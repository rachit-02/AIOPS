// F3 (crash on start) must be a strict no-op unless SEED_CRASH_ON_START=true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crashOnStartFromEnv, scheduleCrash } from '../src/fault.js';

const neverCall = () => { throw new Error('must not be called when the fault is off'); };

test('OFF by default: unset / empty / "false" / "0" / junk -> nothing scheduled, never exits', () => {
  for (const env of [{}, { SEED_CRASH_ON_START: '' }, { SEED_CRASH_ON_START: 'false' }, { SEED_CRASH_ON_START: 'FALSE' },
    { SEED_CRASH_ON_START: '0' }, { SEED_CRASH_ON_START: 'no' }]) {
    assert.equal(crashOnStartFromEnv(env), false, JSON.stringify(env));
    const timer = scheduleCrash({ enabled: crashOnStartFromEnv(env), log: { error: neverCall }, exit: neverCall, setTimer: neverCall });
    assert.equal(timer, null);
  }
});

test('armed: logs an error-level startup failure, then exits 1', () => {
  assert.equal(crashOnStartFromEnv({ SEED_CRASH_ON_START: 'true' }), true);
  const logged = [];
  let exitCode = null;
  let scheduledFn = null;
  scheduleCrash({
    enabled: true,
    log: { error: (obj, msg) => logged.push([obj, msg]) },
    exit: (c) => { exitCode = c; },
    setTimer: (fn, ms) => { scheduledFn = fn; assert.equal(ms, 3000); return 1; },
  });
  assert.equal(exitCode, null, 'does not exit synchronously');
  scheduledFn();
  assert.equal(exitCode, 1);
  assert.equal(logged[0][1], 'fatal_startup_error');
  assert.match(logged[0][0].err.message, /SEED_CRASH_ON_START/);
});
