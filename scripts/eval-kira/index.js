#!/usr/bin/env node
/**
 * Kira evaluation harness.
 *
 *   node scripts/eval-kira                       # HEALTHY + F1..F6, 3 runs each
 *   node scripts/eval-kira --faults F1 --runs 1  # one fault, one run
 *   node scripts/eval-kira --runs 5
 *
 * For each scenario: arm the fault through the Kira server (a real Git commit,
 * applied by ArgoCD), wait until the fault is VISIBLE in the signals, run
 * Kira's investigation N times through its API, score every answer
 * (score.js / docs/evaluation/README.md), disarm, and wait for FULL recovery
 * before the next scenario. Results: docs/evaluation/kira-eval-<date>.csv/.md.
 *
 * Needs: the Kira server running (npm run server), kubectl context
 * kind-aiops-local, Prometheus :9091, Loki :3100, storefront :8090.
 * Generates its own light traffic, so scripts/traffic.sh must NOT be running.
 * Ctrl+C (or any error) always disarms before exiting.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { scoreAnswer, EXPECTATIONS } from './score.js';
import { COLUMNS, csvLine, buildSummary } from './report.js';
import { rescore } from './rescore.js';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

// ---- options -------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);
if (flag('help')) {
  console.log('usage: node scripts/eval-kira [--faults HEALTHY,F1,...,F6] [--runs 1..10] [--window 5m]\n' +
    '       [--kira http://localhost:7777] [--prom http://localhost:9091] [--loki http://localhost:3100]\n' +
    '       [--frontend http://localhost:8090] [--visible-timeout 360] [--recover-timeout 900]\n' +
    '       node scripts/eval-kira --rescore docs/evaluation/kira-eval-<date>.csv [--traces aiops/kira/traces]');
  process.exit(0);
}

// --rescore <csv>: re-score saved answers with the current scorer; no cluster,
// no Kira server, no fault is touched. Writes <name>-rescored.csv/.md.
if (opt('rescore', null)) {
  const csv = opt('rescore', null);
  const path = /^[A-Za-z]:|^\//.test(csv) ? csv : join(process.cwd(), csv);
  if (!existsSync(path)) {
    console.error(`eval-kira: no such CSV ${path}`);
    process.exit(2);
  }
  const tracesOpt = opt('traces', null);
  const r = rescore(path, { repo: REPO, tracesDir: tracesOpt ? join(process.cwd(), tracesOpt) : null });
  console.log(`re-scored ${r.runs} run(s): raw ${r.raw}/${r.runs} correct -> corrected ${r.corrected}/${r.runs}; ${r.changed.length} verdict(s) changed`);
  for (const c of r.changed) console.log(`  ${c.scenario} run ${c.run}: ${c.raw_correct === 'true' ? 'CORRECT' : 'WRONG'} -> ${c.correct ? 'CORRECT' : 'WRONG'}  (raw reason: ${c.raw_reasons})`);
  console.log(`answers from ${r.sources.trace} trace(s), ${r.sources.fixture} fixture(s)\nwrote ${r.outCsv}\nwrote ${r.outMd}`);
  process.exit(0);
}
const ALL = ['HEALTHY', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6'];
const SCENARIOS = opt('faults', ALL.join(',')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const RUNS = Number(opt('runs', '3'));
const WINDOW = opt('window', '5m');
const KIRA = opt('kira', 'http://localhost:7777');
const PROM = opt('prom', 'http://localhost:9091');
const LOKI = opt('loki', 'http://localhost:3100');
const FRONTEND = opt('frontend', 'http://localhost:8090');
const VISIBLE_TIMEOUT_S = Number(opt('visible-timeout', '360'));
const RECOVER_TIMEOUT_S = Number(opt('recover-timeout', '900'));
const CONTEXT = 'kind-aiops-local';
const NS = 'aiops-dev';
const QUESTION = `Users report problems with the shop. Investigate the ${NS} namespace over the last ${WINDOW} and tell me the root cause.`;

for (const s of SCENARIOS) if (!EXPECTATIONS[s]) die(`unknown scenario "${s}" (use ${ALL.join(', ')})`);
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 10) die('--runs must be an integer 1..10');

function die(msg) {
  console.error(`eval-kira: ${msg}`);
  process.exit(2);
}
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const windowSeconds = (w) => {
  const m = /^(\d+)([smh])$/.exec(w);
  if (!m) die(`bad --window ${w}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
};

// ---- cluster / telemetry helpers --------------------------------------------------
async function kubectlJson(...a) {
  const { stdout } = await exec('kubectl', ['--context', CONTEXT, ...a, '-o', 'json'], { maxBuffer: 32 << 20 });
  return JSON.parse(stdout);
}
async function prom(expr) {
  const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(expr)}`, { signal: AbortSignal.timeout(15000) });
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`prometheus: ${body.error}`);
  return body.data.result.map((r) => ({ labels: r.metric, value: Number(r.value[1]) }));
}
async function lokiCount(selector, sinceSeconds) {
  const end = Date.now() * 1e6;
  const start = end - sinceSeconds * 1e9;
  const url = `${LOKI}/loki/api/v1/query_range?query=${encodeURIComponent(selector)}&start=${start}&end=${end}&limit=50`;
  const body = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).json();
  return (body?.data?.result ?? []).reduce((n, s) => n + s.values.length, 0);
}
async function pods(service) {
  const sel = service ? ['-l', `app.kubernetes.io/name=${service}`] : [];
  return (await kubectlJson('-n', NS, 'get', 'pods', ...sel)).items;
}
const cs = (p) => p.status?.containerStatuses?.[0] ?? {};

// ---- when is a fault VISIBLE? ------------------------------------------------------
const VISIBLE = {
  HEALTHY: async () => ({ ok: true, detail: 'baseline' }),
  F1: async () => {
    const r = await prom(`sum(increase(http_requests_total{namespace="${NS}",job="order",status=~"5.."}[2m]))`);
    const n = r[0]?.value ?? 0;
    return { ok: n >= 1, detail: `order 5xx in 2m: ${n.toFixed(1)}` };
  },
  F2: async () => {
    const r = await prom(`histogram_quantile(0.5, sum by (le) (rate(http_request_duration_seconds_bucket{namespace="${NS}",job="product"}[1m])))`);
    const p50 = r[0]?.value;
    return { ok: Number.isFinite(p50) && p50 >= 0.8, detail: `product p50 (1m): ${Number.isFinite(p50) ? Math.round(p50 * 1000) + ' ms' : 'n/a'}` };
  },
  F3: async () => {
    const bad = (await pods('user')).filter((p) => cs(p).state?.waiting?.reason === 'CrashLoopBackOff');
    return { ok: bad.length > 0, detail: `user pods in CrashLoopBackOff: ${bad.length}` };
  },
  F4: async () => {
    const oom = (await pods('auth')).filter((p) => cs(p).lastState?.terminated?.reason === 'OOMKilled');
    return { ok: oom.length > 0, detail: `auth pods with OOMKilled last state: ${oom.length}` };
  },
  F5: async () => {
    const notReady = (await pods('orders')).filter((p) => !cs(p).ready).length;
    const lines = await lokiCount(`{kubernetes_namespace_name="${NS}", kubernetes_container_name="orders"} |= "readiness_check_failed"`, 180);
    return { ok: notReady > 0 && lines > 0, detail: `orders pods not ready: ${notReady}; readiness_check_failed lines (3m): ${lines}` };
  },
  F6: async () => {
    const bad = (await pods('gateway')).filter((p) => ['ErrImagePull', 'ImagePullBackOff'].includes(cs(p).state?.waiting?.reason));
    return { ok: bad.length > 0, detail: `gateway pods with image-pull errors: ${bad.length}` };
  },
};

/** Fully recovered: no fault armed, all rollouts done, pods Ready, no 5xx or slowness in the window. */
async function recovered() {
  const ns = await kubectlJson('get', 'namespace', NS);
  const active = ns.metadata?.annotations?.['aiops.dev/active-fault'] ?? 'none';
  if (active !== 'none') return { ok: false, detail: `fault still armed in cluster: ${active}` };
  const deps = (await kubectlJson('-n', NS, 'get', 'deployments')).items;
  const rolling = deps.filter((d) => {
    const want = d.spec.replicas ?? 1;
    return (d.status.updatedReplicas ?? 0) !== want || (d.status.availableReplicas ?? 0) !== want || (d.status.unavailableReplicas ?? 0) > 0;
  });
  if (rolling.length) return { ok: false, detail: `rollout in progress: ${rolling.map((d) => d.metadata.name).join(', ')}` };
  const all = await pods();
  const notReady = all.filter((p) => !p.metadata.deletionTimestamp && !cs(p).ready);
  if (notReady.length) return { ok: false, detail: `pods not ready: ${notReady.map((p) => p.metadata.name).join(', ')}` };
  if (all.some((p) => p.metadata.deletionTimestamp)) return { ok: false, detail: 'pods still terminating' };
  const recentRestart = all.filter((p) => {
    const t = Date.parse(cs(p).lastState?.terminated?.finishedAt ?? '');
    return Number.isFinite(t) && Date.now() - t < 10 * 60 * 1000;
  });
  if (recentRestart.length) return { ok: false, detail: `restart in last 10 min: ${recentRestart.map((p) => p.metadata.name).join(', ')}` };
  const err = await prom(`sum by (job) (increase(http_requests_total{namespace="${NS}",status=~"5.."}[${WINDOW}]))`);
  const errJobs = err.filter((r) => r.value >= 0.5);
  if (errJobs.length) return { ok: false, detail: `5xx still in the ${WINDOW} window: ${errJobs.map((r) => `${r.labels.job} ${r.value.toFixed(1)}`).join(', ')}` };
  const lat = await prom(`histogram_quantile(0.5, sum by (le,job) (rate(http_request_duration_seconds_bucket{namespace="${NS}"}[${WINDOW}])))`);
  const slow = lat.filter((r) => Number.isFinite(r.value) && r.value >= 0.8);
  if (slow.length) return { ok: false, detail: `still slow in the ${WINDOW} window: ${slow.map((r) => r.labels.job).join(', ')}` };
  return { ok: true, detail: 'recovered' };
}

