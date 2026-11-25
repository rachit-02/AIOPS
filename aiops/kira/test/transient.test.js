/**
 * The healthy-system hallucination (fault disarmed ~16:12, Kira run ~16:27):
 *   fetch_metrics "no 5xx"; fetch_logs(all) "2 lines, top upstream_error"
 *   (connect ETIMEDOUT 10.96.53.99:3000); fetch_health "8/8 ready".
 * The model blamed `product` -> "database connection timeout", quoted
 * "order 106 errors since pod start" as current, and said 502s were ongoing.
 * 10.96.53.99 was the `order` Service; the 2 lines were one request during
 * the order pod's rollout.
 *
 *   2. weak-signal path: a blip that small, with no exception and no current
 *      5xx, gets a fixed "No active incident found" answer.
 *   3. the model never sees lifetime / since-pod-start counts.
 *   4. ClusterIPs in logs are resolved to Service names.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { investigate, weakSignalEvidence, WEAK_LOG_LINES } from '../src/agent.js';
import { run as fetchMetrics } from '../src/tools/fetch_metrics.js';
import { run as fetchLogs } from '../src/tools/fetch_logs.js';
import { setServiceLister, resolveClusterIps } from '../src/k8s.js';
import { stubPrometheus, restore } from './helpers/prometheus.js';

after(restore);
after(() => setServiceLister(null));

const SERVICES = [
  { namespace: 'aiops-dev', name: 'order', clusterIP: '10.96.53.99' },
  { namespace: 'aiops-dev', name: 'product', clusterIP: '10.96.10.20' },
  { namespace: 'aiops-dev', name: 'postgres', clusterIP: 'None' },
  { namespace: 'monitoring', name: 'prometheus', clusterIP: '10.96.99.1' },
];

// ---- 4: ClusterIP -> Service name ------------------------------------------

test('4: resolveClusterIps names known ClusterIPs and leaves others alone', () => {
  const map = new Map([['10.96.53.99', 'order'], ['10.96.99.1', 'monitoring/prometheus']]);
  assert.equal(resolveClusterIps('connect ETIMEDOUT 10.96.53.99:3000', map), 'connect ETIMEDOUT order (ClusterIP 10.96.53.99:3000)');
  assert.equal(resolveClusterIps('to 10.96.99.1 and 10.244.1.15:3000', map), 'to monitoring/prometheus (ClusterIP 10.96.99.1) and 10.244.1.15:3000');
  assert.equal(resolveClusterIps('no ip here', map), 'no ip here');
});

/** A stand-in Loki returning the two real lines from the rollout blip. */
function stubLoki(lines) {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/loki\/api\/v1\/query_range/);
    const result = [{
      stream: { kubernetes_container_name: 'gateway', level: 'error' },
      values: lines.map(([ts, obj]) => [String(Date.parse(ts) * 1e6), JSON.stringify(obj)]),
    }];
    return new Response(JSON.stringify({ status: 'success', data: { result } }), { status: 200 });
  };
}

const BLIP_TIME = new Date(Date.now() - 15 * 60_000).toISOString();
const BLIP_LINES = [
  [BLIP_TIME, { level: 'error', msg: 'upstream_error', upstream: 'http://order:3000', err: 'connect ETIMEDOUT 10.96.53.99:3000', request_id: 'r1' }],
  [BLIP_TIME, { level: 'error', msg: 'request', status: 502, route: '/api/orders', error: 'upstream_error: connect ETIMEDOUT 10.96.53.99:3000', request_id: 'r1' }],
];

test('4: fetch_logs resolves the ClusterIP, keeps the err string and the upstream', async () => {
  setServiceLister(async () => SERVICES);
  stubLoki(BLIP_LINES);
  const r = await fetchLogs({ service: 'all', level: 'error', time_range: '15m' });
  const up = r.messages.find((m) => m.event === 'upstream_error');
  assert.equal(up.message, 'connect ETIMEDOUT order (ClusterIP 10.96.53.99:3000)');
  assert.equal(up.example.upstream, 'http://order:3000');
  assert.deepEqual(up.services, ['gateway']);
  const req = r.messages.find((m) => m.event === 'request');
  assert.equal(req.message, 'upstream_error: connect ETIMEDOUT order (ClusterIP 10.96.53.99:3000)');
  assert.doesNotMatch(JSON.stringify(r.messages), /ETIMEDOUT 10\.96\.53\.99/, 'no bare ClusterIP left');
  assert.equal(r.exception_count, 0);
});

test('4: a failed Service lookup leaves the log text unchanged rather than failing', async () => {
  setServiceLister(async () => { throw new Error('k8s down'); });
  stubLoki(BLIP_LINES);
  const r = await fetchLogs({ service: 'all', level: 'error', time_range: '15m' });
  assert.equal(r.messages.find((m) => m.event === 'upstream_error').message, 'connect ETIMEDOUT 10.96.53.99:3000');
});

// ---- 3: no lifetime counts reach the model ---------------------------------

test('3: fetch_metrics reports only window counts - no since-pod-start fields for a normal pod', async () => {
  stubPrometheus({ raw5xx: { order: 106 } }); // a big lifetime counter left over from the old fault
  const r = await fetchMetrics({ service: 'all', time_range: '15m' });
  const order = r.services.find((s) => s.service === 'order');
  assert.ok(!/since_pod_start|since_this_pod_started/.test(JSON.stringify(r)), JSON.stringify(order));
  assert.deepEqual(r.summary.services_with_errors, []);
  assert.match(r.counts_note, /WITHIN the last 15m.*No lifetime/);
});

// ---- 2: the weak-signal path, end to end ----------------------------------

