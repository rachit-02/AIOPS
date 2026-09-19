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

  // User-specified for this project. Sonnet 5 is a deliberate cost choice:
  // a full three-tool diagnosis lands around $0.12 rather than ~$0.30.
  model: process.env.KIRA_MODEL || 'claude-sonnet-5',

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
