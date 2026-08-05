/**
 * Named KPIs — the shared definition layer every surface reads a figure from.
 *
 * A KPI row says what a figure MEANS (which collection, which aggregate,
 * over which rows, printed how); `runKpi` is the only thing that evaluates
 * one. Panels, Ask AI, reports and the public embed all resolve through here,
 * so the number on a chart and the number an agent quotes come from the same
 * arithmetic instead of three independent guesses at it.
 *
 * Aggregation itself is NOT reimplemented — every run delegates to
 * `runItemsAggregate`, which already settles money rescaling, the refusal to
 * total a column whose currency varies per row, and soft-delete/draft
 * visibility. What this module adds on top is the period comparison: the same
 * definition evaluated over the requested window and over the window
 * immediately before it, paired up.
 */
import { and, asc, eq } from "drizzle-orm";
import type { AuthSubject } from "@backlex/core";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Ctx } from "../context";
import { type AggregateOpts, runItemsAggregate } from "./items/aggregate";
import { serialize } from "./items/serialize";
import { resolvePermission } from "./permissions";

export const KPI_FORMATS = ["number", "money", "percent", "duration"] as const;
export type KpiFormat = (typeof KPI_FORMATS)[number];

/** Which way is good news — the delta's sign does not carry its own meaning. */
export const KPI_DIRECTIONS = ["up", "down", "neutral"] as const;
export type KpiDirection = (typeof KPI_DIRECTIONS)[number];

/** Aggregates whose absence of rows is a real zero rather than "undefined".
 *  No orders in a window means zero revenue; it does NOT mean the average
 *  order value was zero, which is why avg/min/max stay null instead. */
const ZERO_ON_EMPTY = new Set(["count", "sum"]);

const kpisTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.kpis : sqlite.schema.kpis;

