/**
 * Investigation trace: makes Kira's reasoning auditable.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 * An agent that only prints its conclusion is indistinguishable from an agent
 * that guessed. The trace records every tool call, its exact arguments, how
 * long it took and what came back - so a reader can check that the conclusion
 * was actually derived from the three data sources, and can re-run the same
 * queries by hand.
 *
 * Two outputs, deliberately:
 *   - a readable console stream, for watching an investigation live
 *   - a JSON file per run, for attaching as evidence after the fact
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRACE_DIR = join(HERE, '..', 'traces');

// Per-provider token price, supplied by the model client. Local inference is
// {input: 0, output: 0}, which is reported as "free" rather than "$0.0000" so
// the distinction is unmistakable.

const c = process.stdout.isTTY
  ? { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', reset: '\x1b[0m' }
  : { dim: '', bold: '', cyan: '', green: '', red: '', yellow: '', reset: '' };

export class Trace {
  constructor({ incident, model, pricePerMTok = { input: 0, output: 0 } }) {
    this.startedAt = new Date();
    this.incident = incident;
    this.model = model;
    this.pricePerMTok = pricePerMTok;
    this.turns = [];
    this.toolCalls = [];
    this.nudges = [];
    this.usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    this.answer = null;

    console.log(`\n${c.bold}${'='.repeat(74)}${c.reset}`);
    console.log(`${c.bold}  KIRA — incident investigation${c.reset}`);
    console.log(`${'='.repeat(74)}`);
    console.log(`  ${c.dim}model    ${c.reset}${model}`);
    console.log(`  ${c.dim}incident ${c.reset}${incident}`);
    console.log(`  ${c.dim}started  ${c.reset}${this.startedAt.toISOString()}`);
  }

  turn(n) {
    this.currentTurn = n;
    console.log(`\n${c.dim}${'─'.repeat(28)} turn ${n} ${'─'.repeat(28)}${c.reset}`);
  }

  /** Claude's own summarised reasoning, when display:"summarized" is enabled. */
  thinking(text) {
    if (!text?.trim()) return;
    this.turns.push({ turn: this.currentTurn, type: 'thinking', text });
    const wrapped = text.trim().split('\n').map((l) => `  ${c.dim}│${c.reset} ${l}`).join('\n');
    console.log(`  ${c.cyan}[reasoning]${c.reset}\n${wrapped}`);
  }

  /** Narration Claude emits alongside tool calls. */
  say(text) {
    if (!text?.trim()) return;
    this.turns.push({ turn: this.currentTurn, type: 'text', text });
    console.log(`  ${c.dim}[says]${c.reset} ${text.trim().split('\n')[0].slice(0, 160)}`);
  }

  toolStart(name, args) {
    console.log(`  ${c.yellow}▶ TOOL${c.reset} ${c.bold}${name}${c.reset}`);
    console.log(`    ${c.dim}args${c.reset}  ${JSON.stringify(args)}`);
    return { name, args, startedAt: Date.now() };
  }

  toolEnd(handle, { ok, result, error, summary }) {
    const ms = Date.now() - handle.startedAt;
    const record = {
      turn: this.currentTurn,
      tool: handle.name,
      arguments: handle.args,
      duration_ms: ms,
      ok,
      // The FULL result is kept in the JSON trace, so a reader can verify the
      // conclusion against exactly what the tool returned.
      result: ok ? result : undefined,
      error: ok ? undefined : error,
    };
    this.toolCalls.push(record);
    if (ok) console.log(`    ${c.green}✓${c.reset} ${ms}ms  ${c.dim}→${c.reset} ${summary}`);
    else console.log(`    ${c.red}✗${c.reset} ${ms}ms  ${c.red}${error}${c.reset}`);
    return record;
  }

  /**
   * Recorded when the model tried to conclude before gathering all three
   * signals. Visible in the trace ON PURPOSE: it is the clearest evidence of
   * the difference in tool-calling reliability between models, and a run that
   * needed nudging is a weaker result than one that did not.
   */
  nudge(missing, remaining) {
    this.nudges.push({ turn: this.currentTurn, missing: [...missing], remaining });
    console.log(
      `  ${c.yellow}! NUDGE${c.reset} model tried to conclude without: ${c.bold}${missing.join(', ')}${c.reset}` +
        `  ${c.dim}(${remaining} retr${remaining === 1 ? 'y' : 'ies'} left)${c.reset}`,
    );
  }

  addUsage(u) {
    if (!u) return;
    for (const k of Object.keys(this.usage)) this.usage[k] += u[k] ?? 0;
  }

  finish(answer) {
    this.answer = answer;
    const durationMs = Date.now() - this.startedAt.getTime();
    const byTool = {};
    for (const t of this.toolCalls) byTool[t.tool] = (byTool[t.tool] || 0) + 1;

    const REQUIRED = ['fetch_metrics', 'fetch_logs', 'fetch_health'];
    const missing = REQUIRED.filter((t) => !byTool[t]);
    const cost =
      (this.usage.input_tokens / 1e6) * this.pricePerMTok.input +
      (this.usage.output_tokens / 1e6) * this.pricePerMTok.output;
    const costLabel = this.pricePerMTok.input === 0 && this.pricePerMTok.output === 0
      ? 'free (local inference)'
      : `~$${cost.toFixed(4)}`;

    console.log(`\n${c.bold}${'='.repeat(74)}${c.reset}`);
    console.log(`${c.bold}  DIAGNOSIS${c.reset}`);
    console.log(`${'='.repeat(74)}\n`);
    console.log(answer);

    console.log(`\n${c.bold}${'='.repeat(74)}${c.reset}`);
    console.log(`${c.bold}  TRACE SUMMARY${c.reset}  ${c.dim}(what the diagnosis was actually built from)${c.reset}`);
    console.log(`${'='.repeat(74)}`);
    for (const t of this.toolCalls) {
      console.log(`  ${t.ok ? c.green + '✓' : c.red + '✗'}${c.reset} turn ${t.turn}  ${t.tool.padEnd(15)} ${JSON.stringify(t.arguments)}`);
    }
    // The headline check: an answer produced without all three signals is not
    // a correlation, whatever it claims. Printed pass/fail, not buried.
    console.log(
      missing.length === 0
        ? `\n  ${c.green}ALL THREE SIGNALS USED${c.reset} — metrics, logs and health each queried independently.`
        : `\n  ${c.red}INCOMPLETE — never called: ${missing.join(', ')}${c.reset}`,
    );
    if (this.nudges.length) {
      console.log(
        `  ${c.yellow}${this.nudges.length} nudge(s) needed${c.reset} ${c.dim}- the model tried to conclude early; ` +
          `a frontier model typically needs none.${c.reset}`,
      );
    }
    console.log(`  ${c.dim}turns    ${c.reset}${this.currentTurn}   ${c.dim}tool calls ${c.reset}${this.toolCalls.length}   ${c.dim}wall time ${c.reset}${(durationMs / 1000).toFixed(1)}s`);
    console.log(
      `  ${c.dim}tokens   ${c.reset}in ${this.usage.input_tokens.toLocaleString()} ` +
        `(cache read ${this.usage.cache_read_input_tokens.toLocaleString()})  ` +
        `out ${this.usage.output_tokens.toLocaleString()}   ${c.dim}${costLabel}${c.reset}`,
    );

    mkdirSync(TRACE_DIR, { recursive: true });
    const file = join(TRACE_DIR, `${this.startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          incident: this.incident,
          model: this.model,
          started_at: this.startedAt.toISOString(),
          duration_ms: durationMs,
          turns: this.turns,
          tool_calls: this.toolCalls,
          all_three_signals_used: missing.length === 0,
          missing_tools: missing,
          nudges: this.nudges,
          usage: this.usage,
          estimated_cost_usd: Number(cost.toFixed(4)),
          cost_label: costLabel,
          answer,
        },
        null,
        2,
      ),
    );
    console.log(`  ${c.dim}trace    ${c.reset}${file}\n`);
    return { allThreeUsed: missing.length === 0, missing, file, cost, durationMs, nudgeCount: this.nudges.length };
  }
}
