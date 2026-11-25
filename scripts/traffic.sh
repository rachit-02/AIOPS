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
#   [  40 req] ok=28  4xx=8 (409 out-of-stock=0)  failed=4 (5xx=0, no-response=4)  last=201
# 4xx is normally the address-less orders (400 by design). A 409 means the
# product it picked is out of stock: this script only buys products 1-5, so
# over time it sells them out. "failed" is what the dashboard's error panel
# and an unreachable stack look like.
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
reg=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$B/auth/register" -H "$J" \
  -d "{\"email\":\"$email\",\"name\":\"Traffic\",\"password\":\"password123\"}")
TOKEN=$(curl -s --max-time 10 -X POST "$B/auth/login" -H "$J" \
  -d "{\"email\":\"$email\",\"password\":\"password123\"}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  [ "$reg" = 000 ] && unreachable
  echo "could not authenticate against $B (register answered HTTP $reg)" >&2
  exit 1
fi

AUTH="authorization: Bearer $TOKEN"
ADDR='"shippingAddress":{"line1":"1 Ambient St","city":"Bengaluru","postcode":"560001"}'
# The order service authorises a payment before writing the order, and an
# ABSENT card is rejected the same as a bad one. Without this the generator's
# "healthy" orders all came back 402 and nothing was ever written - invisible
# on the dashboard, because 402 is a 4xx and the error panel counts 5xx.
# 4242... is the standard test PAN reserved for an approval.
CARD='"card":"4242424242424242"'
echo "generating load against $B  (Ctrl-C to stop)"

# Each request writes its HTTP status to its own file; tallied after `wait`.
total=0 ok=0 c4=0 c409=0 c5=0 nores=0 last=- next_report=10 seq=0
req() {
  seq=$((seq + 1))
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" > "$TMP/$(printf '%08d' "$seq")" &
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
      4??) c4=$((c4 + 1)) ;;
      5??) c5=$((c5 + 1)) ;;
      *)   nores=$((nores + 1)) ;;
    esac
  done
}

n=0
while true; do
  n=$((n+1))
  req "$B/products"
  req "$B/orders" -H "$AUTH"
  req -X POST "$B/orders" -H "$AUTH" -H "$J" \
    -d "{\"items\":[{\"productId\":$((RANDOM % 5 + 1)),\"qty\":1}],$ADDR,$CARD}"
  # Every third cycle, omit the address: 400 normally, 500 during an incident.
  if [ $((n % 3)) -eq 0 ]; then
    req -X POST "$B/orders" -H "$AUTH" -H "$J" \
      -d "{\"items\":[{\"productId\":$((RANDOM % 5 + 1)),\"qty\":1}],$CARD}"
  fi
  wait
  tally

  # Everything in the first cycles got no response: the stack went away (or
  # was never reachable from this shell). Say so instead of looping silently.
  if [ "$n" -le 2 ] && [ "$nores" -eq "$total" ]; then unreachable; fi

  if [ "$total" -ge "$next_report" ]; then
    printf '[%4d req] ok=%d  4xx=%d (409 out-of-stock=%d)  failed=%d (5xx=%d, no-response=%d)  last=%s\n' \
      "$total" "$ok" "$c4" "$c409" $((c5 + nores)) "$c5" "$nores" "$last"
    while [ "$next_report" -le "$total" ]; do next_report=$((next_report + 10)); done
  fi

  [ "$DURATION" -gt 0 ] && [ $(( $(date +%s) - START )) -ge "$DURATION" ] && break
  sleep 2
done
echo "done after $n cycles: $total requests, ok=$ok 4xx=$c4 (409 out-of-stock=$c409) failed=$((c5 + nores)) (5xx=$c5, no-response=$nores)"
