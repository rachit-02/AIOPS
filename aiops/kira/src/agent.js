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

/**
 * @param {object} opts
 * @param {object} [opts.client] Inject a model client. Used by the test suite
 *   to exercise the enforcement path deterministically: whether the loop
 *   refuses an unevidenced answer is OUR logic, and must not be tested by
 *   hoping a model misbehaves on cue.
 */
export async function investigate(incident, { verbose = true, client: injected } = {}) {
  const client = injected ?? createModelClient();
  const trace = new Trace({ incident, model: `${client.provider}:${client.model}`, pricePerMTok: client.pricePerMTok });
  const system = loadSystemPrompt();

  /** Provider-neutral conversation history. */
  const messages = [{ role: 'user', text: incident }];
  const called = new Set();
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

      const results = await Promise.all(
        res.toolCalls.map(async (call) => {
          const handle = trace.toolStart(call.name, call.args);
          const invalid = validateArgs(call.name, call.args);
          if (invalid) {
            trace.toolEnd(handle, { ok: false, error: invalid });
            // Handed back to the model so it can retry with correct arguments,
            // rather than aborting the investigation.
            return { role: 'tool', toolCallId: call.id, name: call.name, isError: true, content: `Error: ${invalid}` };
          }
          try {
            const result = await runTool(call.name, call.args);
            called.add(call.name);
            trace.toolEnd(handle, { ok: true, result, summary: summarise(call.name, result) });
            return { role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result) };
          } catch (err) {
            trace.toolEnd(handle, { ok: false, error: err.message });
            // A data source being unreachable is itself diagnostic information.
            // Kira should be able to say so, not die with a stack trace.
            return { role: 'tool', toolCallId: call.id, name: call.name, isError: true, content: `Tool failed: ${err.message}` };
          }
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

  const summary = trace.finish(answer);
  return { answer, trace: summary, turns: turn };
}
