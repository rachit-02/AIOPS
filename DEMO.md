# Mid-sem demo runbook — Phases 1–4

Scope: **local dev → CI/CD → GitOps → observability.** Kira, the ops dashboard
and the storefront's checkout features are out of scope and should not be
opened.

Total runtime ~12 minutes, including a live commit that flows all the way to
the cluster while you talk over it.

---

## 0. The one thing that will sink this demo

**A `services/**` change takes 8–12 minutes from `git push` to new pods
serving.** Measured end to end on 2026-10-03, not estimated:

| Stage | Measured | Notes |
|---|---|---|
| GitHub Actions (8 checks → e2e → 7 image builds → gitops commit) | **3m21s** | e2e alone is 2m27s |
| ArgoCD picks up the commit | **10s forced / 4m+ polled** | see the warning below |
| Image pull + rollout | **~5m** | kind pulls every new tag from GHCR per node |

An **infra-only** change (the incident toggle) is much faster — no CI, no image
pull. Measured: push `09:10:18Z` → fault live `09:14:17Z` = **3m59s** polled,
and ~10 seconds if you force the refresh.

**So the live change in Step 3 is an infra-only change** - a replica count in
`infra/k8s/overlays/dev/kustomization.yaml`. It lands in about a minute with a
forced refresh, and you watch it land in Step 4 rather than waiting on CI.
See `CHANGE.md`.

Phase 2 (CI/CD) is then demonstrated in Step 7 from the **last real CI run**
and the bot commits already in `git log` - which is honest evidence and costs
no time. Do not push a `services/**` change live unless you have twelve
minutes to spare and something to fill them with.

### Do not trust ArgoCD's auto-sync. Force the refresh.

During the dry run ArgoCD reported **`Synced / Healthy` while sitting on a
commit three revisions behind origin/main**, for 5.5 minutes. `reconciledAt`
was frozen despite the 120s interval. The status was literally true — it *was*
synced to that revision — it just was not synced to anything recent.

A hard refresh fixed it in 10 seconds:

```bash
kubectl -n argocd annotate application aiops-dev argocd.argoproj.io/refresh=hard --overwrite
```

Or the **Refresh** button in the UI. Use it every time; it is a legitimate
operation, not a cheat, and worth saying so out loud.

---

## 1. Pre-demo checklist (start ~20 minutes early)

```bash
# 1. Docker Desktop must be running BEFORE anything else.
docker info >/dev/null && echo "docker ok"

# 2. Compose must be DOWN. The cluster and compose together exceed the
#    memory available to Docker, and cluster-up.sh refuses to run otherwise.
cd /d/Major/AiOps
docker compose ps -q        # must print nothing
docker compose down         # if it printed anything

# 3. Free up resources: unrelated containers compete with the cluster.
docker ps --format '{{.Names}}\t{{.Status}}' | grep -v aiops-local
#    Stop anything crash-looping (honeypot-*) and any other project stack.
#    docker stop honeypot-1 honeypot-2 honeypot-3

# 4. Cluster up and every pod READY. After a Docker restart this takes
#    90-120 seconds - do not start the demo while anything is 0/1.
kubectl get pods -A --no-headers | awk '{split($3,a,"/"); if (a[1]!=a[2] || $4!="Running") print}'
#    Empty output = good to go.

# 5. All four surfaces answering.
curl -s -o /dev/null -w "frontend   %{http_code}\n" http://localhost:8090/health
curl -s -o /dev/null -w "argocd     %{http_code}\n" http://localhost:8091/
curl -s -o /dev/null -w "grafana    %{http_code}\n" http://localhost:3031/api/health
curl -s -o /dev/null -w "prometheus %{http_code}\n" http://localhost:9091/-/ready
#    All must be 200. Grafana is the flaky one - see Troubleshooting.

# 6. Start traffic in its OWN terminal and leave it running all demo.
bash scripts/traffic.sh
#    Charts need ~2 minutes of traffic before rate() windows fill.

# 7. Confirm the charts actually have data before you present them.
curl -s --get --data-urlencode 'query=sum by (job) (rate(http_requests_total{namespace="aiops-dev"}[1m]))' \
  http://localhost:9091/api/v1/query | grep -o '"job":"[a-z]*"' | sort -u
#    Should list several services. Empty = traffic is not reaching the cluster.
```

