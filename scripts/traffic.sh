#!/usr/bin/env bash
# Continuous background load for the dashboard.
#
#   bash scripts/traffic.sh            # run until Ctrl-C
#   bash scripts/traffic.sh 300        # run for 300 seconds
#
# Run it from Git Bash on Windows. WSL's bash (C:\Windows\System32\bash.exe)
# is a separate Linux VM whose "localhost" is not always the Windows host, so
# it may be unable to reach the storefront at all.
#
# WHY THIS EXISTS
# Prometheus rate() and histogram_quantile() are computed over a trailing
# window. With no traffic the window is empty, quantiles evaluate to NaN, and
# every chart is blank - which looks like the dashboard is broken when the
# system is merely idle. A real service has ambient traffic; this supplies it.
#
# The mix is deliberate: mostly well-formed requests plus a steady minority
# without a shipping address. While the seeded fault is OFF those return 400
# (a normal client error); while it is ON the same requests return 500. So the
# same generator produces a healthy baseline and a genuine partial failure,
# which is what makes the error rate meaningful rather than binary.
#
# OUTPUT
# One summary line every ~10 requests:
#   [  40 req] ok=34  4xx=4 (409 out-of-stock=0)  failed=2 (5xx=2, no-response=0)  orders=4  in-stock=24  last=200
# 4xx is normally the address-less orders (400 by design). Orders only target
# products that were in stock on the last catalogue read, so a 409 is a rare
# race. "failed" is what the dashboard's error panel and an unreachable stack
# look like. Out of stock everywhere? Run scripts/restock.sh.
set -uo pipefail

