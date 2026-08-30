import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, count, desc, eq, gte, isNull, like, lte, or, type SQL } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { isInstanceOperator } from "../services/roles/guards";
import { SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";

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

export const activityRoutes = new OpenAPIHono<AppBindings>({ defaultHook }).openapi(
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
        /** `instance` → drop the workspace filter and include the
         *  `tenant_id IS NULL` pre-auth security rows. Instance-operator only;
         *  a non-operator asking for it is refused, never downgraded. */
        scope: z.enum(["workspace", "instance"]).optional(),
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

    // `?scope=instance` — the deliberate answer to what the workspace
    // predicate below hides, rather than a fallback that quietly restores it.
    //
    // Rows written with a NULL `tenant_id` are the pre-auth security trail:
    // `lib/auth-rate-limit.ts` records `auth.rate_limited` with the attempted
    // address and source IP before any workspace is known. Scoping the query
    // makes them invisible to everyone, which is a real loss for whoever runs
    // the instance — so they get a way to ask for them, and only they do.
    //
    // What this must NOT be is `or(eq(tenantId), isNull(tenantId))` as the
    // default. That keeps unscoped security rows readable by every self-made
    // workspace admin, which is most of the bug wearing a smaller hat.
    //
    // It refuses rather than downgrading: a caller who asked for the instance
    // view and silently got the workspace view would read the answer as "there
    // is nothing there".
    const wantsInstanceScope = q.scope === "instance";
    // Needed for BOTH the explicit instance scope and the default view's
    // treatment of unscoped rows, so it is resolved once. It rides the same
    // per-isolate role cache every request already pays for.
    const operator = await isInstanceOperator(ctx, auth);
    if (wantsInstanceScope && !operator) {
      throw new AppError(
        "FORBIDDEN",
        "Instance-wide activity is operator-only — sign in as an admin of the default workspace, or set OWNER_EMAIL to your address",
      );
    }

    const conds: SQL[] = [];
    // The workspace predicate, unconditionally and before anything else.
    //
    // Its absence was the whole bug: the only isolation this handler ever
    // implemented was `eq(userId)` for non-admins, i.e. PER-USER and never
    // PER-WORKSPACE, while `auth.tenantId` sat on the context unused. So any
    // workspace admin — a role `POST /api/tenants` hands out for free, and one
    // a delegated per-client admin holds by design — read every workspace's
    // item payloads, response bodies, invitee addresses and client IPs, with
    // `?collection=` / `?action=` / `?from=` turning it into targeted
    // cross-workspace search rather than merely a dump.
    //
    // No migration is owed: `activity_tenant_created_idx` on
    // `(tenantId, createdAt)` already ships in both dialects, so the scoped
    // query is cheaper than the unscoped one it replaces.
    const tenantId = auth.tenantId ?? null;
    if (!tenantId) throw new AppError("UNAUTHORIZED", "Active workspace required");
    if (!wantsInstanceScope) {
      // Rows with a NULL `tenant_id` are not "some other workspace's" — they
      // are the INSTANCE's, written before a workspace was known:
      // `lib/auth-rate-limit.ts` records `auth.rate_limited` and
      // `auth.login_locked` with the attempted address and source IP during
      // sign-in. Nobody owns them at the workspace level, and the instance
      // operator is who they are for.
      //
      // So the default view is "this workspace, plus the instance's own trail
      // if you are the instance's operator". A delegated workspace admin sees
      // neither another workspace's rows nor the pre-auth security trail; the
      // operator's Logs page keeps showing what it always showed.
      //
      // What this is NOT is an unconditional `or(isNull(...))`. That was the
      // tempting shortcut and it would have kept the brute-force trail, with
      // attempted addresses and IPs, readable by every self-made workspace
      // admin — most of the original bug, in a smaller hat.
      conds.push(
        operator
          ? (or(eq(t.tenantId, tenantId), isNull(t.tenantId)) as SQL)
          : eq(t.tenantId, tenantId),
      );
    }
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
