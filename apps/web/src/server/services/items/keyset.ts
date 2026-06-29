import { AppError } from "@backlex/core";
import { type SQL, sql } from "drizzle-orm";

/**
 * Keyset (seek) pagination helpers.
 *
 * Offset pagination is O(offset): the engine walks and discards every skipped
 * row before reaching the page window, so deep pages get linearly slower and
 * can silently skip/duplicate rows under concurrent inserts. Keyset pagination
 * seeks straight into a composite index on `(…sort cols, id)` and reads exactly
 * one page regardless of depth — the win is biggest on D1, which has no
 * intra-query parallelism to mask a deep scan.
 *
 * The cursor is the ORDER-BY tuple of the last row on the previous page,
 * base64url-encoded. It is opaque to callers (NOT a row number): pass it back
 * verbatim as `?cursor=` to fetch the next page.
 *
 * Caveat: correctness relies on every leading sort column being non-NULL (a
 * NULL in a leading position makes the `=`/`<`/`>` branches evaluate to
 * UNKNOWN and can skip rows). The default `created_at` sort and the always-
 * present `id` tiebreaker are non-null, so the common path is safe; sorting a
 * page on a nullable column is the caller's risk.
 */

export type KeysetPart = { ref: SQL; dir: "asc" | "desc" };

/** Encode an ORDER-BY boundary tuple into an opaque base64url cursor.
 *  A `bigint` (some Postgres int8 drivers) can't go through JSON, so it's
 *  coerced to its decimal string — Postgres casts the text param back to int8
 *  at compare time, and SQLite compares it numerically, so the seek still
 *  binds correctly on both dialects. */
export const encodeCursor = (values: unknown[]): string => {
  const safe = values.map((v) => (typeof v === "bigint" ? v.toString() : v));
  return Buffer.from(JSON.stringify(safe), "utf8").toString("base64url");
};

/** Decode a cursor back into its boundary tuple. Throws VALIDATION on garbage
 *  so a hand-edited / stale cursor is a 422, not a 500. */
export const decodeCursor = (cursor: string): unknown[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new AppError("VALIDATION", "Malformed pagination cursor");
  }
  if (!Array.isArray(parsed)) {
    throw new AppError("VALIDATION", "Malformed pagination cursor");
  }
  return parsed;
};

/**
 * Build the keyset boundary predicate for an ORDER-BY tuple + the previous
 * page's last-row values. Uses the lexicographic OR-expansion rather than a
 * row-value comparison `(a,b) < (x,y)` because the latter only models the
 * all-same-direction case — the expansion handles mixed `asc`/`desc` and binds
 * identically on SQLite (D1) and Postgres.
 *
 *   ( r0 OP0 v0 )
 *   OR ( r0 = v0 AND r1 OP1 v1 )
 *   OR ( r0 = v0 AND r1 = v1 AND r2 OP2 v2 )
 *   …
 *
 * where OPi is `>` for an ascending column and `<` for a descending one.
 */
export const keysetWhere = (parts: KeysetPart[], values: unknown[]): SQL => {
  if (parts.length === 0 || parts.length !== values.length) {
    // A length mismatch means the cursor was minted under a different sort —
    // refuse rather than silently paginate the wrong axis.
    throw new AppError("VALIDATION", "Cursor does not match the requested sort");
  }
  const ors: SQL[] = [];
  for (let i = 0; i < parts.length; i++) {
    const ands: SQL[] = [];
    for (let j = 0; j < i; j++) {
      ands.push(sql`${parts[j]!.ref} = ${values[j]}`);
    }
    const op = parts[i]!.dir === "asc" ? sql.raw(">") : sql.raw("<");
    ands.push(sql`${parts[i]!.ref} ${op} ${values[i]}`);
    ors.push(sql`(${sql.join(ands, sql` AND `)})`);
  }
  return sql`(${sql.join(ors, sql` OR `)})`;
};
