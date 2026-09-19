#!/usr/bin/env bash
# Continuous background load for the dashboard.
#
#   bash scripts/traffic.sh            # run until Ctrl-C
#   bash scripts/traffic.sh 300        # run for 300 seconds
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
set -uo pipefail

B=${FRONTEND:-http://localhost:8090}/api
DURATION=${1:-0}
J='content-type: application/json'
START=$(date +%s)

email="traffic$(date +%s)@example.com"
curl -s --max-time 10 -X POST "$B/auth/register" -H "$J" \
  -d "{\"email\":\"$email\",\"name\":\"Traffic\",\"password\":\"password123\"}" >/dev/null
TOKEN=$(curl -s --max-time 10 -X POST "$B/auth/login" -H "$J" \
  -d "{\"email\":\"$email\",\"password\":\"password123\"}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
[ -n "$TOKEN" ] || { echo "could not authenticate against $B" >&2; exit 1; }

AUTH="authorization: Bearer $TOKEN"
ADDR='"shippingAddress":{"line1":"1 Ambient St","city":"Bengaluru","postcode":"560001"}'
echo "generating load against $B  (Ctrl-C to stop)"

n=0
while true; do
  n=$((n+1))
  curl -s -o /dev/null --max-time 10 "$B/products" &
  curl -s -o /dev/null --max-time 10 "$B/orders" -H "$AUTH" &
  curl -s -o /dev/null --max-time 10 -X POST "$B/orders" -H "$AUTH" -H "$J" \
    -d "{\"items\":[{\"productId\":$((RANDOM % 5 + 1)),\"qty\":1}],$ADDR}" &
  # Every third cycle, omit the address: 400 normally, 500 during an incident.
  if [ $((n % 3)) -eq 0 ]; then
    curl -s -o /dev/null --max-time 10 -X POST "$B/orders" -H "$AUTH" -H "$J" \
      -d "{\"items\":[{\"productId\":$((RANDOM % 5 + 1)),\"qty\":1}]}" &
  fi
  wait
  [ "$DURATION" -gt 0 ] && [ $(( $(date +%s) - START )) -ge "$DURATION" ] && break
  sleep 2
done
echo "done after $n cycles"
