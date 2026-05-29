/**
 * Admin-only collection-adoption *helpers*. The actual adopt write is now
 * handled by the unified `POST /api/collections` (with `adopted: true`);
 * this route keeps the discovery + introspection endpoints that the admin
 * wizard needs before it can build the create payload.
 *
 *   - `GET  /tables`  — list adopt-eligible tables in the active DB.
 *   - `POST /inspect` — introspect a single table (columns, PK, FKs).
 *
 * Mounted at `/api/admin/adopt` from `app.ts`.
 */
import { Hono } from "hono";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { inspectTable, listAdoptableTables } from "../services/adopt";

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

export const adoptRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    const auth = c.get("auth");
    if (!auth.tenantId) {
      throw new AppError("VALIDATION", "Active workspace required for collection adoption");
    }
    await next();
  })
  /**
   * List every physical table in the active database that is eligible for
   * adoption — i.e. not a managed `c_*` collection, not a workeros system
   * table, and not already adopted by this workspace.
   */
  .get("/tables", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    // Anything this workspace has already adopted is hidden — we don't
    // include cross-tenant adoptions because two workspaces in the same
    // physical DB sharing a table is a deliberate (admin-driven) action.
    const already = await (ctx.db as any)
      .select({ physicalTable: t.physicalTable, adopted: t.adopted })
      .from(t)
      .where(and(eq(t.tenantId, auth.tenantId!), eq(t.adopted, true)));
    const excluded = new Set<string>(
      (already as { physicalTable: string | null }[])
        .map((r) => r.physicalTable)
        .filter((n): n is string => Boolean(n)),
    );
    const data = await listAdoptableTables(
      { db: ctx.db, dialect: ctx.dialect },
      excluded,
    );
    return c.json({ data });
  })
  /**
   * Introspect a single physical table. Returns column shape + PK info +
   * which workeros system columns happen to already exist on the table
   * (we don't add or rename — admins read the inspection result, then
   * pass back the matching flags to `POST /api/collections`).
   */
  .post("/inspect", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = z
      .object({ table: z.string().min(1).max(120) })
      .parse(await c.req.json());
    try {
      const data = await inspectTable(
        { db: ctx.db, dialect: ctx.dialect },
        body.table,
      );
      // Per-FK target collection lookup. Service layer doesn't know about
      // the request's tenant; we resolve here so the wizard can pre-fill
      // the relation dropdown with the matching slug. One SELECT covers
      // all FKs on the table (collections is a small metadata table).
      if (data.foreignKeys.length > 0 && auth.tenantId) {
        const t = tableFor(ctx.dialect);
        const parentTables = [...new Set(data.foreignKeys.map((fk) => fk.referencesTable))];
        const rows: { id: string; slug: string; physicalTable: string }[] = await (ctx.db as any)
          .select({ id: t.id, slug: t.slug, physicalTable: t.physicalTable })
          .from(t)
          .where(and(eq(t.tenantId, auth.tenantId), inArray(t.physicalTable, parentTables)));
        const byPhys = new Map(rows.map((r) => [r.physicalTable, { slug: r.slug, id: r.id }]));
        for (const fk of data.foreignKeys) {
          const hit = byPhys.get(fk.referencesTable);
          if (hit) fk.targetCollection = hit;
        }
      }
      return c.json({ data });
    } catch (e) {
      const msg = (e as Error).message;
      if (/not found/i.test(msg)) throw new AppError("NOT_FOUND", msg);
      throw new AppError("VALIDATION", msg);
    }
  });
