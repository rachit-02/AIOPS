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
| 2 | CI — GitHub Actions, parallel builds, push to GHCR, tag write-back | In progress |
| 3 | Terraform — kind cluster + ArgoCD, Prometheus/Grafana, Loki, Fluent Bit | **Done** |
| 4 | GitOps — ArgoCD app-of-apps | Not started |
| 5 | Kira — local agent + 3 scoped tools (Anthropic API) | Not started |
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
cd services/_shared && npm ci && npm test    # 8 tests on the shared observability layer
```

---

## Run on Kubernetes (kind)

The compose stack above is the fast inner loop. This is the production-shaped
environment: a real Kubernetes cluster with GitOps, three observability signals,
and the platform Kira queries in Phase 5.

### Prerequisites

| Tool | Purpose |
|---|---|
| Docker Desktop | hosts the cluster nodes as containers |
| [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation) | creates the cluster |
| kubectl | talks to it |
| Terraform ≥ 1.5 | installs the platform charts |

`winget install Kubernetes.kind Kubernetes.kubectl Hashicorp.Terraform`

Helm itself is **not** required — the Terraform `helm` provider embeds it.

### Bring it up

```bash
docker compose down            # the two stacks must not run together
bash scripts/cluster-up.sh     # creates the cluster, then applies Terraform
```

That runs two steps, and it is worth knowing which is which:

```bash
# 1. The cluster — kind CLI, from a declarative config file
kind create cluster --config infra/terraform/kind-config.yaml

# 2. The platform — Terraform owns the four Helm releases
cd infra/terraform && terraform init && terraform apply
```

| URL | What | Credentials |
|---|---|---|
| http://localhost:8091 | ArgoCD | `admin` / see command below |
| http://localhost:3031 | Grafana (Prometheus **and** Loki) | `admin` / `admin` |
| http://localhost:9091 | Prometheus | — |
| http://localhost:8090 | Frontend (once Phase 4 deploys it) | — |

```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

Verify logs are flowing — in Grafana → Explore → Loki, run
`{kubernetes_namespace_name="logging"}`.

> **Label names are flattened.** Fluent Bit's Loki output turns
> `$kubernetes['namespace_name']` into the label `kubernetes_namespace_name`.
> Querying `{namespace="..."}` returns an empty result **with no error** — a
> silent failure worth knowing about, since Phase 5's `fetch_logs` builds
> LogQL queries programmatically.

### Tear it down

```bash
bash scripts/cluster-down.sh          # or:
kind delete cluster --name aiops-local
```

Deleting the cluster removes every container, volume and image it owned, so
nothing survives to leak. The script also clears local Terraform state, which
would otherwise describe releases in a cluster that no longer exists.

### Why the cluster is created by the CLI and not by Terraform

Terraform owns the **platform** (the four Helm releases), where a dependency
graph and state genuinely earn their keep. Cluster creation is one idempotent
command with no state worth tracking, and the only Terraform provider for kind
is community-maintained with its last release in **February 2025** — it bundles
its own kind version and lags current Kubernetes node images. Taking that
dependency to save one command would be a bad trade.

The honest framing for a viva: *Terraform is used where it adds value, not
everywhere it could technically be used.*

### What Terraform installs, and why each setting

