# AIOps Resume Project

A production-shaped microservice system that builds itself, deploys itself via
GitOps, watches itself through three independent observability signals, and can
be **diagnosed** by an AI agent named **Kira**.

Kira investigates and explains. She does **not** auto-remediate — a human
applies every fix. That boundary is deliberate and is defended in
[Design decisions](#design-decisions).

---

## Status

| Phase | Scope | State |
|-------|-------|-------|
| 1 | Monorepo + local dev (7 services, Postgres, Prometheus, Grafana) | **Done** |
| 2 | CI — GitHub Actions, parallel builds, push to ECR, tag write-back | Not started |
| 3 | Terraform — VPC, EKS, ECR, ArgoCD + kube-prometheus-stack | Not started |
| 4 | GitOps — ArgoCD app-of-apps | Not started |
| 5 | Kira — Bedrock Agent + 3 scoped Lambda tools | Not started |
| 6 | React UI + incident demo | Not started |

---

## Architecture

```
                    browser
                       │
                 frontend :8087 ──────────────┐  serves UI, proxies /api
                       │                      │  (single origin, no CORS)
                  gateway :8081               │
        ┌──────────┬───┴────┬──────────┐      │
        │          │        │          │      │
     auth:8082  product  order     orders   user:8086   ← all expose
                 :8083   :8084     :8085                   /health /ready /metrics
        │          │        │          │      │
        └──────────┴────────┴──────────┴──────┘
                       │
                 PostgreSQL :5433        one instance, one schema + role per service
                       │
      Prometheus :9090 ──scrapes /metrics from all 7──▶ Grafana :3030
```

**Request path:** the browser only ever talks to the frontend. The frontend
proxies `/api` to the gateway, the only backend entry point. The gateway
verifies JWTs and forwards to services on a private Docker network.

**CQRS split.** `order` owns the **write** path (create, change status) and
`orders` owns the **read** path (history, listing). They share one schema, but
the `orders` DB role holds `SELECT`-only, so the read/write boundary is
enforced by Postgres, not by convention.

---

## Run locally

Requires Docker Desktop. Nothing here touches AWS, so **this phase costs nothing**.

```bash
git clone <your-repo> && cd AiOps

# Build all 7 images and start the stack. --wait blocks until every
# container reports healthy, so a clean exit means the system is up.
docker compose up -d --build --wait

# End-to-end verification: /health + /metrics on all 7, a full user journey
# (register → login → browse → order → read back), authorization checks, and
# that Prometheus has all 7 targets.
bash scripts/smoke.sh
```

Expected tail of the smoke run:

```
  PASS  prometheus: 7/7 targets up

ALL CHECKS PASSED
```

Then open:

| URL | What |
|-----|------|
| http://localhost:8087 | Demo UI (placeholder — replaced by React in Phase 6) |
| http://localhost:3030/d/aiops-overview | Grafana: rate, error %, p95, p99, up/down |
| http://localhost:9090/targets | Prometheus targets |

Grafana allows anonymous viewing for demo convenience; the admin login is
`admin` / `admin`.

```bash
docker compose logs -f order      # structured JSON logs from one service
docker compose down               # stop
docker compose down -v            # stop AND wipe the DB (re-runs db/init on next up)
```

> **Ports.** Services listen on **3000 inside** every container; the host ports
> above exist only so you can hit a service directly for debugging. Frontend
> uses **8087** (8080 is commonly taken by Java/Jenkins/Tomcat) and Postgres
> **5433** (5432 is commonly taken by a local Postgres install).

### Unit tests

```bash
cd services/_shared && npm ci && npm test    # 7 tests on the shared observability layer
```

---

## The seeded bug (Kira's Phase 6 incident)

**There is a deliberate bug in the Order service.** It is off by default and
must not be "fixed" — it is the incident Kira diagnoses.

Location: [`services/order/src/index.js`](services/order/src/index.js), under the
`SEEDED BUG` comment banner.
Toggle: `SEED_BUG_NULL_SHIPPING`.

It simulates a guest-checkout refactor that dropped shipping-address
validation. With the flag on, `POST /orders` **without** a `shippingAddress`
throws an unhandled `TypeError` → HTTP 500. Orders that *do* carry an address
still succeed.

```bash
# Turn it ON
SEED_BUG_NULL_SHIPPING=true docker compose up -d order --wait

# Turn it OFF (default)
docker compose up -d order --wait
```

**Why this bug and not a crash.** It produces a *partial* failure, which is
what makes it a good AIOps exercise — each signal alone is misleading, and only
the correlation identifies it:

| Signal | What it shows | Alone, it suggests |
|--------|---------------|--------------------|
| **Health** | pods stay `Ready` — the process never dies | "nothing is wrong" |
| **Metrics** | `http_requests_total{job="order",route="/orders",status="500"}` climbs; gateway and frontend 5xx climb too | "something is wrong, somewhere" |
| **Logs** | `TypeError: Cannot read properties of undefined (reading 'line1')` with a stack pointing at `buildShipTo()` | the exact line |

Verified locally: with the flag on, an order *with* an address returns 201, one
*without* returns 500, the stack trace appears in the logs, and the container
still reports healthy.

**Blast radius.** The 5xx rate rises on `order` (origin) **and** on `gateway`
and `frontend`, because they propagate the failure. Kira must distinguish the
origin from the collateral — a naive reading blames the frontend.

### Fault injection (separate from the seeded bug)

Every service can inject latency and errors on demand, for generating incidents
that are *not* the seeded bug. Gated behind `CHAOS_ENABLED=true` so it can never
be switched on accidentally in a real environment.

```bash
curl -X POST 'localhost:8084/chaos/latency?ms=800'   # add 800ms to every request
curl -X POST 'localhost:8084/chaos/errors?rate=0.3'  # fail 30% of requests
curl -X POST 'localhost:8084/chaos/reset'
```

> Chaos-injected failures are recorded as `route="unmatched"` because they are
> rejected *before* routing — the same way a real edge-level rejection behaves.
> The seeded bug, which throws inside the handler, attributes correctly to
> `route="/orders"`.

---

## Layout

```
services/
  _shared/        observability + scaffolding used by all 7 (metrics, logs, health, chaos)
  frontend/       serves the UI, proxies /api to the gateway
  gateway/        JWT verification + explicit public-route allow-list
  auth/           register, login, issues JWTs
  product/        catalogue, atomic stock reserve/release
  order/          WRITE path: create orders, status transitions  ← seeded bug lives here
  orders/         READ path: history and listing (SELECT-only DB role)
  user/           profiles
db/init/          schemas, roles, grants, seed data (runs on first Postgres start)
observability/    Prometheus scrape config; Grafana datasource + dashboards as code
scripts/smoke.sh  end-to-end verification
infra/            Terraform            (Phase 3)
aiops/            Kira agent + Lambdas (Phase 5)
.github/workflows/ CI                  (Phase 2)
```

---

## Design decisions

Short rationale for choices that aren't self-evident. Longer explanations live
as comments at the relevant code.

**One shared observability module, not seven copies.** Every service must emit
identically shaped metrics, logs and health, because Kira and the dashboards
depend on that uniformity. Seven copy-pasted versions would drift within weeks.

**Metric labels are low-cardinality.** Requests are labelled with the route
*template* (`/orders/:id`), never the raw URL (`/orders/42`). Raw URLs would
create an unbounded number of time series and exhaust Prometheus's memory —
the single most common way a metrics stack is killed in production.

**`/health` and `/ready` are different endpoints.** `/health` is liveness and
never touches dependencies, so a brief database blip doesn't cause Kubernetes
to restart every pod and turn a small problem into an outage. `/ready` checks
the database and returns 503, which removes the pod from load balancing without
killing it.

**Ops endpoints are excluded from request metrics.** Kubernetes probes hit
`/health` every few seconds and Prometheus scrapes `/metrics` constantly.
Counting those would swamp the real user traffic in every graph.

**The gateway uses an explicit allow-list, not a catch-all proxy.** Services
expose internal endpoints (`POST /products/reserve`, `POST /users`). Listing
public routes one at a time makes internal ones unreachable from outside *by
construction* rather than by remembering to block them. The smoke test asserts
this.

**The gateway strips client-supplied `x-user-id` on every request.** Downstream
services trust that header, so identity may only ever come from a JWT the
gateway itself verified. Without the strip, anyone could set the header and
impersonate any user.

**Prices come from the Product service, never the client.** The order request
carries product ids and quantities; the price is looked up server-side.
Otherwise a user could buy a monitor for one cent.

**Stock reservation is a single atomic statement.** `UPDATE ... WHERE stock >= qty`
performs the check and the decrement together, so two concurrent orders cannot
both pass a check and oversell. Items are also locked in sorted order, which
prevents deadlocks between orders containing the same products.

**5xx responses don't leak internals.** Clients get `{"error":"internal_error","request_id":"..."}`.
The full stack trace goes to the logs, where an operator — or Kira — retrieves
it by request id.

**One Postgres instance, one schema and role per service.** A database per
service would be more orthodox, but the isolation that matters here (a service
cannot read or write another's tables) is enforced by roles and grants, at a
fraction of the cost and operational weight. Defensible as a deliberate
cost/purity trade-off for a student project.

**Grafana is provisioned from files.** Dashboards and the datasource live in Git
and are mounted in, so the observability setup is reproducible and reviewable —
the same principle as the GitOps deployment, applied to monitoring.

**Compose mirrors production topology.** Same images, same env-var wiring as
EKS will use; only the *source* of the values differs. This keeps "works on my
machine" honest.

### Known trade-offs / future improvements

**Image size (~255MB).** The images are multi-stage and run as a non-root user,
but `node:22-alpine` still carries a full Node runtime. Switching to a
distroless base (`gcr.io/distroless/nodejs22`) or a Node single-executable
build would roughly halve this. Deliberately **not** done: the added build
complexity isn't worth it at this scale, and ECR storage for a project this
size is negligible. Worth mentioning as the next optimisation if asked.

---

## Cost

**Phase 1 is free** — everything runs locally in Docker.

AWS spending begins at Phase 3. Every cost will be flagged before it is built.
Planned economies: a single NAT gateway rather than one per AZ, `t3.small`
nodes, on-demand Bedrock calls only while testing Kira, and
`terraform destroy` between work sessions.
