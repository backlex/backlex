// Shared row → series auto-detection for panel charts. Lives outside
// `panel-charts.tsx` so the panel editor's mapping hint can describe the exact
// same detection without pulling recharts into its chunk.

/** Every viz that renders through the lazy recharts module. */
export const CHART_VIZES = [
  "sparkline",
  "line",
  "area",
  "bars",
  "stacked-bars",
  "donut",
  "pie",
  "radar",
  "radial",
] as const;
export type ChartViz = (typeof CHART_VIZES)[number];

export const isChartViz = (viz: string): viz is ChartViz =>
  (CHART_VIZES as readonly string[]).includes(viz);

/** Segment charts read (label, value) pairs per row; the rest read one numeric
 *  series per numeric column. */
export const SEGMENT_VIZES: readonly ChartViz[] = ["donut", "pie", "radial"];

/** Series charts draw at most this many numeric columns. */
export const MAX_SERIES = 5;
/** Segment charts draw at most this many rows/slices. */
export const MAX_SEGMENTS = 6;

export interface SeriesShape {
  cols: string[];
  /** Columns whose first-row value is a number — each becomes a series. */
  numericCols: string[];
  /** First non-numeric column — used as the category/label axis. */
  labelCol: string | undefined;
}

export function detectSeries(rows: Record<string, unknown>[]): SeriesShape {
  const first = rows[0] ?? {};
  const cols = Object.keys(first);
  const numericCols = cols.filter((c) => typeof first[c] === "number");
  const labelCol = cols.find((c) => !numericCols.includes(c));
  return { cols, numericCols, labelCol };
}
