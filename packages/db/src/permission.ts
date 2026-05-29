import { sql, type SQL } from "drizzle-orm";
import type { AuthSubject, ComparisonObj, Condition } from "@backlex/core";

const FALSE: SQL = sql`(1=0)`;
const TRUE: SQL = sql`(1=1)`;

const isAnd = (c: Condition): c is { $and: Condition[] } =>
  Array.isArray((c as { $and?: unknown }).$and);
const isOr = (c: Condition): c is { $or: Condition[] } =>
  Array.isArray((c as { $or?: unknown }).$or);
const isNot = (c: Condition): c is { $not: Condition } =>
  (c as { $not?: unknown }).$not !== undefined;

const isVar = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith("$");

const resolveVar = (v: string, ctx: AuthSubject): unknown => {
  if (v === "$user.id") return ctx.userId;
  if (v === "$user.email") return ctx.email;
  if (v === "$user.roles") return ctx.roles;
  if (v === "$tenant.id" || v === "$user.tenant_id") return ctx.tenantId ?? null;
  if (v === "$now") return Date.now();
  return v;
};

const resolve = (v: unknown, ctx: AuthSubject): unknown =>
  isVar(v) ? resolveVar(v, ctx) : v;

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
  colRef: ColRefResolver = defaultColRef,
  leaf?: LeafCompiler,
): SQL => {
  if (leaf) {
    const override = leaf(field, cmp, ctx);
    if (override) return override;
  }
  const id = colRef(field);
  const parts: SQL[] = [];
  if (cmp._eq !== undefined) {
    const v = resolve(cmp._eq, ctx);
    if (v === null || v === undefined) return FALSE;
    parts.push(sql`${id} = ${v}`);
  }
  if (cmp._neq !== undefined) {
    const v = resolve(cmp._neq, ctx);
    parts.push(v === null || v === undefined ? sql`${id} IS NOT NULL` : sql`${id} <> ${v}`);
  }
  if (cmp._in !== undefined) {
    const arr = (cmp._in as unknown[]).map((x) => resolve(x, ctx));
    if (arr.length === 0) return FALSE;
    parts.push(sql`${id} IN (${sql.join(arr.map((v) => sql`${v}`), sql`, `)})`);
  }
  if (cmp._nin !== undefined) {
    const arr = (cmp._nin as unknown[]).map((x) => resolve(x, ctx));
    if (arr.length === 0) return TRUE;
    parts.push(sql`${id} NOT IN (${sql.join(arr.map((v) => sql`${v}`), sql`, `)})`);
  }
  if (cmp._gt !== undefined) parts.push(sql`${id} > ${resolve(cmp._gt, ctx)}`);
  if (cmp._gte !== undefined) parts.push(sql`${id} >= ${resolve(cmp._gte, ctx)}`);
  if (cmp._lt !== undefined) parts.push(sql`${id} < ${resolve(cmp._lt, ctx)}`);
  if (cmp._lte !== undefined) parts.push(sql`${id} <= ${resolve(cmp._lte, ctx)}`);
  if (cmp._null === true) parts.push(sql`${id} IS NULL`);
  if (cmp._null === false) parts.push(sql`${id} IS NOT NULL`);
  if (cmp._contains !== undefined) {
    const v = resolve(cmp._contains, ctx);
    parts.push(sql`${id} LIKE ${`%${String(v)}%`}`);
  }
  if (cmp._starts_with !== undefined) {
    const v = resolve(cmp._starts_with, ctx);
    parts.push(sql`${id} LIKE ${`${String(v)}%`}`);
  }
  if (cmp._ends_with !== undefined) {
    const v = resolve(cmp._ends_with, ctx);
    parts.push(sql`${id} LIKE ${`%${String(v)}`}`);
  }
  if (parts.length === 0) return TRUE;
  return sql`(${sql.join(parts, sql` AND `)})`;
};

