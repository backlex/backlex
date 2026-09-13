import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { sql } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import { MIGRATION_TAGS_PG, MIGRATION_TAGS_SQLITE } from "@backlex/db";
import { reapplyWorkspaceSchema } from "../services/schema/reapply";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import {
  listBackups,
  startManualBackup,
  createBackupRow,
  getBackupScoped,
  restoreBackupById,
  loadBackupConfig,
  saveBackupConfig,
} from "../services/backup";
import { SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { requireOperatorMw } from "../services/roles/guards";
import { assertQueueable, startLongJob } from "../services/jobs/long-running";
import { keepAlive, logActivity } from "../services/activity";

/** Workspace-scoped admin. Enough for the backup routes below, which all run
 *  against `auth.tenantId`. NOT enough for the instance-wide routes (SQL
 *  console, table/migration inventory) — those touch every workspace's data at
 *  once and take `requireOperatorMw` instead, because `admin` is self-serve:
 *  `POST /api/tenants` grants it to whoever creates a workspace. */
const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  await next();
};

const isWrite = (s: string) =>
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|ATTACH|DETACH)\b/i.test(s);

const splitStatements = (s: string): string[] => {
  // Naive splitter — safe enough for admin-typed queries.
  return s
    .split(/;(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && !x.startsWith("--"));
};

const queryAll = async <T>(
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  raw: string,
): Promise<T[]> => {
  const q = sql.raw(raw);
  if (ctx.dialect === "pg") {
    const r = await (ctx.db as any).execute(q);
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) return r.rows as T[];
    return r as T[];
  }
  return (await (ctx.db as any).all(q)) as T[];
};

const execRaw = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  raw: string,
): Promise<void> => {
  const q = sql.raw(raw);
  if (ctx.dialect === "pg") {
    await (ctx.db as any).execute(q);
  } else {
    await (ctx.db as any).run(q);
  }
};

const TAG = "db-admin";

const SqlRunInput = z
  .object({ sql: z.string().min(1).max(10000) })
  .openapi("SqlRunInput");

const SqlStatementResult = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  ms: z.number().int().nonnegative(),
});

const TableCount = z.object({
  name: z.string(),
  rows: z.number().int().nonnegative(),
});

const MigrationRow = z
  .object({
    id: z.union([z.string(), z.number()]),
    hash: z.string(),
    created_at: z.union([z.string(), z.number()]),
    tag: z.string().nullable(),
    applied: z.boolean(),
    /** Which ledger recorded it: the CLI's `__drizzle_migrations`, the boot
     *  runner's `__backlex_migrations`, or both. `null` = neither, i.e. this
     *  build ships the migration and nothing has applied it. On Vercel and
     *  Netlify no CLI ever runs, so `runtime` is the normal answer there. */
    source: z.enum(["cli", "runtime", "cli+runtime"]).nullable(),
  })
  .openapi("MigrationRow");

const BackupRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    kind: z.string(),
    label: z.string().nullable(),
    storageKey: z.string(),
    size: z.number().int().nonnegative(),
    tableCount: z.number().int().nonnegative(),
    status: z.string(),
    createdBy: z.string().nullable(),
    createdAt: z.unknown().nullable(),
  })
  .openapi("BackupRow");

const BackupNowInput = z
  .object({ label: z.string().max(80).optional() })
  .openapi("BackupNowInput");

/** The opt-in that moves an operation onto the durable job queue. Declared once
 *  so every route that offers it says the same thing in the generated spec. */
const AsyncQuery = z.object({
  async: z.enum(["0", "1"]).optional().openapi({
    description:
      "`1` runs the operation as a durable background job: the call answers 202 with a `jobId` instead of doing the work, and the outcome, progress and any error land on `GET /api/jobs/{id}`. Retry, cancel and dead-lettering come with it. Omit for the synchronous behaviour, which is unchanged. Not available to API keys, workspace end-users or impersonation sessions — a queued job re-resolves permissions from the user id alone, which those three narrow in ways it cannot reproduce.",
  }),
});

