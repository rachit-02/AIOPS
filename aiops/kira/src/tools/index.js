/**
 * The tool registry.
 *
 * THREE TOOLS, EACH DOING EXACTLY ONE JOB, reading exactly one system:
 *   fetch_metrics -> Prometheus
 *   fetch_logs    -> Loki
 *   fetch_health  -> Kubernetes API
 *
 * The narrowness is the design, not an accident. A single `investigate()` tool
 * that returned all three would be easier to write and would make the agent's
 * "correlation across independent signals" meaningless - the correlating would
 * be happening in our code, not in the model's reasoning, and the demo would
 * prove nothing. Keeping them separate also means each call is individually
 * visible in the trace, with its own arguments.
 */
import * as metrics from './fetch_metrics.js';
import * as logs from './fetch_logs.js';
import * as health from './fetch_health.js';

const MODULES = [metrics, logs, health];

export const toolDefinitions = MODULES.map((m) => ({
  ...m.definition,
  // Guarantees the model's arguments validate against the schema, so a
  // malformed call fails at the API rather than inside our tool with a
  // confusing TypeError.
  strict: true,
}));

const REGISTRY = Object.fromEntries(MODULES.map((m) => [m.definition.name, m.run]));

/** One-line summary for the console trace; the full result goes to the JSON trace. */
export function summarise(name, r) {
  try {
    if (name === 'fetch_metrics') {
      const errs = r.summary.services_with_errors;
      return errs.length
        ? `${r.services.length} services; errors on ${errs.join(', ')} (worst: ${r.summary.highest_error_rate})`
        : `${r.services.length} services, no errors`;
    }
    if (name === 'fetch_logs') {
      return r.total_matching_lines === 0
        ? `no ${r.level_filter} lines for ${r.service}`
        : `${r.total_matching_lines} lines, ${r.distinct_messages} distinct; top: "${r.messages[0]?.message.slice(0, 70)}"`;
    }
    if (name === 'fetch_health') {
      const s = r.summary;
      return `${s.ready_pods}/${s.total_pods} pods ready, ${s.total_restarts} restarts`;
    }
  } catch {
    /* fall through */
  }
  return 'ok';
}

export async function runTool(name, args) {
  const fn = REGISTRY[name];
  if (!fn) throw new Error(`unknown tool "${name}"`);
  return fn(args ?? {});
}
