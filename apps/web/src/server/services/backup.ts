import { sql } from "drizzle-orm";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { applyCollection, backfillFoldColumns, tableExists, type FieldDef } from "@backlex/db";
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
  // Absent since the table shipped, so an operator's push templates were
  // silently outside every backup while their email ones were inside.
  push_templates: pg.schema.pushTemplates,
  i18n_strings: pg.schema.i18nStrings,
  app_settings: pg.schema.appSettings,
  saved_panels: pg.schema.savedPanels,
  auth_config: pg.schema.authConfig,
  email_config: pg.schema.emailConfig,
  // Sequence counters. Restoring the invoices WITHOUT the counter that numbered
  // them would reset the series to its start, so the very next create reissues
  // a number already on a document — a UNIQUE violation at best and a duplicate
  // at worst. The counter is part of the data, not derived from it.
  sequences: pg.schema.sequences,
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
  push_templates: sqlite.schema.pushTemplates,
  i18n_strings: sqlite.schema.i18nStrings,
  app_settings: sqlite.schema.appSettings,
  saved_panels: sqlite.schema.savedPanels,
  auth_config: sqlite.schema.authConfig,
  email_config: sqlite.schema.emailConfig,
  sequences: sqlite.schema.sequences,
};

/** Single-quote a value for inlining into a `sql.raw` predicate. */
const lit = (v: string): string => `'${v.replace(/'/g, "''")}'`;

/** Double-quote an identifier for inlining into a `sql.raw` statement. */
const ident = (v: string): string => `"${v.replace(/"/g, '""')}"`;

/**
 * How each system table is narrowed to a single workspace.
 *
 * Four of these tables carry no `tenant_id` column of their own, so they are
 * scoped through the relation that does: `users` via `tenant_members`,
 * `user_roles` / `permissions` via `roles.tenant_id`, and `tenants` by its own
 * primary key. Everything else filters on `tenant_id` directly (keeping the
 * `IS NULL` arm so globally-seeded rows — default email templates, global
 * settings — still land in every workspace's backup).
 *
 * This is a static table rather than "try the filtered query, fall back on
 * error" on purpose. The exception-driven form it replaces produced a FULL
 * cross-tenant dump for exactly those four tables — every workspace's user
 * directory, role assignments and permission rules ended up inside a single
 * tenant's downloadable backup — and degraded the same way for any correctly
 * scoped table that happened to hit a transient DB error.
 */
const TENANT_WHERE: Record<string, (tid: string) => string> = {
  tenants: (tid) => `id = ${lit(tid)}`,
  users: (tid) =>
    `id IN (SELECT user_id FROM tenant_members WHERE tenant_id = ${lit(tid)} AND user_id IS NOT NULL)`,
  user_roles: (tid) =>
    `role_id IN (SELECT id FROM roles WHERE tenant_id = ${lit(tid)} OR tenant_id IS NULL)`,
  permissions: (tid) =>
    `role_id IN (SELECT id FROM roles WHERE tenant_id = ${lit(tid)} OR tenant_id IS NULL)`,
  // `sequences.tenant_id` is NOT NULL with `''` for "no tenant" (a nullable key
  // column would break the allocator's ON CONFLICT), so the default
  // `OR tenant_id IS NULL` arm would match nothing on a tenant-less install.
  sequences: (tid) => `tenant_id = ${lit(tid)} OR tenant_id = ''`,
};

/** Default scoping for tables that own a `tenant_id` column. */
const tenantColumnWhere = (tid: string): string =>
  `tenant_id = ${lit(tid)} OR tenant_id IS NULL`;

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
  /**
   * Tables named in `collections` (or in the system set) that do not exist in
   * this database, so contributed no rows. Absent is a legitimate state — a
   * partial migration, an adopted table dropped outside backlex — and it is
   * reported rather than inferred from a swallowed error.
   */
  missingTables: string[];
}

/**
 * How many rows a single dump may carry before it refuses.
 *
 * The dump is assembled in memory, so on a 128 MB Worker isolate a large enough
 * workspace does not produce a bad backup — it produces an OOM that never
 * reaches `recordAndRunBackup`'s catch, leaving the tracking row at `running`
 * forever. A budget converts that into a `failed` row with a message an
 * operator can act on. Raise it wherever the runtime has the memory.
 */
const DEFAULT_BACKUP_MAX_ROWS = 500_000;

