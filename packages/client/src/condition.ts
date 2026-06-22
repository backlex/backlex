// Vendored from `@backlex/core` (src/permission.ts + src/condition.ts) so the
// published `backlex` has ZERO workspace/runtime dependencies and can
// ship as plain TypeScript source. Keep this in sync if the canonical condition
// shape changes upstream — it is a small, stable, dependency-free slice (the
// query builder compiles to this exact JSON, byte-identical to what the REST
// API and permission rows already speak).

/** Comparison operators for a single field (multi-key maps AND together). */
export interface ComparisonObj {
  _eq?: unknown;
  _neq?: unknown;
  _in?: unknown[];
  _nin?: unknown[];
  _gt?: unknown;
  _gte?: unknown;
  _lt?: unknown;
  _lte?: unknown;
  /** Inclusive range: `col BETWEEN lo AND hi`. */
  _between?: [unknown, unknown];
  _null?: boolean;
  _contains?: string;
  _starts_with?: string;
  _ends_with?: string;
  /** Case-insensitive variants (LOWER() both sides → PG/SQLite parity). */
  _icontains?: string;
  _istarts_with?: string;
  _iends_with?: string;
  /** `_empty: true` ⇒ NULL or empty string; `_nempty: true` ⇒ neither. */
  _empty?: boolean;
  _nempty?: boolean;
}

/**
 * Relative-date value usable anywhere a comparison value is expected, e.g.
 * `{ placed_at: { _gte: { $now: { sub: { months: 1 } } } } }`. Bare `"$now"`
 * still means "this instant"; resolved server-side to the dialect-correct value.
 */
export interface RelativeNow {
  $now: {
    add?: DurationParts;
    sub?: DurationParts;
  };
}

export interface DurationParts {
  years?: number;
  months?: number;
  weeks?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

export type Condition =
  | { $and: Condition[] }
  | { $or: Condition[] }
  | { $not: Condition }
  | { [field: string]: ComparisonObj };

export interface NormalizeOpts {
  /**
   * Names of relation / relation_many fields on the queried collection. When
   * provided, a key in this set whose value is a nested-object (operator-free)
   * map is flattened into dotted relation paths.
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

/** A nested-relation value is an object whose keys are all plain field names. */
const looksLikeNesting = (o: Record<string, unknown>): boolean => {
  const keys = Object.keys(o);
  return keys.length > 0 && keys.every((k) => !k.startsWith("_") && !k.startsWith("$"));
};

/** Flatten a nested-object relation map into canonical dotted leaf entries. */
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
      out[path] = { _eq: v };
    }
  }
};

/**
 * Normalize an arbitrary raw filter value into a canonical `Condition`.
 * Non-object input is returned unchanged (callers validate shape downstream).
 */
export const normalizeCondition = (raw: unknown, opts: NormalizeOpts = {}): Condition => {
  if (!isPlainObject(raw)) return raw as Condition;
  const rels = opts.relationFields;

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

  const out: Record<string, ComparisonObj> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isPlainObject(value)) {
      if (looksLikeComparison(value)) {
        out[key] = value as ComparisonObj;
      } else if (looksLikeNesting(value) && (rels ? rels.has(key) : false)) {
        flattenNested(key, value, out);
      } else {
        out[key] = value as ComparisonObj;
      }
    } else {
      out[key] = { _eq: value };
    }
  }
  return out as Condition;
};
