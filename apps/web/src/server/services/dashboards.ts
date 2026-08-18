/**
 * Embedded BI dashboards — named groupings of `saved_panels` that can be
 * published to a public, unauthenticated embed URL.
 *
 * Two consumption paths share one panel-runner (`runPanel`):
 *   - Admin (`runDashboard`)        — runs panels with the caller's identity.
 *   - Public embed (`runDashboardPublic`) — runs panels with the dashboard's
 *     `embedRoleId` scope (or fully unscoped when null), with NO session.
 *
 * The embed token (`dsh_<hex>`) is minted once on share and only its SHA-256
 * hash is stored, mirroring `services/shared-links.ts`. Every read/write
 * degrades gracefully (try/catch → null/[]) when the `dashboards` table hasn't
 * been migrated yet, the same posture as `shared-links`.
 */
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { AuthSubject } from "@backlex/core";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { Ctx } from "../context";
import {
  analyticsFunnel,
  analyticsOverview,
  analyticsRealtime,
  analyticsSessions,
  analyticsRetention,
} from "./analytics";
import { runItemsAggregate } from "./items/aggregate";
import { requireKpi, runKpiForCaller } from "./kpis";
import { queryAll } from "./items/sql-helpers";
import { resolvePermission } from "./permissions";
import { hashToken } from "./shared-links";

const dashTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.dashboards : sqlite.schema.dashboards;
const panelTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.savedPanels : sqlite.schema.savedPanels;
const roleTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.roles : sqlite.schema.roles;

const EMBED_TOKEN_PREFIX = "dsh";
const EMBED_TOKEN_BYTES = 24;

const randomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Reject anything that isn't a single SELECT — same guard as routes/panels.ts.
 * SQL panels are admin-authored; this stops a panel from being abused as a
 * generic write gateway, including on the public embed path.
 */
export const isReadOnlySelect = (s: string): boolean => {
  const trimmed = s.trim().replace(/;$/, "");
  if (!/^select\b/i.test(trimmed)) return false;
  if (
    /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|attach|detach)\b/i.test(
      trimmed,
    )
  )
    return false;
  return true;
};

export interface DashboardRow {
  id: string;
  tenantId: string | null;
  name: string;
  description: string | null;
  layout: Record<string, unknown> | null;
  embedEnabled: boolean | number;
  embedTokenHash: string | null;
  embedRoleId: string | null;
  createdBy: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

export interface DashboardInput {
  name: string;
  description?: string | null;
  layout?: Record<string, unknown> | null;
}

export interface PanelResult {
  panelId: string;
  name: string;
  viz: string;
  kind: string;
  config: unknown;
  data: Record<string, unknown>[];
  note?: string;
  error?: string;
}

/** Public-safe view of a dashboard returned by the embed route — never leaks
 *  the token hash or owner. */
export interface DashboardEmbed {
  id: string;
  name: string;
  description: string | null;
  layout: Record<string, unknown> | null;
  panels: PanelResult[];
}

const isPublic = (row: DashboardRow): boolean => Boolean(row.embedEnabled);

/** Workspace dashboards plus system-global (`tenantId IS NULL`) ones. */
export const listDashboards = async (
  ctx: Ctx,
  tenantId: string,
): Promise<DashboardRow[]> => {
  const t = dashTable(ctx.dialect);
  try {
    return (await (ctx.db as any)
      .select()
      .from(t)
      .where(or(eq(t.tenantId, tenantId), isNull(t.tenantId)))) as DashboardRow[];
  } catch {
    return [];
  }
};

export const getDashboard = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<DashboardRow | null> => {
  const t = dashTable(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.id, id), or(eq(t.tenantId, tenantId), isNull(t.tenantId))))
      .limit(1)) as DashboardRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
};

export const createDashboard = async (
  ctx: Ctx,
  auth: AuthSubject,
  tenantId: string,
  input: DashboardInput,
): Promise<DashboardRow> => {
  const t = dashTable(ctx.dialect);
  const id = crypto.randomUUID();
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  const row: DashboardRow = {
    id,
    tenantId,
    name: input.name,
    description: input.description ?? null,
    layout: input.layout ?? null,
    embedEnabled: false,
    embedTokenHash: null,
    embedRoleId: null,
    createdBy: auth.userId,
    createdAt: now,
    updatedAt: now,
  };
  await (ctx.db as any).insert(t).values(row);
  return row;
};

