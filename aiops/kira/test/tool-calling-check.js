/**
 * TOOL-CALLING SMOKE TEST — run this BEFORE the real incident demo.
 *
 * A 7B model is much less reliable at tool use than a frontier model, and the
 * failure mode is quiet: it answers plausibly from the system prompt instead
 * of calling anything. Debugging that inside a full investigation is painful,
 * because there are three tools, a live cluster and a long prompt all in play.
 *
 * This isolates the mechanism with stub tools and no cluster dependency, and
 * answers four questions in order:
 *
 *   1. Does the model emit a tool call at all?
 *   2. Does it pass correct arguments?
 *   3. Does it chain — call a tool, read the result, then call another?
 *   4. Does the loop's enforcement actually FIRE when the model tries to
 *      conclude early? (Tested by forbidding tool use, so the answer must be
 *      "the run was marked incomplete".)
 *
 *   node test/tool-calling-check.js
 */
import { createModelClient } from '../src/model/index.js';
import { config } from '../src/config.js';

const STUB_TOOLS = [
  {
    name: 'fetch_metrics',
    description: 'Query Prometheus for a service\'s HTTP error rate and request rate.',
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'service name, or "all"' },
        time_range: { type: 'string', description: 'e.g. "15m"' },
      },
      required: ['service'],
      additionalProperties: false,
    },
  },
  {
    name: 'fetch_logs',
    description: 'Query Loki for a service\'s error logs and stack traces.',
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'service name' },
        level: { type: 'string', enum: ['error', 'warn', 'info', 'all'] },
      },
      required: ['service'],
      additionalProperties: false,
    },
  },
];

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log(`        ${detail}`);
};

const client = createModelClient();
console.log(`\nTool-calling check — ${client.provider}:${client.model}\n`);

// ---- 1 & 2: emits a call, with correct arguments ---------------------------
{
  const r = await client.chat({
    system: 'You are an SRE. You must use tools to answer; never guess.',
    messages: [{ role: 'user', text: 'What is the error rate of the "order" service over the last 15 minutes?' }],
    tools: STUB_TOOLS,
  });
  const call = r.toolCalls[0];
  record('1. emits a tool call', r.toolCalls.length > 0, call ? `called ${call.name}` : `no call; said: "${r.text.slice(0, 80)}"`);
  record(
    '2. picks the right tool with the right argument',
    call?.name === 'fetch_metrics' && call?.args?.service === 'order',
    call ? `args=${JSON.stringify(call.args)}` : 'n/a',
  );
}

// ---- 3: chains a second call after seeing a result -------------------------
{
  const first = { id: 'call_1', name: 'fetch_metrics', args: { service: 'order', time_range: '15m' } };
  const r = await client.chat({
    system:
      'You are an SRE. You must gather BOTH metrics and logs before concluding. ' +
      'Metrics tell you WHERE a failure is; only logs tell you WHY.',
    messages: [
      { role: 'user', text: 'Investigate the order service and tell me the root cause.' },
      { role: 'assistant', text: '', toolCalls: [first] },
      {
        role: 'tool',
        toolCallId: 'call_1',
        name: 'fetch_metrics',
        content: JSON.stringify({ service: 'order', error_rate_percent: 50, note: 'High error rate. Logs will show why.' }),
      },
    ],
    tools: STUB_TOOLS,
  });
  const names = r.toolCalls.map((c) => c.name);
  record(
    '3. chains: reads a result, then calls the next tool',
    names.includes('fetch_logs'),
    names.length ? `then called: ${names.join(', ')}` : `stopped and answered: "${r.text.slice(0, 80)}"`,
  );
}

// ---- 4: enforcement fires when the model concludes early -------------------
// Tested with a STUB client that always answers without calling tools.
//
// An earlier version induced this by telling the real model "do not use
// tools" - which stopped working the moment the prompt was cleaned up and the
// model started behaving correctly. Whether the loop refuses an unevidenced
// answer is OUR logic; it must be deterministic, not contingent on a 7B model
// misbehaving on cue.
{
  const { investigate } = await import('../src/agent.js');
  const stub = {
    provider: 'stub',
    model: 'always-answers-without-tools',
    pricePerMTok: { input: 0, output: 0 },
    async chat() {
      return {
        text: 'The order service is broken because of a null shipping address.',
        toolCalls: [],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    },
  };

  const { answer, trace } = await investigate('Investigate the incident.', { verbose: false, client: stub });
  const refused = trace.allThreeUsed === false && /INCOMPLETE INVESTIGATION/.test(answer);
  record(
    '4. enforcement refuses a toolless answer',
    refused,
    refused
      ? `marked incomplete; missing: ${trace.missing.join(', ')}`
      : 'an answer with no tool calls was accepted - the guard is not working',
  );

  // The nudges must actually have been attempted before giving up, otherwise
  // the guard is failing fast rather than genuinely retrying.
  record(
    '5. retries before giving up',
    trace.nudgeCount === config.maxToolNudges,
    `${trace.nudgeCount} nudge(s) issued, expected ${config.maxToolNudges}`,
  );
}

const failed = results.filter((r) => !r.pass);
console.log(
  failed.length === 0
    ? `\nAll ${results.length} checks passed — tool calling works with this model.\n`
    : `\n${failed.length}/${results.length} checks FAILED: ${failed.map((f) => f.name).join('; ')}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
