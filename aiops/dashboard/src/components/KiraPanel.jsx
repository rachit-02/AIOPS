import { useEffect, useRef, useState } from 'react';
import { investigate } from '../lib/api.js';

/**
 * Kira's panel — a terminal/log stream, not a chat bubble UI.
 *
 * The reveal is the one deliberate motion moment in the product: tool calls
 * arrive one line at a time as they genuinely execute, then the report renders.
 * Crucially this is NOT a typewriter effect on pre-fetched text — each line
 * appears at the moment the server emits it over SSE, so the pacing is the real
 * latency of a real investigation. A spinner would have hidden exactly the part
 * worth watching: which tools she chose, with which arguments, and in what order.
 */

function ToolLine({ e }) {
  const args = Object.entries(e.args ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return (
    <div className="mb-[3px] whitespace-pre-wrap break-words" style={{ color: 'var(--text-dim)' }}>
      <span style={{ color: 'var(--signal-warn)' }}>calling</span> {e.tool}({args})
      {e.pending && <span className="cursor" aria-hidden="true" />}
    </div>
  );
}

function ResultLine({ e }) {
  return (
    <div className="mb-[3px] whitespace-pre-wrap break-words pl-[14px]" style={{ color: 'var(--text-dim)' }}>
      → {e.ok ? <span style={{ color: 'var(--text)' }}>{e.summary}</span> : <span style={{ color: 'var(--signal-crit)' }}>{e.error}</span>}
      <span style={{ color: 'var(--text-faint)' }}> ({e.duration_ms}ms)</span>
    </div>
  );
}

/**
 * Kira answers in Markdown-ish sections (### Root cause, **Metrics:** …).
 * Rendered as structured blocks rather than dumped as raw text, but WITHOUT a
 * markdown library: the shape is known and fixed by her system prompt, and
 * pulling in a parser to handle three heading levels would be more surface
 * area than it is worth.
 */
function Report({ text }) {
  const blocks = [];
  let heading = null;
  let buf = [];
  const flush = () => {
    if (heading || buf.length) blocks.push({ heading, body: buf.join('\n').trim() });
    buf = [];
  };
  for (const raw of text.split('\n')) {
    const h = raw.match(/^#{2,4}\s+(.*)$/);
    if (h) {
      flush();
      heading = h[1].trim();
    } else {
      buf.push(raw);
    }
  }
  flush();

  return (
    <div
      className="mt-[10px] px-[13px] py-3"
      style={{
        borderLeft: '2px solid var(--signal-warn)',
        background: 'var(--bg-panel-raised)',
        borderRadius: '0 var(--radius) var(--radius) 0',
      }}
    >
      {blocks.map((b, i) => (
        <div key={i} className="mb-[6px] last:mb-0">
          {b.heading && (
            <span className="font-semibold" style={{ color: 'var(--signal-warn)' }}>
              {b.heading}
            </span>
          )}
          {b.heading && b.body && ' — '}
          <span className="whitespace-pre-wrap break-words">
            {b.body.replace(/\*\*/g, '').replace(/^[-*]\s+/gm, '· ')}
          </span>
        </div>
      ))}
    </div>
  );
}

const SUGGESTIONS = [
  'Investigate the checkout errors',
  'Why is order latency up?',
];

export default function KiraPanel({ provider, onToast, onBusyChange }) {
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const logRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  // Keep the newest line in view, but only while a run is in flight — yanking
  // the scroll position while someone is reading an old report is hostile.
  useEffect(() => {
    if (busy && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines, busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function run(question) {
    if (busy) return;
    const q = (question || '').trim();
    if (!q) return;

    setBusy(true);
    setLines([{ kind: 'user', text: q }]);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await investigate(
        q,
        (event, data) => {
          setLines((prev) => {
            const next = [...prev];
            if (event === 'tool_start') {
              next.push({ kind: 'call', tool: data.tool, args: data.args, pending: true, id: `${data.tool}:${JSON.stringify(data.args)}` });
            } else if (event === 'tool_end') {
              // Settle the matching pending call, then append its result.
              const id = `${data.tool}:${JSON.stringify(data.args)}`;
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].kind === 'call' && next[i].id === id && next[i].pending) {
                  next[i] = { ...next[i], pending: false };
                  break;
                }
              }
              next.push({ kind: 'result', ...data });
            } else if (event === 'nudge') {
              next.push({ kind: 'nudge', missing: data.missing, remaining: data.remaining });
            } else if (event === 'thinking' && data.text) {
              next.push({ kind: 'thinking', text: data.text });
            } else if (event === 'answer') {
              next.push({ kind: 'report', text: data.answer, allThree: data.allThreeUsed, missing: data.missing });
            } else if (event === 'error') {
              next.push({ kind: 'error', text: data.message });
            }
            return next;
          });

          if (event === 'answer') {
            onToast?.(
              data.allThreeUsed
                ? 'Kira: investigation complete'
                : `Kira: INCOMPLETE — never called ${data.missing.join(', ')}`,
              !data.allThreeUsed,
            );
          }
        },
        { signal: controller.signal },
      );
    } catch (err) {
      if (err.name !== 'AbortError') {
        setLines((p) => [...p, { kind: 'error', text: err.message }]);
        onToast?.(`Kira failed: ${err.message}`, true);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  // Exposed so the command palette can start an investigation.
  useEffect(() => {
    const handler = (e) => run(e.detail);
    window.addEventListener('kira:ask', handler);
    return () => window.removeEventListener('kira:ask', handler);
  });

  return (
    <div className="flex min-h-0 flex-col" style={{ background: 'var(--bg-panel)' }}>
      <div
        className="flex items-center justify-between gap-2 px-4 py-[14px]"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="flex items-center gap-[9px]">
          <div
            className="mono flex items-center justify-center font-bold"
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              background: 'linear-gradient(135deg, var(--signal-warn), #c97e1f)',
              color: '#10141C',
              fontSize: 12,
            }}
            aria-hidden="true"
          >
            K
          </div>
          <div>
            <h3 className="m-0 font-bold" style={{ fontSize: 14 }}>
              Kira
            </h3>
            <p className="m-0" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              AIOps investigation agent
            </p>
          </div>
        </div>
        {/* Read-only: reflects the server's actual KIRA_PROVIDER. It is not a
            toggle, because the model is chosen where the agent runs, and a
            control that appeared to change it from here would be lying. */}
        <span
          className="mono"
          title={`Set by KIRA_PROVIDER on the server (${provider?.name ?? '—'})`}
          style={{
            fontSize: 10.5,
            color: 'var(--text-dim)',
            border: '1px solid var(--border-strong)',
            borderRadius: 20,
            padding: '3px 9px',
          }}
        >
          {provider?.label ?? 'loading…'}
        </span>
      </div>

      <div
        ref={logRef}
        className="mono flex-1 overflow-y-auto px-4 py-[14px]"
        style={{ fontSize: 12.5, lineHeight: 1.65 }}
        aria-live="polite"
        aria-busy={busy}
      >
        {lines.length === 0 && (
          <div style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>
            Waiting. Trigger an incident, then ask Kira to investigate. She calls all three
            tools — metrics, logs and pod health — before concluding anything.
          </div>
        )}

        {lines.map((l, i) => {
          if (l.kind === 'user') return <div key={i} className="mb-[3px] whitespace-pre-wrap break-words">&gt; {l.text}</div>;
          if (l.kind === 'call') return <ToolLine key={i} e={l} />;
          if (l.kind === 'result') return <ResultLine key={i} e={l} />;
          if (l.kind === 'thinking')
            return (
              <div key={i} className="mb-[3px] whitespace-pre-wrap break-words pl-[14px]" style={{ color: 'var(--text-faint)' }}>
                {l.text}
              </div>
            );
          if (l.kind === 'nudge')
            return (
              <div key={i} className="mb-[3px]" style={{ color: 'var(--signal-warn)' }}>
                ! tried to conclude without {l.missing.join(', ')} — asking again ({l.remaining} left)
              </div>
            );
          if (l.kind === 'error')
            return (
              <div key={i} className="mb-[3px] whitespace-pre-wrap" style={{ color: 'var(--signal-crit)' }}>
                {l.text}
              </div>
            );
          if (l.kind === 'report')
            return (
              <div key={i}>
                <Report text={l.text} />
                {!l.allThree && (
                  <div className="mt-2" style={{ color: 'var(--signal-crit)' }}>
                    Incomplete: never called {l.missing.join(', ')}. Not supported by all three signals.
                  </div>
                )}
              </div>
            );
          return null;
        })}
      </div>

      <div className="flex flex-wrap gap-[7px] px-4 pb-[10px]">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            className="mono"
            disabled={busy}
            onClick={() => run(s)}
            style={{
              fontSize: 11,
              padding: '5px 10px',
              border: '1px solid var(--border-strong)',
              borderRadius: 20,
              background: 'transparent',
              color: 'var(--text-dim)',
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.5 : 1,
            }}
          >
            {s}
          </button>
        ))}
      </div>

      <form
        className="flex gap-2 px-4 py-3"
        style={{ borderTop: '1px solid var(--border)' }}
        onSubmit={(e) => {
          e.preventDefault();
          run(input || SUGGESTIONS[0]);
          setInput('');
        }}
      >
        <input
          className="mono flex-1"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          placeholder={busy ? 'Investigating…' : 'Ask Kira about an incident…'}
          aria-label="Ask Kira about an incident"
          style={{
            background: 'var(--bg-panel-raised)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)',
            padding: '9px 11px',
            color: 'var(--text)',
            fontSize: 12.5,
          }}
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Running' : 'Ask'}
        </button>
      </form>

      <div className="px-4 pb-3" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
        Live call against {provider?.model ?? 'the configured model'}. Tool calls stream as they
        execute; every figure comes from Prometheus, Loki and the Kubernetes API.
      </div>
    </div>
  );
}