const backupMaxRows = (ctx: Ctx): number => {
  const raw = Number(ctx.env.BACKUP_MAX_ROWS ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_BACKUP_MAX_ROWS;
};

/**
 * Dump all tenant-relevant tables into a JSONL document and write it to the
 * configured storage adapter. Returns the persisted key + sizes so the
 * caller can update the backup tracking row.
 *
 * Format: each line is `{ "table": "<name>", "row": { … } }`, chosen so a
 * restorer *could* process the file line by line. Note that neither this
 * function nor {@link restoreBackup} streams today: both hold the whole
 * document in memory, which is what `BACKUP_MAX_ROWS` bounds.
 *
 * A table that is missing is recorded in `missingTables`; a table that EXISTS
 * and fails to read throws, so the caller marks the backup `failed`. Those two
 * used to be the same swallowed `catch`, which meant an unreadable table
 * silently vanished from a dump that still reported success — the worst
 * possible failure for the one artifact recovery depends on.
 */
export const runBackup = async (
  ctx: Ctx,
  options: {
    tenantId: string | null;
    storageKey: string;
    /** Called once per table, never once per row — a dump of a hundred tables
     *  should cost a hundred progress writes, not a million. Optional because
     *  the inline request path has nowhere to put the answer; the queued path
     *  passes the job's reporter. Awaited so a slow sink cannot get ahead of
     *  the walk and report a table that has not been read. */
    onProgress?: (p: { done: number; total: number; note: string }) => Promise<void>;
  },
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
    tenantScoped?: boolean | number | null;
    tenant_scoped?: boolean | number | null;
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
      // Whether the physical table actually has a `tenant_id` column to filter
      // on. Legacy rows predate the flag; those default to scoped, matching
      // `applyCollection`'s own default.
      tenantScoped:
        (c.tenantScoped ?? c.tenant_scoped) === undefined
          ? true
          : asBool(c.tenantScoped ?? c.tenant_scoped),
    }));

  // Encode each line as it is produced instead of collecting strings and
  // joining at the end. The joined document was the largest of the three copies
  // we held — a JS string is UTF-16, so it costs ~2 bytes per byte of output —
  // and it exists only to be handed straight to the encoder.
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const writeLine = (table: string, row: Record<string, unknown>): void => {
    const chunk = encoder.encode(
      `${chunks.length === 0 ? "" : "\n"}${JSON.stringify({ table, row })}`,
    );
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  };

  const maxRows = backupMaxRows(ctx);
  const missingTables: string[] = [];
  let rowCount = 0;
  let tableCount = 0;

  /**
   * Read one table, distinguishing "not here" from "could not be read".
   *
   * These were the same swallowed `catch`, which made a transient or permission
   * failure indistinguishable from an absent table — the dump quietly lost the
   * rows and still reported `done`. `tableExists` answers the tolerable case up
   * front so everything else can propagate.
   */
  const readTable = async (
    name: string,
    where: string | null,
  ): Promise<Record<string, unknown>[] | null> => {
    if (!(await tableExists(ctx.db as any, ctx.dialect, name))) {
      missingTables.push(name);
      return null;
    }
    // Deliberately NOT retried unfiltered — an unscoped dump is worse than a
    // short one, and worse than a failed one.
    return queryRows<Record<string, unknown>>(
      ctx,
      sql.raw(`SELECT * FROM ${ident(name)}${where ? ` WHERE ${where}` : ""}`),
    );
  };

  const account = (name: string, rows: Record<string, unknown>[]): void => {
    tableCount += 1;
    rowCount += rows.length;
    if (rowCount > maxRows) {
      throw new Error(
        `Backup exceeds BACKUP_MAX_ROWS (${maxRows}) at table "${name}". The dump is assembled in memory; raise the limit only where the runtime has the headroom.`,
      );
    }
    for (const row of rows) writeLine(name, row);
  };

  // System tables. Each one is scoped to the workspace through `TENANT_WHERE`
  // (see that map for why the predicate is chosen statically rather than
  // discovered by catching a SQL error). We just SELECT *; the resulting raw
  // rows already use the on-disk column names.
  const systemTableNames = Object.keys(sysTables);
  // The denominator is known before the walk starts: every system table plus
  // every collection this workspace owns. Reported as tables-walked rather than
  // rows-written because a table that turns out to be empty is still progress,
  // and rows are not knowable without counting them first.
  const totalTables = systemTableNames.length + includedCollections.length;
  let walked = 0;
  const step = async (note: string): Promise<void> => {
    walked += 1;
    await options.onProgress?.({ done: walked, total: totalTables, note });
  };

  for (const name of systemTableNames) {
    const where = options.tenantId
      ? (TENANT_WHERE[name] ?? tenantColumnWhere)(options.tenantId)
      : null;
    const rows = await readTable(name, where);
    await step(name);
    if (rows === null || rows.length === 0) continue;
    account(name, rows);
  }

  // Dynamic c_* tables. Only tenant-scoped collections own a `tenant_id`
  // column to filter on; an unscoped collection is global by definition, so it
  // is dumped whole. Reading the flag beats probing with a query that throws —
  // that used to silently drop every unscoped collection from the backup.
  for (const c of includedCollections) {
    const table = c.physicalTable;
    const scope =
      options.tenantId && c.tenantScoped
        ? `tenant_id = ${lit(options.tenantId)}`
        : null;
    const rows = await readTable(table, scope);
    await step(c.slug);
    if (rows === null || rows.length === 0) continue;
    account(table, rows);
  }

  const buf = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  await ctx.storage.put({
    key: options.storageKey,
    body: buf,
    contentType: "application/x-ndjson",
    metadata: {
      rows: String(rowCount),
      tables: String(tableCount),
      ...(missingTables.length > 0 ? { missing: missingTables.join(",") } : {}),
    },
  });

  return {
    storageKey: options.storageKey,
    size: buf.byteLength,
    tableCount,
    rowCount,
    missingTables,
  };
};

