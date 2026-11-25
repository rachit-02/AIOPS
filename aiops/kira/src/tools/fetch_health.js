/**
 * TOOL 3 of 3 — fetch_health
 * Source: the Kubernetes API (independent of Prometheus and of Loki).
 *
 * SCOPE: this tool answers "is the process alive, scheduled and stable". It
 * reads the cluster's own view of its workloads - no metrics, no logs.
 *
 * WHY IT MATTERS EVEN WHEN IT SAYS "FINE":
 * This is the signal that rules things OUT. Healthy pods with zero restarts
 * eliminate crashes, OOM kills, image-pull failures and scheduling problems in
 * one step, which is what lets a diagnosis move confidently to the code path.
 * A tool that only ever confirms bad news would not be worth calling.
 *
 * Read-only by construction: this module imports no write methods from the
 * client, so Kira cannot mutate the cluster even if she decided to try.
 */
import { config } from '../config.js';
// Shared, context-pinned, read-only client (also used by fetch_logs to
// resolve ClusterIPs to Service names).
import { clients } from '../k8s.js';

export const definition = {
  name: 'fetch_health',
  description:
    'Query the Kubernetes API for a service\'s pod status: ready/desired replicas, ' +
    'restart counts, pod phase, container state (including CrashLoopBackOff or OOMKilled), ' +
    'and recent warning events. Use this to determine whether a failure is infrastructural ' +
    '(crashing, evicted, unschedulable, image pull failure) or whether the process is ' +
    'healthy and the fault lies in application code. Healthy pods are a meaningful finding, ' +
    'not a dead end - they rule out an entire class of causes.',
  input_schema: {
    type: 'object',
    properties: {
      service: {
        type: 'string',
        description:
          'Service name (frontend, gateway, auth, product, order, orders, user), ' +
          'or "all" for every workload in the namespace.',
      },
    },
    required: ['service'],
    additionalProperties: false,
  },
};

/** A restart newer than this counts as current; older ones are history. */
export const RECENT_RESTART_MS = 10 * 60 * 1000;

/** Warning events older than this are history, not evidence. */
const RECENT_EVENT_MS = 15 * 60 * 1000;

/**
 * One plain-language label per unhealthy pod, from the Kubernetes facts only.
 * Exported for tests.
 */
export function podProblem({ ready, stateName, reason, lastTerm, recent }) {
  if (reason === 'ErrImagePull' || reason === 'ImagePullBackOff' || reason === 'InvalidImageName') {
    return `image cannot be pulled (${reason})`;
  }
  if (lastTerm?.reason === 'OOMKilled' && recent) {
    return `OOMKilled - exceeded its memory limit${reason === 'CrashLoopBackOff' ? ', now in CrashLoopBackOff' : ''}`;
  }
  if (reason === 'CrashLoopBackOff') {
    return `CrashLoopBackOff - process keeps exiting${lastTerm?.exitCode != null ? ` (exit code ${lastTerm.exitCode})` : ''}`;
  }
  if (recent && lastTerm) return `restarted recently (last exit: ${lastTerm.reason ?? 'unknown'}, code ${lastTerm.exitCode ?? '?'})`;
  if (!ready && stateName === 'running') return 'running but NOT Ready (readiness probe failing)';
  if (!ready) return `not Ready (${reason ?? stateName})`;
  return null;
}

const unwrap = (r) => (r && typeof r === 'object' && 'body' in r ? r.body : r);

