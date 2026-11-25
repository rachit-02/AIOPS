import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createIdempotency } from '../src/idempotency.js';

const fakeRes = () => new EventEmitter();

test('no key -> no idempotency', async () => {
  const idem = createIdempotency();
  assert.equal(await idem.claim(1, undefined, fakeRes()), null);
  assert.equal(await idem.claim(1, '', fakeRes()), null);
  assert.equal(await idem.claim(1, 'x'.repeat(201), fakeRes()), null);
});

test('a key that created an order replays that order', async () => {
  const idem = createIdempotency();
  const first = await idem.claim(1, 'k', fakeRes());
  first.settle({ id: 183 });
  const second = await idem.claim(1, 'k', fakeRes());
  assert.deepEqual(second, { replay: { id: 183 } });
});

test('a concurrent duplicate waits for the first and gets its order', async () => {
  const idem = createIdempotency();
  const first = await idem.claim(1, 'k', fakeRes());
  const pending = idem.claim(1, 'k', fakeRes()); // in flight at the same time
  first.settle({ id: 7 });
  assert.deepEqual(await pending, { replay: { id: 7 } });
});

test('a failed attempt releases the key so a retry is processed', async () => {
  const idem = createIdempotency();
  const res = fakeRes();
  await idem.claim(1, 'k', res);
  res.emit('finish'); // e.g. 402 decline - never settled with an order
  const retry = await idem.claim(1, 'k', fakeRes());
  assert.equal(typeof retry.settle, 'function');
});

test('two waiters on a failed attempt: only one proceeds, the other replays it', async () => {
  const idem = createIdempotency();
  const res = fakeRes();
  await idem.claim(1, 'k', res);
  const a = idem.claim(1, 'k', fakeRes());
  const b = idem.claim(1, 'k', fakeRes());
  res.emit('finish'); // first attempt failed
  const ra = await a; // a claims the slot...
  assert.equal(typeof ra.settle, 'function');
  ra.settle({ id: 9 }); // ...and succeeds
  assert.deepEqual(await b, { replay: { id: 9 } });
});

test('keys are scoped per user', async () => {
  const idem = createIdempotency();
  (await idem.claim(1, 'k', fakeRes())).settle({ id: 1 });
  const other = await idem.claim(2, 'k', fakeRes());
  assert.equal(typeof other.settle, 'function');
});

test('entries expire after the TTL', async () => {
  let t = 0;
  const idem = createIdempotency({ ttlMs: 1000, now: () => t });
  (await idem.claim(1, 'k', fakeRes())).settle({ id: 1 });
  t = 1001;
  const again = await idem.claim(1, 'k', fakeRes());
  assert.equal(typeof again.settle, 'function');
});
