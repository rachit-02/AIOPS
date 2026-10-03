# The live demo change

**Not applied.** Make this edit yourself, in front of the room, at Step 3 of
`DEMO.md`.

## File

`services/_shared/index.js` — **line 152**

## Current

```js
  app.get('/health', (req, res) => res.json({ status: 'ok', service: name }));
```

## Change to

```js
  app.get('/health', (req, res) =>
    res.json({ status: 'ok', service: name, build: 'mid-sem-demo' }));
```

Change `'mid-sem-demo'` to anything you like — a date, your initials. The
string is arbitrary; what matters is that it is visibly *yours* and visibly
*new*.

## Then

```bash
git add services/_shared/index.js
git commit -m "feat(_shared): report build version on /health"
git push origin main
```

## How you prove it landed, ~6 minutes later

```bash
curl -s http://localhost:8090/health
```

Before: `{"status":"ok","service":"frontend"}`
After:  `{"status":"ok","service":"frontend","build":"mid-sem-demo"}`

---

## Why this change and not another

**It cannot break anything.** It adds a key to a JSON response. No branching,
no new dependency, no behaviour change. Nothing reads `/health` except the
Kubernetes liveness probe, which checks the status code, not the body. Even a
typo in the string is harmless.

**It is directly visible with one command, no `kubectl` needed.** The frontend
service is the only one exposed outside the cluster, and its `/health` is
reachable at `http://localhost:8090/health`. Verified — that URL answers today.
Every other service's `/health` would need a `kubectl exec`, which is a worse
thing to do live.

**It demonstrates the shared library.** `_shared/index.js` is imported by all
seven services, so the change ships to all seven. The CI run visibly builds
seven images. That is a better story than touching one service.

**It gives you something true to say while CI runs:** this is why `/health`
deliberately does *not* check the database — a liveness probe that checks a
dependency restarts healthy pods during a blip, converting a recoverable
outage into a crash loop. `/ready` is where dependency checks belong, and the
split is right there in the same file.

## What to watch out for

Any change under `services/**` rebuilds **all seven images** — there is no
per-service path filter. That is why the pipeline takes ~3m35s rather than
~1m. Expected, not a fault, but do not be surprised by seven parallel build
jobs for a one-line edit.

## Fallback if you want something more visually dramatic

Edit the hero line in `services/frontend/public/index.html` (line 40). Text on
the storefront page changes after the pipeline runs, which reads instantly to
a non-technical observer. Same pipeline, same timing, same safety — but it
touches the storefront, which is out of scope for a Phases 1–4 demo.
