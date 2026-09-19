/**
 * Anthropic model client — optional, and the better choice when available.
 *
 * Kept behind the same interface as the Ollama client so the README's
 * recommendation ("use Sonnet 5 if you have API access") is something you can
 * actually act on with one environment variable, rather than advice the code
 * cannot honour:
 *
 *     KIRA_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm start
 *
 * It also keeps the architecture claim honest: swapping the model really does
 * touch only this directory.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

/** Kira's neutral history -> Anthropic messages. */
function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      // Anthropic requires every tool_result in ONE user message per turn.
      // Coalesce consecutive tool messages into the same block.
      const prev = out[out.length - 1];
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.isError && { is_error: true }) };
      if (prev?.role === 'user' && Array.isArray(prev.content) && prev.content[0]?.type === 'tool_result') prev.content.push(block);
      else out.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant') {
      // Replay the ORIGINAL content blocks when we have them: thinking blocks
      // must be echoed back unchanged on the same model, and rebuilding the
      // turn from text alone would discard them.
      out.push({ role: 'assistant', content: m.raw ?? m.text ?? '' });
    } else {
      out.push({ role: 'user', content: m.text ?? m.content ?? '' });
    }
  }
  return out;
}

export function createAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('KIRA_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.');
  }
  const client = new Anthropic();

  return {
    provider: 'anthropic',
    model: config.anthropicModel,
    pricePerMTok: { input: 2.0, output: 10.0 }, // claude-sonnet-5 list price

    async chat({ system, messages, tools }) {
      const res = await client.messages.create({
        model: config.anthropicModel,
        max_tokens: config.maxTokens,
        // Stable prefix (system + tools) is cached after the first call.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: tools.map((t) => ({ ...t, strict: true })),
        messages: toAnthropicMessages(messages),
        // `summarized` puts readable reasoning in the trace; without it this
        // model returns empty thinking blocks.
        thinking: { type: 'adaptive', display: 'summarized' },
      });

      if (res.stop_reason === 'refusal') {
        throw new Error(`Model declined the request (${res.stop_details?.category ?? 'unspecified'}).`);
      }

      let text = '';
      let thinking = '';
      const toolCalls = [];
      for (const b of res.content) {
        if (b.type === 'text') text = b.text;
        else if (b.type === 'thinking') thinking += b.thinking ?? '';
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, args: b.input });
      }
      return { text, thinking, toolCalls, usage: res.usage, raw: res.content };
    },
  };
}
