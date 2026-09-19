/**
 * Kira's agentic loop.
 *
 * WHY A HAND-WRITTEN LOOP RATHER THAN THE SDK's TOOL RUNNER
 * The SDK provides `client.beta.messages.tool_runner`, which would drive this
 * automatically and in less code. This loop is written out deliberately:
 *   - the whole point of the project is demonstrating the agentic pattern, and
 *     a loop you can read is a loop you can defend in a viva;
 *   - every tool call has to be visible in a trace with its arguments, which
 *     is most direct when we own the dispatch;
 *   - it avoids depending on a beta API surface.
 * The trade is that error handling and message bookkeeping are ours to get
 * right - which is what the comments below are about.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

import { config } from './config.js';
import { toolDefinitions, runTool, summarise } from './tools/index.js';
import { Trace } from './trace.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The system prompt lives in a reviewable Markdown file, never inline. */
export function loadSystemPrompt() {
  return readFileSync(join(HERE, '..', 'prompts', 'kira-system-prompt.md'), 'utf8');
}

export async function investigate(incident, { model = config.model, verbose = true } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. export it, or put it in aiops/kira/.env');
  }

  const client = new Anthropic();
  const trace = new Trace({ incident, model });
  const system = loadSystemPrompt();

  const messages = [{ role: 'user', content: incident }];
  let answer = '';
  let turn = 0;

  while (turn < config.maxTurns) {
    turn++;
    trace.turn(turn);

    const response = await client.messages.create({
      model,
      max_tokens: config.maxTokens,
      // Cached prefix: the system prompt and tool definitions are byte-identical
      // on every turn and every run, so after the first call they are read from
      // cache rather than re-billed at full rate. Render order is
      // tools -> system -> messages, so a breakpoint here covers both.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: toolDefinitions,
      messages,
      // Adaptive thinking: Claude decides how much to reason per turn. Root
      // cause analysis across three correlated sources is exactly the kind of
      // work that benefits. `summarized` surfaces a readable version of that
      // reasoning so the trace shows HOW she got there, not just the answer -
      // without it, Sonnet 5 returns empty thinking blocks by default.
      thinking: { type: 'adaptive', display: 'summarized' },
    });

    trace.addUsage(response.usage);

    // Guard before reading content: a refused turn returns HTTP 200 with no
    // usable body, and blindly indexing into content would throw something
    // unhelpful.
    if (response.stop_reason === 'refusal') {
      throw new Error(`Model declined the request (${response.stop_details?.category ?? 'unspecified'}).`);
    }

    // The assistant turn must be appended WHOLE - including thinking blocks.
    // Reconstructing it from just the text would discard the thinking blocks,
    // which must be echoed back unchanged for the next turn on the same model.
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = [];
    for (const block of response.content) {
      if (block.type === 'thinking' && verbose) trace.thinking(block.thinking);
      else if (block.type === 'text') {
        answer = block.text; // last text block wins; on the final turn this is the diagnosis
        if (verbose && response.stop_reason === 'tool_use') trace.say(block.text);
      } else if (block.type === 'tool_use') toolUses.push(block);
    }

    if (response.stop_reason !== 'tool_use') break;

    // Execute every requested tool. Claude may ask for several at once; running
    // them concurrently is both faster and the behaviour the API expects.
    const results = await Promise.all(
      toolUses.map(async (block) => {
        const handle = trace.toolStart(block.name, block.input);
        try {
          const result = await runTool(block.name, block.input);
          trace.toolEnd(handle, { ok: true, result, summary: summarise(block.name, result) });
          return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
        } catch (err) {
          trace.toolEnd(handle, { ok: false, error: err.message });
          // Report the failure back to the model rather than aborting. A data
          // source being unreachable is itself diagnostic information, and
          // Claude can say so instead of the run dying with a stack trace.
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            is_error: true,
            content: `Tool failed: ${err.message}`,
          };
        }
      }),
    );

    // ALL tool results go back in ONE user message. Splitting them across
    // several messages is accepted by the API but teaches the model to stop
    // making parallel calls.
    messages.push({ role: 'user', content: results });
  }

  if (turn >= config.maxTurns) {
    answer += `\n\n[stopped: hit the ${config.maxTurns}-turn limit]`;
  }

  const summary = trace.finish(answer);
  return { answer, trace: summary, turns: turn };
}
