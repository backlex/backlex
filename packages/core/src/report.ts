/**
 * A dashboard, as a printable page.
 *
 * Every one of the schema templates ends in someone asking "so what happened
 * this month?", and backlex could already answer it on screen — panels, an
 * embed, a PDF renderer, mail with attachments — but only if a person opened
 * the admin and looked. This module is the part that was missing: turning the
 * panel results into a static document a renderer can print and a flow can
 * mail on a schedule.
 *
 * It is pure on purpose. No DB, no fetch, no clock — the caller passes the rows
 * and the timestamp — so the layout is unit-testable without a browser, a
 * renderer, or a workspace.
 *
 * ## Why the charts are hand-written SVG
 *
 * The admin draws panels with recharts, which needs React and a DOM. The
 * renderer we hand this to is a real browser, so *in principle* it could run
 * recharts — but that would mean shipping a bundle to it and hoping the script
 * finished before the print snapshot was taken. A chart that is already drawn
 * when the HTML arrives cannot lose that race. Everything here is therefore
 * geometry emitted as markup: no script, no external stylesheet, no font, no
 * image. The document is self-contained, which is also what makes it safe to
 * hand to a third-party renderer.
 *
 * The series-detection rule (which column is the label, which are numeric) is
 * imported from `./panels` — the same one the admin uses, so a chart in the PDF
 * shows what the chart on screen shows.
 */
import {
  detectSeries,
  isChartViz,
  MAX_SEGMENTS,
  MAX_SERIES,
  SEGMENT_VIZES,
  type ChartViz,
} from "./panels";

// ── Public shape ─────────────────────────────────────────────────────────────

export interface ReportPanel {
  name: string;
  /** The panel's viz, e.g. `bars`, `line`, `counter`, `table`. */
  viz: string;
  /** One line under the title — what the panel counts. */
  subtitle?: string | null;
  data: Record<string, unknown>[];
  /** A panel that ran but has nothing to draw says so rather than vanishing. */
  note?: string | null;
  /** A panel that FAILED says so, loudly. See `renderPanel`. */
  error?: string | null;
}

export interface ReportHtmlInput {
  title: string;
  description?: string | null;
  /** Stamped into the header. Passed in rather than read, so the output of a
   *  given input is one fixed string. */
  generatedAt: Date;
  panels: ReportPanel[];
  /** IANA zone for the header stamp. A report mailed to Istanbul should not be
   *  stamped in UTC. */
  timeZone?: string | null;
  /** BCP-47 tag for number + date formatting. */
  locale?: string | null;
  /** Small print at the bottom of every page — usually the workspace name. */
  footer?: string | null;
}

/** Rows past this are summarised rather than printed: a table panel over a
 *  large collection would otherwise produce a hundred-page PDF nobody reads. */
export const MAX_REPORT_TABLE_ROWS = 20;
/** Columns past this are dropped — a wide table is unreadable in portrait, and
 *  the count is stated in the footnote so the truncation is never silent. */
export const MAX_REPORT_TABLE_COLS = 8;

/**
 * The categorical palette, light surface only.
 *
 * A PDF has exactly one surface, so unlike the admin there is no dark variant
 * to select — the page is white wherever it is opened. These are the first six
 * slots of the validated categorical order (blue, orange, aqua, yellow,
 * magenta, green); assignment is by position and **never cycled**, so a series
 * keeps its colour when a sibling drops out — and so a seventh slice can never
 * come back round to slot 1 and read as the same thing as the biggest one.
 *
 * Three of them sit under 3:1 against white, which obliges relief rather than a
 * different palette: every chart here carries either direct value labels or a
 * legend naming the series in ink, and a table panel is text throughout.
 */
export const REPORT_SERIES_COLORS = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
] as const;
/** Past the last slot — the "Other" bucket. Deliberately not a seventh hue. */
const OTHER_COLOR = "#8a8a85";

