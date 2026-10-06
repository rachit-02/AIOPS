# The live demo change

**Not applied.** Make this edit yourself, in front of the room, at Step 3 of
`DEMO.md`.

It touches only `infra/k8s/` — the path the `aiops-dev` ArgoCD application
watches — so **it does not trigger CI**. The GitHub Actions workflow only fires
on `services/**`. No image build, no registry push, no image pull. Just
ArgoCD and a rollout.

## Why this, and not a code change

An edit under `services/**` rebuilds all seven images, pushes them to GHCR, and
every kind node then pulls each new tag. Measured end to end: **8–12 minutes**.
Far too long to stand in front of a professor.

This change is the GitOps story on its own terms: *the desired state of the
cluster lives in Git, and changing Git changes the cluster.* That is Phase 3's
actual claim, and a replica count demonstrates it more directly than a string
in a JSON response does.

## File

`infra/k8s/overlays/dev/kustomization.yaml`

## The edit

Find these two lines (near the top, after the long comment block):

```yaml
patches:
- path: frontend-nodeport.yaml
```

Add this immediately below them:

```yaml

replicas:
- name: product
  count: 2
```

That is the whole change — four added lines, one of which is blank.
`git diff` will show exactly that.

Leave the `images:` block alone. CI rewrites it on every release, and
`kustomize edit set image` only touches that block, so a top-level `replicas:`
entry is safe from the bot.

## Commit and push

```bash
git add infra/k8s/overlays/dev/kustomization.yaml
git commit -m "chore(dev): run two product replicas"
git push origin main
```

## Then force the refresh — do not wait

ArgoCD polls every 120s and that poll is not dependable (see DEMO.md section 0).

> In the ArgoCD UI, open the **`aiops-dev`** application, click the **▾ caret on
> REFRESH**, choose **HARD REFRESH**.

Or from the terminal:

```bash
kubectl -n argocd annotate application aiops-dev argocd.argoproj.io/refresh=hard --overwrite
```

## What you should see in ArgoCD

1. Within a second or two of the refresh, the app flips to **`OutOfSync`** and
   the `product` **Deployment** tile is highlighted as differing.
2. Click the `product` Deployment → **DIFF** tab. It shows `replicas: 1` on the
   left (live) and `replicas: 2` on the right (desired, from Git). That diff is
   the whole point — say so.
3. Auto-sync fires. The app returns to **`Synced` / `Healthy`**, and a second
   `product-…` pod appears under the Deployment in the resource tree, briefly
   yellow, then green.

## What you should see in kubectl

```bash
kubectl get pods -n aiops-dev -l app.kubernetes.io/name=product -o wide
```

Before — one pod:

```
NAME                       READY   STATUS    AGE   NODE
product-5c5bb66b4d-gd8g8   1/1     Running   3d    aiops-local-worker
```

After — two, the new one seconds old, on the other worker:

```
NAME                       READY   STATUS    AGE   NODE
product-5c5bb66b4d-gd8g8   1/1     Running   3d    aiops-local-worker
product-5c5bb66b4d-xxxxx   1/1     Running   12s   aiops-local-worker2
```

Two further confirmations worth showing, because they prove the new pod is
actually in service rather than merely running:

```bash
# The Service now has two backend addresses, so traffic is load-balanced to both.
kubectl get endpointslices -n aiops-dev -l kubernetes.io/service-name=product \n  -o custom-columns=NAME:.metadata.name,ADDRESSES:.endpoints[*].addresses

# The Deployment's own view.
kubectl get deploy product -n aiops-dev
# READY should read 2/2
```

And in **Grafana → AIOps — Three Signals**, the *Replicas ready / desired*
panel under SIGNAL 1 steps `product` from 1 to 2. The same change, visible in
all three places: Git, the cluster, and the dashboard.

## Expected timing

| Stage | Expected |
|---|---|
| ArgoCD notices (hard refresh) | ~10s |
| ArgoCD notices (waiting on the poll) | up to ~4 min — don't |
| Pod scheduled and Ready | **a few seconds** |

The pod starts fast because `ghcr.io/rachit-02/aiops-product:d8f6a5c` is
already cached on **both** worker nodes — verified. Nothing is downloaded.
(`order` is the only other service cached on both; `user`, `auth`, `gateway`,
`frontend` and `orders` are each missing from one worker and would stall on a
pull, which is why `product` was chosen.)

## Undo it — practise this

Two options. The first is the one to use live, because it is itself a GitOps
point: a rollback is an ordinary commit.

```bash
# Option A - revert through Git (preferred)
git revert --no-edit HEAD
git push origin main
kubectl -n argocd annotate application aiops-dev argocd.argoproj.io/refresh=hard --overwrite
```

> "Rolling back is the same mechanism as rolling forward. There's no special
> rollback button, because the cluster just follows Git."

```bash
# Option B - drop the commit entirely, if you want the history clean for a re-run
git reset --hard HEAD~1
git push --force-with-lease origin main
kubectl -n argocd annotate application aiops-dev argocd.argoproj.io/refresh=hard --overwrite
```

Use Option B only while rehearsing. `--force-with-lease` rewrites `main`, which
is fine on a solo project but not a habit to demonstrate.

Confirm it is undone:

```bash
kubectl get deploy product -n aiops-dev     # READY back to 1/1
kubectl get pods -n aiops-dev -l app.kubernetes.io/name=product
```

## Why it cannot break anything

`product` is stateless. It serves `GET /products` and reserves stock with a
single atomic statement — `UPDATE products SET stock = stock - qty WHERE
stock >= qty` — so two replicas cannot oversell. That atomicity is the whole
reason the reservation was written that way, and running a second replica is a
decent, honest demonstration of it if you are asked.

Its Service is a ClusterIP with a label selector, so the new pod joins the
load-balancing set automatically with no configuration.

## Memory headroom — checked

An extra pod requests **64Mi** and is capped at **256Mi**.

| | |
|---|---|
| Docker VM total | 7.56 GiB |
| In use when measured | 3.49 GiB |
| Free | **~4.07 GiB** |
| Committed pod requests, all nodes | ~2.8 GiB |

Comfortably affordable, even after Grafana's limit went to 1Gi. Note that all
three kind "nodes" are containers sharing that single 7.56 GiB VM — Kubernetes
reports 7.56 GiB *per node*, which is misleading, so the VM figure is the one
that matters.

## Do not do this instead

`kubectl scale deploy/product -n aiops-dev --replicas=2` looks equivalent and
is **not**. ArgoCD self-heal reverts manual drift within seconds — measured at
about five. The replica count would snap back to 1 mid-sentence. That failure
is worth demonstrating deliberately (DEMO.md Step 4), but never as the means of
making this change.

## Fallback, if you want something more visually dramatic

Edit the hero line in `services/frontend/public/index.html`. Text on the
storefront changes after the pipeline runs, which reads instantly to a
non-technical observer. But it is a `services/**` path, so it costs the full
8–12 minutes and rebuilds all seven images.