**Tabs to open, in this order (left to right):**

| Tab | URL | Login |
|---|---|---|
| GitHub Actions | `https://github.com/rachit-02/AIOPS/actions` | — |
| ArgoCD | `http://localhost:8091` | `admin` / `akM8vSdqSJBIyEJR` |
| Grafana — Three Signals | `http://localhost:3031/d/aiops-three-signals` | `admin` / `admin` |
| Storefront | `http://localhost:8090` | — |

Plus two terminals: one running `traffic.sh`, one free for commands.

---

## 2. Local development (Phase 1) — 90 seconds

> "Seven Node services. One shared library gives all of them the same three
> ops endpoints, so observability isn't bolted on per service."

```bash
cat docker-compose.yml | head -30
ls services/
```

Show `services/_shared/index.js` — the `/health`, `/ready`, `/metrics` block.

> "`/health` is liveness — it never touches the database. `/ready` checks
> Postgres. If liveness checked the database, one DB blip would restart every
> healthy pod and turn a recoverable outage into a crash loop."

**Say:** the same code runs under compose locally and as an image in the
cluster. No "works on my machine" gap.

---

## 3. Push the live change NOW — 90 seconds

This is the Phase 3 (GitOps) demonstration; Step 4 is where it lands.

Full detail, including the exact edit and the undo, is in `CHANGE.md`.

Open `infra/k8s/overlays/dev/kustomization.yaml`, find:

```yaml
patches:
- path: frontend-nodeport.yaml
```

and add below it:

```yaml

replicas:
- name: product
  count: 2
```

```bash
git add infra/k8s/overlays/dev/kustomization.yaml
git commit -m "chore(dev): run two product replicas"
git push origin main
```

> "I've just told Git I want two copies of the product service. I haven't
> touched the cluster — no `kubectl`, no deploy command, no CI. The only thing
> that changed is a file in a repository."

**This path does not trigger CI.** The workflow only watches `services/**`, so
there is no build, no registry push and no image pull. Go straight to Step 4
and watch it arrive.

---

## 4. GitOps (Phase 3) — 3 minutes

Switch to the **ArgoCD** tab.

```bash
kubectl get application -n argocd
```

> "ArgoCD watches the Git repo and makes the cluster match it. Nobody deploys
> by hand. Git is the only source of truth."

Show the app tree in the UI: the root app owning `aiops-dev`, and the child
resources.

```bash
kubectl get application aiops-dev -n argocd -o jsonpath='{.spec.syncPolicy}'; echo
```

> "`prune` and `selfHeal`. Prune means deleting a file from Git deletes the
> resource. Self-heal means manual drift is corrected automatically."

### The refresh — do this explicitly, do not wait for auto-sync

**Do not say "and now we watch it sync automatically."** During the rehearsal
ArgoCD reported `Synced / Healthy` while sitting three commits behind
origin/main, for 5.5 minutes. If you stand there narrating an auto-sync that
is not happening, you will be stuck in front of the room with nothing to show.

Make the refresh a deliberate, explained step instead. It is more honest and
it is a better engineering point.

**First, show the gap. Two commands, side by side:**

```bash
kubectl get application aiops-dev -n argocd -o jsonpath='{.status.sync.revision}'; echo
git ls-remote origin main
```

**The exact line to say:**

> "ArgoCD is reporting Synced and Healthy. But look — that's the commit it
> synced, and this is what's actually on `main`. They can differ. 'Synced'
> means 'the cluster matches the revision I last fetched', not 'the cluster
> matches your latest commit.' It polls every two minutes and that poll is not
> always reliable, so I'm going to ask it to look now rather than hope."

**The exact click:**

