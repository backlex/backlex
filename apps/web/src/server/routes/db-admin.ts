import { Hono } from "hono";
import { z } from "zod";
import { sql, desc, eq } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { recordAndRunBackup } from "../services/backup";

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
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

export const dbAdminRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  /**
   * Run a single SQL statement (or short multi-statement block) against the
   * active database. Defaults to read-only; the client must opt into writes
   * with `?writes=1` AND `X-Workeros-Confirm: yes` to actually execute
   * mutating SQL. Auditable through the activity log (best-effort).
   */
  .post("/sql/run", async (c) => {
    const ctx = c.get("ctx");
    const body = z.object({ sql: z.string().min(1).max(10000) }).parse(await c.req.json());
    const stmts = splitStatements(body.sql);
    if (stmts.length === 0) throw new AppError("VALIDATION", "Empty query.");
    const allowWrites = c.req.query("writes") === "1";
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
  })
  /** Lists migrations recorded in the dialect-specific drizzle table. */
  .get("/migrations", async (c) => {
    const ctx = c.get("ctx");
    if (ctx.dialect === "pg") {
      try {
        const rows = await queryAll<{ id: number | string; hash: string; created_at: number | string }>(
          { db: ctx.db, dialect: ctx.dialect },
          `SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 200`,
        );
        return c.json({ data: rows.map((r) => ({ ...r, applied: true })) });
      } catch {
        return c.json({ data: [], note: "Drizzle migrations table not present yet." });
      }
    }
    try {
      const rows = await queryAll<{ id: number | string; hash: string; created_at: number | string }>(
        { db: ctx.db, dialect: ctx.dialect },
        `SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id DESC LIMIT 200`,
      );
      return c.json({ data: rows.map((r) => ({ ...r, applied: true })) });
    } catch {
      return c.json({ data: [], note: "Drizzle migrations table not present yet." });
    }
  })
  /** Backups index (records only — actual dumping is adapter-specific). */
  .get("/backups", async (c) => {
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
  })
  /**
   * Run a manual backup. Inserts a tracking row, then dumps every system
   * table + the active tenant's c_* tables to JSONL via the storage adapter.
   * The dump runs inline (synchronously from the request's perspective) so
   * the UI shows immediate `done`/`failed` state without polling.
   */
  .post("/backups/now", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = z
      .object({ label: z.string().max(80).optional() })
      .parse(await c.req.json().catch(() => ({})));
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
  })
  /**
   * Stream the dump bytes back to the admin UI for download. We pull through
   * the storage adapter so this works whether the file lives on R2/S3/fs.
   */
  .get("/backups/:id/download", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = ctx.dialect === "pg" ? pg.schema.backups : sqlite.schema.backups;
    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.id, c.req.param("id")))
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
  });
