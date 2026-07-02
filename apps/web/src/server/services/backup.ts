import { sql } from "drizzle-orm";
import { and, desc, eq, isNull } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { applyCollection, type FieldDef } from "@backlex/db";
import type { Ctx } from "../context";
import { publishEvent } from "./events";
import { recordActivity } from "./activity";

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
  email_config: pg.schema.emailConfig,
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
  email_config: sqlite.schema.emailConfig,
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
    physicalTable?: string;
    physical_table?: string;
  }>;
  const includedCollections = allCollections
    .filter(
      (c) =>
        !options.tenantId ||
        !(c.tenantId ?? c.tenant_id) ||
        (c.tenantId ?? c.tenant_id) === options.tenantId,
    )
    .map((c) => ({
      slug: c.slug,
      physicalTable: (c.physicalTable ?? c.physical_table) as string,
    }));

  const lines: string[] = [];
  let rowCount = 0;
  let tableCount = 0;

  // System tables. For each table, scope by tenant_id when the column exists
  // (keeps backups workspace-local). We just SELECT *; the resulting raw rows
  // already use the on-disk column names.
  for (const [name, _table] of Object.entries(sysTables)) {
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
    const table = c.physicalTable;
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
): Promise<{ ok: boolean; error?: string }> => {
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
    return { ok: true };
  } catch (e) {
    const error = (e as Error).message.slice(0, 500);
    await (ctx.db as any)
      .update(t)
      .set({
        status: "failed",
        error,
        completedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(eq(t.id, args.id));
    // A failed backup — especially an unattended scheduled one — must not pass
    // silently. Record an audit row AND (for tenant-scoped backups) push the
    // failure onto the `system` event channel so an operator-configured webhook
    // / flow can alert on it. Both are best-effort: this runs inside a catch
    // that already persisted `status:"failed"`, and the caller has no try/catch,
    // so a throw here would turn a gracefully-failed backup into a 500.
    try {
      await recordActivity(ctx, {
        userId: args.userId,
        tenantId: args.tenantId,
        action: "backup.failed",
        collection: "backups",
        itemId: args.id,
        payload: { label: args.label, storageKey: args.storageKey, error },
      });
      // Only tenant-scoped backups publish. A null-tenant (global) backup would
      // fan out UNSCOPED in dispatchWebhooks — to EVERY tenant's `system:*`
      // webhook — leaking another context's failure across tenants. The failed
      // row + activity audit remain the record for those.
      if (args.tenantId) {
        await publishEvent(
          ctx.env,
          "system",
          {
            event: "backup.failed",
            data: {
              backupId: args.id,
              tenantId: args.tenantId,
              label: args.label,
              storageKey: args.storageKey,
              error,
            },
          },
          { db: ctx.db, dialect: ctx.dialect, fullCtx: ctx, tenantId: args.tenantId },
        );
      }
    } catch {
      /* notification is best-effort — the failed status + error are persisted */
    }
    return { ok: false, error };
  }
};

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Order system tables so parents land before children — the only FK that
 * actually bites on Postgres is `collections.tenant_id → tenants.id` and
 * `user_roles → users/roles`, but a fixed topological-ish order keeps every
 * dialect happy. Tables not listed here (the dynamic `c_*` collection tables)
 * are restored last, after their metadata row + physical table exist.
 */
const RESTORE_ORDER = [
  "tenants",
  "users",
  "tenant_members",
  "roles",
  "user_roles",
  "permissions",
  "api_keys",
  "collections",
  "folders",
  "files",
  "flows",
  "functions",
  "webhooks",
  "comments",
  "notifications",
  "revisions",
  "activity",
  "email_templates",
  "i18n_strings",
  "app_settings",
  "saved_panels",
  "auth_config",
  "email_config",
];

const asBool = (v: unknown): boolean =>
  v === true || v === 1 || v === "1" || v === "true";

/** JSON-encode array/object values; pass primitives through. SQLite stores
 *  JSON columns as TEXT and Postgres binds a stringified value into `jsonb`
 *  via the implicit assignment cast, so the same encoding works for both. */
const bindValue = (v: unknown): unknown => {
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
};

export interface RestoreResult {
  /** Tables we wrote at least one row into. */
  tableCount: number;
  /** Rows processed (attempted). Existing rows are left untouched — restore is
   *  additive (`ON CONFLICT DO NOTHING`), never destructive. */
  rowCount: number;
  /** Tables present in the dump that don't exist here and couldn't be created
   *  (e.g. adopted tables missing from this database). */
  skipped: number;
}

/**
 * Restore a JSONL dump produced by {@link runBackup}. Streams the file from
 * storage, recreates any missing managed `c_*` physical tables from the
 * `collections` metadata in the dump, then re-inserts every row.
 *
 * Semantics are **additive**: rows are inserted with `ON CONFLICT DO NOTHING`,
 * so missing/deleted rows come back while rows that already exist are left
 * exactly as they are. This makes restore safe to run against a live database
 * (it can only add data, never overwrite or delete it). A clean point-in-time
 * rollback is a separate, destructive operation outside this path.
 */
export const restoreBackup = async (
  ctx: Ctx,
  options: { storageKey: string; tenantId: string | null },
): Promise<RestoreResult> => {
  const file = await ctx.storage.get(options.storageKey);
  if (!file) throw new Error("Backup file missing on storage");
  const text = await new Response(file.body).text();

  // Bucket the dump by table so we can order inserts (parents first) and run
  // the `collections` metadata before the dynamic tables it describes.
  const buckets = new Map<string, Record<string, unknown>[]>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: { table?: string; row?: Record<string, unknown> };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed.table || !parsed.row || typeof parsed.row !== "object") continue;
    const arr = buckets.get(parsed.table) ?? [];
    arr.push(parsed.row);
    buckets.set(parsed.table, arr);
  }

  let skipped = 0;

  // Recreate managed physical tables from the dumped collection metadata so the
  // `c_*` row inserts below have somewhere to land. `applyCollection` is
  // additive + idempotent and no-ops on adopted tables.
  for (const row of buckets.get("collections") ?? []) {
    const cTenant = (row.tenant_id ?? row.tenantId) as string | null | undefined;
    if (options.tenantId && cTenant && cTenant !== options.tenantId) continue;
    const table = (row.physical_table ?? row.physicalTable) as string | undefined;
    if (!table) continue;
    let fields = row.fields;
    if (typeof fields === "string") {
      try {
        fields = JSON.parse(fields);
      } catch {
        fields = [];
      }
    }
    try {
      await applyCollection(ctx.db as any, ctx.dialect, {
        table,
        fields: (Array.isArray(fields) ? fields : []) as FieldDef[],
        ownerScoped: asBool(row.owner_scoped ?? row.ownerScoped),
        tenantScoped:
          (row.tenant_scoped ?? row.tenantScoped) === undefined
            ? true
            : asBool(row.tenant_scoped ?? row.tenantScoped),
        versioned: asBool(row.versioned),
        softDelete: asBool(row.soft_delete ?? row.softDelete),
        hasCreatedAt:
          (row.has_created_at ?? row.hasCreatedAt) === undefined
            ? true
            : asBool(row.has_created_at ?? row.hasCreatedAt),
        hasUpdatedAt:
          (row.has_updated_at ?? row.hasUpdatedAt) === undefined
            ? true
            : asBool(row.has_updated_at ?? row.hasUpdatedAt),
        fts: asBool(row.fts),
        adopted: asBool(row.adopted),
      });
    } catch {
      // Best-effort — a table we can't recreate just means its rows get skipped.
    }
  }

  const insertRow = async (
    table: string,
    row: Record<string, unknown>,
  ): Promise<void> => {
    const cols = Object.keys(row);
    if (cols.length === 0) return;
    const colSql = sql.join(
      cols.map((c) => sql.identifier(c)),
      sql`, `,
    );
    const valSql = sql.join(
      cols.map((c) => sql`${bindValue(row[c])}`),
      sql`, `,
    );
    const stmt = sql`INSERT INTO ${sql.identifier(table)} (${colSql}) VALUES (${valSql}) ON CONFLICT DO NOTHING`;
    if (ctx.dialect === "pg") await (ctx.db as any).execute(stmt);
    else await (ctx.db as any).run(stmt);
  };

  // Restore order: known system tables first (parents → children), then every
  // remaining bucket (the dynamic `c_*` collection tables).
  const ordered = [
    ...RESTORE_ORDER.filter((n) => buckets.has(n)),
    ...[...buckets.keys()].filter((n) => !RESTORE_ORDER.includes(n)),
  ];

  let tableCount = 0;
  let rowCount = 0;
  for (const table of ordered) {
    const rows = buckets.get(table) ?? [];
    if (rows.length === 0) continue;
    let wrote = false;
    let tableFailed = false;
    for (const row of rows) {
      try {
        await insertRow(table, row);
        rowCount += 1;
        wrote = true;
      } catch {
        // First failure on a table usually means the table doesn't exist here
        // (adopted + missing). Stop hammering it and mark the table skipped.
        tableFailed = true;
        break;
      }
    }
    if (wrote) tableCount += 1;
    if (tableFailed) skipped += 1;
  }

  return { tableCount, rowCount, skipped };
};

