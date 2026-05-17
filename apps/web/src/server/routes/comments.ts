import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { AppError } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.comments : sqlite.schema.comments;

const CommentInput = z
  .object({
    collection: z.string().min(1),
    itemId: z.string().min(1),
    body: z.string().min(1).max(4000),
  })
  .openapi("CommentInput");

const CommentRow = z
  .object({
    id: z.string(),
    collection: z.string(),
    itemId: z.string(),
    userId: z.string().nullable(),
    body: z.string(),
    createdAt: z.unknown(),
  })
  .openapi("CommentRow");

const TAGS = ["comments"];

/**
 * Per-item discussion thread. Each comment is bound to (collection, itemId)
 * and stored separately from the dynamic `c_<slug>` table — admins can
 * reuse comments across migrations without ALTERing user collections.
 *
 * Permissions are deliberately loose for now: any signed-in user can read +
 * write; only authors and admins can delete. When the permission DSL gains
 * a richer "subject" notion this should fold into it.
 */
export const commentsRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: TAGS,
      summary: "List comments on an item",
      description:
        "Requires `collection` + `itemId` query params. Any signed-in user can read.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        query: z.object({
          collection: z.string(),
          itemId: z.string(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(CommentRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { collection, itemId } = c.req.valid("query");
      if (!collection || !itemId) {
        throw new AppError(
          "VALIDATION",
          "?collection=<slug>&itemId=<id> are required",
        );
      }
      const t = tableFor(ctx.dialect);
      const rows = await (ctx.db as any)
        .select()
        .from(t)
        .where(and(eq(t.collection, collection), eq(t.itemId, itemId)))
        .orderBy(desc(t.createdAt));
      return c.json({ data: rows });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: TAGS,
      summary: "Create a comment",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: { required: true, content: { "application/json": { schema: CommentInput } } },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: CommentRow }) } },
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
      const now = ctx.dialect === "pg" ? new Date() : Date.now();
      await (ctx.db as any).insert(t).values({
        id,
        collection: body.collection,
        itemId: body.itemId,
        userId: auth.userId,
        body: body.body,
        createdAt: now,
      });
      return c.json(
        { data: { id, ...body, userId: auth.userId, createdAt: now } },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: TAGS,
      summary: "Delete a comment",
      description: "Only the author or an admin may delete.",
      security: SECURITY,
      middleware: [requireUser],
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
      const auth = c.get("auth");
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      const rows = await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) throw new AppError("NOT_FOUND", "Comment not found");
      const isAdmin = auth.roles.includes("admin");
      if (!isAdmin && row.userId !== auth.userId) {
        throw new AppError("FORBIDDEN", "Only the author or admin can delete");
      }
      await (ctx.db as any).delete(t).where(eq(t.id, id));
      return c.json({ ok: true });
    },
  );
