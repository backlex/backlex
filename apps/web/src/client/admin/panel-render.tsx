// @ts-nocheck
// Shared panel renderer — the chart body for a saved panel, given the rows a
// run/embed returned. Extracted from insights.tsx so the admin Insights grid
// AND the public embed page (`/embed/d/:token`) render panels identically.
//
// Pure SVG + divs (no charting dep); theme-aware via the OKLCH CSS vars.
import type { ReactNode } from "react";

export function Sparkline({
  data,
  height = 60,
  fill,
  bars,
}: {
  data: number[];
  height?: number;
  fill?: boolean;
  bars?: boolean;
}) {
  const max = Math.max(...data, 1);
  const w = 100;
  const h = height;
  if (bars) {
    return (
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
        {data.map((v, i) => (
          <rect
            key={i}
            x={i * (w / data.length) + 0.4}
            y={h - (v / max) * h}
            width={w / data.length - 0.8}
            height={(v / max) * h}
            fill="var(--primary)"
            rx="0.6"
          />
        ))}
      </svg>
    );
  }
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
      {fill && (
        <polyline
          points={`0,${h} ${pts} ${w},${h}`}
          fill="color-mix(in oklch, var(--primary) 18%, transparent)"
          stroke="none"
        />
      )}
      <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const DONUT_COLORS = [
  "var(--primary)",
  "oklch(0.7 0.18 260)",
  "oklch(0.78 0.16 75)",
  "oklch(0.6 0 0)",
  "oklch(0.7 0.18 22)",
  "oklch(0.7 0.18 320)",
];

export function Donut({ segments }: { segments: { v: number; color: string }[] }) {
  const total = segments.reduce((a, s) => a + s.v, 0) || 1;
  let acc = 0;
  const r = 36;
  const cx = 50;
  const cy = 50;
  return (
    <svg width="120" height="120" viewBox="0 0 100 100">
      {segments.map((s, i) => {
        const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2;
        acc += s.v;
        const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
        const x0 = cx + Math.cos(a0) * r;
        const y0 = cy + Math.sin(a0) * r;
        const x1 = cx + Math.cos(a1) * r;
        const y1 = cy + Math.sin(a1) * r;
        const large = s.v / total > 0.5 ? 1 : 0;
        return <path key={i} d={`M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z`} fill={s.color} />;
      })}
      <circle cx={cx} cy={cy} r="22" fill="var(--card)" />
    </svg>
  );
}

/**
 * Render the body of a panel from its viz + rows. No card chrome, no edit/
 * delete buttons — callers wrap it. `emptyLabel`/`errorLabel` are passed in so
 * each surface controls its own (translated) copy.
 */
export function PanelBody({
  viz,
  rows,
  error,
  emptyLabel,
  errorLabel,
}: {
  viz: string;
  rows: Record<string, unknown>[];
  error?: string | null;
  emptyLabel: ReactNode;
  errorLabel?: ReactNode;
}): ReactNode {
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-[color-mix(in_oklch,var(--destructive)_35%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_8%,var(--card))] px-3 py-2.5 text-xs text-destructive">
        <span className="flex-1 [word-break:break-word]">{errorLabel ?? error}</span>
      </div>
    );
  }
  if (rows.length === 0) {
    return <div className="py-4 text-xs text-muted-foreground">{emptyLabel}</div>;
  }

  const cols = Object.keys(rows[0] ?? {});
  const numericCol = cols.find((c) => typeof rows[0]![c] === "number");
  const labelCol = cols.find((c) => c !== numericCol);

  if (viz === "counter") {
    const v = numericCol ? Number(rows[0]![numericCol]) : rows.length;
    return <div className="py-2 text-[32px] font-semibold tabular-nums">{v.toLocaleString()}</div>;
  }

  if (viz === "sparkline" || viz === "bars") {
    const data = rows.map((r) => Number(r[numericCol ?? cols[0]!]) || 0);
    return <Sparkline data={data} height={160} fill={viz === "sparkline"} bars={viz === "bars"} />;
  }

  if (viz === "donut") {
    const segs = rows.slice(0, 6).map((r, i) => ({
      v: Number(r[numericCol ?? cols[1]!]) || 0,
      color: DONUT_COLORS[i]!,
    }));
    return (
      <div className="flex items-center gap-[18px] py-3">
        <Donut segments={segs} />
        <div className="flex flex-1 flex-col gap-1.5 text-[12.5px]">
          {rows.slice(0, 6).map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="size-2 rounded-[2px]" style={{ background: segs[i]!.color }} />
              <span className="flex-1 font-mono">{String(r[labelCol ?? cols[0]!])}</span>
              <span className="tabular-nums">{Number(r[numericCol ?? cols[1]!])}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Fallback: small table.
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      {rows.slice(0, 8).map((r, i) => (
        <div
          key={i}
          className={`flex justify-between pb-1 font-mono ${i < Math.min(rows.length, 8) - 1 ? "border-b border-border" : ""}`}
        >
          <span>{String(r[labelCol ?? cols[0]!])}</span>
          <span className="tabular-nums">{numericCol ? Number(r[numericCol]).toLocaleString() : ""}</span>
        </div>
      ))}
    </div>
  );
}

/** One-line summary of what a saved panel shows. Shared by admin + embed. */
export function panelSubtitle(
  panel: { description?: string | null; kind: string; config?: Record<string, unknown> | null },
  rowCount: number,
): string {
  if (panel.description) return panel.description;
  if (panel.kind === "items-aggregate") {
    const cfg = (panel.config ?? {}) as { collection?: string; agg?: string; field?: string; groupBy?: string };
    const fn = !cfg.agg || cfg.agg === "count" ? "count" : `${cfg.agg}(${cfg.field ?? "?"})`;
    return `${cfg.collection ?? "collection"} · ${fn}${cfg.groupBy ? ` by ${cfg.groupBy}` : ""}`;
  }
  if (panel.kind === "sql") return `${rowCount} row${rowCount === 1 ? "" : "s"} · sql`;
  return panel.kind;
}