// ---------------------------------------------------------------------------
// Scheduled backups + retention
// ---------------------------------------------------------------------------

export interface BackupConfig {
  /** How often an automatic backup runs. `off` disables scheduling. */
  schedule: "off" | "daily" | "weekly";
  /** Keep this many newest `auto` backups; older ones (and their storage
   *  objects) are pruned after each scheduled run. Manual backups are never
   *  pruned. */
  retain: number;
}

export const BACKUP_CONFIG_DEFAULT: BackupConfig = { schedule: "off", retain: 7 };
const BACKUP_CONFIG_KEY = "backupConfig";

const settingsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;

const normalizeConfig = (value: unknown): BackupConfig => {
  const v = (value ?? {}) as Partial<BackupConfig>;
  const schedule =
    v.schedule === "daily" || v.schedule === "weekly" ? v.schedule : "off";
  const retain =
    typeof v.retain === "number" && v.retain >= 1 && v.retain <= 365
      ? Math.floor(v.retain)
      : BACKUP_CONFIG_DEFAULT.retain;
  return { schedule, retain };
};

/** Read the per-workspace backup schedule from `app_settings`. */
export const loadBackupConfig = async (
  ctx: Ctx,
  tenantId: string | null,
): Promise<BackupConfig> => {
  const t = settingsTable(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(
        and(
          tenantId ? eq(t.tenantId, tenantId) : isNull(t.tenantId),
          eq(t.key, BACKUP_CONFIG_KEY),
        ),
      )
      .limit(1)) as { value: unknown }[];
    if (rows[0]) return normalizeConfig(rows[0].value);
  } catch {
    // Pre-migration / transient — fall back to the disabled default.
  }
  return { ...BACKUP_CONFIG_DEFAULT };
};

