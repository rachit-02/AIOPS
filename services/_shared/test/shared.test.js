import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../index.js';

// Boots a real HTTP server on an ephemeral port: tests the wire behaviour
// (what Prometheus / Kubernetes actually see), not just function calls.
async function boot(opts = {}, routes = () => {}) {
  const svc = createService({ name: 'test', ...opts });
  routes(svc.app);
  const server = svc.start({ port: 0, handleSignals: false });
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, server, ...svc };
}

test('/health is always ok and /metrics is Prometheus text', async () => {
  const { base, server } = await boot();
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert.match(metrics, /process_cpu_user_seconds_total/);
  server.close();
});

test('requests are counted by route TEMPLATE, not raw URL', async () => {
  const { base, server } = await boot({}, (app) =>
    app.get('/things/:id', (req, res) => res.json({ id: req.params.id })),
  );
  await fetch(`${base}/things/1`);
  await fetch(`${base}/things/2`);
  await fetch(`${base}/nope`);
  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert.match(metrics, /http_requests_total\{method="GET",route="\/things\/:id",status="200"\} 2/);
  assert.match(metrics, /route="unmatched",status="404"\} 1/);
  assert.match(metrics, /http_request_duration_seconds_bucket\{le="0.005"/);
  assert.doesNotMatch(metrics, /things\/1/); // no cardinality explosion
  server.close();
});

test('ops endpoints do not pollute request metrics', async () => {
  const { base, server } = await boot();
  await fetch(`${base}/health`);
  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert.doesNotMatch(metrics, /route="\/health"/);
  server.close();
});

test('/ready returns 503 when a dependency check fails', async () => {
  const badPool = { query: async () => { throw new Error('connection refused'); }, end: async () => {} };
  const { base, server } = await boot({ pool: badPool });
  const res = await fetch(`${base}/ready`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).checks.postgres, /connection refused/);
  server.close();
});

test('/ready returns 200 when dependencies are healthy', async () => {
  const goodPool = { query: async () => ({}), end: async () => {} };
  const { base, server } = await boot({ pool: goodPool });
  assert.equal((await fetch(`${base}/ready`)).status, 200);
  server.close();
});

test('chaos endpoints are absent unless CHAOS_ENABLED', async () => {
  delete process.env.CHAOS_ENABLED;
  const off = await boot();
  assert.equal((await fetch(`${off.base}/chaos`)).status, 404);
  off.server.close();
});

// Split from the test above so the env var is set before any `await`: mutating
// process.env after an await is what ESLint's require-atomic-updates warns
// about, and the rule is right that it would be a race if tests ran concurrently.
test('chaos injects errors when enabled', async () => {
  process.env.CHAOS_ENABLED = 'true';
  const on = await boot({}, (app) => app.get('/x', (req, res) => res.json({ ok: 1 })));
  assert.equal((await fetch(`${on.base}/x`)).status, 200);
  await fetch(`${on.base}/chaos/errors?rate=1`, { method: 'POST' });
  assert.equal((await fetch(`${on.base}/x`)).status, 500);
  await fetch(`${on.base}/chaos/reset`, { method: 'POST' });
  assert.equal((await fetch(`${on.base}/x`)).status, 200);
  on.server.close();
  delete process.env.CHAOS_ENABLED;
});

test('x-request-id is generated and echoed', async () => {
  const { base, server } = await boot();
  const res = await fetch(`${base}/health`, { headers: { 'x-request-id': 'abc-123' } });
  assert.equal(res.headers.get('x-request-id'), 'abc-123');
  const res2 = await fetch(`${base}/health`);
  assert.ok(res2.headers.get('x-request-id'));
  server.close();
});
