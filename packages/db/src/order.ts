/**
 * Manual ordering — the position a row sits at in a list somebody arranged by
 * hand, and the arithmetic that moves one row without disturbing the rest.
 *
 * Everything in this module is PURE: the spec, its validation, and the plan a
 * move compiles to. Nothing here imports anything, which is why
 * `@backlex/db/order` is its own package export — reaching it through the
 * package root would drag the migration bundles, and their `*.sql` imports, into
 * the browser build. The admin's drag handler runs the SAME planner the server
 * executes from, so the row lands where the drop preview said it would.
 *
 * ## The shape of the problem
 *
 * Twenty-nine `integer` columns across twenty-eight collections in thirteen of
 * the twenty-seven schema templates exist to hold a hand-arranged order:
 * `position` on menu items, categories, product options and variants, pipeline
 * stages, SLAs, escalation rules, curriculum modules and lessons, quiz
 * questions, form questions, hiring stages, checklist items and BOM operations.
 * Twenty-five of those collections go further and declare `defaultSort:
 * "position"` — the third most common default sort in the whole catalog, after
 * `name` and `-created_at`.
 *
 * Every single one of them is declared `default: 0`.
 *
 * So the catalog says "sort these by hand" and then makes it impossible:
 *
 *  - **Every new row lands at 0**, tied with every other row that was never
 *    positioned. A "default sort" over a column where most values are equal is
 *    not an order at all — it is whatever the query planner returned, and it can
 *    differ between two identical requests.
 *  - **Nothing renumbers.** Putting a lesson between the third and the fourth
 *    means editing the fourth, the fifth and everything after it, by hand, in a
 *    form, one row at a time — and getting one wrong silently reorders the rest.
 *  - **The admin can drag-reorder its schema fields, its collections, its list
 *    columns and its form blocks** — but not the rows whose entire purpose is to
 *    be in an order. The one list a customer sees is the one nobody could
 *    arrange.
 *
 * ## Why this is a spec on an integer, not a new field type
 *
 * A position is an integer and stays one. Making `order` a {@link FieldType}
 * would buy nothing — the storage is identical in both dialects — and would cost
 * a new entry in every exhaustive `Record<FieldType>` in the codebase, which is
 * the shape of bug that once took the whole GraphQL endpoint down (see
 * `isKnownFieldType`). So an order field is an ordinary `integer` column
 * carrying an {@link OrderSpec}, exactly as a document number is an ordinary
 * `text` column carrying a `SequenceSpec`. All twenty-nine template columns
 * adopt it as metadata, with no migration and no DDL.
 *
 * ## Dense and unique, and why that is the whole design
 *
 * Within a scope, positions are kept dense-ish and — this is the load-bearing
 * half — UNIQUE. That is what lets a move be two set-wise statements instead of
 * a renumber of everything:
 *
 *     UPDATE t SET pos = pos + 1 WHERE <scope> AND pos BETWEEN a AND b   -- shift
 *     UPDATE t SET pos = :target WHERE id = :id                          -- place
 *
 * Gaps are harmless: a delete leaves one and the plan still lands the row in the
 * right place, because the arithmetic reasons about VALUES, not about ranks.
 * Ties are not harmless — they are the one thing that defeats it, since a shift
 * `WHERE pos >= 1` over a column of all-zeros moves nothing and the row lands at
 * the end instead of where it was dropped.
 *
 * Which is exactly the state every existing workspace is in. So `order/normalize`
 * is not an optional maintenance route: it is the same hole `sequences/sync`
 * closes for adopted tables, and reorder repairs the scope it is about to touch
 * before touching it.
 *
 * The alternative — sparse positions with a midpoint insert, so a move is one
 * statement — was rejected for a reason that is about people rather than
 * machines: it writes 1024, 2048, 3072 into a column an operator can see and
 * type into, and every template already means 1, 2, 3.
 *
 * @module
 */

/**
 * Declares that an `integer` column is the manual order of a list.
 *
 * Lives on the position field itself. Everything about the column stays what it
 * was — sortable, filterable, an ordinary number — and what the declaration buys
 * is that the server maintains it: a new row appends to the end of its list
 * instead of landing on 0, a row moved between parents re-appends, and
 * `POST /:slug/reorder` can move one row without the caller renumbering the rest.
 */
