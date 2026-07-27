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

// ── Local (in-memory) condition matching ─────────────────────────────────────
//
// Used by `sync` to decide whether a row arriving over the realtime channel
// belongs in a shaped local store. It mirrors the server's JS matcher
// (`@backlex/db` `matchesCondition`) operator for operator, with one deliberate
// difference: the server can resolve `$user.*` / `$tenant.*` variables from the
// request identity, and the client generally can't. Rather than guess, an
// unresolvable variable makes the whole match **undecidable** and the caller
// falls back to the changefeed, which is authoritative.

/** `true` / `false`, or `null` when the shape references something the client
 *  can't resolve locally and the answer has to come from a pull. */
export type MatchResult = boolean | null;

const snakeToCamel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Read a field off a row, tolerating the API's camelCase system columns
 *  (`updated_at` in a shape ↔ `updatedAt` on the wire). */
const lookup = (row: Record<string, unknown>, field: string): unknown => {
  if (field in row) return row[field];
  const camel = snakeToCamel(field);
  if (camel !== field && camel in row) return row[camel];
  return undefined;
};

const MS = { seconds: 1e3, minutes: 6e4, hours: 36e5, days: 864e5, weeks: 6048e5 };

/** Resolve a comparison value. Returns `UNRESOLVED` for server-side variables. */
const UNRESOLVED = Symbol("unresolved");
const resolveValue = (v: unknown, now: number): unknown => {
  if (typeof v === "string") {
    if (v === "$now") return now;
    // `$user.id`, `$tenant.id`, `$field.other` — all need context the local
    // matcher doesn't have.
    if (v.startsWith("$")) return UNRESOLVED;
    return v;
  }
  if (isPlainObject(v) && "$now" in v) {
    const spec = (v as unknown as RelativeNow).$now ?? {};
    let t = now;
    for (const [k, sign] of [["add", 1], ["sub", -1]] as const) {
      const parts = spec[k];
      if (!parts) continue;
      const d = new Date(t);
      if (parts.years) d.setFullYear(d.getFullYear() + sign * parts.years);
      if (parts.months) d.setMonth(d.getMonth() + sign * parts.months);
      for (const unit of ["weeks", "days", "hours", "minutes", "seconds"] as const) {
        if (parts[unit]) d.setTime(d.getTime() + sign * parts[unit]! * MS[unit]);
      }
      t = d.getTime();
    }
    return t;
  }
  return v;
};

/** Numeric coercion with a date fallback, so ISO-string timestamps compare by
 *  instant instead of NaN-failing. Mirrors the server matcher. */
const num = (x: unknown): number => {
  const n = Number(x);
  if (!Number.isNaN(n)) return n;
  if (typeof x === "string") {
    const t = Date.parse(x);
    if (!Number.isNaN(t)) return t;
  }
  return Number.NaN;
};

/**
 * Evaluate a condition against a single row, locally.
 *
 * Returns `null` (undecidable) when the condition spans a relation or contains
 * a `$`-variable this client can't resolve — callers must treat that as "ask
 * the server", never as a match or a miss.
 */
export const matchesCondition = (
  row: Record<string, unknown>,
  cond: Condition,
  now: number = Date.now(),
): MatchResult => {
  const c = cond as Record<string, unknown>;
  if (Array.isArray(c.$and)) {
    let unknown = false;
    for (const sub of c.$and as Condition[]) {
      const r = matchesCondition(row, sub, now);
      if (r === false) return false; // one definite miss settles an AND
      if (r === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if (Array.isArray(c.$or)) {
    let unknown = false;
    for (const sub of c.$or as Condition[]) {
      const r = matchesCondition(row, sub, now);
      if (r === true) return true; // one definite hit settles an OR
      if (r === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if (c.$not !== undefined) {
    const r = matchesCondition(row, c.$not as Condition, now);
    return r === null ? null : !r;
  }

  for (const [field, raw] of Object.entries(c as Record<string, ComparisonObj>)) {
    if (field.includes(".")) return null; // relation hop — server's business
    const cmp = raw ?? {};
    const left = lookup(row, field);
    let undecidable = false;
    const r = (v: unknown): unknown => {
      const out = resolveValue(v, now);
      if (out === UNRESOLVED) undecidable = true;
      return out;
    };
    // A comparison that resolved a `$`-variable to a placeholder didn't really
    // fail — we never had the right-hand side. Report undecidable instead.
    const miss = (): MatchResult => (undecidable ? null : false);

    if (cmp._eq !== undefined && left !== r(cmp._eq)) return miss();
    if (cmp._neq !== undefined && left === r(cmp._neq)) return miss();
    if (cmp._in !== undefined && !cmp._in.map(r).includes(left)) return miss();
    if (cmp._nin !== undefined && cmp._nin.map(r).includes(left)) return miss();
    if (cmp._gt !== undefined && !(num(left) > num(r(cmp._gt)))) return miss();
    if (cmp._gte !== undefined && !(num(left) >= num(r(cmp._gte)))) return miss();
    if (cmp._lt !== undefined && !(num(left) < num(r(cmp._lt)))) return miss();
    if (cmp._lte !== undefined && !(num(left) <= num(r(cmp._lte)))) return miss();
    if (cmp._between !== undefined) {
      const lo = num(r(cmp._between[0]));
      const hi = num(r(cmp._between[1]));
      const n = num(left);
      if (!(n >= lo && n <= hi)) return miss();
    }
    if (cmp._null === true && left != null) return false;
    if (cmp._null === false && left == null) return false;
    if (cmp._empty === true && !(left == null || left === "")) return false;
    if (cmp._nempty === true && (left == null || left === "")) return false;

    const s = String(left ?? "");
    if (cmp._contains !== undefined && !s.includes(String(r(cmp._contains)))) return miss();
    if (cmp._starts_with !== undefined && !s.startsWith(String(r(cmp._starts_with)))) return miss();
    if (cmp._ends_with !== undefined && !s.endsWith(String(r(cmp._ends_with)))) return miss();
    const ls = s.toLowerCase();
    if (cmp._icontains !== undefined && !ls.includes(String(r(cmp._icontains)).toLowerCase())) return miss();
    if (cmp._istarts_with !== undefined && !ls.startsWith(String(r(cmp._istarts_with)).toLowerCase())) return miss();
    if (cmp._iends_with !== undefined && !ls.endsWith(String(r(cmp._iends_with)).toLowerCase())) return miss();
    // A comparison that *passed* but leaned on an unresolvable variable can't
    // be trusted either — the value we compared against was a placeholder.
    if (undecidable) return null;
  }
  return true;
};

/** Stable key for a shape, matching the server's `shapeKey` (FNV-1a over the
 *  canonical, key-sorted JSON). Lets a client notice its shape changed and
 *  re-sync from scratch instead of layering a new shape over stale rows. */
export const shapeKey = (cond: Condition | null | undefined): string => {
  if (!cond) return "all";
  const canonical = JSON.stringify(sortKeys(cond));
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
  return out;
};