export const updateDashboard = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
  patch: Partial<DashboardInput>,
): Promise<void> => {
  const t = dashTable(ctx.dialect);
  const set: Record<string, unknown> = {
    updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
  };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.layout !== undefined) set.layout = patch.layout;
  await (ctx.db as any)
    .update(t)
    .set(set)
    .where(and(eq(t.id, id), or(eq(t.tenantId, tenantId), isNull(t.tenantId))));
};

/** Delete a dashboard and un-group (don't delete) its panels. */
export const deleteDashboard = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<void> => {
  const t = dashTable(ctx.dialect);
  const p = panelTable(ctx.dialect);
  await (ctx.db as any)
    .update(p)
    .set({ dashboardId: null })
    .where(eq(p.dashboardId, id));
  await (ctx.db as any)
    .delete(t)
    .where(and(eq(t.id, id), or(eq(t.tenantId, tenantId), isNull(t.tenantId))));
};

/**
 * Enable the public embed: mint a fresh token (rotating any prior one),
 * optionally scope it to `roleId`. Returns the one-time plaintext token.
 */
export const shareDashboard = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
  opts: { roleId?: string | null } = {},
): Promise<{ token: string; url: string }> => {
  const t = dashTable(ctx.dialect);
  const existing = await getDashboard(ctx, tenantId, id);
  if (!existing) throw new AppError("NOT_FOUND", "Dashboard not found");
  const token = `${EMBED_TOKEN_PREFIX}_${randomHex(EMBED_TOKEN_BYTES)}`;
  const tokenHash = await hashToken(token);
  await (ctx.db as any)
    .update(t)
    .set({
      embedEnabled: true,
      embedTokenHash: tokenHash,
      embedRoleId: opts.roleId ?? null,
      updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
    })
    .where(and(eq(t.id, id), or(eq(t.tenantId, tenantId), isNull(t.tenantId))));
  return { token, url: `/embed/d/${token}` };
};

/** Disable the public embed and forget the token (idempotent). */
export const revokeDashboardEmbed = async (
  ctx: Ctx,
  tenantId: string,
  id: string,
): Promise<void> => {
  const t = dashTable(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({
      embedEnabled: false,
      embedTokenHash: null,
      updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
    })
    .where(and(eq(t.id, id), or(eq(t.tenantId, tenantId), isNull(t.tenantId))));
};

/**
 * Resolve a plaintext embed token to its dashboard row. Null when the token is
 * malformed/unknown, the embed is disabled, or the table is missing.
 */
export const resolveEmbedToken = async (
  ctx: Ctx,
  token: string,
): Promise<DashboardRow | null> => {
  if (!token || !token.startsWith(`${EMBED_TOKEN_PREFIX}_`)) return null;
  const tokenHash = await hashToken(token);
  const t = dashTable(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.embedTokenHash, tokenHash))
      .limit(1)) as DashboardRow[];
    const row = rows[0];
    if (!row || !isPublic(row)) return null;
    return row;
  } catch {
    return null;
  }
};

const panelsOf = async (
  ctx: Ctx,
  tenantId: string,
  dashboardId: string,
): Promise<any[]> => {
  const p = panelTable(ctx.dialect);
  return (await (ctx.db as any)
    .select()
    .from(p)
    .where(
      and(
        eq(p.dashboardId, dashboardId),
        or(eq(p.tenantId, tenantId), isNull(p.tenantId)),
      ),
    )
    .orderBy(asc(p.createdAt))) as any[];
};

/** Metrics an `analytics` panel can plot. */
export const ANALYTICS_PANEL_METRICS = [
  "totals",
  "series",
  "top-events",
  "top-paths",
  "top-referrers",
  "sources",
  "funnel",
  "retention",
  "realtime",
  "sessions",
  "top-countries",
  "top-devices",
  "top-campaigns",
] as const;
export type AnalyticsPanelMetric = (typeof ANALYTICS_PANEL_METRICS)[number];

/**
 * Run an `analytics` panel and flatten the result into the row shape the panel
 * renderer expects: the first non-numeric column is the label, numeric columns
 * are the series.
 *
 * Unlike `items-aggregate`, there is no per-role clamp to apply on the embed
 * path — the analytics stream has no row-level owner, only counts. Analytics
 * panels are therefore treated like `sql` panels on a public embed: admin-
 * authored, and published only because an admin explicitly enabled the embed.
 */