async function waitFor(fn, timeoutS, label, everyS = 10) {
  const start = Date.now();
  let last = '';
  while ((Date.now() - start) / 1000 < timeoutS) {
    const r = await fn().catch((e) => ({ ok: false, detail: `check failed: ${e.message}` }));
    if (r.ok) return { ok: true, seconds: (Date.now() - start) / 1000, detail: r.detail };
    if (r.detail !== last) log(`  ${label}: ${r.detail}`);
    last = r.detail;
    await sleep(everyS * 1000);
  }
  return { ok: false, seconds: (Date.now() - start) / 1000, detail: last };
}

// ---- Kira server API ----------------------------------------------------------------
async function sse(path, body, onEvent) {
  const res = await fetch(`${KIRA}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  if (!res.ok || !res.body) throw new Error(`${path} -> HTTP ${res.status}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length) {
        try { onEvent(event, JSON.parse(data.join('\n'))); } catch { /* ignore a bad frame */ }
      }
    }
  }
}

async function setFault(id) {
  let error = null;
  await sse(id === 'none' ? '/api/faults/disarm' : `/api/faults/${id}/arm`, {}, (event, d) => {
    if (event === 'stage') log(`  [${d.stage}] ${d.detail}`);
    if (event === 'error') error = d.message;
  });
  if (error) throw new Error(error);
}

