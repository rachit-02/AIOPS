/**
 * --rescore <csv>: re-score a finished evaluation from its saved answers,
 * without re-running any fault.
 *
 * For each CSV row the answer is read verbatim from its trace file
 * (aiops/kira/traces/<trace_file>), or - if the trace is gone - from a
 * fixtures/<run>.answers.json copy. Rows that never had an answer (Ollama
 * crashed, fault not visible) keep their original verdict. Writes
 * <name>-rescored.csv and <name>-rescored.md next to the original, which is
 * left untouched. Timing, guard and visibility columns are carried over.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreAnswer } from './score.js';
import { COLUMNS, csvLine, parseCsv, summaryTable, aggregate } from './report.js';

const truthy = (v) => v === true || v === 'true';

export function rescoreRows(rows, answerFor) {
  return rows.map((r) => {
    const answer = r.trace_file ? answerFor(r) : null;
    if (answer === null || answer === undefined) return { ...r, rescored: false };
    const s = scoreAnswer(r.scenario, answer);
    return {
      ...r,
      correct: s.correct, score: s.score, origin_ok: s.origin_ok, category_ok: s.category_ok,
      category_found: s.category_found ?? '', category_fallback: s.category_fallback,
      evidence_ok: s.evidence_ok, blast_ok: s.blast_ok, wrong_services: s.wrong_services,
      reasons: s.reasons.join('; '), warnings: s.warnings.join('; '),
      raw_correct: r.correct, raw_reasons: r.reasons, rescored: true,
    };
  });
}

export function rescore(csvPath, { repo, tracesDir }) {
  const text = readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  const name = basename(csvPath, '.csv');
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', `${name}.answers.json`);
  const fixtureAnswers = existsSync(fixture) ? JSON.parse(readFileSync(fixture, 'utf8')).answers : [];
  const traces = tracesDir ?? join(repo, 'aiops', 'kira', 'traces');
  const sources = { trace: 0, fixture: 0, none: 0 };
  const answerFor = (r) => {
    const p = join(traces, r.trace_file);
    if (existsSync(p)) { sources.trace++; return JSON.parse(readFileSync(p, 'utf8')).answer; }
    const f = fixtureAnswers.find((a) => a.trace_file === r.trace_file);
    if (f) { sources.fixture++; return f.answer; }
    sources.none++;
    return null;
  };
  const out = rescoreRows(rows, answerFor);

  const outCsv = csvPath.replace(/\.csv$/, '-rescored.csv');
  const outMd = csvPath.replace(/\.csv$/, '-rescored.md');
  writeFileSync(outCsv, [COLUMNS.join(','), ...out.map(csvLine)].join('\n') + '\n');

  const scenarios = [...new Set(rows.map((r) => r.scenario))];
  const changed = out.filter((r) => r.rescored && String(truthy(r.raw_correct)) !== String(r.correct));
  const raw = aggregate(rows, scenarios);
  const fixed = aggregate(out, scenarios);
  const total = (agg) => agg.reduce((n, a) => n + a.correct, 0);
  const runs = rows.length;
  const origMd = csvPath.replace(/\.csv$/, '.md');
  const header = existsSync(origMd) ? readFileSync(origMd, 'utf8').split('\n').filter((l) => /^- Model:/.test(l))[0] ?? '' : '';

  const md = [
    `# Kira evaluation — ${name} (re-scored)`,
    '',
    header,
    `- Re-scored ${new Date().toISOString()} with the corrected scorer (\`scripts/eval-kira/score.js\`) from the saved answers; no fault was re-run. Original kept as \`${name}.md\` / \`${name}.csv\`.`,
    `- Answers read from: ${sources.trace} trace file(s), ${sources.fixture} fixture cop(ies); ${rows.length - sources.trace - sources.fixture} row(s) had no answer and keep their original verdict.`,
    `- **Raw accuracy ${total(raw)}/${runs} (${Math.round((100 * total(raw)) / runs)}%) → corrected ${total(fixed)}/${runs} (${Math.round((100 * total(fixed)) / runs)}%)**; ${changed.length} verdict(s) changed. See "Scorer fix" in [README](README.md).`,
    '',
    '## Corrected results',
    '',
    ...summaryTable(out, scenarios),
    '',
    '## Verdicts changed by the scorer fix',
    '',
    changed.length ? '| Scenario | Run | Raw | Corrected | Raw reason | Warnings |' : '_none_',
    ...(changed.length ? ['|---|---|---|---|---|---|'] : []),
    ...changed.map((r) => `| ${r.scenario} | ${r.run} | ${truthy(r.raw_correct) ? 'CORRECT' : 'WRONG'} | ${r.correct ? 'CORRECT' : 'WRONG'} | ${String(r.raw_reasons).replace(/\|/g, '/')} | ${r.warnings || ''} |`),
    '',
    '## Remaining failures',
    '',
    '| Scenario | Run | Score | Reason | Warnings |',
    '|---|---|---|---|---|',
    ...out.filter((r) => !truthy(r.correct)).map((r) => `| ${r.scenario} | ${r.run} | ${r.score}/4 | ${String(r.reasons || r.error).replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 220)} | ${r.warnings || ''} |`),
    '',
  ];
  writeFileSync(outMd, md.join('\n'));
  return { outCsv, outMd, changed, raw: total(raw), corrected: total(fixed), runs, sources };
}