ORIGIN=${FRONTEND:-http://localhost:8090}
B=$ORIGIN/api
DURATION=${1:-0}
J='content-type: application/json'
START=$(date +%s)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

unreachable() {
  echo "cannot reach $ORIGIN — if you are in WSL bash, run this from Git Bash" >&2
  if grep -qi microsoft /proc/version 2>/dev/null; then
    echo "(this shell IS WSL: its localhost is not reliably the Windows host)" >&2
  fi
  exit 1
}

# 1. Can we reach the storefront at all? Fail loudly rather than run silently.
code=000
for _ in 1 2 3; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$B/products")
  [ "$code" != 000 ] && break
  sleep 1
done
[ "$code" = 000 ] && unreachable
[ "$code" = 200 ] || echo "warning: $B/products answered HTTP $code (expected 200) - is the cluster healthy?" >&2

# 2. A throwaway account, so orders are placed by a real authenticated user.
email="traffic$(date +%s)@example.com"
curl -s --max-time 10 -X POST "$B/auth/register" -H "$J" \
  -d "{\"email\":\"$email\",\"name\":\"Traffic\",\"password\":\"password123\"}" >/dev/null

# Tokens expire after 1 hour. This script used to log in ONCE, so any run
# longer than an hour sent every authenticated request with an expired token:
# a steady stream of 401 "jwt expired" on gateway and frontend (~3,400 in 15
# minutes was observed) that reads like an auth incident and wrote no orders.
# login() is therefore re-run on any 401 and proactively every 50 minutes.
TOKEN='' AUTH='' TOKEN_AT=0
login() {
TOKEN=$(curl -s --max-time 10 -X POST "$B/auth/login" -H "$J" \
  -d "{\"email\":\"$email\",\"password\":\"password123\"}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
  AUTH="authorization: Bearer $TOKEN"
  TOKEN_AT=$(date +%s)
  [ -n "$TOKEN" ]
}
if ! login; then
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$B/products")" = 000 ] && unreachable
  echo "could not authenticate against $B (register/login failed - is the auth service healthy?)" >&2
  exit 1
fi

ADDR='"shippingAddress":{"line1":"1 Ambient St","city":"Bengaluru","postcode":"560001"}'
# The order service authorises a payment before writing the order, and an
# ABSENT card is rejected the same as a bad one. Without this the generator's
# "healthy" orders all came back 402 and nothing was ever written - invisible
# on the dashboard, because 402 is a 4xx and the error panel counts 5xx.
# 4242... is the standard test PAN reserved for an approval.
CARD='"card":"4242424242424242"'
echo "generating load against $B  (Ctrl-C to stop)"

# Each request writes its HTTP status to its own file; tallied after `wait`.
total=0 ok=0 c4=0 c409=0 c401=0 c5=0 nores=0 orders=0 last=- next_report=10 seq=0 got401=0
# Sets NF to the next result file. NOT called via $(...): a subshell would lose seq.
next_file() { seq=$((seq + 1)); printf -v NF '%s/%08d' "$TMP" "$seq"; }
req() {
  next_file; local f=$NF
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" > "$f" &
}
tally() {
  local f c
  for f in "$TMP"/*; do
    [ -e "$f" ] || continue
    c=$(cat "$f"); rm -f "$f"
    total=$((total + 1)); last=$c
    case "$c" in
      2??) ok=$((ok + 1)) ;;
      409) c4=$((c4 + 1)); c409=$((c409 + 1)) ;;
      401) c4=$((c4 + 1)); c401=$((c401 + 1)); got401=1 ;;
      4??) c4=$((c4 + 1)) ;;
      5??) c5=$((c5 + 1)) ;;
      *)   nores=$((nores + 1)) ;;
    esac
  done
}

# Browse the catalogue and remember which products are in stock RIGHT NOW, so
# orders never target a sold-out product (which only produces 409s and writes
# nothing). Sets IN_STOCK to a space-separated list of product ids.
IN_STOCK=''
browse_products() {
  local out code body f
  next_file; f=$NF
  out=$(curl -s --max-time 10 -w '\n%{http_code}' "$B/products")
  code=${out##*$'\n'}; body=${out%$'\n'*}
  printf '%s' "$code" > "$f"
  [ "$code" = 200 ] || return 0   # keep the previous list on a failed read
  # One product object per line, then "id stock" pairs, keep stock > 0.
  IN_STOCK=$(printf '%s' "$body" | tr '{' '\n' \
    | sed -n 's/.*"id":\([0-9]*\),.*"stock":\([0-9]*\).*/\1 \2/p' \
    | awk '$2 > 0 { printf "%s ", $1 }')
}
pick_in_stock() {
  local ids=($IN_STOCK)
  echo "${ids[$((RANDOM % ${#ids[@]}))]}"
}

# RATE. Each cycle is 2 browse requests (catalogue + order history). Every 5th
# cycle places ONE real order (qty 1, in-stock product) - about 1 order per 10
# browse requests, so a long run takes stock down slowly instead of selling
# products out. Offset from it, every 5th cycle also sends one order WITHOUT
# an address: 400 normally, 500 while the seeded fault is on. That request is
# rejected before stock is reserved, so it never consumes stock.
ORDER_EVERY=5
was_empty=0
n=0
while true; do
  n=$((n+1))
  browse_products
  req "$B/orders" -H "$AUTH"

  if [ -z "$IN_STOCK" ]; then
    if [ "$was_empty" -eq 0 ]; then
      echo "nothing is in stock - browse-only traffic until something is restocked (bash scripts/restock.sh)" >&2
      was_empty=1
    fi
  else
    if [ "$was_empty" -eq 1 ]; then echo "stock is back - resuming orders" >&2; was_empty=0; fi
    if [ $((n % ORDER_EVERY)) -eq 0 ]; then
      req -X POST "$B/orders" -H "$AUTH" -H "$J" \
        -d "{\"items\":[{\"productId\":$(pick_in_stock),\"qty\":1}],$ADDR,$CARD}"
      orders=$((orders + 1))
    fi
    if [ $((n % ORDER_EVERY)) -eq 2 ]; then
      req -X POST "$B/orders" -H "$AUTH" -H "$J" \
        -d "{\"items\":[{\"productId\":$(pick_in_stock),\"qty\":1}],$CARD}"
    fi
  fi
  wait
  tally

  # Expired (or otherwise rejected) token: sign in again rather than keep
  # sending requests that can only be refused. Also refresh before expiry.
  if [ "$got401" -eq 1 ] || [ $(( $(date +%s) - TOKEN_AT )) -ge 3000 ]; then
    [ "$got401" -eq 1 ] && reason='got 401 (token expired?)' || reason='token is 50 min old'
    if login; then echo "$reason - signed in again" >&2
    else echo "$reason - re-login FAILED; authenticated requests will keep failing" >&2; fi
    got401=0
  fi

  # Everything in the first cycles got no response: the stack went away (or
  # was never reachable from this shell). Say so instead of looping silently.
  if [ "$n" -le 2 ] && [ "$nores" -eq "$total" ]; then unreachable; fi

  if [ "$total" -ge "$next_report" ]; then
    printf '[%4d req] ok=%d  4xx=%d (409 out-of-stock=%d, 401=%d)  failed=%d (5xx=%d, no-response=%d)  orders=%d  in-stock=%d  last=%s\n' \
      "$total" "$ok" "$c4" "$c409" "$c401" $((c5 + nores)) "$c5" "$nores" "$orders" "$(wc -w <<< "$IN_STOCK")" "$last"
    while [ "$next_report" -le "$total" ]; do next_report=$((next_report + 10)); done
  fi

  [ "$DURATION" -gt 0 ] && [ $(( $(date +%s) - START )) -ge "$DURATION" ] && break
  sleep 2
done
echo "done after $n cycles: $total requests, ok=$ok 4xx=$c4 (409 out-of-stock=$c409, 401=$c401) failed=$((c5 + nores)) (5xx=$c5, no-response=$nores), orders placed=$orders"