export interface KpiRow {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  collection: string;
  agg: string;
  field: string | null;
  filter: Record<string, unknown> | null;
  dateField: string | null;
  groupBy: string | null;
  topN: number | null;
  format: string;
  unit: string | null;
  decimals: number | null;
  direction: string;
  alertOperator: string | null;
  alertValue: number | null;
  /** Whether the KPI is CURRENTLY breaching — the flag that makes an alert
   *  fire on the transition rather than on every scheduler tick. */
  alertFiring: boolean;
  alertLastFiredAt: Date | number | null;
  /** The collection whose ITEM PAGE this tile belongs on — not the collection
   *  the KPI aggregates. */
  pinTo: string | null;
  /** The relation column on the KPI's own collection pointing back at that row. */
  pinField: string | null;
  createdBy: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

/** How a KPI's threshold is breached. `change_*` compare `deltaPct`, so their
 *  value is a FRACTION (0.2 = 20%) — the units the result reports in. */
export const KPI_ALERT_OPERATORS = [
  "above",
  "below",
  "change_above",
  "change_below",
] as const;
export type KpiAlertOperator = (typeof KPI_ALERT_OPERATORS)[number];

export interface KpiInput {
  slug: string;
  name: string;
  description?: string | null;
  collection: string;
  agg: string;
  field?: string | null;
  filter?: Record<string, unknown> | null;
  dateField?: string | null;
  groupBy?: string | null;
  topN?: number | null;
  format?: string;
  unit?: string | null;
  decimals?: number | null;
  direction?: string;
  alertOperator?: string | null;
  alertValue?: number | null;
  pinTo?: string | null;
  pinField?: string | null;
}

/** Half-open [from, to) in epoch ms. Half-open on purpose: a row landing
 *  exactly on the boundary must belong to one window, not to both. */
export interface KpiWindow {
  from: number;
  to: number;
}

export interface KpiWindowInput {
  from?: number;
  to?: number;
  rangeDays?: number;
  /** Also return a bucketed series across the window (for a sparkline). Costs
   *  one extra query per KPI, so it is opt-in rather than always-on. */
  series?: boolean;
  /** How many buckets. Clamped; the default is a readable sparkline width. */
  buckets?: number;
  /**
   * Narrow the whole evaluation to one row of the KPI's `pinTo` collection.
   *
   * Only meaningful on a pinned KPI, and IGNORED on one that is not pinned —
   * rather than silently returning the collection-wide figure under a row's
   * heading, which would read as "this product made £40,000".
   */
  rowId?: string;
}

/** One slice of a KPI's window. `t` is the bucket's START, epoch ms. */
export interface KpiSeriesPoint {
  t: number;
  value: number | null;
}

const DEFAULT_BUCKETS = 24;
const MAX_BUCKETS = 200;

export interface KpiPoint {
  /** Present only for a grouped metric. */
  label?: string;
  value: number | null;
  previousValue: number | null;
  delta: number | null;
  /** Fractional change (0.12 = +12%), or null when there is no meaningful
   *  baseline to divide by. */
  deltaPct: number | null;
  currency?: string | null;
}

export interface KpiResult {
  slug: string;
  name: string;
  description: string | null;
  collection: string;
  format: string;
  unit: string | null;
  decimals: number | null;
  direction: string;
  groupBy: string | null;
  /** Null when the metric has no `dateField`: it reports a running total and
   *  no comparison, rather than inventing a previous period. */
  window: KpiWindow | null;
  previousWindow: KpiWindow | null;
  /** Ungrouped result. Null for a grouped metric — read `rows` instead. */
  point: KpiPoint | null;
  /** Grouped result, ordered by current value desc. Null when ungrouped. */
  rows: KpiPoint[] | null;
  /**
   * The window sliced into buckets, oldest first — the shape behind the
   * number. Null unless asked for, and null regardless for a KPI with no
   * `dateField` (nothing to slice on) or a grouped one (a series and a ranking
   * are two questions, and a query has one grouping dimension).
   */
  series: KpiSeriesPoint[] | null;
  /** When the numbers were computed — drives the freshness indicator. */
  computedAt: number;
}

const DEFAULT_RANGE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Resolve the requested window, or null when the metric has no time dimension.
 *
 * A metric without a `dateField` cannot be compared across periods: there is no
 * column that says when a row belongs. Returning null here (rather than
 * silently windowing on `created_at`) is what stops "total customers" from
 * reporting a delta that actually describes when rows were imported.
 */
export const resolveWindows = (
  kpi: Pick<KpiRow, "dateField">,
  input: KpiWindowInput | undefined,
): { window: KpiWindow | null; previous: KpiWindow | null } => {
  if (!kpi.dateField) return { window: null, previous: null };
  const to = input?.to ?? Date.now();
  const from =
    input?.from ??
    to - Math.max(1, Math.floor(input?.rangeDays ?? DEFAULT_RANGE_DAYS)) * DAY_MS;
  if (!(from < to)) {
    throw new AppError("VALIDATION", "KPI window `from` must be before `to`");
  }
  const duration = to - from;
  return {
    window: { from, to },
    previous: { from: from - duration, to: from },
  };
};

/**
 * Put a window bound into the form the column actually stores.
 *
 * This cannot be left to `normalizeTemporalOperands`: that only rewrites
 * operands on columns declared `type: "timestamp"` in `collections.fields`, and
 * the most common `dateField` of all — `created_at` — is a system column that
 * never appears there. An ISO string compared against SQLite's INTEGER epoch
 * column does not merely fail, it inverts (every number sorts before every
 * string), so the window would return the rows OUTSIDE it and say nothing.
 * Serializing here, through the same function the write path uses, keeps the
 * comparison in the column's own units on both dialects.
 */
const windowOperand = (ms: number, dialect: "pg" | "sqlite"): unknown =>
  serialize(new Date(ms), "timestamp", dialect);

/** AND the window onto the metric's own filter without clobbering it — a
 *  metric may already constrain the very column being windowed. */
const withWindow = (
  filter: Record<string, unknown> | null | undefined,
  dateField: string,
  w: KpiWindow,
  dialect: "pg" | "sqlite",
): Record<string, unknown> => {
  const windowCond = {
    [dateField]: {
      _gte: windowOperand(w.from, dialect),
      _lt: windowOperand(w.to, dialect),
    },
  };
  if (!filter || Object.keys(filter).length === 0) return windowCond;
  return { $and: [filter, windowCond] };
};

/** Coerce one aggregate row's `value`, applying the empty-window rule. */
const readValue = (raw: unknown, agg: string): number | null => {
  if (raw === null || raw === undefined) return ZERO_ON_EMPTY.has(agg) ? 0 : null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return ZERO_ON_EMPTY.has(agg) ? 0 : null;
  return n;
};

/**
 * Pair a current value with its baseline.
 *
 * `deltaPct` is null when the baseline is zero or absent. The alternatives are
 * both lies: dividing by zero prints Infinity, and treating "0 → 5" as +100%
 * claims a proportion that does not exist. A caller that wants to say "new"
 * can see `previousValue === 0` and decide that itself.
 */
const pairPoint = (
  value: number | null,
  previousValue: number | null,
  extra: Omit<KpiPoint, "value" | "previousValue" | "delta" | "deltaPct"> = {},
): KpiPoint => {
  const delta =
    value !== null && previousValue !== null ? value - previousValue : null;
  const deltaPct =
    delta !== null && previousValue !== null && previousValue !== 0
      ? // Divide by the magnitude, so a baseline that is negative does not
        // invert the sign of an improvement.
        delta / Math.abs(previousValue)
      : null;
  return { ...extra, value, previousValue, delta, deltaPct };
};

/**
 * Evaluate a metric definition, with a period comparison when it has a date
 * dimension. The caller's read permission is passed straight through to the
 * aggregate, so a metric can never total rows or columns its reader could not
 * have listed directly.
 */
export const runKpi = async (
  ctx: Ctx,
  auth: AuthSubject,
  tenantId: string,
  kpi: KpiRow,
  windowInput?: KpiWindowInput,
  opts: AggregateOpts = {},
): Promise<KpiResult> => {
  const { window, previous } = resolveWindows(kpi, windowInput);
  /**
   * The row scope, when this is a pinned KPI and a row was named.
   *
   * ANDed like the window rather than merged into `filter`, so a definition
   * that already constrains the same relation keeps its own clause. Ignored
   * when the KPI is not pinned — returning the collection-wide figure under a
   * row's heading would read as "this product made £40,000", which is the kind
   * of confidently wrong number this whole layer exists to prevent.
   */
  const rowScope =
    windowInput?.rowId && kpi.pinTo && kpi.pinField
      ? { [kpi.pinField]: { _eq: windowInput.rowId } }
      : null;
  /** The KPI's own filter with the row scope folded in, before any window. */
  const scopedFilter = ((): Record<string, unknown> | null => {
    if (!rowScope) return kpi.filter;
    if (!kpi.filter || Object.keys(kpi.filter).length === 0) return rowScope;
    return { $and: [kpi.filter, rowScope] };
  })();
  const baseConfig = {
    collection: kpi.collection,
    agg: kpi.agg,
    ...(kpi.field ? { field: kpi.field } : {}),
    ...(kpi.groupBy ? { groupBy: kpi.groupBy } : {}),
    ...(kpi.topN ? { limit: kpi.topN } : {}),
  };
  const run = (w: KpiWindow | null) =>
    runItemsAggregate(
      ctx,
      auth,
      tenantId,
      {
        ...baseConfig,
        filter: w
          ? withWindow(scopedFilter, kpi.dateField as string, w, ctx.dialect)
          : (scopedFilter ?? undefined),
      },
      opts,
    );

  /**
   * The window sliced into buckets. Skipped for a grouped KPI (a query has one
   * grouping dimension) and, obviously, for one with no date column.
   *
   * Every bucket in the range is emitted, not just the ones the query returned:
   * a slice with no rows is a real gap in the shape, and letting the chart join
   * the two neighbours across it draws a line that says the quiet period never
   * happened. `count`/`sum` fill it with 0 — no rows is genuinely none — while
   * `avg`/`min`/`max` stay null, because "no orders" is not "an average of
   * zero".
   */
  const loadSeries = async (): Promise<KpiSeriesPoint[] | null> => {
    if (!windowInput?.series || !window || !kpi.dateField || kpi.groupBy) return null;
    const count = Math.min(
      MAX_BUCKETS,
      Math.max(2, Math.floor(windowInput.buckets ?? DEFAULT_BUCKETS)),
    );
    const widthMs = Math.max(1, Math.ceil((window.to - window.from) / count));
    const rows = await runItemsAggregate(
      ctx,
      auth,
      tenantId,
      {
        ...baseConfig,
        // A series is a shape over time, so the ranking dimension is dropped.
        groupBy: undefined,
        limit: undefined,
        filter: withWindow(scopedFilter, kpi.dateField, window, ctx.dialect),
      },
      {
        ...opts,
        bucket: { field: kpi.dateField, from: window.from, widthMs, count },
      },
    );
    const byIndex = new Map<number, unknown>();
    for (const r of rows) byIndex.set(Number(r.label), r.value);
    return Array.from({ length: count }, (_, i) => ({
      t: window.from + i * widthMs,
      value: readValue(byIndex.get(i), kpi.agg),
    }));
  };

  const meta = {
    slug: kpi.slug,
    name: kpi.name,
    description: kpi.description,
    collection: kpi.collection,
    format: kpi.format,
    unit: kpi.unit,
    decimals: kpi.decimals,
    direction: kpi.direction,
    groupBy: kpi.groupBy,
    window,
    previousWindow: previous,
    computedAt: Date.now(),
  };

  const currentRows = await run(window);
  // Only pay for the second query when there is a period to compare against.
  const previousRows = previous ? await run(previous) : null;
  const series = await loadSeries();

  if (!kpi.groupBy) {
    const value = readValue(currentRows[0]?.value, kpi.agg);
    const previousValue = previousRows
      ? readValue(previousRows[0]?.value, kpi.agg)
      : null;
    const currency = (currentRows[0]?.currency as string | undefined) ?? null;
    return {
      ...meta,
      point: pairPoint(value, previousValue, currency ? { currency } : {}),
      rows: null,
      series,
    };
  }

  // Grouped: a label missing from the previous window means that group had no
  // rows then — a real zero for count/sum, and genuinely unknown for avg/min/
  // max, which `readValue(undefined)` already distinguishes.
  const previousByLabel = new Map<string, unknown>();
  for (const row of previousRows ?? []) {
    previousByLabel.set(String(row.label), row.value);
  }
  const rows = currentRows.map((row) => {
    const label = String(row.label);
    const previousValue = previousRows
      ? readValue(previousByLabel.get(label), kpi.agg)
      : null;
    const currency = (row.currency as string | undefined) ?? null;
    return pairPoint(readValue(row.value, kpi.agg), previousValue, {
      label,
      ...(currency ? { currency } : {}),
    });
  });
  return { ...meta, point: null, rows, series };
};

/**
 * Evaluate a metric with the caller's own read visibility resolved for it.
 *
 * Every surface that runs a KPI must call THIS, not `runKpi` directly.
 * KPI definitions are admin-authored, but a KPI is read by whoever opens
 * the page it sits on — so the evaluation has to be clamped to what that reader
 * could have listed for themselves. Without the clamp a KPI tile becomes an
 * oracle: `count` over a collection they hold no grant on, `max(salary)` over
 * rows a row-level condition hides, or a total that silently includes the
 * drafts and soft-deleted rows every other endpoint hides from them.
 *
 * The visibility rules mirror `POST /items/{slug}/aggregate` exactly, because
 * agreeing with the list endpoint is the whole point of the definition layer.
 */
export const runKpiForCaller = async (
  ctx: Ctx,
  auth: AuthSubject,
  tenantId: string,
  kpi: KpiRow,
  windowInput?: KpiWindowInput,
): Promise<KpiResult> => {
  const perm = await resolvePermission(ctx, auth, kpi.collection, "read");
  if (!perm.allowed) {
    throw new AppError(
      "FORBIDDEN",
      `No permission to read collection "${kpi.collection}"`,
    );
  }
  const canSeeDrafts =
    Boolean(perm.isAdmin) ||
    (await resolvePermission(ctx, auth, kpi.collection, "publish")).allowed ||
    (await resolvePermission(ctx, auth, kpi.collection, "update")).allowed;
  return runKpi(ctx, auth, tenantId, kpi, windowInput, {
    permWhere: perm.whereSql,
    allowedFields: perm.fields,
    excludeSoftDeleted: true,
    excludeDrafts: !canSeeDrafts,
  });
};

/* ------------------------------------------------------------------ *
 * CRUD — shared by the REST route, the MCP tools and the CLI, so the
 * validation and tenant scoping cannot drift between surfaces.
 * ------------------------------------------------------------------ */

const rowToKpi = (row: Record<string, unknown>): KpiRow => ({
  id: row.id as string,
  tenantId: (row.tenantId ?? row.tenant_id ?? "") as string,
  slug: row.slug as string,
  name: row.name as string,
  description: (row.description ?? null) as string | null,
  collection: row.collection as string,
  agg: row.agg as string,
  field: (row.field ?? null) as string | null,
  filter: (row.filter ?? null) as Record<string, unknown> | null,
  dateField: (row.dateField ?? row.date_field ?? null) as string | null,
  groupBy: (row.groupBy ?? row.group_by ?? null) as string | null,
  topN: (row.topN ?? row.top_n ?? null) as number | null,
  format: (row.format ?? "number") as string,
  unit: (row.unit ?? null) as string | null,
  decimals: (row.decimals ?? null) as number | null,
  direction: (row.direction ?? "neutral") as string,
  alertOperator: (row.alertOperator ?? row.alert_operator ?? null) as string | null,
  alertValue: (row.alertValue ?? row.alert_value ?? null) as number | null,
  alertFiring: Boolean(row.alertFiring ?? row.alert_firing ?? false),
  alertLastFiredAt: (row.alertLastFiredAt ?? row.alert_last_fired_at ?? null) as
    | Date
    | number
    | null,
  pinTo: (row.pinTo ?? row.pin_to ?? null) as string | null,
  pinField: (row.pinField ?? row.pin_field ?? null) as string | null,
  createdBy: (row.createdBy ?? row.created_by ?? null) as string | null,
  createdAt: (row.createdAt ?? row.created_at ?? null) as Date | number | null,
  updatedAt: (row.updatedAt ?? row.updated_at ?? null) as Date | number | null,
});

/** Every KPI in the workspace, by name. Degrades to `[]` when the table
 *  hasn't been migrated yet — same posture as dashboards/shared-links. */
export const listKpis = async (ctx: Ctx, tenantId: string): Promise<KpiRow[]> => {
  const t = kpisTable(ctx.dialect);
  try {
    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.tenantId, tenantId))
      .orderBy(asc(t.name));
    return (rows as Record<string, unknown>[]).map(rowToKpi);
  } catch {
    return [];
  }
};

