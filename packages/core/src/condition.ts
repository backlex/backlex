import { AppError } from "./errors";
import type { ComparisonObj, Condition } from "./permission";

/**
 * Filter normalization — the single front door that turns any *accepted* input
 * shape into the ONE canonical `Condition` the compiler / predicate / permission
 * store all speak. Keeping this pure and dependency-free (it lives in
 * `@backlex/core`, not `@backlex/db`) lets the SDK and the admin UI compile to
 * canonical JSON without pulling in drizzle.
 *
 * Canonical form (byte-identical to what permission rows already store, so there
 * is NO data migration):
 *   - logical:  `{ $and: Condition[] }` | `{ $or: Condition[] }` | `{ $not: Condition }`
 *   - leaf:     `{ "<field|dot.path>": ComparisonObj }`  (multi-key field maps AND)
 *   - relation: dot-notation keys (`"customer.name"`)
 *
 * Accepted inputs that get rewritten to canonical:
 *   1. `_and` / `_or` / `_not` aliases            → `$and` / `$or` / `$not`
 *   2. nested-object relation form                → dotted key
 *        `{ customer: { name: { _eq } } }`        → `{ "customer.name": { _eq } }`
 *      (only when `relationFields` marks the head as a relation, so a real
 *       `json` column named like a relation is never mis-flattened)
 *   3. implicit equality                          → `{ _eq }`
 *        `{ status: "active" }`                    → `{ status: { _eq: "active" } }`
 *
 * Normalization is idempotent: `normalizeCondition(normalizeCondition(x)) `
 * deep-equals `normalizeCondition(x)`.
 */

export interface NormalizeOpts {
  /**
   * Names of relation / relation_many fields on the queried collection. When
   * provided, a key in this set whose value is a nested-object (operator-free)
   * map is flattened into dotted relation paths. Omit for the schema-blind
   * storage path (permission rows are authored canonically and never nested).
   */
  relationFields?: Set<string>;
}

/**
 * How deeply a condition may nest before it is a denial-of-service rather than
 * a filter.
 *
 * Every walker over a condition is recursive — this normalizer, the SQL
 * compiler, the in-memory evaluator, the money/phone/email/url operand
 * rewriters, the range expander and two separate column validators — and none
 * of them was bounded. `JSON.parse` happily accepts 450 KB of
 * `{"$not":{"$not":…}}` (measured: 50,000 levels parses in milliseconds), so
 * the first recursive walk over it overflowed the stack and left as a 500 with
 * a `RangeError` in the log. Capping HERE, at the single front door every
 * filter path already goes through, bounds all of them at once.
 *
 * 64 is far past anything a person writes or the admin's condition builder can
 * produce — nesting is boolean grouping, and breadth (an `$or` of 200 clauses)
 * costs one level, not 200.
 */
export const MAX_CONDITION_DEPTH = 64;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Every operator a `ComparisonObj` may carry — the ONE list, kept here in
 * `@backlex/core` so the compiler, the in-memory evaluator, the filter door and
 * the SDK all read the same names.
 *
 * `_overlaps` / `_covers` are in it even though no evaluator implements them:
 * `expandRangeOperators` rewrites them into ordinary comparisons before either
 * engine sees a condition, so they are legal INPUT and illegal output. A name
 * outside this set is not "an operator we happen not to support yet" — it is a
 * typo, and see {@link unknownOperators} for why that mattered.
 */
export const COMPARISON_OPERATORS: ReadonlySet<string> = new Set([
  "_eq",
  "_neq",
  "_in",
  "_nin",
  "_gt",
  "_gte",
  "_lt",
  "_lte",
  "_between",
  "_null",
  "_empty",
  "_nempty",
  "_contains",
  "_starts_with",
  "_ends_with",
  "_icontains",
  "_istarts_with",
  "_iends_with",
  "_near",
  "_overlaps",
  "_covers",
]);

/**
 * Collect every operator key in a canonical condition that nothing implements.
 *
 * This exists because a misspelled operator used to be INVISIBLE and
 * fail-OPEN. `looksLikeComparison` admits any key starting with `_`, and the
 * compiler branches on each operator it knows with a plain `if`, so
 * `{ owner_id: { _equals: "$user.id" } }` matched no branch at all, left
 * `parts` empty, and fell out of the bottom as `(1=1)` — a permission rule
 * that reads "only your own rows" compiling to "every row", with no error
 * anywhere. The in-memory evaluator did the same thing by the same route.
 *
 * The evaluators now fail CLOSED on a name they do not know, and this walks a
 * condition at the DOOR so the author is told which key is wrong instead of
 * quietly getting a rule that denies everything.
 */
