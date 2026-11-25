// F2 (latency) must be a strict no-op unless SEED_PRODUCT_LATENCY_MS is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latencyMsFromEnv, latencyMiddleware } from '../src/fault.js';

test('OFF by default: unset / empty / "false" / "0" / junk -> 0 ms and NO middleware installed', () => {
  for (const env of [{}, { SEED_PRODUCT_LATENCY_MS: '' }, { SEED_PRODUCT_LATENCY_MS: '  ' }, { SEED_PRODUCT_LATENCY_MS: 'false' },
    { SEED_PRODUCT_LATENCY_MS: 'FALSE' }, { SEED_PRODUCT_LATENCY_MS: '0' }, { SEED_PRODUCT_LATENCY_MS: '-5' }, { SEED_PRODUCT_LATENCY_MS: 'abc' }]) {
    assert.equal(latencyMsFromEnv(env), 0, JSON.stringify(env));
    assert.equal(latencyMiddleware(latencyMsFromEnv(env)), null, JSON.stringify(env));
  }
});

test('armed: the configured delay, capped at 4000 ms', () => {
  assert.equal(latencyMsFromEnv({ SEED_PRODUCT_LATENCY_MS: '1200' }), 1200);
  assert.equal(latencyMsFromEnv({ SEED_PRODUCT_LATENCY_MS: '999999' }), 4000);
});

test('armed: delays normal requests, never probes or /metrics', async () => {
  const slept = [];
  const mw = latencyMiddleware(1200, async (ms) => { slept.push(ms); });
  const run = (path) => new Promise((resolve) => mw({ path }, {}, resolve));
  await run('/products');
  await run('/health');
  await run('/ready');
  await run('/metrics');
  assert.deepEqual(slept, [1200]);
});