/** Resolve by slug — the handle panels and AI tool calls store. */
export const getKpiBySlug = async (
  ctx: Ctx,
  tenantId: string,
  slug: string,
): Promise<KpiRow | null> => {
  const t = kpisTable(ctx.dialect);
  try {
    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.slug, slug)))
      .limit(1);
    const row = (rows as Record<string, unknown>[])[0];
    return row ? rowToKpi(row) : null;
  } catch {
    return null;
  }
};

export const getKpiById = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<KpiRow | null> => {
  const t = kpisTable(ctx.dialect);
  try {
    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))
      .limit(1);
    const row = (rows as Record<string, unknown>[])[0];
    return row ? rowToKpi(row) : null;
  } catch {
    return null;
  }
};

/** Resolve by slug first, then by id, so every surface can accept either. */
export const requireKpi = async (
  ctx: Ctx,
  tenantId: string,
  ref: string,
): Promise<KpiRow> => {
  const found = (await getKpiBySlug(ctx, tenantId, ref)) ?? (await getKpiById(ctx, tenantId, ref));
  if (!found) throw new AppError("NOT_FOUND", `KPI not found: ${ref}`);
  return found;
};

/**
 * Reject a definition that cannot be evaluated, at write time.
 *
 * The aggregate engine already validates the collection, the field types and
 * the mixed-currency case — and it does so with the real schema in hand, which
 * this cannot. What is checked here is only what the engine has no opinion
 * about because it never sees a metric: that a non-count aggregate names a
 * field, and that a metric which is going to be *stored and reused* isn't left
 * in a state that only fails later, on somebody else's dashboard.
 */