const QueuedResult = z
  .object({
    jobId: z.string(),
    status: z.literal("queued"),
  })
  .catchall(z.unknown())
  .openapi("QueuedJob");

/** Read the flag. A route that offers `?async=1` must branch on this BEFORE it
 *  does any work, and must not touch the synchronous return value — every one
 *  of these responses has SDK, CLI and MCP twins reading it. */
const wantsAsync = (c: { req: { query: (k: string) => string | undefined } }): boolean =>
  c.req.query("async") === "1";

const RestoreResult = z
  .object({
    tableCount: z.number().int().nonnegative(),
    rowCount: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    overwritten: z.number().int().nonnegative().openapi({
      description:
        "Rows restated to their backup-era values. Always 0 unless `mode=overwrite`.",
    }),
    keptAdditive: z.array(z.string()).openapi({
      description:
        "Tables that stayed additive despite `mode=overwrite` because they have no single-column `id` to name as the conflict target (e.g. `user_roles`).",
    }),
    unfoldedRows: z.number().int().nonnegative().openapi({
      description:
        "Rows whose case/accent-fold companion column the post-restore pass could not reach before its cap. Non-zero means case-insensitive filters will not match those rows until the fold pass is run again — the restore itself succeeded.",
    }),
  })
  .openapi("RestoreResult");

const BackupConfigSchema = z
  .object({
    schedule: z.enum(["off", "daily", "weekly"]),
    retain: z.number().int().min(1).max(365),
    retainDays: z.number().int().min(1).max(3650).nullable().openapi({
      description:
        "Age-based retention on top of the count — auto backups older than this many days are pruned. null disables the age rule.",
    }),
  })
  .openapi("BackupConfig");

/** Ceiling on the SQL text carried into the audit payload — see
 *  {@link logSqlRun}. */
const SQL_AUDIT_MAX = 2_000;

/**
 * Record that arbitrary SQL was run, and by whom.
 *
 * This route's own docblock used to claim it was "auditable through the
 * activity log (best-effort)" and nothing wrote a row. That sentence is the
 * whole finding: `routes/impersonation.ts`, `roles/permissions.ts` and
 * `roles/users.ts` all DO log their privileged actions, so an auditor
 * reasonably reads the absence of a row as "it did not happen" — while the one
 * endpoint that can `DELETE FROM activity` was the one leaving no trace of
 * having done it.
 *
 * The SQL text is truncated rather than dropped: an activity payload is read by
 * a human deciding whether to be alarmed, and "a write ran" without the
 * statement is not enough to decide with. It is truncated because a bulk INSERT
 * would otherwise park megabytes in the audit table.
 */
const logSqlRun = async (
  c: Parameters<typeof logActivity>[0],
  stmts: string[],
  writeStmts: string[],
  sql: string,
  error: string | null,
): Promise<void> => {
  await logActivity(c, {
    action: "db.sql",
    collection: "db",
    itemId: null,
    payload: {
      statements: stmts.length,
      writes: writeStmts.length,
      sql: sql.length > SQL_AUDIT_MAX ? `${sql.slice(0, SQL_AUDIT_MAX)}…` : sql,
      ...(error ? { error } : {}),
    },
  });
};

