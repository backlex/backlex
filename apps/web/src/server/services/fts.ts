import { sql, type SQL } from "drizzle-orm";
import { type FieldDef, ftsTableName, isLocalized } from "@backlex/db";
import type { Ctx } from "../context";
import { loadSidecarForRow, loadSidecarForRows } from "./items/i18n-sidecar";
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

/**
 * A field contributes to the index when flagged `searchable`, text-like, and
 * NOT `private`.
 *
 * The private exclusion belongs here rather than upstream, because upstream
 * only covered one of the two callers. The write path scrubs private fields off
 * the payload before the side effects run (`scrubPrivateFields`), so a create
 * never indexed one — but `backfillFts` reads its rows with `SELECT *` and
 * scrubs nothing, so `POST /collections/:slug/fts-reindex` put them straight
 * into the index. Measured: a `private + searchable` value was not findable
 * after a create and WAS findable after a reindex.
 *
 * That is a disclosure, not an untidiness. Search never returns the column, but
 * it returns the ROW, so a caller can guess a value and learn from the hit
 * whether the guess was right — an oracle over a field the API deliberately
 * never renders. Deciding it here makes both callers agree, and makes the
 * sidecar read below safe by construction rather than by remembering.
 */
const isFtsField = (f: FieldDef): boolean =>
  Boolean(f.searchable) && !f.private && (f.type === "text" || f.type === "longtext");

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

/** The `searchable` text fields whose value lives in the `__i18n` sidecar. */
const localizedFtsFields = (fields: FieldDef[]): FieldDef[] =>
  fields.filter((f) => isFtsField(f) && isLocalized(f));

/**
 * Concatenate the `searchable` text fields of a row into one index string.
 * Mirrors the vectorize `buildText`. Returns "" when nothing is indexable.
 *
 * Localized fields are SKIPPED here and supplied by {@link sidecarText}, because
 * this row never holds their real value. It holds one of three things depending
 * on which caller built it, and two of them silently corrupted the index:
 *
 *  - create passes the base payload, from which `splitLocalized` has already
 *    DELETED every localized field — so the field was never indexed at all;
 *  - `PATCH ?locale=tr` passes `echoLocalized(...)`'s single native value — so
 *    the whole blob was rebuilt from Turkish alone and the English text
 *    disappeared from the index;
 *  - a locale-less PATCH passes the `{locale: value}` map, and `String(map)` is
 *    `"[object Object]"` — measured: searching "object" returned the row.
 *
 * Reading the sidecar instead makes all three correct at once, and makes the
 * index a function of what is STORED rather than of which endpoint wrote last.
 */
const buildSearchText = (row: Record<string, unknown>, fields: FieldDef[]): string => {
  const parts: string[] = [];
  for (const f of fields) {
    if (!isFtsField(f) || isLocalized(f)) continue;
    const v = row[f.name];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (!s) continue;
    parts.push(s);
  }
  return parts.join("\n");
};

/**
 * Every locale's text for the localized `searchable` fields, from sidecar rows.
 *
 * All locales go into the ONE blob rather than a blob per locale, and that is a
 * deliberate limit of this shape: both dialects keep a single index per row
 * (SQLite one `<table>__fts` row, Postgres one `_fts` tsvector column on the
 * base table), so a per-locale index would have to move the Postgres column
 * onto the sidecar — a migration and a second read path. What the one blob
 * costs is cross-language matching: a query finds the row if ANY locale
 * matches. For a storefront that is the behaviour you want anyway — the shopper
 * gets the row, and the read path still renders it in the requested locale.
 */
const sidecarText = (
  sidecarRows: Array<Record<string, unknown>>,
  defs: FieldDef[],
): string => {
  const parts: string[] = [];
  for (const r of sidecarRows) {
    for (const f of defs) {
      const v = r[f.name];
      if (v === null || v === undefined) continue;
      const s = String(v).trim();
      if (s) parts.push(s);
    }
  }
  return parts.join("\n");
};

