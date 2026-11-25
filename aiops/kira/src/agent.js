/**
 * Kira's agentic loop — provider-agnostic.
 *
 * Nothing here knows whether the model is a local qwen2.5:7b or Sonnet 5; it
 * talks to the normalised client interface in src/model/. That seam is what
 * makes "only the model client changed" a verifiable claim rather than a
 * description.
 *
 * WHY A HAND-WRITTEN LOOP
 * A provider SDK helper would be less code, but the project exists to
 * demonstrate the agentic pattern, every tool call has to be individually
 * traceable, and a hand-written loop is the only version that works
 * identically across two providers with different wire formats.
 *
 * THE RELIABILITY PROBLEM THIS LOOP SOLVES
 * A 7B model is markedly less dependable at tool use than a frontier model. It
 * will sometimes answer straight from the system prompt — which contains the
 * service topology and therefore enough material to produce a confident,
 * plausible, entirely unevidenced diagnosis. That is the worst possible
 * failure mode for a diagnostic tool, because it looks exactly like success.
 * So the loop refuses to accept a final answer until all three signals have
 * been gathered: it names what is missing, asks again, and fails loudly if the
 * model still will not comply.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { toolDefinitions, runTool, summarise } from './tools/index.js';
import { createModelClient } from './model/index.js';
import { Trace } from './trace.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The three signals a diagnosis is not allowed to be published without. */
export const REQUIRED_TOOLS = ['fetch_metrics', 'fetch_logs', 'fetch_health'];

/** The system prompt lives in a reviewable Markdown file, never inline. */
export function loadSystemPrompt() {
  return readFileSync(join(HERE, '..', 'prompts', 'kira-system-prompt.md'), 'utf8');
}

/**
 * Validate arguments before executing.
 *
 * Anthropic can enforce this server-side with `strict: true`; Ollama has no
 * equivalent, so it has to happen here. Without it a missing required field
 * surfaces as a confusing TypeError deep inside a tool instead of a message
 * the model can actually correct.
 */
function validateArgs(name, args) {
  const def = toolDefinitions.find((t) => t.name === name);
  if (!def) return `Unknown tool "${name}". Available: ${REQUIRED_TOOLS.join(', ')}.`;
  if (args?.__unparseable !== undefined) return `Arguments were not valid JSON: ${args.__unparseable}`;
  for (const req of def.input_schema.required ?? []) {
    if (args?.[req] === undefined || args[req] === null || args[req] === '') {
      return `Missing required argument "${req}" for ${name}.`;
    }
  }
  return null;
}

/** Order-independent identity of a call: same tool + same arguments. */
export function callKey(name, args) {
  // JSON.stringify preserves insertion order, so {service, time_range} and
  // {time_range, service} would hash differently without the sort.
  return `${name}|${JSON.stringify(
    Object.fromEntries(Object.entries(args ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  )}`;
}

/** What the model receives when it repeats a call from an earlier turn. */
export function alreadyFetched(content, turn) {
  return (
    `ALREADY FETCHED: you made this exact call (same tool, same arguments) in turn ${turn} of this ` +
    'investigation. The cached result is below, unchanged. Do not repeat calls - use this data, or call a ' +
    'different tool or different arguments.\n' +
    content
  );
}

// ---------------------------------------------------------------------------
// Blast-radius evidence check
// ---------------------------------------------------------------------------

const SERVICE_CHARS = 'A-Za-z0-9_-';
/** Matches the exact service name, so `order` never matches inside `orders`. */
const serviceRe = (name) => new RegExp(`(?<![${SERVICE_CHARS}])${name}(?![${SERVICE_CHARS}])`, 'i');
/** A line that says a service is NOT affected is a correct line; keep it. */
const NEGATION = /\b(not|unaffected|no errors?|0 errors|zero errors|healthy|unchanged)\b/i;

/**
 * From every successful fetch_metrics result in the investigation: which
 * services were measured, and which of them showed errors (a non-zero 5xx
 * rate, or any 5xx since pod start).
 */
