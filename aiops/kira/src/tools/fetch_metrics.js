/**
 * TOOL 1 of 3 — fetch_metrics
 * Source: Prometheus (independent of Loki and of the Kubernetes API).
 *
 * SCOPE: this tool answers "how much traffic, how many errors, how slow" and
 * nothing else. It does not read logs and does not look at pods. Keeping each
 * tool to one data source is what makes Kira's correlation meaningful: if one
 * tool could return everything, "cross-referencing three signals" would be a
 * fiction.
 *
 * It returns COMPUTED values (rates, percentiles, totals), not raw Prometheus
 * envelopes. The model should spend its reasoning on the diagnosis, not on
 * parsing `{"resultType":"vector","result":[...]}`.
 */
import { config, parseTimeRange, fetchJson } from '../config.js';

const q = (expr) => `${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(expr)}`;

/** Run an instant query, returning [{labels, value}]. */
async function instant(expr) {
  const body = await fetchJson(q(expr));
  if (body.status !== 'success') throw new Error(`Prometheus error: ${body.error || 'unknown'}`);
  return (body.data.result || []).map((r) => ({ labels: r.metric, value: Number(r.value[1]) }));
}

const round = (n, dp = 2) => (Number.isFinite(n) ? Number(n.toFixed(dp)) : null);

export const definition = {
  name: 'fetch_metrics',
  description:
    'Query Prometheus for HTTP traffic metrics of one or all services: request rate, ' +
    'error rate, latency percentiles, and a breakdown by status code and route. ' +
    'Use this to establish WHERE and HOW BADLY something is failing, and to compare ' +
    'services so you can tell an origin apart from services merely propagating its ' +
    'errors. It cannot tell you WHY - use fetch_logs for that.',
  input_schema: {
    type: 'object',
    properties: {
      service: {
        type: 'string',
        description:
          'Service name (frontend, gateway, auth, product, order, orders, user), ' +
          'or "all" to compare every service at once. Start with "all" when you do ' +
          'not yet know which service is at fault.',
      },
      time_range: {
        type: 'string',
        description: 'Lookback window, e.g. "15m", "1h". Default "15m".',
      },
    },
    required: ['service'],
    additionalProperties: false,
  },
};

