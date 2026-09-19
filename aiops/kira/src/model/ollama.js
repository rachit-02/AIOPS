/**
 * Ollama model client — the default, and free.
 *
 * Translates Kira's provider-neutral conversation into Ollama's /api/chat
 * shape and back. NOTHING about the agent, the tools or the system prompt
 * changes when this is swapped for the Anthropic client; that is the point of
 * the seam.
 *
 * FOUR DIFFERENCES FROM THE ANTHROPIC API THAT MATTER HERE:
 *
 * 1. `done_reason` is "stop" EVEN WHEN the model is calling tools. There is no
 *    equivalent of Anthropic's `stop_reason: "tool_use"`. Tool use must be
 *    detected by the PRESENCE of `message.tool_calls` — branching on the stop
 *    reason silently ends the loop after the first tool call.
 * 2. Tool schemas are OpenAI-shaped (`{type:"function", function:{parameters}}`)
 *    rather than Anthropic's flat `input_schema`.
 * 3. `function.arguments` arrives as a real object, not a JSON string — but not
 *    dependably, so both are handled.
 * 4. There is no thinking block and no prompt caching. Local inference is free,
 *    so neither costs anything; it just means less visible reasoning in the
 *    trace than Sonnet 5 gives.
 */
import { config } from '../config.js';

/** Anthropic-style tool definition -> Ollama/OpenAI function schema. */
function toOllamaTool(t) {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      // `strict` has no Ollama equivalent and is dropped. Argument validation
      // therefore has to happen on our side — see validateArgs in agent.js.
      parameters: t.input_schema,
    },
  };
}

/** Kira's neutral history -> Ollama messages. */
function toOllamaMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') {
      // Ollama expects tool output as its own message. `tool_name` helps
      // smaller models keep track of which result belongs to which call;
      // older Ollama builds ignore the extra field harmlessly.
      out.push({ role: 'tool', tool_name: m.name, content: m.content });
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.text || '',
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          function: { name: c.name, arguments: c.args },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.text ?? m.content ?? '' });
    }
  }
  return out;
}

export function createOllamaClient() {
  return {
    provider: 'ollama',
    model: config.ollamaModel,
    /** Local inference is free; reported so the trace can say so explicitly. */
    pricePerMTok: { input: 0, output: 0 },

    async chat({ system, messages, tools }) {
      let res;
      try {
        res = await fetch(`${config.ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: config.ollamaModel,
            messages: toOllamaMessages(system, messages),
            tools: tools.map(toOllamaTool),
            stream: false,
            options: {
              // Ollama's default context is far smaller than this model
              // supports. Left at the default, the system prompt plus three
              // tool results silently overflow and the tail — which is where
              // the evidence is — gets dropped. Set it explicitly.
              num_ctx: config.ollamaNumCtx,
              // Diagnosis should be reproducible and literal, not creative.
              temperature: 0,
            },
          }),
          // A 7B model on CPU is slow, and a cold start reloads ~5GB from disk.
          signal: AbortSignal.timeout(config.ollamaTimeoutMs),
        });
      } catch (err) {
        if (err.name === 'TimeoutError') {
          throw new Error(
            `Ollama did not respond within ${config.ollamaTimeoutMs / 1000}s. ` +
              'A cold start loads ~5GB; if memory is tight it may be swapping. ' +
              'Check `curl localhost:11434/api/ps` and free some RAM.',
          );
        }
        throw new Error(`Cannot reach Ollama at ${config.ollamaUrl}: ${err.message}`);
      }

      if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = await res.json();
      const msg = body.message ?? {};

      const toolCalls = (msg.tool_calls ?? []).map((c, i) => {
        let args = c.function?.arguments ?? {};
        // Usually an object, occasionally a JSON string. Tolerate both rather
        // than crashing the run on a formatting quirk.
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = { __unparseable: args };
          }
        }
        return { id: c.id || `call_${i}`, name: c.function?.name, args };
      });

      return {
        text: msg.content ?? '',
        toolCalls,
        // Ollama reports token counts under different names; normalised so the
        // trace does not need to know which provider produced them.
        usage: {
          input_tokens: body.prompt_eval_count ?? 0,
          output_tokens: body.eval_count ?? 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    },
  };
}
