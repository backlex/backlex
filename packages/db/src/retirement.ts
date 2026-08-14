/**
 * Row retirement — whether a row is still in play, and what stops being offered
 * once it is not.
 *
 * Everything in this module is PURE: the spec, its validation, the question
 * "is this value retired", and the parsing of the read scope. Nothing here
 * imports anything, which is why `@backlex/db/retirement` is its own package
 * export — reaching it through the package root would drag the migration
 * bundles, and their `*.sql` imports, into the browser build. The admin decides
 * which rows to grey out with the SAME function the server filters by.
 *
 * ## The shape of the problem
 *
 * Sixty-four `boolean` columns across sixty-four collections in twenty-one of
 * the twenty-seven schema templates exist to say a row is no longer in play. It
 * is spelled `active` fifty-six times, and then `visible`, `published`,
 * `available` and `enabled`. Sixty-three of the sixty-four default to `true`.
 *
 * Not one of them is `indexed`.
 *
 * So every workspace has the column, and nothing in the product has ever read
 * it:
 *
 *  - **The relation picker offers retired rows exactly like live ones.** An
 *    operator adding a line to an order is shown the discontinued product on
 *    equal footing with the one still being sold, and the only thing that stops
 *    them picking it is remembering that it was discontinued.
 *  - **Every "only the live ones" query is a table scan**, because the flag the
 *    whole catalog filters by carries no index.
 *  - **The answer cannot be declared once.** There is no default-filter
 *    primitive anywhere, so each caller restates `active = true`, or forgets to.
 *
 * ## Retirement never hides a row from a read
 *
 * This is the load-bearing rule, and it is what separates retirement from the
 * `_status` (draft / published / archived) lifecycle that `versioned`
 * collections already carry. That one works by HIDING rows from readers who
 * cannot publish, which is right for an unfinished article and wrong here: an
 * invoice line pointing at a discontinued product must still resolve, for
 * everybody, forever. A retired row is not secret and not deleted — it is
 * finished.
 *
 * What the declaration changes is only the places that OFFER a row for NEW
 * work: the pickers, the admin's default list view, and a write that tries to
 * point a fresh reference at it. Reads are untouched, so no existing API
 * consumer sees a different result than it did yesterday.
 *
 * That also decides the name. "Archived" was taken, by a feature that means
 * something else; calling this one archival too would give one word two
 * answers.
 *
 * ## Why this is a spec on a boolean, not a new field type
 *
 * A flag is a boolean and stays one. Making retirement a {@link FieldType}
 * would buy nothing — the storage is identical in both dialects — and would
 * cost a new entry in every exhaustive `Record<FieldType>` in the codebase,
 * which is the shape of bug that once took the whole GraphQL endpoint down (see
 * `isKnownFieldType`). So a retirement flag is an ordinary `boolean` column
 * carrying a {@link RetireSpec}, exactly as a position is an ordinary `integer`
 * carrying an `OrderSpec`. All sixty-four template columns adopt it as
 * metadata, with no migration.
 *
 * ## NULL is live
 *
 * The narrowing is `flag IS NOT <retired> OR flag IS NULL`, and the NULL arm is
 * not defensive noise. Sixty-three of the sixty-four columns carry a DDL default
 * today, but a column added to an existing table backfills NULL, an adopted
 * table brings whatever it brought, and a CSV import writes what the file held.
 * Reading NULL as retired would empty every picker in the workspace the moment
 * the flag was declared — a silent, total failure that looks like the feature
 * working. Reading it as live degrades to exactly today's behaviour instead.
 *
 * ## Terminal dropdown values are deliberately not this
 *
 * A hundred and eight dropdown fields in the catalog carry a value like
 * `cancelled`, `expired` or `completed`, and a lifecycle status is already
 * answered by `TransitionSpec` — which knows what a status may move to, who may
 * move it, and what the row must carry first. Letting a status ALSO declare
 * retirement would give the same question two owners. A workspace that wants a
 * cancelled order to stop being offered writes the rule where the lifecycle
 * lives.
 *
 * @module
 */

/**
 * Declares that a `boolean` column says whether the row is still in play.
 *
 * Lives on the flag itself. Everything about the column stays what it was —
 * writable, filterable, an ordinary boolean — and what the declaration buys is
 * that the rest of the product finally reads it: the column gets an index, the
 * pickers stop offering retired rows, the admin's list opens on the live ones,
 * and a new reference to a retired row is refused instead of quietly made.
 */
