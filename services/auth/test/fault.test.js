// F4 (memory leak) must be a strict no-op unless SEED_MEMORY_LEAK_MB_PER_S is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leakRateFromEnv, startLeak } from '../src/fault.js';

const neverCall = () => { throw new Error('must not be called when the fault is off'); };

test('OFF by default: unset / empty / "false" / "0" / junk -> no timers, nothing allocated', () => {
  for (const env of [{}, { SEED_MEMORY_LEAK_MB_PER_S: '' }, { SEED_MEMORY_LEAK_MB_PER_S: 'false' }, { SEED_MEMORY_LEAK_MB_PER_S: '0' },
    { SEED_MEMORY_LEAK_MB_PER_S: '-1' }, { SEED_MEMORY_LEAK_MB_PER_S: 'lots' }]) {
    assert.equal(leakRateFromEnv(env), 0, JSON.stringify(env));
    assert.equal(startLeak({ mbPerSec: leakRateFromEnv(env), setTimer: neverCall, setRepeat: neverCall }), null);
  }
});

test('armed: waits, then retains mbPerSec MiB every second; rate capped at 16', () => {
  assert.equal(leakRateFromEnv({ SEED_MEMORY_LEAK_MB_PER_S: '2' }), 2);
  assert.equal(leakRateFromEnv({ SEED_MEMORY_LEAK_MB_PER_S: '500' }), 16);
  let delayed = null;
  let tick = null;
  const leak = startLeak({
    mbPerSec: 2,
    setTimer: (fn, ms) => { delayed = [fn, ms]; },
    setRepeat: (fn, ms) => { tick = fn; assert.equal(ms, 1000); },
  });
  assert.equal(delayed[1], 20000, 'starts after the pod has had time to become Ready');
  assert.equal(leak.held.length, 0);
  delayed[0]();
  tick(); tick(); tick();
  assert.equal(leak.held.length, 3);
  assert.equal(leak.held[0].length, 2 * 1024 * 1024);
  assert.equal(leak.held[0][123], 1, 'pages are touched, so the memory is resident');
});
