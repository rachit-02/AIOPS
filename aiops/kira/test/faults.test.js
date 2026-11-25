/**
 * Fault catalogue (F1-F6) and what Kira's tools and guards make of each kind
 * of fault. No live dependencies: stubbed Prometheus, scripted model.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FAULTS, faultIdInText, REPO_ROOT, LIVE_FILE } from '../src/faults.js';
import { podProblem } from '../src/tools/fetch_health.js';
import { run as fetchMetrics } from '../src/tools/fetch_metrics.js';
import { investigate, noIncidentEvidence, weakSignalEvidence } from '../src/agent.js';
import { stubPrometheus, restore } from './helpers/prometheus.js';

after(restore);

// ---- catalogue <-> templates ----------------------------------------------------

test('every catalogue entry has a template whose annotation and target match', () => {
  assert.deepEqual(FAULTS.map((f) => f.id), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6']);
  for (const f of FAULTS) {
    const path = join(REPO_ROOT, 'infra/k8s/faults', f.file);
    assert.ok(existsSync(path), f.file);
    const text = readFileSync(path, 'utf8');
    assert.equal(faultIdInText(text), f.id, `${f.file} annotation`);
    assert.match(text, new RegExp(`kind: Deployment\\s+metadata:\\s+name: ${f.service}\\s`), `${f.file} targets ${f.service}`);
  }
  assert.equal(faultIdInText(readFileSync(join(REPO_ROOT, 'infra/k8s/faults/none.yaml'), 'utf8')), 'none');
});

test('the committed live fault file is "none" (every fault defaults OFF)', () => {
  const live = readFileSync(join(REPO_ROOT, LIVE_FILE), 'utf8');
  assert.equal(faultIdInText(live), 'none');
  assert.doesNotMatch(live, /kind: Deployment/);
});

// ---- fetch_health labels -----------------------------------------------------------

test('podProblem names each pod-level fault from Kubernetes facts', () => {
  assert.match(podProblem({ ready: false, stateName: 'waiting', reason: 'CrashLoopBackOff', lastTerm: { exitCode: 1, reason: 'Error' }, recent: true }), /CrashLoopBackOff.*exit code 1/);
  assert.match(podProblem({ ready: false, stateName: 'waiting', reason: 'CrashLoopBackOff', lastTerm: { reason: 'OOMKilled', exitCode: 137 }, recent: true }), /^OOMKilled/);
  assert.match(podProblem({ ready: true, stateName: 'running', reason: null, lastTerm: { reason: 'OOMKilled', exitCode: 137 }, recent: true }), /^OOMKilled/);
  assert.match(podProblem({ ready: false, stateName: 'waiting', reason: 'ImagePullBackOff', lastTerm: null, recent: false }), /image cannot be pulled \(ImagePullBackOff\)/);
  assert.match(podProblem({ ready: false, stateName: 'running', reason: null, lastTerm: null, recent: false }), /NOT Ready \(readiness probe failing\)/);
  assert.equal(podProblem({ ready: true, stateName: 'running', reason: null, lastTerm: null, recent: false }), null);
});

// ---- fetch_metrics latency anomalies ---------------------------------------------

test('fetch_metrics flags slow services (no 5xx) as latency anomalies; normal bcrypt-bound auth is not one', async () => {
  stubPrometheus({
    jobs: ['frontend', 'gateway', 'product', 'auth'],
    latency: {
      product: { p50: 1.21, p95: 1.24, p99: 1.25 },
      gateway: { p50: 1.22, p95: 1.26, p99: 1.3 },
      frontend: { p50: 1.23, p95: 1.27, p99: 1.31 },
      auth: { p50: 0.375, p95: 0.9, p99: 1.03 },
    },
  });
  const r = await fetchMetrics({ service: 'all', time_range: '5m' });
  assert.deepEqual(r.summary.services_with_errors, []);
  assert.deepEqual(r.summary.latency_anomalies.map((x) => x.service).sort(), ['frontend', 'gateway', 'product']);
  assert.equal(r.summary.latency_anomalies.find((x) => x.service === 'product').p50_ms, 1210);
  assert.match(r.summary.latency_note, /DEEPEST slow service/);
});

// ---- guards and blast radius for non-5xx faults -----------------------------------

const CLEAN_HEALTH = { summary: { total_pods: 8, ready_pods: 8, recent_restarts: 0, unhealthy: [], rollouts_not_complete: [] } };
const NO_ERROR_LOGS = { service: 'all', level_filter: 'error', total_matching_lines: 0, exception_count: 0, messages: [] };

function scripted(responses) {
  return {
    provider: 'test', model: 'scripted', pricePerMTok: { input: 0, output: 0 },
    async chat() { return { text: '', toolCalls: [], usage: null, raw: null, ...responses.shift() }; },
  };
}
const ALL3 = [
  { id: 'm', name: 'fetch_metrics', args: { service: 'all', time_range: '5m' } },
  { id: 'l', name: 'fetch_logs', args: { service: 'all', level: 'error', time_range: '5m' } },
  { id: 'h', name: 'fetch_health', args: { service: 'all' } },
];

test('F2 latency: guards stay off, and zero-5xx slow services stay in the blast radius', async () => {
  const metrics = {
    services: [
      { service: 'product', scrape_up: true, error_rate_percent: 0, latency_seconds: { p50: 1.2 } },
      { service: 'gateway', scrape_up: true, error_rate_percent: 0, latency_seconds: { p50: 1.2 } },
      { service: 'orders', scrape_up: true, error_rate_percent: 0, latency_seconds: { p50: 0.003 } },
    ],
    summary: { services_with_errors: [], latency_anomalies: [{ service: 'product', p50_ms: 1200 }, { service: 'gateway', p50_ms: 1210 }] },
  };
  const ev = { metrics: [metrics], logs: [NO_ERROR_LOGS], health: [CLEAN_HEALTH] };
  assert.equal(noIncidentEvidence(ev), false);
  assert.equal(weakSignalEvidence(ev), null);

  const ANSWER = '### Root cause\n**Category:** latency\n`product` adds ~1.2 s.\n### Blast radius\n**Affected services:** product (origin), gateway, orders\n';
  const runTool = async (name) => (name === 'fetch_metrics' ? metrics : name === 'fetch_logs' ? NO_ERROR_LOGS : CLEAN_HEALTH);
  const { answer } = await investigate('slow?', { verbose: false, client: scripted([{ toolCalls: ALL3 }, { text: ANSWER }]), runTool });
  assert.doesNotMatch(answer, /No active incident/);
  assert.match(answer, /\*\*Affected services:\*\* product \(origin\), gateway\n/);
  assert.match(answer, /removed orders/);
});

test('F3 crash loop: a crashing new pod (old pod serving, no 5xx) vetoes both guards and stays in the blast radius', async () => {
  const health = { summary: {
    total_pods: 9, ready_pods: 8, recent_restarts: 1,
    unhealthy: [{ service: 'user', ready: false, reason: 'CrashLoopBackOff', problem: 'CrashLoopBackOff - process keeps exiting (exit code 1)' }],
    rollouts_not_complete: [{ deployment: 'user', desired: 1, updated: 1, available: 1 }],
  } };
  const metrics = {
    services: [{ service: 'user', scrape_up: true, error_rate_percent: 0 }, { service: 'gateway', scrape_up: true, error_rate_percent: 0 }],
    summary: { services_with_errors: [], latency_anomalies: [] },
  };
  const oneLine = {
    service: 'all', level_filter: 'error', total_matching_lines: 1, exception_count: 0,
    messages: [{ event: 'fatal_startup_error', message: 'startup check failed', count: 1, has_stack_trace: false }],
  };
  const ev = { metrics: [metrics], logs: [oneLine], health: [health] };
  assert.equal(noIncidentEvidence(ev), false);
  assert.equal(weakSignalEvidence(ev), null);

  const ANSWER = '### Root cause\n**Category:** crash-loop\n`user` keeps exiting.\n### Blast radius\n**Affected services:** user (origin), gateway\n';
  const runTool = async (name) => (name === 'fetch_metrics' ? metrics : name === 'fetch_logs' ? oneLine : health);
  const { answer } = await investigate('crash?', { verbose: false, client: scripted([{ toolCalls: ALL3 }, { text: ANSWER }]), runTool });
  assert.match(answer, /\*\*Affected services:\*\* user \(origin\)\n/, 'user kept, zero-error gateway removed');
});
