import { useCallback, useEffect, useRef, useState } from 'react';
import Header from './components/Header.jsx';
import ServiceRail from './components/ServiceRail.jsx';
import CenterPanel from './components/CenterPanel.jsx';
import KiraPanel from './components/KiraPanel.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Toasts from './components/Toasts.jsx';
import { getSystem, getServiceDetail, getIncidentHistory, setIncident } from './lib/api.js';

const POLL_MS = 5000;

export default function App() {
  const [system, setSystem] = useState(null);
  const [detail, setDetail] = useState(null);
  const [history, setHistory] = useState([]);
  const [selected, setSelected] = useState('order');
  const [error, setError] = useState(null);
  const [theme, setTheme] = useState(() => {
    // Precedence: explicit ?theme= in the URL, then a stored choice, then the
    // OS preference. The query param makes the theme deep-linkable (useful for
    // sharing a view, and for driving a headless screenshot); the OS default
    // means a light-mode user is not ambushed by a full-bleed dark panel.
    const fromUrl = new URLSearchParams(location.search).get('theme');
    if (fromUrl === 'light' || fromUrl === 'dark') return fromUrl;
    const stored = localStorage.getItem('aiops-theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [incidentBusy, setIncidentBusy] = useState(false);
  const [pipelineStage, setPipelineStage] = useState(null);

  const prevIncident = useRef(null);
  const toastId = useRef(0);

  const pushToast = useCallback((message, crit = false) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, crit }]);
  }, []);
  const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : '';
    localStorage.setItem('aiops-theme', theme);
  }, [theme]);

  // ---- telemetry polling -------------------------------------------------
  // Polling, not a websocket: the data source is Prometheus, which is itself a
  // polling system on a 15s scrape. A push channel would deliver the same
  // numbers with more moving parts and a reconnect problem to solve.
  const refresh = useCallback(async () => {
    try {
      const s = await getSystem('15m');
      setSystem(s);
      setError(null);

      // Toast only on a genuine TRANSITION, never on the first load — landing
      // on an already-broken system should not fire an "incident started" alert
      // for something that happened an hour ago.
      const active = s.incident?.active;
      if (prevIncident.current !== null && prevIncident.current !== active) {
        pushToast(
          active ? 'Incident triggered on the Order service' : 'Incident resolved',
          active,
        );
        getIncidentHistory().then(setHistory).catch(() => {});
      }
      prevIncident.current = active;
    } catch (err) {
      setError(err.message);
    }
  }, [pushToast]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    getIncidentHistory().then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    getServiceDetail(selected, '15m')
      .then((d) => !cancelled && setDetail(d))
      .catch(() => !cancelled && setDetail(null));
    return () => {
      cancelled = true;
    };
  }, [selected, system?.at]);

  // ---- incident toggle ---------------------------------------------------
  const toggleIncident = useCallback(
    async (enabled) => {
      if (incidentBusy) return;
      setIncidentBusy(true);
      setPipelineStage('local');
      setSelected('order');
      try {
        await setIncident(enabled, (event, data) => {
          if (event === 'stage') setPipelineStage(data.stage);
          else if (event === 'error') {
            pushToast(`Incident toggle failed: ${data.message}`, true);
            setError(data.message);
          }
        });
        await refresh();
        await getIncidentHistory().then(setHistory).catch(() => {});
      } catch (err) {
        pushToast(`Incident toggle failed: ${err.message}`, true);
      } finally {
        setIncidentBusy(false);
        // Hold the completed pipeline briefly so the final stage is readable,
        // rather than snapping back the instant the request resolves.
        setTimeout(() => setPipelineStage(null), 2500);
      }
    },
    [incidentBusy, pushToast, refresh],
  );

  const askKira = useCallback((q) => {
    window.dispatchEvent(new CustomEvent('kira:ask', { detail: q }));
  }, []);

  // ?ask=<question> starts an investigation on load, so a demo can be a single
  // shareable URL rather than a sequence of clicks. Fires once: the ref guard
  // matters because StrictMode deliberately double-invokes effects in dev, and
  // without it every dev reload would start two concurrent investigations.
  const autoAsked = useRef(false);
  useEffect(() => {
    const q = new URLSearchParams(location.search).get('ask');
    if (!q) return;
    // The guard is checked INSIDE the timer, not before scheduling it.
    // StrictMode mounts, cleans up, then re-mounts: setting the flag up front
    // meant the first pass scheduled a timer, the cleanup cancelled it, and the
    // second pass bailed on the flag — so it never fired at all.
    const t = setTimeout(() => {
      if (autoAsked.current) return;
      autoAsked.current = true;
      askKira(q);
    }, 600);
    return () => clearTimeout(t);
  }, [askKira]);

  // ---- global shortcuts --------------------------------------------------
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const services = system?.services ?? [];
  const svc = services.find((s) => s.id === selected) ?? services[0];

  const actions = {
    toggleIncident,
    toggleTheme: () => setTheme((t) => (t === 'light' ? 'dark' : 'light')),
    askKira,
    refresh,
    selectService: setSelected,
  };

  return (
    <>
      <Header
        system={system}
        theme={theme}
        stale={Boolean(error)}
        incidentBusy={incidentBusy}
        onToggleIncident={toggleIncident}
        onToggleTheme={actions.toggleTheme}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      {error && (
        <div
          className="mono px-[22px] py-2"
          style={{
            background: 'var(--bg-panel-raised)',
            borderBottom: '1px solid var(--signal-crit)',
            color: 'var(--signal-crit)',
            fontSize: 12,
          }}
        >
          {error} — is the API running? `cd aiops/kira && npm run server`
        </div>
      )}

      {/* 1px gaps over a border-coloured background give true hairline
          dividers between the three regions. */}
      <div
        className="grid min-h-[calc(100vh-62px)] grid-cols-1 lg:grid-cols-[230px_1fr_360px]"
        style={{ gap: 1, background: 'var(--border)' }}
      >
        {system ? (
          <>
            <ServiceRail services={services} selected={selected} onSelect={setSelected} />
            <CenterPanel
              svc={svc}
              system={system}
              detail={detail}
              history={history}
              pipelineStage={pipelineStage}
              incidentActive={system.incident?.active}
            />
          </>
        ) : (
          <>
            <div style={{ background: 'var(--bg-panel)' }} />
            <div className="mono p-6" style={{ background: 'var(--bg-panel)', color: 'var(--text-faint)', fontSize: 12.5 }}>
              {error ? 'Waiting for the API…' : 'Reading telemetry from Prometheus, Loki and the Kubernetes API…'}
            </div>
          </>
        )}

        <KiraPanel provider={system?.provider} onToast={pushToast} />
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        services={services}
        incidentActive={system?.incident?.active}
        incidentBusy={incidentBusy}
        actions={actions}
      />

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
