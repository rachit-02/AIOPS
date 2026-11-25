/**
 * Regressions from a live run with the seeded Order fault ARMED:
 *
 *   - Arming the fault restarts the order pod. Right after, "since pod start"
 *     counters are reset and rate() has too few scrapes, so fetch_metrics can
 *     show 0 5xx while order is already throwing (item 2).
 *   - fetch_logs(all) ran before the new pod existed and found nothing; a
 *     later fetch_logs(order) found 12 errors. The no-incident guard must
 *     never fire when ANY log call found error lines (item 4).
 *   - The model then queried every service one by one and hit the turn limit
 *     with no answer. It must now get one final no-tool call (item 3).
 *
 * Scripted model, fake tools, stubbed Prometheus: no live dependencies.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { investigate, metricsLagNote, noIncidentEvidence, PARTIAL_MARK } from '../src/agent.js';
import { run as fetchMetrics } from '../src/tools/fetch_metrics.js';
import { config } from '../src/config.js';

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

/**
 * Prometheus as seen just after the fault was armed: the order pod is
 * `orderAge` seconds old. `window5xx` = what increase() over the window finds.
 */
function stubPrometheus({ orderAge = 20, rate5xx = 0, window5xx = 0, sincePodStart5xx = 0 } = {}) {
  const vec = (rows) => ({ status: 'success', data: { resultType: 'vector', result: rows.map(([metric, v]) => ({ metric, value: [0, String(v)] })) } });
  const jobs = ['gateway', 'frontend', 'order', 'orders'];
  globalThis.fetch = async (url) => {
    const expr = new URL(url).searchParams.get('query');
    let body;
    if (expr.startsWith('up{')) body = vec(jobs.map((job) => [{ job }, 1]));
    else if (expr.startsWith('time() - max by (job) (process_start_time_seconds')) {
      body = vec(jobs.map((job) => [{ job }, job === 'order' ? orderAge : 3600]));
    } else if (expr.includes('increase(http_requests_total')) {
      body = vec(window5xx ? [[{ job: 'order', status: '500' }, window5xx]] : []);
    } else if (expr.includes('histogram_quantile')) body = vec([]);
    else if (expr.startsWith('sum by (job,route,status)')) {
      body = vec(sincePodStart5xx ? [[{ job: 'order', route: '/orders', status: '500' }, sincePodStart5xx]] : []);
    } else if (expr.startsWith('sum by (job,status)')) {
      body = vec([
        [{ job: 'gateway', status: '200' }, 500], [{ job: 'order', status: '201' }, 3],
        ...(sincePodStart5xx ? [[{ job: 'order', status: '500' }, sincePodStart5xx]] : []),
      ]);
    } else if (expr.includes('status=~"5.."')) body = vec(rate5xx ? [[{ job: 'order' }, rate5xx]] : []);
    else body = vec(jobs.map((job) => [{ job }, 1.2]));
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

// ---- item 2: metrics across a pod restart --------------------------------

test('2: 5xx counted over the window survive a pod restart (rate and since-pod-start both 0)', async () => {
  stubPrometheus({ orderAge: 600, rate5xx: 0, sincePodStart5xx: 0, window5xx: 9 });
  const r = await fetchMetrics({ service: 'all', time_range: '15m' });
  const order = r.services.find((s) => s.service === 'order');
  assert.equal(order.error_rate_percent, 0);
  assert.equal(order.server_errors_5xx_since_pod_start.total, 0);
  assert.deepEqual(order.server_errors_5xx_in_window, { approx_total: 9, by_status: [{ status: '500', count: 9 }] });
  assert.deepEqual(r.summary.services_with_errors, ['order']);
});

test('2: a freshly started pod is flagged and the summary warns that metrics may lag', async () => {
  stubPrometheus({ orderAge: 20 });
  const r = await fetchMetrics({ service: 'all', time_range: '15m' });
  const order = r.services.find((s) => s.service === 'order');
  assert.equal(order.pod_started_recently, true);
  assert.equal(order.youngest_pod_age_seconds, 20);
  assert.deepEqual(r.summary.recently_started_pods, [{ service: 'order', age_seconds: 20 }]);
  assert.match(r.summary.metrics_lag_note, /order \(20s\) started recently.*may LAG.*trust the logs/);
  assert.equal(r.services.find((s) => s.service === 'gateway').pod_started_recently, false);
});

test('2: a fresh pod with 5xx since start counts as erroring even before rate() catches up', async () => {
  stubPrometheus({ orderAge: 30, rate5xx: 0, window5xx: 0, sincePodStart5xx: 3 });
  const r = await fetchMetrics({ service: 'all', time_range: '15m' });
  assert.deepEqual(r.summary.services_with_errors, ['order']);
});

test('2: logs with errors + metrics with 0 5xx -> cross-check note, not "no errors"', () => {
  const metrics = [{ services: [{ service: 'order', error_rate_percent: 0 }, { service: 'gateway', error_rate_percent: 0 }] }];
  const logs = [{ service: 'order', level_filter: 'error', total_matching_lines: 12, exception_count: 6 }];
  assert.match(metricsLagNote(metrics, logs), /CROSS-CHECK: fetch_logs shows error lines for order, but fetch_metrics reported 0 5xx.*NOT "no errors"/);
  assert.equal(metricsLagNote(metrics, []), null);
});

// ---- items 2 + 4 end to end: the exact live sequence -----------------------

const LOGS_ALL_EMPTY = { service: 'all', level_filter: 'error', total_matching_lines: 0, exception_count: 0, by_service: [], messages: [] };
const LOGS_ORDER = {
  service: 'order', level_filter: 'error', total_matching_lines: 12, exception_count: 6, distinct_messages: 2,
  messages: [{ event: 'unhandled_error', has_stack_trace: true, count: 6, message: "Cannot read properties of undefined (reading 'line1')" }],
};
const HEALTHY = { summary: { total_pods: 1, ready_pods: 1, total_restarts: 0, recent_restarts: 0 } };

function scripted(responses) {
  const calls = [];
  return {
    provider: 'test', model: 'scripted', pricePerMTok: { input: 0, output: 0 }, calls,
    async chat(req) {
      calls.push({ tools: req.tools, messages: req.messages.map(({ raw: _raw, ...m }) => ({ ...m })) });
      const next = typeof responses === 'function' ? responses(calls.length) : responses.shift();
      return { text: '', toolCalls: [], usage: null, raw: null, ...next };
    },
  };
}

const DIAGNOSIS = [
  '### Root cause', '`order` throws reading line1 of a missing shipping address.',
  '### Evidence', '- **Logs:** 6 exceptions.',
  '### Blast radius', '**Affected services:** order (origin)',
  '### Recommended fix', 'Validate shippingAddress and return 400.',
  '### Prevention', 'Add a test for a missing address.',
].join('\n');

test('4: guard never fires when a later per-service log call found errors (live sequence)', async () => {
  stubPrometheus({ orderAge: 20 }); // metrics: 0 5xx, fresh order pod
  const runTool = async (name, args) =>
    name === 'fetch_metrics' ? fetchMetrics(args)
      : name === 'fetch_logs' ? (args.service === 'all' ? LOGS_ALL_EMPTY : LOGS_ORDER)
        : HEALTHY;
  const client = scripted([
    { toolCalls: [{ id: 'm', name: 'fetch_metrics', args: { service: 'all', time_range: '15m' } }] },
    { toolCalls: [{ id: 'la', name: 'fetch_logs', args: { service: 'all', level: 'error', time_range: '15m' } }] },
    { toolCalls: [{ id: 'lo', name: 'fetch_logs', args: { service: 'order', level: 'error', time_range: '15m' } }] },
    { toolCalls: [{ id: 'h', name: 'fetch_health', args: { service: 'order' } }] },
    { text: DIAGNOSIS },
  ]);
  const { answer } = await investigate('checkout failing', { verbose: false, client, runTool });

  assert.doesNotMatch(answer, /No active incident found/);
  assert.match(answer, /`order` throws reading line1/);
  // order stays in the blast radius: its error LOGS are evidence even though metrics showed 0.
  assert.match(answer, /\*\*Affected services:\*\* order \(origin\)/);
  assert.doesNotMatch(answer, /Evidence check: removed/);
  // The model was told about the disagreement when the order logs arrived.
  const orderLogMsg = client.calls.at(-1).messages.find((m) => m.toolCallId === 'lo');
  assert.match(orderLogMsg.content, /CROSS-CHECK: fetch_logs shows error lines for order/);
});

test('4: noIncidentEvidence is false whenever any log result has error lines or exceptions', () => {
  const metrics = [{ services: [{ service: 'order', scrape_up: true, error_rate_percent: 0 }], summary: { services_with_errors: [] } }];
  assert.equal(noIncidentEvidence({ metrics, logs: [LOGS_ALL_EMPTY], health: [HEALTHY] }), true);
  assert.equal(noIncidentEvidence({ metrics, logs: [LOGS_ALL_EMPTY, LOGS_ORDER], health: [HEALTHY] }), false);
  // exceptions found at level "all" also veto
  const allLevel = { service: 'order', level_filter: 'all', total_matching_lines: 40, exception_count: 2 };
  assert.equal(noIncidentEvidence({ metrics, logs: [LOGS_ALL_EMPTY, allLevel], health: [HEALTHY] }), false);
});

// ---- item 3: turn limit -----------------------------------------------------

const SERVICES = ['frontend', 'auth', 'product', 'orders', 'user', 'gateway', 'order'];
/** A model that never stops calling tools - a different service each turn. */
const toolHappy = (finalReply) => (n) =>
  n <= config.maxTurns
    ? { toolCalls: [n === 1
      ? { id: 'm', name: 'fetch_metrics', args: { service: 'all' } }
      : n === 2 ? { id: 'h', name: 'fetch_health', args: { service: 'all' } }
        : { id: `l${n}`, name: 'fetch_logs', args: { service: SERVICES[n % SERVICES.length], time_range: `${n}m` } }] }
    : finalReply;

const fakeTools = async (name, args) =>
  name === 'fetch_metrics' ? { services: [{ service: 'order', scrape_up: true, error_rate_percent: 0 }], summary: { services_with_errors: [] } }
    : name === 'fetch_logs' ? (args.service === 'order' ? LOGS_ORDER : { ...LOGS_ALL_EMPTY, service: args.service, by_service: undefined })
      : HEALTHY;

test('3: hitting the turn limit makes one final no-tool call and returns a marked partial diagnosis', async () => {
  const client = scripted(toolHappy({ text: DIAGNOSIS }));
  const { answer } = await investigate('checkout failing', { verbose: false, client, runTool: fakeTools });

  assert.equal(client.calls.length, config.maxTurns + 1, 'exactly one extra call');
  const final = client.calls.at(-1);
  assert.deepEqual(final.tools, [], 'the final call offers no tools');
  assert.match(final.messages.at(-1).text, /TURN LIMIT REACHED .*Do not call any more tools/);
  assert.ok(answer.startsWith(PARTIAL_MARK), answer.slice(0, 80));
  assert.match(answer, /written from the evidence gathered so far/);
  assert.match(answer, /### Root cause\n`order` throws reading line1/);
  assert.doesNotMatch(answer, /\[stopped:/);
});

test('3: if the final call returns nothing, a five-heading digest of the evidence is returned', async () => {
  const client = scripted(toolHappy({ text: '' }));
  const { answer } = await investigate('checkout failing', { verbose: false, client, runTool: fakeTools });
  assert.ok(answer.startsWith(PARTIAL_MARK));
  const headings = [...answer.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ['Root cause', 'Evidence', 'Blast radius', 'Recommended fix', 'Prevention']);
  assert.match(answer, /error lines for order; most significant: "Cannot read properties of undefined \(reading 'line1'\)" \(with stack trace\)/);
  assert.match(answer, /\*\*Affected services:\*\* order/);
});
