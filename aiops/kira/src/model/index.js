/**
 * Model provider seam.
 *
 * Everything above this line in the stack — the agent loop, the three tools,
 * the system prompt, the trace — is provider-agnostic. Swapping the model is
 * therefore a one-line change, which is exactly the claim the README makes.
 *
 *   KIRA_PROVIDER=ollama     (default)  local qwen2.5:7b, free
 *   KIRA_PROVIDER=anthropic             claude-sonnet-5, needs an API key
 *
 * Every client returns the same normalised shape:
 *   { text, thinking?, toolCalls: [{id, name, args}], usage, raw? }
 */
import { config } from '../config.js';
import { createOllamaClient } from './ollama.js';
import { createAnthropicClient } from './anthropic.js';

export function createModelClient(provider = config.provider) {
  switch (provider) {
    case 'ollama':
      return createOllamaClient();
    case 'anthropic':
      return createAnthropicClient();
    default:
      throw new Error(`unknown KIRA_PROVIDER "${provider}" (expected "ollama" or "anthropic")`);
  }
}