const validateInput = (input: KpiInput): void => {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(input.slug)) {
    throw new AppError(
      "VALIDATION",
      "KPI slug must be lowercase alphanumeric with - or _ (it is the handle panels and AI tool calls reference)",
    );
  }
  if (input.agg !== "count" && !input.field) {
    throw new AppError("VALIDATION", `field is required for agg "${input.agg}"`);
  }
  if (input.format && !(KPI_FORMATS as readonly string[]).includes(input.format)) {
    throw new AppError("VALIDATION", `Unknown KPI format: ${input.format}`);
  }
  if (
    input.direction &&
    !(KPI_DIRECTIONS as readonly string[]).includes(input.direction)
  ) {
    throw new AppError("VALIDATION", `Unknown KPI direction: ${input.direction}`);
  }
  if (
    input.alertOperator &&
    !(KPI_ALERT_OPERATORS as readonly string[]).includes(input.alertOperator)
  ) {
    throw new AppError("VALIDATION", `Unknown alert operator: ${input.alertOperator}`);
  }
  // An operator with no threshold is a watch that can never decide, and a
  // threshold with no operator is a number nobody compares against. Either
  // alone is a half-configured alert that would sit there looking like cover.
  if (Boolean(input.alertOperator) !== (input.alertValue !== null && input.alertValue !== undefined)) {
    throw new AppError(
      "VALIDATION",
      "An alert needs both `alertOperator` and `alertValue`, or neither",
    );
  }
  // A `pinTo` with no `pinField` is a tile with nothing to narrow on, and a
  // `pinField` with no `pinTo` is a link to a page it will never appear on.
  if (Boolean(input.pinTo) !== Boolean(input.pinField)) {
    throw new AppError(
      "VALIDATION",
      "A pinned KPI needs both `pinTo` (the item page) and `pinField` (the relation back to that row), or neither",
    );
  }
};

