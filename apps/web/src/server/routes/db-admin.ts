import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { sql, desc, eq } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import { MIGRATION_TAGS_PG, MIGRATION_TAGS_SQLITE } from "@workeros/db";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { recordAndRunBackup } from "../services/backup";
import { SECURITY, errorResponses } from "../lib/openapi";

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

export const dbAdminRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "post",
      path: "/sql/run",
      tags: [TAG],
      summary: "Run SQL",
      description:
        "Read-only by default. Writes require `?writes=1` AND `X-Workeros-Confirm: yes` header. Splits on `;` and runs each statement.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
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
     * with `?writes=1` AND `X-Workeros-Confirm: yes` to actually execute
     * mutating SQL. Auditable through the activity log (best-effort).
     */
    async (c) => {
      const ctx = c.get("ctx");
      const body = c.req.valid("json");
      const q = c.req.valid("query");
      const stmts = splitStatements(body.sql);
      if (stmts.length === 0) throw new AppError("VALIDATION", "Empty query.");
      const allowWrites = q.writes === "1";
      const confirmed = c.req.header("x-workeros-confirm") === "yes";
      const writeStmts = stmts.filter(isWrite);
      if (writeStmts.length > 0 && !(allowWrites && confirmed)) {
        throw new AppError(
          "FORBIDDEN",
          "Write statements require ?writes=1 and X-Workeros-Confirm: yes header.",
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
        throw new AppError("VALIDATION", `SQL error: ${(e as Error).message}`);
      }
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
      middleware: [requireUser, requireAdmin],
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
      middleware: [requireUser, requireAdmin],
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
     * Lists migrations recorded in the dialect-specific drizzle table. Joins
     * each row with the build-time manifest so the UI can show the human-
     * readable folder tag (`20260510150000_folders_tenant_id`) instead of
     * the raw sha256 hash that drizzle persists.
     */
    async (c) => {
      const ctx = c.get("ctx");
      const tags = ctx.dialect === "pg" ? MIGRATION_TAGS_PG : MIGRATION_TAGS_SQLITE;
      const tableExpr =
        ctx.dialect === "pg" ? "drizzle.__drizzle_migrations" : "__drizzle_migrations";
      try {
        const rows = await queryAll<{ id: number | string; hash: string; created_at: number | string }>(
          { db: ctx.db, dialect: ctx.dialect },
          `SELECT id, hash, created_at FROM ${tableExpr} ORDER BY id DESC LIMIT 200`,
        );
        return c.json({
          data: rows.map((r) => ({
            ...r,
            tag: tags[r.hash] ?? null,
            applied: true,
          })),
        });
      } catch {
        return c.json({ data: [], note: "Drizzle migrations table not present yet." });
      }
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
      const t = ctx.dialect === "pg" ? pg.schema.backups : sqlite.schema.backups;
      const rows = await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.tenantId, auth.tenantId ?? ""))
        .orderBy(desc(t.createdAt))
        .limit(100);
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
        "Inserts the tracking row and runs the dump synchronously. Returns the refreshed row.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        body: {
          content: { "application/json": { schema: BackupNowInput } },
        },
      },
      responses: {
        201: {
          description: "Done",
          content: { "application/json": { schema: z.object({ data: BackupRow }) } },
        },
        ...errorResponses,
      },
    }),
    /**
     * Run a manual backup. Inserts a tracking row, then dumps every system
     * table + the active tenant's c_* tables to JSONL via the storage adapter.
     * The dump runs inline (synchronously from the request's perspective) so
     * the UI shows immediate `done`/`failed` state without polling.
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
      const t = ctx.dialect === "pg" ? pg.schema.backups : sqlite.schema.backups;
      const id = crypto.randomUUID();
      const stamp = new Date().toISOString().replace(/[:.TZ-]/g, "").slice(0, 14);
      const storageKey = `backups/${auth.tenantId ?? "global"}/${stamp}_${id}.jsonl`;
      await (ctx.db as any).insert(t).values({
        id,
        tenantId: auth.tenantId ?? null,
        kind: "manual",
        label: body.label ?? null,
        storageKey,
        size: 0,
        tableCount: 0,
        status: "queued",
        createdBy: auth.userId,
      });
      // Run inline — dump is small enough for D1/pg fixtures + this is admin
      // traffic. Larger deployments can move this to a queue/cron worker.
      await recordAndRunBackup(ctx, {
        id,
        tenantId: auth.tenantId ?? null,
        storageKey,
        userId: auth.userId,
        label: body.label ?? null,
      });
      const refreshed = await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.id, id))
        .limit(1);
      return c.json({ data: refreshed[0] ?? { id, storageKey, status: "running" } }, 201);
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
      const t = ctx.dialect === "pg" ? pg.schema.backups : sqlite.schema.backups;
      const rows = await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) throw new AppError("NOT_FOUND", "Backup not found");
      if (auth.tenantId && row.tenantId && row.tenantId !== auth.tenantId) {
        throw new AppError("FORBIDDEN", "Backup belongs to a different workspace");
      }
      const file = await ctx.storage.get(row.storageKey as string);
      if (!file) throw new AppError("NOT_FOUND", "Backup file missing on storage");
      return new Response(file.body, {
        headers: {
          "content-type": file.meta.contentType ?? "application/x-ndjson",
          "content-disposition": `attachment; filename="${(row.storageKey as string).split("/").pop()}"`,
        },
      });
    },
  );
