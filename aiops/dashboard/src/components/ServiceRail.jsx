import Sparkline from './Sparkline.jsx';

/**
 * Left rail: all seven services at once, always visible.
 *
 * The point of the rail is peripheral vision — you should be able to see that
 * something is wrong without reading anything. Hence a status dot (position +
 * colour), a latency sparkline (shape), and the p99 number (text): three
 * encodings of the same state, so it survives both a glance and colour-blindness.
 */
const DOT = {
  ok: 'var(--signal-ok)',
  warn: 'var(--signal-warn)',
  crit: 'var(--signal-crit)',
};

export default function ServiceRail({ services, selected, onSelect }) {
  return (
    <nav
      className="overflow-y-auto px-[10px] py-4"
      style={{ background: 'var(--bg-panel)' }}
      aria-label="Services"
    >
      <div
        className="px-2 pb-[10px] font-semibold uppercase"
        style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--text-faint)' }}
      >
        Services
      </div>

      {services.map((svc) => {
        const active = svc.id === selected;
        return (
          <button
            key={svc.id}
            onClick={() => onSelect(svc.id)}
            aria-current={active ? 'true' : undefined}
            className="mb-[2px] flex w-full cursor-pointer items-center gap-[9px] px-2 py-[9px] text-left"
            style={{
              borderRadius: 'var(--radius)',
              border: `1px solid ${active ? 'var(--border-strong)' : 'transparent'}`,
              background: active ? 'var(--bg-panel-raised)' : 'transparent',
              color: 'var(--text)',
            }}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.background = 'var(--bg-panel-raised)';
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.background = 'transparent';
            }}
          >
            <span
              className="shrink-0 rounded-full"
              style={{ width: 8, height: 8, background: DOT[svc.status] ?? DOT.ok }}
            />
            <span className="min-w-0 flex-1">
              <span className="block font-semibold" style={{ fontSize: 13 }}>
                {svc.name}
              </span>
              <span
                className="mono block"
                style={{ fontSize: 11, color: 'var(--text-faint)' }}
                title={svc.scrapeUp ? undefined : 'Prometheus is not currently scraping this service'}
              >
                {svc.p99Ms == null ? 'no traffic' : `${svc.p99Ms}ms p99`}
              </span>
            </span>
            <span className="shrink-0">
              <Sparkline values={svc.spark} status={svc.status} width={46} height={20} />
            </span>
          </button>
        );
      })}
    </nav>
  );
}
