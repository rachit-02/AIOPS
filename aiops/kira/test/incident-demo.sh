#!/usr/bin/env bash
# =============================================================================
# KIRA INCIDENT DEMO
#
# Produces a real incident in the running cluster, then asks Kira to diagnose
# it cold. Nothing tells her what is wrong - she is given the same one-line
# complaint a user would file.
#
#   bash test/incident-demo.sh              # GitOps path (default, honest)
#   bash test/incident-demo.sh --direct     # fast path, for iterating
#   bash test/incident-demo.sh --off        # turn the bug back off
#
# GitOps path : flips SEED_BUG_NULL_SHIPPING in the manifest, commits, pushes,
#               and waits for ArgoCD to roll it out. Enabling the incident is
#               itself a reviewed commit - which is the story worth telling.
# Direct path : patches the Deployment with kubectl. Faster, but ArgoCD's
#               selfHeal reverts it within ~3 minutes, so it is only good for
#               a single run. It also, by design, violates the GitOps rule -
#               use it while iterating, never in the demo.
# =============================================================================
set -uo pipefail

CTX=kind-aiops-local
NS=aiops-dev
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MANIFEST="$ROOT/infra/k8s/base/order/deployment.yaml"
FRONTEND=http://localhost:8090
MODE=gitops

for a in "$@"; do
  case "$a" in
    --direct) MODE=direct ;;
    --off) MODE=off ;;
  esac
done

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

set_flag() { # set_flag true|false
  local want=$1
  if [ "$MODE" = direct ]; then
    kubectl --context "$CTX" -n "$NS" set env deploy/order "SEED_BUG_NULL_SHIPPING=$want" >/dev/null
    kubectl --context "$CTX" -n "$NS" rollout status deploy/order --timeout=180s >/dev/null
    echo "  patched Deployment directly (ArgoCD selfHeal will revert this within ~3m)"
  else
    # Toggle the value in the manifest, then let the pipeline do the work.
    local from to
    if [ "$want" = true ]; then from='"false"'; to='"true"'; else from='"true"'; to='"false"'; fi
    if grep -q "SEED_BUG_NULL_SHIPPING" -A1 "$MANIFEST" && grep -A1 "SEED_BUG_NULL_SHIPPING" "$MANIFEST" | grep -q "value: $from"; then
      perl -0pi -e "s/(SEED_BUG_NULL_SHIPPING\n\s+value: )$from/\${1}$to/" "$MANIFEST"
      ( cd "$ROOT" && git add "$MANIFEST" &&
        git commit -q -m "chore(demo): set SEED_BUG_NULL_SHIPPING=$want

Toggling the seeded Order-service incident. Enabling a fault is a reviewed
commit like any other change - ArgoCD rolls it out from Git." &&
        git push -q origin HEAD:main ) || die "could not commit/push the manifest change"
      echo "  committed and pushed; waiting for ArgoCD to sync..."
      # Nudge rather than wait out the 3-minute poll.
      kubectl --context "$CTX" -n argocd patch app aiops-dev --type merge \
        -p '{"operation":{"sync":{"revision":"main"}}}' >/dev/null 2>&1
    else
      echo "  manifest already set to $want"
    fi
    for i in $(seq 1 24); do
      cur=$(kubectl --context "$CTX" -n "$NS" get deploy order \
        -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="SEED_BUG_NULL_SHIPPING")].value}' 2>/dev/null)
      [ "$cur" = "$want" ] && break
      sleep 10
    done
    kubectl --context "$CTX" -n "$NS" rollout status deploy/order --timeout=180s >/dev/null
  fi
  local now
  now=$(kubectl --context "$CTX" -n "$NS" get deploy order \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="SEED_BUG_NULL_SHIPPING")].value}')
  [ "$now" = "$want" ] || die "flag is '$now', expected '$want'"
  echo "  SEED_BUG_NULL_SHIPPING=$now, rollout complete"
}

# ---------------------------------------------------------------------------
if [ "$MODE" = off ]; then
  step "Disabling the seeded bug"
  MODE=gitops set_flag false
  echo "  done."
  exit 0
fi

step "Preflight"
kubectl --context "$CTX" get ns "$NS" >/dev/null 2>&1 || die "namespace $NS not found - is the cluster up?"
[ -n "${ANTHROPIC_API_KEY:-}" ] || die "ANTHROPIC_API_KEY is not set"
curl -sf --max-time 10 "$FRONTEND/api/products" >/dev/null || die "frontend unreachable at $FRONTEND"
( cd "$(dirname "${BASH_SOURCE[0]}")/.." && node src/index.js --check ) || die "Kira cannot reach all three data sources"

step "Enabling the seeded Order-service bug  (mode: $MODE)"
set_flag true

step "Generating traffic"
# A MIX, on purpose. If every request failed, the error rate would be 100% and
# the incident would be trivially obvious. A partial failure - orders with an
# address succeed, orders without one crash - is the realistic and much harder
# case, and it is what makes correlating three signals actually necessary.
EMAIL="demo$(date +%s)@example.com"
curl -s --max-time 15 -X POST "$FRONTEND/api/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"name\":\"Demo\",\"password\":\"password123\"}" >/dev/null
TOKEN=$(curl -s --max-time 15 -X POST "$FRONTEND/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
[ -n "$TOKEN" ] || die "could not log in to generate traffic"

ADDR='"shippingAddress":{"line1":"1 Demo St","city":"Bengaluru","postcode":"560001"}'
ok=0; bad=0
for i in $(seq 1 12); do
  curl -s -o /dev/null --max-time 15 -X POST "$FRONTEND/api/orders" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"items\":[{\"productId\":2,\"qty\":1}],$ADDR}" && ok=$((ok+1))
  # No shippingAddress -> the seeded bug throws -> HTTP 500
  curl -s -o /dev/null --max-time 15 -X POST "$FRONTEND/api/orders" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"items":[{"productId":2,"qty":1}]}' && bad=$((bad+1))
  curl -s -o /dev/null --max-time 15 "$FRONTEND/api/products"
done
echo "  sent $ok well-formed orders and $bad without a shipping address"

step "Waiting for telemetry to settle"
# Prometheus scrapes every 15s and rate() needs several samples; Fluent Bit
# flushes every second but Loki ingestion lags a little. Asking too early
# produces an empty investigation that looks like a Kira failure.
for i in $(seq 1 9); do printf '  %ds\r' $((i*10)); sleep 10; done; echo "  90s elapsed      "

step "Kira investigates (she is told nothing about the bug)"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node src/index.js \
  "Users report that some checkout attempts are failing intermittently, but others succeed. Investigate the aiops-dev namespace over the last 15 minutes and tell me the root cause."
rc=$?

echo
if [ $rc -eq 0 ]; then
  printf '\033[32mDemo complete - all three signals were used.\033[0m\n'
else
  printf '\033[31mDemo finished with exit %s (see trace summary above).\033[0m\n' "$rc"
fi
echo "Turn the bug off with:  bash test/incident-demo.sh --off"
exit $rc
