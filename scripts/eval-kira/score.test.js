import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAnswer, affectedServices, section, servicesIn } from './score.js';

const F1_GOOD = `### Root cause
**Category:** code-bug
The \`order\` service throws TypeError reading 'line1' of an undefined shipping address.

### Evidence
- **Metrics:** order 5xx.
- **Logs:** unhandled_error with stack trace.

### Blast radius
**Affected services:** order (origin), gateway, frontend (collateral)

### Recommended fix
Validate and return 400.

### Prevention
A test.`;

test('a correct F1 answer scores 4/4', () => {
  const s = scoreAnswer('F1', F1_GOOD);
  assert.equal(s.correct, true, s.reasons.join('; '));
  assert.equal(s.score, 4);
  assert.equal(s.marked_origin, 'order');
});

test('order is never confused with orders', () => {
  assert.deepEqual(servicesIn('orders only'), ['orders']);
  assert.deepEqual(servicesIn('the order service'), ['order']);
  const wrong = F1_GOOD.replace('order (origin), gateway', 'order (origin), orders, gateway');
  const s = scoreAnswer('F1', wrong);
  assert.equal(s.blast_ok, false);
  assert.deepEqual(s.wrong_services, ['orders']);
  assert.equal(s.correct, false);
});

test('wrong origin and wrong category are both caught', () => {
  const ans = F1_GOOD.replace('**Category:** code-bug', '**Category:** bad-config').replace('order (origin)', 'product (origin)');
  const s = scoreAnswer('F1', ans);
  assert.equal(s.category_ok, false);
  assert.equal(s.origin_ok, false, 'marked origin product != order');
  assert.ok(s.reasons.some((r) => /category/.test(r)));
});

test('missing Category line falls back to keywords and says so', () => {
  const s = scoreAnswer('F1', F1_GOOD.replace('**Category:** code-bug\n', ''));
  assert.equal(s.category_fallback, true);
  assert.equal(s.category_ok, true);
});

test('HEALTHY: the guard answer is correct; an invented incident is not', () => {
  const ok = '### Root cause\n**Category:** none\nNo active incident found.\n### Blast radius\n**Affected services:** none. No service is returning server errors.\n';
  assert.equal(scoreAnswer('HEALTHY', ok).correct, true);
  const bad = '### Root cause\n**Category:** code-bug\n`product` is failing.\n### Blast radius\n**Affected services:** product (origin)\n';
  const s = scoreAnswer('HEALTHY', bad);
  assert.equal(s.correct, false);
  assert.deepEqual(s.wrong_services, ['product']);
});

test('F3: CrashLoopBackOff answer on user is correct; adding gateway to the blast radius is not', () => {
  const ans = '### Root cause\n**Category:** crash-loop\n`user` pod is in CrashLoopBackOff (exit code 1).\n### Blast radius\n**Affected services:** user (origin)\n';
  assert.equal(scoreAnswer('F3', ans).correct, true);
  assert.equal(scoreAnswer('F3', ans.replace('user (origin)', 'user (origin), gateway')).blast_ok, false);
});

test('section() and affectedServices() parse the five-heading format', () => {
  assert.match(section(F1_GOOD, 'Recommended fix'), /^Validate/);
  assert.deepEqual(affectedServices(F1_GOOD).listed.sort(), ['frontend', 'gateway', 'order']);
});