export const compileCondition = (
  cond: Condition,
  ctx: AuthSubject,
  colRef: ColRefResolver = defaultColRef,
  leaf?: LeafCompiler,
): SQL => {
  if (isAnd(cond)) {
    const parts = cond.$and.map((c) => compileCondition(c, ctx, colRef, leaf));
    if (parts.length === 0) return TRUE;
    return sql`(${sql.join(parts, sql` AND `)})`;
  }
  if (isOr(cond)) {
    const parts = cond.$or.map((c) => compileCondition(c, ctx, colRef, leaf));
    if (parts.length === 0) return FALSE;
    return sql`(${sql.join(parts, sql` OR `)})`;
  }
  if (isNot(cond)) {
    return sql`NOT (${compileCondition(cond.$not, ctx, colRef, leaf)})`;
  }
  const fieldMap = cond as Record<string, ComparisonObj>;
  const keys = Object.keys(fieldMap);
  if (keys.length === 0) return TRUE;
  const parts = keys.map((k) => compileComparison(k, fieldMap[k]!, ctx, colRef, leaf));
  return sql`(${sql.join(parts, sql` AND `)})`;
};

/**
 * Combine multiple conditions with OR (most permissive across roles).
 * Returns null if all role permissions had no condition (= unrestricted).
 */
export const combineConditions = (
  conds: (Condition | null | undefined)[],
  ctx: AuthSubject,
  colRef: ColRefResolver = defaultColRef,
  leaf?: LeafCompiler,
): SQL | null => {
  if (conds.length === 0) return FALSE;
  if (conds.some((c) => c === null || c === undefined)) {
    // At least one role grants unconditional access.
    return null;
  }
  const compiled = conds.map((c) => compileCondition(c as Condition, ctx, colRef, leaf));
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

export const matchesCondition = (
  row: Record<string, unknown>,
  cond: Condition,
  ctx: AuthSubject,
): boolean => {
  if (isAnd(cond)) return cond.$and.every((c) => matchesCondition(row, c, ctx));
  if (isOr(cond)) return cond.$or.some((c) => matchesCondition(row, c, ctx));
  if (isNot(cond)) return !matchesCondition(row, cond.$not, ctx);
  for (const [field, cmp] of Object.entries(cond as Record<string, ComparisonObj>)) {
    const left = lookup(row, field);
    if (cmp._eq !== undefined && left !== resolve(cmp._eq, ctx)) return false;
    if (cmp._neq !== undefined && left === resolve(cmp._neq, ctx)) return false;
    if (cmp._in !== undefined) {
      const arr = (cmp._in as unknown[]).map((x) => resolve(x, ctx));
      if (!arr.includes(left)) return false;
    }
    if (cmp._nin !== undefined) {
      const arr = (cmp._nin as unknown[]).map((x) => resolve(x, ctx));
      if (arr.includes(left)) return false;
    }
    if (cmp._gt !== undefined && !(Number(left) > Number(resolve(cmp._gt, ctx)))) return false;
    if (cmp._gte !== undefined && !(Number(left) >= Number(resolve(cmp._gte, ctx)))) return false;
    if (cmp._lt !== undefined && !(Number(left) < Number(resolve(cmp._lt, ctx)))) return false;
    if (cmp._lte !== undefined && !(Number(left) <= Number(resolve(cmp._lte, ctx)))) return false;
    if (cmp._null === true && left != null) return false;
    if (cmp._null === false && left == null) return false;
    if (cmp._contains !== undefined && !String(left ?? "").includes(String(resolve(cmp._contains, ctx)))) {
      return false;
    }
    if (cmp._starts_with !== undefined && !String(left ?? "").startsWith(String(resolve(cmp._starts_with, ctx)))) {
      return false;
    }
    if (cmp._ends_with !== undefined && !String(left ?? "").endsWith(String(resolve(cmp._ends_with, ctx)))) {
      return false;
    }
  }
  return true;
};