/**
 * Convenience wrapper for the route layer: insert/update the backup row in
 * a single transaction-friendly flow. Status moves queued → running → done
 * (or failed). Errors are caught + persisted so the UI can render them.
 */
export const recordAndRunBackup = async (
  ctx: Ctx,
  args: {
    id: string;
    tenantId: string | null;
    storageKey: string;
    userId: string | null;
    label: string | null;
    onProgress?: (p: { done: number; total: number; note: string }) => Promise<void>;
  },
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
      onProgress: args.onProgress,
    });
    await (ctx.db as any)
      .update(t)
      .set({
        status: "done",
        size: r.size,
        tableCount: r.tableCount,
        // Persisted rather than only returned: the operator who needs to know a
        // table was absent is almost never the one who triggered the run (these
        // are mostly scheduled), so it has to survive on the row.
        missingTables: r.missingTables.length > 0 ? r.missingTables.join(",") : null,
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
  "sequences",
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

/**
 * How an existing row is treated.
 *
 * - `additive` (default) — `ON CONFLICT DO NOTHING`. Missing rows come back;
 *   rows that still exist are left exactly as they are. Safe against a live
 *   database: it can only add data.
 * - `overwrite` — `ON CONFLICT (id) DO UPDATE`. Rows that still exist are
 *   restated to their backup-era values. This is the only path that can undo an
 *   edit (a bad bulk update, a dropped column's data), and the only one that can
 *   destroy current data — every surface gates it behind an explicit confirm.
 */
export type RestoreMode = "additive" | "overwrite";

export interface RestoreResult {
  /** Tables we wrote at least one row into. */
  tableCount: number;
  /** Rows processed (attempted). In `additive` mode existing rows are left
   *  untouched; in `overwrite` mode they are restated. */
  rowCount: number;
  /** Tables present in the dump that don't exist here and couldn't be created
   *  (e.g. adopted tables missing from this database). */
  skipped: number;
  /** Rows written through the overwrite path — restated if they still exist,
   *  re-inserted if they were deleted. Always 0 in `additive` mode. */
  overwritten: number;
  /**
   * Tables that stayed additive even though `overwrite` was asked for, because
   * they have no single-column `id` to name as the conflict target — `DO NOTHING`
   * needs no target, `DO UPDATE` does. `user_roles` is the standing example: it
   * is keyed `(user_id, role_id)` and carries no `id` column at all.
   *
   * Reported rather than silently downgraded: a caller who asked for overwrite
   * and got additive for some of the dump must be able to see which part.
   */
  keptAdditive: string[];
}

/**
 * Restore a JSONL dump produced by {@link runBackup}. Reads the file from
 * storage, recreates any missing managed `c_*` physical tables from the
 * `collections` metadata in the dump, then re-inserts every row.
 *
 * `mode` decides what happens to a row that still exists — see {@link RestoreMode}.
 * The default is `additive`, which is the historical behaviour.
 *
 * `onlyTables` narrows the restore to a named set. The pre-drop recovery path
 * always passes it: rolling a single collection's table back must not also drag
 * `app_settings`, `auth_config` and `api_keys` back to backup time.
 */
export const restoreBackup = async (
  ctx: Ctx,
  options: {
    storageKey: string;
    tenantId: string | null;
    mode?: RestoreMode;
    onlyTables?: string[];
  },
): Promise<RestoreResult> => {
  const mode: RestoreMode = options.mode === "overwrite" ? "overwrite" : "additive";
  const only = options.onlyTables?.length ? new Set(options.onlyTables) : null;
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
  const restoredTables: { table: string; fields: FieldDef[] }[] = [];
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
      // Remembered for the fold backfill AFTER the rows land. `applyCollection`
      // runs its own backfill, but it runs here — against a table that is still
      // empty, because the restore has not inserted anything yet.
      if (!asBool(row.adopted)) {
        restoredTables.push({
          table,
          fields: (Array.isArray(fields) ? fields : []) as FieldDef[],
        });
      }
    } catch {
      // Best-effort — a table we can't recreate just means its rows get skipped.
    }
  }

  /**
   * Whether this table's rows can name a conflict target.
   *
   * Read off the dumped row rather than a hand-kept registry of primary keys:
   * every system table in `SYSTEM_TABLES_*` except `user_roles` is keyed on a
   * plain `id`, managed `c_*` tables always are, and a table whose dump carries
   * no `id` is exactly the one that cannot be overwritten. One source of truth,
   * and it stays right if a table is added to the dump later.
   *
   * `users` is excluded by name, and it is the one case that is not about keys.
   * A `users` row is a GLOBAL identity — the same person can be a member of
   * several workspaces — and `rowBelongs` lets it through precisely because the
   * dump was already narrowed to this workspace's members. Additive, that is
   * harmless: an existing identity is skipped. Overwriting one would let a
   * workspace admin restate a shared person's profile to backup-era values,
   * which every other workspace they belong to would then see. Their own
   * membership, roles and permissions stay overwritable — those are scoped.
   */
  const NEVER_OVERWRITE = new Set(["users"]);
  const canOverwrite = (
    table: string,
    row: Record<string, unknown> | undefined,
  ): boolean => !NEVER_OVERWRITE.has(table) && !!row && Object.hasOwn(row, "id");

  /**
   * Whether an individual SYSTEM-table row may be restated by this workspace.
   *
   * `tenantColumnWhere` scopes most system tables as
   * `tenant_id = <mine> OR tenant_id IS NULL`, so **every workspace's dump
   * deliberately carries the instance-global rows** — the default email
   * templates, global `app_settings`, instance-wide `api_keys`. Additively that
   * is harmless: those rows still exist, so they are skipped. Under overwrite it
   * is not. The UPDATE keys on `id` alone, so a workspace admin restoring their
   * own backup would restate instance-wide configuration to its backup-era
   * values — reverting a global setting an operator had since hardened, or
   * putting back the `revoked_at`/`expires_at` of a global API key.
   *
   * Dynamic `c_*` tables are deliberately NOT covered: an unscoped collection is
   * global by an instance admin's explicit modelling choice, and the pre-drop
   * recovery path targets exactly those tables.
   */
  const systemTableNames = new Set(
    Object.keys(ctx.dialect === "pg" ? SYSTEM_TABLES_PG : SYSTEM_TABLES_SQLITE),
  );
  const rowOverwritable = (table: string, row: Record<string, unknown>): boolean => {
    // An instance-wide restore (no workspace) is the disaster-recovery path and
    // is meant to reach everything.
    if (!options.tenantId) return true;
    if (!systemTableNames.has(table)) return true;
    return (row.tenant_id ?? row.tenantId) === options.tenantId;
  };

  const exec = async (stmt: ReturnType<typeof sql>): Promise<void> => {
    if (ctx.dialect === "pg") await (ctx.db as any).execute(stmt);
    else await (ctx.db as any).run(stmt);
  };

  /**
   * Write one dumped row.
   *
   * Additive is a single `INSERT … ON CONFLICT DO NOTHING`.
   *
   * Overwrite is **UPDATE-then-INSERT**, not `ON CONFLICT (id) DO UPDATE`, and
   * the reason is the pre-drop snapshot. That dump holds only `(id, <column>)` —
   * capturing the whole row would mean a later restore also reverted columns
   * nobody asked about. An INSERT of a partial row trips the table's NOT NULL
   * constraints *before* any conflict clause is reached, so the upsert form
   * fails on exactly the artifact recovery depends on. An UPDATE names only the
   * columns present, which is what a partial snapshot means.
   *
   * The INSERT still runs after it, so a row that was DELETED (not just edited)
   * comes back. It is allowed to fail on its own: a partial snapshot genuinely
   * cannot reconstruct a missing row, and the UPDATE above has already done
   * everything that was possible.
   */
  const insertRow = async (
    table: string,
    row: Record<string, unknown>,
    overwrite: boolean,
  ): Promise<void> => {
    const cols = Object.keys(row);
    if (cols.length === 0) return;
    const tbl = sql.identifier(table);
    const setCols = cols.filter((c) => c !== "id");

    if (overwrite && setCols.length > 0) {
      await exec(
        sql`UPDATE ${tbl} SET ${sql.join(
          setCols.map((c) => sql`${sql.identifier(c)} = ${bindValue(row[c])}`),
          sql`, `,
        )} WHERE ${sql.identifier("id")} = ${bindValue(row.id)}`,
      );
    }

    const colSql = sql.join(
      cols.map((c) => sql.identifier(c)),
      sql`, `,
    );
    const valSql = sql.join(
      cols.map((c) => sql`${bindValue(row[c])}`),
      sql`, `,
    );
    const stmt = sql`INSERT INTO ${tbl} (${colSql}) VALUES (${valSql}) ON CONFLICT DO NOTHING`;
    if (overwrite) {
      // The UPDATE is the operation; this is only the "row was deleted" arm.
      try {
        await exec(stmt);
      } catch {
        /* a partial snapshot cannot rebuild a missing row — the UPDATE stands */
      }
      return;
    }
    await exec(stmt);
  };

  // Restore order: known system tables first (parents → children), then every
  // remaining bucket (the dynamic `c_*` collection tables).
  const ordered = [
    ...RESTORE_ORDER.filter((n) => buckets.has(n)),
    ...[...buckets.keys()].filter((n) => !RESTORE_ORDER.includes(n)),
  ].filter((n) => !only || only.has(n));

  // Roles that belong to the target workspace, collected as the `roles` bucket
  // is restored. `user_roles` / `permissions` carry no `tenant_id` of their own
  // — they're scoped by the role they point at — so this set is what lets us
  // reject grants belonging to some other workspace.
  const ownRoleIds = new Set<string>();
  for (const row of buckets.get("roles") ?? []) {
    const rTenant = (row.tenant_id ?? row.tenantId) as string | null | undefined;
    if (options.tenantId && rTenant && rTenant !== options.tenantId) continue;
    const id = row.id;
    if (typeof id === "string") ownRoleIds.add(id);
  }

  /**
   * Whether a dumped row may be written into the target workspace.
   *
   * Restore is documented as additive "into the active workspace", but only the
   * `collections` bucket used to be checked — every other table was inserted
   * verbatim, carrying its ORIGINAL `tenant_id`. That let a restore
   * re-materialize another workspace's rows (and, paired with the unscoped dump
   * this file used to produce, re-inject its users and permissions).
   */
  const rowBelongs = (table: string, row: Record<string, unknown>): boolean => {
    if (!options.tenantId) return true; // global restore — keep everything
    if (table === "tenants") return row.id === options.tenantId;
    if (table === "user_roles" || table === "permissions") {
      const roleId = (row.role_id ?? row.roleId) as string | undefined;
      return typeof roleId === "string" ? ownRoleIds.has(roleId) : false;
    }
    // `users` are global identities shared across workspaces; the dump is
    // already narrowed to this workspace's members, and the insert is
    // ON CONFLICT DO NOTHING, so they pass through.
    if (table === "users") return true;
    const rTenant = (row.tenant_id ?? row.tenantId) as string | null | undefined;
    // No tenant column in the row (unscoped collection, or a globally-seeded
    // system row) → nothing to disagree with.
    return !rTenant || rTenant === options.tenantId;
  };

  let tableCount = 0;
  let rowCount = 0;
  let overwritten = 0;
  const keptAdditive: string[] = [];
  for (const table of ordered) {
    const rows = (buckets.get(table) ?? []).filter((r) => {
      const ok = rowBelongs(table, r);
      if (!ok) skipped += 1;
      return ok;
    });
    if (rows.length === 0) continue;
    // Decided once per table, from the first row that survived scoping.
    let overwrite = mode === "overwrite" && canOverwrite(table, rows[0]);
    if (mode === "overwrite" && !overwrite) keptAdditive.push(table);
    let wrote = false;
    let tableFailed = false;
    for (const row of rows) {
      // Per ROW, not per table: a system table's bucket legitimately mixes this
      // workspace's rows with the instance-global ones the dump also carries.
      const rowOverwrite = overwrite && rowOverwritable(table, row);
      if (overwrite && !rowOverwrite && !keptAdditive.includes(table)) {
        keptAdditive.push(table);
      }
      try {
        await insertRow(table, row, rowOverwrite);
        rowCount += 1;
        if (rowOverwrite) overwritten += 1;
        wrote = true;
      } catch (e) {
        // An `ON CONFLICT (id)` target the table cannot satisfy — an adopted
        // table whose `id` carries no unique index — must not cost us the rows.
        // Downgrade this table to additive, report it, and retry the same row
        // rather than letting the whole table fall through to `skipped`.
        if (rowOverwrite) {
          overwrite = false;
          if (!keptAdditive.includes(table)) keptAdditive.push(table);
          try {
            await insertRow(table, row, false);
            rowCount += 1;
            wrote = true;
            continue;
          } catch {
            /* fall through to the table-level skip below */
          }
        }
        // First failure on a table usually means the table doesn't exist here
        // (adopted + missing). Stop hammering it and mark the table skipped.
        void e;
        tableFailed = true;
        break;
      }
    }
    if (wrote) tableCount += 1;
    if (tableFailed) skipped += 1;
  }

  // Fold the restored rows.
  //
  // A restore writes columns VERBATIM from the dump — that is what makes it a
  // faithful restore — so a backup taken before folded search existed carries
  // no `<name>__fold` values, and every row it brings back would be invisible
  // to `_icontains` with nothing to indicate why. The pass is a no-op for a
  // newer dump that already carries them: it only touches rows whose companion
  // is NULL while the source column is not.
  for (const { table, fields } of restoredTables) {
    try {
      await backfillFoldColumns(ctx.db as any, ctx.dialect, table, fields);
    } catch {
      // Best-effort, like the rest of restore: a table we cannot fold is a
      // table whose case-insensitive filters fall back, not a failed restore.
    }
  }

  return { tableCount, rowCount, skipped, overwritten, keptAdditive };
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
  /** Age-based retention on top of the count: `auto` backups older than this
   *  many days are pruned even when fewer than `retain` exist. `null`
   *  disables the age rule (count-only, the historical behavior). */
  retainDays: number | null;
}

