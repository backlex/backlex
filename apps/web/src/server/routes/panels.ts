import { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.savedPanels : sqlite.schema.savedPanels;

const PanelInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  kind: z.enum(["sql", "items-aggregate", "static"]).default("sql"),
  sql: z.string().nullable().optional(),
  viz: z.enum(["sparkline", "bars", "donut", "counter", "table"]).default("sparkline"),
  config: z.record(z.unknown()).nullable().optional(),
  layout: z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      w: z.number().int().positive(),
      h: z.number().int().positive(),
    })
    .nullable()
    .optional(),
});

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

/**
 * Reject anything that isn't a single SELECT — protects the panel-run
 * endpoint from being abused as a generic SQL gateway. The Database page
 * has its own (more permissive but still gated) editor for that.
 */
const isReadOnly = (s: string): boolean => {
  const trimmed = s.trim().replace(/;$/, "");
  if (!/^select\b/i.test(trimmed)) return false;
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|attach|detach)\b/i.test(trimmed)) {
    return false;
  }
  return true;
};

const queryAll = async <T>(
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  q: ReturnType<typeof sql.raw>,
): Promise<T[]> => {
  if (ctx.dialect === "pg") {
    const r = await (ctx.db as any).execute(q);
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) return r.rows as T[];
    return r as T[];
  }
  return (await (ctx.db as any).all(q)) as T[];
};

export const panelsRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(or(eq(t.tenantId, auth.tenantId ?? ""), isNull(t.tenantId)));
    return c.json({ data: rows });
  })
  .post("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = PanelInput.parse(await c.req.json());
    if (body.kind === "sql" && body.sql && !isReadOnly(body.sql)) {
      throw new AppError("VALIDATION", "Panel SQL must be a single read-only SELECT.");
    }
    const t = tableFor(ctx.dialect);
    const id = crypto.randomUUID();
    await (ctx.db as any).insert(t).values({
      id,
      tenantId: auth.tenantId ?? null,
      name: body.name,
      description: body.description ?? null,
      kind: body.kind,
      sql: body.sql ?? null,
      viz: body.viz,
      config: body.config ?? null,
      layout: body.layout ?? null,
      createdBy: auth.userId,
    });
    return c.json({ data: { id, ...body } }, 201);
  })
  .patch("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const id = c.req.param("id");
    const body = PanelInput.partial().parse(await c.req.json());
    if (body.sql && !isReadOnly(body.sql)) {
      throw new AppError("VALIDATION", "Panel SQL must be a single read-only SELECT.");
    }
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .update(t)
      .set({
        ...body,
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      // Allow editing global (tenantId NULL) panels too — system-seeded
      // dashboards belong to no workspace but should still be editable by
      // admins; admin role is already required above.
      .where(
        and(
          eq(t.id, id),
          or(eq(t.tenantId, tenantId), isNull(t.tenantId)),
        ),
      );
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .delete(t)
      .where(
        and(
          eq(t.id, c.req.param("id")),
          or(eq(t.tenantId, tenantId), isNull(t.tenantId)),
        ),
      );
    return c.json({ ok: true });
  })
  /** Run a saved panel — useful when the dashboard renders a sparkline. */
  .post("/:id/run", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(
        and(
          eq(t.id, c.req.param("id")),
          or(eq(t.tenantId, tenantId), isNull(t.tenantId)),
        ),
      )
      .limit(1);
    const panel = rows[0];
    if (!panel) throw new AppError("NOT_FOUND", "Panel not found");
    if (panel.kind !== "sql" || !panel.sql) {
      return c.json({ data: [], note: "Non-SQL panel — return static config to the UI." });
    }
    if (!isReadOnly(panel.sql as string)) {
      throw new AppError("FORBIDDEN", "Panel SQL is not read-only.");
    }
    try {
      const t0 = Date.now();
      const out = await queryAll<Record<string, unknown>>(
        { db: ctx.db, dialect: ctx.dialect },
        sql.raw(panel.sql as string),
      );
      return c.json({ data: out, ms: Date.now() - t0 });
    } catch (e) {
      throw new AppError("VALIDATION", `SQL error: ${(e as Error).message}`);
    }
  });
