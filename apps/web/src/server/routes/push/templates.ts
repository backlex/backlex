import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../../app";
import type { Ctx } from "../../context";
import { requireUser } from "../../middleware/session";
import { SECURITY, errorResponses } from "../../lib/openapi";
import { sendTemplatedPush } from "../../services/messaging/push";
import { defaultHook } from "../../lib/openapi-router";

// Overrides resolve the way `email_templates` do: a workspace row shadows the
// instance-wide (`tenant_id IS NULL`) row with the same key, and a workspace
// never writes the shared row. PATCH and DELETE used to reach that row by id,
// so one workspace's edit would have rewritten every workspace's push. Nothing
// seeds a shared push template yet — the scope was wrong with nothing behind
// it, which is exactly how the email twin sat until defaults were seeded.

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
    updatedBy: z.string().nullable().optional(),
    updatedAt: z.unknown().nullable().optional(),
    inherited: z.boolean().openapi({ description: "Instance-wide default. Saving it writes the workspace's copy." }),
    overridesDefault: z.boolean().openapi({ description: "Shadows an instance-wide default; deleting restores it." }),
  })
  .openapi("PushTemplateRow");

const SendTestInput = z
  .object({ vars: z.record(z.string(), z.unknown()).optional() })
  .openapi("PushTemplateSendTestInput");

type Row = Omit<z.infer<typeof PushTemplateRow>, "inherited" | "overridesDefault">;

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

/** A READ scope: the workspace's own row or a shared one. Never a write `where`. */
const idVisibleToTenant = (t: ReturnType<typeof tableFor>, id: string, tenantId: string) =>
  and(eq(t.id, id), or(eq(t.tenantId, tenantId), isNull(t.tenantId)));

const findVisible = async (ctx: Ctx, id: string, tenantId: string): Promise<Row | null> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(idVisibleToTenant(t, id, tenantId))
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
  inherited: row.tenantId === null,
  overridesDefault: row.tenantId !== null && sharedExists,
});

const tags = ["push-templates"];
const adminGate = [requireUser, requireAdmin];

export const pushTemplatesRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List push templates",
      description: "One row per key: the workspace's own, else the instance-wide default. Admin only.",
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
      const rows = (await (ctx.db as any)
        .select()
        .from(t)
        .where(or(eq(t.tenantId, auth.tenantId ?? ""), isNull(t.tenantId)))
        .orderBy(asc(t.key))) as Row[];
      // Both halves of an override would list, and the flow builder's picker
      // would offer the key twice.
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
      method: "post",
      path: "/",
      tags,
      summary: "Create a push template",
      description: "Under a key with an instance-wide default this is the workspace's override; a key it already has is a 409.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { required: true, content: { "application/json": { schema: PushTemplateInput } } },
      },
      responses: {
        201: { description: "Created", content: { "application/json": { schema: z.object({ data: PushTemplateRow }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      // Stamped from the active workspace, never `?? null`: a create with no
      // workspace in scope would otherwise mint a shared row.
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const t = tableFor(ctx.dialect);
      const row: Row = {
        id: crypto.randomUUID(),
        tenantId,
        key: body.key,
        name: body.name,
        title: body.title,
        body: body.body,
        url: norm(body.url),
        variables: body.variables ?? null,
      };
      await (ctx.db as any).insert(t).values({ ...row, updatedBy: auth.userId });
      return c.json({ data: flagged(row, (await findShared(ctx, row.key)) !== null) }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags,
      summary: "Update a push template",
      description: "On an instance-wide default this writes (and returns) the workspace's copy — read `data.id` back.",
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
        200: {
          description: "Updated",
          content: {
            "application/json": { schema: z.object({ ok: z.boolean(), data: PushTemplateRow }) },
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
            title: row.title,
            body: row.body,
            url: row.url,
            variables: row.variables,
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
      summary: "Delete a push template",
      description: "Returns what the key resolves to now (the default it overrode, or null). Defaults are a 403.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Deleted",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean(), data: PushTemplateRow.nullable() }),
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
      const tpl = await findVisible(ctx, id, tenantId);
      if (!tpl) throw new AppError("NOT_FOUND", "Template not found");

      const vars = { user: { email: auth.email ?? "user@example.com" }, ...(body.vars ?? {}) };
      // Renders through `sendTemplatedPush` by key rather than rendering the
      // row it just read: the whole point of this endpoint is answering "what
      // will the real send look like", and it can only answer that by BEING
      // the real send. Rendering here is how the preview and the send were two
      // different code paths for as long as one of them did not exist.
      const result = await sendTemplatedPush(ctx, tenantId, {
        userIds: [auth.userId],
        templateKey: tpl.key as string,
        vars,
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