export interface RetireSpec {
  /**
   * Which value of the column means "no longer in play". Defaults to `false`,
   * because fifty-six of the sixty-four catalog columns are named `active` and
   * read the obvious way.
   *
   * Set it to `true` for a column phrased the other way round — `discontinued`,
   * `archived`, `is_deprecated`. Both spellings are real and neither is wrong;
   * what was wrong was that nothing could tell them apart.
   */
  retiredWhen?: boolean;
  /**
   * What a write that points a NEW `relation` / `relation_many` value at a
   * retired row does.
   *
   *  - `"block"` (the default) → 422, naming the row and the collection.
   *  - `"allow"` → nothing; the reference is made.
   *
   * Only values a write actually NAMES are judged. A PATCH that does not
   * mention the relation leaves it alone, and no existing reference is ever
   * re-validated — retiring a product does not make every past order invalid,
   * which is the whole point of not hiding the row.
   *
   * `"allow"` exists because "still in play" is not always the same question as
   * "may be referenced": a retired price list is exactly what a historical
   * correction needs to point at.
   */
  references?: "block" | "allow";
}

/** How a read treats retired rows. `all` is the default everywhere. */
export type RetiredScope = "all" | "exclude" | "only";

/** True when this field is a collection's retirement flag. */
export const isRetireFlag = (field: { retire?: RetireSpec }): boolean => Boolean(field.retire);

/** The column value that means "no longer in play". */
export const retiredValue = (spec: RetireSpec): boolean => spec.retiredWhen ?? false;

/**
 * The collection's retirement flag, or undefined.
 *
 * A collection has at most one — see {@link validateRetireSpec} — so callers
 * that need to know "is this row in play" have exactly one column to consult
 * and never have to combine two answers.
 */
export const findRetireField = <T extends { retire?: RetireSpec }>(
  fields: readonly T[],
): T | undefined => fields.find((f) => isRetireFlag(f));

/**
 * Whether a stored value means the row is retired.
 *
 * Deliberately tolerant about the ENCODING and strict about the meaning.
 * SQLite has no boolean type, so the same flag arrives as `1`/`0` there and as
 * `true`/`false` from Postgres, and a CSV import can put the string `"false"`
 * in the column. All of those are the same answer to the same question. What is
 * NOT tolerated is anything unrecognisable: it reads as live, for the reason
 * NULL does — the failure mode of guessing "retired" is an empty picker nobody
 * can explain.
 */
export const isRetiredValue = (value: unknown, spec: RetireSpec): boolean => {
  const flag = coerceFlag(value);
  return flag === null ? false : flag === retiredValue(spec);
};

/** `1`/`0`, `"true"`/`"false"`, `true`/`false` → a boolean; anything else null. */
const coerceFlag = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
  }
  return null;
};

/**
 * Read a `?retired=` query value.
 *
 * Returns null for anything unrecognised so the caller can 400 rather than
 * silently serve `all` — an operator who typed `retired=excluded` and got every
 * row back has been told the filter ran.
 */
export const parseRetiredScope = (raw: unknown): RetiredScope | null => {
  if (raw === undefined || raw === null || raw === "") return "all";
  if (raw === "all" || raw === "exclude" || raw === "only") return raw;
  return null;
};

/**
 * Reject a malformed {@link RetireSpec} at schema-save time.
 *
 * `otherRetireFields` is the names of the collection's OTHER fields that
 * already declare one. Two flags is the mistake worth catching here: a
 * collection with both `active` and `visible` declared has no single answer to
 * "is this row in play", so every consumer would have to invent one — and they
 * would not all invent the same one.
 *
 * @throws Error naming the problem.
 */
export const validateRetireSpec = (
  spec: RetireSpec,
  ctx: { fieldName: string; otherRetireFields: readonly string[] },
): void => {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error("`retire` must be an object");
  }
  if (spec.retiredWhen !== undefined && typeof spec.retiredWhen !== "boolean") {
    throw new Error("`retire.retiredWhen` must be true or false");
  }
  if (
    spec.references !== undefined &&
    spec.references !== "block" &&
    spec.references !== "allow"
  ) {
    throw new Error('`retire.references` must be "block" or "allow"');
  }
  if (ctx.otherRetireFields.length > 0) {
    throw new Error(
      `\`retire\` is already declared on "${ctx.otherRetireFields[0]}" — a collection has one retirement flag`,
    );
  }
};
