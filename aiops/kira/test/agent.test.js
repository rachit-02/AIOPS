/**
 * Agent-loop behaviour that is OUR logic, tested with a scripted model and
 * fake tools - no Ollama, Prometheus, Loki or cluster needed.
 *
 *   1. An identical tool call repeated in a later turn is answered from the
 *      investigation's cache, marked "ALREADY FETCHED", and not re-run.
 *   2. A service with zero errors in fetch_metrics is removed from the
 *      blast radius of the final answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { investigate, enforceBlastRadius, callKey } from '../src/agent.js';

// fetch_metrics shaped like the real tool: `order` erroring, `orders` clean.
const METRICS = {
  source: 'prometheus',
  services: [
    { service: 'frontend', error_rate_percent: 12.5, server_errors_5xx_in_window: { approx_total: 9, by_status: [{ status: '500', count: 9 }] } },
    { service: 'gateway', error_rate_percent: 12.5, server_errors_5xx_in_window: { approx_total: 9, by_status: [{ status: '500', count: 9 }] } },
    { service: 'order', error_rate_percent: 40, server_errors_5xx_in_window: { approx_total: 9, by_status: [{ status: '500', count: 9 }] } },
    { service: 'orders', error_rate_percent: 0, server_errors_5xx_in_window: { approx_total: 0, by_status: [] } },
    { service: 'product', error_rate_percent: 0, server_errors_5xx_in_window: { approx_total: 0, by_status: [] } },
  ],
  summary: { services_with_errors: ['frontend', 'gateway', 'order'], highest_error_rate: 'order' },
};
const LOGS = { service: 'order', level_filter: 'error', total_matching_lines: 2, distinct_messages: 1, messages: [{ message: 'TypeError' }] };
const HEALTH = { summary: { ready_pods: 8, total_pods: 8, total_restarts: 0, recent_restarts: 0 } };

const ANSWER = [
  '### Root cause',
  'The `order` service throws on a request field.',
  '',
  '### Evidence',
  '- **Metrics:** order 40% errors.',
  '',
  '### Blast radius',
  '**Affected services:** order (origin), gateway, frontend (collateral), orders',
  '- `orders` read path may also be impacted by the failing writes.',
  '- `product` shows no errors and is unaffected.',
  'Users cannot place orders.',
  '',
  '### Recommended fix',
  'Validate the field and return 400.',
].join('\n');

/** A model client that plays back a fixed script of responses. */
function scriptedClient(responses) {
  const seen = [];
  return {
    provider: 'test',
    model: 'scripted',
    pricePerMTok: { input: 0, output: 0 },
    seen,
    async chat({ messages }) {
      seen.push(structuredClone(messages.map(({ raw: _raw, ...m }) => m)));
      const next = responses.shift();
      if (!next) throw new Error('script exhausted');
      return { text: '', toolCalls: [], usage: null, raw: null, ...next };
    },
  };
}

const call = (id, name, args) => ({ id, name, args });

function fakeTools() {
  const runs = [];
  const runTool = async (name, args) => {
    runs.push(callKey(name, args));
    if (name === 'fetch_metrics') return METRICS;
    if (name === 'fetch_logs') return LOGS;
    if (name === 'fetch_health') return HEALTH;
    throw new Error(`unexpected tool ${name}`);
  };
  return { runs, runTool };
}

test('1: an identical call in a later turn returns the cached result marked ALREADY FETCHED', async () => {
  const metricsArgs = { service: 'all', time_range: '15m' };
  const client = scriptedClient([
    { toolCalls: [call('a', 'fetch_metrics', metricsArgs)] },
    // same call again, arguments in a different order - must still be a repeat
    { toolCalls: [call('b', 'fetch_metrics', { time_range: '15m', service: 'all' })] },
    { toolCalls: [call('c', 'fetch_metrics', metricsArgs)] },
    { toolCalls: [call('d', 'fetch_logs', { service: 'order' }), call('e', 'fetch_health', { service: 'all' })] },
    { text: ANSWER },
  ]);
  const { runs, runTool } = fakeTools();
  const events = [];
  const { answer } = await investigate('test incident', {
    verbose: false, client, runTool, onEvent: (e) => events.push(e),
  });

  // Executed once, not three times.
  assert.equal(runs.filter((k) => k.startsWith('fetch_metrics|')).length, 1);

  // The model saw the note on both repeats, with the original data intact.
  const lastMessages = client.seen.at(-1);
  const repeats = lastMessages.filter((m) => m.role === 'tool' && (m.toolCallId === 'b' || m.toolCallId === 'c'));
  assert.equal(repeats.length, 2);
  for (const r of repeats) {
    assert.match(r.content, /^ALREADY FETCHED: .* in turn 1 /);
    assert.match(r.content, /"highest_error_rate":"order"/);
  }
  // The first call carried no note.
  const first = lastMessages.find((m) => m.toolCallId === 'a');
  assert.doesNotMatch(first.content, /ALREADY FETCHED/);

  // The trace marks the repeats as cached.
  const cachedEnds = events.filter((e) => e.type === 'tool_end' && e.cached);
  assert.equal(cachedEnds.length, 2);
  assert.ok(answer.includes('### Root cause'));
});

