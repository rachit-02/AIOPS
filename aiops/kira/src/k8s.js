/**
 * Shared, read-only Kubernetes access for the tools.
 *
 * Read-only by construction: only list calls are made, so Kira cannot mutate
 * the cluster even if she decided to try.
 */
import * as k8s from '@kubernetes/client-node';
import { config } from './config.js';

let cached = null;
export function clients() {
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

const unwrap = (r) => (r && typeof r === 'object' && 'body' in r ? r.body : r);

// ---------------------------------------------------------------------------
// ClusterIP -> Service name
//
// Proxy errors name an IP, not a service: "connect ETIMEDOUT 10.96.53.99:3000".
// A 7B model read that as "the database" (it was the `order` Service). The
// IPs are resolved to names before the model ever sees them.
// ---------------------------------------------------------------------------

const TTL_MS = 5 * 60 * 1000;
let ipCache = { at: 0, map: null };
let lister = null;

/** Test seam: replace how Services are listed. */
export function setServiceLister(fn) {
  lister = fn;
  ipCache = { at: 0, map: null };
}

async function listServices() {
  if (lister) return lister();
  const res = await clients().core.listServiceForAllNamespaces();
  return (unwrap(res).items || []).map((s) => ({
    namespace: s.metadata?.namespace,
    name: s.metadata?.name,
    clusterIP: s.spec?.clusterIP,
  }));
}

/** Build a fresh ClusterIP map. Throws if the Services cannot be listed. */
async function buildIpMap() {
  const map = new Map();
  for (const s of await listServices()) {
    if (!s.clusterIP || s.clusterIP === 'None') continue;
    // Services in Kira's own namespace by bare name; others qualified.
    map.set(s.clusterIP, s.namespace === config.namespace ? s.name : `${s.namespace}/${s.name}`);
  }
  return map;
}

/** Map of ClusterIP -> display name, cached for 5 minutes. Never throws. */
export function clusterIpMap() {
  const current = ipCache;
  if (current.map && Date.now() - current.at < TTL_MS) return Promise.resolve(current.map);
  return buildIpMap().then(
    (map) => {
      ipCache = { at: Date.now(), map };
      return map;
    },
    // Resolution is a nicety; a failed lookup must not fail the log query.
    () => current.map ?? new Map(),
  );
}

/**
 * Rewrite every known ClusterIP in `text` as "<service> (ClusterIP <ip>[:port])".
 * Unknown IPs are left exactly as they were.
 */
export function resolveClusterIps(text, map) {
  if (typeof text !== 'string' || !map?.size) return text;
  return text.replace(/\b(\d{1,3}(?:\.\d{1,3}){3})(:\d{1,5})?\b/g, (whole, ip, port = '') =>
    map.has(ip) ? `${map.get(ip)} (ClusterIP ${ip}${port})` : whole,
  );
}