/** Map a driver UNIQUE violation onto the constraint it actually is.
 *
 *  The driver text hides in different places per dialect — D1 puts it on
 *  `cause`, bun:sqlite on `message` — so both are searched; matching only one
 *  passes every test and still 500s in production. */
const isSlugConflict = (e: unknown): boolean => {
  const err = e as { message?: string; cause?: { message?: string } };
  const text = `${err?.message ?? ""} ${err?.cause?.message ?? ""}`.toLowerCase();
  return (
    (text.includes("unique") || text.includes("duplicate")) &&
    (text.includes("kpis_tenant_slug_idx") || text.includes("slug"))
  );
};

export const createKpi = async (
  ctx: Ctx,
  auth: AuthSubject,
  tenantId: string,
  input: KpiInput,
): Promise<KpiRow> => {
  validateInput(input);
  const t = kpisTable(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  const row: KpiRow = {
    id: crypto.randomUUID(),
    tenantId,
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    collection: input.collection,
    agg: input.agg,
    field: input.field ?? null,
    filter: input.filter ?? null,
    dateField: input.dateField ?? null,
    groupBy: input.groupBy ?? null,
    topN: input.topN ?? null,
    format: input.format ?? "number",
    unit: input.unit ?? null,
    decimals: input.decimals ?? null,
    direction: input.direction ?? "neutral",
    alertOperator: input.alertOperator ?? null,
    alertValue: input.alertValue ?? null,
    alertFiring: false,
    alertLastFiredAt: null,
    pinTo: input.pinTo ?? null,
    pinField: input.pinField ?? null,
    createdBy: auth.userId,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await (ctx.db as any).insert(t).values(row);
  } catch (e) {
    // Let the database be the one that decides uniqueness. A pre-flight SELECT
    // here would be the check-then-insert race that has already produced
    // UNIQUE failures against D1 in this codebase.
    if (isSlugConflict(e)) {
      throw new AppError("VALIDATION", `A KPI with slug "${input.slug}" already exists`);
    }
    throw e;
  }
  return row;
};

export const updateKpi = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
  patch: Partial<KpiInput>,
): Promise<KpiRow> => {
  const existing = await getKpiById(ctx, tenantId, id);
  if (!existing) throw new AppError("NOT_FOUND", `KPI not found: ${id}`);
  const merged: KpiInput = {
    slug: patch.slug ?? existing.slug,
    name: patch.name ?? existing.name,
    description: patch.description !== undefined ? patch.description : existing.description,
    collection: patch.collection ?? existing.collection,
    agg: patch.agg ?? existing.agg,
    field: patch.field !== undefined ? patch.field : existing.field,
    filter: patch.filter !== undefined ? patch.filter : existing.filter,
    dateField: patch.dateField !== undefined ? patch.dateField : existing.dateField,
    groupBy: patch.groupBy !== undefined ? patch.groupBy : existing.groupBy,
    topN: patch.topN !== undefined ? patch.topN : existing.topN,
    format: patch.format ?? existing.format,
    unit: patch.unit !== undefined ? patch.unit : existing.unit,
    decimals: patch.decimals !== undefined ? patch.decimals : existing.decimals,
    direction: patch.direction ?? existing.direction,
    alertOperator:
      patch.alertOperator !== undefined ? patch.alertOperator : existing.alertOperator,
    alertValue: patch.alertValue !== undefined ? patch.alertValue : existing.alertValue,
    pinTo: patch.pinTo !== undefined ? patch.pinTo : existing.pinTo,
    pinField: patch.pinField !== undefined ? patch.pinField : existing.pinField,
  };
  validateInput(merged);
  const t = kpisTable(ctx.dialect);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  // `alertFiring` is state about the OLD rule. Editing the threshold — or
  // removing the watch entirely — makes it meaningless, and a stranded `true`
  // is worse than meaningless: the scheduler only looks at watched KPIs, so
  // nothing would ever clear it and the tile would wear a red Alert badge
  // forever. Reset it whenever the rule itself moves; the next tick re-decides.
  const alertRuleChanged =
    merged.alertOperator !== existing.alertOperator ||
    merged.alertValue !== existing.alertValue;
  try {
    await (ctx.db as any)
      .update(t)
      .set({
        ...merged,
        ...(alertRuleChanged ? { alertFiring: false, alertLastFiredAt: null } : {}),
        updatedAt: now,
      })
      .where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
  } catch (e) {
    if (isSlugConflict(e)) {
      throw new AppError("VALIDATION", `A KPI with slug "${merged.slug}" already exists`);
    }
    throw e;
  }
  return {
    ...existing,
    ...merged,
    ...(alertRuleChanged ? { alertFiring: false, alertLastFiredAt: null } : {}),
    updatedAt: now,
  };
};

export const deleteKpi = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<void> => {
  const t = kpisTable(ctx.dialect);
  const existing = await getKpiById(ctx, tenantId, id);
  if (!existing) throw new AppError("NOT_FOUND", `KPI not found: ${id}`);
  await (ctx.db as any).delete(t).where(and(eq(t.tenantId, tenantId), eq(t.id, id)));
};
