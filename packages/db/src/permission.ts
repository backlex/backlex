import { sql, type SQL } from "drizzle-orm";
import type {
  AuthSubject,
  ComparisonObj,
  Condition,
  DurationParts,
  RelativeNow,
} from "@backlex/core";

const FALSE: SQL = sql`(1=0)`;
const TRUE: SQL = sql`(1=1)`;

export type Dialect = "pg" | "sqlite";

/**
 * Evaluation context threaded through one compile/match pass. `now` is captured
 * ONCE at the public entry so every relative date in the same condition resolves
 * to the same instant (SQL and the realtime predicate can't drift apart).
 * `dialect` lets temporal values resolve to the right physical representation
 * (SQLite stores timestamps as epoch-ms INTEGER, PG as timestamptz ISO string).
 * Both optional: omitted `now` ⇒ Date.now(); omitted `dialect` ⇒ epoch-ms
 * (back-compat with the historical `$now` behavior, correct for SQLite + JS).
 */
export interface EvalOpts {
  now?: number;
  dialect?: Dialect;
}

const isAnd = (c: Condition): c is { $and: Condition[] } =>
  Array.isArray((c as { $and?: unknown }).$and);
const isOr = (c: Condition): c is { $or: Condition[] } =>
  Array.isArray((c as { $or?: unknown }).$or);
const isNot = (c: Condition): c is { $not: Condition } =>
  (c as { $not?: unknown }).$not !== undefined;

const isVar = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith("$");

const isRelativeNow = (v: unknown): v is RelativeNow =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { $now?: unknown }).$now === "object" &&
  (v as { $now?: unknown }).$now !== null;

const MS = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

/** Apply a calendar-correct offset to an epoch-ms instant. Months/years use
 *  Date setters (calendar math); smaller units are fixed-width. */
const applyDuration = (baseMs: number, parts: DurationParts, sign: 1 | -1): number => {
  const d = new Date(baseMs);
  if (parts.years) d.setUTCFullYear(d.getUTCFullYear() + sign * parts.years);
  if (parts.months) d.setUTCMonth(d.getUTCMonth() + sign * parts.months);
  let ms = d.getTime();
  ms += sign * (parts.weeks ?? 0) * MS.weeks;
  ms += sign * (parts.days ?? 0) * MS.days;
  ms += sign * (parts.hours ?? 0) * MS.hours;
  ms += sign * (parts.minutes ?? 0) * MS.minutes;
  ms += sign * (parts.seconds ?? 0) * MS.seconds;
  return ms;
};

/** Format an epoch-ms instant for the target dialect's timestamp column. */
const temporal = (ms: number, dialect: Dialect | undefined): unknown =>
  dialect === "pg" ? new Date(ms).toISOString() : ms;

const resolveRelativeNow = (v: RelativeNow, now: number, dialect?: Dialect): unknown => {
  let ms = now;
  if (v.$now.add) ms = applyDuration(ms, v.$now.add, 1);
  if (v.$now.sub) ms = applyDuration(ms, v.$now.sub, -1);
  return temporal(ms, dialect);
};

const resolveVar = (
  v: string,
  ctx: AuthSubject,
  now: number,
  dialect?: Dialect,
): unknown => {
  if (v === "$user.id") return ctx.userId;
  if (v === "$user.email") return ctx.email;
  if (v === "$user.roles") return ctx.roles;
  if (v === "$tenant.id" || v === "$user.tenant_id") return ctx.tenantId ?? null;
  if (v === "$now") return temporal(now, dialect);
  return v;
};

const resolve = (
  v: unknown,
  ctx: AuthSubject,
  now: number,
  dialect?: Dialect,
): unknown => {
  if (isVar(v)) return resolveVar(v, ctx, now, dialect);
  if (isRelativeNow(v)) return resolveRelativeNow(v, now, dialect);
  return v;
};

/**
 * Resolves a logical field key to a SQL identifier (or qualified
 * identifier). Default behavior is `sql.identifier(field)`; callers
 * that need to alias system columns to a different physical column,
 * or route nested-relation keys (`customer_id.name`) through a JOIN
 * alias, pass a custom resolver.
 */
export type ColRefResolver = (field: string) => SQL;

/**
 * Optional leaf-comparison override. Called for every leaf field key
 * before the default operator dispatch runs. Returning an `SQL` fragment
 * replaces the default `<colRef> <op> <val>` shape entirely — useful for
 * keys that need to lower to a subquery (e.g. `relation_many` arrays via
 * `EXISTS … json_each(…)` / `jsonb_array_elements_text(…)`). Returning
 * `null` falls through to the default scalar comparison path.
 *
 * The callback owns the full comparison: it sees the user-supplied
 * `ComparisonObj` and emits a single SQL fragment that captures every
 * operator in it. Operator semantics (`_eq`, `_neq`, `_in`, …) match the
 * default path; callers re-use the same resolver for the `_eq`-value
 * indirection.
 */
export type LeafCompiler = (
  field: string,
  cmp: ComparisonObj,
  ctx: AuthSubject,
) => SQL | null;

