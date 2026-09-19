/**
 * TOOL 2 of 3 — fetch_logs
 * Source: Loki (independent of Prometheus and of the Kubernetes API).
 *
 * SCOPE: this tool answers "what actually happened, in the service's own
 * words". It is the only tool that can produce a stack trace, and therefore
 * the only one that can identify a failing code path.
 *
 * TWO THINGS IT DOES SO THE MODEL DOES NOT HAVE TO:
 *
 * 1. GETS THE LABEL NAMES RIGHT. Fluent Bit's Loki output FLATTENS nested
 *    Kubernetes metadata: the label is `kubernetes_namespace_name`, not
 *    `namespace`. Querying the wrong name returns an empty result with NO
 *    error - which reads as "nothing is wrong" and is the worst possible
 *    failure mode for a diagnostic tool. The names are hard-coded here rather
 *    than left to the model to remember.
 *
 * 2. AGGREGATES BEFORE RETURNING. Raw log dumps are expensive in tokens and
 *    worse for accuracy - three significant lines get buried in five thousand
 *    routine ones. This groups identical errors, counts them, and returns a
 *    capped sample with the stack trace attached.
 */
import { config, parseTimeRange, fetchJson } from '../config.js';

const NS_LABEL = 'kubernetes_namespace_name';
const CONTAINER_LABEL = 'kubernetes_container_name';

export const definition = {
  name: 'fetch_logs',
  description:
    'Query Loki for application logs, grouped by distinct error message with counts and ' +
    'example stack traces. Accepts one service or "all". Use it to find WHY a service is ' +
    'failing once metrics have told you WHERE, and to identify WHICH service ORIGINATED a ' +
    'failure: only the service that actually threw has a stack trace, while services merely ' +
    'propagating a downstream error have access-log entries alone. In "all" mode the ' +
    'by_service breakdown answers "who threw?" in a single call.',
  input_schema: {
    type: 'object',
    properties: {
      service: {
        type: 'string',
        description:
          'Service name (frontend, gateway, auth, product, order, orders, user), or "all" to ' +
          'survey every service at once. Use "all" first when you do not yet know which service ' +
          'threw - it reports threw_exceptions per service, which identifies the origin directly.',
      },
      time_range: { type: 'string', description: 'Lookback window, e.g. "15m", "1h". Default "15m".' },
      level: {
        type: 'string',
        enum: ['error', 'warn', 'info', 'all'],
        description:
          'Log level filter. Use "error" first when investigating a failure; "all" only ' +
          'if errors alone do not explain the behaviour. Default "error".',
      },
    },
    required: ['service'],
    additionalProperties: false,
  },
};

/** Collapse variable parts so "order 41 not found" and "order 42 not found" group together. */
const fingerprint = (msg) =>
  String(msg)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d+\b/g, '<n>')
    .slice(0, 200);

