import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import {
  AppError,
  EMAIL_TEMPLATE_KEY_PATTERN,
  SYSTEM_ROLES,
  htmlToText,
  renderTemplate,
} from "@backlex/core";
import { normalizeAppearance, withThemeVars, type Appearance } from "@backlex/core/appearance";
import { applyShell } from "@backlex/core/template-shell";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../../app";
import type { Ctx } from "../../context";
import { requireUser } from "../../middleware/session";
import { assertNotDemo } from "../../services/demo";
import { SECURITY, OkSchema, errorResponses } from "../../lib/openapi";
import { defaultHook } from "../../lib/openapi-router";
import { AppearanceSchema } from "../../lib/appearance-schema";

// Overrides resolve like `document_templates`: a workspace row shadows the
// instance-wide (`tenant_id IS NULL`) row with the same key, and a workspace
// never writes the shared row. PATCH and DELETE used to reach it by id, so one
// workspace's edit rewrote every workspace's mail (and a delete lasted until
// the next boot re-seeded it).

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.emailTemplates : sqlite.schema.emailTemplates;

const EmailTemplateInput = z
  .object({
    key: z.string().regex(EMAIL_TEMPLATE_KEY_PATTERN, "2–40 of A-Z a-z 0-9 _ - ., starting alphanumeric"),
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
    bodyText: z.string().nullish().openapi({ description: "Null derives the text part from `bodyHtml`." }),
    variables: z.array(z.string()).nullish(),
    appearance: AppearanceSchema.nullish(),
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
    appearance: AppearanceSchema.nullable(),
    updatedBy: z.string().nullable().optional(),
    updatedAt: z.unknown().nullable().optional(),
    inherited: z.boolean().openapi({ description: "Instance-wide default. Saving it writes the workspace's copy." }),
    overridesDefault: z.boolean().openapi({ description: "Shadows an instance-wide default; deleting restores it." }),
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

const SendDraftTestInput = SendTestInput.extend({
  subject: z.string().min(1).max(200),
  bodyHtml: z.string().min(1),
  bodyText: z.string().nullish(),
  fromAddress: z.union([z.string().email(), z.literal("")]).nullish(),
  appearance: AppearanceSchema.nullish(),
}).openapi("EmailTemplateSendDraftTestInput");

type Row = Omit<z.infer<typeof EmailTemplateRow>, "inherited" | "overridesDefault">;

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

const findVisible = async (ctx: Ctx, id: string, tenantId: string): Promise<Row | null> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(idScopedToTenant(t, id, tenantId))
    .limit(1)) as Row[];
  return rows[0] ?? null;
};

const findShared = async (ctx: Ctx, key: string): Promise<Row | null> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.key, key), isNull(t.tenantId)))
    .limit(1)) as Row[];
  return rows[0] ?? null;
};

const findOwnByKey = async (ctx: Ctx, key: string, tenantId: string): Promise<Row | null> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.key, key), eq(t.tenantId, tenantId)))
    .limit(1)) as Row[];
  return rows[0] ?? null;
};

const flagged = (row: Row, sharedExists: boolean) => ({
  ...row,
  // Read back through the same filter the renderer uses, so the API never
  // returns an appearance the mailer would not honour.
  appearance: normalizeAppearance(row.appearance),
  inherited: row.tenantId === null,
  overridesDefault: row.tenantId !== null && sharedExists,
});

const sendRendered = async (
  ctx: Ctx,
  tenantId: string,
  tpl: {
    subject: string;
    bodyHtml: string;
    bodyText?: string | null;
    fromAddress?: string | null;
    appearance?: Appearance | Record<string, unknown> | null;
  },
  rawVars: Record<string, unknown>,
  to: string,
) => {
  // Both send-test routes end here, and together they are a mail relay: any
  // subject and body, to any address, from the workspace's own sender. The
  // playground publishes its admin credentials, and its write guard is a prefix
  // list that blocks `/api/admin/email-config` but not these — so the refusal
  // travels with the send, the way `assertNotDemo` does for GraphQL.
  assertNotDemo(ctx.env);
  // `theme.*` exactly as `sendTemplatedEmail` fills it, and the same shell
  // around the result, so a test mail matches what a real recipient of the
  // saved template gets — including the text part, taken before the wrap.
  const appearance = normalizeAppearance(tpl.appearance);
  const vars = withThemeVars(rawVars, appearance);
  const body = renderTemplate(tpl.bodyHtml, vars);
  const text = tpl.bodyText ? renderTemplate(tpl.bodyText, vars) : htmlToText(body);
  const html = applyShell(body, appearance, "email");
  const transport = await ctx.emailFor(tenantId);
  await transport.send({
    to,
    from: tpl.fromAddress || undefined,
    subject: renderTemplate(tpl.subject, vars),
    html,
    text,
  });
};

const tags = ["email-templates"];
const adminGate = [requireUser, requireAdmin];
const rowResponse = {
  description: "OK",
  content: { "application/json": { schema: z.object({ data: EmailTemplateRow }) } },
};