| Release | Namespace | Notable tuning |
|---|---|---|
| Loki `7.3.0` | `logging` | SingleBinary, filesystem store; **caches disabled** (the chart's default chunk cache alone requests ~2 GB) |
| Fluent Bit `0.58.2` | `logging` | DaemonSet; CRI parser → JSON merge, so `level`/`service`/`request_id` are queryable |
| kube-prometheus-stack `91.4.1` | `monitoring` | Alertmanager off; **control-plane scrapers off** (see below); Loki wired as a second Grafana datasource |
| ArgoCD `10.9.2` | `argocd` | Dex off, ApplicationSet scaled to 0, plain HTTP behind NodePort |

Three decisions worth defending:

**Control-plane scrapers are disabled.** On kind, `kubeScheduler`,
`kubeControllerManager`, `kubeEtcd` and `kubeProxy` bind to `127.0.0.1` inside
the control-plane container and can never be scraped. Left enabled they sit
permanently DOWN — and that is worse than untidy: it becomes permanent noise in
every "is anything unhealthy?" answer, including Kira's. An agent taught that
four red targets are normal is an agent taught to ignore evidence.

**`serviceMonitorSelectorNilUsesHelmValues: false`.** This defaults to `true`,
which silently restricts Prometheus to ServiceMonitors carrying the chart's own
release labels. The Phase 4 ServiceMonitors would be ignored with no error and
no metrics — a failure that looks like the application not exporting anything.

**Log labels are low-cardinality on purpose.** Loki indexes namespace, pod,
container and level. `request_id` is deliberately a *field*, not a label: one
value per request would create one Loki stream per request. It is queried at
read time instead —
`{kubernetes_namespace_name="aiops-dev"} | json | request_id="abc-123"` —
which is the same cardinality discipline applied to the Prometheus metric
labels, for the same reason.

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
scripts/
  smoke.sh          end-to-end verification of the compose stack
  cluster-up.sh     kind cluster + Terraform platform, in order
  cluster-down.sh   tear it all down
infra/terraform/
  kind-config.yaml  cluster topology (1 control-plane + 2 workers, port maps)
  main.tf           the 4 Helm releases
  values/           one YAML per chart — reviewable, lintable, diffable
infra/k8s/          kustomize base + overlays  (Phase 2 branch)
aiops/              Kira agent + 3 scoped tools (Phase 5)
.github/workflows/  CI                         (Phase 2 branch)
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
complexity isn't worth it at this scale, and registry storage for a project
this size is negligible. It does matter more now that kind pulls every image a
second time into its node containers — see [Resource
requirements](#resource-requirements).

---

## Resource requirements

This project runs **entirely on one machine**. There is no cloud infrastructure
and no cloud bill. The constraint is local RAM and disk instead.

| Environment | RAM | Disk | Notes |
|---|---|---|---|
| `docker compose` (inner loop) | ~1.5 GB | ~3 GB | 7 services + Postgres + Prometheus + Grafana |
| `kind` cluster (full platform) | **~5.5 GB** | **~5 GB** | + ArgoCD, Loki, Fluent Bit, kube-state-metrics |

**Never run both at once.** Together they exceed what Docker is typically
allocated, and the failure mode is confusing — pods get `OOMKilled` and look
like application faults. `scripts/cluster-up.sh` refuses to start if the
compose stack is up.

Breakdown of the kind cluster (~25 pods):

| Component | ~RAM |
|---|---|
| kind control-plane + 2 workers | 1.8 GB |
| Prometheus + Grafana + exporters | 1.5 GB |
| ArgoCD (Dex off, ApplicationSet scaled to 0) | 0.6 GB |
| Loki + Fluent Bit | 0.6 GB |
| 7 services (1 replica each) + Postgres | 0.9 GB |

**Recommended minimum: 16 GB RAM**, with at least 8 GB allocated to Docker
(10 GB is comfortable — set `memory=10GB` in `%USERPROFILE%\.wslconfig` on
Windows). **12 GB free disk** on whichever drive holds Docker's VM image; kind
does not share Docker's image store, so every image is pulled *again* inside
the node containers.

If disk is tight, `docker builder prune -f` and `docker image prune -a -f`
usually reclaim several GB.

### The one thing that does cost money

**Kira's Anthropic API calls** (Phase 5). Everything else is free. Using
`claude-sonnet-5`, a full three-tool diagnosis costs roughly **$0.12**;
development and demos land in the region of $10–15 total. Costs are contained
by capping `fetch_logs` to a bounded time window and line count, and by prompt
caching the stable system prompt and tool definitions.

---

## Why this runs locally instead of on AWS

The project was originally designed for AWS — VPC across 3 AZs, EKS, ECR,
CloudWatch, and Kira as a Bedrock Agent with Lambda tools. It was then
deliberately re-targeted to run entirely on one machine, to remove a recurring
cost (~$105/month for the EKS control plane and NAT gateway alone) from a
student project.

| Original | Now | What was preserved |
|---|---|---|
| EKS | kind | Same manifests, same kustomize overlays |
| ECR | GHCR | Same SHA-tagged immutable images |
| CloudWatch | Loki | Same Fluent Bit shipper — only the output plugin changed |
| Terraform → VPC/EKS | Terraform → Helm releases | Same IaC discipline, pinned versions, `apply`/`destroy` |
| Bedrock Agent + Lambda | Local Node service + Anthropic API | Same 3 scoped tools, same narrow-tool principle |

**The application code did not change.** Swapping the entire cloud substrate
touched four comments across 7 services — the services never knew where their
logs went or which cluster they ran on. That decoupling is the point.

The original AWS design — including the scoped IAM policy and the GitHub OIDC
trust policy — is preserved in Git history on the `feat/ci-ecr-pipeline`
branch, and moves to `docs/design-notes/` when Phase 2 is re-cut for GHCR. The
reasoning there is worth keeping even though it is no longer deployed.
