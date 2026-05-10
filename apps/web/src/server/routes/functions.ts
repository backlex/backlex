import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import {
  findByName,
  invokeFunction,
  type FunctionRow,
} from "../services/functions";
import { logActivity } from "../services/activity";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.functions : sqlite.schema.functions;

const Input = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),
  trigger: z.enum(["http", "event", "cron"]),
  pattern: z.string().nullable().optional(),
  code: z.string().min(1),
  timeoutMs: z.number().int().min(50).max(60_000).optional(),
  active: z.boolean().optional(),
});

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
};

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

export const functionsRoutes = new Hono<AppBindings>()
  // Invoke must come before the admin gate so non-admin users can call functions
  // they're allowed to (but for v1 invoke is admin-only too — defer per-function ACL).
  .post("/:name/invoke", requireUser, async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    requireAdmin(auth);
    const tenantId = requireTenant(c);
    const fn = await findByName(ctx, tenantId, c.req.param("name"));
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
      // Surface sandbox load failures (e.g. QuickJS-WASM unavailable in CF
      // Workers without FUNCTIONS_DISPATCH) as a structured 500 with the
      // sandbox's own error message rather than leaking a stack trace into
      // the global error handler.
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
    });
    return c.json(result, result.ok ? 200 : 500);
  })
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.tenantId, tenantId));
    return c.json({ data: rows });
  })
  .post("/", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const body = Input.parse(await c.req.json());
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
    await logActivity(c, { action: "create", collection: "system_functions", itemId: id, payload: { name: body.name, trigger: body.trigger } });
    return c.json(
      {
        data: {
          id,
          ...body,
          timeoutMs: body.timeoutMs ?? 5000,
          active: body.active ?? true,
        },
      },
      201,
    );
  })
  .patch("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const body = Input.partial().parse(await c.req.json());
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
      .where(and(eq(t.id, c.req.param("id")), eq(t.tenantId, tenantId)));
    await logActivity(c, { action: "update", collection: "system_functions", itemId: c.req.param("id"), payload: body });
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .delete(t)
      .where(and(eq(t.id, c.req.param("id")), eq(t.tenantId, tenantId)));
    await logActivity(c, { action: "delete", collection: "system_functions", itemId: c.req.param("id") });
    return c.json({ ok: true });
  });
