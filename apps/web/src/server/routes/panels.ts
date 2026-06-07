import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  ITEMS_AGG_FUNCS,
  ItemsAggregateConfig,
  runItemsAggregate,
} from "../services/items/aggregate";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.savedPanels : sqlite.schema.savedPanels;

const PanelInput = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).nullable().optional(),
    kind: z.enum(["sql", "items-aggregate", "static"]).default("sql"),
    sql: z.string().nullable().optional(),
    viz: z.enum(["sparkline", "bars", "donut", "counter", "table"]).default("sparkline"),
    config: z.record(z.string(), z.unknown()).nullable().optional(),
    layout: z
      .object({
        x: z.number().int(),
        y: z.number().int(),
        w: z.number().int().positive(),
        h: z.number().int().positive(),
      })
      .nullable()
      .optional(),
  })
  .openapi("PanelInput");

const PanelRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    kind: z.string(),
    sql: z.string().nullable(),
    viz: z.string(),
    config: z.unknown().nullable(),
    layout: z.unknown().nullable(),
    createdBy: z.string().nullable(),
    createdAt: z.unknown().nullable(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("Panel");

const PreviewInput = z
  .object({
    kind: z.enum(["sql", "items-aggregate"]),
    sql: z.string().optional(),
    config: z.unknown().optional(),
  })
  .openapi("PanelPreviewInput");

const PanelResult = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
  ms: z.number().int().nonnegative(),
  note: z.string().optional(),
});

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  await next();
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

const TAGS = ["panels"];
const ADMIN_GATE = [requireUser, requireAdminMiddleware];

export const panelsRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: TAGS,
      summary: "List panels",
      description:
        "Saved panels for the active workspace plus the system-global (`tenantId IS NULL`) ones.",
      security: SECURITY,
      middleware: ADMIN_GATE,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(PanelRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const t = tableFor(ctx.dialect);
      const rows = await (ctx.db as any)
        .select()
        .from(t)
        .where(or(eq(t.tenantId, auth.tenantId ?? ""), isNull(t.tenantId)));
      return c.json({ data: rows });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: TAGS,
      summary: "Create panel",
      description: "SQL panels must contain a single read-only SELECT.",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: {
        body: { required: true, content: { "application/json": { schema: PanelInput } } },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": { schema: z.any() },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = c.req.valid("json");
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
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: TAGS,
      summary: "Update panel",
      description: "Partial update.",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: PanelInput.partial() } },
        },
      },
      responses: {
        200: {
          description: "Updated",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
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
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: TAGS,
      summary: "Delete panel",
      description: "Idempotent.",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const t = tableFor(ctx.dialect);
      await (ctx.db as any)
        .delete(t)
        .where(
          and(
            eq(t.id, id),
            or(eq(t.tenantId, tenantId), isNull(t.tenantId)),
          ),
        );
      return c.json({ ok: true });
    },
  )
  /** Run an in-progress panel without saving it. The editor uses this for the
   *  "Run preview" button so authors can verify their query (or aggregate
   *  config) before committing the row. Same security gates as the saved-run
   *  endpoint — admin-only, SELECT-only for SQL, tenant-scoped for items. */
  .openapi(
    createRoute({
      method: "post",
      path: "/preview",
      tags: TAGS,
      summary: "Preview an unsaved panel",
      description:
        "Runs the panel without persisting. Same security gates as the saved-run endpoint.",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: {
        body: { required: true, content: { "application/json": { schema: PreviewInput } } },
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: PanelResult } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json") as { kind?: string; sql?: string; config?: unknown };
      if (body.kind === "items-aggregate") {
        const t0 = Date.now();
        const out = await runItemsAggregate(ctx, auth, tenantId, body.config);
        return c.json({ data: out, ms: Date.now() - t0 });
      }
      if (body.kind !== "sql" || !body.sql) {
        throw new AppError(
          "VALIDATION",
          `Preview only supports kind "sql" or "items-aggregate" (got "${body.kind ?? "unknown"}")`,
        );
      }
      if (!isReadOnly(body.sql)) {
        throw new AppError("FORBIDDEN", "Panel SQL is not read-only.");
      }
      try {
        const t0 = Date.now();
        const out = await queryAll<Record<string, unknown>>(
          { db: ctx.db, dialect: ctx.dialect },
          sql.raw(body.sql),
        );
        return c.json({ data: out, ms: Date.now() - t0 });
      } catch (e) {
        throw new AppError("VALIDATION", `SQL error: ${(e as Error).message}`);
      }
    },
  )
  /** Run a saved panel — useful when the dashboard renders a sparkline. */
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/run",
      tags: TAGS,
      summary: "Run a saved panel",
      description:
        "Executes the saved query/aggregate config. Non-SQL panels return static config.",
      security: SECURITY,
      middleware: ADMIN_GATE,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.any() } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const t = tableFor(ctx.dialect);
      const rows = await (ctx.db as any)
        .select()
        .from(t)
        .where(
          and(
            eq(t.id, id),
            or(eq(t.tenantId, tenantId), isNull(t.tenantId)),
          ),
        )
        .limit(1);
      const panel = rows[0];
      if (!panel) throw new AppError("NOT_FOUND", "Panel not found");

      if (panel.kind === "items-aggregate") {
        const t0 = Date.now();
        const out = await runItemsAggregate(ctx, auth, tenantId, panel.config);
        return c.json({ data: out, ms: Date.now() - t0 });
      }

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
    },
  );
