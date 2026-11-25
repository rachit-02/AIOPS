/**
 * Legacy single-fault API, kept as a thin wrapper over src/faults.js.
 *
 * Before the fault catalogue, the seeded Order bug (now fault F1) was toggled
 * by editing SEED_BUG_NULL_SHIPPING in infra/k8s/base/order/deployment.yaml.
 * It is now armed like every other fault, through the one live fault file
 * (infra/k8s/overlays/dev/fault.yaml). The base value stays "false"; editing
 * it directly would bypass the catalogue and the "one fault at a time" rule.
 *
 * flagPattern is kept because the history of the base file is still read
 * (faults.js, legacy F1 events) and its CRLF-tolerance has a regression test.
 */
import { setFault, activeFaultInCluster, faultHistory, REPO_ROOT } from './faults.js';

export { REPO_ROOT };

const FLAG = 'SEED_BUG_NULL_SHIPPING';

/**
 * Matches the flag with a given value. MUST tolerate CRLF: on Windows the
 * working tree is checked out with \r\n, and a literal "\n" needle failed
 * silently the first time this ran for real.
 */
export const flagPattern = (value) =>
  new RegExp(`(name:\\s*${FLAG}\\s*[\\r\\n]+\\s*value:\\s*)"${value}"`);

/** True if ANY fault is armed in the cluster, null if the cluster is unreachable. */
export async function liveIncidentState() {
  const active = await activeFaultInCluster();
  return active === null ? null : active !== 'none';
}

/** enabled -> arm F1 (the original Order bug); otherwise disarm whatever is armed. */
export const setIncident = (enabled, onStage) => setFault(enabled ? 'F1' : 'none', onStage);

export const incidentHistory = faultHistory;
