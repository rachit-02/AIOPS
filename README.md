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
| 2 | CI — GitHub Actions, parallel builds, push to GHCR, tag write-back | **Done** |
| 3 | Terraform — kind cluster + ArgoCD, Prometheus/Grafana, Loki, Fluent Bit | **Done** |
| 4 | GitOps — ArgoCD app-of-apps, ServiceMonitors, dashboard as code | **Done** |
| 5 | Kira — local agent + 3 scoped tools (Ollama, local) | **Done** |
| 6 | React dashboard + Kira chat, on live cluster data | **Done** |

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

### Testing

| Layer | What it covers | Run it |
|-------|----------------|--------|
| Unit | The shared observability layer — 8 tests, including one asserting metrics use route *templates* not raw URLs | `cd services/_shared && npm ci && npm test` |
| Lint | All 7 services under one ESLint config | `cd services && npm ci && npx eslint .` |
| End-to-end | Full user journey + authorization boundaries + Prometheus targets, against the running stack | `bash scripts/smoke.sh` |

> **Per-service unit tests are deliberate placeholders.** Each service's
> `npm test` prints a `PLACEHOLDER` banner and exits 0, so a green CI check is
> never mistaken for real coverage. The genuine coverage today is `_shared`
> (where the logic that *all* services depend on lives) plus `smoke.sh` (which
> tests the services through their real HTTP contracts). Adding per-service
> unit tests needs a test database or repository mocking — worth doing, not yet
> done, and honest to say so.

---

## CI/CD — how a push becomes a deployment

```
 push to main (services/** only)
        │
        ▼
   ┌──────────┐   discovers the service list from the filesystem,
   │ prepare  │   so the matrix can never drift from the repo
   └────┬─────┘
        ▼
   ┌──────────┐   lint + test, 8 packages in parallel.
   │  check   │   Nothing is built until this passes.
   └────┬─────┘
        ▼
   ┌──────────┐   7 images in parallel → GHCR, tagged with the short SHA.
   │  build   │   Auth via the built-in GITHUB_TOKEN — zero secrets.
   └────┬─────┘
        ▼
   ┌──────────┐   rewrites image tags in infra/k8s/overlays/dev,
   │  gitops  │   commits as github-actions[bot], pushes to main.
   └────┬─────┘   *** CI STOPS HERE. It has no cluster credentials. ***
        ▼
   ArgoCD (in kind) notices the changed tag and syncs — Phase 4
```

**Why the pipeline stops at a Git commit.** CI's last act is to write down
*which* images should be running. It never runs `kubectl apply` and holds no
cluster credentials — it could not deploy if it tried. ArgoCD, running inside
the cluster, pulls the change. The consequences are the point:

- **Git is the single source of truth.** "What is deployed?" is answered by
  reading a file, not by interrogating the cluster.
- **A deploy is a `git push`; a rollback is a `git revert`.** Both are reviewed,
  attributable and auditable.
- **Blast radius is contained.** A compromised CI token can push a bad image,
  but it cannot bypass review to deploy one.
- **Drift is detectable.** Anything changed by hand in the cluster differs from
  Git, and ArgoCD reports it.

### Loop prevention — three independent layers

The `gitops` job commits to the same repository that triggers the workflow.
Left unguarded, that commit retriggers the build, which commits again, forever.
Three layers stop it, any one of which would suffice:

1. **`paths:` filter** — the workflow only triggers on `services/**`. The bot
   writes to `infra/k8s/**`, so its commits are *structurally incapable* of
   triggering a build.
2. **`[skip ci]` in the commit subject** — backstop if someone later widens
   that filter.
3. **GitHub's own rule** — pushes authenticated with the default `GITHUB_TOKEN`
   never trigger workflow runs. This is free and the strongest of the three.

### Image tags are the short commit SHA, never `latest`

`latest` is mutable, so two pods on the "same version" can run different code
and a rollback has no fixed target. A SHA tag ties a running container to the
exact commit that produced it — which is what Kira needs in Phase 5 to
correlate "error rate rose at 14:02" with "deploy of `a1b2c3d` at 14:01".
GHCR packages are immutable per tag for the same reason.

### Setup — there isn't any

