/**
 * Prometheus RANGE queries for the dashboard's sparklines and charts.
 *
 * WHY THIS IS SEPARATE FROM src/tools/
 * Kira's three tools exist to serve an AGENT: they aggregate aggressively,
 * return prose-friendly summaries and cap their output, because tokens are
 * expensive and a wall of numbers makes reasoning worse. A chart needs the
 * opposite - an evenly-spaced series of raw points.
 *
 * Mixing the two would either bloat the agent's context with time series it
 * cannot use, or starve the chart. Keeping them apart also preserves the rule
 * that each of Kira's tools does exactly one job.
 */
import { config, parseTimeRange, fetchJson } from './config.js';

async function rangeQuery(expr, seconds, points = 40) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - seconds;
  const step = Math.max(15, Math.floor(seconds / points));
  const url =
    `${config.prometheusUrl}/api/v1/query_range?query=${encodeURIComponent(expr)}` +
    `&start=${start}&end=${end}&step=${step}`;
  const body = await fetchJson(url);
  if (body.status !== 'success') throw new Error(body.error || 'prometheus range query failed');
  return body.data.result || [];
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * One latency series per service, for the rail sparklines and the centre chart.
 * Returns { [service]: number[] } in milliseconds, nulls dropped so a gap in
 * scraping does not render as a spike to zero - which would read as "latency
 * recovered" when it actually means "we stopped measuring".
 */
export async function latencySeries(timeRange = '15m', quantile = 0.99) {
  const seconds = parseTimeRange(timeRange);
  const w = Math.max(60, Math.min(seconds, 300));
  const expr =
    `histogram_quantile(${quantile}, sum by (le, job) (` +
    `rate(http_request_duration_seconds_bucket{namespace="${config.namespace}"}[${w}s])))`;
  const series = await rangeQuery(expr, seconds);

  const out = {};
  for (const s of series) {
    const job = s.metric.job;
    if (!job) continue;
    out[job] = s.values.map(([, v]) => num(v)).filter((v) => v !== null).map((v) => Math.round(v * 1000));
  }
  return out;
}

/** Error-rate percentage series, used to colour and shape the centre chart. */
export async function errorRateSeries(timeRange = '15m') {
  const seconds = parseTimeRange(timeRange);
  const w = Math.max(60, Math.min(seconds, 300));
  const total = `sum by (job) (rate(http_requests_total{namespace="${config.namespace}"}[${w}s]))`;
  const errors = `sum by (job) (rate(http_requests_total{namespace="${config.namespace}",status=~"5.."}[${w}s]))`;

  // `or (<total> * 0)` fills a ZERO for every job that has no 5xx series.
  //
  // Without it, PromQL division only emits a result where BOTH sides have a
  // matching job label - so a service that has just started erroring produces
  // no points at all until the 5xx series spans the window, and its error
  // chart stays blank at exactly the moment it matters most. Measured: order
  // sitting at 4.51% with an empty error series while frontend and gateway,
  // which had errored earlier, had 41 points each.
  const expr = `100 * ((${errors}) or (${total} * 0)) / clamp_min(${total}, 0.001)`;
  const series = await rangeQuery(expr, seconds);
  const out = {};
  for (const s of series) {
    if (!s.metric.job) continue;
    out[s.metric.job] = s.values.map(([, v]) => num(v)).filter((v) => v !== null).map((v) => Math.round(v * 10) / 10);
  }
  return out;
}