export const emailTemplatesRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List email templates",
      description: "One row per key: the workspace's own, else the instance-wide default. Admin only.",
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
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const t = tableFor(ctx.dialect);
      const rows = (await (ctx.db as any)
        .select()
        .from(t)
        .where(or(eq(t.tenantId, auth.tenantId ?? ""), isNull(t.tenantId)))
        .orderBy(asc(t.key))) as Row[];
      // Both halves of an override used to list, and pickers offered the key twice.
      const shared = new Set(rows.filter((r) => r.tenantId === null).map((r) => r.key));
      const byKey = new Map<string, Row>();
      for (const row of rows) {
        const seen = byKey.get(row.key);
        if (!seen || (seen.tenantId === null && row.tenantId !== null)) byKey.set(row.key, row);
      }
      return c.json({ data: [...byKey.values()].map((r) => flagged(r, shared.has(r.key))) });
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
      responses: { 200: rowResponse, ...errorResponses },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const row = await findVisible(ctx, c.req.valid("param").id, tenantId);
      if (!row) throw new AppError("NOT_FOUND", "Template not found");
      const sharedExists = row.tenantId !== null && (await findShared(ctx, row.key)) !== null;
      return c.json({ data: flagged(row, sharedExists) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Create an email template",
      description: "Under a key with an instance-wide default this is the workspace's override; a key it already has is a 409.",
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
        appearance: normalizeAppearance(body.appearance),
      };
      await (ctx.db as any).insert(t).values({ ...row, updatedBy: auth.userId });
      const sharedExists = row.tenantId !== null && (await findShared(ctx, row.key)) !== null;
      return c.json({ data: flagged(row, sharedExists) }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags,
      summary: "Update an email template",
      description: "On an instance-wide default this writes (and returns) the workspace's copy — read `data.id` back.",
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
          content: {
            "application/json": { schema: z.object({ ok: z.boolean(), data: EmailTemplateRow }) },
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
      const body = c.req.valid("json");
      const t = tableFor(ctx.dialect);
      const row = await findVisible(ctx, id, tenantId);
      if (!row) throw new AppError("NOT_FOUND", "Template not found");
      if (row.tenantId === null && body.key !== undefined && body.key !== row.key) {
        throw new AppError("VALIDATION", `"${row.key}" is a shared default, so its key cannot change`);
      }
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
      if (body.appearance !== undefined) set.appearance = normalizeAppearance(body.appearance);

      let targetId = row.id;
      if (row.tenantId === null) {
        // Copy-on-write. A stale tab still holding the default's id saves into
        // the existing copy rather than hitting the (tenant_id, key) index.
        const { key: _unchanged, ...patch } = set;
        const own = await findOwnByKey(ctx, row.key, tenantId);
        if (own) {
          targetId = own.id;
          await (ctx.db as any)
            .update(t)
            .set(patch)
            .where(and(eq(t.id, own.id), eq(t.tenantId, tenantId)));
        } else {
          targetId = crypto.randomUUID();
          await (ctx.db as any).insert(t).values({
            id: targetId,
            tenantId,
            key: row.key,
            name: row.name,
            subject: row.subject,
            fromAddress: row.fromAddress,
            bodyHtml: row.bodyHtml,
            bodyText: row.bodyText,
            variables: row.variables,
            appearance: row.appearance,
            ...patch,
          });
        }
      } else {
        await (ctx.db as any)
          .update(t)
          .set(set)
          .where(and(eq(t.id, row.id), eq(t.tenantId, tenantId)));
      }
      const saved = await findVisible(ctx, targetId, tenantId);
      if (!saved) throw new AppError("NOT_FOUND", "Template not found");
      return c.json({ ok: true, data: flagged(saved, (await findShared(ctx, saved.key)) !== null) });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete an email template",
      description: "Returns what the key resolves to now (the default it overrode, or null). Defaults are a 403.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Deleted",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean(), data: EmailTemplateRow.nullable() }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const row = await findVisible(ctx, c.req.valid("param").id, tenantId);
      if (!row) throw new AppError("NOT_FOUND", "Template not found");
      if (row.tenantId === null) {
        throw new AppError("FORBIDDEN", `"${row.key}" is a shared default and cannot be deleted from a workspace`);
      }
      await (ctx.db as any).delete(t).where(and(eq(t.id, row.id), eq(t.tenantId, tenantId)));
      const fallback = await findShared(ctx, row.key);
      return c.json({ ok: true, data: fallback ? flagged(fallback, true) : null });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/send-test",
      tags,
      summary: "Render + send an unsaved template as a test email",
      description: "Renders the draft with exactly `vars` (so it matches the editor preview) and mails `to`, default the caller. Stores nothing.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: SendDraftTestInput } },
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
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      await sendRendered(
        ctx,
        tenantId,
        { ...body, fromAddress: normAddr(body.fromAddress) },
        body.vars ?? {},
        body.to ?? auth.email ?? "test@example.com",
      );
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
      const tpl = await findVisible(ctx, id, tenantId);
      if (!tpl) throw new AppError("NOT_FOUND", "Template not found");

      // Sample vars so the test reads naturally even when the caller doesn't
      // supply their own; anything the caller passes wins.
      const defaults: Record<string, unknown> = {
        user: { email: auth.email ?? "user@example.com" },
        site: { name: "backlex" },
      };
      await sendRendered(
        ctx,
        tenantId,
        tpl,
        { ...defaults, ...(body.vars ?? {}) },
        body.to ?? auth.email ?? "test@example.com",
      );
      return c.json({ ok: true });
    },
  );
