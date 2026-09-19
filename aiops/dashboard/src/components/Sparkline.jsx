/**
 * Hairline sparkline / line chart.
 *
 * Deliberately plain SVG rather than a charting library: at this size a chart
 * library would ship 40-100KB to draw one path, and would fight the design
 * with its own default axes, tooltips, grid and padding. The whole visual
 * language here is "hairline stroke on a dark panel", which is one <path>.
 *
 * Colour encodes status, but status is never encoded by colour ALONE anywhere
 * in this UI — the rail also shows a dot with a distinct position and the
 * centre panel shows a text status tag — so this remains readable for
 * colour-blind users.
 */
const STROKE = {
  ok: 'var(--signal-ok)',
  warn: 'var(--signal-warn)',
  crit: 'var(--signal-crit)',
};

export default function Sparkline({ values = [], width = 46, height = 20, status = 'ok', strokeWidth = 1.6, fill = false }) {
  // One point cannot make a line, and an empty series must not render as a
  // flat baseline at zero — that reads as "healthy", when it actually means
  // "no data". Show nothing and let the caller label it.
  if (!values || values.length < 2) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--border-strong)"
          strokeWidth="1"
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  // Inset by the stroke width so the line is never clipped at the extremes.
  const pad = strokeWidth;
  const usable = height - pad * 2;

  const pts = values.map((v, i) => {
    const x = i * step;
    const y = pad + (usable - ((v - min) / range) * usable);
    return [x, y];
  });

  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${d} L${width},${height} L0,${height} Z`;
  const stroke = STROKE[status] ?? STROKE.ok;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      {fill && <path d={area} fill={stroke} opacity="0.08" />}
      <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
