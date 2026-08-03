/**
 * Date ranges — a period a row covers, and the ability to ask what clashes.
 *
 * Everything in this module is PURE: the interval grammar, the ordering rule,
 * and the rewrite that turns an overlap question into ordinary comparisons.
 * Nothing here imports anything, which is why `@backlex/db/range` is its own
 * package export — reaching it through the package root would drag the migration
 * bundles, and their `*.sql` imports, into the browser build.
 *
 * ## The shape of the problem
 *
 * Twenty-eight pairs of `timestamp` columns across fifteen of the twenty-seven
 * schema templates are a period: `starts_at`/`ends_at` on leases, promotions,
 * open houses, blocked times and availability blocks; `start_date`/`end_date` on
 * contracts, campaigns, sprints and leave requests; `period_start`/`period_end`
 * on invoices, payroll runs and payouts. Two columns, and nothing tying them
 * together, which left three things broken:
 *
 *  - **Overlap.** "Which leases clash with this one?" is the question every one
 *    of those collections exists to be asked, and every caller hand-wrote it.
 *    Worse, they hand-wrote it *differently*: whether a period ending at 10:00
 *    collides with one starting at 10:00 depends on a convention nobody had
 *    written down, and getting it wrong double-books a room.
 *  - **Open ends.** A contract with no `end_date` is one that is still running —
 *    but `end_date >= today` excludes NULL, so the obvious "currently active"
 *    filter silently drops exactly the rows that ARE active. This is the sharp
 *    one: the query looks right and returns a subset with nothing to mark it.
 *  - **Ordering.** Nothing stopped a row being saved with its end before its
 *    start. That takes a hand-written cross-field `validation.rule` per pair,
 *    and most templates did not carry one.
 *
 * #32 solved overlap for BOOKINGS, with a partial unique index — a real solution
 * that is not available to a lease, a sprint or a promotion.
 *
 * ## Why this is a spec on a pair, not a new column type
 *
 * A range is two values, and the obvious move — one column holding both (a PG
 * `tstzrange`, or JSON) — is the wrong one here three times over. SQLite has no
 * range type, so it would not be portable. All twenty-eight pairs would need a
 * data migration. And sorting or filtering by the start alone, which is the most
 * common thing anyone does with these columns, would get harder rather than
 * easier.
 *
 * So a range is DECLARED over columns that already exist: the start field
 * carries a {@link RangeSpec} naming its end column. Nothing moves, nothing is
 * migrated, `starts_at` stays an ordinary sortable timestamp, and all twenty-
 * eight pairs can adopt it as metadata.
 *
 * ## Why the operators are a rewrite and not a compiler branch
 *
 * `_overlaps` and `_covers` do not reach SQL as themselves. They are expanded
 * into `$and`/`$or` trees over the two real columns using operators the DSL
 * already has — `_lt`, `_gte`, `_null`.
 *
 * That single choice is what makes them work everywhere at once. The condition
 * DSL is evaluated by two independent implementations: compiled to SQL for
 * queries, and interpreted in JavaScript for realtime delivery and the
 * permission simulator. A new operator would have to be written twice, and the
 * two would eventually disagree — which is the trap #42 refused `$before` to
 * avoid. An expansion into existing operators cannot disagree with itself.
 *
 * Same move as `geo`'s squared distances: change the question into one the
 * machinery already answers, rather than teaching the machinery a new one.
 *
 * @module
 */

/**
 * Which endpoints a period includes.
 *
 * `"[)"` — **half-open, and the default.** The start is inside the period, the
 * end is not. This is the only convention under which back-to-back periods do
 * not collide: a room booked 09:00–10:00 and one booked 10:00–11:00 must both be
 * allowed, and under closed bounds they overlap at 10:00. Every range of
 * *instants* wants this.
 *
 * `"[]"` — **closed.** Both endpoints are inside. This is what a range of *days*
 * means: leave "from Monday to Friday" includes Friday, and a membership freeze
 * `ends_on` the day it ends. Storing those as half-open would need the end
 * pushed to the following midnight, which is exactly the off-by-one nobody
 * remembers to apply.
 */