export const dbAdminRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "post",
      path: "/sql/run",
      tags: [TAG],
      summary: "Run SQL",
      description:
        "Read-only by default. Writes require `?writes=1` AND `X-Backlex-Confirm: yes` header. Splits on `;` and runs each statement.",
      security: SECURITY,
      middleware: [requireUser, requireOperatorMw],
      request: {
        query: z.object({ writes: z.enum(["0", "1"]).optional() }),
        body: { required: true, content: { "application/json": { schema: SqlRunInput } } },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(SqlStatementResult),
                ms: z.number().int(),
                count: z.number().int(),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    /**
     * Run a single SQL statement (or short multi-statement block) against the
     * active database. Defaults to read-only; the client must opt into writes
     * with `?writes=1` AND `X-Backlex-Confirm: yes` to actually execute
     * mutating SQL. Every run writes an activity row — see {@link logSqlRun}.
     */
    async (c) => {
      const ctx = c.get("ctx");
      const body = c.req.valid("json");
      const q = c.req.valid("query");
      const stmts = splitStatements(body.sql);
      if (stmts.length === 0) throw new AppError("VALIDATION", "Empty query.");
      const allowWrites = q.writes === "1";
      const confirmed = c.req.header("x-backlex-confirm") === "yes";
      const writeStmts = stmts.filter(isWrite);
      if (writeStmts.length > 0 && !(allowWrites && confirmed)) {
        throw new AppError(
          "FORBIDDEN",
          "Write statements require ?writes=1 and X-Backlex-Confirm: yes header.",
        );
      }
      const t0 = Date.now();
      const results: Array<{ rows: Record<string, unknown>[]; ms: number }> = [];
      try {
        for (const s of stmts) {
          const ts = Date.now();
          if (isWrite(s)) {
            await execRaw({ db: ctx.db, dialect: ctx.dialect }, s);
            results.push({ rows: [], ms: Date.now() - ts });
          } else {
            const rows = await queryAll<Record<string, unknown>>(
              { db: ctx.db, dialect: ctx.dialect },
              s,
            );
            results.push({ rows, ms: Date.now() - ts });
          }
        }
      } catch (e) {
        // Recorded BEFORE the throw. A statement that errored still ran against
        // the database, and a failed `DELETE FROM activity` is exactly the
        // attempt an auditor most wants to see.
        await logSqlRun(c, stmts, writeStmts, body.sql, (e as Error).message);
        throw new AppError("VALIDATION", `SQL error: ${(e as Error).message}`);
      }
      await logSqlRun(c, stmts, writeStmts, body.sql, null);
      return c.json({ data: results, ms: Date.now() - t0, count: stmts.length });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/tables",
      tags: [TAG],
      summary: "List user-visible tables",
      description:
        "Tables with row counts. Drops the drizzle migrations table and runtime system tables.",
      security: SECURITY,
      middleware: [requireUser, requireOperatorMw],
      request: { query: z.object({ limit: z.string().optional() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(TableCount) }) },
          },
        },
        ...errorResponses,
      },
    }),
    /**
     * Dialect-aware list of user-visible tables with row counts. Excludes
     * drizzle's migration tracker, sqlite system tables, and Cloudflare D1's
     * `_cf_*` reserved tables (which reject user SELECTs). Counts run in
     * parallel and are best-effort — a count failure on one table doesn't
     * fail the whole response.
     */
    async (c) => {
      const ctx = c.get("ctx");
      const q = c.req.valid("query");
      const limit = Math.min(Math.max(Number(q.limit ?? 200), 1), 500);
      let names: string[];
      if (ctx.dialect === "pg") {
        const rows = await queryAll<{ name: string }>(
          { db: ctx.db, dialect: ctx.dialect },
          `SELECT tablename AS name FROM pg_tables
           WHERE schemaname = 'public'
             AND tablename NOT LIKE '\\_\\_drizzle%' ESCAPE '\\'
           ORDER BY tablename
           LIMIT ${limit}`,
        );
        names = rows.map((r) => r.name);
      } else {
        // ESCAPE only applies to the immediately preceding LIKE, so every
        // pattern that uses an escaped underscore needs its own ESCAPE clause.
        // sqlite_% doesn't need one because there's no literal underscore in
        // the pattern we want to match.
        const rows = await queryAll<{ name: string }>(
          { db: ctx.db, dialect: ctx.dialect },
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             AND name NOT LIKE '\\_\\_drizzle%' ESCAPE '\\'
             AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
           ORDER BY name
           LIMIT ${limit}`,
        );
        names = rows.map((r) => r.name);
      }
      const quote = ctx.dialect === "pg" ? '"' : '"';
      const counts = await Promise.allSettled(
        names.map(async (n) => {
          const safe = n.replace(/"/g, '""');
          const r = await queryAll<{ n: number | string }>(
            { db: ctx.db, dialect: ctx.dialect },
            `SELECT COUNT(*) AS n FROM ${quote}${safe}${quote}`,
          );
          const row = r[0];
          return { name: n, rows: Number(row?.n ?? 0) };
        }),
      );
      return c.json({
        data: counts.map((r, i) =>
          r.status === "fulfilled" ? r.value : { name: names[i] ?? "", rows: 0 },
        ),
      });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/migrations",
      tags: [TAG],
      summary: "List applied migrations",
      description:
        "Joins the drizzle migrations table with the build-time manifest for human-readable tags.",
      security: SECURITY,
      middleware: [requireUser, requireOperatorMw],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(MigrationRow),
                note: z.string().optional(),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    /**
     * Lists every migration this build knows about, and which of the two
     * ledgers has recorded it.
     *
     * There ARE two (see docs/deployment.md): the CLI writes
     * `__drizzle_migrations` — `drizzle.__drizzle_migrations` on Postgres —
     * and the boot runner `ensureMigrations` writes `__backlex_migrations`.
     * This used to read only the first, so on a Vercel or Netlify deploy, where
     * no CLI ever runs and the boot runner does all the work, the page reported
     * "not present yet" over a fully current schema. Blind exactly on the
     * targets whose operator is least able to check by hand (#326).
     *
     * Keyed on the folder TAG rather than the hash, because that is the one
     * identity both ledgers share: the CLI stores a sha256 and the boot runner
     * stores the migration NAME, which IS the tag. A row present in both is one
     * row with `source: "cli+runtime"`, not two.
     *
     * The manifest seeds the list, so a migration this build ships and NEITHER
     * ledger has appears as `applied: false`. `applied` used to be hardcoded
     * true on every returned row, which made it the one thing the page could
     * not tell you.
     */
    async (c) => {
      const ctx = c.get("ctx");
      const tags = ctx.dialect === "pg" ? MIGRATION_TAGS_PG : MIGRATION_TAGS_SQLITE;
      const hashOfTag = new Map(Object.entries(tags).map(([hash, tag]) => [tag, hash]));
      const cliTable =
        ctx.dialect === "pg" ? "drizzle.__drizzle_migrations" : "__drizzle_migrations";

      interface Row {
        id: string | number;
        hash: string;
        created_at: string | number;
        tag: string | null;
        applied: boolean;
        source: "cli" | "runtime" | "cli+runtime" | null;
      }
      // Keyed by tag where there is one, else by hash — a CLI row whose hash the
      // manifest does not know still has to appear, and it is the row that says
      // the manifest is out of sync.
      const byKey = new Map<string, Row>();
      for (const [hash, tag] of Object.entries(tags)) {
        byKey.set(tag, { id: tag, hash, created_at: "", tag, applied: false, source: null });
      }

      /**
       * "This ledger is not in use on this deploy target" and "this ledger
       * would not answer" are DIFFERENT facts, and the old bare catch reported
       * both as "not present yet".
       *
       * Absence is ordinary and expected: a Cloudflare/D1 deploy migrates
       * through the CLI and has no `__backlex_migrations`; a Vercel/Netlify
       * deploy boots the runner and has no `__drizzle_migrations`. Neither is
       * worth a word on screen. A permission error or a malformed query is,
       * and it is what the old catch hid.
       */
      const missingTable = (msg: string) =>
        /no such table|does not exist|doesn't exist|unknown table|relation .* does not exist/i.test(
          msg,
        );
      const problems: string[] = [];
      let readable = 0;
      const read = async <T>(what: string, sql: string): Promise<T[] | null> => {
        try {
          const rows = await queryAll<T>({ db: ctx.db, dialect: ctx.dialect }, sql);
          readable++;
          return rows;
        } catch (e) {
          // The driver's own message is the specific one; drizzle's wrapper
          // restates the whole statement, which is noise on an admin page.
          const err = e as { message?: string; cause?: { message?: string } };
          const msg = err.cause?.message ?? err.message ?? String(e);
          if (!missingTable(msg)) problems.push(`${what}: ${msg}`);
          return null;
        }
      };

      // Derived from the manifest, never a round number. A ledger holds one row
      // per migration this build ships, so a fixed cap becomes wrong the release
      // it is crossed — and it would go wrong SILENTLY, reporting applied
      // migrations as `pending` because the row that proves otherwise fell off
      // the end. The margin covers rows a newer deployment wrote against an
      // older build.
      const limit = Object.keys(tags).length + 200;
      const cli = await read<{ id: number | string; hash: string; created_at: number | string }>(
        cliTable,
        `SELECT id, hash, created_at FROM ${cliTable} ORDER BY id DESC LIMIT ${limit}`,
      );
      for (const r of cli ?? []) {
        const tag = tags[r.hash] ?? null;
        const key = tag ?? r.hash;
        byKey.set(key, {
          id: r.id,
          hash: r.hash,
          created_at: r.created_at,
          tag,
          applied: true,
          source: "cli",
        });
      }

      const runtime = await read<{ name: string; applied_at: number | string }>(
        "__backlex_migrations",
        `SELECT name, applied_at FROM __backlex_migrations ORDER BY applied_at DESC LIMIT ${limit}`,
      );
      for (const r of runtime ?? []) {
        const existing = byKey.get(r.name);
        byKey.set(r.name, {
          id: existing?.applied ? existing.id : r.name,
          hash: existing?.hash ?? hashOfTag.get(r.name) ?? r.name,
          // The CLI's timestamp wins when both have one: it is when the schema
          // actually changed, where the runtime row may only record the moment
          // the ledger was adopted.
          created_at: existing?.applied ? existing.created_at : r.applied_at,
          tag: r.name,
          applied: true,
          source: existing?.source === "cli" ? "cli+runtime" : "runtime",
        });
      }

      const data = [...byKey.values()].sort((a, b) => {
        if (a.applied !== b.applied) return a.applied ? -1 : 1;
        return String(b.tag ?? b.hash).localeCompare(String(a.tag ?? a.hash));
      });
      // A note is for something the operator can act on. One ledger being
      // absent is not — it is what every deploy target that uses the other one
      // looks like, and calling it "not present yet" is what made this page
      // report a healthy Vercel deployment as un-migrated. NEITHER ledger being
      // readable is worth saying, because then the page genuinely knows
      // nothing.
      if (readable === 0 && problems.length === 0) {
        problems.push(
          "Neither migration ledger exists yet — nothing has migrated this database.",
        );
      }
      return c.json(problems.length > 0 ? { data, note: problems.join("; ") } : { data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/backups",
      tags: [TAG],
      summary: "List backups",
      description:
        "Backup tracking rows for the active workspace, newest first.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(BackupRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    /** Backups index (records only — actual dumping is adapter-specific). */
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      // Cast matches the repo-wide dual-dialect convention — the zod response
      // schema is the wire contract; drizzle rows are structurally loose.
      const rows = (await listBackups(ctx, auth.tenantId ?? null)) as any;
      return c.json({ data: rows });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/backups/now",
      tags: [TAG],
      summary: "Run a manual backup",
      description:
        "Inserts the tracking row and runs the dump synchronously. Returns the refreshed row. Pass `?async=1` to run the dump as a durable background job instead — the tracking row is still created immediately, and the call answers 202 with a `jobId`.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        query: AsyncQuery,
        body: {
          content: { "application/json": { schema: BackupNowInput } },
        },
      },
      responses: {
        201: {
          description: "Done",
          content: { "application/json": { schema: z.object({ data: BackupRow }) } },
        },
        202: {
          description: "Queued",
          content: { "application/json": { schema: z.object({ data: QueuedResult }) } },
        },
        ...errorResponses,
      },
    }),
    /**
     * Run a manual backup. Inserts a tracking row, then dumps every system
     * table + the active tenant's c_* tables to JSONL via the storage adapter.
     *
     * Synchronously by default, which is what the admin UI wants for a small
     * workspace — immediate `done`/`failed` with no polling. `?async=1` moves
     * the dump onto the durable queue for the workspaces where it does not fit
     * in a request: the tracking row is inserted here either way, so the caller
     * always leaves with a backup id, and the job fills the rest in.
     */
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      // Body is optional — tolerate empty/invalid JSON the same as before.
      let body: { label?: string } = {};
      try {
        body = c.req.valid("json");
      } catch {
        body = {};
      }
      if (wantsAsync(c)) {
        // Refuse BEFORE the tracking row is written. `startLongJob` would reject
        // an API key / app-plane / impersonation caller anyway, but by then the
        // row exists — and an orphan `queued` backup that no job will ever run
        // is worse than a plain refusal: it sits in the workspace's backup list
        // looking like a dump in progress.
        assertQueueable(auth);
        const row = await createBackupRow(ctx, {
          tenantId: auth.tenantId ?? null,
          userId: auth.userId,
          label: body.label ?? null,
        });
        const { jobId } = await startLongJob(ctx, {
          type: "db.backup",
          auth,
          payload: { backupId: row.id, label: body.label ?? null },
          background: (p) => keepAlive(c, p),
        });
        return c.json(
          {
            data: {
              jobId,
              status: "queued" as const,
              backupId: row.id,
              storageKey: row.storageKey,
            },
          },
          202,
        );
      }
      // Runs inline — dump is small enough for D1/pg fixtures + this is admin
      // traffic. Larger deployments pass `?async=1`.
      const row = (await startManualBackup(ctx, {
        tenantId: auth.tenantId ?? null,
        userId: auth.userId,
        label: body.label ?? null,
      })) as any;
      return c.json({ data: row }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/backups/{id}/download",
      tags: [TAG],
      summary: "Download a backup",
      description: "Streams the JSONL dump from the storage adapter.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Backup file (ndjson)",
          content: { "application/octet-stream": { schema: z.any() } },
        },
        ...errorResponses,
      },
    }),
    /**
     * Stream the dump bytes back to the admin UI for download. We pull through
     * the storage adapter so this works whether the file lives on R2/S3/fs.
     */
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const row = await getBackupScoped(ctx, auth.tenantId ?? null, id);
      const file = await ctx.storage.get(row.storageKey as string);
      if (!file) throw new AppError("NOT_FOUND", "Backup file missing on storage");
      return new Response(file.body, {
        headers: {
          "content-type": file.meta.contentType ?? "application/x-ndjson",
          "content-disposition": `attachment; filename="${(row.storageKey as string).split("/").pop()}"`,
        },
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/backups/{id}/restore",
      tags: [TAG],
      summary: "Restore a backup",
      description:
        "Re-inserts the dump's rows. `mode=additive` (the default) uses `ON CONFLICT DO NOTHING` — missing/deleted rows come back, existing rows are never overwritten or removed, so it is safe to run live. `mode=overwrite` uses `ON CONFLICT (id) DO UPDATE`, restating rows that still exist to their backup-era values: this is what undoes a bad bulk update or recovers a dropped column's data, and it CAN destroy current data. `onlyTables` narrows the restore to a named set. Requires the `X-Backlex-Confirm: yes` header in either mode.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        params: z.object({ id: z.string() }),
        query: z.object({
          mode: z.enum(["additive", "overwrite"]).optional().openapi({
            description: "Defaults to `additive`.",
          }),
          onlyTables: z.string().optional().openapi({
            description:
              "Comma-separated table names. When present, only these tables are restored.",
          }),
        }).extend(AsyncQuery.shape),
      },
      responses: {
        200: {
          description: "Restored",
          content: {
            "application/json": { schema: z.object({ data: RestoreResult }) },
          },
        },
        202: {
          description: "Queued",
          content: { "application/json": { schema: z.object({ data: QueuedResult }) } },
        },
        ...errorResponses,
      },
    }),
    /**
     * Restore a stored backup into the active workspace. Gated on the same
     * confirm header the SQL-write path uses, since it mutates data. In the
     * default additive mode the worst case is a no-op when every row already
     * exists; `mode=overwrite` restates existing rows, which is the point of it
     * and also why the header is not optional there either.
     */
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const { mode, onlyTables } = c.req.valid("query");
      if (c.req.header("x-backlex-confirm") !== "yes") {
        throw new AppError(
          "FORBIDDEN",
          "Restore requires the X-Backlex-Confirm: yes header.",
        );
      }
      const tables = onlyTables
        ? onlyTables.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      if (wantsAsync(c)) {
        // The backup is resolved here rather than in the job so an unknown id
        // or a foreign workspace's backup is still a 404/403 on THIS call —
        // queueing a restore that was never going to be allowed just moves the
        // refusal somewhere nobody is looking.
        await getBackupScoped(ctx, auth.tenantId ?? null, id);
        const { jobId } = await startLongJob(ctx, {
          type: "db.restore",
          auth,
          payload: { backupId: id, mode, onlyTables: tables },
          background: (p) => keepAlive(c, p),
        });
        return c.json({ data: { jobId, status: "queued" as const, backupId: id } }, 202);
      }
      const result = await restoreBackupById(ctx, auth.tenantId ?? null, id, {
        mode,
        onlyTables: tables,
        userId: auth.userId ?? null,
      });
      // The `200` is stated rather than inferred. Once a route declares more
      // than one success status, a bare `c.json(x)` widens to the union of them
      // and the compiler then asks this body to satisfy the 202 shape too.
      return c.json({ data: result }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/backups/config",
      tags: [TAG],
      summary: "Get the backup schedule",
      description:
        "The active workspace's automatic-backup schedule + retention count.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: BackupConfigSchema }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const cfg = await loadBackupConfig(ctx, auth.tenantId ?? null);
      return c.json({ data: cfg });
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/backups/config",
      tags: [TAG],
      summary: "Set the backup schedule",
      description:
        "Enable/disable automatic backups (`off` | `daily` | `weekly`) and how many to retain. Auto backups run from the cron tick and prune to the retention count.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: BackupConfigSchema.partial() } },
        },
      },
      responses: {
        200: {
          description: "Saved",
          content: {
            "application/json": { schema: z.object({ data: BackupConfigSchema }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const cfg = await saveBackupConfig(ctx, auth.tenantId ?? null, body);
      return c.json({ data: cfg });
    },
  )

  /**
   * Re-apply every managed collection's schema.
   *
   * `applyCollection` is additive and idempotent — it never drops or rewrites a
   * column — so running it over a whole workspace is safe and is the one thing
   * that brings an EXISTING workspace forward when a release adds a column to
   * managed tables.
   *
   * It exists because nothing else does that. `applyCollection` runs on create,
   * patch, restore, provisioning and migrate; nothing re-applies at boot, so a
   * tenant that upgrades keeps its old physical tables until somebody happens
   * to edit a schema. Folded search is the first feature to need this — every
   * `text` column gains a `<name>__fold` companion, and the rows are backfilled
   * by the same call.
   *
   * Reports per collection rather than a single count: a workspace with one
   * unapplyable table must not read as a failed upgrade, and a backfill that
   * did not finish has to SAY so instead of being counted as done.
   *
   * **`cronTick` now runs the same pass daily across every workspace** (#317) —
   * running this by hand after a release is no longer the only thing standing
   * between a workspace and a column it is owed. This route stays because an
   * operator who has just fixed a failing collection wants the answer NOW and
   * wants to READ it, which a cron log is not.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/schema/reapply",
      tags: [TAG],
      summary: "Re-apply every managed collection's schema",
      description:
        "Additive and idempotent: adds any columns a newer release introduced (and backfills them), never drops or rewrites one. Adopted collections are skipped — backlex never DDLs a table it did not create. Run this after upgrading a workspace.",
      security: SECURITY,
      middleware: [requireUser, requireOperatorMw],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  applied: z.number().int().nonnegative(),
                  skipped: z.number().int().nonnegative(),
                  failed: z.array(z.object({ slug: z.string(), error: z.string() })),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = auth.tenantId ?? null;
      if (!tenantId) {
        throw new AppError("VALIDATION", "Re-apply requires an active workspace");
      }
      // The loop lives in `services/schema/reapply.ts` because the scheduled
      // sweep runs the same one. Two copies of a DDL pass would drift, and the
      // half that drifted would be the one nobody reads — the cron.
      const result = await reapplyWorkspaceSchema(ctx, tenantId);
      return c.json({ data: result });
    },
  );