export const runAnalyticsPanel = async (
  ctx: Ctx,
  tenantId: string,
  config: any,
): Promise<Record<string, unknown>[]> => {
  const metric: AnalyticsPanelMetric = (ANALYTICS_PANEL_METRICS as readonly string[]).includes(
    config?.metric,
  )
    ? config.metric
    : "series";
  // `runPanel` carries the workspace as `""` for the default tenant, while the
  // analytics tables store NULL there — normalise before querying.
  const scopeTenant = tenantId || null;
  const rangeDays = Math.min(365, Math.max(1, Math.floor(Number(config?.rangeDays) || 30)));
  const to = Date.now();
  const from = to - rangeDays * 86_400_000;
  const dbCtx = { db: ctx.db, dialect: ctx.dialect };

  if (metric === "sessions") {
    const s = await analyticsSessions(dbCtx, {
      tenantId: scopeTenant,
      from,
      to,
      siteId: typeof config?.siteId === "string" ? config.siteId : null,
    });
    // One row of headline figures — the panel renderer reads the first
    // non-numeric column as the label, so there is none and every column is a
    // series, which is what a stat-style panel wants.
    return [
      {
        sessions: s.sessions,
        pageviews: s.pageviews,
        bounceRatePct: Math.round(s.bounceRate * 100),
        avgDurationSec: Math.round(s.avgDurationMs / 1000),
        pagesPerSession: Number(s.pagesPerSession.toFixed(2)),
      },
    ];
  }

  if (metric === "realtime") {
    // Deliberately ignores `rangeDays`: "the last 30 minutes" is the metric, not
    // a window the panel author picks. A dashboard asking for 90 days of
    // realtime is asking for something that does not exist.
    const rt = await analyticsRealtime(dbCtx, {
      tenantId: scopeTenant,
      siteId: typeof config?.siteId === "string" ? config.siteId : null,
    });
    return rt.byMinute.map((b) => ({
      minute: new Date(b.minute).toISOString().slice(11, 16),
      events: b.events,
      visitors: b.visitors,
    }));
  }

  if (metric === "funnel") {
    const steps = Array.isArray(config?.steps) ? config.steps.map(String) : [];
    const { steps: rows } = await analyticsFunnel(dbCtx, {
      tenantId: scopeTenant,
      from,
      to,
      steps,
      windowDays: Number(config?.windowDays) || undefined,
    });
    return rows.map((s) => ({ step: s.name, users: s.count }));
  }

  if (metric === "retention") {
    const { cohorts, maxOffset } = await analyticsRetention(dbCtx, {
      tenantId: scopeTenant,
      from,
      to,
      event: config?.event ?? null,
    });
    // Collapse the cohort grid into one curve: total users still active N days
    // after their first day. A per-cohort grid needs the dedicated Analytics
    // page — a panel is a single chart.
    const out: Record<string, unknown>[] = [];
    for (let offset = 0; offset <= maxOffset; offset++) {
      let users = 0;
      for (const c of cohorts) users += c.values[offset] ?? 0;
      out.push({ day: `Day ${offset}`, users });
    }
    return out;
  }

  const overview = await analyticsOverview(dbCtx, { tenantId: scopeTenant, from, to });
  switch (metric) {
    case "totals":
      return [overview.totals as unknown as Record<string, unknown>];
    case "top-events":
      return overview.topEvents as unknown as Record<string, unknown>[];
    case "top-paths":
      return overview.topPaths as unknown as Record<string, unknown>[];
    case "top-referrers":
      return overview.topReferrers as unknown as Record<string, unknown>[];
    case "sources":
      return overview.sources as unknown as Record<string, unknown>[];
    case "top-countries":
      return overview.topCountries as unknown as Record<string, unknown>[];
    case "top-devices":
      return overview.topDevices as unknown as Record<string, unknown>[];
    case "top-campaigns":
      return overview.topCampaigns as unknown as Record<string, unknown>[];
    default:
      return overview.series as unknown as Record<string, unknown>[];
  }
};

/**
 * Run a single panel and shape the result. `scope` (when supplied) carries the
 * embed role's resolved read permission so items-aggregate panels never expose
 * rows/fields the embed role can't read.
 */
