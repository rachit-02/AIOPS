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

export default function Header({ system, theme, onToggleTheme, onOpenPalette, incidentBusy, faults = [], onChangeFault, stale }) {
  const overall = system?.overall;
  const armed = system?.incident?.fault ?? null;
  const [choice, setChoice] = useState('F1');

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

        {/* Fault controls, labelled for the FAULT, not the incident: the pill
            reports what the telemetry shows; these report what is ARMED.
            Arming commits infra/k8s/overlays/dev/fault.yaml to Git and ArgoCD
            applies it (no CI build). Arming a fault replaces any armed one. */}
        <div className="flex items-center gap-[6px]">
          {armed && (
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--signal-crit)' }} title={armed.summary}>
              armed: {armed.label}
            </span>
          )}
          <select
            className="btn mono"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            disabled={incidentBusy || !system || !faults.length}
            aria-label="Fault to arm"
            title="Seeded faults F1-F6 (infra/k8s/faults)"
          >
            {faults.map((f) => (
              <option key={f.id} value={f.id}>
                {f.id} · {f.service} · {f.name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-danger"
            onClick={() => onChangeFault(choice)}
            disabled={incidentBusy || !system || !faults.length || armed?.id === choice}
            title={faults.find((f) => f.id === choice)?.summary ?? ''}
          >
            {incidentBusy ? 'Working…' : armed ? `Switch to ${choice}` : `Arm ${choice}`}
          </button>
          <button
            className="btn"
            onClick={() => onChangeFault('none')}
            disabled={incidentBusy || !system || !armed}
            title="Disarm the armed fault. Commits to Git; ArgoCD rolls it out (30-90s)."
          >
            Disarm
          </button>
        </div>

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
