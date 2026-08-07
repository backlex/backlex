/**
 * The admin's one sparkline.
 *
 * Lifted out of the Overview page so the KPI tiles draw the same shape rather
 * than a second, slightly-different chart — the same argument the KPI layer
 * itself makes about numbers, applied to how they are drawn. Overview's maths,
 * proportions and defaults are preserved exactly; the only addition is gap
 * handling, which Overview never needed because its series are dense.
 *
 * Deliberately unlabelled and un-axised: at this size a scale would be
 * illegible, and inviting the reader to estimate values off it is worse than
 * not offering it. What it honestly conveys is direction and volatility — the
 * headline figure beside it is the value.
 */

/** A gap in the data. NOT zero: an average over an empty bucket is unknown,
 *  and drawing it at the baseline would assert the figure fell to nothing. */
export type SparkPoint = number | null;

/** One run of contiguous known points, with their original indices. */
interface Run {
  points: [number, number][];
}

export function Sparkline({
  data,
  color = "var(--primary)",
  height = 36,
  fill = true,
  className = "block w-full",
}: {
  data: SparkPoint[];
  color?: string;
  height?: number;
  fill?: boolean;
  className?: string;
}) {
  const w = 100;
  const h = height;
  const known = data.filter((v): v is number => v !== null && Number.isFinite(v));
  if (known.length < 2) return null;

  const max = Math.max(...known, 1);
  const min = Math.min(...known, 0);
  const span = max - min || 1;
  const x = (i: number) => (i / Math.max(1, data.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / span) * (h - 4) - 2;

  // A null starts a new run, so the line and its fill BREAK at the gap rather
  // than joining across it and claiming the quiet stretch never happened.
  const runs: Run[] = [];
  let current: [number, number][] = [];
  data.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (current.length) runs.push({ points: current });
      current = [];
      return;
    }
    current.push([x(i), y(v)]);
  });
  if (current.length) runs.push({ points: current });

  const lineOf = (pts: [number, number][]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");

  const last = runs[runs.length - 1]?.points.at(-1) ?? [0, 0];

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height }}
      aria-hidden="true"
    >
      {fill &&
        runs.map((run, i) => {
          // A single point has no area; skip rather than emit a degenerate path.
          if (run.points.length < 2) return null;
          const first = run.points[0]!;
          const end = run.points.at(-1)!;
          return (
            <path
              key={`f${i}`}
              d={`${lineOf(run.points)} L ${end[0].toFixed(2)},${h} L ${first[0].toFixed(2)},${h} Z`}
              fill={color}
              opacity="0.12"
            />
          );
        })}
      {runs.map((run, i) => (
        <path
          key={`l${i}`}
          d={lineOf(run.points)}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      <circle cx={last[0]} cy={last[1]} r="2" fill={color} />
    </svg>
  );
}