> In the ArgoCD UI, open the **`aiops-dev`** application (click its card on the
> Applications page). In the toolbar across the top you'll see
> **SYNC · SYNC STATUS · HISTORY AND ROLLBACK · DELETE · REFRESH**.
> Click the small **▾ caret on the REFRESH button** and choose **HARD REFRESH**.
> (Plain **REFRESH** re-reads the cluster; **HARD REFRESH** also bypasses the
> repo-server's cached manifests, which is the part that was stale.)

Equivalent from the terminal, if the UI is slow — this is what was measured at
~10 seconds:

```bash
kubectl -n argocd annotate application aiops-dev argocd.argoproj.io/refresh=hard --overwrite
```

**Then say:**

> "That's the one place this setup isn't fully hands-off, and it's worth being
> straight about it. In production you'd wire a webhook from GitHub so a push
> notifies ArgoCD instead of ArgoCD asking every two minutes. I can't, because
> this cluster is on my laptop and GitHub can't reach it."

### Now watch Step 3's commit arrive

Within a second or two of the refresh the app flips to **`OutOfSync`** and the
`product` **Deployment** is flagged. Click it, then the **DIFF** tab:

> "Left side is what's running: one replica. Right side is what Git says:
> two. ArgoCD's whole job is to make the left match the right."

Auto-sync fires; the app returns to **`Synced` / `Healthy`** and a second
`product-…` pod appears in the resource tree.

```bash
kubectl get pods -n aiops-dev -l app.kubernetes.io/name=product -o wide
kubectl get endpointslices -n aiops-dev -l kubernetes.io/service-name=product \n  -o custom-columns=NAME:.metadata.name,ADDRESSES:.endpoints[*].addresses
```

Two pods, the new one seconds old on the other worker, and the Service now
listing **two** backend addresses.

> "Seconds, not minutes — the image was already on the node, so nothing was
> downloaded. And the new pod is in the load-balancing set automatically,
> because the Service selects on labels, not on a list of addresses I maintain."

The *Replicas ready / desired* panel in Grafana (Step 5) will show `product`
stepping 1 → 2. Same change, visible in Git, in the cluster, and on the
dashboard.

**Undo it after the demo** — `CHANGE.md` has both methods; the Git revert is
the one worth showing:

```bash
git revert --no-edit HEAD && git push origin main
kubectl -n argocd annotate application aiops-dev argocd.argoproj.io/refresh=hard --overwrite
```

### Optional: prove self-heal (fast — seconds, not minutes)

```bash
kubectl scale deploy/product -n aiops-dev --replicas=3   # manual drift
kubectl get deploy product -n aiops-dev                  # run it a few times
```

It drops back to 1 almost immediately.

> "I just changed production by hand and it was reverted before I finished
> talking. Note the asymmetry: reverting *drift* is instant, because the
> controller is watching the cluster and sees it immediately. Noticing a *new
> commit* is the slow, unreliable half — that's a poll, which is why I refreshed
> manually a moment ago."

---

## 5. Observability — the three signals (Phase 4) — 3 minutes

Switch to the **Grafana** tab, `AIOps — Three Signals`.

> "Three independent signals, from three independent systems. That
> independence is the point — any one of them can lie."

- **Signal 1, pod health** — from the Kubernetes API via kube-state-metrics.
- **Signal 2, metrics** — Prometheus scraping each service's `/metrics`.
- **Signal 3, logs** — Loki, shipped by Fluent Bit.

> "Watch the error rate panel. Right now it reads 0% — not blank. That took a
> fix: the query divides a 5xx rate by a total rate, and when nothing is
> failing the numerator has no series at all, so the panel rendered empty. An
> empty panel and a broken panel look identical, which is the worst possible
> failure for a chart whose job is to tell you something is wrong."

### The incident (this is the money shot)

**Arm it through Git. Do NOT use `kubectl set env` — ArgoCD self-heal reverts
it within SECONDS and the incident never fires at all.**

Tested twice. The second time, ArgoCD had already reverted the change at
08:32:42, before `kubectl rollout status` even returned at 08:32:48 — self-heal
is event-driven, it does not wait for the 120s poll. The deployment never ran
with the fault armed, and the error rate stayed flat at 0% for two and a half
minutes while I waited for an incident that was never happening.

Edit `infra/k8s/base/order/deployment.yaml`, line ~35:

```yaml
            - name: SEED_BUG_NULL_SHIPPING
              value: "false"      # <-- change to "true"
```

```bash
git add infra/k8s/base/order/deployment.yaml
git commit -m "chore(demo): enable seeded Order-service incident"
git push origin main
```

This path does **not** trigger CI — the workflow only watches `services/**` —
and needs no image pull, so it is just ArgoCD plus a restart. Measured:
**3m59s** waiting on the poll, **~10 seconds** if you force the refresh. Force
it.

> "Breaking production also happens through Git. There is no button for this
> and no `kubectl` — I commit the fault, ArgoCD delivers it. Which means the
> incident is reviewable, attributable and revertible, exactly like a feature."

Wait ~60 seconds with traffic running, then on the dashboard:

- **Pod health: still green.** Nothing restarted; the process didn't die.
- **Error rate: climbing** (the generator sends an address-less order every
  third cycle — those now 500 instead of 400).
- **Error logs: the TypeError stack, pointing at `buildShipTo`.**

> "This is the whole argument for three signals. Health alone says the system
> is fine. Metrics say something is wrong but not what. Only the logs name the
> function. Any one signal on its own would have misled you."

**What the rehearsal actually produced** (2026-10-03), so you know what to
expect and can tell if something is off:

| Signal | Reading |
|---|---|
| Pod health | `order 1/1 Running`, **0 restarts** |
| Error rate | order **10.5%**, gateway 3.4%, frontend 4.2% (baseline 0.0%) |
| Logs | `unhandled_error` → `TypeError: Cannot read properties of undefined (reading 'line1')` → `at buildShipTo (index.js:69:21)` |

The error rate decreasing up the chain — order 10.5% → gateway 3.4% →
frontend 4.2% — is worth pointing at: only a fraction of each upstream
service's traffic reaches the failing call, so the signal dilutes with
distance. That is why you alert on the service, not the edge.

Then resolve it the same way:

```bash
git revert --no-edit HEAD
git push origin main
```

> "The fix ships the same way the fault did."

**If you want to prove self-heal instead** (fast, no push, and it is a genuinely
good moment):

```bash
kubectl set env deploy/order -n aiops-dev SEED_BUG_NULL_SHIPPING=true
kubectl set env deploy/order -n aiops-dev --list | grep SEED_BUG
# Run the second command a few times. It flips back to false within seconds.
```

> "I just changed production by hand. ArgoCD put it back, because Git says
> `false` and Git wins. That is self-heal — and it is why the incident has to
> be committed rather than clicked."


---

## 6. Loki directly (optional, 60 seconds)

In Grafana → Explore → Loki:

```logql
{kubernetes_namespace_name="aiops-dev", level="error"} | json
```

> "Note the label is `kubernetes_namespace_name`, not `namespace` — Fluent Bit
> flattens the Kubernetes metadata. Getting that wrong returns an empty result
> with no error, which is a very easy way to convince yourself there are no
> logs when there are."

---

## 7. CI/CD — the other half (Phase 2) — 2 minutes

Nothing is pending here: Step 3's change was infra-only and landed in Step 4.
This step shows the CI half from **evidence already in the repo**, which costs
no waiting and is no less real.

Switch to the **GitHub Actions** tab and open the most recent run on `main`.

> "Every push under `services/` runs this. Eight packages linted and tested,
> then a real browser driving a real checkout against real services, then seven
> images built and pushed to the registry. Nothing is built until the tests
> pass, and nothing is pushed until the end-to-end test completes."

Point at the job graph — `prepare → check ×8 → e2e → build ×7 → gitops`. The
dependency arrows make the argument without the run needing to be live.

Then the handoff, which is the part that matters:

```bash
git log --oneline -40 | grep "chore(deploy)"
```

> "Those are the bot's commits. CI's last act isn't a deploy — it's a commit.
> It writes the new image tags back into this repo and stops. It has no
> credentials for the cluster and never runs `kubectl`. ArgoCD takes it from
> there, which is why 'what's deployed?' is answered by `git log`."

```bash
git show --stat $(git log --format=%H -1 --grep="chore(deploy)")
kubectl get deploy -n aiops-dev   -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image --no-headers
```

> "One file changed — the image tags. And those are the exact tags running in
> the cluster right now. Git and the cluster agree, and that agreement is
> enforced, not hoped for."

**If you do want to show a live CI run**, start it before the demo begins, not
during: it is 3m21s for CI plus up to 4 minutes for ArgoCD plus ~5 minutes of
image pulls across the nodes. Section 0 has the measured breakdown.

---

## 8. Closing line

> "Every number on those dashboards came from a running system. The failure I
> showed you is a real unhandled exception in a real service, not a scripted
> error — and the three signals disagreed with each other in exactly the way
> that makes the architecture worth having."

---

## Troubleshooting

**Grafana is 000 / not loading.** This is the most likely thing to break — it
has restarted 29 times and gets slow under memory pressure.

```bash
kubectl rollout restart deploy/kube-prometheus-stack-grafana -n monitoring
kubectl rollout status  deploy/kube-prometheus-stack-grafana -n monitoring
```

Takes ~90 seconds. **Backup plan:** Prometheus at `http://localhost:9091` has
its own graph UI and needs no login. Paste the same queries there. Have this
tab already open.

**Charts are blank.** `traffic.sh` isn't running, or hasn't run long enough.
`rate()` over a 1m window needs ~2 minutes of traffic. Check:
`curl -s http://localhost:8090/api/products | head -c 80`

**ArgoCD shows Synced but nothing changed.** Two different causes, both seen
during the dry run.

1. *It is synced to a stale revision.* Compare what it thinks it is on against
   the remote, then force a refresh:
   ```bash
   kubectl get application aiops-dev -n argocd -o jsonpath='{.status.sync.revision}'; echo
   git ls-remote origin main
   kubectl -n argocd annotate application aiops-dev argocd.argoproj.io/refresh=hard --overwrite
   ```
2. *It applied a file that isn't the one you think.* Check the rendered object,
   not the sync status:
   `kubectl get cm <name> -n aiops-dev -o yaml | head -40`

**CI is still running when you need it.** Show the Actions tab live and narrate
the job graph instead — `check` → `e2e` → `build` → `gitops` is itself the
story. The dependency arrows make the "nothing ships unless tests pass" point
without needing the run to finish.

**Pods are 0/1 after starting Docker.** Normal. Wait 90–120 seconds.

**`cluster-up.sh` refuses to start.** Compose is still running:
`docker compose down`.

---

## Known weak spots, if asked

- **Grafana stability.** Single replica, SQLite, no resource limits tuned, on a
  laptop kind cluster. It is the least reliable component in the stack.
- **ArgoCD polls, it isn't pushed to.** No webhook, because the cluster isn't
  reachable from GitHub. Hence the up-to-2-minute delay.
- **CI rebuilds all 7 images on any `services/**` change.** There is no
  per-service path filter, so a one-line comment costs a full rebuild, and then
  every kind node pulls all 7 new tags from GHCR (~5 minutes). Correct but
  wasteful; a `dorny/paths-filter` step would fix the rebuild half.
- **ArgoCD's auto-sync is not reliable here.** It reported Synced/Healthy on a
  revision three commits stale for 5.5 minutes during the dry run. Forcing the
  refresh works instantly, but "GitOps converges automatically" deserves the
  caveat if you are asked.
- **Terraform bootstraps the root ArgoCD Application with `kubectl`** via a
  `local-exec`, because the CRD doesn't exist until the Helm release is
  installed. So "zero manual kubectl" is not quite true, and it's better to say
  so than to be caught on it.
