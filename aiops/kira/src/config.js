/**
 * Kira's configuration. Everything is overridable by environment variable so
 * the same code runs against the kind cluster or, later, anywhere else.
 *
 * The defaults point at the NodePorts defined in
 * infra/terraform/kind-config.yaml. If those change, these must change too.
 */
export const config = {
  // Prometheus NodePort 30090 -> host 9091
  prometheusUrl: process.env.PROMETHEUS_URL || 'http://localhost:9091',
  // Loki NodePort 30100 -> host 3100
  lokiUrl: process.env.LOKI_URL || 'http://localhost:3100',

  namespace: process.env.AIOPS_NAMESPACE || 'aiops-dev',
  kubeContext: process.env.KUBE_CONTEXT || 'kind-aiops-local',

  // ---- Model provider -------------------------------------------------------
  // "ollama" (default) runs locally and costs nothing. "anthropic" is more
  // reliable at the three-way correlation this agent depends on, and is the
  // recommendation for anyone who has API access. See src/model/index.js.
  provider: process.env.KIRA_PROVIDER || 'ollama',

  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',

  // Ollama's DEFAULT context window is much smaller than qwen2.5 supports, and
  // silently truncates rather than erroring. The system prompt plus three tool
  // results comfortably exceeds the default, and what gets dropped is the tail
  // - which is where the evidence is. Set explicitly.
  ollamaNumCtx: Number(process.env.OLLAMA_NUM_CTX) || 16384,

  // A 7B model on CPU is slow and a cold start reloads ~5GB from disk; the
  // first call can take a minute before any tokens appear.
  ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS) || 300000,

  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',

  // ---- Reliability ------------------------------------------------------------
  // Smaller models sometimes answer from the system prompt alone instead of
  // calling tools. When that happens Kira is told what she has not yet checked
  // and asked again, up to this many times, before the run is failed. A
  // confident answer built on partial evidence is worse than no answer, so the
  // failure is loud rather than silent.
  maxToolNudges: Number(process.env.KIRA_MAX_TOOL_NUDGES) || 2,

  // Generous ceiling, not a target - billing is on tokens actually produced.
  // Too low truncates a diagnosis mid-sentence and wastes the whole run.
  maxTokens: Number(process.env.KIRA_MAX_TOKENS) || 16000,

  // Hard stop on the agentic loop. Three tools should need ~2-4 turns; more
  // than this means something is wrong and we should fail loudly rather than
  // silently spend money in a loop.
  maxTurns: Number(process.env.KIRA_MAX_TURNS) || 12,

  // COST AND ACCURACY GUARDRAIL. An unbounded log fetch is both expensive
  // (tokens) and worse for diagnosis - a wall of 5,000 lines buries the three
  // that matter. Tools aggregate and cap instead.
  maxLogLines: Number(process.env.KIRA_MAX_LOG_LINES) || 40,

  // The services Kira knows about, used to validate tool arguments so a
  // hallucinated service name fails fast with a clear message instead of
  // silently returning an empty result that looks like "nothing is wrong".
  services: ['frontend', 'gateway', 'auth', 'product', 'order', 'orders', 'user'],
};

/** Parse "15m" / "2h" / "90s" into seconds. Throws on anything else. */
export function parseTimeRange(range) {
  const m = /^(\d+)([smh])$/.exec(String(range).trim());
  if (!m) throw new Error(`invalid time_range "${range}" (expected e.g. "15m", "1h", "90s")`);
  const n = Number(m[1]);
  const seconds = n * { s: 1, m: 60, h: 3600 }[m[2]];
  if (seconds <= 0 || seconds > 24 * 3600) throw new Error(`time_range must be between 1s and 24h`);
  return seconds;
}

/** Fetch with a timeout so a hung data source fails fast instead of stalling the agent. */
export async function fetchJson(url, { timeoutMs = 15000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${new URL(url).host}: ${text.slice(0, 200)}`);
  }
}
