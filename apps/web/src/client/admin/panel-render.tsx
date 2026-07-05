// Shared panel renderer — the chart body for a saved panel, given the rows a
// run/embed returned. Extracted from insights.tsx so the admin Insights grid
// AND the public embed page (`/embed/d/:token`) render panels identically.
//
// Chart vizzes render through the shadcn chart primitives (recharts) in
// `panel-charts.tsx`, loaded lazily so the sign-in page, admin shell and
// chart-less embeds never download recharts.
import { lazy, Suspense, type ReactNode } from "react";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { detectSeries, isChartViz } from "./panel-series";

const PanelChart = lazy(() => import("./panel-charts"));

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

  const { cols, numericCols, labelCol } = detectSeries(rows);
  const numericCol = numericCols[0];

  if (viz === "counter") {
    const v = numericCol ? Number(rows[0]![numericCol]) : rows.length;
    return <div className="py-2 text-[32px] font-semibold tabular-nums">{v.toLocaleString()}</div>;
  }

  if (isChartViz(viz)) {
    return (
      <Suspense fallback={<Skeleton className="h-40 w-full grow" />}>
        <PanelChart viz={viz} rows={rows} />
      </Suspense>
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
