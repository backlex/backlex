import { sql, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { FieldDef } from "@backlex/db";
import {
  denseRenumber,
  hasOrderTies,
  type OrderPlacement,
  type OrderSpec,
  planOrderMove,
} from "@backlex/db/order";
import type { Ctx } from "../../context";
import {
  deletedFilter,
  execute,
  pkEq,
  queryAll,
  tenantFilter,
  whereOf,
} from "./sql-helpers";

/**
 * The parts of a collection an ordering statement needs.
 *
 * Structural rather than the items layer's `CollectionRow` because GraphQL
 * carries its own, narrower row shape — and the whole point of the parity gate
 * is that both surfaces reach THIS code instead of hand-writing a second copy
 * of the shift arithmetic. Anything either row type has is accepted; only these
 * fields are read.
 */
export interface OrderCollection {
  slug: string;
  physicalTable: string;
  pkColumn: string;
  fields: FieldDef[];
  tenantScoped: boolean;
  softDelete: boolean;
  hasCreatedAt: boolean;
  /** Adopted tables may call it something else; managed ones never do. */
  createdAtColumn?: string | null;
}

/**
 * Maintaining the position column — appending a new row to the end of its list,
 * moving one row without renumbering the rest, and repairing a column of ties.
 *
 * The pure half (the spec, the move arithmetic, the tie test) lives in
 * `@backlex/db/order`, so the admin's drop handler and the server's UPDATE run
 * the same planner. This module is the SQL half.
 *
 * @see `@backlex/db/order` for why positions are dense integers rather than
 * sparse ones, and why ties are the one state the shift cannot survive.
 */

/** An order field, paired with its spec, for the paths that iterate them. */
export interface OrderField {
  name: string;
  spec: OrderSpec;
}

/** The order fields on a collection, in declaration order. */
export const orderFieldsOf = (fields: FieldDef[]): OrderField[] =>
  fields.flatMap((f) => (f.order ? [{ name: f.name, spec: f.order }] : []));

/** Find one order field by name, or throw the 422 a route wants. */
export const requireOrderField = (
  collection: OrderCollection,
  fieldName: string,
): OrderField => {
  const field = collection.fields.find((f) => f.name === fieldName);
  if (!field?.order) {
    throw new AppError(
      "VALIDATION",
      `"${fieldName}" is not an order field on "${collection.slug}"`,
    );
  }
  return { name: field.name, spec: field.order };
};

/**
 * Assert the caller may actually rearrange this list, before anything is
 * renumbered. Both checks were found by the security review of this feature's
 * own code, and both are about the same thing: **an ordering operation writes
 * rows the caller never named.**
 *
 * 1. **Field allow-list.** `PATCH /:slug/:id` refuses a write to a column
 *    outside `perm.fields` (see `validateBody`), so a role granted
 *    `update` on `menu_items` with `fields: ["title"]` — the natural way to say
 *    "may rename entries, may not rearrange the menu" — is correctly refused
 *    there. `reorder` writes the same column by another door, so it has to ask
 *    the same question or the allow-list silently stops being a boundary.
 *
 * 2. **Row condition.** A renumber is only coherent over a WHOLE list. The
 *    bundled self-service roles condition `update` on the row
 *    (`app_user_id = $user.id`), and neither answer is acceptable for such a
 *    caller: ignoring the condition writes other people's rows, and applying it
 *    renumbers a subset that then collides with the rows it skipped — the list
 *    comes out *less* ordered than it started. So the operation is REFUSED, in
 *    the same spirit as money refusing to compare two currencies rather than
 *    answering wrong. Rearranging a shared list is a whole-list privilege.
 *
 * @throws AppError("FORBIDDEN")
 */
export const assertCanRearrange = (
  collection: OrderCollection,
  field: OrderField,
  perm: { whereSql?: unknown; fields: Set<string> | null },
): void => {
  if (perm.fields && !perm.fields.has(field.name)) {
    // Same wording as the write path's refusal, so the two read as one rule.
    throw new AppError("FORBIDDEN", `No permission to write field "${field.name}"`);
  }
  if (perm.whereSql != null) {
    throw new AppError(
      "FORBIDDEN",
      `Rearranging "${collection.slug}" renumbers rows other than the one you moved, so it needs update permission on every row of the collection — your role's update is limited to some of them.`,
    );
  }
};

/** Scope column types that are stored as text, and can therefore hold the
 *  empty string as well as NULL. Comparing a `bigint` or a `boolean` column to
 *  `''` is a hard error on Postgres, so the empty-string arm below is added
 *  only for these. */
const TEXTUAL_SCOPES = new Set(["relation", "text", "uuid"]);

/**
 * "This row is in the same list as that one", as SQL.
 *
 * Two traps live in this one expression, and both produce the SAME symptom — a
 * whole list of rows tied on position 1, handed out by the very code written to
 * prevent ties.
 *
 *  1. **`col = NULL` is never true** in either dialect, so an unparented row
 *    compared that way finds no maximum and falls back to 1. Same class of trap
 *    as the sequence table's NOT NULL scope key, where a nullable column
 *    silently defeated `ON CONFLICT`.
 *  2. **"No parent" has two spellings.** A relation cleared in the admin form
 *    arrives as `""` and is stored as `""`, not NULL. Matching only `IS NULL`
 *    looks in an empty partition while the rows sit one spelling over — which
 *    is exactly what the first real-screen pass caught, after a unit test that
 *    OMITTED the column (and so wrote NULL) had passed. So the empty case
 *    matches both, and `sameScope` normalizes the two the same way.
 *
 * Returns null for an unscoped field, so it composes through `whereOf`.
 */
export const orderScopeFilter = (
  collection: OrderCollection,
  spec: OrderSpec,
  scopeValue: unknown,
): SQL | null => {
  if (!spec.scope) return null;
  const col = sql.identifier(spec.scope);
  if (scopeValue !== null && scopeValue !== undefined && scopeValue !== "") {
    return sql`${col} = ${scopeValue}`;
  }
  const type = collection.fields.find((f) => f.name === spec.scope)?.type ?? "text";
  return TEXTUAL_SCOPES.has(type)
    ? sql`(${col} IS NULL OR ${col} = ${""})`
    : sql`${col} IS NULL`;
};

/**
 * The scope filter plus everything that bounds "the same list" physically.
 *
 * Soft-deleted rows are deliberately INCLUDED. A deleted row still occupies its
 * position, and excluding it would let the next append reuse a number that comes
 * back the moment the row is restored — two rows on one position, which is
 * precisely the state that defeats a move. A gap costs nothing; a collision
 * costs the ordering.
 */
const listFilter = (
  collection: OrderCollection,
  tenantId: string | null | undefined,
  spec: OrderSpec,
  scopeValue: unknown,
): SQL =>
  whereOf(
    orderScopeFilter(collection, spec, scopeValue),
    tenantFilter(collection, { tenantId: tenantId ?? null, roles: [] }),
  );

/**
 * The INSERT value that appends a row to the end of its list.
 *
 * A subquery rather than a number this process read first, and that is the
 * point: the DATABASE evaluates it at insert time, so the second of two rows
 * inserted in one batch sees the first, and two concurrent creates serialize
 * against each other instead of both reading the same maximum. Same reasoning as
 * the rollup refresh being one self-contained `UPDATE … SET col = (SELECT …)`.
 *
 * Deliberately NOT narrowed by the caller's row-level permission. The question
 * is "what is the last position in this list", and a row the caller may not read
 * still occupies one — narrowing it would hand an end-user's new row a position
 * somebody else already has. Nothing about another row is disclosed: the value
 * that comes back is one integer, and it is written, not returned.
 */
export const appendPositionSql = (
  collection: OrderCollection,
  tenantId: string | null | undefined,
  field: OrderField,
  scopeValue: unknown,
): SQL =>
  sql`(SELECT COALESCE(MAX(${sql.identifier(field.name)}), 0) + 1 FROM ${sql.identifier(
    collection.physicalTable,
  )} ${listFilter(collection, tenantId, field.spec, scopeValue)})`;

/**
 * `ORDER BY` that reads a list the way it is meant to read, on both dialects.
 *
 * Three clauses, and each earns its place:
 *
 *  - The `CASE` is not decoration. Postgres sorts NULLs LAST on an ascending
 *    sort and SQLite sorts them FIRST, so a column with any unset position reads
 *    in a different order on the two backends — and normalize would then hand
 *    back a different arrangement depending on where it ran.
 *  - `created_at` breaks position ties, and this is the clause that decides
 *    whether the repair is any good. The lists that need it are the ones where
 *    EVERY position is the same 0, so the position clause orders nothing and the
 *    tiebreak IS the answer. Falling through to the primary key alone would sort
 *    a curriculum by the random UUIDs of its lessons — stable, and completely
 *    unrelated to the order anybody put them in. Insertion order is what an
 *    operator saw before the pass ran, and it is what they meant.
 *  - The primary key last, so the result is total even on a collection with no
 *    created_at column (an adopted table may have none).
 *
 * The honest limit: `created_at` has millisecond resolution, so rows written
 * inside the same millisecond — a bulk import, a restore — fall through to the
 * primary key and come out in an order nothing chose. There is no portable
 * monotonic tiebreak to reach for, and the case is not as bad as it sounds:
 * a bulk write that had an order to preserve states its positions, and one that
 * states none never had an intended order for this pass to lose.
 */
const listOrder = (collection: OrderCollection, positionCol: string): SQL => {
  const createdAt = collection.hasCreatedAt
    ? (collection.createdAtColumn ?? "created_at")
    : null;
  const pos = sql.identifier(positionCol);
  return sql`ORDER BY CASE WHEN ${pos} IS NULL THEN 1 ELSE 0 END ASC, ${pos} ASC${
    createdAt ? sql`, ${sql.identifier(createdAt)} ASC` : sql``
  }, ${sql.identifier(collection.pkColumn)} ASC`;
};

/**
 * How many rows one list may hold before the repair paths refuse it.
 *
 * Renumbering is inherently whole-scope — there is no way to break a tie without
 * rewriting values — so it cannot be paged the way the email/phone normalizers
 * can. Ten thousand is far past any list a person arranges by hand, and refusing
 * with a message beats silently rewriting a table nobody expected to be touched.
 */
export const MAX_ORDERED_SCOPE = 10_000;

/** Bound-parameter budget per statement — D1 caps at ~100. Same constant and
 *  the same reason as `services/analytics.ts`. */
const PARAM_BUDGET = 90;

/**
 * Rewrite one list's positions to 1…N, in the order it currently reads.
 *
 * Emitted as chunked `CASE` statements rather than one UPDATE per row: a
 * hundred-row list is four statements instead of a hundred, and each stays under
 * the bound-parameter cap. Rows whose number does not change are skipped, so a
 * list that is already dense costs nothing to re-normalize — which is what makes
 * it safe for `reorder` to call speculatively.
 *
 * Returns the number of rows actually renumbered.
 */
const renumberScope = async (
  ctx: Ctx,
  collection: OrderCollection,
  tenantId: string | null | undefined,
  field: OrderField,
  scopeValue: unknown,
): Promise<number> => {
  const table = sql.identifier(collection.physicalTable);
  const col = sql.identifier(field.name);
  const pk = sql.identifier(collection.pkColumn);
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${pk} AS id, ${col} AS pos FROM ${table} ${listFilter(
      collection,
      tenantId,
      field.spec,
      scopeValue,
    )} ${listOrder(collection, field.name)} LIMIT ${MAX_ORDERED_SCOPE + 1}`,
  );
  if (rows.length > MAX_ORDERED_SCOPE) {
    throw new AppError(
      "VALIDATION",
      `"${collection.slug}.${field.name}" has more than ${MAX_ORDERED_SCOPE} rows in one list — a manual order that large cannot be repaired in one pass. Narrow it with "order.scope".`,
    );
  }
  const current = new Map<string, number | null>();
  for (const r of rows) {
    const raw = r.pos;
    current.set(
      String(r.id),
      raw === null || raw === undefined ? null : Number(raw),
    );
  }
  const changed = denseRenumber(rows.map((r) => String(r.id))).filter(
    (t) => current.get(t.id) !== t.position,
  );
  if (changed.length === 0) return 0;

  // Three bound params per row (the CASE key, the CASE result, the IN entry).
  const perStatement = Math.max(1, Math.floor(PARAM_BUDGET / 3));
  for (let i = 0; i < changed.length; i += perStatement) {
    const slice = changed.slice(i, i + perStatement);
    const cases = sql.join(
      slice.map((t) => sql`WHEN ${t.id} THEN ${t.position}`),
      sql` `,
    );
    const ids = sql.join(
      slice.map((t) => sql`${t.id}`),
      sql`, `,
    );
    // The scope is restated on the UPDATE rather than trusting the ids the
    // SELECT returned: they are two statements, and an id is not an
    // authorization. Same rule the email normalizer follows.
    await execute(
      ctx,
      sql`UPDATE ${table} SET ${col} = CASE ${pk} ${cases} ELSE ${col} END ${whereOf(
        sql`${pk} IN (${ids})`,
        orderScopeFilter(collection, field.spec, scopeValue),
        tenantFilter(collection, { tenantId: tenantId ?? null, roles: [] }),
      )}`,
    );
  }
  return changed.length;
};

/** One row's position and the list it is in. */
interface OrderedRow {
  id: string;
  position: number | null;
  scope: unknown;
}

/**
 * Load a row's position and scope under the caller's full read scope.
 *
 * `extra` carries `perm.whereSql` — a reorder is an `update`, and holding update
 * on a collection is not holding it on every row.
 */
const loadOrderedRow = async (
  ctx: Ctx,
  collection: OrderCollection,
  tenantId: string | null | undefined,
  field: OrderField,
  id: string,
  extra: SQL | null | undefined,
): Promise<OrderedRow | null> => {
  const scopeSel = field.spec.scope
    ? sql`, ${sql.identifier(field.spec.scope)} AS scope_value`
    : sql``;
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${sql.identifier(collection.pkColumn)} AS id, ${sql.identifier(
      field.name,
    )} AS pos${scopeSel} FROM ${sql.identifier(collection.physicalTable)} ${whereOf(
      pkEq(collection.pkColumn, id),
      extra,
      tenantFilter(collection, { tenantId: tenantId ?? null, roles: [] }),
      deletedFilter(collection),
    )} LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  const raw = row.pos;
  return {
    id: String(row.id),
    position: raw === null || raw === undefined ? null : Number(raw),
    scope: field.spec.scope ? (row.scope_value ?? null) : null,
  };
};

export interface ReorderResult {
  /** The position the row ended up on. */
  position: number;
  /** Rows that stepped aside to make room. */
  shifted: number;
  /** Rows renumbered by the tie repair that ran first, if any. */
  repaired: number;
}

/**
 * Move one row to sit immediately before or after another in the same list.
 *
 * Three phases, and the first is the one that is easy to leave out:
 *
 *  1. **Repair.** If the list holds duplicate (or NULL) positions, the shift
 *     cannot work — `pos >= 1` over a column of zeros moves nothing and the row
 *     lands at the end instead of where it was dropped. Every collection that
 *     has ever used a `position` column is in exactly that state, so the move
 *     renumbers its own list first rather than failing on data it can fix.
 *  2. **Shift.** One set-wise UPDATE moves the span between the old slot and the
 *     new one out of the way.
 *  3. **Place.** One UPDATE puts the row on the freed position.
 *
 * The two writes restate the tenant scope and the moving row's id; the caller's
 * ROW CONDITION is not restated, and does not need to be, because
 * {@link assertCanRearrange} has already refused any caller who has one. That
 * order matters — the repair in phase 1 rewrites the whole list, so a
 * conditioned caller reaching this function at all would be the bug. The gate is
 * the boundary; these statements are inside it.
 */
export const reorderItem = async (
  ctx: Ctx,
  collection: OrderCollection,
  tenantId: string | null | undefined,
  field: OrderField,
  args: { id: string; anchorId: string; place: OrderPlacement },
  permWhere: SQL | null | undefined,
): Promise<ReorderResult> => {
  if (args.id === args.anchorId) {
    throw new AppError("VALIDATION", "A row cannot be moved relative to itself");
  }
  const moving = await loadOrderedRow(ctx, collection, tenantId, field, args.id, permWhere);
  if (!moving) {
    throw new AppError("NOT_FOUND", `No row "${args.id}" you can reorder`);
  }
  const anchor = await loadOrderedRow(
    ctx,
    collection,
    tenantId,
    field,
    args.anchorId,
    permWhere,
  );
  if (!anchor) {
    throw new AppError("NOT_FOUND", `No row "${args.anchorId}" to move relative to`);
  }
  // A move ACROSS lists is a different operation with a different meaning: it
  // changes which parent the row belongs to, which is a write to the scope
  // column and belongs in a PATCH. Silently accepting it here would leave the
  // row in its old list at a position taken from another one.
  if (field.spec.scope && !sameScope(moving.scope, anchor.scope)) {
    throw new AppError(
      "VALIDATION",
      `Both rows must be in the same "${field.spec.scope}" — moving a row between lists is a change to "${field.spec.scope}", not a reorder`,
    );
  }
  const scopeValue = moving.scope;

  const table = sql.identifier(collection.physicalTable);
  const col = sql.identifier(field.name);
  const pk = sql.identifier(collection.pkColumn);

  const positions = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${col} AS pos FROM ${table} ${listFilter(
      collection,
      tenantId,
      field.spec,
      scopeValue,
    )} LIMIT ${MAX_ORDERED_SCOPE + 1}`,
  );
  let repaired = 0;
  let from = moving.position;
  let anchorPos = anchor.position;
  if (
    positions.length > MAX_ORDERED_SCOPE ||
    hasOrderTies(
      positions.map((r) => (r.pos === null || r.pos === undefined ? null : Number(r.pos))),
    )
  ) {
    repaired = await renumberScope(ctx, collection, tenantId, field, scopeValue);
    // Re-read both endpoints: the repair moved them, and planning against the
    // positions they had BEFORE it would place the row against numbers no row
    // holds any more.
    const [m, a] = await Promise.all([
      loadOrderedRow(ctx, collection, tenantId, field, args.id, permWhere),
      loadOrderedRow(ctx, collection, tenantId, field, args.anchorId, permWhere),
    ]);
    if (!m || !a) {
      throw new AppError("NOT_FOUND", "The rows moved while the list was being repaired");
    }
    from = m.position;
    anchorPos = a.position;
  }
  if (from === null || anchorPos === null) {
    // Only reachable if the repair itself could not produce a number, which
    // means something else is writing the column concurrently.
    throw new AppError("CONFLICT", "The list could not be put in a usable order — try again");
  }

  const move = planOrderMove(from, anchorPos, args.place);
  if (!move) return { position: from, shifted: 0, repaired };

  let shifted = 0;
  if (move.shiftFrom <= move.shiftTo) {
    // The plan's span never contains the moving row, but it is excluded by id
    // anyway: a duplicate position that survived the repair would otherwise let
    // the shift carry the mover along with the rows it is supposed to pass.
    await execute(
      ctx,
      sql`UPDATE ${table} SET ${col} = ${col} + ${move.delta} ${whereOf(
        sql`${col} >= ${move.shiftFrom}`,
        sql`${col} <= ${move.shiftTo}`,
        sql`${pk} <> ${args.id}`,
        orderScopeFilter(collection, field.spec, scopeValue),
        permWhere,
        tenantFilter(collection, { tenantId: tenantId ?? null, roles: [] }),
      )}`,
    );
    shifted = move.shiftTo - move.shiftFrom + 1;
  }
  await execute(
    ctx,
    sql`UPDATE ${table} SET ${col} = ${move.target} ${whereOf(
      pkEq(collection.pkColumn, args.id),
      permWhere,
      tenantFilter(collection, { tenantId: tenantId ?? null, roles: [] }),
      deletedFilter(collection),
    )}`,
  );
  return { position: move.target, shifted, repaired };
};