export type RangeBounds = "[)" | "[]";

/** The default when a spec does not say — see {@link RangeBounds}. */
export const DEFAULT_BOUNDS: RangeBounds = "[)";

/**
 * A period declared over two columns that already exist.
 *
 * Lives on the START field; `end` names the other column. That mirrors how
 * `rollup` and `money` hang their configuration off one field, and it means the
 * range is addressed in a filter by the name people already use for it
 * (`starts_at`), not by a synthetic third name.
 */
export interface RangeSpec {
  /** The sibling column holding the end of the period. */
  end: string;
  /** Which endpoints are inside the period. Default `"[)"`. */
  bounds?: RangeBounds;
  /**
   * Reject a write whose end is before its start.
   *
   * On by default, because a period that ends before it begins is not a period,
   * and the alternative is a hand-written cross-field rule per pair that most
   * templates never had. Turn it off only for a column pair where the two dates
   * genuinely are independent.
   */
  ordered?: boolean;
}

/** True when this field declares a period. */
export const isRange = (field: { range?: RangeSpec }): boolean => Boolean(field.range);

/** The bounds a spec asks for, defaulted. */
export const boundsOf = (spec: RangeSpec | undefined): RangeBounds =>
  spec?.bounds === "[]" ? "[]" : DEFAULT_BOUNDS;

/**
 * Reject a malformed {@link RangeSpec} at schema-save time.
 *
 * `fieldTypes` is the collection's other fields by name; naming an end column
 * that does not exist — or one that is not a timestamp — is the mistake worth
 * catching here, because its only other symptom is an overlap filter that
 * compares against a column of something else and quietly answers wrong.
 *
 * @throws Error naming the problem.
 */
export const validateRangeSpec = (
  spec: RangeSpec,
  ctx: { fieldName: string; fieldTypes: Record<string, string> },
): void => {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error("`range` must be an object");
  }
  if (typeof spec.end !== "string" || !spec.end) {
    throw new Error("`range.end` (the column holding the end of the period) is required");
  }
  if (spec.end === ctx.fieldName) {
    throw new Error("`range.end` cannot be the start column itself");
  }
  const endType = ctx.fieldTypes[spec.end];
  if (endType === undefined) {
    throw new Error(`\`range.end\` names an unknown field: ${spec.end}`);
  }
  if (endType !== "timestamp") {
    throw new Error(
      `\`range.end\` must be a timestamp field ("${spec.end}" is ${endType})`,
    );
  }
  if (spec.bounds !== undefined && spec.bounds !== "[)" && spec.bounds !== "[]") {
    throw new Error('`range.bounds` must be "[)" or "[]"');
  }
  if (spec.ordered !== undefined && typeof spec.ordered !== "boolean") {
    throw new Error("`range.ordered` must be a boolean");
  }
};

/** A period as a caller states it in a filter. Either end may be omitted, which
 *  means "open in that direction" — `{ start: X }` alone asks for everything
 *  that has not finished by X. */
export interface RangeOperand {
  start?: unknown;
  end?: unknown;
}

/**
 * Coerce a `_overlaps` operand into {@link RangeOperand}.
 *
 * Accepts the object form and a two-element array (`[start, end]`), because a
 * pair is how a date-range picker hands one over and how `_between` already
 * reads. `null` in either slot is an explicit open end, and is preserved as
 * such rather than being dropped.
 *
 * @throws Error naming what was wrong.
 */
