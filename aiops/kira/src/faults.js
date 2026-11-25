/**
 * Fault control: arm / disarm one of the seeded faults F1-F6, read which one is
 * live, and derive the incident history from Git.
 *
 * ONE LIVE FILE. infra/k8s/overlays/dev/fault.yaml is a kustomize patch that is
 * always present. Arming copies a template from infra/k8s/faults/ over it;
 * disarming copies none.yaml. Because only one file exists, arming a fault
 * always disarms the previous one, and only the target Deployment rolls.
 *
 * WHY GIT AND NOT kubectl: ArgoCD runs with selfHeal, so a kubectl change would
 * be reverted within minutes. Causing (and resolving) an incident is a commit;
 * ArgoCD delivers it. These are infra-only commits - no CI build.
 *
 * The namespace annotation `aiops.dev/active-fault` (set by every template) is
 * how the CLUSTER says which fault it is running, independent of Git.
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
export const LIVE_FILE = 'infra/k8s/overlays/dev/fault.yaml';
const CATALOGUE_DIR = 'infra/k8s/faults';
/** Before the catalogue existed, F1 was toggled in this file. Its history is kept. */
const LEGACY_F1_FILE = 'infra/k8s/base/order/deployment.yaml';

/** The catalogue. `category` is the vocabulary Kira's answers are scored against. */
export const FAULTS = [
  { id: 'F1', name: 'Code bug', service: 'order', category: 'code-bug', file: 'F1-order-code-bug.yaml',
    summary: 'order throws on an order without a shipping address (500s)' },
  { id: 'F2', name: 'Latency', service: 'product', category: 'latency', file: 'F2-product-latency.yaml',
    summary: 'product delays every request by 1200 ms (slow, no 5xx)' },
  { id: 'F3', name: 'Crash loop', service: 'user', category: 'crash-loop', file: 'F3-user-crash-loop.yaml',
    summary: 'user exits shortly after start (CrashLoopBackOff)' },
  { id: 'F4', name: 'Out of memory', service: 'auth', category: 'out-of-memory', file: 'F4-auth-oom.yaml',
    summary: 'auth leaks memory to a 128Mi limit (OOMKilled restarts)' },
  { id: 'F5', name: 'Bad config', service: 'orders', category: 'bad-config', file: 'F5-orders-bad-config.yaml',
    summary: 'orders points at a database host that does not exist' },
  { id: 'F6', name: 'Bad deploy', service: 'gateway', category: 'bad-deploy', file: 'F6-gateway-bad-deploy.yaml',
    summary: 'gateway image tag that does not exist (ImagePullBackOff)' },
];
export const faultById = (id) => FAULTS.find((f) => f.id === id) ?? null;
export const faultLabel = (id) => {
  const f = faultById(id);
  return f ? `${f.id} ${f.service} ${f.name.toLowerCase()}` : 'none';
};

const git = (args, opts = {}) => exec('git', args, { cwd: REPO_ROOT, maxBuffer: 8 << 20, ...opts });
const kubectl = (args) => exec('kubectl', ['--context', config.kubeContext, ...args], { maxBuffer: 4 << 20 });

/** The fault id an annotated YAML text declares ('none' if it declares none). */
export function faultIdInText(text) {
  const m = /aiops\.dev\/active-fault:\s*"?([A-Za-z0-9]+)"?/.exec(String(text));
  return m ? m[1] : 'none';
}

/** What the CLUSTER is running: 'none', 'F1'..'F6', or null if unreachable. */
export async function activeFaultInCluster() {
  try {
    const { stdout } = await kubectl([
      'get', 'namespace', config.namespace,
      '-o', 'jsonpath={.metadata.annotations.aiops\\.dev/active-fault}',
    ]);
    return stdout.trim() || 'none';
  } catch {
    return null;
  }
}

