import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull, or } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES, renderTemplate } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { sendPushToUsers } from "../services/push";
import { defaultHook } from "../lib/openapi-router";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.pushTemplates : sqlite.schema.pushTemplates;

const PushTemplateInput = z
  .object({
    key: z.string().min(2).max(40),
    name: z.string().min(1).max(80),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(1000),
    url: z.union([z.string(), z.literal("")]).nullish(),
    variables: z.array(z.string()).nullish(),
  })
  .openapi("PushTemplateInput");

const PushTemplateRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    key: z.string(),
    name: z.string(),
    title: z.string(),
    body: z.string(),
    url: z.string().nullable(),
    variables: z.array(z.string()).nullable(),
    updatedBy: z.string().nullable(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("PushTemplateRow");

const SendTestInput = z
  .object({ vars: z.record(z.string(), z.unknown()).optional() })
  .openapi("PushTemplateSendTestInput");

const norm = (v: string | null | undefined) => (v ? v : null);

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

const idScopedToTenant = (t: ReturnType<typeof tableFor>, id: string, tenantId: string) =>
  and(eq(t.id, id), or(eq(t.tenantId, tenantId), isNull(t.tenantId)));

const tags = ["push-templates"];
const adminGate = [requireUser, requireAdmin];

export const pushTemplatesRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List push templates",
      description: "Tenant-scoped rows plus global (`tenantId IS NULL`) defaults. Admin only.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.array(PushTemplateRow) }) } },
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
      tags,
      summary: "Create a push template",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { required: true, content: { "application/json": { schema: PushTemplateInput } } },
      },
      responses: {
        201: { description: "Created", content: { "application/json": { schema: z.any() } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const t = tableFor(ctx.dialect);
      const id = crypto.randomUUID();
      const row = {
        id,
        tenantId: auth.tenantId ?? null,
        key: body.key,
        name: body.name,
        title: body.title,
        body: body.body,
        url: norm(body.url),
        variables: body.variables ?? null,
      };
      await (ctx.db as any).insert(t).values({ ...row, updatedBy: auth.userId });
      return c.json({ data: row }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags,
      summary: "Update a push template",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: PushTemplateInput.partial() } },
        },
      },
      responses: {
        200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const t = tableFor(ctx.dialect);
      const set: Record<string, unknown> = {
        updatedBy: auth.userId,
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      };
      if (body.key !== undefined) set.key = body.key;
      if (body.name !== undefined) set.name = body.name;
      if (body.title !== undefined) set.title = body.title;
      if (body.body !== undefined) set.body = body.body;
      if (body.url !== undefined) set.url = norm(body.url);
      if (body.variables !== undefined) set.variables = body.variables ?? null;
      await (ctx.db as any).update(t).set(set).where(idScopedToTenant(t, id, tenantId));
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete a push template",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      await (ctx.db as any).delete(t).where(idScopedToTenant(t, id, tenantId));
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/send-test",
      tags,
      summary: "Render + send the template to the caller's own devices",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: { required: false, content: { "application/json": { schema: SendTestInput } } },
      },
      responses: {
        200: {
          description: "Sent",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean(), sent: z.number(), failed: z.number() }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      if (!auth.userId) throw new AppError("VALIDATION", "No caller to send to");
      const body = await c.req
        .json()
        .then((b) => SendTestInput.parse(b ?? {}))
        .catch(() => SendTestInput.parse({}));
      const t = tableFor(ctx.dialect);
      const rows = await (ctx.db as any)
        .select()
        .from(t)
        .where(idScopedToTenant(t, id, tenantId))
        .limit(1);
      const tpl = rows[0];
      if (!tpl) throw new AppError("NOT_FOUND", "Template not found");

      const vars = { user: { email: auth.email ?? "user@example.com" }, ...(body.vars ?? {}) };
      const result = await sendPushToUsers(ctx, tenantId, {
        userIds: [auth.userId],
        title: renderTemplate(tpl.title as string, vars),
        body: renderTemplate(tpl.body as string, vars),
        url: tpl.url ? renderTemplate(tpl.url as string, vars) : undefined,
      });
      if (result.sent === 0 && result.failed === 0) {
        throw new AppError(
          "VALIDATION",
          "No active devices registered for your account — register one first.",
        );
      }
      return c.json({ ok: true, sent: result.sent, failed: result.failed });
    },
  );