export const BACKUP_CONFIG_DEFAULT: BackupConfig = {
  schedule: "off",
  retain: 7,
  retainDays: null,
};
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
  // Stored configs predating the age rule have no `retainDays` — treat as
  // disabled rather than inventing a cutoff.
  const retainDays =
    typeof v.retainDays === "number" && v.retainDays >= 1 && v.retainDays <= 3650
      ? Math.floor(v.retainDays)
      : null;
  return { schedule, retain, retainDays };
};

/** Read the per-workspace backup schedule from `app_settings`.
 *
 *  Takes the narrow `{db, dialect}` shape rather than a full `Ctx`: the advisor
 *  reads this to decide whether to warn that backups are off, and it carries its
 *  own context type. Widening the one parameter beats a second reader. */
export const loadBackupConfig = async (
  ctx: Pick<Ctx, "db" | "dialect">,
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

// ── Shared surface helpers ───────────────────────────────────────────────────
// REST (routes/db-admin.ts), GraphQL (services/graphql/backups.ts) and — via
// the REST routes — MCP + SDK all funnel through these, so tenant scoping and
// the tracking-row lifecycle live in exactly one place.

const backupsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.backups : sqlite.schema.backups;

/** Backup tracking rows for a workspace, newest first (capped at 100). */
export const listBackups = async (
  ctx: Ctx,
  tenantId: string | null,
): Promise<Record<string, unknown>[]> => {
  const t = backupsTable(ctx.dialect);
  return (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId ?? ""))
    .orderBy(desc(t.createdAt))
    .limit(100)) as Record<string, unknown>[];
};

