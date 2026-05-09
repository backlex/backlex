import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import { physicalTableFor } from "@workeros/db";
import type { Ctx } from "../context";

/**
 * The set of system tables we always include. Dynamic c_* tables are
 * discovered from `collections`. Auth-internal tables (sessions, accounts,
 * verifications, passkeys) are intentionally skipped — they hold short-lived
 * secrets and re-syncing them across restores is more harmful than helpful.
 */
const SYSTEM_TABLES_PG: Record<string, unknown> = {
  tenants: pg.schema.tenants,
  tenant_members: pg.schema.tenantMembers,
  users: pg.schema.users,
  roles: pg.schema.roles,
  user_roles: pg.schema.userRoles,
  permissions: pg.schema.permissions,
  api_keys: pg.schema.apiKeys,
  collections: pg.schema.collections,
  folders: pg.schema.folders,
  files: pg.schema.files,
  flows: pg.schema.flows,
  functions: pg.schema.functions,
  webhooks: pg.schema.webhooks,
  comments: pg.schema.comments,
  notifications: pg.schema.notifications,
  revisions: pg.schema.revisions,
  activity: pg.schema.activity,
  email_templates: pg.schema.emailTemplates,
  i18n_strings: pg.schema.i18nStrings,
  app_settings: pg.schema.appSettings,
  saved_panels: pg.schema.savedPanels,
  auth_config: pg.schema.authConfig,
};

const SYSTEM_TABLES_SQLITE: Record<string, unknown> = {
  tenants: sqlite.schema.tenants,
  tenant_members: sqlite.schema.tenantMembers,
  users: sqlite.schema.users,
  roles: sqlite.schema.roles,
  user_roles: sqlite.schema.userRoles,
  permissions: sqlite.schema.permissions,
  api_keys: sqlite.schema.apiKeys,
  collections: sqlite.schema.collections,
  folders: sqlite.schema.folders,
  files: sqlite.schema.files,
  flows: sqlite.schema.flows,
  functions: sqlite.schema.functions,
  webhooks: sqlite.schema.webhooks,
  comments: sqlite.schema.comments,
  notifications: sqlite.schema.notifications,
  revisions: sqlite.schema.revisions,
  activity: sqlite.schema.activity,
  email_templates: sqlite.schema.emailTemplates,
  i18n_strings: sqlite.schema.i18nStrings,
  app_settings: sqlite.schema.appSettings,
  saved_panels: sqlite.schema.savedPanels,
  auth_config: sqlite.schema.authConfig,
};

const queryRows = async <T>(
  ctx: Ctx,
  raw: ReturnType<typeof sql.raw>,
): Promise<T[]> => {
  if (ctx.dialect === "pg") {
    const r = (await (ctx.db as any).execute(raw)) as unknown;
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) return (r as { rows: T[] }).rows;
    return r as T[];
  }
  return (await (ctx.db as any).all(raw)) as T[];
};

export interface BackupResult {
  storageKey: string;
  size: number;
  tableCount: number;
  rowCount: number;
}

/**
 * Dump all tenant-relevant tables into a JSONL document and write it to the
 * configured storage adapter. Returns the persisted key + sizes so the
 * caller can update the backup tracking row.
 *
 * Format: each line is `{ "table": "<name>", "row": { … } }` so a future
 * restorer can stream-process huge backups without parsing the whole file.
 */
export const runBackup = async (
  ctx: Ctx,
  options: { tenantId: string | null; storageKey: string },
): Promise<BackupResult> => {
  const sysTables =
    ctx.dialect === "pg" ? SYSTEM_TABLES_PG : SYSTEM_TABLES_SQLITE;

  const collectionsTable =
    ctx.dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;
  const allCollections = (await (ctx.db as any).select().from(collectionsTable)) as Array<{
    slug: string;
    tenantId?: string | null;
    tenant_id?: string | null;
  }>;
  const includedCollections = allCollections.filter(
    (c) =>
      !options.tenantId ||
      !(c.tenantId ?? c.tenant_id) ||
      (c.tenantId ?? c.tenant_id) === options.tenantId,
  );

  const lines: string[] = [];
  let rowCount = 0;
  let tableCount = 0;

  // System tables. For each table, scope by tenant_id when the column exists
  // (keeps backups workspace-local). We just SELECT *; the resulting raw rows
  // already use the on-disk column names.
  for (const [name, table] of Object.entries(sysTables)) {
    let rows: Record<string, unknown>[];
    try {
      // Try filtered first — works when tenant_id column exists.
      if (options.tenantId) {
        rows = await queryRows(
          ctx,
          sql.raw(
            `SELECT * FROM "${name}" WHERE tenant_id = '${options.tenantId.replace(/'/g, "''")}' OR tenant_id IS NULL`,
          ),
        );
      } else {
        rows = await queryRows(ctx, sql.raw(`SELECT * FROM "${name}"`));
      }
    } catch {
      try {
        rows = await queryRows(ctx, sql.raw(`SELECT * FROM "${name}"`));
      } catch {
        rows = [];
      }
    }
    if (rows.length === 0) continue;
    tableCount += 1;
    rowCount += rows.length;
    for (const row of rows) {
      lines.push(JSON.stringify({ table: name, row }));
    }
  }

  // Dynamic c_* tables.
  for (const c of includedCollections) {
    const table = physicalTableFor(c.slug);
    let rows: Record<string, unknown>[];
    try {
      if (options.tenantId) {
        rows = await queryRows(
          ctx,
          sql.raw(
            `SELECT * FROM "${table}" WHERE tenant_id = '${options.tenantId.replace(/'/g, "''")}'`,
          ),
        );
      } else {
        rows = await queryRows(ctx, sql.raw(`SELECT * FROM "${table}"`));
      }
    } catch {
      rows = [];
    }
    if (rows.length === 0) continue;
    tableCount += 1;
    rowCount += rows.length;
    for (const row of rows) {
      lines.push(JSON.stringify({ table, row }));
    }
  }

  const body = lines.join("\n");
  const buf = new TextEncoder().encode(body);
  await ctx.storage.put({
    key: options.storageKey,
    body: buf,
    contentType: "application/x-ndjson",
    metadata: { rows: String(rowCount), tables: String(tableCount) },
  });

  return {
    storageKey: options.storageKey,
    size: buf.byteLength,
    tableCount,
    rowCount,
  };
};

/**
 * Convenience wrapper for the route layer: insert/update the backup row in
 * a single transaction-friendly flow. Status moves queued → running → done
 * (or failed). Errors are caught + persisted so the UI can render them.
 */
export const recordAndRunBackup = async (
  ctx: Ctx,
  args: { id: string; tenantId: string | null; storageKey: string; userId: string | null; label: string | null },
): Promise<void> => {
  const t = ctx.dialect === "pg" ? pg.schema.backups : sqlite.schema.backups;
  await (ctx.db as any)
    .update(t)
    .set({ status: "running" })
    .where(eq(t.id, args.id));
  try {
    const r = await runBackup(ctx, {
      tenantId: args.tenantId,
      storageKey: args.storageKey,
    });
    await (ctx.db as any)
      .update(t)
      .set({
        status: "done",
        size: r.size,
        tableCount: r.tableCount,
        completedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(eq(t.id, args.id));
  } catch (e) {
    await (ctx.db as any)
      .update(t)
      .set({
        status: "failed",
        error: (e as Error).message.slice(0, 500),
        completedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(eq(t.id, args.id));
  }
};