/** Upsert the per-workspace backup schedule into `app_settings`. */
export const saveBackupConfig = async (
  ctx: Ctx,
  tenantId: string | null,
  input: Partial<BackupConfig>,
): Promise<BackupConfig> => {
  const cfg = normalizeConfig({ ...(await loadBackupConfig(ctx, tenantId)), ...input });
  const t = settingsTable(ctx.dialect);
  const existing = (await (ctx.db as any)
    .select()
    .from(t)
    .where(
      and(
        tenantId ? eq(t.tenantId, tenantId) : isNull(t.tenantId),
        eq(t.key, BACKUP_CONFIG_KEY),
      ),
    )
    .limit(1)) as { id: string }[];
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  if (existing[0]) {
    await (ctx.db as any)
      .update(t)
      .set({ value: cfg, updatedAt: now })
      .where(eq(t.id, existing[0].id));
  } else {
    await (ctx.db as any).insert(t).values({
      id: crypto.randomUUID(),
      tenantId: tenantId ?? null,
      key: BACKUP_CONFIG_KEY,
      value: cfg,
      updatedAt: now,
    });
  }
  return cfg;
};

const toMs = (v: unknown): number => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
};

const SCHEDULE_INTERVAL_MS: Record<Exclude<BackupConfig["schedule"], "off">, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Run any automatic backups that are due and prune old ones to the retention
 * count. Enumerates every workspace with a non-`off` schedule (from
 * `app_settings`), checks the most recent `auto` backup's age against the
 * schedule interval, and runs + prunes per workspace. Designed to be called
 * from the cron tick — cheap when nothing is due (a couple of indexed reads).
 */
