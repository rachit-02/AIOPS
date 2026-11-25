/**
 * The live hallucination this guards against: before the fault was armed,
 * fetch_metrics said "no errors", error logs were empty and pods were healthy,
 * yet qwen2.5:7b blamed `order` and cited ~3,400 401s on gateway/frontend as
 * "propagated errors".
 *
 *   1. No-incident guard: clean signals -> a fixed answer, model text discarded.
 *   2. 4xx are reported separately from 5xx by the real fetch_metrics, so a
 *      pile of 401s is not "errors" and does not stop the guard firing.
 *
 * Scripted model + fake tools (and a stubbed Prometheus for fetch_metrics):
 * no Ollama, Prometheus, Loki or cluster needed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { investigate, noIncidentEvidence } from '../src/agent.js';
import { run as fetchMetrics } from '../src/tools/fetch_metrics.js';
import { stubPrometheus, restore } from './helpers/prometheus.js';

// ---- fetch_metrics against a stubbed Prometheus ---------------------------
// The incident's real numbers: lots of 401s on gateway and frontend, zero 5xx.
after(restore);
function stubIncident({ with5xx = false } = {}) {
  stubPrometheus({
    rate5xx: with5xx ? { order: 0.05 } : {},
    window: [
      [{ job: 'gateway', status: '401' }, 3393], [{ job: 'frontend', status: '401' }, 3373],
      ...(with5xx ? [[{ job: 'order', status: '500' }, 12]] : []),
    ],
    routes: [
      [{ job: 'gateway', route: '/api/orders', status: '401' }, 3393],
      ...(with5xx ? [[{ job: 'order', route: '/orders', status: '500' }, 12]] : []),
    ],
  });
}

test('2: fetch_metrics reports 4xx separately from 5xx; 401s are not "errors"', async () => {
  stubIncident();
  const r = await fetchMetrics({ service: 'all', time_range: '15m' });
  const gw = r.services.find((s) => s.service === 'gateway');
  assert.equal(gw.error_rate_percent, 0);
  assert.deepEqual(gw.server_errors_5xx_in_window, { approx_total: 0, by_status: [] });
  assert.equal(gw.client_errors_4xx_in_window.approx_total, 3393);
  assert.ok(!Object.keys(gw).some((k) => /since_pod_start/.test(k)), 'no lifetime fields');
  assert.deepEqual(gw.failing_routes, [], 'failing_routes is 5xx only');
  assert.deepEqual(gw.client_error_routes_4xx, [{ route: '/api/orders', status: '401', approx_count: 3393 }]);
  assert.deepEqual(r.summary.services_with_errors, []);
  assert.equal(r.summary.server_errors_5xx_in_window, false);
  assert.deepEqual(r.summary.client_errors_4xx_in_window, { frontend: 3373, gateway: 3393 });
  assert.match(r.summary.client_errors_note, /not server failures, not a root cause/);
});

test('2: a real 5xx still shows up as a server error', async () => {
  stubIncident({ with5xx: true });
  const r = await fetchMetrics({ service: 'all', time_range: '15m' });
  const order = r.services.find((s) => s.service === 'order');
  assert.ok(order.error_rate_percent > 0);
  assert.equal(order.server_errors_5xx_in_window.approx_total, 12);
  assert.deepEqual(order.failing_routes, [{ route: '/orders', status: '500', approx_count: 12 }]);
  assert.deepEqual(r.summary.services_with_errors, ['order']);
});

// ---- the guard, end to end with a scripted model ----------------------------

const LOGS_EMPTY = { service: 'order', level_filter: 'error', total_matching_lines: 0, distinct_messages: 0, messages: [] };
const LOGS_ERR = { service: 'order', level_filter: 'error', total_matching_lines: 4, exception_count: 2, distinct_messages: 1, messages: [{ event: 'unhandled_error', has_stack_trace: true, count: 2, message: 'TypeError' }] };
const HEALTHY = { summary: { total_pods: 8, ready_pods: 8, total_restarts: 68, recent_restarts: 0 } };

// What qwen2.5:7b actually produced: a confident root cause from 401 counts.
const HALLUCINATION = [
  '### Root cause',
  'The `order` service is failing JWT validation, propagating 401 errors.',
  '### Evidence',
  '- **Metrics:** gateway 3393 401s, frontend 3373 401s (propagated errors).',
  '### Blast radius',
  '**Affected services:** order (origin), gateway, frontend',
  '### Recommended fix',
  'Fix the JWT secret in order.',
  '### Prevention',
  'Add JWT tests.',
].join('\n');

function scripted(responses) {
  return {
    provider: 'test', model: 'scripted', pricePerMTok: { input: 0, output: 0 },
    async chat() {
      const next = responses.shift();
      return { text: '', toolCalls: [], usage: null, raw: null, ...next };
    },
  };
}
const allThree = [
  { id: 'm', name: 'fetch_metrics', args: { service: 'all', time_range: '15m' } },
  { id: 'l', name: 'fetch_logs', args: { service: 'order', level: 'error' } },
  { id: 'h', name: 'fetch_health', args: { service: 'order' } },
];

async function runWith({ with5xx = false, logs = LOGS_EMPTY, health = HEALTHY } = {}) {
  stubIncident({ with5xx });
  const runTool = async (name, args) =>
    name === 'fetch_metrics' ? fetchMetrics(args) : name === 'fetch_logs' ? logs : health;
  const client = scripted([{ toolCalls: allThree }, { text: HALLUCINATION }]);
  return (await investigate('Is anything wrong with checkout?', { verbose: false, client, runTool })).answer;
}

test('1: clean signals (only 4xx) -> fixed "No active incident found" answer, model text discarded', async () => {
  const answer = await runWith();
  assert.match(answer, /No active incident found/);
  assert.match(answer, /ArgoCD needs ~2–3 minutes to roll out; try again shortly/);
  // Same five headings, in order.
  const headings = [...answer.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ['Root cause', 'Evidence', 'Blast radius', 'Recommended fix', 'Prevention']);
  // Evidence summary built from the tool results.
  assert.match(answer, /no 5xx server errors on any service/);
  assert.match(answer, /gateway 3393/);
  assert.match(answer, /no error-level lines for order/);
  assert.match(answer, /8\/8 pods ready/);
  // The hallucination is gone.
  assert.doesNotMatch(answer, /JWT|propagat/i);
});

test('1: guard does NOT fire when there is a 5xx', async () => {
  const answer = await runWith({ with5xx: true });
  assert.doesNotMatch(answer, /No active incident found/);
  assert.match(answer, /The `order` service is failing/);
});

test('1: guard does NOT fire when error logs are present', async () => {
  assert.doesNotMatch(await runWith({ logs: LOGS_ERR }), /No active incident found/);
});

test('1: guard does NOT fire when a pod is unready or restarted recently', async () => {
  const unready = { summary: { total_pods: 8, ready_pods: 7, total_restarts: 0, recent_restarts: 0 } };
  const restarted = { summary: { total_pods: 8, ready_pods: 8, total_restarts: 9, recent_restarts: 1 } };
  assert.doesNotMatch(await runWith({ health: unready }), /No active incident found/);
  assert.doesNotMatch(await runWith({ health: restarted }), /No active incident found/);
});

test('1: guard needs positive evidence from every signal', () => {
  const metrics = [{ services: [{ service: 'gateway', scrape_up: true, error_rate_percent: 0 }], summary: { services_with_errors: [] } }];
  assert.equal(noIncidentEvidence({ metrics, logs: [LOGS_EMPTY], health: [HEALTHY] }), true);
  // logs only fetched at level "all" -> no error-level evidence -> no guard
  assert.equal(noIncidentEvidence({ metrics, logs: [{ ...LOGS_EMPTY, level_filter: 'all' }], health: [HEALTHY] }), false);
  // nothing scraped -> "no errors" means "no data", not "healthy"
  const blind = [{ services: [{ service: 'gateway', scrape_up: false, error_rate_percent: 0 }], summary: { services_with_errors: [] } }];
  assert.equal(noIncidentEvidence({ metrics: blind, logs: [LOGS_EMPTY], health: [HEALTHY] }), false);
  assert.equal(noIncidentEvidence({ metrics: [], logs: [LOGS_EMPTY], health: [HEALTHY] }), false);
});
