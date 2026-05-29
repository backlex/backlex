import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  findByName,
  invokeFunction,
  type FunctionRow,
} from "../services/functions";
import { logActivity } from "../services/activity";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.functions : sqlite.schema.functions;

const FunctionInput = z
  .object({
    name: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),
    trigger: z.enum(["http", "event", "cron"]),
    pattern: z.string().nullable().optional().openapi({
      description: "For `event`: dot-pattern (`items.*.created`). For `cron`: cron string.",
    }),
    code: z.string().min(1),
    timeoutMs: z.number().int().min(50).max(60_000).optional(),
    active: z.boolean().optional(),
  })
  .openapi("FunctionInput");

const FunctionRowSchema = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    name: z.string(),
    trigger: z.enum(["http", "event", "cron"]),
    pattern: z.string().nullable().optional(),
    code: z.string(),
    timeoutMs: z.number().int(),
    active: z.boolean(),
  })
  .openapi("FunctionRow");

const InvokeResult = z
  .object({
    ok: z.boolean(),
    logs: z.array(z.unknown()),
    error: z.string().optional(),
    durationMs: z.number().nonnegative(),
    result: z.unknown().optional(),
  })
  .openapi("FunctionInvokeResult");

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

const tags = ["functions"];
const adminGate = [requireUser, requireAdmin];

export const functionsRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "post",
      path: "/{name}/invoke",
      tags,
      summary: "Invoke function",
      description:
        "Admin-only. Invokes an `http`-triggered function with the request body as input. Sandbox load failures surface as a 500 with the sandbox's error message.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ name: z.string() }),
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z
                .record(z.string(), z.unknown())
                .openapi({ description: "Input passed to the function." }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Function ran successfully.",
          content: { "application/json": { schema: InvokeResult } },
        },
        500: {
          description: "Function returned an error.",
          content: { "application/json": { schema: InvokeResult } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      // Invoke must come before generic CRUD so non-admin users could in principle
      // call functions they're allowed to (but for v1 invoke is admin-only too).
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { name } = c.req.valid("param");
      const fn = await findByName(ctx, tenantId, name);
      if (!fn) throw new AppError("NOT_FOUND", "Function not found");
      if (fn.trigger !== "http") {
        throw new AppError("BAD_REQUEST", "Function trigger is not 'http'");
      }
      if (!fn.active) {
        throw new AppError("FORBIDDEN", "Function is inactive");
      }
      const body = await c.req.json().catch(() => ({}));
      const selfOrigin = new URL(c.req.url).origin;
      let result;
      try {
        result = await invokeFunction(
          fn as FunctionRow,
          { ctx, auth, selfOrigin },
          body,
        );
      } catch (err) {
        // Surface sandbox load failures (e.g. QuickJS-WASM unavailable in a
        // runtime with no variant) as a structured 500 with the sandbox's own
        // error message rather than leaking a stack trace into the global
        // error handler.
        result = {
          ok: false as const,
          logs: [],
          error: (err as Error).message ?? "Sandbox failed to start",
          durationMs: 0,
        };
      }
      await logActivity(c, {
        action: "invoke",
        collection: "system_functions",
        itemId: fn.name,
        payload: { ok: result.ok },
        response: result,
      });
      return c.json(result, result.ok ? 200 : 500);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List functions",
      description: "Admin-only. Lists every function in the active workspace.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(FunctionRowSchema) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const rows = await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.tenantId, tenantId));
      return c.json({ data: rows });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Create function",
      description: "Admin-only.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: FunctionInput } },
        },
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
        pattern: body.pattern ?? null,
        code: body.code,
        timeoutMs: body.timeoutMs ?? 5000,
        active: body.active ?? true,
      });
      const created = {
        id,
        ...body,
        timeoutMs: body.timeoutMs ?? 5000,
        active: body.active ?? true,
      };
      await logActivity(c, {
        action: "create",
        collection: "system_functions",
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
      summary: "Update function",
      description: "Admin-only. Partial update.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: FunctionInput.partial() } },
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
          ...(body.pattern !== undefined ? { pattern: body.pattern } : {}),
          ...(body.code !== undefined ? { code: body.code } : {}),
          ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(and(eq(t.id, id), eq(t.tenantId, tenantId)));
      await logActivity(c, {
        action: "update",
        collection: "system_functions",
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
      summary: "Delete function",
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
        collection: "system_functions",
        itemId: id,
        response: { ok: true },
      });
      return c.json({ ok: true });
    },
  );