export async function run({ service, time_range = '15m' }) {
  const seconds = parseTimeRange(time_range);
  if (service !== 'all' && !config.services.includes(service)) {
    throw new Error(`unknown service "${service}". Known: ${config.services.join(', ')}, or "all"`);
  }

  const ns = `namespace="${config.namespace}"`;
  const sel = service === 'all' ? ns : `${ns},job="${service}"`;
  // The rate window must span several scrape intervals (15s) or the result is
  // noisy; it is also clamped to the requested range so a 1m lookback does not
  // silently average over 5m of history.
  const w = `${Math.max(60, Math.min(seconds, 600))}s`;

  const [rate, errRate, p50, p95, p99, byStatus, byRoute, up] = await Promise.all([
    instant(`sum by (job) (rate(http_requests_total{${sel}}[${w}]))`),
    instant(`sum by (job) (rate(http_requests_total{${sel},status=~"5.."}[${w}]))`),
    instant(`histogram_quantile(0.50, sum by (le,job) (rate(http_request_duration_seconds_bucket{${sel}}[${w}])))`),
    instant(`histogram_quantile(0.95, sum by (le,job) (rate(http_request_duration_seconds_bucket{${sel}}[${w}])))`),
    instant(`histogram_quantile(0.99, sum by (le,job) (rate(http_request_duration_seconds_bucket{${sel}}[${w}])))`),
    // RAW counter totals, not increase(). increase() extrapolates at the window
    // edges and is badly distorted when a counter was born mid-window - which
    // happens on every deploy, i.e. exactly when incidents start. Measured
    // against a real incident, increase() reported 15 / 7 / 2 errors for three
    // services that had each seen the same 14. Raw totals since pod start are
    // exact, and after a rollout they are scoped to the incident anyway.
    instant(`sum by (job,status) (http_requests_total{${sel}})`),
    instant(`sum by (job,route,status) (http_requests_total{${sel},status=~"[45].."})`),
    instant(`up{${sel}}`),
  ]);

  const pick = (arr, job) => arr.find((r) => r.labels.job === job)?.value;
  const jobs = [...new Set([...rate, ...up].map((r) => r.labels.job))].sort();

  // 5xx and 4xx are reported SEPARATELY, never in one "errors" list. A 4xx is
  // the server correctly refusing a request (bad input, no/expired token, not
  // found, conflict). Mixed together, a 7B model read ~3,400 401s from an
  // expired traffic token as "propagated errors" and invented an incident.
  const is5xx = (s) => String(s).startsWith('5');
  const is4xx = (s) => String(s).startsWith('4');
  const sum = (list) => list.reduce((n, x) => n + x.count, 0);

  const services = jobs.map((job) => {
    const rps = pick(rate, job) ?? 0;
    const eps = pick(errRate, job) ?? 0;
    const statuses = byStatus
      .filter((r) => r.labels.job === job && r.value >= 0.5)
      .map((r) => ({ status: r.labels.status, count: Math.round(r.value) }))
      .sort((a, b) => b.count - a.count);
    // Only failing routes: a list of every healthy route is noise that buries
    // the one that matters.
    const routes = byRoute
      .filter((r) => r.labels.job === job && r.value >= 0.5)
      .map((r) => ({ route: r.labels.route, status: r.labels.status, count: Math.round(r.value) }))
      .sort((a, b) => b.count - a.count);
    const server = statuses.filter((s) => is5xx(s.status));
    const client = statuses.filter((s) => is4xx(s.status));

    return {
      service: job,
      scrape_up: pick(up, job) === 1,
      requests_per_second: round(rps, 3),
      // The headline number: 5xx only, within the window. clamp avoids
      // 0/0 -> NaN on an idle service.
      error_rate_percent: rps > 0 ? round((eps / rps) * 100) : 0,
      latency_seconds: { p50: round(pick(p50, job), 4), p95: round(pick(p95, job), 4), p99: round(pick(p99, job), 4) },
      // All counts below are "since the pod started", NOT "within the query
      // window". Named explicitly so they are not misread as windowed counts.
      server_errors_5xx_since_pod_start: { total: sum(server), by_status: server },
      client_errors_4xx_since_pod_start: { total: sum(client), by_status: client },
      other_responses_since_pod_start: statuses.filter((s) => !is5xx(s.status) && !is4xx(s.status)),
      // SERVER failures only (5xx). The dashboard reads this field too.
      failing_routes: routes.filter((r) => is5xx(r.status)).slice(0, 10),
      client_error_routes_4xx: routes.filter((r) => is4xx(r.status)).slice(0, 10),
    };
  });

  const erroring = services.filter((s) => s.error_rate_percent > 0);
  const with4xx = services.filter((s) => s.client_errors_4xx_since_pod_start.total > 0);

  return {
    source: 'prometheus',
    query_window: time_range,
    namespace: config.namespace,
    services,
    summary: {
      // Server errors (5xx) in the query window. This - not 4xx - is what
      // "erroring" means.
      services_with_errors: erroring.map((s) => s.service),
      server_errors_5xx_in_window: erroring.length > 0,
      client_errors_4xx_since_pod_start: Object.fromEntries(
        with4xx.map((s) => [s.service, s.client_errors_4xx_since_pod_start.total]),
      ),
      client_errors_note:
        '4xx are CLIENT responses (400 validation, 401/403 missing or expired token, 404 not found, ' +
        '409 conflict/out of stock). The server handled them correctly. They are not server failures, ' +
        'not a root cause, and not "propagated errors" on their own; gateway and frontend repeat the ' +
        'same 4xx because they proxy it.',
      // Deliberately phrased as a HINT, not a conclusion. The tool reports the
      // service with the most 5xx; deciding whether that is the origin or just
      // the busiest propagator is the model's job, using the call graph.
      highest_error_rate: erroring.sort((a, b) => b.error_rate_percent - a.error_rate_percent)[0]?.service ?? null,
      note:
        erroring.length > 1
          ? 'Multiple services are erroring. Errors propagate upstream (frontend <- gateway <- backend), ' +
            'so compare absolute 5xx counts and the call graph before naming an origin.'
          : null,
    },
  };
}
