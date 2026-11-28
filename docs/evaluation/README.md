# Kira evaluation — method

This folder holds measured results of Kira's diagnosis accuracy against seeded
faults. Results are produced by `scripts/eval-kira` and are never edited by
hand: a failed run is a result, and stays in the CSV with the reason it failed.

## Scenarios

| Scenario | Fault (infra/k8s/faults) | Origin | Category |
|---|---|---|---|
| HEALTHY | none armed | — | `none` |
| F1 | `order` throws on an order without a shipping address | order | `code-bug` |
| F2 | `product` delays every request by 1200 ms | product | `latency` |
| F3 | `user` exits shortly after start | user | `crash-loop` |
| F4 | `auth` leaks memory to a 128Mi limit | auth | `out-of-memory` |
| F5 | `orders` points at a database host that does not exist | orders | `bad-config` |
| F6 | `gateway` image tag that does not exist | gateway | `bad-deploy` |

Each fault is armed by an infra-only Git commit (ArgoCD applies it; no CI
build), exactly as an operator or the dashboard would do it. Only one fault is
armed at a time.

## Procedure (per scenario)

1. **Arm** the fault (Git commit → ArgoCD). HEALTHY arms nothing.
2. **Wait until the fault is visible** in the telemetry — not just "applied" —
   by polling, with a 6-minute timeout:
   F1 order 5xx > 0 · F2 product p50 ≥ 800 ms · F3 a `user` pod in
   CrashLoopBackOff · F4 an `auth` pod whose last state is OOMKilled ·
   F5 an `orders` pod not Ready plus a `readiness_check_failed` log line ·
   F6 a `gateway` pod in ErrImagePull/ImagePullBackOff.
   A fault that never becomes visible is recorded as `not_visible` and scored 0.
3. **Ask Kira N times** (default 3) through its API, the same path the
   dashboard uses, with the fixed question: *"Users report problems with the
   shop. Investigate the aiops-dev namespace over the last 5 minutes and tell me
   the root cause."* Kira is never told which fault is armed.
4. **Score** each answer automatically (below) and record the wall-clock time
   from question to answer (*time to diagnosis*).
5. **Disarm**, then wait for **full recovery** before the next scenario: no
   fault annotation, every rollout complete, every pod Ready, no restart in the
   last 10 minutes, and no 5xx and no slow service in the last 5 minutes — so
   one fault's symptoms can never leak into the next scenario's window.

The harness generates its own light traffic (the same mix as
`scripts/traffic.sh`) and refuses to start if `traffic.sh` is running, so load
is identical across runs.

## Scoring: four checks

A run is **correct only if all four pass**. The partial score (0–4) is also
recorded.

1. **Origin** — the expected origin service is named in the *Root cause*
   section, and if the *Affected services* line marks an `(origin)`, it is
   that service. Service names are matched exactly: `order` (write) never
   matches `orders` (read). For HEALTHY: Root cause says "No active incident".
2. **Category** — the `**Category:**` line at the top of Root cause equals the
   expected category (`code-bug | latency | crash-loop | out-of-memory |
   bad-config | bad-deploy | none`). Only if the line is missing is a keyword
   fallback used, and that is recorded (`category_fallback=true`).
3. **Evidence** — at least one expected piece of evidence appears in the
   answer (e.g. F1: `line1` / TypeError / 500; F2: p50/p95/p99 or a millisecond
   figure; F3: CrashLoopBackOff; F4: OOMKilled / memory limit; F5: ENOTFOUND /
   database / readiness; F6: ImagePullBackOff / ErrImagePull).
4. **Blast radius** — no service outside the allowed set appears on the
   *Affected services* line. Allowed sets: F1 order, gateway, frontend · F2
   product, order, gateway, frontend · F3 user · F4 auth, gateway, frontend ·
   F5 orders, gateway, frontend · F6 gateway · HEALTHY none.

The exact patterns are in `scripts/eval-kira/score.js`
(`EXPECTATIONS`), with unit tests in `score.test.js`.

## Reproducing

```bash
# Kira server running (cd aiops/kira && npm run server), kubectl context
# kind-aiops-local, no fault armed, scripts/traffic.sh stopped.
node scripts/eval-kira                       # HEALTHY + F1..F6, 3 runs each
node scripts/eval-kira --runs 5              # 5 runs each
node scripts/eval-kira --faults F1 --runs 1  # a single fault
```

Expected runtime (CPU-only qwen2.5:7b, ~1–2 min per investigation): about
12–15 min per fault at 3 runs, dominated by the recovery wait; **≈ 1.5–2 h**
for the full set at `--runs 3` and **≈ 2–2.5 h** at `--runs 5`.

Output: `kira-eval-<date>.csv` (one row per run: checks, category found,
wrong services, time to diagnosis, time to visible, guard used, partial,
trace file, answer excerpt) and `kira-eval-<date>.md` (the per-scenario
table). Each run's full tool trace is in `aiops/kira/traces/` (local).

## Re-scoring saved answers

```bash
node scripts/eval-kira --rescore docs/evaluation/kira-eval-<date>.csv
```

Re-scores every run from its saved answer (the trace in `aiops/kira/traces/`,
or the verbatim copy in `scripts/eval-kira/fixtures/<run>.answers.json`)
with the current scorer. No fault is re-run, and the original files are left
untouched; output is `<name>-rescored.csv` / `<name>-rescored.md`, listing
every changed verdict and every remaining failure.

## Scorer fix (2026-11-28)

**What was wrong.** The model does not always follow the five-heading
format: some answers start straight with the `**Category:**` line and have no
`### Root cause` heading, one put only the Category line under Root cause, and
several used bold pseudo-headings (`**Blast radius:**`) instead of `###`. The
scorer only recognised `###` headings, found no Root-cause text, and failed
the **origin** check even when the *Affected services* line marked the correct
`(origin)`. Its reason message ("origin: expected auth, marked auth") hid which
condition had actually failed.

**What changed** (`scripts/eval-kira/score.js`): both heading styles are
recognised (any case); when there is no Root-cause section the text before the
first heading is used; a correct `(origin)` marker passes unless the Root cause
names *only other* services (that contradiction still fails); a wrong marker
still fails; reasons now name the exact failing condition; a non-scoring
warning flags prose that calls a different service "the origin". Nothing else
was relaxed — category, evidence and blast-radius checks are unchanged, and a
test asserts that no answer previously scored correct changes verdict.
Regression tests use the 34 real answers of the 2026-11-27 run
(`scripts/eval-kira/score.real-answers.test.js`).

**Effect on the 2026-11-27 20:54 run** (`kira-eval-2026-11-27-2054`, 35 runs):
7 verdicts changed, all WRONG → CORRECT (F1 run 3, F4 runs 4–5, F5 run 1,
F6 runs 3–5). **Raw accuracy 19/35 (54%) → corrected 26/35 (74%).** Both
results are kept: the original `.md`/`.csv` as produced, and
`kira-eval-2026-11-27-2054-rescored.md`/`.csv`. F6 run 5 passes the four
checks but is flagged: one sentence of its blast radius calls `order` the
origin.

## Known limits of the method

- Pattern-based scoring can be fooled by an answer that names the right
  service and keywords while reasoning badly; read the answer excerpts.
- Three runs per scenario at temperature 0 measure consistency more than
  variety; differences between runs come from changing telemetry.
- The faults are seeded and known to the author (not to Kira); they cover
  common failure classes, not the full space of real incidents.
