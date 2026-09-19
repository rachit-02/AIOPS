#!/usr/bin/env bash
# End-to-end smoke test against the running compose stack.
# Usage: bash scripts/smoke.sh        (exit code 0 = all good)
set -u
fail=0
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; fail=1; }
check() { # check <name> <expected-status> <actual-status>
  [ "$2" = "$3" ] && ok "$1 ($3)" || bad "$1 (expected $2, got $3)"
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== /health and /metrics on all 7 services (direct host ports) =="
for pair in frontend:8087 gateway:8081 auth:8082 product:8083 order:8084 orders:8085 user:8086; do
  svc=${pair%%:*}; port=${pair##*:}
  check "$svc /health"  200 "$(code localhost:$port/health)"
  check "$svc /metrics" 200 "$(code localhost:$port/metrics)"
done

echo "== Functional flow through frontend -> gateway =="
B=localhost:8087/api
EMAIL="smoke$(date +%s)@example.com"
JSON='content-type: application/json'

check "list products (public)" 200 "$(code $B/products)"
check "register"               201 "$(code -X POST $B/auth/register -H "$JSON" -d "{\"email\":\"$EMAIL\",\"name\":\"Smoke\",\"password\":\"password123\"}")"
check "login wrong password"   401 "$(code -X POST $B/auth/login -H "$JSON" -d "{\"email\":\"$EMAIL\",\"password\":\"nope\"}")"
TOKEN=$(curl -s -X POST $B/auth/login -H "$JSON" -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
[ -n "$TOKEN" ] && ok "login returns token" || bad "login returns token"
AUTH="authorization: Bearer $TOKEN"

check "orders without token"   401 "$(code $B/orders)"
check "users/me"               200 "$(code $B/users/me -H "$AUTH")"
check "internal endpoint NOT exposed via gateway" 404 "$(code -X POST $B/users -H "$JSON" -d '{}')"

ADDR='"shippingAddress":{"line1":"1 Test St","city":"Bengaluru","postcode":"560001"}'
ORDER=$(curl -s -X POST $B/orders -H "$AUTH" -H "$JSON" -d "{\"items\":[{\"productId\":1,\"qty\":1}],$ADDR}")
# Capture the real id: each run registers a fresh user, and a user can only see
# their own orders, so a hardcoded id would 404.
OID=$(echo "$ORDER" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
[ -n "$OID" ] && ok "create order (id=$OID)" || bad "create order -> $ORDER"
check "create order, no address (healthy build rejects)" 400 "$(code -X POST $B/orders -H "$AUTH" -H "$JSON" -d '{"items":[{"productId":1,"qty":1}]}')"
check "create order, too much stock" 409 "$(code -X POST $B/orders -H "$AUTH" -H "$JSON" -d "{\"items\":[{\"productId\":1,\"qty\":99999}],$ADDR}")"
check "list my orders (Orders svc)" 200 "$(code $B/orders -H "$AUTH")"
check "get order (Orders svc)"    200 "$(code $B/orders/$OID -H "$AUTH")"
check "pay order (Order svc)"       200 "$(code -X PATCH $B/orders/$OID/status -H "$AUTH" -H "$JSON" -d '{"status":"paid"}')"
check "illegal transition"          409 "$(code -X PATCH $B/orders/$OID/status -H "$AUTH" -H "$JSON" -d '{"status":"pending"}')"

echo "== Prometheus scraping all 7 targets =="
UP=$(curl -s 'localhost:9090/api/v1/query?query=count(up==1)' | grep -o '"value":\[[^]]*\]' | grep -o '"[0-9]*"\]' | tr -d '"]')
[ "${UP:-0}" = "7" ] && ok "prometheus: 7/7 targets up" || bad "prometheus: ${UP:-0}/7 targets up"

echo
[ $fail = 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $fail
