import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Command palette (Ctrl/Cmd+K).
 *
 * Every entry runs the same real action as its equivalent control elsewhere —
 * the incident command drives the actual Git-backed toggle, "ask Kira" starts
 * a real investigation. Nothing here is a shortcut to a fake.
 *
 * Keyboard handling lives on the input rather than the document while open, so
 * arrow keys cannot leak through to the page behind the overlay.
 */
export default function CommandPalette({ open, onClose, services, incidentActive, incidentBusy, actions }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const commands = useMemo(() => {
    const base = [
      {
        id: 'incident',
        label: incidentActive ? 'Resolve the incident' : 'Trigger incident — Order service',
        hint: incidentBusy ? 'in progress' : 'incident',
        disabled: incidentBusy,
        run: () => actions.toggleIncident(!incidentActive),
      },
      {
        id: 'kira',
        label: 'Ask Kira: investigate the checkout errors',
        hint: 'kira',
        run: () => actions.askKira('Investigate the checkout errors'),
      },
      { id: 'theme', label: 'Toggle light / dark theme', hint: 'theme', run: actions.toggleTheme },
      { id: 'refresh', label: 'Refresh telemetry now', hint: 'data', run: actions.refresh },
    ];
    for (const s of services) {
      base.push({
        id: `svc:${s.id}`,
        label: `Jump to service: ${s.name}`,
        hint: s.path,
        run: () => actions.selectService(s.id),
      });
    }
    return base;
  }, [services, incidentActive, incidentBusy, actions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.hint}`.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Focus after paint, or the browser may drop it on a just-mounted node.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row in view when arrowing past the visible window.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, filtered]);

  if (!open) return null;

  const choose = (cmd) => {
    if (!cmd || cmd.disabled) return;
    onClose();
    cmd.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center"
      style={{ background: 'rgba(8,10,14,0.55)', paddingTop: '14vh' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        style={{
          width: 'min(520px, 92vw)',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-strong)',
          borderRadius: 6,
          boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          className="mono w-full"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command… (services, incident, kira, theme)"
          autoComplete="off"
          aria-label="Command"
          aria-activedescendant={filtered[active] ? `cmd-${filtered[active].id}` : undefined}
          style={{
            border: 'none',
            borderBottom: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--text)',
            padding: '14px 16px',
            fontSize: 14,
            outline: 'none',
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(filtered[active]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div ref={listRef} className="overflow-y-auto p-[6px]" style={{ maxHeight: 280 }} role="listbox">
          {filtered.length === 0 && (
            <div className="px-[10px] py-[9px]" style={{ fontSize: 13, color: 'var(--text-faint)' }}>
              No matches
            </div>
          )}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={i === active}
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(c);
              }}
              className="flex cursor-pointer justify-between px-[10px] py-[9px]"
              style={{
                borderRadius: 4,
                fontSize: 13,
                color: c.disabled ? 'var(--text-faint)' : 'var(--text)',
                background: i === active ? 'var(--bg-panel-raised)' : 'transparent',
              }}
            >
              <span>{c.label}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                {c.hint}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
