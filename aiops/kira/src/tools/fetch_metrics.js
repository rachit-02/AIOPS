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

/** A service is "slow" at p50 >= 800 ms or p95 >= 2 s (see latency_anomalies). */
export const LATENCY_P50_S = 0.8;
export const LATENCY_P95_S = 2;

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

  // The full requested window (not clamped like `w`), for the restart-proof
  // 5xx figure below.
  const win = `${Math.max(60, seconds)}s`;

  // EVERY count the model sees is WITHIN THE WINDOW. Lifetime counters
  // ("since pod start") were read by a 7B model as current: with the system
  // healthy it cited "order 106 errors since pod start" - left over from a
  // fault disarmed 15 minutes earlier - as an ongoing failure.
  //
  // Window counts use increase(), computed per series and summed, so they
  // handle counter resets and include old AND new pods across a restart
  // (arming or disarming the seeded fault restarts the order pod). increase()
  // extrapolates at the window edges, so counts are labelled approximate;
  // they answer "were there 5xx, roughly how many", not an exact tally.
  const [rate, errRate, p50, p95, p99, up, podAge, statusWindow, routeWindow, raw5xx] = await Promise.all([
    instant(`sum by (job) (rate(http_requests_total{${sel}}[${w}]))`),
    instant(`sum by (job) (rate(http_requests_total{${sel},status=~"5.."}[${w}]))`),
    instant(`histogram_quantile(0.50, sum by (le,job) (rate(http_request_duration_seconds_bucket{${sel}}[${w}])))`),
    instant(`histogram_quantile(0.95, sum by (le,job) (rate(http_request_duration_seconds_bucket{${sel}}[${w}])))`),
    instant(`histogram_quantile(0.99, sum by (le,job) (rate(http_request_duration_seconds_bucket{${sel}}[${w}])))`),
    instant(`up{${sel}}`),
    // Age of the youngest pod per service. A pod a minute old has reset
    // counters and fewer than a handful of scrapes, so every rate is unreliable.
    instant(`time() - max by (job) (process_start_time_seconds{${sel}})`),
    instant(`sum by (job,status) (increase(http_requests_total{${sel},status=~"[45].."}[${win}]))`),
    instant(`sum by (job,route,status) (increase(http_requests_total{${sel},status=~"[45].."}[${win}]))`),
    // Raw 5xx counter. Used ONLY for a pod younger than FRESH_POD_SECONDS,
    // where "since this pod started" is itself recent and rate() has not
    // caught up yet. Never reported for an older pod.
    instant(`sum by (job) (http_requests_total{${sel},status=~"5.."})`),
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
  /** A pod this young has reset counters and too few scrapes for rate(). */
  const FRESH_POD_SECONDS = 300;

  const services = jobs.map((job) => {
    const rps = pick(rate, job) ?? 0;
    const eps = pick(errRate, job) ?? 0;
    const statuses = statusWindow
      .filter((r) => r.labels.job === job && r.value >= 0.5)
      .map((r) => ({ status: r.labels.status, count: Math.round(r.value) }))
      .sort((a, b) => b.count - a.count);
    // Only failing routes: a list of every healthy route is noise that buries
    // the one that matters.
    const routes = routeWindow
      .filter((r) => r.labels.job === job && r.value >= 0.5)
      .map((r) => ({ route: r.labels.route, status: r.labels.status, approx_count: Math.round(r.value) }))
      .sort((a, b) => b.approx_count - a.approx_count);
    const server = statuses.filter((s) => is5xx(s.status));
    const client = statuses.filter((s) => is4xx(s.status));
    const age = pick(podAge, job);
    const fresh = Number.isFinite(age) && age < FRESH_POD_SECONDS;
    const fresh5xx = fresh ? Math.round(pick(raw5xx, job) ?? 0) : 0;

    return {
      service: job,
      scrape_up: pick(up, job) === 1,
      requests_per_second: round(rps, 3),
      // The headline number: 5xx only, within the window. clamp avoids
      // 0/0 -> NaN on an idle service.
      error_rate_percent: rps > 0 ? round((eps / rps) * 100) : 0,
      latency_seconds: { p50: round(pick(p50, job), 4), p95: round(pick(p95, job), 4), p99: round(pick(p99, job), 4) },
      server_errors_5xx_in_window: { approx_total: sum(server), by_status: server },
      client_errors_4xx_in_window: { approx_total: sum(client), by_status: client },
      youngest_pod_age_seconds: Number.isFinite(age) ? Math.round(age) : null,
      pod_started_recently: fresh,
      // Only for a pod a few minutes old, where it is current by definition.
      ...(fresh ? { server_errors_5xx_since_this_pod_started: fresh5xx } : {}),
      // SERVER failures only (5xx), in the window. The dashboard reads this.
      failing_routes: routes.filter((r) => is5xx(r.status)).slice(0, 10),
      client_error_routes_4xx: routes.filter((r) => is4xx(r.status)).slice(0, 10),
    };
  });

  // Erroring = 5xx evidence NOW: a non-zero windowed rate, 5xx counted in the
  // window across pod restarts, or 5xx on a pod too young for rate() to show.
  const erroring = services.filter(
    (s) =>
      s.error_rate_percent > 0 ||
      s.server_errors_5xx_in_window.approx_total > 0 ||
      (s.server_errors_5xx_since_this_pod_started ?? 0) > 0,
  );
  const freshPods = services.filter((s) => s.pod_started_recently);
  // SLOW without failing (5xx-free latency faults). Thresholds sit far above
  // normal: p50 is single-digit ms for most services and ~375 ms for
  // bcrypt-bound auth. Exported thresholds keep the guard and the dashboard in
  // step with this definition.
  const slow = services
    .filter((s) => (s.latency_seconds.p50 ?? 0) >= LATENCY_P50_S || (s.latency_seconds.p95 ?? 0) >= LATENCY_P95_S)
    .map((s) => ({
      service: s.service,
      p50_ms: Math.round((s.latency_seconds.p50 ?? 0) * 1000),
      p95_ms: Math.round((s.latency_seconds.p95 ?? 0) * 1000),
      p99_ms: Math.round((s.latency_seconds.p99 ?? 0) * 1000),
    }))
    .sort((a, b) => b.p50_ms - a.p50_ms);
  const with4xx = services.filter((s) => s.client_errors_4xx_in_window.approx_total > 0);

  return {
    source: 'prometheus',
    query_window: time_range,
    namespace: config.namespace,
    counts_note:
      `All counts are approximate totals WITHIN the last ${time_range}, summed across pod restarts. ` +
      'No lifetime / since-pod-start totals are reported.',
    services,
    summary: {
      // Server errors (5xx) in the query window. This - not 4xx - is what
      // "erroring" means.
      services_with_errors: erroring.map((s) => s.service),
      server_errors_5xx_in_window: erroring.length > 0,
      // A restarted pod (e.g. the one a config change just rolled out) has
      // reset counters and needs at least two scrapes before rate() or
      // increase() can show anything. A 0 for it is not evidence of health.
      recently_started_pods: freshPods.map((s) => ({ service: s.service, age_seconds: s.youngest_pod_age_seconds })),
      metrics_lag_note: freshPods.length
        ? `${freshPods.map((s) => `${s.service} (${s.youngest_pod_age_seconds}s)`).join(', ')} started recently: ` +
          'its counters reset and rate windows need a few scrapes, so 5xx figures for it may LAG reality by a ' +
          'minute or two. If fetch_logs shows errors for it, trust the logs - do not conclude "no errors".'
        : null,
      latency_anomalies: slow,
      latency_note: slow.length
        ? 'Latency propagates UPSTREAM exactly like errors: a slow product makes order, gateway and frontend ' +
          'slow too. The origin is the DEEPEST slow service in the call graph (product/auth/user/orders below ' +
          'order, below gateway, below frontend), not the slowest number.'
        : null,
      client_errors_4xx_in_window: Object.fromEntries(
        with4xx.map((s) => [s.service, s.client_errors_4xx_in_window.approx_total]),
      ),
      client_errors_note:
        '4xx are CLIENT responses (400 validation, 401/403 missing or expired token, 404 not found, ' +
        '409 conflict/out of stock). The server handled them correctly. They are not server failures, ' +
        'not a root cause, and not "propagated errors" on their own; gateway and frontend repeat the ' +
        'same 4xx because they proxy it.',
      // Deliberately phrased as a HINT, not a conclusion. The tool reports the
      // service with the most 5xx; deciding whether that is the origin or just
      // the busiest propagator is the model's job, using the call graph.
      highest_error_rate: [...erroring].sort((a, b) => b.error_rate_percent - a.error_rate_percent)[0]?.service ?? null,
      note:
        erroring.length > 1
          ? 'Multiple services are erroring. Errors propagate upstream (frontend <- gateway <- backend), ' +
            'so use the call graph and which service THREW (fetch_logs) before naming an origin.'
          : null,
    },
  };
}