export async function run({ service, time_range = '15m', level = 'error' }) {
  if (service !== 'all' && !config.services.includes(service)) {
    throw new Error(`unknown service "${service}". Known: ${config.services.join(', ')}, or "all"`);
  }
  const seconds = parseTimeRange(time_range);
  const end = Date.now() * 1e6;
  const start = end - seconds * 1e9;

  // With "all", drop the container label so every service in the namespace is
  // surveyed in one query, making "who actually threw?" a single tool call
  // instead of seven.
  let selector =
    service === 'all'
      ? `{${NS_LABEL}="${config.namespace}"}`
      : `{${NS_LABEL}="${config.namespace}", ${CONTAINER_LABEL}="${service}"}`;
  // `level` is an indexed label (Fluent Bit promotes it), so filtering on it
  // is cheap - it narrows streams rather than scanning lines.
  if (level !== 'all') selector = selector.replace('}', `, level="${level}"}`);

  const url =
    `${config.lokiUrl}/loki/api/v1/query_range` +
    `?query=${encodeURIComponent(selector + ' | json')}` +
    `&start=${start}&end=${end}&limit=1000&direction=backward`;

  const body = await fetchJson(url, { timeoutMs: 20000 });
  const streams = body?.data?.result || [];

  const groups = new Map();
  let total = 0;

  // Per-service tallies, so "all" mode can attribute exceptions to a service.
  // Without this the survey would say that SOMETHING threw but not what, which
  // is the one question it exists to answer.
  const perService = new Map();

  for (const s of streams) {
    const svcName = s.stream?.[CONTAINER_LABEL] ?? 'unknown';
    for (const [tsNano, raw] of s.values) {
      total++;
      let line;
      try {
        line = JSON.parse(raw);
      } catch {
        line = { msg: raw };
      }
      // Our services log an `err` object for unhandled exceptions; the access
      // log carries `error` for handled failures.
      const errMsg = line?.err?.message || line.error || line.msg || '(no message)';
      // Group by (event, message), not message alone.
      //
      // The shared logger emits TWO lines per failed request: an
      // `unhandled_error` carrying the exception and stack, and a `request`
      // access-log line carrying the same error text and the 500 status.
      // Collapsing them into one group double-counts every failure - 14 failed
      // requests look like 28. Splitting them keeps the arithmetic honest and
      // makes the distinction visible: only the exception line has a stack.
      const event = line.msg || '(none)';
      const key = `${event}|${fingerprint(errMsg)}`;
      if (!groups.has(key)) {
        groups.set(key, {
          event,
          // `unhandled_error` means this service THREW. `request` alone means
          // it only recorded a status - which is what a proxy does when the
          // failure happened somewhere downstream.
          has_stack_trace: Boolean(line?.err?.stack),
          message: String(errMsg).slice(0, 300),
          count: 0,
          first_seen: null,
          last_seen: null,
          // Only the FIRST example keeps a stack trace. Ten copies of the same
          // trace is ten times the tokens for no extra information.
          example: {
            timestamp: new Date(Number(tsNano) / 1e6).toISOString(),
            level: line.level ?? null,
            route: line.route ?? null,
            status: line.status ?? null,
            request_id: line.request_id ?? null,
            stack: line?.err?.stack ? String(line.err.stack).split('\n').slice(0, 6).join('\n') : null,
          },
        });
      }
      const g = groups.get(key);
      g.count++;

      if (!perService.has(svcName)) perService.set(svcName, { service: svcName, lines: 0, exceptions: 0 });
      const ps = perService.get(svcName);
      ps.lines++;
      if (line?.err?.stack) ps.exceptions++;
      const iso = new Date(Number(tsNano) / 1e6).toISOString();
      if (!g.first_seen || iso < g.first_seen) g.first_seen = iso;
      if (!g.last_seen || iso > g.last_seen) g.last_seen = iso;
    }
  }

  const distinct = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, config.maxLogLines);
  const withStack = distinct.filter((g) => g.has_stack_trace);

  return {
    source: 'loki',
    service,
    level_filter: level,
    query_window: time_range,
    // THE ORIGIN SIGNAL, and the most reliable one available.
    // A service that threw has a stack trace. A service that merely forwarded
    // a downstream failure has only access-log lines. This distinguishes an
    // origin from its blast radius far more dependably than comparing error
    // counts, which are distorted by rate-window extrapolation and by counter
    // resets at deploy time.
    threw_exceptions: withStack.length > 0,
    exception_count: withStack.reduce((n, g) => n + g.count, 0),
    // Only meaningful in "all" mode, and the reason that mode exists: the
    // service(s) with exceptions > 0 are the ORIGIN; services with lines but
    // zero exceptions merely observed and forwarded the failure.
    by_service:
      service === 'all'
        ? [...perService.values()]
            .sort((a, b) => b.exceptions - a.exceptions || b.lines - a.lines)
            .map((s) => ({ ...s, threw: s.exceptions > 0 }))
        : undefined,
    // The exact LogQL used, so a human can paste it into Grafana and reproduce
    // what Kira saw. Reproducibility is what separates evidence from assertion.
    logql: `${selector} | json`,
    total_matching_lines: total,
    distinct_messages: distinct.length,
    messages: distinct,
    note:
      total === 0
        ? 'No matching log lines. Either the service is not logging at this level, the window ' +
          'is wrong, or the service is not the one failing. This is not by itself evidence of health.'
        : withStack.length > 0
          ? `This service THREW ${withStack.reduce((n, g) => n + g.count, 0)} exception(s) with stack traces - ` +
            'it is where the failure originated, not merely where it was observed. ' +
            'Note that each failed request produces TWO log lines (the exception and the access-log ' +
            'entry), so count distinct events, not raw lines.'
          : 'No stack traces here - only access-log entries recording a status. This service ' +
            'OBSERVED failures but did not throw them, which is the signature of a proxy or caller ' +
            'propagating a downstream error.',
  };
}