export async function run({ service }) {
  if (service !== 'all' && !config.services.includes(service)) {
    throw new Error(`unknown service "${service}". Known: ${config.services.join(', ')}, or "all"`);
  }
  const { core, apps } = clients();
  const ns = config.namespace;
  const selector = service === 'all' ? undefined : `app.kubernetes.io/name=${service}`;

  const [depsRes, podsRes, eventsRes] = await Promise.all([
    apps.listNamespacedDeployment({ namespace: ns, labelSelector: selector }),
    core.listNamespacedPod({ namespace: ns, labelSelector: selector }),
    core.listNamespacedEvent({ namespace: ns, fieldSelector: 'type=Warning' }),
  ]);

  const deployments = (unwrap(depsRes).items || []).map((d) => ({
    name: d.metadata.name,
    desired: d.spec.replicas ?? 0,
    ready: d.status?.readyReplicas ?? 0,
    available: d.status?.availableReplicas ?? 0,
    updated: d.status?.updatedReplicas ?? 0,
    // The running image tag. This is how a diagnosis gets tied to a specific
    // commit: the tag IS the short git SHA that produced it.
    image: d.spec?.template?.spec?.containers?.[0]?.image ?? null,
    // A rollout that has not finished (e.g. a new pod that cannot start while
    // the old one keeps serving) is a fault even when every SERVING pod is fine.
    rollout_complete:
      (d.status?.updatedReplicas ?? 0) === (d.spec.replicas ?? 0) &&
      (d.status?.availableReplicas ?? 0) === (d.spec.replicas ?? 0) &&
      (d.status?.unavailableReplicas ?? 0) === 0,
    strategy: d.spec?.strategy?.type ?? null,
  }));

  const now = Date.now();
  const pods = (unwrap(podsRes).items || []).map((p) => {
    const cs = p.status?.containerStatuses?.[0];
    const state = cs?.state || {};
    const stateName = Object.keys(state)[0] ?? 'unknown';
    // When the previous container instance ended. restartCount is lifetime and
    // never resets, so 8 restarts from last night's laptop reboot look exactly
    // like 8 crashes a minute ago. The timestamp is what tells them apart.
    const lastEnded = cs?.lastState?.terminated?.finishedAt ?? null;
    const lastEndedMs = lastEnded ? new Date(lastEnded).getTime() : NaN;
    const lastTerm = cs?.lastState?.terminated ?? null;
    const reason = state[stateName]?.reason ?? null;
    return {
      name: p.metadata.name,
      // The Deployment this pod belongs to - "orders-7b6d..." is NOT "order".
      service: p.metadata?.labels?.['app.kubernetes.io/name'] ?? null,
      phase: p.status?.phase,
      ready: cs?.ready ?? false,
      restarts: cs?.restartCount ?? 0,
      last_restart_at: Number.isFinite(lastEndedMs) ? new Date(lastEndedMs).toISOString() : null,
      restarted_recently: Number.isFinite(lastEndedMs) && now - lastEndedMs < RECENT_RESTART_MS,
      state: stateName,
      // Populated on CrashLoopBackOff / OOMKilled / ImagePullBackOff - the
      // difference between "waiting to be pulled" and "killed for memory".
      state_reason: reason,
      // e.g. the registry's "not found" for ErrImagePull, or the back-off text.
      state_message: state[stateName]?.message ? String(state[stateName].message).slice(0, 240) : null,
      last_termination_reason: lastTerm?.reason ?? null,
      last_termination: lastTerm
        ? { reason: lastTerm.reason ?? null, exit_code: lastTerm.exitCode ?? null, finished_at: lastEnded ? new Date(lastEndedMs).toISOString() : null }
        : null,
      problem: podProblem({ ready: cs?.ready ?? false, stateName, reason, lastTerm, recent: Number.isFinite(lastEndedMs) && now - lastEndedMs < RECENT_RESTART_MS }),
      started_at: p.status?.startTime ?? null,
      node: p.spec?.nodeName ?? null,
      image: cs?.image ?? null,
    };
  });

  const wanted = new Set(pods.map((p) => p.name));
  const events = (unwrap(eventsRes).items || [])
    .filter((e) => service === 'all' || wanted.has(e.involvedObject?.name))
    // Only RECENT events. Old BackOff events from a laptop reboot hours ago
    // are history, exactly like lifetime restart counts.
    .filter((e) => {
      const t = Date.parse(e.lastTimestamp ?? e.eventTime ?? '');
      return !Number.isFinite(t) || now - t < RECENT_EVENT_MS;
    })
    .map((e) => ({
      object: e.involvedObject?.name,
      reason: e.reason,
      message: String(e.message || '').slice(0, 250),
      count: e.count ?? 1,
      last_seen: e.lastTimestamp ?? e.eventTime ?? null,
    }))
    .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)))
    .slice(0, 15);

  // Unhealthy = not Ready now, or restarted within the recent window. Old
  // restarts (a node or Docker Desktop restart hours ago) are history, not a
  // current infrastructure fault, and must not steer a diagnosis away from code.
  const unhealthy = pods.filter((p) => !p.ready || p.restarted_recently);
  const totalRestarts = pods.reduce((n, p) => n + p.restarts, 0);
  const stuck = deployments.filter((d) => !d.rollout_complete);

  return {
    source: 'kubernetes_api',
    namespace: ns,
    deployments,
    pods,
    recent_warning_events: events,
    summary: {
      total_pods: pods.length,
      ready_pods: pods.filter((p) => p.ready).length,
      total_restarts: totalRestarts,
      recent_restarts: pods.filter((p) => p.restarted_recently).length,
      unhealthy: unhealthy.map((p) => ({
        name: p.name, service: p.service, ready: p.ready, state: p.state, reason: p.state_reason,
        message: p.state_message, last_termination: p.last_termination,
        restarts: p.restarts, last_restart_at: p.last_restart_at, problem: p.problem,
      })),
      rollouts_not_complete: stuck.map((d) => ({ deployment: d.name, desired: d.desired, updated: d.updated, available: d.available, image: d.image })),
      // Stated explicitly so the conclusion is unambiguous rather than left to
      // be inferred from an empty array.
      interpretation:
        unhealthy.length === 0
          ? `All pods are Ready with no restarts in the last ${RECENT_RESTART_MS / 60000} minutes` +
            (totalRestarts > 0
              ? ` (the ${totalRestarts} lifetime restart(s) are older, e.g. from a node or Docker restart, and are not a current fault)`
              : '') +
            '. This RULES OUT crashes, OOM kills, image-pull failures and scheduling problems. A ' +
            'service returning errors while in this state is failing inside application code, not infrastructure.'
          : `${unhealthy.length} pod(s) not Ready or restarted in the last ${RECENT_RESTART_MS / 60000} minutes: ` +
            unhealthy.map((p) => `${p.service ?? p.name} - ${p.problem}`).join('; ') +
            '. Infrastructure or startup fault is in play. A pod that cannot start while an older pod of ' +
            'the same Deployment keeps serving means users may see nothing, but the fault is real.',
    },
  };
}