/** Slot lookup that folds rather than wraps. */
const seriesColor = (i: number): string => REPORT_SERIES_COLORS[i] ?? OTHER_COLOR;

const INK = "#111110";
const INK_MUTED = "#6b6a65";
const GRID = "#e4e3de";

// ── Escaping + formatting ────────────────────────────────────────────────────

/** Everything interpolated below is row data or an operator's panel name, so
 *  every insertion point goes through this. */
export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );

const fmtNumber = (v: number, locale?: string | null): string => {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  // Whole numbers read better without a decimal tail; a ratio needs one.
  const digits = abs >= 100 || Number.isInteger(v) ? 0 : abs >= 1 ? 1 : 2;
  try {
    return new Intl.NumberFormat(locale ?? undefined, {
      maximumFractionDigits: digits,
    }).format(v);
  } catch {
    return String(v);
  }
};

/** A cell's printable form. Objects are JSON rather than `[object Object]` —
 *  a relation column is data the reader may actually need. */
const fmtCell = (v: unknown, locale?: string | null): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return fmtNumber(v, locale);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;

const fmtStamp = (at: Date, locale?: string | null, timeZone?: string | null): string => {
  try {
    return new Intl.DateTimeFormat(locale ?? "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(at);
  } catch {
    // An unknown zone must not cost the whole report — the stamp degrades to
    // UTC and the document still gets delivered.
    return at.toISOString().replace("T", " ").slice(0, 16);
  }
};

// ── Scale helpers ────────────────────────────────────────────────────────────

/** Round a maximum up to something a reader can divide by four in their head. */
const niceMax = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * exp;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ── SVG primitives ───────────────────────────────────────────────────────────

const W = 680;
const H = 240;

interface Plot {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const svgOpen = (height = H): string =>
  `<svg class="chart" viewBox="0 0 ${W} ${height}" width="100%" height="${height}" role="img" xmlns="http://www.w3.org/2000/svg">`;

const text = (
  x: number,
  y: number,
  body: string,
  opts: { anchor?: string; size?: number; fill?: string; weight?: number } = {},
): string =>
  `<text x="${round(x)}" y="${round(y)}" text-anchor="${opts.anchor ?? "middle"}" font-size="${
    opts.size ?? 10
  }" fill="${opts.fill ?? INK_MUTED}"${opts.weight ? ` font-weight="${opts.weight}"` : ""}>${escapeHtml(body)}</text>`;

const round = (n: number): number => Math.round(n * 100) / 100;

/** A bar with only its top corners rounded — `rx` would round the baseline end
 *  too, which lifts the mark off the axis it is measured against. */
const barPath = (x: number, y: number, w: number, h: number, r = 3): string => {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${round(x)} ${round(y + h)}V${round(y + rr)}a${rr} ${rr} 0 0 1 ${rr} ${-rr}h${round(
    w - 2 * rr,
  )}a${rr} ${rr} 0 0 1 ${rr} ${rr}V${round(y + h)}Z`;
};

/** Gridlines + y labels. Recessive on purpose: the marks carry the chart. */
const yAxis = (
  plot: Plot,
  max: number,
  min: number,
  locale?: string | null,
): string => {
  const parts: string[] = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const value = min + ((max - min) * i) / steps;
    const y = plot.bottom - ((value - min) / (max - min || 1)) * (plot.bottom - plot.top);
    parts.push(
      `<line x1="${plot.left}" y1="${round(y)}" x2="${plot.right}" y2="${round(y)}" stroke="${GRID}" stroke-width="1" />`,
      text(plot.left - 8, round(y) + 3.5, fmtNumber(value, locale), { anchor: "end", size: 9 }),
    );
  }
  return parts.join("");
};

/** At most eight category labels, evenly spaced — every label on a 60-point
 *  series is an unreadable smear. */
const xLabels = (labels: string[], plot: Plot, bandCenter: (i: number) => number): string => {
  const stride = Math.max(1, Math.ceil(labels.length / 8));
  return labels
    .map((label, i) =>
      i % stride === 0 ? text(bandCenter(i), plot.bottom + 16, truncate(label, 14), { size: 9 }) : "",
    )
    .join("");
};

const legend = (names: string[]): string => {
  if (names.length < 2) return "";
  const chips = names
    .map(
      (n, i) =>
        `<span class="chip"><i style="background:${seriesColor(i)}"></i>${escapeHtml(
          truncate(n, 28),
        )}</span>`,
    )
    .join("");
  return `<div class="legend">${chips}</div>`;
};

// ── Chart bodies ─────────────────────────────────────────────────────────────

interface ChartInput {
  rows: Record<string, unknown>[];
  labelCol: string | undefined;
  seriesCols: string[];
  locale?: string | null;
}

const labelsOf = ({ rows, labelCol }: ChartInput): string[] =>
  rows.map((r, i) => (labelCol ? fmtCell(r[labelCol], null) : String(i + 1)));

/**
 * Bars, grouped or stacked.
 *
 * Value labels appear only while they still fit (≤ 12 marks) — past that they
 * overlap into noise, and the y axis is doing the job anyway.
 */
const barsSvg = (input: ChartInput, stacked: boolean): string => {
  const { rows, seriesCols, locale } = input;
  const plot: Plot = { left: 52, right: W - 16, top: 16, bottom: H - 34 };
  const labels = labelsOf(input);
  const values = rows.map((r) => seriesCols.map((c) => num(r[c])));

  const totals = stacked ? values.map((v) => v.reduce((a, b) => a + Math.max(0, b), 0)) : values.flat();
  const rawMax = Math.max(0, ...totals);
  const rawMin = Math.min(0, ...values.flat());
  const max = niceMax(rawMax);
  const min = rawMin < 0 ? -niceMax(-rawMin) : 0;
  const span = max - min || 1;
  const yOf = (v: number): number => plot.bottom - ((v - min) / span) * (plot.bottom - plot.top);

  const bandW = (plot.right - plot.left) / Math.max(1, rows.length);
  const center = (i: number): number => plot.left + bandW * (i + 0.5);
  // Thin marks: the group never fills more than ~62% of its band, and a single
  // series is capped outright. Four wide categories otherwise print as slabs
  // that read like a block diagram rather than a comparison.
  const groupW = Math.min(bandW * 0.62, 56 * (stacked ? 1 : seriesCols.length));
  const barW = stacked ? groupW : Math.max(1, (groupW - (seriesCols.length - 1) * 2) / seriesCols.length);
  const showValues = rows.length * (stacked ? 1 : seriesCols.length) <= 12;

  const marks: string[] = [];
  rows.forEach((_row, i) => {
    let stackTop = 0;
    seriesCols.forEach((_col, s) => {
      const v = values[i]![s]!;
      const color = seriesColor(s);
      if (stacked) {
        const y0 = yOf(stackTop);
        const y1 = yOf(stackTop + v);
        const h = Math.abs(y0 - y1);
        // 2px surface gap between stacked segments, so two adjacent fills stay
        // two marks rather than reading as one long block.
        const drawn = Math.max(0, h - (s > 0 ? 2 : 0));
        marks.push(
          `<path d="${barPath(center(i) - barW / 2, Math.min(y0, y1), barW, drawn, s === seriesCols.length - 1 ? 3 : 0)}" fill="${color}" />`,
        );
        stackTop += v;
      } else {
        const x = center(i) - groupW / 2 + s * (barW + 2);
        const y0 = yOf(0);
        const y1 = yOf(v);
        marks.push(
          `<path d="${barPath(x, Math.min(y0, y1), barW, Math.abs(y0 - y1))}" fill="${color}" />`,
        );
        if (showValues && v !== 0) {
          marks.push(
            text(x + barW / 2, Math.min(y0, y1) - 4, fmtNumber(v, locale), { size: 9, fill: INK }),
          );
        }
      }
    });
    if (stacked && showValues && stackTop !== 0) {
      marks.push(text(center(i), yOf(stackTop) - 4, fmtNumber(stackTop, locale), { size: 9, fill: INK }));
    }
  });

  return [
    svgOpen(),
    yAxis(plot, max, min, locale),
    `<line x1="${plot.left}" y1="${round(yOf(0))}" x2="${plot.right}" y2="${round(yOf(0))}" stroke="${INK_MUTED}" stroke-width="1" />`,
    marks.join(""),
    xLabels(labels, plot, center),
    "</svg>",
  ].join("");
};

/** Line, area, sparkline. The end of each series is labelled directly when few
 *  enough to fit, which is what keeps identity off colour alone. */
const lineSvg = (input: ChartInput, filled: boolean, bare = false): string => {
  const { rows, seriesCols, locale } = input;
  const labelRoom = !bare && seriesCols.length <= 4 && seriesCols.length > 1 ? 84 : 16;
  const plot: Plot = bare
    ? { left: 4, right: W - 4, top: 8, bottom: H - 8 }
    : { left: 52, right: W - labelRoom, top: 16, bottom: H - 34 };
  const labels = labelsOf(input);
  const values = seriesCols.map((c) => rows.map((r) => num(r[c])));
  const flat = values.flat();
  const rawMax = Math.max(0, ...flat);
  const rawMin = Math.min(0, ...flat);
  const max = niceMax(rawMax);
  const min = rawMin < 0 ? -niceMax(-rawMin) : 0;
  const span = max - min || 1;
  const stepX = rows.length > 1 ? (plot.right - plot.left) / (rows.length - 1) : 0;
  const xOf = (i: number): number => (rows.length > 1 ? plot.left + stepX * i : (plot.left + plot.right) / 2);
  const yOf = (v: number): number => plot.bottom - ((v - min) / span) * (plot.bottom - plot.top);

  const marks: string[] = [];
  values.forEach((series, s) => {
    const color = seriesColor(s);
    const points = series.map((v, i) => `${round(xOf(i))},${round(yOf(v))}`).join(" ");
    if (filled && series.length > 1) {
      marks.push(
        `<polygon points="${round(xOf(0))},${round(yOf(min))} ${points} ${round(xOf(series.length - 1))},${round(yOf(min))}" fill="${color}" fill-opacity="0.14" />`,
      );
    }
    marks.push(
      `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`,
    );
    // A one-point series draws no line — without a marker the panel would look
    // empty while holding a value.
    if (series.length === 1) {
      marks.push(`<circle cx="${round(xOf(0))}" cy="${round(yOf(series[0]!))}" r="4" fill="${color}" />`);
    }
    if (labelRoom > 16) {
      const last = series[series.length - 1]!;
      marks.push(
        text(plot.right + 6, yOf(last) + 3.5, truncate(seriesCols[s]!, 12), {
          anchor: "start",
          size: 9,
          fill: color,
          weight: 600,
        }),
      );
    }
  });

  if (bare) return [svgOpen(120), marks.join(""), "</svg>"].join("");
  return [
    svgOpen(),
    yAxis(plot, max, min, locale),
    marks.join(""),
    xLabels(labels, plot, xOf),
    "</svg>",
  ].join("");
};

/** Pie and donut. Slices past the sixth fold into one "Other" — a ring of
 *  fourteen 2% slivers answers nothing. */
const segmentSvg = (input: ChartInput, donut: boolean): string => {
  const { rows, seriesCols, locale } = input;
  const valueCol = seriesCols[0];
  const labels = labelsOf(input);
  const raw = rows.map((r, i) => ({
    label: labels[i] ?? String(i + 1),
    value: valueCol ? Math.max(0, num(r[valueCol])) : 0,
  }));
  const sorted = [...raw].sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, MAX_SEGMENTS);
  const tail = sorted.slice(MAX_SEGMENTS);
  const slices = tail.length
    ? [...head, { label: `Other (${tail.length})`, value: tail.reduce((a, b) => a + b.value, 0) }]
    : head;
  const total = slices.reduce((a, b) => a + b.value, 0);

  const cx = 130;
  const cy = H / 2;
  const r = 92;
  const inner = donut ? 52 : 0;

  const arcs: string[] = [];
  let angle = -Math.PI / 2;
  slices.forEach((slice, i) => {
    const frac = total > 0 ? slice.value / total : 0;
    const sweep = frac * Math.PI * 2;
    const color = seriesColor(i);
    // A single slice covering the whole circle cannot be drawn as an arc — the
    // start and end points coincide and the path collapses to nothing.
    if (frac >= 0.999) {
      arcs.push(
        inner > 0
          ? `<path d="M${cx} ${cy - r}A${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r}ZM${cx} ${cy - inner}A${inner} ${inner} 0 1 0 ${cx - 0.01} ${cy - inner}Z" fill="${color}" fill-rule="evenodd" />`
          : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" />`,
      );
    } else if (frac > 0) {
      const end = angle + sweep;
      const large = sweep > Math.PI ? 1 : 0;
      const p = (rad: number, radius: number): string =>
        `${round(cx + Math.cos(rad) * radius)} ${round(cy + Math.sin(rad) * radius)}`;
      arcs.push(
        inner > 0
          ? `<path d="M${p(angle, r)}A${r} ${r} 0 ${large} 1 ${p(end, r)}L${p(end, inner)}A${inner} ${inner} 0 ${large} 0 ${p(angle, inner)}Z" fill="${color}" stroke="#ffffff" stroke-width="2" />`
          : `<path d="M${cx} ${cy}L${p(angle, r)}A${r} ${r} 0 ${large} 1 ${p(end, r)}Z" fill="${color}" stroke="#ffffff" stroke-width="2" />`,
      );
    }
    angle += sweep;
  });

  // Direct labels, in ink beside a swatch — identity never rests on the fill,
  // which is what the low-contrast slots oblige.
  const rowsOut = slices
    .map((slice, i) => {
      const color = seriesColor(i);
      const y = H / 2 - (slices.length - 1) * 11 + i * 22;
      const pct = total > 0 ? Math.round((slice.value / total) * 100) : 0;
      return [
        `<rect x="256" y="${round(y - 8)}" width="10" height="10" rx="2" fill="${color}" />`,
        text(274, round(y), truncate(slice.label, 26), { anchor: "start", size: 11, fill: INK }),
        text(W - 12, round(y), `${fmtNumber(slice.value, locale)} · ${pct}%`, {
          anchor: "end",
          size: 11,
          fill: INK_MUTED,
        }),
      ].join("");
    })
    .join("");

  return [svgOpen(), arcs.join(""), rowsOut, "</svg>"].join("");
};