export const maybeRunScheduledBackups = async (
  ctx: Ctx,
  now: Date = new Date(),
): Promise<{ ran: number; pruned: number }> => {
  const settings = settingsTable(ctx.dialect);
  let configured: { tenantId: string | null; value: unknown }[];
  try {
    configured = (await (ctx.db as any)
      .select({ tenantId: settings.tenantId, value: settings.value })
      .from(settings)
      .where(eq(settings.key, BACKUP_CONFIG_KEY))) as {
      tenantId: string | null;
      value: unknown;
    }[];
  } catch {
    return { ran: 0, pruned: 0 };
  }

  const backupsTable =
    ctx.dialect === "pg" ? pg.schema.backups : sqlite.schema.backups;
  let ran = 0;
  let pruned = 0;

  for (const entry of configured) {
    const cfg = normalizeConfig(entry.value);
    if (cfg.schedule === "off") continue;
    const tenantId = entry.tenantId;

    const autos = (await (ctx.db as any)
      .select()
      .from(backupsTable)
      .where(
        and(
          tenantId ? eq(backupsTable.tenantId, tenantId) : isNull(backupsTable.tenantId),
          eq(backupsTable.kind, "auto"),
        ),
      )
      .orderBy(desc(backupsTable.createdAt))) as Array<{
        id: string;
        storageKey: string;
        createdAt: unknown;
      }>;

    const lastAt = autos[0] ? toMs(autos[0].createdAt) : 0;
    const due = now.getTime() - lastAt >= SCHEDULE_INTERVAL_MS[cfg.schedule];

    if (due) {
      const id = crypto.randomUUID();
      const stamp = now.toISOString().replace(/[:.TZ-]/g, "").slice(0, 14);
      const storageKey = `backups/${tenantId ?? "global"}/${stamp}_${id}.jsonl`;
      await (ctx.db as any).insert(backupsTable).values({
        id,
        tenantId: tenantId ?? null,
        kind: "auto",
        label: "Scheduled",
        storageKey,
        size: 0,
        tableCount: 0,
        status: "queued",
        createdBy: null,
      });
      await recordAndRunBackup(ctx, {
        id,
        tenantId,
        storageKey,
        userId: null,
        label: "Scheduled",
      });
      ran += 1;
      autos.unshift({ id, storageKey, createdAt: now });
    }

    // Retention: drop `auto` backups beyond the newest `retain`, storage first.
    if (autos.length > cfg.retain) {
      for (const old of autos.slice(cfg.retain)) {
        try {
          await ctx.storage.delete(old.storageKey);
        } catch {
          // Storage object already gone — drop the tracking row anyway.
        }
        await (ctx.db as any)
          .delete(backupsTable)
          .where(eq(backupsTable.id, old.id));
        pruned += 1;
      }
    }
  }

  return { ran, pruned };
};
