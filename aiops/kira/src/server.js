#!/usr/bin/env node
/**
 * Dashboard API.
 *
 * The browser cannot talk to Kira's data sources directly: Prometheus and Loki
 * do not send CORS headers for cross-origin XHR, and the Kubernetes API needs a
 * kubeconfig credential that must never reach a browser. So the dashboard gets
 * a thin server that REUSES Kira's existing three tools rather than
 * reimplementing the queries — one definition of "what the error rate is",
 * shared by the agent and the UI.
 *
 *   npm run server          # http://localhost:7777
 */
import express from 'express';
import { config } from './config.js';
import { runTool } from './tools/index.js';
import { latencySeries, errorRateSeries } from './dashboard-queries.js';
import { investigate } from './agent.js';
import { liveIncidentState, incidentHistory, setIncident } from './incident.js';

const PORT = Number(process.env.KIRA_API_PORT) || 7777;

// The seeded fault lives in the order service specifically (see the SEEDED BUG
// banner in services/order/src/index.js). Named here so the UI can show WHICH
// service is armed rather than implying the whole system is.
const SEEDED_FAULT_SERVICE = 'order';

// Display metadata only. Every STATUS below is derived from live telemetry;
// nothing here is a hardcoded health value.
const SERVICE_META = {
  frontend: { name: 'Frontend', path: '/' },
  gateway: { name: 'Gateway', path: '/api' },
  auth: { name: 'Auth', path: '/auth' },
  product: { name: 'Product', path: '/products' },
  order: { name: 'Order', path: '/orders (write)' },
  orders: { name: 'Orders', path: '/orders (read)' },
  user: { name: 'User', path: '/users' },
};

const app = express();
app.use(express.json());

/** Server-Sent Events: a long-lived stream of progress for slow operations. */
function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Proxies and Node both buffer small writes; without this the browser can
    // see nothing until the response ends, defeating the point of streaming.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  return {
    send: (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    end: () => res.end(),
  };
}

const asyncRoute = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  });

/**
 * Status is DERIVED, never asserted:
 *   crit — a pod is not ready, or the 5xx rate is clearly elevated
 *   warn — some 5xx, but low; typically a service propagating someone else's
 *   ok   — no server errors
 * 4xx deliberately does not count: a 400 for a malformed request is the
 * service working correctly, not a fault.
 */
function deriveStatus({ errorRatePercent, podsReady, podsTotal }) {
  if (podsTotal > 0 && podsReady < podsTotal) return 'crit';
  if (errorRatePercent >= 5) return 'crit';
  if (errorRatePercent > 0.5) return 'warn';
  return 'ok';
}

