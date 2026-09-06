import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AuthSubject } from "@backlex/core";
import type { Ctx } from "../../context";
import { resolvePermission } from "../permissions";
import type { CollectionRow } from "./collection-loader";
import {
  deletedFilter,
  draftFilter,
  fromOf,
  pkEq,
  queryAll,
  selectStar,
  tenantFilter,
  usesOwnershipSideTable,
  whereOf,
} from "./sql-helpers";

/**
 * Whether the caller may see drafts of a versioned collection. Admins and
 * holders of `publish` or `update` permission on the collection do; everyone
 * else gets published-only reads. Returns false for non-versioned collections
 * (no status filter is applied to them).
 */
export const canSeeDraftsFor = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  auth: AuthSubject & { tenantId?: string | null },
  collection: CollectionRow,
  perm: { isAdmin?: boolean },
): Promise<boolean> => {
  if (!collection.versioned) return false;
  if (perm.isAdmin) return true;
  const dbctx = { db: ctx.db as any, dialect: ctx.dialect };
  if ((await resolvePermission(dbctx, auth, collection.slug, "publish")).allowed) return true;
  return (await resolvePermission(dbctx, auth, collection.slug, "update")).allowed;
};

/**
 * The row `GET /api/items/{slug}/{id}` would return for THIS identity, or null.
 *
 * Every surface that hangs something off a row id — the revision history, the
 * discussion thread, an embedding namespace — has to answer the same question
 * before it answers its own: *may this caller read the row?* Resolving `read`
 * on the COLLECTION is not that question. A role whose grant carries a
 * condition (`{owner_id: {_eq: "$user.id"}}` — the shape every self-service
 * portal role uses) passes the collection gate for every row in the table and
 * is meant to be stopped at the row, by `perm.whereSql`. Sibling endpoints
 * resolved the permission and then never applied it, so the clamp that makes
 * the portal safe was present on the item and absent on what hangs off it.
 *
 * So this is that question, once. It runs the same four filters the by-id GET
 * runs — primary key, the caller's row condition, the workspace, soft-delete —
 * plus the versioned-draft filter, so an unpublished row stays as invisible
 * here as it is there. Callers throw their own `NOT_FOUND`: the message
 * belongs to the surface being asked, not to this.
 *
 * A caller that already holds the row (the by-id GET itself) does not need
 * this — it composes the same filters into its own single query.
 */
export const readableRow = async (
  ctx: Ctx,
  auth: AuthSubject & { tenantId?: string | null },
  collection: CollectionRow,
  id: string,
  perm: { whereSql: SQL | null; isAdmin?: boolean },
): Promise<Record<string, unknown> | null> => {
  const canSeeDrafts = await canSeeDraftsFor(ctx, auth, collection, perm);
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(
      pkEq(collection.pkColumn, id),
      perm.whereSql,
      tenantFilter(collection, auth),
      deletedFilter(collection),
      draftFilter(collection, canSeeDrafts, undefined),
    )} LIMIT 1`,
  );
  return rows[0] ?? null;
};

/**
 * Of these ids, the ones whose row this identity may actually read.
 *
 * {@link readableRow} for a set, in one query. Anything that gets a row id
 * from somewhere other than a permission-filtered read — a vector store, an
 * FK on a row the caller CAN see, a JOIN that already ran — needs this before
 * it hands anything back, because none of those sources has a permission
 * model of its own.
 *
 * Nothing is skipped when the caller is unrestricted: an admin's `whereSql` is
 * null and every filter composes to a no-op, so the query costs one round trip
 * and returns everything asked for. Uniformity is worth the round trip — a
 * fast path conditioned on "looks unrestricted" is a second implementation of
 * the rule, and callers that can cheaply tell (`perm.whereSql === null` and no
 * soft-delete and not versioned) are free to skip the call themselves.
 */
export const readableIds = async (
  ctx: Ctx,
  auth: AuthSubject & { tenantId?: string | null },
  collection: CollectionRow,
  perm: { whereSql: SQL | null; isAdmin?: boolean },
  ids: readonly string[],
): Promise<Set<string>> => {
  const wanted = [...new Set(ids)].filter((id) => id !== "");
  if (wanted.length === 0) return new Set<string>();
  const canSeeDrafts = await canSeeDraftsFor(ctx, auth, collection, perm);
  // Qualification mirrors `searchCollectionItems`: an adopted owner-scoped
  // collection reaches its owner through a join, and only the columns that
  // exist on both sides need naming. `perm.whereSql` stays unqualified for the
  // reason spelled out in `routes/items/read.ts` — the conditions it compiles
  // reference `owner_id`, which the join surfaces.
  const joined = usesOwnershipSideTable(collection);
  const baseTblId = sql.identifier(collection.physicalTable);
  const pkRef = joined
    ? sql`${baseTblId}.${sql.identifier(collection.pkColumn)}`
    : sql`${sql.identifier(collection.pkColumn)}`;
  const tenantWhereRaw = tenantFilter(collection, auth);
  const tenantWhere =
    joined && tenantWhereRaw && collection.tenantScoped && auth.tenantId
      ? sql`${baseTblId}.${sql.identifier("tenant_id")} = ${auth.tenantId}`
      : tenantWhereRaw;
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${pkRef} AS ${sql.identifier("pk")} FROM ${fromOf(collection)} ${whereOf(
      sql`${pkRef} IN (${sql.join(
        wanted.map((id) => sql`${id}`),
        sql`, `,
      )})`,
      perm.whereSql,
      tenantWhere,
      deletedFilter(collection, joined ? collection.physicalTable : undefined),
      draftFilter(
        collection,
        canSeeDrafts,
        undefined,
        joined ? collection.physicalTable : undefined,
      ),
    )}`,
  );
  return new Set(rows.map((r) => String(r.pk)));
};
