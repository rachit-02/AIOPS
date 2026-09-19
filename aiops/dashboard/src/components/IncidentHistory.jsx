/**
 * Incident history, newest first.
 *
 * These are not UI events remembered in local state — they are read back from
 * `git log` on the order Deployment manifest. Every incident in this system is
 * caused and resolved by a commit, so Git already IS the incident log, with
 * real timestamps and a real author. Keeping a parallel in-memory list would
 * have created a second source of truth that could disagree with the first.
 *
 * That is also why each row carries its short SHA: every line here is
 * independently verifiable with `git show <sha>`.
 */
function when(iso) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const clock = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (mins < 1) return `${clock} · just now`;
  if (mins < 60) return `${clock} · ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${clock} · ${hrs}h ago`;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ` ${clock}`;
}

export default function IncidentHistory({ events }) {
  if (!events?.length) {
    return (
      <div className="mono" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
        No incidents recorded in this repository yet.
      </div>
    );
  }

  return (
    <div>
      {events.map((e) => (
        <div
          key={e.sha}
          className="mono flex items-start justify-between gap-[10px] py-[6px]"
          style={{ fontSize: 12, color: 'var(--text-dim)', borderBottom: '1px solid var(--border)' }}
        >
          <span className="min-w-0">
            <span style={{ color: e.type === 'crit' ? 'var(--signal-crit)' : 'var(--signal-ok)' }}>
              {e.text}
            </span>
            <span className="block" style={{ color: 'var(--text-faint)', fontSize: 11 }}>
              {e.sha} by {e.author}
            </span>
          </span>
          <span className="shrink-0 whitespace-nowrap" style={{ color: 'var(--text-faint)' }}>
            {when(e.at)}
          </span>
        </div>
      ))}
    </div>
  );
}
