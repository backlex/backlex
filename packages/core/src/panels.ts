/**
 * Row → series auto-detection for dashboard panels.
 *
 * Lived in the admin SPA until the report renderer needed it: a scheduled PDF
 * has to draw the same chart the operator sees on the Insights page, and it
 * draws it on the SERVER with no recharts and no DOM. Two copies of "which
 * column is the label" would drift, and the drift would only show up in an
 * emailed report nobody re-opens the admin to compare against — so the rule
 * lives here, and both sides import it.
 */

/** Every viz that renders as a chart rather than a table. */
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
