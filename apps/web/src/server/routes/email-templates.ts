import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull, or } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES, htmlToText, renderTemplate } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.emailTemplates : sqlite.schema.emailTemplates;

const EmailTemplateInput = z
  .object({
    key: z.string().min(2).max(40),
    name: z.string().min(1).max(80),
    subject: z.string().min(1).max(200),
    // Accept an empty string from the form's "From" field — it's normalized to
    // NULL on write. Without the literal("") branch the editor's blank input
    // fails `.email()` and the whole save 422s.
    fromAddress: z
      .union([z.string().email(), z.literal("")])
      .nullish()
      .openapi({ description: "Empty string or null clears the override." }),
    bodyHtml: z.string(),
    bodyText: z.string().nullish(),
    variables: z.array(z.string()).nullish(),
  })
  .openapi("EmailTemplateInput");

const EmailTemplateRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    key: z.string(),
    name: z.string(),
    subject: z.string(),
    fromAddress: z.string().nullable(),
    bodyHtml: z.string(),
    bodyText: z.string().nullable(),
    variables: z.array(z.string()).nullable(),
    updatedBy: z.string().nullable(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("EmailTemplateRow");

const SendTestInput = z
  .object({
    to: z.string().email().optional(),
    // Allow nested objects so callers can pass `{ user: { email: "…" } }`
    // matching the dotted-path placeholders in the template.
    vars: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("EmailTemplateSendTestInput");

/** Map an optional email field to a stored value: "" / null / undefined → null. */
const normAddr = (v: string | null | undefined) => (v ? v : null);

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

/** ID match scoped to the active workspace OR a global (tenantId NULL) row. */
const idScopedToTenant = (
  t: ReturnType<typeof tableFor>,
  id: string,
  tenantId: string,
) => and(eq(t.id, id), or(eq(t.tenantId, tenantId), isNull(t.tenantId)));

const tags = ["email-templates"];
const adminGate = [requireUser, requireAdmin];

export const emailTemplatesRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List email templates",
      description:
        "Returns tenant-scoped rows plus the global (`tenantId IS NULL`) defaults. Admin only.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(EmailTemplateRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      // List templates for the active tenant. Falls back to global (tenantId=null)
      // rows so an admin can see the platform-wide defaults alongside tenant
      // overrides.
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
      method: "get",
      path: "/{id}",
      tags,
      summary: "Get a single email template",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: EmailTemplateRow }) },
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
        .where(idScopedToTenant(t, id, tenantId))
        .limit(1);
      if (!rows[0]) throw new AppError("NOT_FOUND", "Template not found");
      return c.json({ data: rows[0] });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Create an email template",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: EmailTemplateInput } },
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
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const t = tableFor(ctx.dialect);
      const id = crypto.randomUUID();
      const row = {
        id,
        tenantId: auth.tenantId ?? null,
        key: body.key,
        name: body.name,
        subject: body.subject,
        fromAddress: normAddr(body.fromAddress),
        bodyHtml: body.bodyHtml,
        bodyText: body.bodyText ?? null,
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
      summary: "Update an email template",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: EmailTemplateInput.partial() } },
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
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const t = tableFor(ctx.dialect);
      // Only touch the columns the caller actually sent — a PATCH that updates
      // just the subject must not blank out from_address / variables.
      const set: Record<string, unknown> = {
        updatedBy: auth.userId,
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      };
      if (body.key !== undefined) set.key = body.key;
      if (body.name !== undefined) set.name = body.name;
      if (body.subject !== undefined) set.subject = body.subject;
      if (body.fromAddress !== undefined) set.fromAddress = normAddr(body.fromAddress);
      if (body.bodyHtml !== undefined) set.bodyHtml = body.bodyHtml;
      if (body.bodyText !== undefined) set.bodyText = body.bodyText ?? null;
      if (body.variables !== undefined) set.variables = body.variables ?? null;
      await (ctx.db as any)
        .update(t)
        .set(set)
        .where(idScopedToTenant(t, id, tenantId));
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete an email template",
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
        .where(idScopedToTenant(t, id, tenantId));
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/send-test",
      tags,
      summary: "Render + send the template as a test email",
      description:
        "Resolves the workspace email transport, renders the template with sample vars, and sends to `to` (defaults to the caller's email).",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: false,
          content: { "application/json": { schema: SendTestInput } },
        },
      },
      responses: {
        200: {
          description: "Sent",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      // Render the template with sample vars and ship it via the configured
      // email adapter. In dev (no Resend) the console adapter prints to stdout,
      // which is exactly what the design's "Send test" button promises.
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      // Body is optional — fall back to {} when the caller sends nothing.
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

      // Sample vars so the preview reads naturally even when the caller doesn't
      // supply their own. Shape mirrors what flow runs use at runtime.
      const defaults: Record<string, unknown> = {
        user: { email: auth.email ?? "user@example.com" },
        confirm_url: `${ctx.env.APP_URL}/verify?token=test`,
        reset_url: `${ctx.env.APP_URL}/reset?token=test`,
        magic_url: `${ctx.env.APP_URL}/magic?token=test`,
        site: { name: "backlex" },
      };
      const vars = { ...defaults, ...(body.vars ?? {}) };

      const html = renderTemplate(tpl.bodyHtml as string, vars);
      const text = tpl.bodyText
        ? renderTemplate(tpl.bodyText as string, vars)
        : htmlToText(html);
      const transport = await ctx.emailFor(tenantId);
      await transport.send({
        to: body.to ?? auth.email ?? "test@example.com",
        from: tpl.fromAddress ?? undefined,
        subject: renderTemplate(tpl.subject as string, vars),
        html,
        text,
      });
      return c.json({ ok: true });
    },
  );