async function investigate() {
  const started = Date.now();
  let answer = null;
  let summary = {};
  let error = null;
  let toolCalls = 0;
  let model = '';
  await sse('/api/kira/investigate', { question: QUESTION }, (event, d) => {
    if (event === 'start') model = `${d.provider}:${d.model}`;
    if (event === 'tool_end') toolCalls++;
    if (event === 'answer') { answer = d.answer; summary = d; }
    if (event === 'error') error = d.message;
  });
  return { answer, summary, error, toolCalls, model, seconds: (Date.now() - started) / 1000 };
}

// ---- built-in light traffic (same mix as scripts/traffic.sh) -------------------------
function startTraffic() {
  const B = `${FRONTEND}/api`;
  const J = { 'content-type': 'application/json' };
  const email = `eval${Date.now()}@example.com`;
  // A throwaway account per run, with a random credential: nothing reusable in the repo.
  const pw = `eval-${randomUUID()}`;
  const ADDR = { line1: '1 Eval St', city: 'Pune', postcode: '411001' };
  let token = null;
  let stopped = false;
  let n = 0;
  const call = (path, init = {}) => fetch(`${B}${path}`, { ...init, signal: AbortSignal.timeout(10000) }).catch(() => null);
  const login = async () => {
    const r = await call('/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ email, password: pw }) });
    token = r?.ok ? (await r.json()).token : null;
  };
  const loop = (async () => {
    await call('/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email, name: 'Eval', password: pw }) });
    await login();
    while (!stopped) {
      n++;
      const auth = token ? { authorization: `Bearer ${token}` } : {};
      const prods = await call('/products');
      const list = prods?.ok ? await prods.json().catch(() => []) : [];
      const inStock = Array.isArray(list) ? list.filter((p) => p.stock > 0).map((p) => p.id) : [];
      const pick = () => inStock[Math.floor(Math.random() * inStock.length)];
      const jobs = [call('/orders', { headers: auth })];
      if (inStock.length && n % 5 === 0) {
        jobs.push(call('/orders', { method: 'POST', headers: { ...J, ...auth }, body: JSON.stringify({ items: [{ productId: pick(), qty: 1 }], shippingAddress: ADDR, card: '4242424242424242' }) }));
      }
      if (inStock.length && n % 5 === 2) {
        // No address: 400 normally, 500 while F1 is armed.
        jobs.push(call('/orders', { method: 'POST', headers: { ...J, ...auth }, body: JSON.stringify({ items: [{ productId: pick(), qty: 1 }], card: '4242424242424242' }) }));
      }
      const results = await Promise.all(jobs);
      if (results.some((r) => r?.status === 401) || n % 1500 === 0) await login();
      await sleep(2000);
    }
  })();
  return async () => { stopped = true; await loop.catch(() => {}); };
}

// ---- pre-flight ----------------------------------------------------------------------
async function trafficShRunning() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await exec('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'traffic\\.sh' } | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"]);
      // Drop this probe's own PowerShell process, whose command line mentions the pattern.
      return stdout.trim().split(/\r?\n/).filter((l) => l && !/Get-CimInstance/.test(l));
    }
    const { stdout } = await exec('ps', ['-eo', 'pid,args']);
    return stdout.split('\n').filter((l) => /scripts\/traffic\.sh/.test(l) && !/eval-kira/.test(l));
  } catch {
    return [];
  }
}