export interface OrderSpec {
  /**
   * The sibling column that partitions the sequence — the parent a list belongs
   * to. `lessons.position` scoped by `module` numbers each module's lessons
   * 1, 2, 3 independently; without it every lesson in the workspace shares one
   * numbering, which is right for a top-level list (pipelines, SLAs) and wrong
   * for anything nested.
   *
   * A `relation` is the common case, but a `text` dropdown is deliberately
   * allowed too: ordering cards WITHIN a Kanban column is a partition by status,
   * and it is the same operation.
   *
   * Deliberately ONE column, not a list. A deeper partition ("within the course,
   * then within the module") is a modelling question with a real answer — order
   * within the NEAREST parent — and supporting two would mostly serve schemas
   * that had not picked one.
   */
  scope?: string;
}

/** True when this field is the manual order of a list. */
export const isOrdered = (field: { order?: OrderSpec }): boolean => Boolean(field.order);

/**
 * Column types a scope may be. The question a scope asks is "which rows are in
 * the same list as this one", so it has to be a value that equality answers
 * honestly:
 *
 *  - `relation` / `uuid` / `text` / `integer` / `boolean` — an id, a choice, a
 *    flag. All fine.
 *  - `number` is out because two floats that print the same need not be equal,
 *    so a list could silently split in half.
 *  - `timestamp` is out because equality on an instant partitions nothing anyone
 *    meant — every row would be its own list.
 *  - `json` / `geo` / `money` / `relation_many` / `file` / `longtext` / `hash`
 *    are out because none of them compares as a scalar at all.
 */
const SCOPE_TYPES = new Set(["relation", "uuid", "text", "integer", "boolean"]);

/**
 * Reject a malformed {@link OrderSpec} at schema-save time.
 *
 * `fieldTypes` is the collection's OTHER fields by name. Naming a scope column
 * that does not exist is the mistake worth catching here, because its only other
 * symptom is an append that silently numbers the whole collection as one list —
 * which looks like it worked until two modules' lessons interleave.
 *
 * @throws Error naming the problem.
 */
export const validateOrderSpec = (
  spec: OrderSpec,
  ctx: { fieldName: string; fieldTypes: Record<string, string> },
): void => {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error("`order` must be an object");
  }
  if (spec.scope === undefined) return;
  if (typeof spec.scope !== "string" || !spec.scope) {
    throw new Error("`order.scope` must be a field name");
  }
  if (spec.scope === ctx.fieldName) {
    throw new Error("`order.scope` cannot be the order column itself");
  }
  const scopeType = ctx.fieldTypes[spec.scope];
  if (scopeType === undefined) {
    throw new Error(`\`order.scope\` names an unknown field: ${spec.scope}`);
  }
  if (!SCOPE_TYPES.has(scopeType)) {
    throw new Error(
      `\`order.scope\` must be a relation, text, integer, uuid or boolean field ("${spec.scope}" is ${scopeType})`,
    );
  }
};

/** Where a move puts the row relative to the anchor it names. */
export type OrderPlacement = "before" | "after";

/**
 * The two statements a move compiles to.
 *
 * `shiftFrom > shiftTo` means the span is empty and the shift statement should
 * be skipped entirely — which is the common "moved it one place" case, and the
 * reason a short list costs a single row update.
 */
export interface OrderMove {
  /** The position the moving row lands on. */
  target: number;
  /** Inclusive lower bound of the rows that step aside. */
  shiftFrom: number;
  /** Inclusive upper bound of the rows that step aside. */
  shiftTo: number;
  /** Which way they step. */
  delta: 1 | -1;
}

/** True when a plan's shift span holds no rows and only the placement runs. */
export const isEmptyShift = (move: OrderMove): boolean => move.shiftFrom > move.shiftTo;

/**
 * Where a row lands, and which span steps aside to make room.
 *
 * Reasons about the position VALUES rather than about ranks, which is what makes
 * gaps harmless: with positions `1, 5, 9, 12`, dropping the last row after the
 * first shifts `5` and `9` up by one and places the row at `2`. The order is
 * right and nothing was renumbered.
 *
 * The span never includes the moving row itself, in any of the four cases — the
 * caller still excludes it by id, because a duplicate position (the state
 * `normalize` exists to fix) would otherwise let the shift carry the mover along
 * with the rows it was supposed to pass.
 *
 * Returns null when the row is already where it was asked to go, so a no-op drop
 * writes nothing at all.
 *
 * @param from   the moving row's current position
 * @param anchor the position of the row it was dropped next to
 */
