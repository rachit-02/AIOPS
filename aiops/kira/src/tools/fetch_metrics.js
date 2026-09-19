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
    instant(`sum by (job,status) (increase(http_requests_total{${sel}}[${seconds}s]))`),
    instant(`sum by (job,route,status) (increase(http_requests_total{${sel},status=~"[45].."}[${seconds}s]))`),
    instant(`up{${sel}}`),
  ]);

  const pick = (arr, job) => arr.find((r) => r.labels.job === job)?.value;
  const jobs = [...new Set([...rate, ...up].map((r) => r.labels.job))].sort();

  const services = jobs.map((job) => {
    const rps = pick(rate, job) ?? 0;
    const eps = pick(errRate, job) ?? 0;
    const statuses = byStatus
      .filter((r) => r.labels.job === job && r.value >= 0.5)
      .map((r) => ({ status: r.labels.status, count: Math.round(r.value) }))
      .sort((a, b) => b.count - a.count);
    // Only failing routes: a list of every healthy route is noise that buries
    // the one that matters.
    const failing = byRoute
      .filter((r) => r.labels.job === job && r.value >= 0.5)
      .map((r) => ({ route: r.labels.route, status: r.labels.status, count: Math.round(r.value) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      service: job,
      scrape_up: pick(up, job) === 1,
      requests_per_second: round(rps, 3),
      // The headline number. clamp avoids 0/0 -> NaN on an idle service.
      error_rate_percent: rps > 0 ? round((eps / rps) * 100) : 0,
      latency_seconds: { p50: round(pick(p50, job), 4), p95: round(pick(p95, job), 4), p99: round(pick(p99, job), 4) },
      status_counts_in_window: statuses,
      failing_routes: failing,
    };
  });

  const erroring = services.filter((s) => s.error_rate_percent > 0);

  return {
    source: 'prometheus',
    query_window: time_range,
    namespace: config.namespace,
    services,
    summary: {
      services_with_errors: erroring.map((s) => s.service),
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