async function preflight() {
  const running = await trafficShRunning();
  if (running.length) {
    die(`scripts/traffic.sh is already running - refusing to start, so traffic is never doubled.\n` +
      `  The harness generates its own traffic. Stop these first (Ctrl+C in their terminals):\n    ${running.join('\n    ')}`);
  }
  const { stdout: ctx } = await exec('kubectl', ['config', 'current-context']).catch(() => ({ stdout: '' }));
  if (ctx.trim() !== CONTEXT) die(`kubectl context is "${ctx.trim()}", expected ${CONTEXT}`);
  const health = await fetch(`${KIRA}/api/healthz`).then((r) => r.ok).catch(() => false);
  if (!health) die(`Kira server not reachable at ${KIRA} - start it: cd aiops/kira && npm run server`);
  const faults = await fetch(`${KIRA}/api/faults`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!faults) die(`${KIRA}/api/faults missing - the Kira server is running old code; restart it`);
  if (faults.active.cluster !== 'none' || faults.active.git !== 'none') {
    die(`a fault is armed (cluster: ${faults.active.cluster}, git: ${faults.active.git}) - disarm it first`);
  }
  const fe = await fetch(`${FRONTEND}/api/products`).then((r) => r.ok).catch(() => false);
  if (!fe) die(`storefront not reachable at ${FRONTEND}`);
}

// ---- output ----------------------------------------------------------------------------
const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const OUT_DIR = join(REPO, 'docs', 'evaluation');
const CSV = join(OUT_DIR, `kira-eval-${stamp}.csv`);
const MD = join(OUT_DIR, `kira-eval-${stamp}.md`);
const rows = [];
function record(row) {
  rows.push(row);
  appendFileSync(CSV, csvLine(row) + '\n');
}

function writeSummary(m) {
  writeFileSync(MD, buildSummary(rows, {
    scenarios: SCENARIOS, runs: RUNS, window: WINDOW, model: m.model, commit: m.commit, date: m.date,
    csvName: CSV.split(/[\\/]/).pop(),
  }));
}

// ---- main ----------------------------------------------------------------------------
let armed = null;
let stopTraffic = null;
let interrupted = false;

async function cleanup(reason) {
  // Claim both synchronously, then await: a second cleanup (e.g. Ctrl+C during
  // an error exit) finds nothing left to do.
  const stop = stopTraffic;
  const fault = armed;
  stopTraffic = null;
  armed = null;
  if (stop) await stop();
  if (fault) {
    log(`${reason}: disarming ${fault} before exit...`);
    try { await setFault('none'); } catch (e) { log(`  DISARM FAILED: ${e.message} - disarm from the dashboard!`); }
  }
}
process.on('SIGINT', async () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  await cleanup('Interrupted');
  if (rows.length) writeSummary(meta);
  process.exit(130);
});

const meta = { date: new Date().toISOString(), commit: '', model: '' };