export const unknownOperators = (cond: unknown): string[] => {
  const found = new Set<string>();
  const walk = (node: unknown, depth: number): void => {
    if (!isPlainObject(node)) return;
    // Refuse rather than stop. Stopping silently would have let an over-deep
    // condition be STORED here and then throw at read time, in the permission
    // resolver, on somebody else's request.
    if (depth > MAX_CONDITION_DEPTH) {
      throw new AppError(
        "VALIDATION",
        `Condition nesting exceeds the maximum depth of ${MAX_CONDITION_DEPTH}`,
      );
    }
    const and = (node.$and ?? node._and) as unknown;
    if (Array.isArray(and)) {
      for (const c of and) walk(c, depth + 1);
      return;
    }
    const or = (node.$or ?? node._or) as unknown;
    if (Array.isArray(or)) {
      for (const c of or) walk(c, depth + 1);
      return;
    }
    const not = (node.$not ?? node._not) as unknown;
    if (not !== undefined) {
      walk(not, depth + 1);
      return;
    }
    for (const value of Object.values(node)) {
      if (!isPlainObject(value)) continue;
      const keys = Object.keys(value);
      // Only judge things that ARE comparison objects. A `json` column literal
      // (`{ meta: { plan: "pro" } }`) has no leading-underscore keys and is a
      // value, not a set of operators.
      if (keys.length === 0 || !keys.every((k) => k.startsWith("_"))) continue;
      for (const k of keys) if (!COMPARISON_OPERATORS.has(k)) found.add(k);
    }
  };
  walk(cond, 0);
  return [...found];
};

/** A leaf value object is a ComparisonObj iff every key is operator-prefixed. */
const looksLikeComparison = (o: Record<string, unknown>): boolean => {
  const keys = Object.keys(o);
  return keys.length > 0 && keys.every((k) => k.startsWith("_"));
};

/** A nested-relation value is an object whose keys are all plain field names
 *  (no `_op` / `$logical` prefixes) — i.e. it nests further conditions. */
const looksLikeNesting = (o: Record<string, unknown>): boolean => {
  const keys = Object.keys(o);
  return (
    keys.length > 0 && keys.every((k) => !k.startsWith("_") && !k.startsWith("$"))
  );
};

/**
 * Flatten a nested-object relation map into canonical dotted leaf entries,
 * writing them onto `out`. `prefix` is the accumulated dot-path head.
 * e.g. flatten("customer", { address: { city: { _eq } } }) →
 *      out["customer.address.city"] = { _eq }
 */
const flattenNested = (
  prefix: string,
  value: Record<string, unknown>,
  out: Record<string, ComparisonObj>,
  depth = 0,
): void => {
  // Bounded for the same reason the logical walk is — this is the OTHER
  // recursion a nested filter can drive, and `{a:{a:{a:…}}}` reaches it
  // without a single `$not`.
  if (depth > MAX_CONDITION_DEPTH) {
    throw new AppError(
      "VALIDATION",
      `Filter nesting exceeds the maximum depth of ${MAX_CONDITION_DEPTH}`,
    );
  }
  for (const [k, v] of Object.entries(value)) {
    const path = `${prefix}.${k}`;
    if (isPlainObject(v) && looksLikeComparison(v)) {
      out[path] = v as ComparisonObj;
    } else if (isPlainObject(v) && looksLikeNesting(v)) {
      flattenNested(path, v, out, depth + 1);
    } else {
      // scalar leaf under a relation path → implicit equality
      out[path] = { _eq: v };
    }
  }
};

/**
 * Normalize an arbitrary raw filter value into a canonical `Condition`.
 * Non-object input is returned unchanged (callers validate shape downstream).
 */
export const normalizeCondition = (
  raw: unknown,
  opts: NormalizeOpts = {},
  depth = 0,
): Condition => {
  if (!isPlainObject(raw)) return raw as Condition;
  if (depth > MAX_CONDITION_DEPTH) {
    throw new AppError(
      "VALIDATION",
      `Filter nesting exceeds the maximum depth of ${MAX_CONDITION_DEPTH}`,
    );
  }
  const rels = opts.relationFields;

  // Logical combinators (accept underscore aliases). Handle first; a
  // well-formed condition is either logical OR a field-map, never both.
  const and = (raw.$and ?? raw._and) as unknown;
  if (Array.isArray(and)) {
    return { $and: and.map((c) => normalizeCondition(c, opts, depth + 1)) };
  }
  const or = (raw.$or ?? raw._or) as unknown;
  if (Array.isArray(or)) {
    return { $or: or.map((c) => normalizeCondition(c, opts, depth + 1)) };
  }
  const not = (raw.$not ?? raw._not) as unknown;
  if (not !== undefined) {
    return { $not: normalizeCondition(not, opts, depth + 1) };
  }

  // Field map: each key is a (possibly dotted) field; normalize each value.
  const out: Record<string, ComparisonObj> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isPlainObject(value)) {
      if (looksLikeComparison(value)) {
        out[key] = value as ComparisonObj;
      } else if (
        looksLikeNesting(value) &&
        (rels ? rels.has(key) : false)
      ) {
        // Nested-object relation form → dotted keys (schema-aware only).
        flattenNested(key, value, out);
      } else {
        // Unknown object shape (e.g. a json-column literal, or schema-blind
        // nesting we won't flatten) — pass through untouched.
        out[key] = value as ComparisonObj;
      }
    } else {
      // Scalar / array / null → implicit equality.
      out[key] = { _eq: value };
    }
  }
  return out as Condition;
};
