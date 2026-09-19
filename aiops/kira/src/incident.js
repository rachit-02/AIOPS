/**
 * Real incident control and history.
 *
 * WHY THE TOGGLE GOES THROUGH GIT AND NOT kubectl
 * A `kubectl set env` would flip the flag instantly, but the ArgoCD Application
 * runs with selfHeal: true - it reverts drift within about three minutes. The
 * incident would therefore resolve itself part-way through a demo, which is
 * both confusing and a worse story than the truth: in this system, causing an
 * incident is a reviewed commit, and the pipeline is what delivers it.
 *
 * The cost is latency (roughly 30-90s), which the dashboard turns into an
 * asset by lighting the pipeline stages as the change moves through them.
 *
 * WHY HISTORY COMES FROM `git log`
 * Every toggle is a commit touching this one file, so Git already IS the
 * incident log - with real timestamps, real authors and a real audit trail.
 * Keeping a separate in-memory list would be inventing a second source of
 * truth that could disagree with the first.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..');
const MANIFEST = 'infra/k8s/base/order/deployment.yaml';
const FLAG = 'SEED_BUG_NULL_SHIPPING';

const git = (args, opts = {}) => exec('git', args, { cwd: REPO_ROOT, maxBuffer: 4 << 20, ...opts });
const kubectl = (args) => exec('kubectl', ['--context', config.kubeContext, ...args], { maxBuffer: 4 << 20 });

/** What the cluster is ACTUALLY running right now - not what Git says. */
export async function liveIncidentState() {
  try {
    const { stdout } = await kubectl([
      '-n', config.namespace, 'get', 'deploy', 'order',
      '-o', `jsonpath={.spec.template.spec.containers[0].env[?(@.name=="${FLAG}")].value}`,
    ]);
    return stdout.trim() === 'true';
  } catch {
    return null; // cluster unreachable - distinct from "no incident"
  }
}

/** What Git says the desired state is. Divergence from live = a sync in flight. */
async function manifestState() {
  const text = await readFile(join(REPO_ROOT, MANIFEST), 'utf8');
  return /name:\s*SEED_BUG_NULL_SHIPPING\s*\n\s*value:\s*"true"/.test(text);
}

async function setManifest(enabled) {
  const path = join(REPO_ROOT, MANIFEST);
  const text = await readFile(path, 'utf8');
  const from = enabled ? '"false"' : '"true"';
  const to = enabled ? '"true"' : '"false"';
  const needle = `- name: ${FLAG}\n              value: ${from}`;
  if (!text.includes(needle)) return false; // already in the desired state
  await writeFile(path, text.replace(needle, `- name: ${FLAG}\n              value: ${to}`), 'utf8');
  return true;
}

/**
 * Toggle the incident, reporting progress as it moves through the pipeline.
 * @param {boolean} enabled
 * @param {(stage: string, detail: string) => void} onStage
 */
export async function setIncident(enabled, onStage = () => {}) {
  onStage('commit', enabled ? 'Enabling seeded fault in the manifest' : 'Reverting the seeded fault');

  const changed = await setManifest(enabled);
  if (changed) {
    await git(['add', MANIFEST]);
    await git([
      '-c', 'user.name=aiops-dashboard',
      '-c', 'user.email=dashboard@aiops.local',
      'commit', '-q', '-m',
      `chore(demo): ${enabled ? 'enable' : 'resolve'} seeded Order-service incident\n\n` +
        'Triggered from the dashboard. Causing and resolving a fault are both\n' +
        'reviewed commits here; ArgoCD delivers them from Git.',
    ]);
    onStage('push', 'Pushing to main');
    await git(['push', '-q', 'origin', 'HEAD:main']);
  } else {
    onStage('push', 'Manifest already in the target state');
  }

  // Nudge rather than wait out ArgoCD's ~3 minute poll interval.
  onStage('sync', 'Asking ArgoCD to sync');
  await kubectl([
    '-n', 'argocd', 'patch', 'app', 'aiops-dev', '--type', 'merge',
    '-p', '{"operation":{"sync":{"revision":"main"}}}',
  ]).catch(() => {});

  onStage('rollout', 'Waiting for the new pod');
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if ((await liveIncidentState()) === enabled) {
      onStage('done', enabled ? 'Incident live in the cluster' : 'Incident resolved');
      return true;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('ArgoCD did not roll the change out within 180s');
}

/**
 * Incident history, read from Git. Each commit touching the order manifest is
 * inspected for the flag's value at that commit, so the list is derived from
 * the repository rather than remembered by the server.
 */
export async function incidentHistory(limit = 25) {
  const { stdout } = await git([
    'log', `-${limit * 2}`, '--format=%H%x1f%aI%x1f%an%x1f%s', '--', MANIFEST,
  ]);
  const rows = stdout.trim() ? stdout.trim().split('\n') : [];

  const events = [];
  let previous = null;
  // git log is newest-first; walk oldest-first so a transition is detectable.
  for (const row of rows.reverse()) {
    const [sha, iso, author, subject] = row.split('\x1f');
    let enabled = null;
    try {
      const { stdout: blob } = await git(['show', `${sha}:${MANIFEST}`]);
      enabled = /name:\s*SEED_BUG_NULL_SHIPPING\s*\n\s*value:\s*"true"/.test(blob);
    } catch {
      continue;
    }
    // Only record TRANSITIONS. Commits that touched the file for unrelated
    // reasons (resource limits, securityContext) are not incidents.
    if (previous === null || enabled !== previous) {
      if (previous !== null) {
        events.push({
          sha: sha.slice(0, 7),
          at: iso,
          author,
          subject,
          type: enabled ? 'crit' : 'ok',
          text: enabled ? 'Order service degraded — seeded fault enabled' : 'Order service — resolved',
        });
      }
      previous = enabled;
    }
  }
  return events.reverse().slice(0, limit); // newest first
}
