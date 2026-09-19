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
import * as k8s from '@kubernetes/client-node';
import { config } from '../config.js';

let cached = null;
function clients() {
  if (cached) return cached;
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  // Pin the context explicitly. Without this, Kira would inspect whatever
  // cluster kubectl happens to point at - which in the best case is confusing
  // and in the worst case is someone else's cluster.
  if (config.kubeContext) kc.setCurrentContext(config.kubeContext);
  cached = {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
  };
  return cached;
}

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
  }));

  const pods = (unwrap(podsRes).items || []).map((p) => {
    const cs = p.status?.containerStatuses?.[0];
    const state = cs?.state || {};
    const stateName = Object.keys(state)[0] ?? 'unknown';
    return {
      name: p.metadata.name,
      phase: p.status?.phase,
      ready: cs?.ready ?? false,
      restarts: cs?.restartCount ?? 0,
      state: stateName,
      // Populated on CrashLoopBackOff / OOMKilled / ImagePullBackOff - the
      // difference between "waiting to be pulled" and "killed for memory".
      state_reason: state[stateName]?.reason ?? null,
      last_termination_reason: cs?.lastState?.terminated?.reason ?? null,
      started_at: p.status?.startTime ?? null,
      node: p.spec?.nodeName ?? null,
      image: cs?.image ?? null,
    };
  });

  const wanted = new Set(pods.map((p) => p.name));
  const events = (unwrap(eventsRes).items || [])
    .filter((e) => service === 'all' || wanted.has(e.involvedObject?.name))
    .map((e) => ({
      object: e.involvedObject?.name,
      reason: e.reason,
      message: String(e.message || '').slice(0, 250),
      count: e.count ?? 1,
      last_seen: e.lastTimestamp ?? e.eventTime ?? null,
    }))
    .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)))
    .slice(0, 15);

  const unhealthy = pods.filter((p) => !p.ready || p.restarts > 0);

  return {
    source: 'kubernetes_api',
    namespace: ns,
    deployments,
    pods,
    recent_warning_events: events,
    summary: {
      total_pods: pods.length,
      ready_pods: pods.filter((p) => p.ready).length,
      total_restarts: pods.reduce((n, p) => n + p.restarts, 0),
      unhealthy: unhealthy.map((p) => ({ name: p.name, state: p.state, reason: p.state_reason, restarts: p.restarts })),
      // Stated explicitly so the conclusion is unambiguous rather than left to
      // be inferred from an empty array.
      interpretation:
        unhealthy.length === 0
          ? 'All pods are Ready with no restarts. This RULES OUT crashes, OOM kills, image-pull ' +
            'failures and scheduling problems. A service returning errors while in this state is ' +
            'failing inside application code, not infrastructure.'
          : `${unhealthy.length} pod(s) unhealthy - infrastructure or startup fault is in play.`,
    },
  };
}