/** Whether two rows are in the same list. Compared as strings so an id that
 *  arrives as a number from one driver and a string from another still matches
 *  itself; null and "no parent" are the same list. */
export const sameScope = (a: unknown, b: unknown): boolean => {
  const norm = (v: unknown) => (v === null || v === undefined || v === "" ? "" : String(v));
  return norm(a) === norm(b);
};

/**
 * Read back the positions the database just assigned, for one row.
 *
 * The append is a subquery precisely so this process never decides the number —
 * which means the number is not knowable until the statement has run. Without
 * this read the 201 body, the realtime event, the activity row and the client's
 * offline store would all carry no position at all, while the column held one:
 * the same "canonicalize on the payload, not just in the column" rule that geo,
 * money, phone and email each had to learn.
 *
 * Callers skip it while COLLECTING an atomic batch — nothing has executed yet,
 * so there is nothing to read, and the batch response is a summary either way.
 */
export const readBackPositions = async (
  ctx: Ctx,
  collection: OrderCollection,
  id: string,
  fields: OrderField[],
  db?: unknown,
): Promise<Record<string, number>> => {
  if (fields.length === 0) return {};
  const cols = sql.join(
    fields.map((f) => sql.identifier(f.name)),
    sql`, `,
  );
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${cols} FROM ${sql.identifier(collection.physicalTable)} ${whereOf(
      pkEq(collection.pkColumn, id),
    )} LIMIT 1`,
    db,
  );
  const row = rows[0];
  if (!row) return {};
  const out: Record<string, number> = {};
  for (const f of fields) {
    const raw = row[f.name];
    if (raw !== null && raw !== undefined && Number.isFinite(Number(raw))) {
      out[f.name] = Number(raw);
    }
  }
  return out;
};

export interface NormalizeResult {
  /** Distinct lists examined. */
  scopes: number;
  /** Rows whose position changed. */
  renumbered: number;
}

/**
 * Put every list in a collection into dense 1…N order.
 *
 * The counterpart to `sequences/sync`, and it closes the same kind of hole: a
 * column that arrived from somewhere the write path never saw. Here that is
 * every workspace created before this feature existed — twenty-nine template
 * columns declared `default: 0`, so every row shares one position and the
 * "default sort" over them is whatever the planner felt like returning.
 *
 * Unlike the email and phone normalizers this cannot be paged WITHIN a list —
 * breaking a tie means rewriting the whole list — so it walks list by list and
 * refuses any single one larger than {@link MAX_ORDERED_SCOPE}.
 *
 * The row ORDER is preserved as faithfully as it can be: the current position
 * first, then insertion order — see {@link listOrder} for why the tiebreak is
 * the whole answer on exactly the lists that need repairing.
 */
export const normalizeOrderField = async (
  ctx: Ctx,
  collection: OrderCollection,
  tenantId: string | null | undefined,
  field: OrderField,
): Promise<NormalizeResult> => {
  const table = sql.identifier(collection.physicalTable);
  const tenant = tenantFilter(collection, { tenantId: tenantId ?? null, roles: [] });
  let scopeValues: unknown[] = [null];
  if (field.spec.scope) {
    const rows = await queryAll<Record<string, unknown>>(
      ctx,
      sql`SELECT DISTINCT ${sql.identifier(field.spec.scope)} AS scope_value FROM ${table} ${whereOf(tenant)}`,
    );
    // Collapse the two spellings of "no parent" (see `orderScopeFilter`) —
    // otherwise `DISTINCT` reports NULL and `""` as separate lists, and the
    // pass renumbers the same rows twice while claiming one more scope than
    // exists.
    const seen = new Set<string>();
    scopeValues = [];
    for (const r of rows) {
      const raw = r.scope_value;
      const value = raw === undefined || raw === "" ? null : raw;
      const key = value === null ? " null" : String(value);
      if (seen.has(key)) continue;
      seen.add(key);
      scopeValues.push(value);
    }
  }
  let renumbered = 0;
  for (const value of scopeValues) {
    renumbered += await renumberScope(ctx, collection, tenantId, field, value);
  }
  return { scopes: scopeValues.length, renumbered };
};
