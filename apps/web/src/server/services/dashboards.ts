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
  analyticsChannels,
  resolveSegment,
  analyticsRevenue,
  analyticsRealtime,
  analyticsSessions,
  analyticsRetention,
} from "./analytics";
import { type AggregateOpts, runItemsAggregate } from "./items/aggregate";
import { requireKpi, runKpiForCaller } from "./kpis";
import { queryAll } from "./items/sql-helpers";
import { resolvePermission } from "./permissions";
import { assertWritableScope, isInstanceOperator } from "./roles/guards";
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
  auth: AuthSubject,
  tenantId: string,
  id: string,
  patch: Partial<DashboardInput>,
): Promise<void> => {
  await assertWritableScope(ctx, auth, await getDashboard(ctx, tenantId, id), "This dashboard");
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

/**
 * Delete a dashboard and un-group (don't delete) its panels.
 *
 * The early return is load-bearing, not tidiness. The panel detach filters on
 * `dashboard_id` ALONE, and it used to run before — and regardless of — the
 * tenant-scoped delete below it, so a request naming another workspace's
 * dashboard id detached that workspace's panels while deleting nothing. The
 * allowlist entry excusing the unscoped detach said it acted on "the dashboard
 * the scoped delete just removed"; it acted first, on any id. Reading the row
 * under the workspace scope and stopping on a miss is what makes that sentence
 * true. Still silent rather than 404 on a miss: deleting what is not there has
 * always answered `ok`.
 */
export const deleteDashboard = async (
  ctx: Ctx,
  auth: AuthSubject,
  tenantId: string,
  id: string,
): Promise<void> => {
  const existing = await getDashboard(ctx, tenantId, id);
  if (!existing) return;
  await assertWritableScope(ctx, auth, existing, "This dashboard");
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
  auth: AuthSubject,
  tenantId: string,
  id: string,
  opts: { roleId?: string | null } = {},
): Promise<{ token: string; url: string }> => {
  const t = dashTable(ctx.dialect);
  const existing = await getDashboard(ctx, tenantId, id);
  if (!existing) throw new AppError("NOT_FOUND", "Dashboard not found");
  // Publishing a deployment-wide dashboard to an unauthenticated URL is the
  // sharpest edge of the whole `tenant_id IS NULL` write hole: the token is
  // minted by one workspace and serves a dashboard every workspace shares.
  await assertWritableScope(ctx, auth, existing, "This dashboard");
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
  auth: AuthSubject,
  tenantId: string,
  id: string,
): Promise<void> => {
  await assertWritableScope(ctx, auth, await getDashboard(ctx, tenantId, id), "This dashboard");
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
  "channels",
  "revenue",
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
  // A panel may carry a saved segment. Resolved through the SAME tenant-scoped
  // lookup every other caller uses, so a panel cannot borrow another
  // workspace's filter — and re-validated, so a stale definition narrows
  // nothing rather than narrowing wrongly. Note that a segment only ever
  // NARROWS a result, so this adds no disclosure on the public-embed path.
  const to = Date.now();
  const from = to - rangeDays * 86_400_000;
  const dbCtx = { db: ctx.db, dialect: ctx.dialect };
  const segment = await resolveSegment(
    dbCtx,
    scopeTenant,
    typeof config?.segmentId === "string" ? config.segmentId : null,
  );

  if (metric === "revenue") {
    const r = await analyticsRevenue(dbCtx, {
      tenantId: scopeTenant,
      from,
      to,
      siteId: typeof config?.siteId === "string" ? config.siteId : null,
      segment,
    });
    // Currency leads the row so a chart groups by it rather than stacking
    // amounts that cannot be added.
    return r.byCurrency as unknown as Record<string, unknown>[];
  }

  if (metric === "channels") {
    const c = await analyticsChannels(dbCtx, {
      tenantId: scopeTenant,
      from,
      to,
      siteId: typeof config?.siteId === "string" ? config.siteId : null,
      segment,
    });
    return c.channels as unknown as Record<string, unknown>[];
  }

  if (metric === "sessions") {
    const s = await analyticsSessions(dbCtx, {
      tenantId: scopeTenant,
      from,
      to,
      siteId: typeof config?.siteId === "string" ? config.siteId : null,
      segment,
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
      segment,
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

  const overview = await analyticsOverview(dbCtx, {
    tenantId: scopeTenant,
    from,
    to,
    siteId: typeof config?.siteId === "string" ? config.siteId : null,
    segment,
  });
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
 *
 * `allowRawSql` gates the `sql` kind, and it DEFAULTS TO FALSE because most of
 * this function's reachable callers have no business running raw SQL: the
 * public embed (no session at all), a cron tick (`SYSTEM_AUTH`, `roles: []`)
 * and a webhook-triggered flow (unauthenticated by design — the flow id is the
 * secret) all arrive here with a synthetic subject. A default of "permit"
 * would hand each of them `sql.raw` against the whole database. Only
 * `runDashboard` sets it, and only after `isInstanceOperator`.
 */
const runPanel = async (
  ctx: Ctx,
  auth: AuthSubject,
  tenantId: string,
  panel: any,
  scope: { embedRoleName: string | null } | null,
  allowRawSql = false,
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
      // On the embed path, clamp the aggregate to what the viewer may read.
      //
      // `runItemsAggregate` applies NO permission of its own — `permWhere` and
      // `allowedFields` are the whole control — and this branch used to skip
      // resolving them whenever the dashboard carried no embed role. That is
      // the default `shareDashboard` writes (`embedRoleId: null`), so the
      // ordinary way of sharing a dashboard produced an unauthenticated URL
      // that aggregated any collection in the workspace: `groupBy: "email"`
      // returns one label per distinct value, which is a full column read
      // wearing a chart's clothes.
      //
      // So the clamp is unconditional on this path now, exactly as the `kpi`
      // branch below has always been. A dashboard shared with no embed role
      // resolves the `public` role and gets what the workspace granted it —
      // for most workspaces that is nothing, and such a panel now answers
      // "Not permitted for this embed." That is a deliberate behaviour change
      // and the point of the fix: sharing a link was never meant to be a
      // grant.
      let opts: AggregateOpts = {};
      if (scope) {
        const coll = (panel.config as any)?.collection;
        if (typeof coll === "string" && coll) {
          // `auth` IS the embed subject on this path — the caller built it
          // from the same `embedRoleName`. Resolving off a second, locally
          // rebuilt copy is how the two would drift.
          const perm = await resolvePermission(ctx, auth, coll, "read");
          if (!perm.allowed)
            return { ...base, data: [], error: "Not permitted for this embed." };
          // Soft-deleted rows and unpublished drafts are excluded for the same
          // reason `runKpiForCaller` excludes them: a count is a read, and a
          // viewer who cannot see the row must not learn it exists from the
          // total. The admin path (scope === null) deliberately keeps them —
          // "rows grouped by `deleted_at`" is a real dashboard question.
          opts = {
            permWhere: perm.whereSql,
            allowedFields: perm.fields,
            excludeSoftDeleted: true,
            excludeDrafts: !perm.isAdmin,
          };
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
      // Unlike `items-aggregate` and `kpi` above, this branch has no clamp to
      // apply: the stored string names its own tables and reaches `sql.raw`
      // verbatim, so `scope` cannot narrow it. Identity is the only control
      // available, and it is checked before the statement is looked at.
      // Reported as a panel-level `error` rather than thrown, so one tile the
      // caller may not run does not blank the whole dashboard.
      if (!allowRawSql)
        return {
          ...base,
          data: [],
          error:
            "`sql` panels run raw SQL against the whole database and are restricted to the instance operator.",
        };
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
    const message = (e as Error).message;
    // A public embed gets a fixed sentence; the authenticated path gets the
    // real one.
    //
    // A panel whose query fails at the driver had its exception copied straight
    // into the response, and drizzle wraps a driver failure as
    // `Failed query: <sql>` with the bound parameters appended. So an anonymous
    // `GET /api/public/dashboards/{token}` returned the physical table name
    // (`c_<tenantPrefix12>_<slug>`), the column list and the values of a query
    // the caller never authored — and an `AppError` such as
    // `Collection "orders" not found` confirmed which slugs the workspace has.
    if (scope) {
      console.error(`[dashboard] panel ${panel.id} failed:`, message);
      return { ...base, data: [], error: "This panel could not be rendered." };
    }
    return { ...base, data: [], error: message };
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
  // Resolved once per dashboard rather than per panel, and only when a panel
  // actually needs it — a dashboard of `items-aggregate` tiles pays nothing.
  // Every caller that reaches here hands us the request's real auth (REST and
  // GraphQL both pass `c.get("auth")`), so an API-key identity is refused by
  // `isInstanceOperator` the same way it is on the SQL console.
  const allowRawSql = panels.some((p: any) => p.kind === "sql" && p.sql)
    ? await isInstanceOperator(ctx, auth)
    : false;
  const out: PanelResult[] = [];
  for (const panel of panels)
    out.push(await runPanel(ctx, auth, tenantId, panel, null, allowRawSql));
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
  // ALWAYS a scope on the public path. `dashboard.embedRoleId ? … : null` was
  // the bug: `shareDashboard` defaults that column to null, so the ordinary
  // share turned the clamp off entirely rather than narrowing it to `public`.
  // A null `embedRoleName` means "the public role", which is what
  // `resolvePermission` resolves for a subject with no user id anyway.
  const scope = { embedRoleName };
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
