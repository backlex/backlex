// The stacked-bar time series shared by Analytics and Usage.
//
// Both pages used to carry a near-identical hand-rolled `<svg viewBox>` bar
// chart — two copies of the same 35 lines, neither with a tooltip, an axis or
// a legend. recharts was already a dependency (`packages/ui` wraps it in the
// shadcn chart primitives) and already used by saved panels, so a third copy
// was never the right answer.
//
// Loaded lazily from `timeseries.tsx` for the same reason `panel-charts.tsx`
// is: recharts is large, and a page that never draws a chart should not pay
// for it in the initial bundle.
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@backlex/ui/components/chart";

export interface TimeseriesPoint {
  /** Axis label — a `YYYY-MM-DD` day or an `HH:MM` minute. */
  label: string;
  /** The taller, background series (events, requests). */
  total: number;
  /** The shorter series drawn in front (visitors, errors). */
  accent: number;
}

export interface TimeseriesChartProps {
  data: TimeseriesPoint[];
  totalLabel: string;
  accentLabel: string;
  className?: string;
}

/**
 * The two series are drawn GROUPED, never stacked.
 *
 * At both call sites `accent` is a subset of `total` — visitors are a subset
 * of events, 5xx responses are a subset of requests. Stacking them would draw
 * a bar of 14 for a day with 10 events and 4 visitors, which is not a quantity
 * that exists. The hand-rolled charts this replaces nested the accent bar
 * inside the total one to say "part of"; grouping says the same thing without
 * pretending to an overlay recharts does not do natively.
 */
export default function TimeseriesChart({
  data,
  totalLabel,
  accentLabel,
  className,
}: TimeseriesChartProps) {
  const config: ChartConfig = {
    total: { label: totalLabel, color: "var(--chart-1)" },
    accent: { label: accentLabel, color: "var(--chart-2)" },
  };

  return (
    <ChartContainer config={config} className={className ?? "h-[120px] w-full"}>
      <BarChart
        accessibilityLayer
        data={data}
        margin={{ top: 4, right: 4, bottom: 0, left: 4 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          // Recharts drops ticks that would collide, which is what keeps a
          // 30-point axis readable at 390px without any width branch here.
          minTickGap={24}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="total" fill="var(--color-total)" fillOpacity={0.35} radius={2} />
        <Bar dataKey="accent" fill="var(--color-accent)" radius={2} />
      </BarChart>
    </ChartContainer>
  );
}