/**
 * Insert the tracking row and run the dump synchronously (small enough for
 * admin traffic — see the REST handler's note), then return the refreshed row
 * so callers can render immediate `done`/`failed` state without polling.
 */
/**
 * Insert the tracking row, without dumping anything.
 *
 * Split out of `startManualBackup` so the queued path can answer the caller
 * with a real backup id straight away — the row appears in the workspace's
 * backup list as `queued` the moment the button is pressed, rather than only
 * once a worker picks the job up. It is also the queued run's replay guard:
 * `recordAndRunBackup` moves `queued → running`, so a second copy of the job
 * finds it already running and declines instead of dumping twice.
 */
export const createBackupRow = async (
  ctx: Ctx,
  options: { tenantId: string | null; userId: string | null; label?: string | null },
): Promise<{ id: string; storageKey: string }> => {
  const t = backupsTable(ctx.dialect);
  const id = crypto.randomUUID();
  const stamp = new Date().toISOString().replace(/[:.TZ-]/g, "").slice(0, 14);
  const storageKey = `backups/${options.tenantId ?? "global"}/${stamp}_${id}.jsonl`;
  await (ctx.db as any).insert(t).values({
    id,
    tenantId: options.tenantId,
    kind: "manual",
    label: options.label ?? null,
    storageKey,
    size: 0,
    tableCount: 0,
    status: "queued",
    createdBy: options.userId,
  });
  return { id, storageKey };
};

