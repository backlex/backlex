// Row → series auto-detection for panel charts.
//
// The rule itself moved to `@backlex/core` when the server-side report renderer
// needed to draw the same chart into a PDF. This module stays as the admin's
// import path — `panel-charts.tsx` is lazy, and re-exporting here keeps the
// detection out of the eager chunk's import graph the same way it always was.
export {
  CHART_VIZES,
  isChartViz,
  SEGMENT_VIZES,
  MAX_SERIES,
  MAX_SEGMENTS,
  detectSeries,
  seriesLabel,
  type ChartViz,
  type SeriesShape,
} from "@backlex/core";