export const planOrderMove = (
  from: number,
  anchor: number,
  place: OrderPlacement,
): OrderMove | null => {
  if (from === anchor) return null;
  if (place === "after") {
    return from > anchor
      ? // Moving earlier: everything from just after the anchor up to just
        // before the old slot steps up one, and the row takes anchor + 1.
        { target: anchor + 1, shiftFrom: anchor + 1, shiftTo: from - 1, delta: 1 }
      : // Moving later: everything from just after the old slot through the
        // anchor steps down one, freeing the anchor's own position.
        { target: anchor, shiftFrom: from + 1, shiftTo: anchor, delta: -1 };
  }
  return from > anchor
    ? { target: anchor, shiftFrom: anchor, shiftTo: from - 1, delta: 1 }
    : { target: anchor - 1, shiftFrom: from + 1, shiftTo: anchor - 1, delta: -1 };
};

/**
 * Renumber a scope densely from 1, in the order the rows are currently in.
 *
 * Takes ids already sorted the way the list reads (position, then primary key —
 * the tiebreak matters, since the whole reason to run this is that positions are
 * tied) and returns only the rows whose number actually changes. A scope that is
 * already dense produces an empty list, so normalize is cheap to re-run and
 * cheap to call speculatively before a move.
 */
export const denseRenumber = (orderedIds: readonly string[]): { id: string; position: number }[] => {
  const out: { id: string; position: number }[] = [];
  for (let i = 0; i < orderedIds.length; i++) {
    out.push({ id: orderedIds[i]!, position: i + 1 });
  }
  return out;
};

/**
 * The same move, applied to a page of rows the user can see — the optimistic
 * half of a drag.
 *
 * Two things differ from {@link planOrderMove}, and both come from the fact that
 * this runs against a LIST rather than against a table:
 *
 *  - It works on array order, because array order is what the operator is
 *    looking at. The row lands where it was dropped, immediately, and the server
 *    catches up.
 *  - The positions it writes are the ones the page ALREADY holds, redistributed.
 *    Nothing is invented: the set of numbers on screen is unchanged and stays
 *    ascending, so a visible `position` column does not flicker through values
 *    the database never had before the refetch replaces them.
 *
 * Requires the page to be sorted by the order column ascending, which is also
 * the condition for offering the drag at all — dragging a list that is sorted by
 * something else is a gesture with no meaning.
 *
 * Returns null when either id is absent from the page, or the move is a no-op.
 */
export const reorderVisible = <T extends { id: string; position: number | null }>(
  rows: readonly T[],
  id: string,
  anchorId: string,
  place: OrderPlacement,
): T[] | null => {
  const from = rows.findIndex((r) => r.id === id);
  const anchor = rows.findIndex((r) => r.id === anchorId);
  if (from < 0 || anchor < 0 || from === anchor) return null;
  const next = rows.slice();
  const [moved] = next.splice(from, 1);
  if (!moved) return null;
  // The anchor's index shifts down by one when the row removed sat above it.
  const anchorAfterRemoval = from < anchor ? anchor - 1 : anchor;
  const insertAt = place === "before" ? anchorAfterRemoval : anchorAfterRemoval + 1;
  next.splice(insertAt, 0, moved);
  const positions = rows.map((r) => r.position);
  return next.map((r, i) => ({ ...r, position: positions[i] ?? r.position }));
};

/**
 * Whether a list of current positions needs normalizing before a move.
 *
 * Duplicates are the only disqualifier. Gaps are fine — {@link planOrderMove}
 * handles them — and so is starting at 7 rather than 1, because nothing about
 * the order depends on where it starts.
 */
export const hasOrderTies = (positions: readonly (number | null)[]): boolean => {
  const seen = new Set<number>();
  for (const p of positions) {
    // A NULL position is not a number and cannot be compared with one, so a
    // column holding any is exactly as unorderable as one holding ties.
    if (p === null || p === undefined || !Number.isFinite(p)) return true;
    if (seen.has(p)) return true;
    seen.add(p);
  }
  return false;
};