/** Radial reads as "a value per category", so it prints as horizontal bars —
 *  the same comparison without asking a reader to judge arc length. */
const radialSvg = (input: ChartInput): string => {
  const { rows, seriesCols, locale } = input;
  const valueCol = seriesCols[0];
  const labels = labelsOf(input);
  const items = rows
    .map((r, i) => ({ label: labels[i] ?? String(i + 1), value: valueCol ? num(r[valueCol]) : 0 }))
    .slice(0, 8);
  const max = niceMax(Math.max(0, ...items.map((i) => i.value)));
  const left = 150;
  const right = W - 70;
  const rowH = Math.min(28, (H - 24) / Math.max(1, items.length));

  const marks = items
    .map((item, i) => {
      const y = 16 + i * rowH;
      const w = max > 0 ? ((right - left) * item.value) / max : 0;
      const color = seriesColor(i);
      return [
        text(left - 10, y + rowH / 2 + 3, truncate(item.label, 20), { anchor: "end", size: 10, fill: INK }),
        `<path d="${barPath(left, y + 4, Math.max(1, w), rowH - 12)}" fill="${color}" />`,
        text(right + 8, y + rowH / 2 + 3, fmtNumber(item.value, locale), {
          anchor: "start",
          size: 10,
          fill: INK,
        }),
      ].join("");
    })
    .join("");
  return [svgOpen(), marks, "</svg>"].join("");
};

