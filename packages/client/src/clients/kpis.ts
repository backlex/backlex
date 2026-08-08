import type { ClientCore } from "../core";

/** A named KPI definition — the workspace's agreed formula for one figure.
 *  Mirrors `/api/admin/kpis`. */
export interface Kpi {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  collection: string;
  agg: "count" | "sum" | "avg" | "min" | "max";
  field: string | null;
  filter: Record<string, unknown> | null;
  /** Timestamp column the period window applies to. Null = no comparison. */
  dateField: string | null;
  groupBy: string | null;
  topN: number | null;
  format: "number" | "money" | "percent" | "duration";
  unit: string | null;
  decimals: number | null;
  /** Which way is good news — `up` for revenue, `down` for refunds. */
  direction: "up" | "down" | "neutral";
  createdBy: string | null;
}

export type KpiInput = Omit<Kpi, "id" | "tenantId" | "createdBy">;

export interface KpiPoint {
  /** Present only on a grouped KPI's rows. */
  label?: string;
  /** Null for an avg/min/max over an empty window — which is not a zero. */
  value: number | null;
  previousValue: number | null;
  delta: number | null;
  /** Fractional change (0.12 = +12%). **Null when the previous period was
   *  zero**: there is no proportion to report, so render the absolute `delta`
   *  rather than printing "+100%". */
  deltaPct: number | null;
  currency?: string | null;
}

/** One slice of a KPI's window. `t` is the bucket's START, epoch ms. */
export interface KpiSeriesPoint {
  t: number;
  /** Null for an avg/min/max slice with no rows — which is not a zero. An
   *  empty `count`/`sum` slice IS 0, and every slice in the range is present,
   *  so a chart never joins across a gap and claims it did not happen. */
  value: number | null;
}

export interface KpiResult {
  slug: string;
  name: string;
  description: string | null;
  collection: string;
  format: Kpi["format"];
  unit: string | null;
  decimals: number | null;
  direction: Kpi["direction"];
  groupBy: string | null;
  /** Null when the KPI has no `dateField` — a running total, no comparison. */
  window: { from: number; to: number } | null;
  previousWindow: { from: number; to: number } | null;
  /** The ungrouped figure. Null for a grouped KPI — read `rows`. */
  point: KpiPoint | null;
  /** The ranking, best-first. Null when the KPI is ungrouped. */
  rows: KpiPoint[] | null;
  /** The window in buckets, oldest first — the shape behind the number. Null
   *  unless `series` was requested, and null regardless for a KPI with no
   *  date column or a grouped one. */
  series: KpiSeriesPoint[] | null;
  computedAt: number;
}

/**
 * Named KPIs — the shared definition layer.
 *
 * Reach for `run` instead of composing your own aggregate whenever a KPI
 * already describes the figure: the definition carries which rows count,
 * which date column bounds the period and how the number should be printed,
 * so its answer matches what the admin's dashboard shows. Authoring a
 * definition is admin-only; running one is clamped to the caller's own read
 * permission on the KPI's collection.
 */
export interface KpisClient {
  /** Every KPI definition in the active workspace. */
  list(): Promise<{ data: Kpi[] }>;
  /** Fetch one definition by slug (or id) without evaluating it. */
  get(ref: string): Promise<{ data: Kpi }>;
  /** Define a KPI (admin-only). */
  create(input: KpiInput): Promise<{ data: Kpi }>;
  /** Partial update by id (admin-only). */
  update(id: string, patch: Partial<KpiInput>): Promise<{ data: Kpi }>;
  /** Delete by id (admin-only). */
  delete(id: string): Promise<{ ok: boolean }>;
  /** Evaluate over a window and the window immediately before it. */
  run(
    ref: string,
    opts?: {
      rangeDays?: number;
      from?: number;
      to?: number;
      /** Also return the bucketed series. One extra query per KPI. */
      series?: boolean;
      buckets?: number;
    },
  ): Promise<{ data: KpiResult }>;
}

export const makeKpis = (core: ClientCore): KpisClient => {
  // Named KPIs. Authoring is admin-scoped; `run` only needs a session and is
  // clamped server-side to the caller's read permission on the collection.
  const kpiPath = (ref: string) => `/api/admin/kpis/${encodeURIComponent(ref)}`;
  const kpis: KpisClient = {
    list: () => core.request<{ data: Kpi[] }>("GET", "/api/admin/kpis"),
    get: (ref: string) => core.request<{ data: Kpi }>("GET", kpiPath(ref)),
    create: (input: KpiInput) => core.request<{ data: Kpi }>("POST", "/api/admin/kpis", input),
    update: (id: string, patch: Partial<KpiInput>) =>
      core.request<{ data: Kpi }>("PATCH", kpiPath(id), patch),
    delete: (id: string) => core.request<{ ok: boolean }>("DELETE", kpiPath(id)),
    run: (
      ref: string,
      opts?: {
        rangeDays?: number;
        from?: number;
        to?: number;
        series?: boolean;
        buckets?: number;
      },
    ) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts ?? {})) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const suffix = qs.toString() ? `?${qs}` : "";
      return core.request<{ data: KpiResult }>("GET", `${kpiPath(ref)}/run${suffix}`);
    },
  };

  return kpis;
};