test('1: identical calls in the SAME turn share one execution without a note', async () => {
  const args = { service: 'all', time_range: '15m' };
  const client = scriptedClient([
    { toolCalls: [call('a', 'fetch_metrics', args), call('b', 'fetch_metrics', args)] },
    { toolCalls: [call('c', 'fetch_logs', { service: 'order' }), call('d', 'fetch_health', { service: 'all' })] },
    { text: ANSWER },
  ]);
  const { runs, runTool } = fakeTools();
  await investigate('x', { verbose: false, client, runTool });
  assert.equal(runs.filter((k) => k.startsWith('fetch_metrics|')).length, 1);
  const msgs = client.seen.at(-1).filter((m) => m.toolCallId === 'a' || m.toolCallId === 'b');
  assert.equal(msgs.length, 2);
  msgs.forEach((m) => assert.doesNotMatch(m.content, /ALREADY FETCHED/));
});

test('1: a failed call is not cached, so a repeat really retries', async () => {
  const args = { service: 'order' };
  let attempts = 0;
  const runTool = async (name) => {
    if (name === 'fetch_logs' && ++attempts === 1) throw new Error('loki unreachable');
    return name === 'fetch_metrics' ? METRICS : name === 'fetch_logs' ? LOGS : HEALTH;
  };
  const client = scriptedClient([
    { toolCalls: [call('a', 'fetch_logs', args)] },
    { toolCalls: [call('b', 'fetch_logs', args), call('c', 'fetch_metrics', { service: 'all' }), call('d', 'fetch_health', { service: 'all' })] },
    { text: ANSWER },
  ]);
  await investigate('x', { verbose: false, client, runTool });
  assert.equal(attempts, 2);
  const retry = client.seen.at(-1).find((m) => m.toolCallId === 'b');
  assert.doesNotMatch(retry.content, /ALREADY FETCHED/);
});

test('2: a zero-error service is dropped from the blast radius of the final answer', async () => {
  const client = scriptedClient([
    { toolCalls: [call('a', 'fetch_metrics', { service: 'all' }), call('b', 'fetch_logs', { service: 'order' }), call('c', 'fetch_health', { service: 'all' })] },
    { text: ANSWER },
  ]);
  const { runTool } = fakeTools();
  const { answer } = await investigate('x', { verbose: false, client, runTool });

  const blast = answer.split('### Blast radius')[1].split('### Recommended fix')[0];
  assert.match(blast, /\*\*Affected services:\*\* order \(origin\), gateway, frontend \(collateral\)\s*\n/);
  assert.doesNotMatch(blast, /`orders` read path may also be impacted/);
  // A line correctly saying a zero-error service is UNaffected is kept.
  assert.match(blast, /`product` shows no errors and is unaffected/);
  assert.match(blast, /Evidence check: removed orders from the blast radius/);
  // Other sections untouched.
  assert.match(answer, /### Root cause\nThe `order` service throws on a request field\./);
  assert.match(answer, /### Recommended fix\nValidate the field and return 400\./);
});

test('2: `order` is never mistaken for `orders` (or the reverse)', () => {
  const metrics = [{ services: [
    { service: 'order', error_rate_percent: 0, server_errors_5xx_in_window: { approx_total: 0, by_status: [] } },
    { service: 'orders', error_rate_percent: 5, server_errors_5xx_in_window: { approx_total: 3, by_status: [{ status: '500', count: 3 }] } },
  ] }];
  const text = '### Blast radius\n**Affected services:** orders (origin), order\n- `order` write path impacted\n';
  const { answer, removed } = enforceBlastRadius(text, metrics);
  assert.deepEqual(removed, ['order']);
  assert.match(answer, /\*\*Affected services:\*\* orders \(origin\)\n/);
  assert.doesNotMatch(answer, /write path impacted/);
});

test('2: no fetch_metrics evidence -> answer left exactly as written', () => {
  assert.equal(enforceBlastRadius(ANSWER, []).answer, ANSWER);
});

test('2: 5xx counted in the window keep a service even when the current rate is 0', () => {
  const metrics = [{ services: [
    { service: 'orders', error_rate_percent: 0, server_errors_5xx_in_window: { approx_total: 2, by_status: [{ status: '500', count: 2 }] } },
  ] }];
  const text = '### Blast radius\n**Affected services:** orders\n';
  assert.equal(enforceBlastRadius(text, metrics).answer, text);
});

test('3: LIFETIME 5xx (an old pod counter) never keep a service in the blast radius', () => {
  // The healthy-system run: "order 106 errors since pod start", left over
  // from a fault disarmed 15 minutes earlier, was reported as current.
  const metrics = [{ services: [
    { service: 'order', error_rate_percent: 0, server_errors_5xx_in_window: { approx_total: 0, by_status: [] },
      server_errors_5xx_since_pod_start: { total: 106 }, status_counts_since_pod_start: [{ status: '500', count: 106 }] },
  ] }];
  const { removed } = enforceBlastRadius('### Blast radius\n**Affected services:** order\n', metrics);
  assert.deepEqual(removed, ['order']);
});
