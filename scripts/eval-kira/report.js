/**
 * CSV and markdown output for the Kira evaluation - shared by a live run
 * (index.js) and by --rescore (rescore.js), so both write the same format.
 */
import { EXPECTATIONS } from './score.js';

export const COLUMNS = [
  'timestamp', 'scenario', 'expected_origin', 'expected_category', 'run', 'correct', 'score',
  'origin_ok', 'category_ok', 'category_found', 'category_fallback', 'evidence_ok', 'blast_ok', 'wrong_services',
  'time_to_diagnosis_s', 'time_to_visible_s', 'tool_calls', 'guard', 'partial', 'all_three_signals',
  'error', 'reasons', 'warnings', 'trace_file', 'answer_excerpt',
];

export const csvCell = (v) => {
  const s = Array.isArray(v) ? v.join(' ') : v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvLine = (row) => COLUMNS.map((c) => csvCell(row[c])).join(',');

/** RFC-4180-ish parser (quoted cells, doubled quotes, embedded newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head = [], ...rest] = rows;
  return rest.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const truthy = (v) => v === true || v === 'true';
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

/** Per-scenario aggregates. */
export function aggregate(rows, scenarios) {
  return scenarios.map((s) => {
    const rs = rows.filter((r) => r.scenario === s);
    const correct = rs.filter((r) => truthy(r.correct)).length;
    const timed = rs.map((r) => num(r.time_to_diagnosis_s)).filter(Number.isFinite);
    const scores = rs.map((r) => num(r.score)).filter(Number.isFinite);
    return {
      scenario: s,
      runs: rs.length,
      correct,
      accuracy: rs.length ? Math.round((100 * correct) / rs.length) : null,
      meanScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      meanTime: timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : null,
      visible: num(rs[0]?.time_to_visible_s),
      reasons: [...new Set(rs.flatMap((r) => (r.reasons ? String(r.reasons).split('; ') : [])).filter(Boolean))],
      notVisible: rs[0]?.error === 'not_visible',
    };
  });
}

/** The per-scenario markdown table (same columns for live and re-scored runs). */
export function summaryTable(rows, scenarios) {
  const lines = [
    '| Scenario | Expected | Runs | Correct | Accuracy | Mean score /4 | Mean time to diagnosis | Time to visible | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  let allRuns = 0;
  let allCorrect = 0;
  for (const a of aggregate(rows, scenarios)) {
    const exp = EXPECTATIONS[a.scenario];
    allRuns += a.runs;
    allCorrect += a.correct;
    const notes = a.notVisible ? 'fault never became visible - runs skipped'
      : a.reasons.length ? a.reasons.slice(0, 3).join('; ') : a.runs ? 'all checks passed' : 'not run';
    lines.push(
      `| ${a.scenario} | ${exp.origin ?? '—'} / ${exp.category} | ${a.runs} | ${a.correct} | ` +
      `${a.accuracy === null ? '—' : a.accuracy + '%'} | ${a.meanScore === null ? '—' : a.meanScore.toFixed(2)} | ` +
      `${a.meanTime === null ? '—' : a.meanTime.toFixed(0) + ' s'} | ${Number.isFinite(a.visible) ? Math.round(a.visible) + ' s' : '—'} | ` +
      `${notes.replace(/\|/g, '/')} |`,
    );
  }
  lines.push(`| **Overall** | | **${allRuns}** | **${allCorrect}** | **${allRuns ? Math.round((100 * allCorrect) / allRuns) + '%' : '—'}** | | | | |`);
  return lines;
}

/** Full markdown summary for a live run. */
export function buildSummary(rows, { scenarios, runs, window, model, commit, date, csvName }) {
  return [
    `# Kira evaluation — ${date}`,
    '',
    `- Model: \`${model || 'unknown'}\` · commit \`${commit}\` · ${runs} run(s) per scenario · question window: last ${window}`,
    '- Scoring: a run is **correct** only if all four checks pass (origin, category, evidence, blast radius) — see [README](README.md).',
    `- Raw results: \`${csvName}\``,
    '',
    ...summaryTable(rows, scenarios),
    '',
    `Started ${date}, finished ${new Date().toISOString()}. Failures are results: every run is in the CSV, including the answer excerpt and the reasons a check failed.`,
    '',
  ].join('\n');
}
