import { eq } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";

/** Tenant id of the instance-wide override row — applied when a workspace
 *  has no row of its own. Mirrors `email_config` / `auth_config`. */
export const GLOBAL_WORKSPACE_CONFIG_ID = "_global";

export interface WorkspaceConfigRow {
  tenantId: string;
  workspaceName: string | null;
  description: string | null;
  logoFileKey: string | null;
  faviconFileKey: string | null;
  /** Raw OKLCH string applied to `:root { --primary }` at boot. */
  primaryColor: string | null;
  /** light | dark | system | null (= leave to user). */
  defaultTheme: string | null;
  updatedAt: Date | number | null;
}

/** Resolved view: the workspace row layered onto the `_global` row layered
 *  onto an empty record. Used by the public bootstrap endpoint.
 *
 *  `logoUrl` / `faviconUrl` point at the public asset endpoint
 *  (`/api/workspace-config/asset/:kind`) and are non-null only when the
 *  active workspace's own row has the corresponding `*_file_key` set
 *  (asset files are per-tenant, so we don't fall back to `_global` for
 *  them). A short `assetsVersion` query param busts the browser cache when
 *  the row is re-saved. */
export interface ResolvedWorkspaceConfig {
  workspaceName: string | null;
  description: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  /** OKLCH / hex / rgb() / hsl() — applied verbatim as the `--primary` token. */
  primaryColor: string | null;
  defaultTheme: "light" | "dark" | "system" | null;
}

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.workspaceConfig : sqlite.schema.workspaceConfig;

const readRow = async (
  ctx: DbCtx,
  tenantId: string,
): Promise<WorkspaceConfigRow | undefined> => {
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.tenantId, tenantId))
      .limit(1)) as WorkspaceConfigRow[];
    return rows[0];
  } catch {
    return undefined;
  }
};

/**
 * Load the workspace's own row. Does NOT fall back to `_global` — callers that
 * want resolved values use {@link resolveWorkspaceConfig}. Read failures
 * (table not migrated yet) degrade to `undefined` rather than throwing.
 */
export const loadWorkspaceConfigRow = async (
  ctx: DbCtx,
  tenantId: string | null | undefined,
): Promise<WorkspaceConfigRow | undefined> =>
  readRow(ctx, tenantId && tenantId !== GLOBAL_WORKSPACE_CONFIG_ID ? tenantId : GLOBAL_WORKSPACE_CONFIG_ID);

/**
 * Accept any of: `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`, or a CSS color
 * function call (`rgb()`, `hsl()`, `oklch()`, `oklab()`) with only the
 * characters that legitimately appear inside one. Strict enough to keep
 * `</style>` etc. out of the boot-time `<style>` injection regardless of who
 * wrote the row.
 */
export const isValidColor = (v: string): boolean => {
  const s = v.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s.length === 4 || s.length === 5 || s.length === 7 || s.length === 9;
  return /^(rgb|hsl|oklch|oklab)a?\(\s*[\d\s%.,/-]+\s*\)$/i.test(s);
};

const cleanKey = (v: string | null | undefined): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

const validTheme = (v: string | null): ResolvedWorkspaceConfig["defaultTheme"] =>
  v === "light" || v === "dark" || v === "system" ? v : null;

const toVersionToken = (v: Date | number | null | undefined): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return String(v.getTime());
  return String(v);
};

/**
 * Resolve the active workspace config: the tenant's own row layered onto the
 * `_global` row. Each field independently falls through to `_global` when the
 * workspace value is null/blank, so a workspace can override only what it
 * needs.
 */
export const resolveWorkspaceConfig = async (
  ctx: DbCtx,
  tenantId: string | null | undefined,
): Promise<ResolvedWorkspaceConfig> => {
  const own =
    tenantId && tenantId !== GLOBAL_WORKSPACE_CONFIG_ID ? await readRow(ctx, tenantId) : undefined;
  const fallback =
    !own || tenantId === GLOBAL_WORKSPACE_CONFIG_ID
      ? own
      : await readRow(ctx, GLOBAL_WORKSPACE_CONFIG_ID);

  const pick = <K extends keyof WorkspaceConfigRow>(k: K): WorkspaceConfigRow[K] | null => {
    const a = own?.[k];
    if (a !== null && a !== undefined && a !== "") return a;
    const b = fallback?.[k];
    if (b !== null && b !== undefined && b !== "") return b;
    return null;
  };

  const primary = pick("primaryColor");
  // Asset URLs are built from the workspace's own row only — files live under
  // `tenants/<id>/…` and the asset endpoint serves from the active tenant's
  // bucket, so a `_global` file key wouldn't resolve here anyway.
  const ownLogo = cleanKey(own?.logoFileKey ?? null);
  const ownFavicon = cleanKey(own?.faviconFileKey ?? null);
  const version = toVersionToken(own?.updatedAt ?? null);
  const assetUrl = (kind: "logo" | "favicon"): string =>
    `/api/workspace-config/asset/${kind}${version ? `?v=${encodeURIComponent(version)}` : ""}`;
  return {
    workspaceName: (pick("workspaceName") as string | null) ?? null,
    description: (pick("description") as string | null) ?? null,
    logoUrl: ownLogo ? assetUrl("logo") : null,
    faviconUrl: ownFavicon ? assetUrl("favicon") : null,
    primaryColor:
      typeof primary === "string" && isValidColor(primary) ? primary : null,
    defaultTheme: validTheme(pick("defaultTheme") as string | null),
  };
};