export function errorEvidence(metricsResults, logsResults = []) {
  const seen = new Set();
  const erroring = new Set();
  for (const r of metricsResults) {
    for (const s of r?.services ?? []) {
      seen.add(s.service);
      const fiveXX =
        (s.server_errors_5xx_in_window?.approx_total ?? 0) > 0 ||
        (s.server_errors_5xx_since_pod_start?.total ?? 0) > 0 ||
        (s.status_counts_since_pod_start ?? []).some((c) => String(c.status).startsWith('5') && c.count > 0);
      if (s.error_rate_percent > 0 || fiveXX) erroring.add(s.service);
    }
  }
  // Error LOGS are evidence too. Metrics lag a freshly restarted pod, so a
  // service can have error lines while fetch_metrics still shows 0 5xx; it
  // must not be dropped from the blast radius for that.
  for (const svc of servicesWithErrorLogs(logsResults)) erroring.add(svc);
  const zeroErrors = [...seen].filter((s) => !erroring.has(s));
  return { erroring, zeroErrors };
}

/**
 * Services that fetch_logs found error-level lines (or exceptions) for.
 * In "all" mode the per-service breakdown says which; for a single service,
 * the result is that service.
 */
export function servicesWithErrorLogs(logsResults) {
  const out = new Set();
  for (const r of logsResults) {
    if (!r) continue;
    const errorish = r.level_filter === 'error' || (r.exception_count ?? 0) > 0;
    if (!errorish || !((r.total_matching_lines ?? 0) > 0)) continue;
    if (Array.isArray(r.by_service)) {
      for (const s of r.by_service) {
        if (s.lines > 0 && (r.level_filter === 'error' || s.exceptions > 0)) out.add(s.service);
      }
    } else if (r.service && r.service !== 'all') {
      out.add(r.service);
    }
  }
  return out;
}

/**
 * The cross-signal check the tools cannot do themselves (each reads one
 * system). Returns a note when error logs and metrics disagree: logs show
 * errors for a service that fetch_metrics reported with zero 5xx. The usual
 * reason is a pod that just restarted (arming the seeded fault does exactly
 * that): reset counters and too few scrapes for rate().
 */
export function metricsLagNote(metricsResults, logsResults) {
  if (!metricsResults.length) return null;
  const withLogs = servicesWithErrorLogs(logsResults);
  const { erroring } = errorEvidence(metricsResults);
  const measured = new Set(metricsResults.flatMap((r) => (r?.services ?? []).map((s) => s.service)));
  const lagging = [...withLogs].filter((s) => measured.has(s) && !erroring.has(s));
  if (!lagging.length) return null;
  return (
    `CROSS-CHECK: fetch_logs shows error lines for ${lagging.join(', ')}, but fetch_metrics reported 0 5xx ` +
    `for ${lagging.length === 1 ? 'it' : 'them'}. Metrics can lag a freshly started pod (counters reset; rate ` +
    'windows need a few scrapes). Treat the error logs as current evidence: this is NOT "no errors".'
  );
}

/**
 * Post-check on the final answer: a service with ZERO errors in fetch_metrics
 * must not be listed as affected. Observed with qwen2.5:7b on the seeded
 * `order` fault: it listed `orders` (the read service, no errors at all) in
 * the blast radius, apparently on the strength of the similar name.
 *
 * Only the "Blast radius" section is touched:
 *  - an "Affected services: a, b, c" line loses the zero-error names;
 *  - a bullet naming only zero-error services (and not saying they are
 *    unaffected) is removed.
 * A short note records what was removed, so the correction is visible rather
 * than silent. Services fetch_metrics never measured are left alone.
 *
 * @returns {{ answer: string, removed: string[] }}
 */
