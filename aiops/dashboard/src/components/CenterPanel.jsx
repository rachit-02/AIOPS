import Sparkline from './Sparkline.jsx';
import Pipeline from './Pipeline.jsx';
import IncidentHistory from './IncidentHistory.jsx';

const STATUS_LABEL = { ok: 'healthy', warn: 'elevated', crit: 'degraded' };

function StatTile({ label, value, delta, deltaTone }) {
  return (
    <div className="px-4 py-[14px]" style={{ background: 'var(--bg-panel)' }}>
      <div className="font-semibold" style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
        {label}
      </div>
      <div className="mono mt-1 font-semibold" style={{ fontSize: 24 }}>
        {value}
      </div>
      <div
        className="mono mt-[3px]"
        style={{
          fontSize: 11.5,
          color:
            deltaTone === 'up'
              ? 'var(--signal-crit)'
              : deltaTone === 'down'
                ? 'var(--signal-ok)'
                : 'var(--text-faint)',
        }}
      >
        {delta}
      </div>
    </div>
  );
}

/**
 * Pod health grid. One square per real pod, not a fixed three.
 *
 * Scaled to the replica count that actually exists so the grid cannot imply
 * capacity the cluster does not have — these run at 1 replica each on a laptop,
 * and drawing three would be a lie about the deployment.
 */
