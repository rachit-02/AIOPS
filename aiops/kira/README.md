# Kira — the diagnostic agent

Kira investigates incidents by correlating **three independent observability
signals** and explains what went wrong. She **never remediates** — she produces
a root cause, the evidence behind it, a recommended fix and a prevention
suggestion. A human decides and acts.

## How she works

```
              ┌──────────────────────────────┐
  incident ──▶│  Claude (claude-sonnet-5)    │
  (one line)  │  system prompt: prompts/     │
              └──────────────┬───────────────┘
                             │ tool use, agentic loop
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
   fetch_metrics        fetch_logs        fetch_health
          │                  │                  │
    Prometheus             Loki        Kubernetes API
    :9091                  :3100          kubeconfig
```

Three tools, each reading **exactly one system**. That narrowness is the
design: a single `investigate()` tool returning everything would mean the
correlation happened in *our* code, not in the model's reasoning, and the
whole exercise would prove nothing.

| Tool | Answers | Cannot tell you |
|---|---|---|
| `fetch_metrics` | how much, how fast, what status codes | *why* |
| `fetch_logs` | what happened, with stack traces | how widespread |
| `fetch_health` | are pods alive, restarting, scheduled | anything about application behaviour |

Each returns **aggregated, structured JSON** — grouped error messages with
counts, computed rates and percentiles — not raw dumps. That is both a cost
control (a 5,000-line log dump is expensive in tokens) and an accuracy one
(three significant lines get buried in five thousand routine ones).

## Setup

```bash
cd aiops/kira
npm install
export ANTHROPIC_API_KEY=sk-ant-...

npm run check     # verifies all three data sources are reachable
```

`--check` tests each source **separately and by name**, because "Kira found
nothing wrong" and "Kira could not reach Loki" must never look the same.

## Run

```bash
# Ask about a specific incident
node src/index.js "checkout is failing for some users, investigate the last 15 minutes"

# Or the full scripted demo: creates a real incident, then diagnoses it cold
npm run demo
```

## The system prompt is a file, not a string

[`prompts/kira-system-prompt.md`](prompts/kira-system-prompt.md) is loaded
verbatim at runtime. Edit it and re-run; nothing is duplicated in code.

It gives Kira the **service topology and the call graph** — the things an
on-call engineer would have in a runbook — and the method: call all three
tools, cite real values, distinguish an origin from its blast radius, and say
"I don't know" rather than guess.

**It does not tell her what is broken.** There is no mention of the seeded bug,
of the order service being at fault, or of null shipping addresses. If she
names the root cause, she derived it from tool output. Keeping that line clean
is what makes the demo evidence rather than theatre.

## The trace — what makes this auditable

Every run prints each tool call with its **exact arguments**, timing and a
result summary, then writes the full record — including complete tool outputs —
to `traces/<timestamp>.json`.

```
──────────── turn 1 ────────────
  [reasoning]
  │ Starting broad to see which services are affected...
  ▶ TOOL fetch_metrics
    args  {"service":"all","time_range":"15m"}
    ✓ 412ms  → 7 services; errors on order, gateway, frontend (worst: order)
```

The run ends with an explicit pass/fail on whether all three signals were
actually used, and **exits non-zero if they were not** — so a confident-looking
answer built on a single signal fails the harness instead of passing quietly.

Cost and token usage (including cache reads) are printed per run. A full
three-tool diagnosis on `claude-sonnet-5` costs roughly **$0.10–0.15**.

## Design decisions

**A hand-written agentic loop, not the SDK's tool runner.** The SDK's
`beta.messages.tool_runner` would do this in less code. The loop in
[`src/agent.js`](src/agent.js) is written out deliberately: the project exists
to demonstrate the agentic pattern, every tool call must be individually
traceable, and it avoids depending on a beta API surface.

**Adaptive thinking with `display: "summarized"`.** Sonnet 5 returns empty
thinking blocks by default; enabling summaries is what puts Kira's *reasoning*
in the trace rather than only her conclusion.

**Prompt caching on the system prompt and tool definitions.** They are
byte-identical across turns and runs, so after the first call they are read
from cache instead of re-billed at full rate.

**Tool failures are reported to the model, not thrown.** A data source being
unreachable is itself diagnostic information — Kira can say "Loki did not
respond, so I cannot confirm the mechanism" instead of the process dying.

**Kira runs outside the cluster.** A diagnostic tool that lives inside the
thing it diagnoses goes down exactly when it is most needed. She reaches
Prometheus and Loki over NodePorts and the Kubernetes API over kubeconfig.

**Read-only by construction.** `fetch_health` imports no write methods from the
Kubernetes client, so Kira cannot mutate the cluster even if she tried. The
"diagnose, never remediate" boundary is enforced by the code, not only by the
prompt.

## Cost control

| Lever | Effect |
|---|---|
| Tools aggregate before returning | a log dump becomes ~20 grouped messages |
| `maxLogLines` cap (default 40) | bounds the worst case |
| Prompt caching | system prompt + tools billed once, then cached |
| `maxTurns` hard stop (default 12) | a runaway loop fails loudly instead of spending |
| `claude-sonnet-5` | ~$0.12/diagnosis vs ~$0.30 on Opus 5 |
