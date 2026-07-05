// Recharts-backed chart bodies for saved panels, built on the shared shadcn
// chart primitives (`@backlex/ui/components/chart`). Loaded lazily from
// `panel-render.tsx` so recharts stays out of the initial bundle — only a
// dashboard that actually renders a chart viz downloads it.
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  XAxis,
} from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@backlex/ui/components/chart";
import { detectSeries, MAX_SEGMENTS, MAX_SERIES, SEGMENT_VIZES, type ChartViz } from "./panel-series";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
/** 6th+ slice falls back to a muted tone instead of repeating chart-1. */
const segmentColor = (i: number) => COLORS[i] ?? "var(--muted-foreground)";
const seriesColor = (i: number) => COLORS[i % COLORS.length]!;

const trimTick = (v: unknown) => {
  const s = String(v);
  return s.length > 12 ? `${s.slice(0, 11)}…` : s;
};

const CONTAINER = "aspect-auto h-40 w-full";

export default function PanelChart({ viz, rows }: { viz: ChartViz; rows: Record<string, unknown>[] }) {
  if (SEGMENT_VIZES.includes(viz)) return <SegmentChart viz={viz} rows={rows} />;
  return <SeriesChart viz={viz} rows={rows} />;
}

/** sparkline / line / area / bars / stacked-bars / radar — one series per
 *  numeric column (capped at MAX_SERIES), first non-numeric column as labels. */
function SeriesChart({ viz, rows }: { viz: ChartViz; rows: Record<string, unknown>[] }) {
  const { cols, numericCols, labelCol } = detectSeries(rows);
  const seriesCols = (numericCols.length > 0 ? numericCols : cols.slice(0, 1)).slice(0, MAX_SERIES);
  const series = seriesCols.map((col, i) => ({ key: `ser${i}`, col, color: seriesColor(i) }));
  const data = rows.map((r, i) => {
    const d: Record<string, unknown> = { __label: labelCol ? String(r[labelCol]) : String(i + 1) };
    for (const s of series) d[s.key] = Number(r[s.col]) || 0;
    return d;
  });
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.col, color: s.color }]));
  const multi = series.length > 1;

  if (viz === "sparkline") {
    return (
      <ChartContainer config={config} className={CONTAINER}>
        <AreaChart accessibilityLayer data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <ChartTooltip content={<ChartTooltipContent />} />
          {series.map((s) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type="monotone"
              fill={`var(--color-${s.key})`}
              fillOpacity={0.18}
              stroke={`var(--color-${s.key})`}
              strokeWidth={1.5}
            />
          ))}
        </AreaChart>
      </ChartContainer>
    );
  }

  if (viz === "area") {
    return (
      <ChartContainer config={config} className={CONTAINER}>
        <AreaChart accessibilityLayer data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="__label" tickLine={false} axisLine={false} tickMargin={6} minTickGap={16} tickFormatter={trimTick} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {series.map((s) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type="monotone"
              fill={`var(--color-${s.key})`}
              fillOpacity={0.25}
              stroke={`var(--color-${s.key})`}
              strokeWidth={1.5}
            />
          ))}
          {multi && <ChartLegend content={<ChartLegendContent className="flex-wrap" />} />}
        </AreaChart>
      </ChartContainer>
    );
  }

  if (viz === "line") {
    return (
      <ChartContainer config={config} className={CONTAINER}>
        <LineChart accessibilityLayer data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="__label" tickLine={false} axisLine={false} tickMargin={6} minTickGap={16} tickFormatter={trimTick} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {series.map((s) => (
            <Line key={s.key} dataKey={s.key} type="monotone" stroke={`var(--color-${s.key})`} strokeWidth={2} dot={false} />
          ))}
          {multi && <ChartLegend content={<ChartLegendContent className="flex-wrap" />} />}
        </LineChart>
      </ChartContainer>
    );
  }

  if (viz === "radar") {
    return (
      <ChartContainer config={config} className={CONTAINER}>
        <RadarChart accessibilityLayer data={data} margin={{ top: 4, right: 16, bottom: 12, left: 16 }}>
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          <PolarAngleAxis dataKey="__label" tickFormatter={trimTick} />
          <PolarGrid />
          {series.map((s) => (
            <Radar key={s.key} dataKey={s.key} fill={`var(--color-${s.key})`} fillOpacity={0.35} stroke={`var(--color-${s.key})`} />
          ))}
          {multi && <ChartLegend content={<ChartLegendContent className="flex-wrap" />} />}
        </RadarChart>
      </ChartContainer>
    );
  }

  // bars | stacked-bars
  const stacked = viz === "stacked-bars";
  return (
    <ChartContainer config={config} className={CONTAINER}>
      <BarChart accessibilityLayer data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="__label" tickLine={false} axisLine={false} tickMargin={6} minTickGap={16} tickFormatter={trimTick} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} fill={`var(--color-${s.key})`} radius={stacked ? 0 : 3} stackId={stacked ? "a" : undefined} />
        ))}
        {multi && <ChartLegend content={<ChartLegendContent className="flex-wrap" />} />}
      </BarChart>
    </ChartContainer>
  );
}

/** donut / pie / radial — one slice per row (capped at MAX_SEGMENTS): first
 *  non-numeric column is the slice label, first numeric column the value. */
function SegmentChart({ viz, rows }: { viz: ChartViz; rows: Record<string, unknown>[] }) {
  const { cols, numericCols, labelCol } = detectSeries(rows);
  const valueCol = numericCols[0] ?? cols[1] ?? cols[0];
  const nameCol = labelCol ?? cols[0];
  const segs = rows.slice(0, MAX_SEGMENTS).map((r, i) => ({
    key: `seg${i}`,
    name: nameCol ? String(r[nameCol]) : String(i + 1),
    value: valueCol ? Number(r[valueCol]) || 0 : 0,
    fill: `var(--color-seg${i})`,
  }));
  const config: ChartConfig = Object.fromEntries(segs.map((s, i) => [s.key, { label: s.name, color: segmentColor(i) }]));

  // Side legend (like the old hand-rolled donut): the chart keeps its full
  // height and long labels get a truncating column instead of stacking rows
  // under the plot.
  const sideLegend = (
    <ChartLegend
      layout="vertical"
      align="right"
      verticalAlign="middle"
      content={
        <ChartLegendContent
          nameKey="key"
          className="max-w-[55%] flex-col items-start gap-1.5 overflow-hidden *:max-w-full *:truncate"
        />
      }
    />
  );

  if (viz === "radial") {
    return (
      <ChartContainer config={config} className={CONTAINER}>
        <RadialBarChart accessibilityLayer data={segs} innerRadius="35%" outerRadius="100%">
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="key" />} />
          <RadialBar dataKey="value" background cornerRadius={4} />
          {sideLegend}
        </RadialBarChart>
      </ChartContainer>
    );
  }

  // donut | pie
  return (
    <ChartContainer config={config} className={CONTAINER}>
      <PieChart accessibilityLayer>
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="key" />} />
        <Pie data={segs} dataKey="value" nameKey="name" innerRadius={viz === "donut" ? "55%" : 0} strokeWidth={2} />
        {sideLegend}
      </PieChart>
    </ChartContainer>
  );
}
