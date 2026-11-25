/**
 * A stand-in Prometheus for fetch_metrics tests: answers each of the tool's
 * instant queries from plain data, by recognising the query's shape.
 * Installs itself as globalThis.fetch; call restore() (or the returned
 * function) to put the real fetch back.
 */
const vec = (rows) => ({
  status: 'success',
  data: { resultType: 'vector', result: rows.map(([metric, v]) => ({ metric, value: [0, String(v)] })) },
});

const realFetch = globalThis.fetch;
export const restore = () => { globalThis.fetch = realFetch; };

/**
 * @param {object} o
 * @param {string[]} [o.jobs]             services that exist (up == 1)
 * @param {object}   [o.podAge]           { job: seconds } youngest pod age (default 3600)
 * @param {object}   [o.rate]             { job: req/s } (default 1.2)
 * @param {object}   [o.rate5xx]          { job: 5xx req/s } (default none)
 * @param {Array}    [o.window]           [[{job,status}, count]] increase() over the window, 4xx/5xx
 * @param {Array}    [o.routes]           [[{job,route,status}, count]] increase() by route, 4xx/5xx
 * @param {object}   [o.raw5xx]           { job: count } raw 5xx counter (read only for fresh pods)
 * @param {object}   [o.latency]          { job: { p50, p95, p99 } } in SECONDS (default: none)
 */
export function stubPrometheus({
  jobs = ['gateway', 'frontend', 'order', 'orders'],
  podAge = {},
  rate = {},
  rate5xx = {},
  window = [],
  routes = [],
  raw5xx = {},
  latency = {},
} = {}) {
  const perJob = (obj, dflt) => jobs.filter((j) => (obj[j] ?? dflt) !== undefined).map((job) => [{ job }, obj[job] ?? dflt]);
  const quantile = (expr) => (expr.includes('(0.50,') ? 'p50' : expr.includes('(0.95,') ? 'p95' : 'p99');
  globalThis.fetch = async (url) => {
    const expr = new URL(url).searchParams.get('query');
    let body;
    if (expr.startsWith('up{')) body = vec(jobs.map((job) => [{ job }, 1]));
    else if (expr.startsWith('time() - max by (job) (process_start_time_seconds')) body = vec(perJob(podAge, 3600));
    else if (expr.includes('histogram_quantile')) {
      const q = quantile(expr);
      body = vec(Object.entries(latency).map(([job, l]) => [{ job }, l[q]]));
    }
    else if (expr.startsWith('sum by (job,route,status) (increase(')) body = vec(routes);
    else if (expr.startsWith('sum by (job,status) (increase(')) body = vec(window);
    else if (expr.startsWith('sum by (job) (http_requests_total{')) body = vec(Object.entries(raw5xx).map(([job, v]) => [{ job }, v]));
    else if (expr.includes('status=~"5.."')) body = vec(Object.entries(rate5xx).map(([job, v]) => [{ job }, v]));
    else body = vec(perJob(rate, 1.2));
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return restore;
}
