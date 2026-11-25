# Fault catalogue

Each file here is a complete replacement for `infra/k8s/overlays/dev/fault.yaml`,
the one live fault file. Arming a fault = copying its template over `fault.yaml`
and committing; disarming = copying `none.yaml`. Because there is exactly one
live file, arming a fault always disarms the previous one.

The dashboard and `scripts/eval-kira.mjs` do this through the Kira server
(`POST /api/faults/:id/arm`, `POST /api/faults/disarm`), which commits, pushes
and asks ArgoCD to sync. No CI build is involved: these are infra-only commits.

| ID | File | Target | Mechanism | Expected symptom |
|----|------|--------|-----------|------------------|
| F1 | F1-order-code-bug.yaml | order | `SEED_BUG_NULL_SHIPPING=true` | 500 on POST /orders, `line1` TypeError |
| F2 | F2-product-latency.yaml | product | `SEED_PRODUCT_LATENCY_MS=1200` | p50/p99 ~1.2 s, no 5xx |
| F3 | F3-user-crash-loop.yaml | user | `SEED_CRASH_ON_START=true` | CrashLoopBackOff (pod health only) |
| F4 | F4-auth-oom.yaml | auth | `SEED_MEMORY_LEAK_MB_PER_S=2` + 128Mi limit | OOMKilled restarts |
| F5 | F5-orders-bad-config.yaml | orders | wrong DB host + `Recreate` | NotReady, DB ENOTFOUND, gateway 5xx on reads |
| F6 | F6-gateway-bad-deploy.yaml | gateway | non-existent image tag | ImagePullBackOff |

Every fault defaults OFF: with `none.yaml` live, no service has any `SEED_*`
variable set, and the code paths are no-ops (unit-tested per service).
