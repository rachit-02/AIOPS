# Flight Recorder — the dashboard

A live instrument panel for the AIOps system, plus a terminal-style chat with
Kira. **Every number on screen comes from the running cluster** — Prometheus,
Loki and the Kubernetes API. There is no mock data path and no sample payload
to fall back on, deliberately: a dashboard that silently degrades to
plausible-looking fake numbers when its backend dies is worse than one that
shows an error, because you cannot tell the difference from the screen.

## Run it

Three processes. The cluster must be up first (`bash scripts/cluster-up.sh`).

```bash
# 1. the API — reuses Kira's three tools
cd aiops/kira && npm install && npm run server      # :7777

# 2. the dashboard
cd aiops/dashboard && npm install && npm run dev    # :5173

# 3. ambient load, so the charts have something to draw
bash scripts/traffic.sh
```

Then open **http://localhost:5173**.

> Vite binds to IPv6, so use `localhost:5173` rather than `127.0.0.1:5173`.

### Why there is a server at all

The browser cannot reach the data sources directly: Prometheus and Loki send no
CORS headers for cross-origin XHR, and the Kubernetes API needs a kubeconfig
credential that must never be shipped to a browser. So
[`aiops/kira/src/server.js`](../kira/src/server.js) sits in between — and
crucially it **reuses Kira's existing three tools** rather than reimplementing
the queries, so "what the error rate is" has exactly one definition, shared by
the agent and the UI.

## What is real

| Surface | Source |
|---|---|
| Service status, error rate, p99 | Prometheus, via `fetch_metrics` |
| Sparklines and charts | Prometheus range queries |
| Pod health grid, restarts | Kubernetes API, via `fetch_health` |
| Recent errors + stack traces | Loki, via `fetch_logs` |
| Image tag on the header | the running Deployment — the tag *is* the git SHA |
| Kira's tool calls and report | a live model call, streamed over SSE |
| **Incident history** | **`git log` on the order manifest** |
| **Incident trigger/resolve** | **a real commit, pushed, synced by ArgoCD** |

### The incident button commits to Git

It would be far simpler to `kubectl set env` the flag. That was rejected: the
ArgoCD Application runs with `selfHeal: true`, so a manual patch is reverted
within about three minutes — the incident would resolve itself part-way through
a demo.

So the button edits the manifest, commits, pushes, and nudges ArgoCD. That takes
30–90 seconds, and the **five pipeline stages light up as each one actually
completes**. The wait becomes the clearest explanation of how the system works
rather than dead time.

It also means incident history needs no storage: every incident is a commit, so
`git log` already *is* the log, with real timestamps and authors. Each row shows
its short SHA, so any line can be checked with `git show <sha>`.

## Design

Built to the "Flight Recorder" brief: an instrument panel, not a marketing page.

- **Tokens, never one-off values.** All colour lives in CSS custom properties in
  [`src/index.css`](src/index.css), which is what makes the theme switch a single
  attribute flip. The light theme **darkens** the signal colours — the dark-mode
  cyan and amber sit near 2:1 against a white panel and fail contrast outright.
- **Hairline dividers via `gap: 1px`** over a border-coloured background, so
  adjacent panels share one line instead of stacking two borders.
- **3px radius, no drop shadows** except the two overlays (palette, toasts).
- **Two families only**: Space Grotesk for UI, JetBrains Mono for every number,
  log line and identifier.
- **One motion moment**: Kira's tool calls streaming in. It is not a typewriter
  effect over pre-fetched text — each line appears when the server actually
  emits it, so the pacing is the real latency of a real investigation. A spinner
  would have hidden the only part worth watching.
- **Amber means "happening now".** The pipeline lights only while a change is
  moving through it. An earlier version also lit the whole chain whenever an
  incident was live, which left five nodes glowing permanently and drained the
  colour of meaning.
- **Status is never colour alone** — a dot *and* a sparkline shape *and* a
  numeric readout *and* a text tag.
- `prefers-reduced-motion` removes every animation; nothing conveys meaning by
  motion alone, so nothing is lost.

### Deep links

| URL | Effect |
|---|---|
| `?theme=light` / `?theme=dark` | force a theme (otherwise: stored choice, then OS preference) |
| `?ask=<question>` | start an investigation on load — a demo as a single URL |

## Screenshots for a write-up

[`scripts/shot.mjs`](scripts/shot.mjs) drives headless Edge over CDP and waits
in real time:

```bash
node scripts/shot.mjs "http://localhost:5173/" out.png 8000 1000 1600
```

`msedge --screenshot` captures at the load event and `--virtual-time-budget`
fast-forwards timers without waiting on a long-lived SSE stream, so neither can
capture Kira mid-investigation — which is the one view worth checking.