const defaultColRef: ColRefResolver = (field) => sql`${sql.identifier(field)}`;

const compileComparison = (
  field: string,
  cmp: ComparisonObj,
  ctx: AuthSubject,
  now: number,
  dialect: Dialect | undefined,
  colRef: ColRefResolver = defaultColRef,
  leaf?: LeafCompiler,
): SQL => {
  if (leaf) {
    const override = leaf(field, cmp, ctx);
    if (override) return override;
  }
  const id = colRef(field);
  const r = (v: unknown) => resolve(v, ctx, now, dialect);
  const parts: SQL[] = [];
  if (cmp._eq !== undefined) {
    const v = r(cmp._eq);
    if (v === null || v === undefined) return FALSE;
    parts.push(sql`${id} = ${v}`);
  }
  if (cmp._neq !== undefined) {
    const v = r(cmp._neq);
    parts.push(v === null || v === undefined ? sql`${id} IS NOT NULL` : sql`${id} <> ${v}`);
  }
  if (cmp._in !== undefined) {
    const arr = (cmp._in as unknown[]).map(r);
    if (arr.length === 0) return FALSE;
    parts.push(sql`${id} IN (${sql.join(arr.map((v) => sql`${v}`), sql`, `)})`);
  }
  if (cmp._nin !== undefined) {
    const arr = (cmp._nin as unknown[]).map(r);
    if (arr.length === 0) return TRUE;
    parts.push(sql`${id} NOT IN (${sql.join(arr.map((v) => sql`${v}`), sql`, `)})`);
  }
  if (cmp._gt !== undefined) parts.push(sql`${id} > ${r(cmp._gt)}`);
  if (cmp._gte !== undefined) parts.push(sql`${id} >= ${r(cmp._gte)}`);
  if (cmp._lt !== undefined) parts.push(sql`${id} < ${r(cmp._lt)}`);
  if (cmp._lte !== undefined) parts.push(sql`${id} <= ${r(cmp._lte)}`);
  if (cmp._between !== undefined) {
    const [lo, hi] = cmp._between;
    parts.push(sql`${id} BETWEEN ${r(lo)} AND ${r(hi)}`);
  }
  if (cmp._null === true) parts.push(sql`${id} IS NULL`);
  if (cmp._null === false) parts.push(sql`${id} IS NOT NULL`);
  if (cmp._empty === true) parts.push(sql`(${id} IS NULL OR ${id} = ${""})`);
  if (cmp._nempty === true) parts.push(sql`(${id} IS NOT NULL AND ${id} <> ${""})`);
  if (cmp._contains !== undefined) {
    parts.push(sql`${id} LIKE ${`%${String(r(cmp._contains))}%`}`);
  }
  if (cmp._starts_with !== undefined) {
    parts.push(sql`${id} LIKE ${`${String(r(cmp._starts_with))}%`}`);
  }
  if (cmp._ends_with !== undefined) {
    parts.push(sql`${id} LIKE ${`%${String(r(cmp._ends_with))}`}`);
  }
  // Case-insensitive: LOWER() the column and lowercase the JS value so PG and
  // SQLite agree regardless of column collation.
  if (cmp._icontains !== undefined) {
    parts.push(sql`LOWER(${id}) LIKE ${`%${String(r(cmp._icontains)).toLowerCase()}%`}`);
  }
  if (cmp._istarts_with !== undefined) {
    parts.push(sql`LOWER(${id}) LIKE ${`${String(r(cmp._istarts_with)).toLowerCase()}%`}`);
  }
  if (cmp._iends_with !== undefined) {
    parts.push(sql`LOWER(${id}) LIKE ${`%${String(r(cmp._iends_with)).toLowerCase()}`}`);
  }
  if (parts.length === 0) return TRUE;
  return sql`(${sql.join(parts, sql` AND `)})`;
};

const compileInner = (
  cond: Condition,
  ctx: AuthSubject,
  now: number,
  dialect: Dialect | undefined,
  colRef: ColRefResolver,
  leaf?: LeafCompiler,
): SQL => {
  if (isAnd(cond)) {
    const parts = cond.$and.map((c) => compileInner(c, ctx, now, dialect, colRef, leaf));
    if (parts.length === 0) return TRUE;
    return sql`(${sql.join(parts, sql` AND `)})`;
  }
  if (isOr(cond)) {
    const parts = cond.$or.map((c) => compileInner(c, ctx, now, dialect, colRef, leaf));
    if (parts.length === 0) return FALSE;
    return sql`(${sql.join(parts, sql` OR `)})`;
  }
  if (isNot(cond)) {
    return sql`NOT (${compileInner(cond.$not, ctx, now, dialect, colRef, leaf)})`;
  }
  const fieldMap = cond as Record<string, ComparisonObj>;
  const keys = Object.keys(fieldMap);
  if (keys.length === 0) return TRUE;
  const parts = keys.map((k) =>
    compileComparison(k, fieldMap[k]!, ctx, now, dialect, colRef, leaf),
  );
  return sql`(${sql.join(parts, sql` AND `)})`;
};

