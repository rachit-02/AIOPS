#!/usr/bin/env node
/**
 * Kira CLI.
 *
 *   node src/index.js "the order service is throwing errors, investigate"
 *   node src/index.js --check          # verify all three data sources are reachable
 *
 * Kira runs as a plain host process, outside the cluster she is diagnosing.
 * That separation is deliberate: a diagnostic tool that lives inside the thing
 * it diagnoses goes down exactly when it is most needed.
 */
import { investigate } from './agent.js';
import { config } from './config.js';
import { runTool } from './tools/index.js';

const DEFAULT_INCIDENT =
  'Users report that some checkout attempts are failing. Investigate the aiops-dev ' +
  'namespace over the last 15 minutes and tell me the root cause.';

/**
 * Preflight. Each data source is checked SEPARATELY, because "Kira found
 * nothing wrong" and "Kira could not reach Loki" must never look the same.
 */
async function check() {
  console.log('\nChecking Kira\'s three data sources:\n');
  const checks = [
    ['fetch_metrics  → Prometheus  ' + config.prometheusUrl, () => runTool('fetch_metrics', { service: 'all', time_range: '5m' })],
    ['fetch_logs     → Loki        ' + config.lokiUrl, () => runTool('fetch_logs', { service: 'order', time_range: '5m', level: 'all' })],
    ['fetch_health   → Kubernetes  ' + config.kubeContext, () => runTool('fetch_health', { service: 'all' })],
  ];
  let ok = true;
  for (const [label, fn] of checks) {
    try {
      await fn();
      console.log(`  PASS  ${label}`);
    } catch (err) {
      console.log(`  FAIL  ${label}\n        ${err.message}`);
      ok = false;
    }
  }
  console.log(
    ok
      ? '\nAll three sources reachable.\n'
      : '\nAt least one source is unreachable. Is the cluster up (scripts/cluster-up.sh)?\n',
  );
  return ok;
}

const args = process.argv.slice(2);
if (args[0] === '--check') {
  process.exit((await check()) ? 0 : 1);
}

const incident = args.filter((a) => !a.startsWith('--')).join(' ') || DEFAULT_INCIDENT;
try {
  const { trace } = await investigate(incident);
  // Non-zero exit when the correlation did not actually happen, so the demo
  // harness fails loudly rather than printing a confident-looking answer that
  // was built on one signal.
  process.exit(trace.allThreeUsed ? 0 : 2);
} catch (err) {
  console.error(`\nKira failed: ${err.message}\n`);
  process.exit(1);
}
