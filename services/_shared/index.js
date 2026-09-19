/**
 * Shared service scaffolding.
 *
 * WHY this exists: the project's core promise is that *every* service emits the
 * same three signals (metrics, structured logs, health) in the same shape.
 * Kira and the Grafana dashboards depend on that uniformity, so it lives in one
 * place instead of seven copy-pasted (and slowly diverging) versions.
 *
 * Contract every service gets for free:
 *   GET /health   liveness  - process is up (never touches dependencies)
 *   GET /ready    readiness - dependencies (DB) reachable; 503 otherwise
 *   GET /metrics  Prometheus exposition format
 *   JSON logs on stdout, one line per request, carrying a request_id
 */
import express from 'express';
import pino from 'pino';
import client from 'prom-client';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

// Re-exported so services use the *same* express instance as the shared code.
// Two copies of express in one process is legal but confusing to debug.
export { express };

// Paths that are infrastructure chatter, not user traffic. Excluding them keeps
// request-rate / error-rate graphs honest (k8s probes hit /health every few
// seconds and Prometheus scrapes /metrics constantly).
const OPS_PATHS = new Set(['/health', '/ready', '/metrics']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Wrap async route handlers: Express 4 does not catch rejected promises. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Postgres pool. Each service passes its own DATABASE_URL (its own DB role), so
 * a compromised or buggy service can only touch its own schema.
 */
export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 2000 });
  // An idle-client error must not crash the process; readiness will report it.
  pool.on('error', () => {});
  return pool;
}

/**
 * Service-to-service HTTP call. Always has a timeout: without one, a hung
 * downstream would pile up requests here and cascade the failure upstream -
 * exactly the kind of incident Kira should be able to trace.
 * Propagates x-request-id so one user request can be followed across services
 * in the logs.
 */
export async function callService(baseUrl, path, { method = 'GET', body, requestId, userId, timeoutMs = 3000 } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(requestId && { 'x-request-id': requestId }),
      ...(userId && { 'x-user-id': String(userId) }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${baseUrl}${path} responded ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export function createService({ name, pool = null, parseBody = true }) {
  const log = pino({
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    // "level":"error" (string) rather than pino's default numeric levels, so
    // CloudWatch Logs Insights filters read naturally: `filter level = "error"`.
    formatters: { level: (label) => ({ level: label }) },
  });

  // Per-instance registry (not prom-client's global one) so tests can create
  // several apps in one process without "metric already registered" errors.
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  // Labels are deliberately low-cardinality: method, route TEMPLATE
  // (/orders/:id, never /orders/42) and status. Raw URLs would create an
  // unbounded number of time series and blow up Prometheus memory.
  const requestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });
  const requestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'],
    // Buckets bracket the latencies we care about; p95/p99 are estimated from
    // these, so resolution around 50ms-1s matters most.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const app = express();
  app.disable('x-powered-by');

  // 1. Request id: reuse the caller's (gateway) or mint one.
  app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] || randomUUID();
    req.headers['x-request-id'] = req.id; // so the gateway proxy forwards it
    res.setHeader('x-request-id', req.id);
    next();
  });

  // 2. Metrics + access log, recorded when the response finishes so we know
  //    the final status and total duration.
  app.use((req, res, next) => {
    if (OPS_PATHS.has(req.path)) return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req.route?.path ?? 'unmatched'; // never the raw URL
      const labels = { method: req.method, route, status: res.statusCode };
      requestsTotal.inc(labels);
      requestDuration.observe(labels, seconds);
      const fields = {
        request_id: req.id,
        method: req.method,
        route,
        path: req.originalUrl,
        status: res.statusCode,
        duration_ms: Math.round(seconds * 1000),
        ...(res.locals.error && { error: res.locals.error }),
      };
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      log[level](fields, 'request');
    });
    next();
  });

  // 3. Body parsing. The gateway opts out: a proxy must stream the raw body
  //    through, and express.json() would consume it first.
  if (parseBody) app.use(express.json({ limit: '100kb' }));

  // ---- Ops endpoints ------------------------------------------------------
  app.get('/health', (req, res) => res.json({ status: 'ok', service: name }));

  const readyChecks = [];
  if (pool) readyChecks.push(['postgres', () => pool.query('SELECT 1')]);
  app.get('/ready', async (req, res) => {
    const checks = {};
    for (const [dep, check] of readyChecks) {
      try {
        await check();
        checks[dep] = 'ok';
      } catch (err) {
        checks[dep] = `fail: ${err.message}`;
      }
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks });
  });

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });

  // ---- Fault injection ----------------------------------------------------
  // WHY: we need reproducible incidents to test the dashboards and, later,
  // Kira. Disabled unless CHAOS_ENABLED=true so it can never be flipped on in
  // a real environment by accident. State is in-memory and resets on restart.
  const chaos = { latencyMs: 0, errorRate: 0 };
  if (process.env.CHAOS_ENABLED === 'true') {
    app.get('/chaos', (req, res) => res.json(chaos));
    app.post('/chaos/latency', (req, res) => {
      chaos.latencyMs = clamp(Number(req.query.ms) || 0, 0, 30000);
      res.json(chaos);
    });
    app.post('/chaos/errors', (req, res) => {
      chaos.errorRate = clamp(Number(req.query.rate) || 0, 0, 1);
      res.json(chaos);
    });
    app.post('/chaos/reset', (req, res) => {
      chaos.latencyMs = 0;
      chaos.errorRate = 0;
      res.json(chaos);
    });
  }
  app.use(async (req, res, next) => {
    if (chaos.latencyMs) await sleep(chaos.latencyMs);
    if (chaos.errorRate && Math.random() < chaos.errorRate) {
      res.locals.error = 'chaos_injected_failure';
      return res.status(500).json({ error: 'chaos_injected_failure' });
    }
    next();
  });

  /**
   * Call AFTER registering routes: adds 404 + error handlers (they must be
   * last), starts listening, and wires graceful shutdown so in-flight requests
   * finish when Kubernetes sends SIGTERM during a rolling deploy.
   */
  function start({ port = Number(process.env.PORT) || 3000, handleSignals = true } = {}) {
    app.use((req, res) => res.status(404).json({ error: 'not_found' }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      // Logged with the stack: this is the evidence Kira reads via fetch_logs.
      log.error({ request_id: req.id, err: { message: err.message, stack: err.stack } }, 'unhandled_error');
      res.locals.error = err.message;
      const status = err.status && err.status < 600 ? err.status : 500;
      // Never leak internals (messages/stacks) to clients on a 5xx. The
      // request_id lets an operator - or Kira - find the full stack in the logs.
      res.status(status).json(status >= 500 ? { error: 'internal_error', request_id: req.id } : { error: err.message });
    });

    const server = app.listen(port, () => log.info({ port }, 'listening'));
    if (handleSignals) {
      const shutdown = (signal) => {
        log.info({ signal }, 'shutting_down');
        server.close(async () => {
          if (pool) await pool.end().catch(() => {});
          process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000).unref(); // hard stop if stuck
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    }
    return server;
  }

  return { app, start, log, registry };
}