/** What Git (the working tree) says is armed. */
export async function activeFaultInGit() {
  try {
    return faultIdInText(await readFile(join(REPO_ROOT, LIVE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Push, rebasing onto whatever landed on main meanwhile (CI's tag bumps make a
 * stale clone routine). Never force. --autostash so unrelated local edits in
 * the working tree cannot block it.
 */
async function pushWithRebase(onStage) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await git(['push', '-q', 'origin', 'HEAD:main']);
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      onStage('push', `Remote moved on; rebasing and retrying (${attempt}/2)`);
      await git(['fetch', '-q', 'origin', 'main']);
      await git(['rebase', '-q', '--autostash', 'origin/main']).catch(async (rebaseErr) => {
        await git(['rebase', '--abort']).catch(() => {});
        throw rebaseErr;
      });
    }
  }
}

let busy = false;

/**
 * Arm `id` ('F1'..'F6') or disarm ('none'). Commits ONLY the live fault file
 * (pathspec commit, so nothing else staged can ride along), pushes, nudges
 * ArgoCD, and waits until the cluster's namespace annotation says `id`.
 * Pods may still be rolling when this returns; the caller decides how long to
 * wait for the fault to become visible.
 */
export function setFault(id, onStage = () => {}) {
  if (id !== 'none' && !faultById(id)) return Promise.reject(new Error(`unknown fault "${id}"`));
  if (busy) return Promise.reject(new Error('another fault change is already in progress'));
  // Taken and released synchronously around the async work: one change at a time.
  busy = true;
  return applyFault(id, onStage).finally(() => {
    busy = false;
  });
}

async function applyFault(id, onStage) {
  {
    const before = await activeFaultInGit();
    const template = id === 'none' ? 'none.yaml' : faultById(id).file;
    const text = await readFile(join(REPO_ROOT, CATALOGUE_DIR, template), 'utf8');

    onStage('commit', id === 'none' ? `Disarming ${faultLabel(before)}` : `Arming ${faultLabel(id)}`);
    const current = await readFile(join(REPO_ROOT, LIVE_FILE), 'utf8').catch(() => '');
    if (current !== text) {
      await writeFile(join(REPO_ROOT, LIVE_FILE), text, 'utf8');
      const subject = id === 'none'
        ? `chore(fault): disarm ${faultLabel(before)}`
        : `chore(fault): arm ${faultLabel(id)}${before && before !== 'none' ? ` (replaces ${before})` : ''}`;
      await git([
        '-c', 'user.name=aiops-dashboard', '-c', 'user.email=dashboard@aiops.local',
        'commit', '-q', '-m', subject, '-m',
        'Triggered from the dashboard / evaluation harness. Infra-only: ArgoCD\n' +
          'applies it from Git with no CI build. See infra/k8s/faults/README.md.',
        '--', LIVE_FILE,
      ]);
      onStage('push', 'Pushing to main');
      await pushWithRebase(onStage);
    } else {
      onStage('push', 'Fault file already in the target state');
    }

    // Nudge rather than wait out ArgoCD's ~3 minute poll interval.
    onStage('sync', 'Asking ArgoCD to sync');
    await kubectl([
      '-n', 'argocd', 'patch', 'app', 'aiops-dev', '--type', 'merge',
      '-p', '{"operation":{"sync":{"revision":"main"}}}',
    ]).catch(() => {});

    onStage('rollout', 'Waiting for the cluster to apply it');
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if ((await activeFaultInCluster()) === id) {
        onStage('done', id === 'none' ? 'Fault disarmed in the cluster' : `${faultLabel(id)} live in the cluster`);
        return true;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('ArgoCD did not apply the change within 180s');
  }
}

/**
 * Incident history from Git: transitions of the live fault file, plus the
 * legacy F1 toggles in the base order manifest from before the catalogue.
 * Newest first.
 */
export async function faultHistory(limit = 25) {
  const events = [];

  const transitions = async (file, readState) => {
    let rows;
    try {
      const { stdout } = await git(['log', `-${limit * 3}`, '--format=%H%x1f%aI%x1f%an%x1f%s', '--', file]);
      rows = stdout.trim() ? stdout.trim().split('\n') : [];
    } catch {
      return;
    }
    let previous = null;
    for (const row of rows.reverse()) {
      const [sha, iso, author, subject] = row.split('\x1f');
      let state;
      try {
        state = readState((await git(['show', `${sha}:${file}`])).stdout);
      } catch {
        continue;
      }
      if (previous !== null && state !== previous) {
        const armed = state !== 'none';
        const f = faultById(armed ? state : previous);
        events.push({
          sha: sha.slice(0, 7), at: iso, author, subject,
          fault: f?.id ?? null, service: f?.service ?? null, category: f?.category ?? null,
          type: armed ? 'crit' : 'ok',
          text: armed
            ? `${faultLabel(state)} — armed${f ? ` (${f.summary})` : ''}`
            : `${faultLabel(previous)} — disarmed`,
        });
      }
      previous = state;
    }
  };

  await transitions(LIVE_FILE, faultIdInText);
  await transitions(LEGACY_F1_FILE, (blob) =>
    /name:\s*SEED_BUG_NULL_SHIPPING\s*[\r\n]+\s*value:\s*"true"/.test(blob) ? 'F1' : 'none',
  );

  return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
