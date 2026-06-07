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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
): void => {
  for (const [k, v] of Object.entries(value)) {
    const path = `${prefix}.${k}`;
    if (isPlainObject(v) && looksLikeComparison(v)) {
      out[path] = v as ComparisonObj;
    } else if (isPlainObject(v) && looksLikeNesting(v)) {
      flattenNested(path, v, out);
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
): Condition => {
  if (!isPlainObject(raw)) return raw as Condition;
  const rels = opts.relationFields;

  // Logical combinators (accept underscore aliases). Handle first; a
  // well-formed condition is either logical OR a field-map, never both.
  const and = (raw.$and ?? raw._and) as unknown;
  if (Array.isArray(and)) {
    return { $and: and.map((c) => normalizeCondition(c, opts)) };
  }
  const or = (raw.$or ?? raw._or) as unknown;
  if (Array.isArray(or)) {
    return { $or: or.map((c) => normalizeCondition(c, opts)) };
  }
  const not = (raw.$not ?? raw._not) as unknown;
  if (not !== undefined) {
    return { $not: normalizeCondition(not, opts) };
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