const HEALTHY = { summary: { total_pods: 8, ready_pods: 8, total_restarts: 12, recent_restarts: 0 } };
const HALLUCINATION = [
  '### Root cause', 'The `product` service has a database connection timeout.',
  '### Evidence', '- **Metrics:** order 106 errors since pod start; 502s are happening.',
  '### Blast radius', '**Affected services:** product (origin), gateway',
  '### Recommended fix', 'Increase the database pool.',
  '### Prevention', 'Monitor the database.',
].join('\n');

function scripted(responses) {
  return {
    provider: 'test', model: 'scripted', pricePerMTok: { input: 0, output: 0 }, seen: [],
    async chat(req) {
      this.seen.push(req.messages.map(({ raw: _raw, ...m }) => ({ ...m })));
      return { text: '', toolCalls: [], usage: null, raw: null, ...responses.shift() };
    },
  };
}

/** The healthy-system run, with optional twists. */
async function healthyRun({ logs = BLIP_LINES, window = [[{ job: 'gateway', status: '502' }, 1], [{ job: 'frontend', status: '502' }, 1]], rate5xx = {}, health = HEALTHY } = {}) {
  setServiceLister(async () => SERVICES);
  // order's pod started 17 min ago, i.e. 2 min before the blip at -15 min.
  const metricsStub = () => stubPrometheus({ podAge: { order: 17 * 60 }, window, rate5xx, raw5xx: { order: 106 } });
  const runTool = async (name, args) => {
    if (name === 'fetch_metrics') { metricsStub(); return fetchMetrics(args); }
    if (name === 'fetch_logs') { stubLoki(logs); return fetchLogs(args); }
    return health;
  };
  const client = scripted([
    { toolCalls: [
      { id: 'm', name: 'fetch_metrics', args: { service: 'all', time_range: '15m' } },
      { id: 'l', name: 'fetch_logs', args: { service: 'all', level: 'error', time_range: '15m' } },
      { id: 'h', name: 'fetch_health', args: { service: 'all' } },
    ] },
    { text: HALLUCINATION },
  ]);
  const { answer } = await investigate('Is checkout OK?', { verbose: false, client, runTool });
  return { answer, client };
}

test('2: the healthy-system blip -> fixed "No active incident found", lines listed as transient', async () => {
  const { answer, client } = await healthyRun();
  assert.match(answer, /^### Root cause\nNo active incident found/);
  assert.match(answer, /transient, likely during a rollout at \d\d:\d\d:\d\d UTC/);
  assert.match(answer, /of order \(new pod started \d\d:\d\d:\d\d UTC\)/);
  assert.match(answer, /gateway: `upstream_error` "connect ETIMEDOUT order \(ClusterIP 10\.96\.53\.99:3000\)" \(upstream http:\/\/order:3000\)/);
  assert.match(answer, /frontend 502 ×1, gateway 502 ×1 - proxy responses matching the transient lines/);
  const headings = [...answer.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ['Root cause', 'Evidence', 'Blast radius', 'Recommended fix', 'Prevention']);
  // None of the hallucination survives.
  assert.doesNotMatch(answer, /database|product|106/);
  // And the model never saw a lifetime count or a bare ClusterIP.
  const toolMsgs = client.seen.at(-1).filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
  assert.doesNotMatch(toolMsgs, /since_pod_start|"106"|: ?106\b/);
  assert.doesNotMatch(toolMsgs, /ETIMEDOUT 10\.96\.53\.99/);
});

test('2: an exception anywhere -> the model decides, as today', async () => {
  const withException = [...BLIP_LINES, [BLIP_TIME, { level: 'error', msg: 'unhandled_error', err: { message: 'TypeError: x', stack: 'TypeError: x\n    at f (a.js:1:1)' } }]];
  const { answer } = await healthyRun({ logs: withException });
  assert.doesNotMatch(answer, /No active incident found/);
  // the blast-radius post-check still removes the zero-error product
  assert.match(answer, /`product` service has a database/);
});

test('2: more than a few error lines -> the model decides', async () => {
  const many = Array.from({ length: WEAK_LOG_LINES + 1 }, (_, i) => [BLIP_TIME, { level: 'error', msg: 'upstream_error', err: `connect ETIMEDOUT 10.96.53.99:300${i}` }]);
  const { answer } = await healthyRun({ logs: many });
  assert.doesNotMatch(answer, /No active incident found/);
});

test('2: a CURRENT 5xx rate -> the model decides', async () => {
  const { answer } = await healthyRun({ rate5xx: { gateway: 0.02 } });
  assert.doesNotMatch(answer, /No active incident found/);
});

test('2: a non-proxy 5xx (500) in the window -> the model decides', async () => {
  const { answer } = await healthyRun({ window: [[{ job: 'order', status: '500' }, 1]] });
  assert.doesNotMatch(answer, /No active incident found/);
});

test('2: a pod not ready -> the model decides', async () => {
  const { answer } = await healthyRun({ health: { summary: { total_pods: 8, ready_pods: 7, recent_restarts: 0 } } });
  assert.doesNotMatch(answer, /No active incident found/);
});

test('2: 502s in the window with no upstream_error line to explain them -> not a blip', () => {
  const metrics = [{ services: [{ service: 'gateway', scrape_up: true, error_rate_percent: 0, server_errors_5xx_in_window: { approx_total: 1, by_status: [{ status: '502', count: 1 }] } }], summary: { services_with_errors: ['gateway'] } }];
  const logs = [{ level_filter: 'error', total_matching_lines: 1, exception_count: 0, messages: [{ event: 'request', message: 'something', count: 1, first_seen: BLIP_TIME }] }];
  assert.equal(weakSignalEvidence({ metrics, logs, health: [HEALTHY] }), null);
});