The pipeline requires **no repository secrets and no external accounts**.
`GITHUB_TOKEN` is minted per run, scoped to this repository, and expires when
the job ends; `packages: write` is the only extra permission. The GHCR packages
are public, so the kind cluster pulls them anonymously — no pull secrets
either.

This is a genuine simplification over the original ECR design, which needed an
OIDC identity provider, a federated IAM role, a trust policy and two secrets
configured before the first run. That design is preserved as a
[design note](docs/design-notes/original-aws-design.md), because the IAM
scoping and OIDC trust-policy reasoning are worth defending even though they
are no longer deployed.

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

## GitOps — verified end to end

A push to `services/**` reaches running pods with no human touching the
cluster. This was measured, not assumed:

| Step | Evidence |
|---|---|
| Source commit `59b4b3a` pushed to `main` | — |
| CI builds 7 images, pushes to GHCR | 17/17 jobs green |
| Bot commits the tag bump | `chore(deploy): 59b4b3a [skip ci]` by `github-actions[bot]`, touching only `kustomization.yaml` |
| ArgoCD notices and syncs | Application `aiops-dev` → `Synced / Healthy` at revision `20c3acd` |
| Pods roll out | all 7 Deployments on `:59b4b3a`, pods 60s old, Postgres untouched |
| App still works | 12/12 functional checks through `localhost:8090` |

No `kubectl apply` was run at any point. A deploy is a `git push`; a rollback
is `git revert`.

### What ArgoCD manages

```
Terraform ──plants──▶ Application/root ──watches──▶ infra/k8s/argocd/applications/
                                                          │
                                                          ▼
                                                  Application/aiops-dev
                                                          │ watches
                                                          ▼
                                              infra/k8s/overlays/dev  ◀── CI writes here
```

Terraform plants **exactly one object** — the root Application. Everything
else is added, changed or removed by committing to Git. That is the smallest
the bootstrap exception can be made: ArgoCD cannot install itself, and cannot
manage applications before it is running, so something outside GitOps has to
start the chain.

`prune: true` and `selfHeal: true` are what make "Git is the source of truth"
enforceable rather than a convention: a resource deleted from Git is deleted
from the cluster, and a manual `kubectl edit` is reverted within minutes.

### The three signals, in one dashboard

Grafana → **AIOps — Three Signals** (`aiops-three-signals`), provisioned from
[a ConfigMap in Git](infra/k8s/base/monitoring/dashboard-three-signals.json),
so a dashboard change is a reviewable commit.

| Row | Source | What it proves |
|---|---|---|
| **Pod health** | Kubernetes API via kube-state-metrics | replicas ready, container restarts |
| **Metrics** | Prometheus scraping `/metrics` via ServiceMonitor | request rate, error %, p95/p99 |
| **Logs** | Loki, shipped by Fluent Bit | error volume + the log lines themselves |

They are **genuinely independent data sources** — a different system, a
different collection path, a different storage engine for each. That is what
makes cross-referencing them meaningful rather than circular, and it is the
whole basis of Kira's diagnosis in Phase 5.

The seeded bug is the clearest demonstration: **pod health stays green**
throughout, metrics show a 5xx spike on `order` *and* on `gateway`/`frontend`
that merely propagate it, and only the logs name the line. Any one signal
alone misleads.

### Secrets

Committed to Git as plain `Secret` manifests, deliberately. They are the same
throwaway credentials already in `docker-compose.yml` and `db/init/`, guarding
a disposable cluster bound to localhost. Committing them keeps every cluster
object traceable to the repository, with no out-of-band `kubectl create secret`
that would make the cluster un-reproducible.

**This is not what production looks like.** The real options — External Secrets
Operator, Sealed Secrets, or SOPS+age — each add a component that buys nothing
for credentials already public in this repo. The choice is scoped and
deliberate, and [the manifest says so](infra/k8s/base/secrets.yaml).

### Three settings that fail silently if wrong

Each of these produces a green-looking system that does not work, and each cost
real debugging time here:

1. **`runAsUser` must be numeric.** The Dockerfiles said `USER node`; Kubernetes
   cannot resolve a *name* to a uid, so with `runAsNonRoot: true` it refuses to
   start the container — `CreateContainerConfigError`. Now fixed at source
   (`USER 1000:1000`) with the manifest setting kept as defence in depth.
