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
 *  `logoFileKey` / `faviconFileKey` are the **logical** keys stored in
 *  `files.key` (minus the `tenants/<id>/` physical prefix). Wiring the public
 *  asset serving endpoint is deferred to PR-2 — until then the client either
 *  ignores them or builds an authenticated `/api/storage/<key>` URL itself. */
export interface ResolvedWorkspaceConfig {
  workspaceName: string | null;
  description: string | null;
  logoFileKey: string | null;
  faviconFileKey: string | null;
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

export const isOklch = (v: string): boolean => /^\s*oklch\s*\(/i.test(v.trim());

const cleanKey = (v: string | null | undefined): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

const validTheme = (v: string | null): ResolvedWorkspaceConfig["defaultTheme"] =>
  v === "light" || v === "dark" || v === "system" ? v : null;

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
  return {
    workspaceName: (pick("workspaceName") as string | null) ?? null,
    description: (pick("description") as string | null) ?? null,
    logoFileKey: cleanKey(pick("logoFileKey") as string | null),
    faviconFileKey: cleanKey(pick("faviconFileKey") as string | null),
    primaryColor:
      typeof primary === "string" && isOklch(primary) ? primary : null,
    defaultTheme: validTheme(pick("defaultTheme") as string | null),
  };
};