export function enforceBlastRadius(answer, metricsResults, logsResults = []) {
  const { erroring, zeroErrors } = errorEvidence(metricsResults, logsResults);
  if (!zeroErrors.length) return { answer, removed: [] };

  const lines = answer.split('\n');
  const isHeading = (l) => /^\s*#{1,6}\s/.test(l) || /^\s*\*\*[^*]+\*\*\s*:?\s*$/.test(l);
  const start = lines.findIndex((l) => isHeading(l) && /blast radius/i.test(l));
  if (start === -1) return { answer, removed: [] };
  let end = lines.findIndex((l, i) => i > start && isHeading(l));
  if (end === -1) end = lines.length;

  const mentions = (text, names) => names.filter((n) => serviceRe(n).test(text));
  const removed = new Set();
  const kept = [];

  for (const line of lines.slice(start + 1, end)) {
    const list = /^(.*?affected services?\**\s*[:\-–]\**\s*)(.+)$/i.exec(line);
    if (list) {
      const items = list[2].split(/\s*,\s*|\s+and\s+/).filter(Boolean);
      const keep = items.filter((item) => {
        const named = mentions(item, [...erroring, ...zeroErrors]);
        const drop = named.length > 0 && named.every((n) => zeroErrors.includes(n));
        if (drop) named.forEach((n) => removed.add(n));
        return !drop;
      });
      kept.push(keep.length ? `${list[1]}${keep.join(', ')}` : `${list[1]}(none with errors in fetch_metrics)`);
      continue;
    }
    if (/^\s*[-*]\s/.test(line) && !NEGATION.test(line)) {
      const bad = mentions(line, zeroErrors);
      if (bad.length && mentions(line, [...erroring]).length === 0) {
        bad.forEach((n) => removed.add(n));
        continue;
      }
    }
    kept.push(line);
  }

  if (!removed.size) return { answer, removed: [] };
  const names = [...removed].sort();
  // Trim trailing blank lines so the note sits with the section it corrects.
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  kept.push(
    `_Evidence check: removed ${names.join(', ')} from the blast radius - fetch_metrics shows zero errors for ` +
      `${names.length === 1 ? 'it' : 'them'}._`,
    '',
  );
  return { answer: [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)].join('\n'), removed: names };
}

// ---------------------------------------------------------------------------
// No-incident guard
// ---------------------------------------------------------------------------

/**
 * True when all three signals agree that nothing is failing right now:
 *  - metrics: every fetch_metrics result has zero 5xx in its window (4xx are
 *    client responses and do not count), and at least one service was scraped;
 *  - logs: at least one fetch_logs call at level "error" was made, and every
 *    error-level result is empty;
 *  - health: every fetch_health result has all pods Ready and no restart in
 *    the last 10 minutes.
 * Any missing signal -> false: the guard only fires on positive evidence.
 */
export function noIncidentEvidence({ metrics, logs, health }) {
  const m = metrics.length > 0
    && metrics.every((r) => (r.summary?.services_with_errors ?? []).length === 0
      && (r.services ?? []).every((s) => !(s.error_rate_percent > 0)))
    && metrics.some((r) => (r.services ?? []).some((s) => s.scrape_up));
  const errorLogs = logs.filter((r) => r.level_filter === 'error');
  // ANY error evidence in ANY log result vetoes the guard - including a
  // per-service query that found errors after an "all" query found none
  // (observed: the fault rolled out between the two calls).
  const anyErrorLines = logs.some(
    (r) => (r.exception_count ?? 0) > 0 || (r.level_filter === 'error' && (r.total_matching_lines ?? 0) > 0),
  );
  const l = !anyErrorLines && errorLogs.length > 0 && errorLogs.every((r) => (r.total_matching_lines ?? 0) === 0);
  const h = health.length > 0 && health.every((r) => {
    const s = r.summary ?? {};
    return s.total_pods > 0 && s.ready_pods === s.total_pods && (s.recent_restarts ?? 0) === 0;
  });
  return m && l && h;
}