2. **A NodePort must actually exist.** `kind-config.yaml` maps host `8090` to
   node port `30080`, but every Service was ClusterIP. ArgoCD reported
   `Synced / Healthy` and all 8 pods `Running` while the frontend was
   unreachable.
3. **CI and ArgoCD must render manifests identically.** The base generates its
   DB-init ConfigMap from the one canonical `db/init/01-schemas.sql`, outside
   the kustomize root, so both need `--load-restrictor LoadRestrictionsNone`.
   CI's verify gate caught the mismatch and refused to commit a tag bump — the
   gate doing exactly its job.

---

## Disaster recovery — rebuilt from nothing, verified

The entire cluster was **deleted and recreated from scratch** to prove Git is
genuinely the source of truth:

```bash
bash scripts/cluster-down.sh    # kind delete cluster + clear local TF state
bash scripts/cluster-up.sh      # kind create + terraform apply
```

| Before | After |
|---|---|
| 36 pods across 9 namespaces | rebuilt to 23/23 Running |
| `aiops-dev` on `:59b4b3a` | restored to `:59b4b3a` — **read from Git, not retyped** |
| 2 ArgoCD Applications | both back, `Synced / Healthy` |

Terraform installed the platform and planted **one** object, the root
Application. ArgoCD then pulled everything else from `main` and rebuilt all 8
workloads with **no manual intervention**.

What survives and what does not, stated honestly:

- **Survives:** every deployment, service, config, dashboard and image tag —
  because all of it is in Git.
- **Does not:** application *data*. The Postgres PVC goes with the cluster and
  the schema re-initialises from `db/init/01-schemas.sql`. A disposable local
  cluster is not a backup strategy, and this project does not pretend otherwise.

### The bug this rebuild caught

The root Application was originally declared in the argo-cd chart's
`extraObjects`. That worked — but **only because ArgoCD was already installed
when it was added.** On a clean cluster it fails:

```
resource mapping not found for kind "Application" in version "argoproj.io/v1alpha1"
ensure CRDs are installed first
```

The Helm provider renders and validates the whole manifest set against the API
server *before* applying, so a chart cannot reference a CRD it is installing in
the same release. `kubernetes_manifest` has the same problem one step earlier —
it needs the CRD at *plan* time.

The root Application now lives in
[`infra/k8s/argocd/root-application.yaml`](infra/k8s/argocd/root-application.yaml)
and Terraform applies it as a separate step afterwards. Still declarative,
still reviewable, still exactly one object wide.

**This is the argument for rebuild tests.** The bug was invisible in a working
cluster and would have surfaced only when someone tried to recreate the
environment — which is the worst possible moment.

---

## The storefront

**Arbor**, at **http://localhost:8090** — the real customer-facing service, and
one of the seven the ops dashboard watches.

It is not a mock. Every interaction is a real request through the gateway:

| Action | Call | Service |
|---|---|---|
| Product grid | `GET /api/products` | product — catalogue, prices, **live stock** |
| Place order | `POST /api/orders` | order — reserves stock, writes the order |
| Confirmation | `GET /api/orders/:id` | orders — the **read** path, SELECT-only role |

The confirmation deliberately reads the order back from the *read* service
rather than echoing the POST response, which proves the write landed and is
visible on the read path — the CQRS split doing real work rather than sitting
in a diagram.

### The incident demo is real

Ticking **"submit without a shipping address"** omits `shippingAddress`
entirely and renders whatever the backend actually returns:

| Seeded fault | Response |
|---|---|
| Disarmed | `400` — `{"error":"shippingAddress {line1, city, postcode} required"}` |
| Armed | `500` — `{"error":"internal_error","request_id":"…"}` |

Verified end to end: that `request_id` appears in the order service's real logs
alongside `TypeError: Cannot read properties of undefined (reading 'line1') at
buildShipTo`. A well-formed order still returns `201` while the fault is armed,
so it is a **partial** failure — which is what makes it worth diagnosing.

A hard-coded error string would look identical on screen and prove nothing.

### Product photos