/** Base-row text plus every locale's sidecar text, joined. */
const joinText = (base: string, extra: string): string =>
  base && extra ? `${base}\n${extra}` : base || extra;

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression. Tokenizes on
 * Unicode letters/numbers, wraps each token as a quoted literal (neutralizing
 * FTS5 operators like `*`, `:`, `-`, `"`, `(`), and ANDs them with spaces —
 * matching `websearch_to_tsquery`'s default space-as-AND semantics. Returns
 * null when the input has no usable tokens (caller skips the search).
 *
 * ## Why the case fold is FTS5's and not JavaScript's
 *
 * This used to read `needle.toLowerCase()`, and that one call made a row
 * unfindable by the very string it is named with.
 *
 * `toLowerCase()` uses the locale-invariant mapping, where `İ` (U+0130, the
 * dotted capital I every Turkish proper noun starts with) does not fold to one
 * character — it EXPANDS to `i` + U+0307 COMBINING DOT ABOVE. The tokenizer
 * regex below counts letters and numbers, and a combining mark is neither, so
 * it reads U+0307 as a SEPARATOR: `"İSTANBUL"` came out as the two tokens `i`
 * and `stanbul`, ANDed. Neither is a word in the index, so a product literally
 * named "İstanbul Filtre Kahve" returned nothing for `İstanbul` — while the
 * misspelled ASCII `ISTANBUL` found it, because that one folds to a single `i`.
 *
 * The fold was also redundant. FTS5's default `unicode61` tokenizer already
 * case-folds AND strips diacritics at MATCH time, on both sides — which is why
 * `cay` has always matched `çay`. Doing it again in JS could only ever
 * disagree with the tokenizer, never help it, and here it disagreed for every
 * character whose lowercase is longer than itself: Turkish `İ`, Lithuanian
 * `Į`/`Ĩ`, and Greek capitals carrying tonos.
 *
 * So the tokens now keep the case they arrived in and FTS5 folds them. Only
 * SQLite came through here — Postgres hands the raw needle to
 * `websearch_to_tsquery` — so this was a SQLite/D1 bug, which is to say it was
 * every managed tenant and every default self-host.
 *
 * Pinned by `apps/web/tests/fts-turkish-dotted-i.test.ts`.
 */
export const toFtsMatchExpr = (needle: string): string | null => {
  const tokens = needle.match(/[\p{L}\p{N}]+/gu);
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
  await writeIndex(ctx, collection, itemId, await indexTextFor(ctx, collection, itemId, row));
};

/**
 * The index text for one row: its base fields, plus every locale held in the
 * sidecar. The sidecar read is guarded on its own — a failure there must cost
 * the localized half, not the whole index entry.
 */
const indexTextFor = async (
  ctx: Ctx,
  collection: FtsTarget,
  itemId: string,
  row: Record<string, unknown>,
): Promise<string> => {
  const base = buildSearchText(row, collection.fields);
  const locDefs = localizedFtsFields(collection.fields);
  if (locDefs.length === 0) return base;
  try {
    const rows = await loadSidecarForRow(ctx, collection.physicalTable, itemId, locDefs);
    return joinText(base, sidecarText(rows, locDefs));
  } catch (e) {
    console.error(`[fts] sidecar read failed for ${collection.physicalTable}/${itemId}:`, e);
    return base;
  }
};

/** Persist one row's computed index text. Best-effort, as above. */
const writeIndex = async (
  ctx: Ctx,
  collection: FtsTarget,
  itemId: string,
  text: string,
): Promise<void> => {
  const table = collection.physicalTable;
  const pk = collection.pkColumn;
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
  const locDefs = localizedFtsFields(collection.fields);
  // One sidecar query for the whole batch. Calling `indexFts` per row would
  // issue one per row, which is the difference between a backfill that finishes
  // and one that does not.
  let sidecars = new Map<string, Array<Record<string, unknown>>>();
  if (locDefs.length > 0) {
    try {
      sidecars = await loadSidecarForRows(
        ctx,
        collection.physicalTable,
        rows.map((r) => r.id),
        locDefs,
      );
    } catch (e) {
      console.error(`[fts] sidecar batch read failed for ${collection.physicalTable}:`, e);
    }
  }
  let indexed = 0;
  for (const { id, row } of rows) {
    const text = joinText(
      buildSearchText(row, collection.fields),
      sidecarText(sidecars.get(id) ?? [], locDefs),
    );
    await writeIndex(ctx, collection, id, text);
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
