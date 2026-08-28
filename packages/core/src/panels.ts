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

/**
 * A group key's printable form on an axis, slice or table row.
 *
 * A `GROUP BY` over a nullable column produces a bucket whose key is `null`,
 * and that is the honest answer from the server — it means "these rows had no
 * value", which is not the same as a row whose value is the four characters
 * `null`. The browser renderer stringified it anyway: measured on a live
 * public dashboard embed on 2026-08-27, where the LARGEST slice of a donut
 * chart a customer shows their own stakeholders was labelled `null`.
 *
 * The PDF report renderer already did this correctly via `fmtCell`, so the
 * same panel read `—` on paper and `null` on screen. This is the browser
 * half's version of the same decision.
 *
 * An empty string gets the same treatment: it draws nothing at all, which
 * reads as a broken chart rather than as an empty category. A REAL string
 * `"null"` is left alone — it is a value, and pretending otherwise would hide
 * data.
 */
export const seriesLabel = (v: unknown, fallback?: string): string => {
  if (v === null || v === undefined) return fallback ?? "\u2014";
  const s = String(v);
  return s.trim() === "" ? (fallback ?? "\u2014") : s;
};
