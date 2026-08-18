// Lazy boundary for the shared time-series chart.
//
// recharts is heavy, and both pages that draw one (Analytics, Usage) render
// plenty of other content first. Importing through this shim keeps the library
// out of the initial bundle — the same arrangement `panel-render.tsx` has with
// `panel-charts.tsx`.
import { Suspense, lazy } from "react";
import { Skeleton } from "@backlex/ui/components/skeleton";
import type { TimeseriesChartProps } from "./timeseries-chart";

const Chart = lazy(() => import("./timeseries-chart"));

export type { TimeseriesPoint } from "./timeseries-chart";

export function Timeseries(props: TimeseriesChartProps) {
  return (
    <Suspense
      // Same height as the chart so the card does not resize when the chunk
      // lands — a skeleton of a different size IS a layout jump.
      fallback={<Skeleton className={props.className ?? "h-[120px] w-full"} />}
    >
      <Chart {...props} />
    </Suspense>
  );
}
