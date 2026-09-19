import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagPattern, REPO_ROOT } from '../src/incident.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Regression tests for the incident toggle's manifest edit.
 *
 * This broke in production on its first real run: the original implementation
 * matched a literal "\n              value:", which never matches a working
 * tree checked out with CRLF. The failure was silent — it reported "already in
 * the target state" while the cluster stayed on the old value — so it is
 * exactly the kind of bug that needs a test rather than a careful reading.
 */
const doc = (eol, value) =>
  ['          env:', '            - name: SEED_BUG_NULL_SHIPPING', `              value: "${value}"`, ''].join(eol);

for (const [name, eol] of [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
]) {
  test(`matches and flips true -> false with ${name} line endings`, () => {
    const text = doc(eol, 'true');
    const re = flagPattern('true');
    assert.ok(re.test(text), `pattern should match ${name}`);
    const out = text.replace(re, '$1"false"');
    assert.match(out, /value: "false"/);
    assert.doesNotMatch(out, /value: "true"/);
  });

  test(`matches and flips false -> true with ${name} line endings`, () => {
    const text = doc(eol, 'false');
    const re = flagPattern('false');
    assert.ok(re.test(text));
    assert.match(text.replace(re, '$1"true"'), /value: "true"/);
  });

  test(`reports no-op when already in the target state (${name})`, () => {
    // Asking to set "false" when it is already "false" must NOT match, so the
    // caller can skip the commit rather than creating an empty one.
    assert.equal(flagPattern('true').test(doc(eol, 'false')), false);
  });
}

test('matches the real manifest in the repository', () => {
  const real = readFileSync(join(REPO_ROOT, 'infra/k8s/base/order/deployment.yaml'), 'utf8');
  const matchesEither = flagPattern('true').test(real) || flagPattern('false').test(real);
  assert.ok(
    matchesEither,
    'the pattern must match the actual manifest — if this fails the toggle is silently broken',
  );
});