async function main() {
  await preflight();
  meta.commit = (await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO })).stdout.trim();
  mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(CSV)) writeFileSync(CSV, COLUMNS.join(',') + '\n');
  log(`scenarios: ${SCENARIOS.join(', ')} · ${RUNS} run(s) each · window ${WINDOW} (${windowSeconds(WINDOW)} s)`);
  log(`output: ${CSV}`);

  stopTraffic = startTraffic();
  log('built-in traffic started; waiting for a clean baseline...');
  const base = await waitFor(recovered, RECOVER_TIMEOUT_S, 'baseline');
  if (!base.ok) throw new Error(`system not healthy at start: ${base.detail}`);

  for (const scenario of SCENARIOS) {
    if (interrupted) break;
    const exp = EXPECTATIONS[scenario];
    log(`=== ${scenario} (expected: ${exp.origin ?? 'no incident'} / ${exp.category}) ===`);
    let visibleS = 0;
    if (scenario !== 'HEALTHY') {
      const t0 = Date.now();
      armed = scenario;
      await setFault(scenario);
      const vis = await waitFor(VISIBLE[scenario], VISIBLE_TIMEOUT_S, 'visible?');
      visibleS = (Date.now() - t0) / 1000;
      if (!vis.ok) {
        log(`  NOT VISIBLE after ${VISIBLE_TIMEOUT_S}s (${vis.detail}) - recording and moving on`);
        record({ timestamp: new Date().toISOString(), scenario, expected_origin: exp.origin, expected_category: exp.category, run: 0, correct: false, score: 0, error: 'not_visible', reasons: `fault not visible: ${vis.detail}`, time_to_visible_s: Math.round(visibleS) });
      } else {
        log(`  visible after ${Math.round(visibleS)} s (${vis.detail})`);
      }
      if (!vis.ok) { await disarmAndRecover(); continue; }
    }

    for (let run = 1; run <= RUNS && !interrupted; run++) {
      log(`  run ${run}/${RUNS}: asking Kira...`);
      const r = await investigate().catch((e) => ({ error: e.message, answer: null, summary: {}, seconds: NaN, toolCalls: 0 }));
      if (r.model) meta.model = r.model;
      const s = r.answer ? scoreAnswer(scenario, r.answer) : { correct: false, score: 0, reasons: [`no answer: ${r.error ?? 'unknown'}`], wrong_services: [] };
      const guard = /weak-signal guard/.test(r.answer ?? '') ? 'transient' : /no-incident guard/.test(r.answer ?? '') ? 'clean' : '';
      record({
        timestamp: new Date().toISOString(), scenario, expected_origin: exp.origin, expected_category: exp.category, run,
        correct: s.correct, score: s.score, origin_ok: s.origin_ok, category_ok: s.category_ok, category_found: s.category_found,
        category_fallback: s.category_fallback, evidence_ok: s.evidence_ok, blast_ok: s.blast_ok, wrong_services: s.wrong_services,
        time_to_diagnosis_s: Number.isFinite(r.seconds) ? Math.round(r.seconds) : null,
        time_to_visible_s: Math.round(visibleS), tool_calls: r.toolCalls, guard,
        partial: /Partial investigation|Investigation aborted/.test(r.answer ?? ''),
        all_three_signals: r.summary?.allThreeUsed ?? '', error: r.error ?? '',
        reasons: (s.reasons ?? []).join('; '), warnings: (s.warnings ?? []).join('; '), trace_file: r.summary?.file ? String(r.summary.file).split(/[\\/]/).pop() : '',
        answer_excerpt: String(r.answer ?? '').replace(/\s+/g, ' ').slice(0, 240),
      });
      log(`  run ${run}: ${s.correct ? 'CORRECT' : 'WRONG'} (${s.score}/4, ${Math.round(r.seconds)} s)${s.reasons?.length ? ' - ' + s.reasons.join('; ') : ''}`);
    }
    writeSummary(meta);
    if (scenario !== 'HEALTHY') await disarmAndRecover();
  }
}

async function disarmAndRecover() {
  log('  disarming...');
  await setFault('none');
  armed = null;
  log(`  waiting for full recovery (rollouts done, pods Ready, no 5xx / slowness in the last ${WINDOW})...`);
  const rec = await waitFor(recovered, RECOVER_TIMEOUT_S, 'recovery', 15);
  if (!rec.ok) throw new Error(`did not recover within ${RECOVER_TIMEOUT_S}s: ${rec.detail}`);
  log(`  recovered after ${Math.round(rec.seconds)} s`);
}

main()
  .then(async () => {
    await cleanup('Finished');
    writeSummary(meta);
    log(`done. Summary: ${MD}`);
  })
  .catch(async (err) => {
    log(`ERROR: ${err.message}`);
    await cleanup('Error');
    if (rows.length) writeSummary(meta);
    process.exit(1);
  });
