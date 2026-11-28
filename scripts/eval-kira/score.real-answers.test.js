/**
 * Scorer regression tests built from REAL Kira answers (evaluation run
 * 2026-11-27 20:54, qwen2.5:7b; verbatim copies in fixtures/).
 *
 * The bug: qwen does not always use the five "### " headings. Some answers
 * start straight with the **Category:** line (no "### Root cause"), some put
 * only the Category line under Root cause, some use bold pseudo-headings
 * ("**Blast radius:**"). The scorer then found no Root cause text and failed
 * the ORIGIN check - with a reason ("expected auth, marked auth") that hid
 * which condition had failed - even though the model had marked the right
 * origin.
 *
 * These tests pin the corrected verdict of every run that was WRONG, and
 * guard against loosening: real mistakes (F4 runs 1 and 3 list `user`; F3
 * run 1 says bad-config; F2 says none) must stay WRONG, for the right reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreAnswer, section, preamble, affectedServices } from './score.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/kira-eval-2026-11-27-2054.answers.json', import.meta.url), 'utf8'));
const get = (scenario, run) => {
  const a = FIX.answers.find((x) => x.scenario === scenario && x.run === run);
  assert.ok(a, `fixture ${scenario} run ${run}`);
  return a.answer;
};
const score = (scenario, run) => scoreAnswer(scenario, get(scenario, run));

// ---- false negatives the old scorer produced: now correct -------------------------

for (const [scenario, run, why] of [
  ['F1', 3, 'no "### Root cause" heading; starts with the Category line'],
  ['F4', 4, 'bold pseudo-headings throughout, no Root cause section'],
  ['F4', 5, 'bold pseudo-headings throughout, no Root cause section'],
  ['F5', 1, '"### Root cause" holds only the Category line'],
  ['F6', 3, 'bold pseudo-headings, no Root cause section'],
  ['F6', 4, 'bold pseudo-headings, no Root cause section'],
  ['F6', 5, 'bold pseudo-headings, no Root cause section'],
]) {
  test(`${scenario} run ${run} is CORRECT (${why})`, () => {
    const s = score(scenario, run);
    assert.equal(s.correct, true, s.reasons.join('; '));
    assert.equal(s.marked_origin, { F1: 'order', F4: 'auth', F5: 'orders', F6: 'gateway' }[scenario]);
  });
}

test('F6 run 5 passes the four checks but is flagged: its prose calls `order` the origin', () => {
  const s = score('F6', 5);
  assert.equal(s.correct, true);
  assert.ok(s.warnings.some((w) => /prose also calls order the origin/.test(w)), s.warnings.join('; '));
});

// ---- real mistakes: must stay WRONG, for the real reason ---------------------------

test('F4 run 1 stays WRONG: `user` in the blast radius (origin itself is now right)', () => {
  const s = score('F4', 1);
  assert.equal(s.correct, false);
  assert.equal(s.origin_ok, true);
  assert.equal(s.blast_ok, false);
  assert.deepEqual(s.wrong_services, ['user']);
  assert.deepEqual(s.reasons, ['wrong services in blast radius: user']);
});

test('F4 run 3 stays WRONG: `user` in the blast radius', () => {
  const s = score('F4', 3);
  assert.equal(s.correct, false);
  assert.deepEqual(s.wrong_services, ['user']);
});

test('F3 run 1 stays WRONG: category bad-config for a crash loop', () => {
  const s = score('F3', 1);
  assert.equal(s.correct, false);
  assert.equal(s.category_found, 'bad-config');
  assert.deepEqual(s.reasons, ['category: expected crash-loop, got bad-config']);
});

for (const run of [1, 2, 3, 4, 5]) {
  test(`F2 run ${run} stays WRONG: says category none for a latency fault`, () => {
    const s = score('F2', run);
    assert.equal(s.correct, false);
    assert.equal(s.category_ok, false);
    assert.equal(s.category_found, 'none');
  });
}

// ---- no loosening: nothing previously correct changes, every answer is stable ---

test('every answer the old scorer called CORRECT is still CORRECT', () => {
  for (const a of FIX.answers.filter((x) => x.raw_correct)) {
    const s = scoreAnswer(a.scenario, a.answer);
    assert.equal(s.correct, true, `${a.scenario} run ${a.run}: ${s.reasons.join('; ')}`);
  }
});

test('only the seven format false-negatives change verdict', () => {
  const changed = FIX.answers
    .filter((a) => scoreAnswer(a.scenario, a.answer).correct !== a.raw_correct)
    .map((a) => `${a.scenario}#${a.run}`)
    .sort();
  assert.deepEqual(changed, ['F1#3', 'F4#4', 'F4#5', 'F5#1', 'F6#3', 'F6#4', 'F6#5']);
});

// ---- the parsing pieces, on synthetic edge cases -----------------------------------

test('bold pseudo-headings and ### headings both delimit sections; a bold label with content does not', () => {
  const a = '**Category:** latency\n\n**Evidence:**\n- x\n\n**Blast radius:**\n- **Affected services:** product (origin)\n\n### Recommended Fix\nfix';
  assert.equal(preamble(a), '**Category:** latency');
  assert.equal(section(a, 'Evidence'), '- x');
  assert.match(section(a, 'Blast radius'), /Affected services/);
  assert.equal(section(a, 'recommended fix'), 'fix');
  assert.equal(affectedServices(a).markedOrigin, 'product');
});

test('a correctly marked origin still FAILS if the Root cause names only another service', () => {
  const a = '### Root cause\n**Category:** latency\nThe `gateway` is slow.\n### Blast radius\n**Affected services:** product (origin), gateway\n';
  const s = scoreAnswer('F2', a);
  assert.equal(s.origin_ok, false);
  assert.match(s.reasons[0], /marked product but Root cause names only gateway/);
});

test('a wrong marked origin FAILS even with no Root cause section', () => {
  const a = '**Category:** out-of-memory\n\n**Blast radius:**\n- **Affected services:** user (origin), auth\n';
  const s = scoreAnswer('F4', a);
  assert.equal(s.origin_ok, false);
  assert.match(s.reasons[0], /expected auth, marked user/);
});

test('no marker and no Root cause: origin fails, and the reason says why', () => {
  const s = scoreAnswer('F4', '**Category:** out-of-memory\n\nThe auth pod was OOMKilled.\n');
  // "The auth pod..." is in the preamble, so it counts as the root-cause text.
  assert.equal(s.origin_ok, true);
  const t = scoreAnswer('F4', '**Category:** out-of-memory\n\n**Evidence:**\n- auth OOMKilled\n');
  assert.equal(t.origin_ok, false);
  assert.match(t.reasons[0], /not named in Root cause \(no Root cause section\) and no \(origin\) marker/);
});

test('**Category**: x (colon outside the bold) and `backticked` values are read', () => {
  assert.equal(scoreAnswer('F2', '### Root cause\n**Category**: `latency`\n`product` is slow (p95 2300 ms).\n').category_found, 'latency');
});
