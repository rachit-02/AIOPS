import { useEffect } from 'react';

/**
 * Toasts fire on state changes the user caused but may not be looking at:
 * an incident starting or resolving, and Kira finishing an investigation.
 * They never carry information available nowhere else — the status pill and
 * the Kira log remain the durable record — so missing one costs nothing.
 */
function Toast({ toast, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), 4200);
    return () => clearTimeout(t);
  }, [toast.id, onDismiss]);

  return (
    <div
      className="mono toast-in"
      role="status"
      style={{
        fontSize: 12,
        padding: '10px 14px',
        background: 'var(--bg-panel-raised)',
        border: '1px solid var(--border-strong)',
        borderLeft: `2px solid ${toast.crit ? 'var(--signal-crit)' : 'var(--signal-ok)'}`,
        borderRadius: 4,
        color: 'var(--text)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        maxWidth: 380,
      }}
    >
      {toast.message}
    </div>
  );
}

export default function Toasts({ toasts, onDismiss }) {
  return (
    <div
      className="fixed right-4 z-60 flex flex-col gap-2"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
