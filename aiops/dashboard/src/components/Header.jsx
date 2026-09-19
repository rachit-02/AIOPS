import { useEffect, useState } from 'react';

/**
 * Persistent top strip: whole-system state at a glance, plus the controls that
 * change it. It never scrolls away, because the one question this UI must
 * always answer without interaction is "is anything wrong right now".
 */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="mono text-right" style={{ fontSize: 12, color: 'var(--text-dim)', minWidth: 78 }}>
      {now.toLocaleTimeString('en-GB')}
    </div>
  );
}

export default function Header({ system, theme, onToggleTheme, onOpenPalette, incidentBusy, onToggleIncident, stale }) {
  const overall = system?.overall;
  const incidentActive = system?.incident?.active;

  return (
    <header
      className="flex flex-wrap items-center justify-between gap-4 px-[22px] py-[14px]"
      style={{ background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-[11px]">
        {/* A ring, not a logo: an instrument bezel. */}
        <div
          className="relative shrink-0 rounded-full"
          style={{
            width: 26,
            height: 26,
            background: 'radial-gradient(circle at 35% 30%, var(--signal-ok), #1a6f7d 70%)',
          }}
          aria-hidden="true"
        >
          <span
            className="absolute rounded-full"
            style={{ inset: 7, background: 'var(--bg-panel)' }}
          />
        </div>
        <div>
          <h1 className="m-0 font-bold" style={{ fontSize: 16, letterSpacing: '0.2px' }}>
            AIOps — Three Signals
          </h1>
          <p className="m-0 mt-[1px] font-medium" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            Metrics, logs, and pod health, watched together, correlated by Kira.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Clock />

        <div
          className={`status-pill ${overall?.status === 'crit' ? 'crit' : overall?.status === 'warn' ? 'warn' : ''}`}
          role="status"
        >
          <span className="dot" />
          <span>{stale ? 'Backend unreachable' : (overall?.text ?? 'Loading…')}</span>
        </div>

        <button
          className="btn btn-danger"
          onClick={() => onToggleIncident(!incidentActive)}
          disabled={incidentBusy || !system}
          title="Commits the change to Git and lets ArgoCD roll it out — takes 30-90s"
        >
          {incidentBusy
            ? 'Working…'
            : incidentActive
              ? 'Resolve incident'
              : 'Trigger incident — Order service'}
        </button>

        <button className="btn mono" onClick={onOpenPalette} title="Command palette (Ctrl/Cmd+K)">
          ⌘K
        </button>

        <button
          className="btn btn-icon"
          onClick={onToggleTheme}
          title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
          aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
        >
          {theme === 'light' ? '☾' : '☀'}
        </button>
      </div>
    </header>
  );
}