const runPanel = async (
  ctx: Ctx,
  auth: AuthSubject,
  tenantId: string,
  panel: any,
  scope: { embedRoleName: string | null } | null,
): Promise<PanelResult> => {
  const base: Omit<PanelResult, "data"> = {
    panelId: panel.id,
    name: panel.name,
    viz: panel.viz,
    kind: panel.kind,
    config: panel.config ?? null,
  };
  try {
    if (panel.kind === "items-aggregate") {
      // For the public embed, resolve the embed role's read permission against
      // the aggregate's target collection and clamp the query to it.
      let opts = {};
      if (scope) {
        const coll = (panel.config as any)?.collection;
        if (typeof coll === "string" && coll) {
          const embedAuth: AuthSubject = {
            plane: "platform",
            userId: null,
            email: null,
            roles: scope.embedRoleName ? [scope.embedRoleName] : ["public"],
            tenantId,
          };
          const perm = await resolvePermission(ctx, embedAuth, coll, "read");
          if (!perm.allowed)
            return { ...base, data: [], error: "Not permitted for this embed." };
          opts = { permWhere: perm.whereSql, allowedFields: perm.fields };
        }
      }
      const data = await runItemsAggregate(ctx, auth, tenantId, panel.config, opts);
      return { ...base, data };
    }
    if (panel.kind === "kpi") {
      // The panel stores only a slug, so the tile and every other surface read
      // the SAME definition — that is the whole reason this kind exists.
      const ref = (panel.config as any)?.kpi;
      if (typeof ref !== "string" || !ref) {
        return { ...base, data: [], error: "KPI panel has no `config.kpi` slug." };
      }
      const kpi = await requireKpi(ctx, tenantId, ref);
      // Unlike `items-aggregate`, this clamps on the embed path even when the
      // dashboard carries NO embed role: `auth` is then the synthetic `public`
      // subject, and an unauthenticated viewer should get what the public role
      // may read, not an unclamped total.
      const result = await runKpiForCaller(ctx, auth, tenantId, kpi, {
        rangeDays: Number((panel.config as any)?.rangeDays) || undefined,
      });
      // Flatten onto the {label, value} shape every panel viz already renders,
      // keeping the comparison fields for tiles that show a delta.
      const data = result.rows
        ? result.rows.map((r) => ({ ...r }))
        : [{ label: result.name, ...(result.point ?? {}) }];
      return { ...base, data };
    }
    if (panel.kind === "analytics") {
      const data = await runAnalyticsPanel(ctx, tenantId, panel.config);
      return { ...base, data };
    }
    if (panel.kind === "sql" && panel.sql) {
      if (!isReadOnlySelect(panel.sql as string))
        return { ...base, data: [], error: "Panel SQL is not read-only." };
      const data = await queryAll<Record<string, unknown>>(
        ctx,
        sql.raw(panel.sql as string),
      );
      return { ...base, data };
    }
    return { ...base, data: [], note: "Static panel — render from config." };
  } catch (e) {
    return { ...base, data: [], error: (e as Error).message };
  }
};

/** Run every panel in a dashboard with the caller's (admin) identity. */
export const runDashboard = async (
  ctx: Ctx,
  auth: AuthSubject,
  tenantId: string,
  id: string,
): Promise<PanelResult[]> => {
  const panels = await panelsOf(ctx, tenantId, id);
  const out: PanelResult[] = [];
  for (const panel of panels)
    out.push(await runPanel(ctx, auth, tenantId, panel, null));
  return out;
};

/**
 * Run a dashboard for a public embed — NO session. Panel data is scoped to the
 * dashboard's `embedRoleId` (resolved to its role name for the DSL); a null
 * role means fully public stats (unscoped read).
 */
export const runDashboardPublic = async (
  ctx: Ctx,
  dashboard: DashboardRow,
): Promise<DashboardEmbed> => {
  const tenantId = dashboard.tenantId ?? "";
  let embedRoleName: string | null = null;
  if (dashboard.embedRoleId) {
    try {
      const r = roleTable(ctx.dialect);
      const rows = (await (ctx.db as any)
        .select()
        .from(r)
        .where(eq(r.id, dashboard.embedRoleId))
        .limit(1)) as { name: string }[];
      embedRoleName = rows[0]?.name ?? null;
    } catch {
      embedRoleName = null;
    }
  }
  // Synthetic auth for runItemsAggregate's signature; the real clamp comes from
  // the resolved permission opts passed via `scope`.
  const embedAuth: AuthSubject = {
    plane: "platform",
    userId: null,
    email: null,
    roles: embedRoleName ? [embedRoleName] : ["public"],
    tenantId,
  };
  const scope = dashboard.embedRoleId ? { embedRoleName } : null;
  const panels = await panelsOf(ctx, tenantId, dashboard.id);
  const results: PanelResult[] = [];
  for (const panel of panels)
    results.push(await runPanel(ctx, embedAuth, tenantId, panel, scope));
  return {
    id: dashboard.id,
    name: dashboard.name,
    description: dashboard.description,
    layout: dashboard.layout,
    panels: results,
  };
};
