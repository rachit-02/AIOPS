# Kira — the diagnostic agent

Kira investigates incidents by correlating **three independent observability
signals** and explains what went wrong. She **never remediates** — she produces
a root cause, the evidence behind it, a recommended fix and a prevention
suggestion. A human decides and acts.

## How she works

```
              ┌──────────────────────────────┐
  incident ──▶│  qwen2.5:7b via Ollama       │  (local, free)
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

## Which model?

Kira runs on a **local Ollama model by default — no API key, no billing**.
The provider is a one-line swap ([`src/model/`](src/model/)); nothing else in
the agent, the tools or the system prompt changes.

| | `ollama` (default) | `anthropic` |
|---|---|---|
| Model | `qwen2.5:7b` | `claude-sonnet-5` |
| Cost | free | ~$0.12 / diagnosis |
| Speed | ~40–50s (CPU) | ~20–30s |
| Tool calling | works, needs guardrails | reliable |
| Correlation accuracy | correct root cause; minor factual slips | consistently precise |

**If you have API access, use Sonnet 5.** This agent's whole value is
cross-referencing three signals and separating an origin from its blast
radius, and that is precisely where the gap shows. Measured on the seeded
incident, qwen2.5:7b identified the root cause correctly but listed a service
as affected that had zero errors — a fabricated claim inside an otherwise
sound diagnosis. It is good enough to demonstrate the architecture; it is not
good enough to trust unreviewed.

```bash
KIRA_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm start
```

## Setup

```bash
# Ollama (default) - no key needed
ollama pull qwen2.5:7b
cd aiops/kira && npm install
npm run check
```

`--check` tests the model **and** each data source **separately and by name**,
because "Kira found nothing wrong", "Loki is unreachable" and "Ollama is not
running" must never look the same.

> **Memory.** qwen2.5:7b needs ~5GB, and the kind cluster wants ~5.5GB. On a
> 16GB machine that is tight but works; a cold start takes ~50s while the model
> loads from disk.

## Run

```bash
# Verify tool calling works with your model BEFORE a real investigation
npm run check:tools

# Ask about a specific incident
node src/index.js "checkout is failing for some users, investigate the last 15 minutes"

# Or the full scripted demo: creates a real incident, then diagnoses it cold
npm run demo
```

### Why `check:tools` exists

A 7B model is far less dependable at tool use than a frontier model, and the
failure is quiet — it answers plausibly from the system prompt instead of
calling anything. [`test/tool-calling-check.js`](test/tool-calling-check.js)
isolates the mechanism with stub tools and no cluster dependency, and answers
five questions: does it emit a call, with correct arguments, does it chain
after reading a result, and **does the loop's enforcement actually refuse an
unevidenced answer**.

That last pair is tested with a stub client that always answers without
calling tools. An earlier version induced it by telling the real model "do not
use tools" — which stopped working the moment the prompt was cleaned up and
the model started behaving. Whether the loop refuses a toolless answer is
*our* logic and must be deterministic, not contingent on a model misbehaving
on cue.

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

**A hand-written agentic loop, not an SDK tool runner.** The loop in
[`src/agent.js`](src/agent.js) is provider-agnostic, which is what lets the
same code drive Ollama and Anthropic despite entirely different wire formats.
It also keeps every tool call individually traceable.

**Tool use is detected by the presence of tool calls, never by a stop reason.**
Ollama reports `done_reason: "stop"` *even while calling tools* — there is no
equivalent of Anthropic's `stop_reason: "tool_use"`. Branching on the stop
reason silently ends the investigation after the first tool call.

**The loop refuses an answer built on partial evidence.** A 7B model will
sometimes answer straight from the system prompt, which contains the service
topology and therefore enough material for a confident, plausible, entirely
unevidenced diagnosis — the worst failure mode for a diagnostic tool, because
it looks exactly like success. When the model tries to conclude early it is
told *by name* which tools it has not called and asked again (twice by
default); if it still will not comply the answer is stamped
`[INCOMPLETE INVESTIGATION]` and the process exits non-zero. Nudges appear in
the trace, because a run that needed them is a weaker result than one that did
not.

**`num_ctx` is set explicitly.** Ollama's default context is far smaller than
qwen2.5 supports and it truncates *silently* — and what gets dropped is the
tail, which is where the tool results are.

**Arguments are validated before execution.** Anthropic can enforce schemas
server-side with `strict: true`; Ollama has no equivalent, so it happens in the
loop. A bad argument comes back to the model as a correctable error rather than
a TypeError deep inside a tool.

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
| **Local Ollama by default** | **$0 — no API billing at all** |
| Tools aggregate before returning | a log dump becomes ~20 grouped messages |
| `maxLogLines` cap (default 40) | bounds the worst case |
| `maxTurns` hard stop (default 12) | a runaway loop fails loudly instead of spending |
| Prompt caching (Anthropic path) | system prompt + tools billed once, then cached |

A measured run on `qwen2.5:7b`: 3 tool calls, 2 turns, 41.8s, 8,222 in /
498 out tokens, **free**. The same run on `claude-sonnet-5` costs ~$0.12.
