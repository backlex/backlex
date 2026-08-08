import { api, API_BASE, captureBookmark, sessionHeaders } from "@/lib/api";
import type { Envelope } from "./types";

export interface ApiPanel {
  id: string;
  name: string;
  description: string | null;
  /** Mirrors the server's `PANEL_KINDS` (routes/panels.ts). It previously
   *  listed only three of the five, so `analytics` and `kpi` panels — which
   *  the API does return — were unrepresentable, and the Insights page's
   *  filter for them read as a comparison with no overlap. */
  kind: "sql" | "items-aggregate" | "analytics" | "kpi" | "static";
  sql: string | null;
  viz: string;
  config: Record<string, unknown> | null;
  layout: { x: number; y: number; w: number; h: number } | null;
  /** Parent dashboard id, or null for a loose (ungrouped) panel. */
  dashboardId?: string | null;
}

export interface ApiDashboard {
  id: string;
  tenantId: string | null;
  name: string;
  description: string | null;
  layout: Record<string, unknown> | null;
  embedEnabled: boolean;
  embedRoleId: string | null;
}

/** A named KPI definition — the shared formula every surface reads a figure
 *  from. See `services/kpis.ts` for why the definition is stored rather than
 *  re-spelled per panel. */
export interface ApiKpi {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  collection: string;
  agg: "count" | "sum" | "avg" | "min" | "max";
  field: string | null;
  filter: Record<string, unknown> | null;
  dateField: string | null;
  groupBy: string | null;
  topN: number | null;
  format: "number" | "money" | "percent" | "duration";
  unit: string | null;
  decimals: number | null;
  direction: "up" | "down" | "neutral";
  /** Watch: notify when the figure crosses `alertValue`. Null = unwatched.
   *  `change_*` compare `deltaPct`, so their value is a FRACTION (0.2 = 20%). */
  alertOperator: "above" | "below" | "change_above" | "change_below" | null;
  alertValue: number | null;
  /** Currently outside the threshold. Server-owned — the flag is what makes an
   *  alert fire on the transition rather than on every scheduler tick. */
  alertFiring: boolean;
  /** The collection whose ITEM PAGE this tile belongs on — not the one the KPI
   *  aggregates. Null = not pinned. */
  pinTo: string | null;
  /** The relation column on the KPI's own collection pointing back at that row. */
  pinField: string | null;
  createdBy: string | null;
}

export interface ApiKpiPoint {
  /** Present only on a grouped KPI's rows. */
  label?: string;
  value: number | null;
  previousValue: number | null;
  delta: number | null;
  /** Fractional change (0.12 = +12%); null when there is no baseline to
   *  divide by, which the UI must render as "—" rather than 0%. */
  deltaPct: number | null;
  currency?: string | null;
}

export interface ApiKpiSeriesPoint {
  /** Bucket START, epoch ms. */
  t: number;
  value: number | null;
}

export interface ApiKpiResult {
  slug: string;
  name: string;
  description: string | null;
  collection: string;
  format: ApiKpi["format"];
  unit: string | null;
  decimals: number | null;
  direction: ApiKpi["direction"];
  groupBy: string | null;
  /** Null when the KPI has no `dateField` — a running total with no period
   *  comparison, which the UI must show WITHOUT a delta badge. */
  window: { from: number; to: number } | null;
  previousWindow: { from: number; to: number } | null;
  point: ApiKpiPoint | null;
  rows: ApiKpiPoint[] | null;
  /** The window in buckets, oldest first. Null unless requested. */
  series: ApiKpiSeriesPoint[] | null;
  computedAt: number;
}

export type ApiKpiInput = Omit<ApiKpi, "id" | "tenantId" | "createdBy" | "alertFiring">;

export interface ApiDashboardReportInput {
  filename?: string;
  pageOptions?: { format?: string; landscape?: boolean; printBackground?: boolean };
  /** Omit to render + store only. */
  email?: { to: string; subject?: string; templateKey?: string };
}

export interface ApiDashboardReport {
  key: string;
  filename: string;
  size: number;
  renderer: string;
  dashboard: { id: string; name: string };
  panels: number;
  failedPanels: number;
  sentTo: string[];
  attachmentsDropped?: boolean;
}

