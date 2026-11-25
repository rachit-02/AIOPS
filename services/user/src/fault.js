/**
 * SEEDED FAULT F3 - crash loop. Armed only by infra/k8s/faults/F3-user-crash-loop.yaml
 * (SEED_CRASH_ON_START=true); OFF by default.
 *
 * The process exits shortly after starting, so Kubernetes restarts it with
 * growing back-off: CrashLoopBackOff. The rolling update keeps the previous
 * pod serving, so the fault is visible only in pod health.
 */

/** True only for an explicit "true" / "1". Unset, empty and "false" are off. */
export function crashOnStartFromEnv(env = process.env) {
  const v = String(env.SEED_CRASH_ON_START ?? '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

/**
 * Schedule the crash. Returns the timer, or null when the fault is off (in
 * which case nothing is scheduled). Logged at level "error" - not pino's
 * "fatal" - so an error-level log query finds it.
 */
export function scheduleCrash({ enabled, log, exit = (code) => process.exit(code), delayMs = 3000, setTimer = setTimeout }) {
  if (!enabled) return null;
  return setTimer(() => {
    log.error({ err: { message: 'startup check failed: SEED_CRASH_ON_START is set; exiting' } }, 'fatal_startup_error');
    exit(1);
  }, delayMs);
}
