/**
 * SEEDED FAULT F2 - latency. Armed only by infra/k8s/faults/F2-product-latency.yaml
 * (SEED_PRODUCT_LATENCY_MS=1200); OFF by default.
 *
 * Adds a fixed delay to every product request. Below order's 3 s and the
 * gateway's 5 s upstream timeouts, so the symptom is latency (p50/p99), not 5xx.
 */

/** Probe and scrape paths are never delayed: a slow /health would turn latency into a crash loop. */
const OPS_PATHS = new Set(['/health', '/ready', '/metrics']);
/** Hard ceiling, so a typo cannot hang requests past every timeout. */
const MAX_MS = 4000;

/** Delay in ms from the environment; 0 (off) for unset, empty, "false", "0" or junk. */
export function latencyMsFromEnv(env = process.env) {
  const raw = String(env.SEED_PRODUCT_LATENCY_MS ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'false' || raw === '0') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n), MAX_MS);
}

/**
 * Express middleware that delays non-probe requests by `ms`, or null when the
 * fault is off - in which case nothing is installed at all.
 */
export function latencyMiddleware(ms, sleep = (t) => new Promise((r) => setTimeout(r, t))) {
  if (!ms) return null;
  return async (req, res, next) => {
    if (OPS_PATHS.has(req.path)) return next();
    await sleep(ms);
    next();
  };
}