app.get(
  '/api/system',
  asyncRoute(async (req, res) => {
    const range = String(req.query.range || '15m');

    const [metrics, health, latency, errRate, incidentActive] = await Promise.all([
      runTool('fetch_metrics', { service: 'all', time_range: range }),
      runTool('fetch_health', { service: 'all' }),
      latencySeries(range).catch(() => ({})),
      errorRateSeries(range).catch(() => ({})),
      liveIncidentState(),
    ]);

    const podsByService = {};
    for (const pod of health.pods) {
      // Pod names are <deployment>-<replicaset>-<suffix>. Match on the LONGEST
      // known service name that prefixes the pod, so "orders-abc" is not
      // attributed to "order". They are different services and the entire
      // origin-vs-collateral story turns on not confusing them.
      const owner = Object.keys(SERVICE_META)
        .filter((s) => pod.name.startsWith(`${s}-`))
        .sort((a, b) => b.length - a.length)[0];
      if (!owner) continue;
      (podsByService[owner] ??= []).push(pod);
    }

    const services = Object.entries(SERVICE_META).map(([id, meta]) => {
      const m = metrics.services.find((s) => s.service === id);
      const pods = podsByService[id] ?? [];
      const errorRatePercent = m?.error_rate_percent ?? 0;
      const spark = latency[id] ?? [];

      // The instant quantile and the range query use different rate windows, so
      // on a quiet service the instant one can be NaN while the series still
      // has points. Falling back to the last sample keeps the rail from saying
      // "no traffic" next to a sparkline that is visibly drawing traffic.
      const p99Ms =
        m?.latency_seconds?.p99 != null ? Math.round(m.latency_seconds.p99 * 1000) : (spark.at(-1) ?? null);
      return {
        id,
        ...meta,
        status: deriveStatus({
          errorRatePercent,
          podsReady: pods.filter((p) => p.ready).length,
          podsTotal: pods.length,
        }),
        errorRatePercent,
        requestsPerSecond: m?.requests_per_second ?? 0,
        p99Ms,
        p95Ms: m?.latency_seconds?.p95 != null ? Math.round(m.latency_seconds.p95 * 1000) : null,
        scrapeUp: m?.scrape_up ?? false,
        spark,
        errorSpark: errRate[id] ?? [],
        pods: pods.map((p) => ({
          name: p.name,
          ready: p.ready,
          restarts: p.restarts,
          state: p.state,
          node: p.node,
        })),
        failingRoutes: m?.failing_routes ?? [],
        // Armed != failing. The fault can be armed while the error rate is
        // zero simply because nothing is exercising the failing path.
        faultArmed: id === SEEDED_FAULT_SERVICE && incidentActive === true,
        // The running image tag is the short git SHA that produced it, which
        // is how a diagnosis ties back to a specific commit.
        image: health.deployments.find((d) => d.name === id)?.image ?? null,
      };
    });

    const critical = services.filter((s) => s.status === 'crit');
    const elevated = services.filter((s) => s.status === 'warn');

    // TWO DIFFERENT QUESTIONS, and the UI must not blur them:
    //   "is the seeded fault ARMED?"    -> incidentActive, the env var on the pod
    //   "are errors FLOWING right now?" -> derived from the error rate
    //
    // They legitimately disagree whenever the fault is armed but nothing is
    // exercising the failing path - no traffic means no 5xx means a healthy
    // error rate. Reporting that as a flat "All systems normal" next to a
    // "Resolve incident" button reads as a contradiction, so the armed-but-
    // quiet case gets its own wording and its own colour.
    const overall = (() => {
      if (critical.length) {
        return {
          status: 'crit',
          text: `${critical.length} active incident${critical.length > 1 ? 's' : ''} — ${critical.map((s) => s.name).join(', ')}`,
        };
      }
      if (elevated.length) {
        return { status: 'warn', text: `Elevated errors — ${elevated.map((s) => s.name).join(', ')}` };
      }
      if (incidentActive) {
        return { status: 'warn', text: `Fault armed on Order — no errors in the last ${range}` };
      }
      return { status: 'ok', text: 'All systems normal' };
    })();

    res.json({
      at: new Date().toISOString(),
      range,
      namespace: config.namespace,
      overall,
      incident: { active: incidentActive },
      totalRestarts: health.summary.total_restarts,
      podsReady: health.summary.ready_pods,
      podsTotal: health.summary.total_pods,
      services,
      provider: {
        name: config.provider,
        model: config.provider === 'ollama' ? config.ollamaModel : config.anthropicModel,
        label:
          config.provider === 'ollama'
            ? `${config.ollamaModel} (local)`
            : `${config.anthropicModel} (api)`,
      },
    });
  }),
);

app.get(
  '/api/service/:id',
  asyncRoute(async (req, res) => {
    const id = req.params.id;
    if (!SERVICE_META[id]) return res.status(404).json({ error: `unknown service "${id}"` });
    const range = String(req.query.range || '15m');
    const logs = await runTool('fetch_logs', { service: id, time_range: range, level: 'error' }).catch(
      (e) => ({ error: e.message }),
    );
    res.json({ id, range, logs });
  }),
);

app.get(
  '/api/incident',
  asyncRoute(async (req, res) => {
    res.json({ active: await liveIncidentState() });
  }),
);

app.get(
  '/api/incident/history',
  asyncRoute(async (req, res) => {
    res.json({ events: await incidentHistory(25) });
  }),
);

/**
 * Toggling goes through Git, so it takes 30-90s. Streamed as stages rather than
 * left as a dead button: those stages ARE the pipeline the dashboard
 * visualises, so the wait becomes the demonstration instead of dead time.
 */
app.post('/api/incident', (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const stream = sse(res);
  stream.send('stage', { stage: 'start', detail: enabled ? 'Triggering incident' : 'Resolving incident' });
  setIncident(enabled, (stage, detail) => stream.send('stage', { stage, detail }))
    .then(() => stream.send('done', { enabled }))
    .catch((err) => stream.send('error', { message: err.message }))
    .finally(() => stream.end());
});

/** Kira's investigation, streamed live — tool calls arrive before the report. */
app.post('/api/kira/investigate', (req, res) => {
  const question =
    String(req.body?.question || '').trim() ||
    'Investigate the aiops-dev namespace over the last 15 minutes and tell me the root cause.';
  const stream = sse(res);
  const model = config.provider === 'ollama' ? config.ollamaModel : config.anthropicModel;
  stream.send('start', { question, provider: config.provider, model });
  investigate(question, { verbose: false, onEvent: (e) => stream.send(e.type, e) })
    .catch((err) => stream.send('error', { message: err.message }))
    .finally(() => stream.end());
});

app.get('/api/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Kira dashboard API on http://localhost:${PORT}`);
  console.log(`  provider   ${config.provider}:${config.provider === 'ollama' ? config.ollamaModel : config.anthropicModel}`);
  console.log(`  prometheus ${config.prometheusUrl}`);
  console.log(`  loki       ${config.lokiUrl}`);
});