export const compileCondition = (
  cond: Condition,
  ctx: AuthSubject,
  colRef: ColRefResolver = defaultColRef,
  leaf?: LeafCompiler,
  opts: EvalOpts = {},
): SQL =>
  compileInner(cond, ctx, opts.now ?? Date.now(), opts.dialect, colRef, leaf);

/**
 * Combine multiple conditions with OR (most permissive across roles).
 * Returns null if all role permissions had no condition (= unrestricted).
 */
export const combineConditions = (
  conds: (Condition | null | undefined)[],
  ctx: AuthSubject,
  colRef: ColRefResolver = defaultColRef,
  leaf?: LeafCompiler,
  opts: EvalOpts = {},
): SQL | null => {
  if (conds.length === 0) return FALSE;
  if (conds.some((c) => c === null || c === undefined)) {
    // At least one role grants unconditional access.
    return null;
  }
  // Capture one clock for the whole combined predicate.
  const now = opts.now ?? Date.now();
  const compiled = conds.map((c) =>
    compileInner(c as Condition, ctx, now, opts.dialect, colRef, leaf),
  );
  if (compiled.length === 1) return compiled[0]!;
  return sql`(${sql.join(compiled, sql` OR `)})`;
};

/**
 * Evaluate a Condition against a plain row in JS (no SQL). Used for create
 * actions where we want to validate the proposed row without round-tripping.
 * Supports the same operators as compileCondition.
 */
const snakeToCamel = (s: string): string =>
  s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

const lookup = (row: Record<string, unknown>, field: string): unknown => {
  if (field in row) return row[field];
  const camel = snakeToCamel(field);
  if (camel !== field && camel in row) return row[camel];
  return undefined;
};

const matchesInner = (
  row: Record<string, unknown>,
  cond: Condition,
  ctx: AuthSubject,
  now: number,
): boolean => {
  if (isAnd(cond)) return cond.$and.every((c) => matchesInner(row, c, ctx, now));
  if (isOr(cond)) return cond.$or.some((c) => matchesInner(row, c, ctx, now));
  if (isNot(cond)) return !matchesInner(row, cond.$not, ctx, now);
  // JS predicate is dialect-agnostic: relative dates resolve to epoch-ms so the
  // numeric comparisons below stay comparable.
  const r = (v: unknown) => resolve(v, ctx, now, undefined);
  for (const [field, cmp] of Object.entries(cond as Record<string, ComparisonObj>)) {
    const left = lookup(row, field);
    if (cmp._eq !== undefined && left !== r(cmp._eq)) return false;
    if (cmp._neq !== undefined && left === r(cmp._neq)) return false;
    if (cmp._in !== undefined) {
      const arr = (cmp._in as unknown[]).map(r);
      if (!arr.includes(left)) return false;
    }
    if (cmp._nin !== undefined) {
      const arr = (cmp._nin as unknown[]).map(r);
      if (arr.includes(left)) return false;
    }
    if (cmp._gt !== undefined && !(Number(left) > Number(r(cmp._gt)))) return false;
    if (cmp._gte !== undefined && !(Number(left) >= Number(r(cmp._gte)))) return false;
    if (cmp._lt !== undefined && !(Number(left) < Number(r(cmp._lt)))) return false;
    if (cmp._lte !== undefined && !(Number(left) <= Number(r(cmp._lte)))) return false;
    if (cmp._between !== undefined) {
      const lo = Number(r(cmp._between[0]));
      const hi = Number(r(cmp._between[1]));
      const n = Number(left);
      if (!(n >= lo && n <= hi)) return false;
    }
    if (cmp._null === true && left != null) return false;
    if (cmp._null === false && left == null) return false;
    if (cmp._empty === true && !(left == null || left === "")) return false;
    if (cmp._nempty === true && (left == null || left === "")) return false;
    if (cmp._contains !== undefined && !String(left ?? "").includes(String(r(cmp._contains)))) {
      return false;
    }
    if (cmp._starts_with !== undefined && !String(left ?? "").startsWith(String(r(cmp._starts_with)))) {
      return false;
    }
    if (cmp._ends_with !== undefined && !String(left ?? "").endsWith(String(r(cmp._ends_with)))) {
      return false;
    }
    if (
      cmp._icontains !== undefined &&
      !String(left ?? "").toLowerCase().includes(String(r(cmp._icontains)).toLowerCase())
    ) {
      return false;
    }
    if (
      cmp._istarts_with !== undefined &&
      !String(left ?? "").toLowerCase().startsWith(String(r(cmp._istarts_with)).toLowerCase())
    ) {
      return false;
    }
    if (
      cmp._iends_with !== undefined &&
      !String(left ?? "").toLowerCase().endsWith(String(r(cmp._iends_with)).toLowerCase())
    ) {
      return false;
    }
  }
  return true;
};

export const matchesCondition = (
  row: Record<string, unknown>,
  cond: Condition,
  ctx: AuthSubject,
  opts: EvalOpts = {},
): boolean => matchesInner(row, cond, ctx, opts.now ?? Date.now());