export const parseRangeOperand = (raw: unknown): RangeOperand => {
  if (Array.isArray(raw)) {
    if (raw.length !== 2) {
      throw new Error("expected a [start, end] pair");
    }
    return { start: raw[0] ?? undefined, end: raw[1] ?? undefined };
  }
  if (raw === null || typeof raw !== "object") {
    throw new Error('expected { "start": …, "end": … } or a [start, end] pair');
  }
  const o = raw as Record<string, unknown>;
  const start = o.start ?? o.from ?? o.gte;
  const end = o.end ?? o.to ?? o.lt;
  if (start === undefined && end === undefined) {
    // A period with neither end is every period, which is never what someone
    // meant to ask and is far better refused than answered with the whole table.
    throw new Error("needs at least one of `start` / `end`");
  }
  return { start: start ?? undefined, end: end ?? undefined };
};

/**
 * The condition tree that means "this row's period overlaps `operand`".
 *
 * Two clauses, and the shape of each is where the NULL handling lives:
 *
 *     row.start  <  q.end    OR  row.start IS NULL     (row opens before q closes)
 *     row.end    >  q.start  OR  row.end   IS NULL     (row closes after q opens)
 *
 * A NULL endpoint is an INFINITE one — a contract with no end date has not
 * ended — so each clause is satisfied outright when its column is NULL. Written
 * as a plain `end >= q.start` the NULL row is excluded, which is the bug this
 * exists to make unwritable: the filter looks right and silently omits exactly
 * the rows that are still running.
 *
 * Under closed bounds both comparisons become inclusive, so a period ending on
 * the day another begins DOES overlap — which is what "through Friday" means.
 *
 * An omitted side of the query operand drops its clause entirely rather than
 * emitting a vacuous one, so `{ start: X }` compiles to a single comparison.
 */
export const overlapsCondition = (
  startCol: string,
  spec: RangeSpec,
  operand: RangeOperand,
): Record<string, unknown> => {
  const closed = boundsOf(spec) === "[]";
  const parts: Record<string, unknown>[] = [];
  if (operand.end !== undefined && operand.end !== null) {
    parts.push({
      $or: [
        { [startCol]: closed ? { _lte: operand.end } : { _lt: operand.end } },
        { [startCol]: { _null: true } },
      ],
    });
  }
  if (operand.start !== undefined && operand.start !== null) {
    parts.push({
      $or: [
        { [spec.end]: closed ? { _gte: operand.start } : { _gt: operand.start } },
        { [spec.end]: { _null: true } },
      ],
    });
  }
  // `parseRangeOperand` guarantees at least one side, so this is never empty.
  return parts.length === 1 ? parts[0]! : { $and: parts };
};

/**
 * The condition tree that means "this row's period contains `instant`".
 *
 * The degenerate overlap — a moment is a period of zero width — but worth its
 * own operator because "what is in effect right now" is asked far more often
 * than "what clashes with this", and expressing it as an overlap would make the
 * caller write the same value twice.
 */
export const coversCondition = (
  startCol: string,
  spec: RangeSpec,
  instant: unknown,
): Record<string, unknown> => {
  const closed = boundsOf(spec) === "[]";
  return {
    $and: [
      { $or: [{ [startCol]: { _lte: instant } }, { [startCol]: { _null: true } }] },
      {
        $or: [
          { [spec.end]: closed ? { _gte: instant } : { _gt: instant } },
          { [spec.end]: { _null: true } },
        ],
      },
    ],
  };
};

/** Fields that declare a period, by their start column name. */
export type RangeFields = Map<string, RangeSpec>;

/** Build the lookup {@link expandRangeOperators} needs from a field list. */
export const rangeFieldsOf = (
  fields: readonly { name: string; range?: RangeSpec }[],
): RangeFields => {
  const out: RangeFields = new Map();
  for (const f of fields) if (f.range) out.set(f.name, f.range);
  return out;
};