Drop 8 JPEGs into [`services/frontend/public/images/`](services/frontend/public/images/),
named after each product's **SKU** — `tote.jpg`, `mug.jpg`, `scarf.jpg`,
`shirt.jpg`, `belt.jpg`, `beanie.jpg`, `throw.jpg`, `bookend.jpg`. The SKU
doubles as the image slug, so there is no mapping table to drift out of sync.
Until a file exists the card shows a neutral tile labelled with the SKU, so it
is obvious which photo is missing. No code change is needed.

### Guest checkout

The gateway requires a verified JWT for `POST /orders` and strips any
client-supplied `x-user-id`, so identity can only come from a token it issued.
The design has no sign-in, so the storefront registers a throwaway account and
keeps it in `localStorage`. The order really is placed by an authenticated user
with their own order history — the security boundary is preserved rather than
weakened to suit the design.

> **Changing the catalogue resets the database.** Postgres only runs its init
> scripts on an empty data dir, so editing `db/init/01-schemas.sql` means
> deleting the PVC (`kubectl -n aiops-dev delete pvc data-postgres-0 pod/postgres-0`)
> or `docker compose down -v`. Existing orders are lost.

---

## The dashboard

A live instrument panel plus a terminal-style chat with Kira, at
**http://localhost:5173**. Every number is read from the running cluster —
there is no mock data path.

```bash
bash scripts/cluster-up.sh                        # cluster + platform
cd aiops/kira      && npm install && npm run server   # API on :7777
cd aiops/dashboard && npm install && npm run dev      # UI  on :5173
bash scripts/traffic.sh                           # ambient load for the charts
```

Full detail, including the design rationale, is in
[aiops/dashboard/README.md](aiops/dashboard/README.md).

**Two things are more real than they look:**

- **The incident button commits to Git.** A `kubectl` patch would be instant,
  but ArgoCD's `selfHeal` reverts drift within ~3 minutes and the incident would
  resolve itself mid-demo. Instead it edits the manifest, commits, pushes and
  syncs — and the five pipeline stages light up as each one actually completes,
  which turns a 30–90s wait into the clearest available explanation of how the
  system works.
- **Incident history is `git log`.** Every incident here is caused and resolved
  by a commit, so Git already is the incident log. Each row carries its short
  SHA and is verifiable with `git show`.

**Why the dashboard needs a backend at all:** the browser cannot reach
Prometheus or Loki (no CORS headers) or the Kubernetes API (needs a kubeconfig
credential that must never reach a browser). The API server reuses Kira's own
three tools rather than reimplementing the queries, so the agent and the UI
share one definition of every metric.

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
infra/k8s/
  base/             environment-agnostic Deployments + Services for all 7
  overlays/dev/     image tags — THE FILE CI WRITES TO, and ArgoCD reads
infra/terraform/
  kind-config.yaml  cluster topology (1 control-plane + 2 workers, port maps)
  main.tf           the 4 Helm releases
  values/           one YAML per chart — reviewable, lintable, diffable
aiops/              Kira agent + 3 scoped tools  (Phase 5)
docs/design-notes/  the superseded AWS design, kept for its reasoning
.github/workflows/ci.yml   build → GHCR → GitOps handoff
```

## Contributing

`main` is protected by convention: work happens on feature branches named
`feat/<service>-<thing>` (e.g. `feat/order-idempotency-keys`) and merges via
PR. Pull requests run lint and tests but **never** build or push images — only
a merge to `main` publishes images.

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

### Cost: zero

Kira runs on a **local Ollama model** (`qwen2.5:7b`), so there is no API
billing and no key to manage. The entire project — build, deploy, observe,
diagnose — costs nothing beyond electricity.

A measured diagnosis: 3 tool calls, 2 turns, 41.8s, **free**.

**If you have Anthropic API access, `claude-sonnet-5` is the better model** and
is a one-line swap (`KIRA_PROVIDER=anthropic`). The three-way correlation this
agent depends on is exactly where a 7B model's limits show: on the seeded
incident it found the root cause correctly but also listed a service as
affected that had zero errors. Roughly $0.12 per diagnosis. See
[aiops/kira/README.md](aiops/kira/README.md#which-model).

> **Memory.** qwen2.5:7b needs ~5GB alongside the cluster's ~5.5GB. On 16GB
> that works but is tight; the first call takes ~50s while the model loads.

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
