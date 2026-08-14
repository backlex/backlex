import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { parsePagination } from "../lib/pagination";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { sendPushToUsers } from "../services/push";
import { defaultHook } from "../lib/openapi-router";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.notifications : sqlite.schema.notifications;

/** Notifications — including broadcasts (`user_id NULL`) — are workspace-scoped.
 *  Every read/update pins `tenant_id` so a broadcast created in tenant A is not
 *  visible to (or markable by) a user acting in tenant B. */
const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId ?? null;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const NotificationInput = z
  .object({
    title: z.string().min(1),
    body: z.string().optional(),
    url: z.string().optional(),
    userId: z.string().nullable().optional().openapi({
      description:
        "Target user. Omitting it (or sending null) targets the CALLER — the handler falls back to the calling identity, so this endpoint cannot produce a workspace-wide broadcast. Broadcast rows (userId null) are written by flows and are readable by everyone; this said it created them, and it never did.",
    }),
    push: z.boolean().optional().openapi({
      description: "Also fan out to the target user's push devices (ignored for broadcasts).",
    }),
  })
  .openapi("NotificationInput");

const NotificationRow = z
  .object({
    id: z.string(),
    userId: z.string().nullable(),
    title: z.string(),
    body: z.string().nullable(),
    url: z.string().nullable(),
    flowId: z.string().nullable(),
    readAt: z.unknown().nullable(),
    createdAt: z.unknown(),
  })
  .openapi("NotificationRow");

const TAGS = ["notifications"];

/**
 * In-app notifications. Each row targets a userId (or null = broadcast).
 * `flow_id` is filled by the flow `notification` op (which uses an
 * internal write path); admin POST here is for ad-hoc test or manual
 * admin actions.
 */
export const notificationsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: TAGS,
      summary: "List notifications for the caller",
      description:
        "Returns rows targeted at the caller plus broadcasts. `?unread=1` filters to unread.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        query: z.object({
          unread: z.enum(["1"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(NotificationRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const onlyUnread = c.req.query("unread") === "1";
      const { limit } = parsePagination(c);
      const myConds = and(
        eq(t.tenantId, tenantId),
        auth.userId
          ? or(eq(t.userId, auth.userId), isNull(t.userId))
          : isNull(t.userId),
      );
      const where = onlyUnread ? and(myConds, isNull(t.readAt)) : myConds;
      const rows = await (ctx.db as any)
        .select()
        .from(t)
        .where(where)
        .orderBy(desc(t.createdAt))
        .limit(limit);
      return c.json({ data: rows });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/_unread-count",
      tags: TAGS,
      summary: "Unread notification count",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({ count: z.number().int().nonnegative() }),
              }),
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
      const t = tableFor(ctx.dialect);
      const where = and(
        eq(t.tenantId, tenantId),
        auth.userId
          ? or(eq(t.userId, auth.userId), isNull(t.userId))
          : isNull(t.userId),
        isNull(t.readAt),
      );
      const r = await (ctx.db as any)
        .select({ count: sql<number>`count(*)` })
        .from(t)
        .where(where);
      return c.json({ data: { count: Number(r[0]?.count ?? 0) } });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: TAGS,
      summary: "Create a notification",
      description: "Admins may target any user. Non-admins may only notify themselves.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: NotificationInput } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": {
              schema: z.object({ data: z.object({ id: z.string() }) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      // Admin-only ad-hoc post — anyone signed in can write only to themselves.
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const isAdmin = auth.roles.includes("admin");
      if (!isAdmin && body.userId && body.userId !== auth.userId) {
        throw new AppError(
          "FORBIDDEN",
          "Non-admins can only notify themselves",
        );
      }
      const t = tableFor(ctx.dialect);
      const id = crypto.randomUUID();
      const now = ctx.dialect === "pg" ? new Date() : Date.now();
      await (ctx.db as any).insert(t).values({
        id,
        tenantId,
        userId: body.userId ?? auth.userId ?? null,
        title: body.title,
        body: body.body ?? null,
        url: body.url ?? null,
        flowId: null,
        readAt: null,
        createdAt: now,
      });
      const target = body.userId ?? auth.userId ?? null;
      if (body.push && target) {
        try {
          await sendPushToUsers(ctx, auth.tenantId ?? null, {
            userIds: [target],
            title: body.title,
            body: body.body ?? body.title,
            url: body.url,
          });
        } catch {
          // best-effort — the in-app row already landed
        }
      }
      return c.json({ data: { id } }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/read",
      tags: TAGS,
      summary: "Mark a notification read",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      const now = ctx.dialect === "pg" ? new Date() : Date.now();
      await (ctx.db as any)
        .update(t)
        .set({ readAt: now })
        .where(
          and(
            eq(t.id, id),
            eq(t.tenantId, tenantId),
            auth.userId
              ? or(eq(t.userId, auth.userId), isNull(t.userId))
              : isNull(t.userId),
          ),
        );
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/_read-all",
      tags: TAGS,
      summary: "Mark every notification read for the caller",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const now = ctx.dialect === "pg" ? new Date() : Date.now();
      await (ctx.db as any)
        .update(t)
        .set({ readAt: now })
        .where(
          and(
            eq(t.tenantId, tenantId),
            auth.userId
              ? or(eq(t.userId, auth.userId), isNull(t.userId))
              : isNull(t.userId),
            isNull(t.readAt),
          ),
        );
      return c.json({ ok: true });
    },
  );
