import type { ClientCore } from "../core";

/** A BI dashboard row — a named grouping of saved panels, optionally published
 *  to a public embed URL. Mirrors `/api/admin/dashboards`. */
export interface Dashboard {
  id: string;
  tenantId?: string | null;
  name: string;
  description: string | null;
  layout?: unknown;
  /** Whether the public embed is currently live. */
  embedEnabled: boolean;
  /** Role the public embed scopes panel data to (null = unscoped public). */
  embedRoleId: string | null;
}

/** Create/update payload for a dashboard. */
export interface DashboardInput {
  name: string;
  description?: string | null;
  layout?: unknown;
}

/** One panel's rendered result inside a dashboard run. */
export interface DashboardPanelResult {
  panelId: string;
  name: string;
  viz: string;
  kind: string;
  config: unknown;
  data: Record<string, unknown>[];
  note?: string;
  error?: string;
}

/** Outcome of minting/rotating a dashboard embed token. The plaintext `token`
 *  is shown once; `url` is the relative embed path. */
export interface DashboardShareResult {
  token: string;
  url: string;
}

/** Embedded BI dashboards (admin-scoped). Mirrors `/api/admin/dashboards`. */
export interface DashboardsClient {
  /** List every dashboard in the active workspace. */
  list(): Promise<{ data: Dashboard[] }>;
  /** Fetch a single dashboard by id. */
  get(id: string): Promise<{ data: Dashboard }>;
  /** Create a dashboard scoped to the active workspace. */
  create(input: DashboardInput): Promise<{ data: Dashboard }>;
  /** Partial update of a dashboard by id. */
  update(id: string, patch: Partial<DashboardInput>): Promise<{ ok: boolean }>;
  /** Delete a dashboard by id (panels are un-grouped, not deleted). */
  delete(id: string): Promise<{ ok: boolean }>;
  /** Run every panel and return their results. */
  run(id: string): Promise<{ data: DashboardPanelResult[]; ms: number }>;
  /** Enable the public embed; mints a one-time token (optionally role-scoped). */
  share(id: string, opts?: { roleId?: string | null }): Promise<DashboardShareResult>;
  /** Disable the public embed and forget the token. */
  revoke(id: string): Promise<{ ok: boolean }>;
  /**
   * Print the dashboard to a PDF and store it; with `email`, mail it too.
   *
   * The stored key comes back either way, so a caller that wants to send the
   * file itself can. Rejects when no PDF renderer is configured — there is no
   * fallback renderer, by design.
   */
  report(id: string, input?: DashboardReportInput): Promise<DashboardReport>;
  /** The same render, returning the PDF bytes instead of the metadata. Cannot
   *  be combined with `email` — a request that asked for both has one of the
   *  two intents wrong, and the server says so. */
  reportPdf(id: string, input?: Omit<DashboardReportInput, "email">): Promise<Uint8Array>;
}

export interface DashboardReportInput {
  /** Defaults to `<dashboard-name>-<date>.pdf`. */
  filename?: string;
  pageOptions?: {
    format?: "A4" | "Letter" | "Legal" | "A3" | "A5";
    landscape?: boolean;
    printBackground?: boolean;
  };
  /** Omit to render + store only. */
  email?: { to: string; subject?: string; templateKey?: string };
}

export interface DashboardReport {
  /** Storage key of the stored PDF. */
  key: string;
  filename: string;
  size: number;
  /** Which renderer produced it, for diagnostics. */
  renderer: string;
  dashboard: { id: string; name: string };
  panels: number;
  /** Panels that failed. The PDF prints their error rather than dropping them. */
  failedPanels: number;
  sentTo: string[];
  /** The covering mail went, WITHOUT the report — the configured transport
   *  cannot carry attachments. */
  attachmentsDropped?: boolean;
}

/* ── Product analytics + crash reporting (#22) ─────────────────────────── */

export const makeDashboards = (core: ClientCore): DashboardsClient => {
  // Embedded BI dashboards. Admin-scoped CRUD over `/api/admin/dashboards`;
  // `run` executes every panel, `share`/`revoke` toggle the public embed token.
  const dash = (id: string) => `/api/admin/dashboards/${encodeURIComponent(id)}`;
  const dashboards: DashboardsClient = {
    list: () => core.request<{ data: Dashboard[] }>("GET", "/api/admin/dashboards"),
    get: (id: string) => core.request<{ data: Dashboard }>("GET", dash(id)),
    create: (input: DashboardInput) =>
      core.request<{ data: Dashboard }>("POST", "/api/admin/dashboards", input),
    update: (id: string, patch: Partial<DashboardInput>) =>
      core.request<{ ok: boolean }>("PATCH", dash(id), patch),
    delete: (id: string) => core.request<{ ok: boolean }>("DELETE", dash(id)),
    run: (id: string) =>
      core.request<{ data: DashboardPanelResult[]; ms: number }>("POST", `${dash(id)}/run`, {}),
    share: (id: string, opts?: { roleId?: string | null }) =>
      core.request<DashboardShareResult>("POST", `${dash(id)}/share`, opts ?? {}),
    revoke: (id: string) => core.request<{ ok: boolean }>("DELETE", `${dash(id)}/share`),
    report: (id: string, input?: DashboardReportInput) =>
      core.request<DashboardReport>("POST", `${dash(id)}/report`, input ?? {}),
    // Bytes, not JSON — same raw path the document render uses.
    reportPdf: async (id: string, input?: Omit<DashboardReportInput, "email">) => {
      const res = await core.requestRaw(
        "POST",
        `${dash(id)}/report`,
        JSON.stringify({ ...(input ?? {}), download: true }),
        "application/json",
      );
      return new Uint8Array(await res.arrayBuffer());
    },
  };

  return dashboards;
};