/** The fixed answer used instead of the model's when the guard fires. */
export function noIncidentAnswer({ metrics, logs, health }) {
  const lastMetrics = metrics.at(-1);
  const measured = (lastMetrics?.services ?? []).map((s) => s.service);
  const client4xx = Object.entries(lastMetrics?.summary?.client_errors_4xx_since_pod_start ?? {});
  const logServices = [...new Set(logs.filter((r) => r.level_filter === 'error').map((r) => r.service))];
  const hs = health.at(-1)?.summary ?? {};

  return [
    '### Root cause',
    'No active incident found. None of the three signals shows a server-side failure right now.',
    '',
    '### Evidence',
    `- **Metrics:** ${measured.length} services measured (${measured.join(', ')}) over ${lastMetrics?.query_window ?? 'the window'}; ` +
      'no 5xx server errors on any service.' +
      (client4xx.length
        ? ` 4xx client responses since pod start (${client4xx.map(([s, n]) => `${s} ${n}`).join(', ')}) are ` +
          'requests the server correctly refused - not a failure.'
        : ''),
    `- **Logs:** no error-level lines for ${logServices.join(', ') || 'the services queried'}.`,
    `- **Health:** ${hs.ready_pods}/${hs.total_pods} pods ready, no restarts in the last 10 minutes.`,
    ...(lastMetrics?.summary?.recently_started_pods?.length
      ? [`- **Caution:** ${lastMetrics.summary.recently_started_pods.map((p) => `${p.service} pod started ${p.age_seconds}s ago`).join(', ')} - ` +
          'a change may still be rolling out and its errors may not be visible yet.']
      : []),
    '',
    '### Blast radius',
    '**Affected services:** none. No service is returning server errors.',
    '',
    '### Recommended fix',
    'No fix needed. If you just armed a fault, ArgoCD needs ~2–3 minutes to roll out; try again shortly.',
    '',
    '### Prevention',
    'Nothing to prevent. _This answer comes from Kira\'s no-incident guard, built directly from the tool ' +
      'results above; the model\'s own conclusion was not used because the evidence contains no failure._',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Turn limit: partial diagnosis
// ---------------------------------------------------------------------------

export const PARTIAL_MARK = '**Partial investigation (turn limit reached)**';

/** A deterministic five-heading answer from the evidence, if the model gives nothing. */
export function evidenceDigest({ metrics, logs, health }) {
  const { erroring } = errorEvidence(metrics);
  const withLogs = [...servicesWithErrorLogs(logs)];
  const topLog = logs.flatMap((r) => r?.messages ?? []).sort((a, b) => (b.has_stack_trace - a.has_stack_trace) || (b.count - a.count))[0];
  const hs = health.at(-1)?.summary;
  const affected = [...new Set([...erroring, ...withLogs])];
  return [
    '### Root cause',
    'Not determined - the model did not write a conclusion. The evidence gathered so far is below.',
    '',
    '### Evidence',
    `- **Metrics:** ${metrics.length ? (erroring.size ? `5xx on ${[...erroring].join(', ')}.` : 'no 5xx reported.') : 'not gathered.'}`,
    `- **Logs:** ${withLogs.length ? `error lines for ${withLogs.join(', ')}${topLog ? `; most significant: "${topLog.message}"${topLog.has_stack_trace ? ' (with stack trace)' : ''}` : ''}.` : logs.length ? 'no error lines found.' : 'not gathered.'}`,
    `- **Health:** ${hs ? `${hs.ready_pods}/${hs.total_pods} pods ready, ${hs.recent_restarts ?? 0} recent restarts.` : 'not gathered.'}`,
    '',
    '### Blast radius',
    `**Affected services:** ${affected.length ? affected.join(', ') : 'unknown'}`,
    '',
    '### Recommended fix',
    'Not determined. Start from the error logs above; re-run the investigation for a full diagnosis.',
    '',
    '### Prevention',
    'Not determined.',
  ].join('\n');
}

async function partialDiagnosis({ client, system, messages, trace, missing, evidence, verbose }) {
  messages.push({
    role: 'user',
    text:
      `TURN LIMIT REACHED (${config.maxTurns} turns). Do not call any more tools. Using ONLY the tool ` +
      'results already in this conversation, write your diagnosis now in exactly the five-heading format ' +
      '(Root cause, Evidence, Blast radius, Recommended fix, Prevention). Cite the values you have. Where ' +
      'the evidence is incomplete, say what is missing instead of guessing.',
  });
  let text = '';
  try {
    // No tools offered, so the only possible reply is text. (Anthropic
    // rejects a conversation containing tool_use blocks without the tool
    // definitions, so they stay declared there; any call is ignored below.)
    const res = await client.chat({ system, messages, tools: client.provider === 'anthropic' ? toolDefinitions : [] });
    trace.addUsage(res.usage);
    text = (res.text ?? '').trim();
    if (verbose && text) trace.say('[turn limit] final no-tool diagnosis');
  } catch {
    text = '';
  }
  if (!text) text = evidenceDigest(evidence);
  const header =
    `${PARTIAL_MARK} - all ${config.maxTurns} turns were used, so this was written from the evidence gathered so far` +
    (missing.length ? `; never called: ${missing.join(', ')}` : '') +
    '.';
  return `${header}\n\n${text}`;
}

/**
 * @param {object} opts
 * @param {object} [opts.client] Inject a model client. Used by the test suite
 *   to exercise the enforcement path deterministically: whether the loop
 *   refuses an unevidenced answer is OUR logic, and must not be tested by
 *   hoping a model misbehaves on cue.
 * @param {Function} [opts.runTool] Inject the tool executor, for the same
 *   reason: tests must not need Prometheus, Loki and a cluster.
 */
export async function investigate(
  incident,
  { verbose = true, client: injected, onEvent = () => {}, runTool: execTool = runTool } = {},
) {
  const client = injected ?? createModelClient();
  const trace = new Trace({
    incident,
    model: `${client.provider}:${client.model}`,
    pricePerMTok: client.pricePerMTok,
    onEvent,
  });
  const system = loadSystemPrompt();

  /** Provider-neutral conversation history. */
  const messages = [{ role: 'user', text: incident }];
  const called = new Set();
  /** callKey -> { turn, work: Promise<tool message>, result } for this investigation. */
  const fetched = new Map();
  /** Every successful fetch_metrics result, for the blast-radius check. */
  const metricsResults = [];
  /** Every successful fetch_logs / fetch_health result, for the no-incident guard. */
  const logsResults = [];
  const healthResults = [];
  /** Lag notes already shown to the model, so each is said once. */
  const lagNoted = new Set();
  let nudgesLeft = config.maxToolNudges;
  let answer = '';
  let turn = 0;
  let emptyTurns = 0;

  while (turn < config.maxTurns) {
    turn++;
    trace.turn(turn);

    const res = await client.chat({ system, messages, tools: toolDefinitions });
    trace.addUsage(res.usage);
    if (res.thinking && verbose) trace.thinking(res.thinking);

    messages.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls, raw: res.raw });

    // NOTE: detected by the PRESENCE of tool calls, never by a stop reason.
    // Ollama reports done_reason "stop" even while calling tools, so branching
    // on the stop reason would end the loop after the very first call.
    if (res.toolCalls.length > 0) {
      emptyTurns = 0;
      if (res.text && verbose) trace.say(res.text);

      // Identical calls (same tool, same arguments) are executed ONCE per
      // investigation. Observed with qwen2.5:7b on the seeded fault:
      // fetch_metrics(service=all, 15m) three turns running, with identical
      // arguments. Re-querying minutes apart adds nothing to a diagnosis that
      // takes a minute, and it burns turns a 7B model needs for logs and
      // health. So:
      //  - same turn: the duplicates share one execution, silently (each
      //    tool_use_id still gets its own result - the protocol requires it);
      //  - later turn: the cached result is returned, prefixed with an
      //    "ALREADY FETCHED" note so the model is told to move on, and the
      //    trace records it as a cached call.
      // Failures are never cached, so a retry after an error really runs.
      // Fresher data is still one argument away (e.g. a different time_range).
      const results = await Promise.all(
        res.toolCalls.map(async (call) => {
          const key = callKey(call.name, call.args);
          const prior = fetched.get(key);
          if (prior) {
            const shared = await prior.work;
            if (prior.turn === turn || shared.isError) return { ...shared, toolCallId: call.id };
            const handle = trace.toolStart(call.name, call.args);
            trace.toolEnd(handle, {
              ok: true,
              result: prior.result,
              summary: `already fetched in turn ${prior.turn} - cached result returned`,
              cached: true,
            });
            return { ...shared, toolCallId: call.id, content: alreadyFetched(shared.content, prior.turn) };
          }

          const handle = trace.toolStart(call.name, call.args);
          const invalid = validateArgs(call.name, call.args);
          if (invalid) {
            trace.toolEnd(handle, { ok: false, error: invalid });
            // Handed back to the model so it can retry with correct arguments,
            // rather than aborting the investigation.
            return { role: 'tool', toolCallId: call.id, name: call.name, isError: true, content: `Error: ${invalid}` };
          }
          const entry = { turn, result: undefined, work: null };
          // Registered BEFORE the work starts, so a same-turn duplicate finds it
          // and a synchronous failure's delete below is not undone.
          fetched.set(key, entry);
          // Never rejects: a same-turn duplicate awaits this too, and a
          // rejection escaping Promise.all would abort the whole investigation.
          entry.work = (async () => {
            try {
              const result = await execTool(call.name, call.args);
              entry.result = result;
              called.add(call.name);
              if (call.name === 'fetch_metrics') metricsResults.push(result);
              if (call.name === 'fetch_logs') logsResults.push(result);
              if (call.name === 'fetch_health') healthResults.push(result);
              trace.toolEnd(handle, { ok: true, result, summary: summarise(call.name, result) });
              // Logs vs metrics disagreement (see metricsLagNote): tell the
              // model on whichever result arrives second.
              const lag =
                call.name === 'fetch_logs' || call.name === 'fetch_metrics'
                  ? metricsLagNote(metricsResults, logsResults)
                  : null;
              const content = JSON.stringify(result) + (lag && !lagNoted.has(lag) ? `
${lag}` : '');
              if (lag) lagNoted.add(lag);
              return { role: 'tool', toolCallId: call.id, name: call.name, content };
            } catch (err) {
              fetched.delete(key); // do not cache failures
              trace.toolEnd(handle, { ok: false, error: err.message });
              // A data source being unreachable is itself diagnostic information.
              // Kira should be able to say so, not die with a stack trace.
              return { role: 'tool', toolCallId: call.id, name: call.name, isError: true, content: `Tool failed: ${err.message}` };
            }
          })();
          return entry.work;
        }),
      );
      messages.push(...results);
      continue;
    }

    // ---- No tool calls: the model is trying to conclude -------------------
    if (!res.text.trim()) {
      // Neither text nor tool calls. Usually a small model losing the thread.
      if (++emptyTurns > 2) {
        // Used to THROW, so the caller got an error and no answer at all.
        // Observed live once (a transient Ollama state: three empty replies
        // in a row). Return what the evidence shows instead, clearly marked.
        answer =
          '**Investigation aborted: the model returned empty responses three turns running** ' +
          '(often a transient model-server state; re-run the investigation). Evidence gathered so far:\n\n' +
          evidenceDigest({ metrics: metricsResults, logs: logsResults, health: healthResults });
        break;
      }
      messages.push({ role: 'user', text: 'You returned an empty response. Call the tools you still need, or give your final answer.' });
      continue;
    }

    const missing = REQUIRED_TOOLS.filter((t) => !called.has(t));
    if (missing.length === 0) {
      // No-incident guard. Observed with qwen2.5:7b before a fault was armed:
      // metrics "no errors", error logs empty, pods healthy - and it still
      // blamed `order`, citing 401s as "propagated errors". When all three
      // signals say nothing is failing, the model's conclusion is discarded
      // and a fixed, evidence-only answer is returned instead.
      const evidence = { metrics: metricsResults, logs: logsResults, health: healthResults };
      if (noIncidentEvidence(evidence)) {
        if (verbose) trace.say('[no-incident guard] all three signals are clean; model conclusion discarded');
        answer = noIncidentAnswer(evidence);
      } else {
        answer = res.text;
      }
      break;
    }

    if (nudgesLeft > 0) {
      nudgesLeft--;
      trace.nudge(missing, nudgesLeft);
      // Explicit and mechanical. A vague "please use your tools" is routinely
      // ignored by a 7B model; naming the exact tools and forbidding a
      // conclusion is what actually lands.
      messages.push({
        role: 'user',
        text:
          `STOP. You have not called: ${missing.join(', ')}. ` +
          'Your instructions require all three signals before any conclusion, because each one is ' +
          'misleading alone. Do not answer yet. Call the missing tool(s) now.',
      });
      continue;
    }

    // Out of nudges: fail loudly rather than return an unevidenced answer.
    answer =
      res.text +
      `\n\n[INCOMPLETE INVESTIGATION] Never called: ${missing.join(', ')}. ` +
      'This diagnosis is not supported by all three signals and must not be trusted.';
    break;
  }

  // Turn limit reached without a conclusion. Observed: qwen2.5:7b queried
  // every service's logs one by one and ran out of turns, returning nothing.
  // The evidence gathered by then is usually enough, so ask once more - no
  // tools - for the diagnosis from what is already in the conversation.
  if (!answer) {
    const missing = REQUIRED_TOOLS.filter((t) => !called.has(t));
    const evidence = { metrics: metricsResults, logs: logsResults, health: healthResults };
    if (missing.length === 0 && noIncidentEvidence(evidence)) {
      answer = noIncidentAnswer(evidence);
    } else {
      answer = await partialDiagnosis({ client, system, messages, trace, missing, evidence, verbose });
    }
  }

  // Evidence check: nothing with zero errors in fetch_metrics stays in the
  // blast radius. See enforceBlastRadius().
  answer = enforceBlastRadius(answer, metricsResults, logsResults).answer;

  const summary = trace.finish(answer);
  onEvent({ type: 'answer', answer, ...summary });
  return { answer, trace: summary, turns: turn };
}
