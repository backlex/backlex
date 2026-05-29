import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { AppError, OperationsSchema, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { runFlowById } from "../services/flows";
import { logActivity } from "../services/activity";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.flows : sqlite.schema.flows;

const FlowInput = z
  .object({
    name: z.string().min(1),
    trigger: z.string().min(1).openapi({
      description: "Trigger key (`event:items.created`, `cron`, `manual`, etc.).",
    }),
    operations: OperationsSchema,
    layout: z.unknown().optional().openapi({
      description: "Builder graph snapshot — purely presentational.",
    }),
    active: z.boolean().optional(),
  })
  .openapi("FlowInput");

const FlowRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    name: z.string(),
    trigger: z.string(),
    operations: z.unknown(),
    layout: z.unknown().nullable().optional(),
    active: z.boolean(),
  })
  .openapi("FlowRow");

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const tags = ["flows"];
const adminGate = [requireUser, requireAdmin];

export const flowsRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List flows",
      description: "Admin-only. Lists every flow in the active workspace.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(FlowRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const rows = await (ctx.db as any).select().from(t).where(eq(t.tenantId, tenantId));
      return c.json({ data: rows });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags,
      summary: "Get flow",
      description: "Admin-only. Fetches a single flow by id.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: FlowRow }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      const rows = await (ctx.db as any)
        .select()
        .from(t)
        .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
        .limit(1);
      if (!rows[0]) throw new AppError("NOT_FOUND", "Flow not found");
      return c.json({ data: rows[0] });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Create flow",
      description: "Admin-only. Creates a flow scoped to the active workspace.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { required: true, content: { "application/json": { schema: FlowInput } } },
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
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const t = tableFor(ctx.dialect);
      const id = crypto.randomUUID();
      await (ctx.db as any).insert(t).values({
        id,
        tenantId,
        name: body.name,
        trigger: body.trigger,
        operations: body.operations,
        layout: body.layout ?? null,
        active: body.active ?? true,
      });
      const created = { id, ...body, active: body.active ?? true };
      await logActivity(c, {
        action: "create",
        collection: "system_flows",
        itemId: id,
        payload: { name: body.name, trigger: body.trigger },
        response: { data: created },
      });
      return c.json({ data: created }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags,
      summary: "Update flow",
      description: "Admin-only. Partial update.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: FlowInput.partial() } },
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
      const body = c.req.valid("json");
      const { id } = c.req.valid("param");
      const t = tableFor(ctx.dialect);
      await (ctx.db as any)
        .update(t)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
          ...(body.operations !== undefined ? { operations: body.operations } : {}),
          ...(body.layout !== undefined ? { layout: body.layout } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
      await logActivity(c, {
        action: "update",
        collection: "system_flows",
        itemId: id,
        payload: body,
        response: { ok: true },
      });
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete flow",
      description: "Admin-only.",
      security: SECURITY,
      middleware: adminGate,
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
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      await (ctx.db as any)
        .delete(t)
        .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
      await logActivity(c, {
        action: "delete",
        collection: "system_flows",
        itemId: id,
        response: { ok: true },
      });
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/run",
      tags,
      summary: "Manually run flow",
      description:
        "Admin-only. Synchronously executes the flow with an arbitrary input payload. Records a `flow.run` activity row.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z
                .record(z.string(), z.unknown())
                .openapi({ description: "Arbitrary input payload." }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean(),
                error: z.string().optional(),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      // Manual trigger — admin invokes a flow with an arbitrary input payload.
      // Any flow type can be run this way; cron + event flows are independently
      // dispatched, so this is purely on-demand.
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      // Verify the flow belongs to the active workspace before running —
      // runFlowById doesn't tenant-check on its own.
      const t = tableFor(ctx.dialect);
      const own = await (ctx.db as any)
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.id, id), eq(t.tenantId, tenantId)))
        .limit(1);
      if (!own[0]) throw new AppError("NOT_FOUND", "Flow not found");
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      // runFlowById records its own `flow.run` activity row (so cron- and
      // webhook-triggered runs are logged too), including the failure message
      // in payload.error — don't double-log here.
      const result = await runFlowById(ctx, id, body, {
        userId: auth.userId,
        email: auth.email,
        roles: auth.roles,
      });
      return c.json({ ok: result.ok, error: result.error ?? undefined });
    },
  );
