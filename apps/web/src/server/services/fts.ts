import { sql, type SQL } from "drizzle-orm";
import { type FieldDef, ftsTableName } from "@backlex/db";
import type { Ctx } from "../context";
import { execute, queryAll } from "./items/sql-helpers";

/**
 * Keyword full-text-search index maintenance + querying, mirroring the
 * vectorize service's shape (best-effort write hooks, a bulk backfill, and a
 * search path). The DDL for the index objects lives in the schema applier
 * (`ensureFtsObjects`); this module only writes/reads their *content*.
 *
 * - **Postgres** keeps the index inline: a `_fts tsvector` column on the
 *   physical table, GIN-indexed. On write we recompute `to_tsvector('simple',
 *   …)`; we query with `websearch_to_tsquery('simple', …)` ranked by
 *   `ts_rank_cd`.
 * - **SQLite** uses an FTS5 shadow table `<table>__fts(item_id, content)`. On
 *   write we delete-then-insert the row's text; we query `MATCH` ranked by
 *   `bm25()`.
 *
 * We pin the `'simple'` text-search config on Postgres (no stemming, no stop
 * words) so ranking parity with SQLite's default FTS5 tokenizer stays close —
 * both are language-agnostic.
 */

/** The subset of a collection these helpers need. `CollectionRow` satisfies it. */
export interface FtsTarget {
  fts: boolean;
  physicalTable: string;
  pkColumn: string;
  fields: FieldDef[];
}

/** A field contributes to the index when flagged `searchable` and text-like. */
const isFtsField = (f: FieldDef): boolean =>
  Boolean(f.searchable) && (f.type === "text" || f.type === "longtext");

/** Whether this collection actually maintains a full-text index. */
export const isSearchable = (c: Pick<FtsTarget, "fts" | "fields">): boolean =>
  c.fts && c.fields.some(isFtsField);

/**
 * Stable fingerprint of what feeds the full-text index: "" when FTS is off,
 * else the sorted names of the searchable text fields. Two metadata states
 * with the same signature index identical content, so a PATCH only needs a
 * backfill when the signature changes.
 */
export const ftsIndexSignature = (c: Pick<FtsTarget, "fts" | "fields">): string =>
  c.fts
    ? c.fields
        .filter(isFtsField)
        .map((f) => f.name)
        .sort()
        .join(",")
    : "";

/** Concatenate the `searchable` text fields of a row into one index string.
 *  Mirrors the vectorize `buildText`. Returns "" when nothing is indexable. */
const buildSearchText = (row: Record<string, unknown>, fields: FieldDef[]): string => {
  const parts: string[] = [];
  for (const f of fields) {
    if (!isFtsField(f)) continue;
    const v = row[f.name];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (!s) continue;
    parts.push(s);
  }
  return parts.join("\n");
};

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression. Tokenizes on
 * Unicode letters/numbers, wraps each token as a quoted literal (neutralizing
 * FTS5 operators like `*`, `:`, `-`, `"`, `(`), and ANDs them with spaces —
 * matching `websearch_to_tsquery`'s default space-as-AND semantics. Returns
 * null when the input has no usable tokens (caller skips the search).
 */
export const toFtsMatchExpr = (needle: string): string | null => {
  const tokens = needle.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" ");
};

const run = async (ctx: Ctx, stmt: SQL): Promise<void> => {
  await execute(ctx, stmt);
};

/**
 * Re-index a single item. Best-effort: any failure is logged but never thrown,
 * so a hiccup in the search index can't fail the underlying item write (same
 * contract as `embedAndUpsert`). No-op unless the collection is searchable.
 */
export const indexFts = async (
  ctx: Ctx,
  collection: FtsTarget,
  itemId: string,
  row: Record<string, unknown>,
): Promise<void> => {
  if (!isSearchable(collection)) return;
  const table = collection.physicalTable;
  const pk = collection.pkColumn;
  const text = buildSearchText(row, collection.fields);
  try {
    if (ctx.dialect === "pg") {
      await run(
        ctx,
        text
          ? sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier("_fts")} = to_tsvector('simple', ${text}) WHERE ${sql.identifier(pk)} = ${itemId}`
          : sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier("_fts")} = NULL WHERE ${sql.identifier(pk)} = ${itemId}`,
      );
      return;
    }
    const ftsTbl = ftsTableName(table);
    await run(ctx, sql`DELETE FROM ${sql.identifier(ftsTbl)} WHERE ${sql.identifier("item_id")} = ${itemId}`);
    if (text) {
      await run(
        ctx,
        sql`INSERT INTO ${sql.identifier(ftsTbl)} (${sql.identifier("item_id")}, ${sql.identifier("content")}) VALUES (${itemId}, ${text})`,
      );
    }
  } catch (e) {
    console.error(`[fts] index failed for ${table}/${itemId}:`, e);
  }
};

/**
 * Drop an item from the index on delete. Postgres needs nothing — a hard
 * delete takes the `_fts` column with the row, and a soft delete is excluded
 * by the read path's `deleted_at IS NULL` filter. SQLite must remove the
 * shadow-table row explicitly.
 */
export const deleteFts = async (
  ctx: Ctx,
  collection: FtsTarget,
  itemId: string,
): Promise<void> => {
  if (!isSearchable(collection)) return;
  if (ctx.dialect === "pg") return;
  try {
    const ftsTbl = ftsTableName(collection.physicalTable);
    await run(ctx, sql`DELETE FROM ${sql.identifier(ftsTbl)} WHERE ${sql.identifier("item_id")} = ${itemId}`);
  } catch (e) {
    console.error(`[fts] delete failed for ${collection.physicalTable}/${itemId}:`, e);
  }
};