// ── Panel bodies ─────────────────────────────────────────────────────────────

const tableHtml = (rows: Record<string, unknown>[], locale?: string | null): string => {
  const allCols = Object.keys(rows[0] ?? {});
  const cols = allCols.slice(0, MAX_REPORT_TABLE_COLS);
  const shown = rows.slice(0, MAX_REPORT_TABLE_ROWS);
  const head = cols
    .map(
      (c) =>
        `<th${typeof rows[0]?.[c] === "number" ? ' class="n"' : ""}>${escapeHtml(truncate(c, 24))}</th>`,
    )
    .join("");
  const body = shown
    .map(
      (r) =>
        `<tr>${cols
          .map(
            (c) =>
              `<td${typeof r[c] === "number" ? ' class="n"' : ""}>${escapeHtml(
                truncate(fmtCell(r[c], locale), 60),
              )}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  const notes: string[] = [];
  if (rows.length > shown.length) notes.push(`${rows.length - shown.length} more rows`);
  if (allCols.length > cols.length) notes.push(`${allCols.length - cols.length} more columns`);
  const footnote = notes.length
    ? `<p class="footnote">Showing ${shown.length} of ${rows.length} rows — ${escapeHtml(notes.join(", "))} not printed.</p>`
    : "";
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${footnote}`;
};

const counterHtml = (rows: Record<string, unknown>[], locale?: string | null): string => {
  const { numericCols } = detectSeries(rows);
  const col = numericCols[0];
  const value = col ? num(rows[0]![col]) : rows.length;
  return `<p class="counter">${escapeHtml(fmtNumber(value, locale))}</p>`;
};

const chartHtml = (viz: ChartViz, rows: Record<string, unknown>[], locale?: string | null): string => {
  const { numericCols, labelCol } = detectSeries(rows);
  const isSegment = (SEGMENT_VIZES as readonly string[]).includes(viz);
  // ONLY numeric columns. Falling back to the remaining text columns would
  // coerce them to zero and draw a chart of flat nothing — which looks like a
  // real answer. The rows still say something, so they get printed instead.
  const seriesCols = numericCols.slice(0, isSegment ? 1 : MAX_SERIES);
  if (seriesCols.length === 0) return tableHtml(rows, locale);
  const input: ChartInput = { rows, labelCol, seriesCols, locale };

  switch (viz) {
    case "bars":
      return legend(seriesCols) + barsSvg(input, false);
    case "stacked-bars":
      return legend(seriesCols) + barsSvg(input, true);
    case "area":
      return legend(seriesCols) + lineSvg(input, true);
    case "line":
      return legend(seriesCols) + lineSvg(input, false);
    case "sparkline":
      return lineSvg(input, true, true);
    case "pie":
      return segmentSvg(input, false);
    case "donut":
      return segmentSvg(input, true);
    case "radial":
      return radialSvg(input);
    default:
      // `radar` — a spider plot printed as one is harder to read than the
      // numbers behind it, and faking it with a different geometry would be a
      // different chart wearing its name.
      return tableHtml(rows, locale);
  }
};

/**
 * One panel's card.
 *
 * A panel that errored prints the error. It would be tidier to drop it, and
 * that is exactly the failure mode worth avoiding: a monthly report whose
 * revenue panel silently disappeared reads as a month with no revenue.
 */
const renderPanel = (panel: ReportPanel, locale?: string | null): string => {
  const head = [
    `<h2>${escapeHtml(panel.name)}</h2>`,
    panel.subtitle ? `<p class="sub">${escapeHtml(panel.subtitle)}</p>` : "",
  ].join("");

  let body: string;
  let wide = true;
  if (panel.error) {
    body = `<p class="error">${escapeHtml(panel.error)}</p>`;
  } else if (panel.data.length === 0) {
    body = `<p class="empty">${escapeHtml(panel.note || "No data for this period.")}</p>`;
    wide = false;
  } else if (panel.viz === "counter") {
    body = counterHtml(panel.data, locale);
    wide = false;
  } else if (isChartViz(panel.viz)) {
    body = chartHtml(panel.viz, panel.data, locale);
  } else {
    body = tableHtml(panel.data, locale);
  }
  return `<section class="panel${wide ? " wide" : ""}">${head}${body}</section>`;
};

// ── The document ─────────────────────────────────────────────────────────────

const STYLE = `
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:${INK};font-size:12px;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}
header{border-bottom:2px solid ${INK};padding-bottom:12px;margin-bottom:20px}
h1{margin:0;font-size:21px;letter-spacing:-0.01em}
header .desc{margin:6px 0 0;color:${INK_MUTED};font-size:12px}
header .stamp{margin:8px 0 0;color:${INK_MUTED};font-size:10.5px;text-transform:uppercase;letter-spacing:0.06em}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.panel{border:1px solid ${GRID};border-radius:8px;padding:14px 16px 16px;break-inside:avoid;page-break-inside:avoid}
.panel.wide{grid-column:1 / -1}
h2{margin:0;font-size:13px;font-weight:600}
.sub{margin:2px 0 10px;color:${INK_MUTED};font-size:10.5px}
.counter{margin:6px 0 2px;font-size:34px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-0.02em}
.empty{margin:8px 0 2px;color:${INK_MUTED};font-style:italic}
.error{margin:8px 0 2px;color:#b3261e;background:#fdf0ef;border:1px solid #f3c9c6;border-radius:6px;padding:8px 10px;word-break:break-word}
.legend{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 6px}
.chip{display:inline-flex;align-items:center;gap:5px;color:${INK_MUTED};font-size:10.5px}
.chip i{width:9px;height:9px;border-radius:2px;display:inline-block}
.chart{display:block;margin-top:2px;overflow:visible}
table{width:100%;border-collapse:collapse;margin-top:6px;font-size:10.5px}
th{text-align:left;font-weight:600;color:${INK_MUTED};border-bottom:1px solid ${GRID};padding:4px 8px 4px 0;white-space:nowrap}
td{padding:4px 8px 4px 0;border-bottom:1px solid #f2f1ed;word-break:break-word}
th.n,td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.footnote{margin:6px 0 0;color:${INK_MUTED};font-size:10px}
footer{margin-top:22px;padding-top:10px;border-top:1px solid ${GRID};color:${INK_MUTED};font-size:10px}
`.trim();

/**
 * Build the whole document. Self-contained: one inline stylesheet, no script,
 * no network reference of any kind — the renderer that prints it is handed
 * nothing it has to go and fetch.
 */
export function buildReportHtml(input: ReportHtmlInput): string {
  const locale = input.locale ?? null;
  const panels = input.panels.map((p) => renderPanel(p, locale)).join("");
  const stamp = fmtStamp(input.generatedAt, locale, input.timeZone);
  const body = input.panels.length
    ? `<div class="grid">${panels}</div>`
    : `<p class="empty">This dashboard has no panels yet.</p>`;

  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>${escapeHtml(input.title)}</title>
<style>${STYLE}</style></head>
<body>
<header>
<h1>${escapeHtml(input.title)}</h1>
${input.description ? `<p class="desc">${escapeHtml(input.description)}</p>` : ""}
<p class="stamp">Generated ${escapeHtml(stamp)}</p>
</header>
${body}
${input.footer ? `<footer>${escapeHtml(input.footer)}</footer>` : ""}
</body></html>`;
}
