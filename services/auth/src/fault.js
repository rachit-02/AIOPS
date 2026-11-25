/**
 * SEEDED FAULT F4 - memory leak. Armed only by infra/k8s/faults/F4-auth-oom.yaml
 * (SEED_MEMORY_LEAK_MB_PER_S=2, plus a fault-only 128Mi memory limit); OFF by
 * default.
 *
 * After a start-up delay (so the pod becomes Ready and the rollout completes)
 * it allocates and RETAINS memory every second until the container hits its
 * cgroup limit and the kernel OOM-kills it. Only this container is killed; the
 * node is never at risk because the limit is far below node memory.
 * Deliberately silent: real leaks do not announce themselves in the logs.
 */

/** Hard ceiling on the leak rate, so a typo cannot allocate gigabytes per second. */
const MAX_MB_PER_S = 16;

/** MiB per second from the environment; 0 (off) for unset, empty, "false", "0" or junk. */
export function leakRateFromEnv(env = process.env) {
  const raw = String(env.SEED_MEMORY_LEAK_MB_PER_S ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'false' || raw === '0') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_MB_PER_S);
}

/**
 * Start the leak. Returns { held } (the retained buffers), or null when the
 * fault is off - in which case no timer is created at all.
 */
export function startLeak({ mbPerSec, delayMs = 20000, setTimer = setTimeout, setRepeat = setInterval }) {
  if (!mbPerSec) return null;
  const held = [];
  const bytes = Math.round(mbPerSec * 1024 * 1024);
  setTimer(() => {
    setRepeat(() => {
      // fill(1) touches every page, so the memory is really resident (RSS),
      // not just reserved.
      held.push(Buffer.alloc(bytes, 1));
    }, 1000);
  }, delayMs);
  return { held };
}