/** Backfill: re-index a batch of existing rows. Returns the count that
 *  produced non-empty index text (the rest are reported as `skipped`). */
export const indexFtsBatch = async (
  ctx: Ctx,
  collection: FtsTarget,
  rows: Array<{ id: string; row: Record<string, unknown> }>,
): Promise<number> => {
  if (!isSearchable(collection)) return 0;
  let indexed = 0;
  for (const { id, row } of rows) {
    const text = buildSearchText(row, collection.fields);
    await indexFts(ctx, collection, id, row);
    if (text) indexed += 1;
  }
  return indexed;
};

export interface FtsBackfillResult {
  /** Rows whose searchable fields produced index text. */
  processed: number;
  /** Rows whose searchable fields were all empty (nothing to index). */
  skipped: number;
  /** Rows visited. */
  total: number;
}

/**
 * Backfill the full-text index for every existing row in the collection's
 * physical table. Synchronous + paginated (100 rows per batch). Scoped to
 * `tenantId` only when the collection is tenant-scoped — a global table has
 * no `tenant_id` column to filter on. Shared by the explicit
 * `POST /:slug/fts-reindex` endpoint and the PATCH auto-backfill that runs
 * when FTS is enabled / the searchable field set changes.
 */
export const backfillFts = async (
  ctx: Ctx,
  collection: FtsTarget & { tenantScoped?: boolean },
  tenantId: string | null,
): Promise<FtsBackfillResult> => {
  const table = sql.identifier(collection.physicalTable);
  const where =
    (collection.tenantScoped ?? true) && tenantId
      ? sql` WHERE ${sql.identifier("tenant_id")} = ${tenantId}`
      : sql``;
  const totalRow = await queryAll<{ count: number | string | bigint }>(
    ctx,
    sql`SELECT COUNT(*) AS count FROM ${table}${where}`,
  );
  const total = Number(totalRow[0]?.count ?? 0);

  let processed = 0;
  let skipped = 0;
  let offset = 0;
  const batchSize = 100;
  while (offset < total) {
    const batch = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT * FROM ${table}${where} ORDER BY ${sql.identifier(collection.pkColumn)} LIMIT ${batchSize} OFFSET ${offset}`,
    );
    if (batch.length === 0) break;
    const indexed = await indexFtsBatch(
      ctx,
      collection,
      batch.map((row) => ({ id: String(row[collection.pkColumn]), row })),
    );
    processed += indexed;
    skipped += batch.length - indexed;
    offset += batch.length;
  }
  return { processed, skipped, total };
};

/**
 * Rank the collection's items against `needle` by relevance and return their
 * ids, best-first, up to `limit`. Pure index ranking — it applies NO
 * permission / tenant / soft-delete / draft filters. Callers MUST re-apply
 * those when hydrating the rows (the search route does), which is what keeps
 * the result secure and visibility-correct.
 */
export const ftsRankedIds = async (
  ctx: Ctx,
  collection: FtsTarget,
  needle: string,
  limit: number,
): Promise<string[]> => {
  if (!isSearchable(collection)) return [];
  const table = collection.physicalTable;
  if (ctx.dialect === "pg") {
    const tsq = sql`websearch_to_tsquery('simple', ${needle})`;
    const rows = await queryAll<{ id: string }>(
      ctx,
      sql`SELECT ${sql.identifier(collection.pkColumn)} AS id
          FROM ${sql.identifier(table)}
          WHERE ${sql.identifier("_fts")} @@ ${tsq}
          ORDER BY ts_rank_cd(${sql.identifier("_fts")}, ${tsq}) DESC
          LIMIT ${limit}`,
    );
    return rows.map((r) => String(r.id));
  }
  const match = toFtsMatchExpr(needle);
  if (!match) return [];
  const ftsTbl = sql.identifier(ftsTableName(table));
  const rows = await queryAll<{ id: string }>(
    ctx,
    sql`SELECT ${sql.identifier("item_id")} AS id
        FROM ${ftsTbl}
        WHERE ${ftsTbl} MATCH ${match}
        ORDER BY bm25(${ftsTbl}) ASC
        LIMIT ${limit}`,
  );
  return rows.map((r) => String(r.id));
};

/**
 * A WHERE fragment that keeps only rows matching `needle`, qualified to the
 * collection's physical table so it composes in the list query (which may
 * JOIN). Used to upgrade `?q=` from substring `LIKE` to real keyword search
 * when the collection has FTS enabled. Returns null when the query yields no
 * usable tokens (SQLite) — caller then applies no search narrowing.
 */
export const ftsMembershipWhere = (
  collection: FtsTarget,
  needle: string,
  dialect: "pg" | "sqlite",
): SQL | null => {
  const tbl = sql.identifier(collection.physicalTable);
  if (dialect === "pg") {
    return sql`${tbl}.${sql.identifier("_fts")} @@ websearch_to_tsquery('simple', ${needle})`;
  }
  const match = toFtsMatchExpr(needle);
  if (!match) return null;
  const ftsTbl = sql.identifier(ftsTableName(collection.physicalTable));
  return sql`${tbl}.${sql.identifier(collection.pkColumn)} IN (SELECT ${sql.identifier("item_id")} FROM ${ftsTbl} WHERE ${ftsTbl} MATCH ${match})`;
};
