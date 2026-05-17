import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.activity : sqlite.schema.activity;

const ActivityRow = z
  .object({
    id: z.string(),
    userId: z.string().nullable(),
    tenantId: z.string().nullable(),
    action: z.string(),
    collection: z.string().nullable(),
    itemId: z.string().nullable(),
    payload: z.unknown().nullable(),
    durationMs: z.number().int().nullable(),
    createdAt: z.unknown(),
  })
  .openapi("ActivityRow");

export const activityRoutes = new OpenAPIHono<AppBindings>().openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["activity"],
    summary: "List activity log entries",
    description:
      "Admins see every entry; non-admins see only their own. Filter by `collection` and/or `itemId`. Paginate with `limit` (max 200) and `offset`.",
    security: SECURITY,
    middleware: [requireUser],
    request: {
      query: z.object({
        collection: z.string().optional(),
        itemId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
    },
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: z.object({
              data: z.array(ActivityRow),
              limit: z.number().int(),
              offset: z.number().int(),
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
    const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
    const t = tableFor(ctx.dialect);
    const q = c.req.valid("query");
    const limit = Math.min(200, Math.max(1, q.limit ?? 50));
    const offset = Math.max(0, q.offset ?? 0);
    const collection = q.collection;
    const itemId = q.itemId;

    const conds: SQL[] = [];
    if (!isAdmin) {
      if (!auth.userId) throw new AppError("UNAUTHORIZED", "Sign in required");
      conds.push(eq(t.userId, auth.userId));
    }
    if (collection) conds.push(eq(t.collection, collection));
    if (itemId) conds.push(eq(t.itemId, itemId));

    let qb = (ctx.db as any).select().from(t);
    if (conds.length) qb = qb.where(conds.length === 1 ? conds[0] : and(...conds));
    const rows = await qb.orderBy(desc(t.createdAt)).limit(limit).offset(offset);

    return c.json({ data: rows, limit, offset });
  },
);