function PodHealth({ pods }) {
  if (!pods.length) {
    return (
      <div className="mono" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
        No pods found for this service.
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-[6px]">
      {pods.map((p) => {
        const bad = !p.ready || p.restarts > 0;
        return (
          <div
            key={p.name}
            title={`${p.name}\n${p.ready ? 'Ready' : 'NOT ready'} · ${p.restarts} restarts · ${p.state}${p.node ? ` · ${p.node}` : ''}`}
            className="flex items-center justify-center"
            style={{
              width: 26,
              height: 26,
              borderRadius: 4,
              background: 'var(--bg-panel-raised)',
              border: '1px solid var(--border-strong)',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: bad ? 'var(--signal-crit)' : 'var(--signal-ok)',
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export default function CenterPanel({ svc, system, detail, history, pipelineStage }) {
  if (!svc) return null;

  const errText = `${svc.errorRatePercent.toFixed(svc.errorRatePercent >= 10 ? 1 : 2)}%`;
  const failing = svc.failingRoutes.filter((r) => String(r.status).startsWith('5')).slice(0, 4);
  const logs = detail?.logs;

  return (
    <div className="overflow-y-auto px-[22px] pt-5 pb-2" style={{ background: 'var(--bg-panel)' }}>
      <div className="mb-4 flex flex-wrap items-baseline gap-[10px]">
        <h2 className="m-0 font-bold" style={{ fontSize: 19 }}>
          {svc.name}
        </h2>
        <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>
          {svc.path}
        </span>
        <span
          className="mono font-semibold"
          style={{
            fontSize: 11,
            padding: '3px 8px',
            borderRadius: 20,
            border: `1px solid ${svc.status === 'ok' ? 'var(--border-strong)' : `var(--signal-${svc.status})`}`,
            color: svc.status === 'ok' ? 'var(--signal-ok)' : `var(--signal-${svc.status})`,
          }}
        >
          {STATUS_LABEL[svc.status]}
        </span>
        {/* Shown whenever the seeded fault is armed, even at a zero error
            rate - otherwise a "healthy" tag sits next to a "Resolve incident"
            button and the two appear to contradict each other. */}
        {svc.faultArmed && (
          <span
            className="mono font-semibold"
            title="The seeded fault is enabled on this service. It only produces errors when a request hits the failing path."
            style={{
              fontSize: 11,
              padding: '3px 8px',
              borderRadius: 20,
              border: '1px solid var(--signal-warn)',
              color: 'var(--signal-warn)',
            }}
          >
            fault armed
          </span>
        )}
        {svc.image && (
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {/* The tag IS the short git SHA that built it. */}
            {svc.image.split(':').pop()}
          </span>
        )}
      </div>

      {/* 1px gaps over a border-coloured background: true hairline dividers
          with no doubled borders where tiles meet. */}
      <div
        className="mb-4 grid grid-cols-3 overflow-hidden"
        style={{ gap: 1, background: 'var(--border)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
      >
        <StatTile
          label="Request rate"
          value={`${svc.requestsPerSecond.toFixed(2)}/s`}
          delta={svc.scrapeUp ? 'scraping' : 'target down'}
          deltaTone={svc.scrapeUp ? 'flat' : 'up'}
        />
        <StatTile
          label="p99 latency"
          value={svc.p99Ms == null ? '—' : `${svc.p99Ms}ms`}
          delta={svc.p95Ms == null ? 'no traffic in window' : `p95 ${svc.p95Ms}ms`}
          deltaTone="flat"
        />
        <StatTile
          label="Error rate"
          value={errText}
          delta={
            svc.errorRatePercent === 0
              ? 'no 5xx'
              : failing.length
                ? `${failing[0].route} → ${failing[0].status}`
                : 'elevated'
          }
          deltaTone={svc.errorRatePercent > 0 ? 'up' : 'flat'}
        />
      </div>

      <div className="panel-box">
        <h3>Latency p99, last {system.range}</h3>
        <div style={{ width: '100%' }}>
          <Sparkline
            values={svc.spark}
            width={620}
            height={130}
            status={svc.status}
            strokeWidth={2}
            fill
          />
        </div>
        {svc.spark.length < 2 && (
          <div className="mono mt-2" style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
            Not enough samples in this window. Run scripts/traffic.sh to generate load.
          </div>
        )}
      </div>

      {svc.errorSpark.length >= 2 && (
        <div className="panel-box">
          <h3>Error rate, last {system.range}</h3>
          <Sparkline
            values={svc.errorSpark}
            width={620}
            height={80}
            status={svc.errorRatePercent > 0 ? 'crit' : 'ok'}
            strokeWidth={2}
            fill
          />
        </div>
      )}

      <div className="panel-box">
        <h3>Pod health</h3>
        <PodHealth pods={svc.pods} />
        <div className="mono mt-[10px]" style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
          {svc.pods.filter((p) => p.ready).length}/{svc.pods.length} ready ·{' '}
          {svc.pods.reduce((n, p) => n + p.restarts, 0)} restarts
          {svc.status === 'crit' && svc.pods.every((p) => p.ready) && (
            <> — pods healthy, so this is application code, not infrastructure</>
          )}
        </div>
      </div>

      {logs && !logs.error && logs.total_matching_lines > 0 && (
        <div className="panel-box">
          <h3>Recent errors, from Loki</h3>
          {logs.messages.slice(0, 3).map((m, i) => (
            <div key={i} className="mono mb-2" style={{ fontSize: 12, lineHeight: 1.6 }}>
              <span style={{ color: m.has_stack_trace ? 'var(--signal-crit)' : 'var(--text-dim)' }}>
                ×{m.count}
              </span>{' '}
              <span style={{ color: 'var(--text-dim)' }}>[{m.event}]</span>{' '}
              <span>{m.message}</span>
              {m.example?.stack && (
                <div
                  className="mt-1 whitespace-pre-wrap pl-4"
                  style={{ fontSize: 11, color: 'var(--text-faint)' }}
                >
                  {m.example.stack.split('\n').slice(0, 2).join('\n')}
                </div>
              )}
            </div>
          ))}
          <div className="mono mt-1" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {logs.threw_exceptions
              ? `${logs.exception_count} exception(s) thrown here — this service is an origin`
              : 'No stack traces — this service observed failures but did not throw them'}
          </div>
        </div>
      )}

      <div className="panel-box">
        <h3>Pipeline</h3>
        <Pipeline activeStage={pipelineStage} />
      </div>

      <div className="panel-box">
        <h3>Incident history</h3>
        <IncidentHistory events={history} />
      </div>
    </div>
  );
}