/** A single panel's rendered result from a dashboard run / public embed. */
export interface ApiDashboardPanelResult {
  panelId: string;
  name: string;
  viz: string;
  kind: string;
  config: Record<string, unknown> | null;
  data: Record<string, unknown>[];
  note?: string;
  error?: string;
}

export interface ApiPublicDashboard {
  id: string;
  name: string;
  description: string | null;
  layout: Record<string, unknown> | null;
  panels: ApiDashboardPanelResult[];
}

export const panelsApi = {
  list: () => api<Envelope<ApiPanel[]>>(`/api/admin/panels`),
  create: (body: Omit<ApiPanel, "id">) =>
    api<Envelope<ApiPanel>>(`/api/admin/panels`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<Omit<ApiPanel, "id">>) =>
    api<Envelope<ApiPanel>>(`/api/admin/panels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/panels/${id}`, { method: "DELETE" }),
  run: (id: string) =>
    api<Envelope<Record<string, unknown>[]> & { ms: number }>(`/api/admin/panels/${id}/run`, {
      method: "POST",
    }),
  preview: (body: {
    kind: "sql" | "items-aggregate" | "analytics" | "kpi";
    sql?: string;
    config?: unknown;
  }) =>
    api<Envelope<Record<string, unknown>[]> & { ms: number }>(`/api/admin/panels/preview`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export const kpisApi = {
  list: () => api<Envelope<ApiKpi[]>>(`/api/admin/kpis`),
  get: (ref: string) => api<Envelope<ApiKpi>>(`/api/admin/kpis/${encodeURIComponent(ref)}`),
  create: (body: ApiKpiInput) =>
    api<Envelope<ApiKpi>>(`/api/admin/kpis`, { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: Partial<ApiKpiInput>) =>
    api<Envelope<ApiKpi>>(`/api/admin/kpis/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) => api<{ ok: true }>(`/api/admin/kpis/${id}`, { method: "DELETE" }),
  /** Evaluate one KPI. `rangeDays` is the friendly form; `from`/`to` are epoch
   *  ms for an explicit window. Scoped server-side to the caller's read
   *  permission on the KPI's collection. */
  run: (
    ref: string,
    params: {
      rangeDays?: number;
      from?: number;
      to?: number;
      series?: boolean;
      buckets?: number;
      /** Narrow to one row of the KPI's `pinTo` collection. */
      rowId?: string;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs}` : "";
    return api<Envelope<ApiKpiResult>>(
      `/api/admin/kpis/${encodeURIComponent(ref)}/run${suffix}`,
    );
  },
};

export const dashboardsApi = {
  list: () => api<Envelope<ApiDashboard[]>>(`/api/admin/dashboards`),
  get: (id: string) => api<Envelope<ApiDashboard>>(`/api/admin/dashboards/${id}`),
  create: (body: { name: string; description?: string | null; layout?: Record<string, unknown> | null }) =>
    api<Envelope<ApiDashboard>>(`/api/admin/dashboards`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<{ name: string; description: string | null; layout: Record<string, unknown> | null }>) =>
    api<{ ok: true }>(`/api/admin/dashboards/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/dashboards/${id}`, { method: "DELETE" }),
  run: (id: string) =>
    api<Envelope<ApiDashboardPanelResult[]> & { ms: number }>(`/api/admin/dashboards/${id}/run`, {
      method: "POST",
    }),
  share: (id: string, body: { roleId?: string | null } = {}) =>
    api<{ token: string; url: string }>(`/api/admin/dashboards/${id}/share`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revoke: (id: string) =>
    api<{ ok: true }>(`/api/admin/dashboards/${id}/share`, { method: "DELETE" }),
  report: (id: string, body: ApiDashboardReportInput = {}) =>
    api<ApiDashboardReport>(`/api/admin/dashboards/${id}/report`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** The download shape — bytes, not JSON, so it bypasses the envelope helper
   *  and comes back as a Blob the browser can save. Mirrors `documentsApi.render`. */
  reportPdf: async (id: string, body: ApiDashboardReportInput = {}): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/api/admin/dashboards/${id}/report`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({ ...body, download: true }),
    });
    captureBookmark(res);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(err.error?.message ?? `Report failed (${res.status})`);
    }
    return res.blob();
  },
};

export const dashboardsPublicApi = {
  get: (token: string) =>
    api<Envelope<ApiPublicDashboard>>(`/api/public/dashboards/${encodeURIComponent(token)}`),
};
