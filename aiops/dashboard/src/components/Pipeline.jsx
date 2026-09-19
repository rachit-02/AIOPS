/**
 * The five delivery stages.
 *
 * Numbered 01-05 — the one place in this UI where numbering is legitimate,
 * because these genuinely ARE an ordered sequence: a change cannot reach the
 * cluster without passing through each in turn.
 *
 * This is not decoration. When the incident button is pressed, the toggle runs
 * through Git and ArgoCD rather than kubectl (so ArgoCD's selfHeal cannot
 * silently revert it mid-demo), which takes 30-90 seconds. The server streams
 * its real progress, and these nodes light up as each stage actually completes
 * — turning the unavoidable wait into the clearest explanation of how the
 * system works.
 */
const STAGES = [
  { key: 'local', label: 'Local', hint: 'Manifest edited in the working tree' },
  { key: 'commit', label: 'Commit', hint: 'Change committed to Git' },
  { key: 'push', label: 'Push', hint: 'Pushed to main on GitHub' },
  { key: 'sync', label: 'ArgoCD', hint: 'ArgoCD pulls and syncs the cluster' },
  { key: 'rollout', label: 'Rollout', hint: 'New pod running the change' },
];

const ORDER = ['local', 'commit', 'push', 'sync', 'rollout', 'done'];

export default function Pipeline({ activeStage }) {
  // Stages light ONLY while a change is actually moving through them.
  //
  // An earlier version also lit the whole chain whenever an incident was live,
  // on the reasoning that the change had traversed it. In practice that left
  // five amber nodes glowing permanently, which drains the colour of meaning —
  // the brief is explicit that amber should be earned, not ambient. Amber here
  // now means "this is happening right now".
  const activeIdx = activeStage ? ORDER.indexOf(activeStage) : -1;
  const litThrough = activeStage ? activeIdx : -1;

  return (
    <div className="flex items-center overflow-x-auto pt-1 pb-[2px]">
      {STAGES.map((s, i) => {
        const lit = i <= litThrough;
        const current = activeStage && ORDER[activeIdx] === s.key;
        return (
          <div key={s.key} className="flex shrink-0 items-center">
            <div
              title={s.hint}
              className="flex items-center gap-2 whitespace-nowrap font-semibold"
              style={{
                fontSize: 12,
                padding: '8px 12px',
                borderRadius: 20,
                border: `1px solid ${lit ? 'var(--signal-warn)' : 'var(--border-strong)'}`,
                color: lit ? 'var(--text)' : 'var(--text-dim)',
              }}
            >
              <span
                className="mono flex items-center justify-center"
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  fontSize: 10.5,
                  background: lit ? 'var(--signal-warn)' : 'var(--bg-panel-raised)',
                  color: lit ? '#10141C' : 'var(--text-faint)',
                }}
              >
                {i + 1}
              </span>
              {s.label}
              {current && <span className="cursor" aria-hidden="true" />}
            </div>
            {i < STAGES.length - 1 && (
              <div
                className="shrink-0"
                style={{
                  width: 26,
                  height: 1,
                  background: i < litThrough ? 'var(--signal-warn)' : 'var(--border-strong)',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
