import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { FieldDef } from "@backlex/db";
import type { Ctx } from "../../context";
import type { CollectionRow } from "./collection-loader";
import { nowFor } from "./sql-helpers";

/**
 * Staged-edits sidecar (#15). A `stagedEdits` collection stores PATCHes made
 * against a *published* row in `item_staged` (one JSON patch per item, merged
 * shallowly per field across saves) instead of mutating the live row. The
 * patch is applied — through the normal `performUpdate` path, so validation,
 * FTS/vector reindex, revisions, and events all fire — when the row's
 * lifecycle moves (publish / unpublish / archive / schedule), then cleared.
 * Explicit discard deletes the patch without applying.
 *
 * Values are stored in API (deserialized) shape: hash fields pre-digested
 * (never plaintext — `hashIncomingFields` passes digests through unchanged on
 * apply), `localized` fields as their canonical `{locale: value}` map so the
 * apply-time `splitLocalized` routes them back into the sidecar table.
 */

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.itemStaged : sqlite.schema.itemStaged;

export interface StagedRow {
  data: Record<string, unknown>;
  updatedAt: Date | number | null;
  updatedBy: string | null;
}

type DbCtx = Pick<Ctx, "db" | "dialect">;

export const getStagedRow = async (
  ctx: DbCtx,
  collection: Pick<CollectionRow, "id">,
  itemId: string,
): Promise<StagedRow | null> => {
  const t = tableFor(ctx.dialect);
  const rows = await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.collectionId, collection.id), eq(t.itemId, itemId)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const data =
    typeof r.data === "string" ? JSON.parse(r.data) : (r.data ?? {});
  return {
    data: (data ?? {}) as Record<string, unknown>,
    updatedAt: r.updatedAt ?? null,
    updatedBy: r.updatedBy ?? null,
  };
};

/** Which of `ids` have a staged patch — one query for a whole list page. */
export const stagedIdsFor = async (
  ctx: DbCtx,
  collection: Pick<CollectionRow, "id">,
  ids: string[],
): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ itemId: t.itemId })
    .from(t)
    .where(and(eq(t.collectionId, collection.id), inArray(t.itemId, ids)))) as {
    itemId: string;
  }[];
  return new Set(rows.map((r) => r.itemId));
};

/** Raw upsert statement, dialect-aware, for the write chokepoint (`emit`) so a
 *  staged save joins an atomic batch's transaction like any other write. */
export const stagedUpsertSql = (
  dialect: "pg" | "sqlite",
  collectionId: string,
  itemId: string,
  tenantId: string | null,
  data: Record<string, unknown>,
  userId: string | null,
): SQL => {
  const json = JSON.stringify(data);
  const dataVal = dialect === "pg" ? sql`${json}::jsonb` : sql`${json}`;
  const now = nowFor(dialect);
  return sql`INSERT INTO ${sql.identifier("item_staged")} (${sql.identifier("collection_id")}, ${sql.identifier("item_id")}, ${sql.identifier("tenant_id")}, ${sql.identifier("data")}, ${sql.identifier("updated_at")}, ${sql.identifier("updated_by")})
    VALUES (${collectionId}, ${itemId}, ${tenantId}, ${dataVal}, ${now}, ${userId})
    ON CONFLICT (${sql.identifier("collection_id")}, ${sql.identifier("item_id")}) DO UPDATE SET
      ${sql.identifier("data")} = excluded.${sql.identifier("data")},
      ${sql.identifier("updated_at")} = excluded.${sql.identifier("updated_at")},
      ${sql.identifier("updated_by")} = excluded.${sql.identifier("updated_by")}`;
};

/** Raw delete statement for the same chokepoint. */
export const stagedDeleteSql = (collectionId: string, itemId: string): SQL =>
  sql`DELETE FROM ${sql.identifier("item_staged")}
      WHERE ${sql.identifier("collection_id")} = ${collectionId}
      AND ${sql.identifier("item_id")} = ${itemId}`;

export const deleteStagedRow = async (
  ctx: DbCtx,
  collection: Pick<CollectionRow, "id">,
  itemId: string,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  await (ctx.db as any)
    .delete(t)
    .where(and(eq(t.collectionId, collection.id), eq(t.itemId, itemId)));
};

/**
 * Merged read-side preview of a staged patch: hash values masked to null and
 * `private` fields dropped, mirroring what `deserializeRow` does for the live
 * row — the digest / private value must not leak via `?staged=1`.
 */
export const stagedViewOf = (
  data: Record<string, unknown>,
  fields: FieldDef[],
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...data };
  for (const f of fields) {
    if (f.type === "hash" && f.name in out) out[f.name] = null;
    if (f.private) delete out[f.name];
  }
  return out;
};
