/**
 * Small accessible bar chart (SVG, no dependencies). One measure per chart: CTC (LPA) and internship stipend (rupees) are
 * never drawn on the same axis. A visually hidden caption carries the same numbers for screen readers.
 */
export interface Bar {
  label: string;
  value: number;
}

export function BarChart({ title, bars, unit, format, empty = "No data yet" }: { title: string; bars: Bar[]; unit?: string; format?: (n: number) => string; empty?: string }) {
  const fmt = format ?? ((n: number) => String(n));
  const max = Math.max(1, ...bars.map((b) => b.value));
  const rowH = 30;
  const labelW = 120;
  const chartW = 260;
  const h = Math.max(bars.length, 1) * rowH + 6;
  if (!bars.length || bars.every((b) => b.value === 0)) return <p className="text-[13px] text-[var(--text-tertiary)] py-6 text-center">{empty}</p>;
  return (
    <figure>
      <svg viewBox={`0 0 ${chartW + labelW + 60} ${h}`} role="img" aria-label={`${title}${unit ? ` (${unit})` : ""}`} className="w-full h-auto">
        <title>{title}</title>
        {bars.map((b, i) => {
          const w = Math.max(2, (b.value / max) * chartW);
          const y = i * rowH + 3;
          return (
            <g key={b.label}>
              <text x={labelW - 8} y={y + 17} textAnchor="end" className="fill-[var(--text-secondary)]" fontSize="12">
                {b.label}
              </text>
              <rect x={labelW} y={y + 4} width={w} height={rowH - 12} rx="2" className="fill-[var(--brand-primary)]" opacity={b.value === 0 ? 0.25 : 1} />
              <text x={labelW + w + 6} y={y + 17} className="fill-[var(--text-primary)]" fontSize="12" fontWeight="600">
                {fmt(b.value)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="sr-only">
        {title}: {bars.map((b) => `${b.label} ${fmt(b.value)}`).join(", ")}
      </figcaption>
    </figure>
  );
}
