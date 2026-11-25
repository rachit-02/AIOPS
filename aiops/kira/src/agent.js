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
export function errorEvidence(metricsResults) {
  const seen = new Set();
  const erroring = new Set();
  for (const r of metricsResults) {
    for (const s of r?.services ?? []) {
      seen.add(s.service);
      const fiveXX = (s.status_counts_since_pod_start ?? []).some((c) => String(c.status).startsWith('5') && c.count > 0);
      if (s.error_rate_percent > 0 || fiveXX) erroring.add(s.service);
    }
  }
  const zeroErrors = [...seen].filter((s) => !erroring.has(s));
  return { erroring, zeroErrors };
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
export function enforceBlastRadius(answer, metricsResults) {
  const { erroring, zeroErrors } = errorEvidence(metricsResults);
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
              trace.toolEnd(handle, { ok: true, result, summary: summarise(call.name, result) });
              return { role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result) };
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
      if (++emptyTurns > 2) throw new Error('Model returned empty responses three turns running; aborting.');
      messages.push({ role: 'user', text: 'You returned an empty response. Call the tools you still need, or give your final answer.' });
      continue;
    }

    const missing = REQUIRED_TOOLS.filter((t) => !called.has(t));
    if (missing.length === 0) {
      answer = res.text;
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

  if (turn >= config.maxTurns) answer += `\n\n[stopped: hit the ${config.maxTurns}-turn limit]`;

  // Evidence check: nothing with zero errors in fetch_metrics stays in the
  // blast radius. See enforceBlastRadius().
  answer = enforceBlastRadius(answer, metricsResults).answer;

  const summary = trace.finish(answer);
  onEvent({ type: 'answer', answer, ...summary });
  return { answer, trace: summary, turns: turn };
}