export const startManualBackup = async (
  ctx: Ctx,
  options: {
    tenantId: string | null;
    userId: string | null;
    label?: string | null;
    onProgress?: (p: { done: number; total: number; note: string }) => Promise<void>;
  },
): Promise<Record<string, unknown>> => {
  const t = backupsTable(ctx.dialect);
  const { id, storageKey } = await createBackupRow(ctx, options);
  await recordAndRunBackup(ctx, {
    id,
    tenantId: options.tenantId,
    storageKey,
    userId: options.userId,
    label: options.label ?? null,
    onProgress: options.onProgress,
  });
  const refreshed = await (ctx.db as any).select().from(t).where(eq(t.id, id)).limit(1);
  return (refreshed[0] ?? { id, storageKey, status: "running" }) as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Pre-drop data snapshots
// ---------------------------------------------------------------------------

/**
 * The narrowest context a pre-drop snapshot needs.
 *
 * Deliberately structural rather than the full {@link Ctx}: the two callers
 * that must capture one do not share a context type. `routes/collections.ts`
 * holds a full `Ctx`; `services/schema-versions.ts` has only `{db, dialect}`
 * plus whatever its route hands through. Widening one shared parameter beats
 * writing a second snapshot path for the schema-apply route — and a second path
 * is exactly how that route ended up without a data snapshot in the first place.
 */
export interface SnapshotCtx {
  db: unknown;
  dialect: "pg" | "sqlite";
  storage: Ctx["storage"];
}

export interface DropImpact {
  /** Rows the drop would touch, within the caller's workspace. */
  rows: number;
  /** Rows where the column being dropped actually holds a value. Only present
   *  for a field drop; this is the number that decides whether data is lost. */
  nonNull?: number;
}

/**
 * How much data a drop would destroy.
 *
 * Answered before the DDL runs, so an operator (and the confirm gate) can tell
 * "drop this empty scaffolding column" from "drop 40,000 customer phone
 * numbers". A field drop reports both counts because they answer different
 * questions: `rows` is how big the table is, `nonNull` is how much is lost.
 */
export const countDropImpact = async (
  ctx: Pick<SnapshotCtx, "db" | "dialect">,
  args: {
    table: string;
    column?: string | null;
    tenantScoped?: boolean;
    tenantId?: string | null;
  },
): Promise<DropImpact> => {
  const where =
    args.tenantScoped && args.tenantId
      ? ` WHERE tenant_id = ${lit(args.tenantId)}`
      : "";
  const select = args.column
    ? `COUNT(*) AS n, COUNT(${ident(args.column)}) AS nn`
    : `COUNT(*) AS n`;
  const rows = await queryRows<{ n: number | string; nn?: number | string }>(
    { ...(ctx as any), storage: undefined } as Ctx,
    sql.raw(`SELECT ${select} FROM ${ident(args.table)}${where}`),
  );
  const first = rows[0];
  const out: DropImpact = { rows: Number(first?.n ?? 0) };
  if (args.column) out.nonNull = Number(first?.nn ?? 0);
  return out;
};

/**
 * Capture the data a drop is about to destroy, as a restorable backup.
 *
 * Writes the SAME `{table, row}` JSONL {@link runBackup} produces, into the same
 * storage adapter, tracked by the same `backups` row — so recovery is the
 * ordinary {@link restoreBackup} with `mode: "overwrite"` and `onlyTables` set
 * to this one table. That reuse is the whole design: a bespoke "undo a drop"
 * path would be a second format, a second reader and a second thing to get
 * wrong, and the restore this leans on is already tested.
 *
 * `kind: "pre-drop"` keeps these out of the scheduled retention sweep, which
 * prunes only `kind = "auto"`. That is deliberate — an artifact created because
 * someone destroyed something should not expire on the backup schedule's clock —
 * but it does mean they accumulate; `docs/backup-restore.md` says so.
 *
 * Best-effort by contract: a storage adapter that refuses must not block the
 * drop the operator explicitly confirmed. Returns `null` when nothing was
 * captured, and the caller reports that rather than implying a safety net.
 */
export const snapshotBeforeDrop = async (
  ctx: SnapshotCtx,
  args: {
    tenantId: string | null;
    userId: string | null;
    table: string;
    /** Columns to capture. Omit for a whole-collection drop (`SELECT *`); for a
     *  field drop pass `["id", "<column>"]` so the restore can put back just
     *  that column without restating the rest of the row. */
    columns?: string[];
    /** Narrow the capture to rows where this column holds a value. Set for a
     *  field drop, so the snapshot is exactly the `nonNull` count the operator
     *  was shown — a row that was already empty needs no saving, because
     *  re-adding the column makes it empty again. */
    nonNullColumn?: string;
    label: string;
    tenantScoped?: boolean;
  },
): Promise<{ id: string; storageKey: string; rowCount: number } | null> => {
  const t = backupsTable(ctx.dialect);
  const id = crypto.randomUUID();
  const stamp = new Date().toISOString().replace(/[:.TZ-]/g, "").slice(0, 14);
  const storageKey = `backups/${args.tenantId ?? "global"}/predrop_${stamp}_${id}.jsonl`;

  try {
    const projection =
      args.columns && args.columns.length > 0
        ? args.columns.map((c) => ident(c)).join(", ")
        : "*";
    const predicates = [
      args.tenantScoped && args.tenantId ? `tenant_id = ${lit(args.tenantId)}` : null,
      args.nonNullColumn ? `${ident(args.nonNullColumn)} IS NOT NULL` : null,
    ].filter(Boolean);
    const where = predicates.length > 0 ? ` WHERE ${predicates.join(" AND ")}` : "";
    const rows = await queryRows<Record<string, unknown>>(
      ctx as unknown as Ctx,
      sql.raw(`SELECT ${projection} FROM ${ident(args.table)}${where}`),
    );
    if (rows.length === 0) return null;

    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    for (const row of rows) {
      const chunk = encoder.encode(
        `${chunks.length === 0 ? "" : "\n"}${JSON.stringify({ table: args.table, row })}`,
      );
      chunks.push(chunk);
      byteLength += chunk.byteLength;
    }
    const buf = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await ctx.storage.put({
      key: storageKey,
      body: buf,
      contentType: "application/x-ndjson",
      metadata: { rows: String(rows.length), tables: "1" },
    });

    await (ctx.db as any).insert(t).values({
      id,
      tenantId: args.tenantId,
      kind: "pre-drop",
      label: args.label,
      storageKey,
      size: buf.byteLength,
      tableCount: 1,
      status: "done",
      createdBy: args.userId,
      completedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
    });
    return { id, storageKey, rowCount: rows.length };
  } catch (e) {
    // The operator asked for the drop and confirmed it. Failing to take the
    // safety copy is worth logging loudly, but turning it into a 500 would leave
    // them unable to drop anything at all when storage is misconfigured.
    console.error("[backup] pre-drop snapshot failed", e);
    return null;
  }
};

/** Fetch one tracking row, enforcing workspace scoping.
 *
 *  Note the null arms are NOT symmetric. A row with `tenant_id = NULL` is a
 *  *global* backup, and `runBackup` applies no WHERE at all for those — it is a
 *  genuine full-instance dump carrying every workspace's `users`, `api_keys`
 *  and `auth_config`. The previous guard (`tenantId && row.tenantId && …`)
 *  fell open on exactly that row, so a workspace-scoped caller holding the id
 *  could download or restore the whole instance. `listBackups` filters on
 *  `eq(tenant_id, …)`, which never matches NULL, so the id was not reachable
 *  through the API — this closes the guard rather than a live exploit. */
export const getBackupScoped = async (
  ctx: Ctx,
  tenantId: string | null,
  id: string,
): Promise<Record<string, unknown>> => {
  const t = backupsTable(ctx.dialect);
  const rows = await (ctx.db as any).select().from(t).where(eq(t.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "Backup not found");
  if (tenantId && row.tenantId !== tenantId)
    throw new AppError(
      "FORBIDDEN",
      row.tenantId
        ? "Backup belongs to a different workspace"
        : "This is an instance-wide backup — not reachable from a workspace",
    );
  return row as Record<string, unknown>;
};

/** Restore a stored backup into the active workspace. Confirm gating stays
 *  surface-specific (REST header / GraphQL arg / MCP arg / CLI flag); `mode`
 *  defaults to the additive behaviour every caller had before it existed.
 *
 *  Every surface funnels through here, so this is where the audit row belongs —
 *  restore used to write none at all, which made the one operation that can
 *  overwrite live data the only admin action with no trace. */
export const restoreBackupById = async (
  ctx: Ctx,
  tenantId: string | null,
  id: string,
  opts: { mode?: RestoreMode; onlyTables?: string[]; userId?: string | null } = {},
): Promise<RestoreResult> => {
  const row = await getBackupScoped(ctx, tenantId, id);
  const mode: RestoreMode = opts.mode === "overwrite" ? "overwrite" : "additive";
  const result = await restoreBackup(ctx, {
    storageKey: row.storageKey as string,
    tenantId: tenantId ?? null,
    mode,
    onlyTables: opts.onlyTables,
  });
  // Best-effort: the restore already happened and a failed audit write must not
  // turn a completed restore into a 500 (same reasoning as the backup failure
  // path above).
  try {
    await recordActivity(ctx, {
      userId: opts.userId ?? null,
      tenantId,
      action: "backup.restored",
      collection: "backups",
      itemId: id,
      payload: {
        mode,
        onlyTables: opts.onlyTables ?? null,
        tableCount: result.tableCount,
        rowCount: result.rowCount,
        overwritten: result.overwritten,
        skipped: result.skipped,
        keptAdditive: result.keptAdditive,
      },
    });
  } catch {
    /* audit is best-effort — the restore itself already succeeded */
  }
  return result;
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

/** How long a `running` backup row may sit before the sweep calls it failed.
 *  Generous, because the dump is synchronous and a big workspace on a slow
 *  runtime is legitimately slow — this is for rows whose process is GONE. */
const STUCK_BACKUP_MS = 60 * 60 * 1000;

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

  // A dump that OOMs or whose isolate is evicted never reaches
  // `recordAndRunBackup`'s catch, so its row stays `running` forever — it reads
  // as "in progress" months later and, worse, hides that no backup succeeded.
  // Nothing else can close those out, because the process that owned them is
  // gone. Age them out here, on the sweep that already runs.
  try {
    const stuckBefore = now.getTime() - STUCK_BACKUP_MS;
    await (ctx.db as any)
      .update(backupsTable)
      .set({
        status: "failed",
        error: "Backup did not finish (process ended before it completed).",
        completedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(
        and(
          eq(backupsTable.status, "running"),
          lt(
            backupsTable.createdAt,
            ctx.dialect === "pg" ? (new Date(stuckBefore) as any) : (stuckBefore as any),
          ),
        ),
      );
  } catch {
    /* best-effort — never block the scheduled run behind bookkeeping */
  }

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

    // Retention: drop `auto` backups beyond the newest `retain` AND (when the
    // age rule is on) any older than `retainDays` — whichever bites first.
    // Storage object goes first so a crash between the two deletes leaves a
    // harmless tracking row, not an orphaned blob.
    const ageCutoff =
      cfg.retainDays != null
        ? now.getTime() - cfg.retainDays * 24 * 60 * 60 * 1000
        : null;
    const stale = autos.filter(
      (a, i) =>
        i >= cfg.retain || (ageCutoff != null && toMs(a.createdAt) < ageCutoff),
    );
    for (const old of stale) {
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

  return { ran, pruned };
};
