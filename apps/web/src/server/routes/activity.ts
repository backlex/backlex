import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, count, desc, eq, gte, like, lte, type SQL } from "drizzle-orm";
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
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    payload: z.unknown().nullable(),
    response: z.unknown().nullable(),
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
      "Admins see every entry; non-admins see only their own. Filter by " +
      "`collection`, `itemId`, an `action` prefix (e.g. `action=item` matches " +
      "`item.create`), and/or a `from`/`to` epoch-ms time window. Paginate " +
      "with `limit` (max 200) and `offset`. Pass `meta=count` to add a " +
      "`meta.count` total computed against the same filters (ignores " +
      "`limit`/`offset`).",
    security: SECURITY,
    middleware: [requireUser],
    request: {
      query: z.object({
        collection: z.string().optional(),
        itemId: z.string().optional(),
        /** Action namespace prefix — matched as `action LIKE '<prefix>%'`. */
        action: z.string().optional(),
        /** Inclusive lower bound on `createdAt`, epoch milliseconds. */
        from: z.coerce.number().int().optional(),
        /** Inclusive upper bound on `createdAt`, epoch milliseconds. */
        to: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        /** `count` → adds `meta.count` (total rows matching the filters). */
        meta: z.string().optional(),
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
              meta: z.object({ count: z.number().int() }).optional(),
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
    const wantCount = q.meta?.split(",").includes("count") ?? false;

    const conds: SQL[] = [];
    if (!isAdmin) {
      if (!auth.userId) throw new AppError("UNAUTHORIZED", "Sign in required");
      conds.push(eq(t.userId, auth.userId));
    }
    if (q.collection) conds.push(eq(t.collection, q.collection));
    if (q.itemId) conds.push(eq(t.itemId, q.itemId));
    // Action namespaces are dot-prefixed (`item.create`, `auth.login`), so a
    // prefix filter is a `LIKE '<prefix>%'`. `%`/`_` in the prefix would be
    // wildcards, but action namespaces never contain them so it's a non-issue.
    if (q.action) conds.push(like(t.action, `${q.action}%`));
    // `createdAt` is a Drizzle `Date` column on both dialects, so comparing
    // against `new Date(epochMs)` is dialect-agnostic.
    if (q.from != null) conds.push(gte(t.createdAt, new Date(q.from)));
    if (q.to != null) conds.push(lte(t.createdAt, new Date(q.to)));

    const where =
      conds.length === 0
        ? undefined
        : conds.length === 1
          ? conds[0]
          : and(...conds);

    let qb = (ctx.db as any).select().from(t);
    if (where) qb = qb.where(where);
    const rows = await qb.orderBy(desc(t.createdAt)).limit(limit).offset(offset);

    if (!wantCount) return c.json({ data: rows, limit, offset });

    let cb = (ctx.db as any).select({ value: count() }).from(t);
    if (where) cb = cb.where(where);
    const countRows = await cb;
    const total = Number(countRows[0]?.value ?? 0);
    return c.json({ data: rows, limit, offset, meta: { count: total } });
  },
);
