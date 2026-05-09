import { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull, or } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.emailTemplates : sqlite.schema.emailTemplates;

const Input = z.object({
  key: z.string().min(2).max(40),
  name: z.string().min(1).max(80),
  subject: z.string().min(1).max(200),
  fromAddress: z.string().email().optional(),
  bodyHtml: z.string(),
  bodyText: z.string().optional(),
  variables: z.array(z.string()).optional(),
});

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

const renderTemplate = (
  body: string,
  vars: Record<string, string>,
): string => body.replace(/{{\s*([\w.]+)\s*}}/g, (_, k: string) => vars[k] ?? "");

export const emailTemplatesRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  /**
   * List templates for the active tenant. Falls back to global (tenantId=null)
   * rows so an admin can see the platform-wide defaults alongside tenant
   * overrides.
   */
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
  .get("/:id", async (c) => {
    const ctx = c.get("ctx");
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.id, c.req.param("id")))
      .limit(1);
    if (!rows[0]) throw new AppError("NOT_FOUND", "Template not found");
    return c.json({ data: rows[0] });
  })
  .post("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = Input.parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    const id = crypto.randomUUID();
    await (ctx.db as any).insert(t).values({
      id,
      tenantId: auth.tenantId ?? null,
      key: body.key,
      name: body.name,
      subject: body.subject,
      fromAddress: body.fromAddress ?? null,
      bodyHtml: body.bodyHtml,
      bodyText: body.bodyText ?? null,
      variables: body.variables ?? null,
      updatedBy: auth.userId,
    });
    return c.json({ data: { id, ...body } }, 201);
  })
  .patch("/:id", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const id = c.req.param("id");
    const body = Input.partial().parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .update(t)
      .set({
        ...body,
        fromAddress: body.fromAddress ?? null,
        updatedBy: auth.userId,
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(eq(t.id, id));
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const t = tableFor(ctx.dialect);
    await (ctx.db as any).delete(t).where(eq(t.id, c.req.param("id")));
    return c.json({ ok: true });
  })
  /**
   * Render the template with sample vars and ship it via the configured
   * email adapter. In dev (no Resend) the console adapter prints to stdout,
   * which is exactly what the design's "Send test" button promises.
   */
  .post("/:id/send-test", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const id = c.req.param("id");
    const body = z
      .object({
        to: z.string().email().optional(),
        vars: z.record(z.string()).optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any).select().from(t).where(eq(t.id, id)).limit(1);
    const tpl = rows[0];
    if (!tpl) throw new AppError("NOT_FOUND", "Template not found");

    const defaults: Record<string, string> = {
      "user.email": auth.email ?? "user@example.com",
      "confirm_url": `${ctx.env.APP_URL}/verify?token=test`,
      "reset_url": `${ctx.env.APP_URL}/reset?token=test`,
      "magic_url": `${ctx.env.APP_URL}/magic?token=test`,
      "site.name": "workeros",
    };
    const vars = { ...defaults, ...(body.vars ?? {}) };

    const html = renderTemplate(tpl.bodyHtml as string, vars);
    const text = tpl.bodyText
      ? renderTemplate(tpl.bodyText as string, vars)
      : html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    await ctx.email.send({
      to: body.to ?? auth.email ?? "test@example.com",
      from: tpl.fromAddress ?? undefined,
      subject: renderTemplate(tpl.subject as string, vars),
      html,
      text,
    });
    return c.json({ ok: true });
  });