/**
 * Rewrite every `_overlaps` / `_covers` in a condition tree into comparisons the
 * DSL already implements.
 *
 * This is the whole feature's portability argument. After this pass no consumer
 * of the tree has ever heard of a range: the SQL compiler sees `_lt` and
 * `_null`, the in-memory predicate sees the same, and the permission simulator
 * sees the same — so the answer a query gives, the answer realtime gives, and
 * the answer the simulator previews cannot drift, because there is one
 * implementation of each operator rather than two of a new one.
 *
 * Returns a NEW tree; the caller's condition is left alone. A field that
 * declares no range is passed through untouched, so a collection without one
 * stays on exactly its old path.
 *
 * @throws Error naming the field, for the caller to map to a 422.
 */
export const expandRangeOperators = <T>(cond: T, ranges: RangeFields): T => {
  if (ranges.size === 0) return cond;
  const walk = (node: unknown): unknown => {
    if (node === null || node === undefined || typeof node !== "object") return node;
    const c = node as Record<string, unknown>;
    if (Array.isArray(c.$and)) return { $and: (c.$and as unknown[]).map(walk) };
    if (Array.isArray(c.$or)) return { $or: (c.$or as unknown[]).map(walk) };
    if (c.$not !== undefined) return { $not: walk(c.$not) };
    const out: Record<string, unknown> = {};
    const extra: Record<string, unknown>[] = [];
    for (const [key, cmp] of Object.entries(c)) {
      const spec = ranges.get(key);
      if (!spec || cmp === null || typeof cmp !== "object" || Array.isArray(cmp)) {
        out[key] = cmp;
        continue;
      }
      const rest: Record<string, unknown> = {};
      for (const [op, operand] of Object.entries(cmp as Record<string, unknown>)) {
        if (op === "_overlaps") {
          try {
            extra.push(overlapsCondition(key, spec, parseRangeOperand(operand)));
          } catch (e) {
            throw new Error(`${key}: "_overlaps" ${(e as Error).message}`);
          }
        } else if (op === "_covers") {
          if (operand === undefined || operand === null) {
            throw new Error(`${key}: "_covers" needs a date`);
          }
          extra.push(coversCondition(key, spec, operand));
        } else {
          // Every other operator still applies to the start column itself, which
          // is an ordinary timestamp and stays one. `starts_at: { _gte: X }` is
          // a perfectly good question and is not a range question.
          rest[op] = operand;
        }
      }
      if (Object.keys(rest).length > 0) out[key] = rest;
    }
    if (extra.length === 0) return out;
    return Object.keys(out).length === 0 && extra.length === 1
      ? extra[0]!
      : { $and: [...(Object.keys(out).length ? [out] : []), ...extra] };
  };
  return walk(cond) as T;
};

/**
 * Check a proposed row's period is ordered, given the values a write would
 * produce.
 *
 * Returns the error message, or null when the row is fine. A missing endpoint is
 * fine by construction: an open period has nothing to compare.
 *
 * Comparison is on epoch milliseconds so the two columns are compared as
 * instants regardless of whether they arrived as `Date`s, ISO strings or
 * numbers — which they do, differently, on each of the two dialects.
 */
export const rangeOrderError = (
  startCol: string,
  spec: RangeSpec,
  row: Record<string, unknown>,
): string | null => {
  if (spec.ordered === false) return null;
  const start = toEpoch(row[startCol]);
  const end = toEpoch(row[spec.end]);
  if (start === null || end === null) return null;
  if (end < start) {
    return `${spec.end} is before ${startCol} — a period cannot end before it begins`;
  }
  // A zero-width half-open period contains no instant at all, so it can never
  // overlap anything and can never be "in effect". That is almost always a
  // mistake rather than an intent, and it is invisible afterwards.
  if (boundsOf(spec) === "[)" && end === start) {
    return `${spec.end} is the same instant as ${startCol} — a half-open period of zero length covers nothing`;
  }
  return null;
};

/** Epoch-ms for the shapes a timestamp column's value arrives in, or null. */
const toEpoch = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    if (/^-?\d+$/.test(v.trim())) return Number(v);
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
};
