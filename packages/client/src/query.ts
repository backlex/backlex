import {
  type Condition,
  type DurationParts,
  type RelativeNow,
  normalizeCondition,
} from "@backlex/core";
import type { ListQuery, ListResponse } from "./types";

/**
 * Type-safe fluent query builder — a Drizzle/Supabase-style ergonomics layer
 * that COMPILES to the canonical JSON `Condition` / `ListQuery` the REST API
 * already speaks. It is NOT a new wire format: `.toQuery()` returns a plain
 * `ListQuery`, so everything (permissions, AI plans, serialization) stays on
 * the one JSON grammar.
 *
 *   const { data } = await client.from<Order>("orders").query()
 *     .where(f => f.and(
 *       f.eq("status", "active"),
 *       f.gte("total", 100),
 *       f.rel("customer", c => c.eq("tier", "gold")),   // → "customer.tier"
 *       f.gte("placed_at", f.now({ sub: { months: 1 } })),
 *     ))
 *     .select("id", "total", "customer.name")
 *     .orderBy("-placed_at", "id")
 *     .limit(50)
 *     .list();
 *
 * Field args are typed `keyof T | (string & {})` — autocomplete for known
 * columns, dotted relation paths still allowed, no codegen required.
 */

/** A known column of `T`, or any string (dotted relation paths, computed). */
export type FieldKey<T> = (keyof T & string) | (string & {});

/** `field` ascending, or `-field` descending. */
export type SortKey<T> = FieldKey<T> | `-${string}`;

/** Prefix every leaf field key of a condition with `head.` (relation hop). */
const prefixKeys = (cond: Condition, head: string): Condition => {
  const c = cond as Record<string, unknown>;
  if (Array.isArray(c.$and)) {
    return { $and: (c.$and as Condition[]).map((x) => prefixKeys(x, head)) };
  }
  if (Array.isArray(c.$or)) {
    return { $or: (c.$or as Condition[]).map((x) => prefixKeys(x, head)) };
  }
  if (c.$not !== undefined) {
    return { $not: prefixKeys(c.$not as Condition, head) };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) out[`${head}.${k}`] = v;
  return out as Condition;
};

export interface FilterBuilder<T> {
  eq(field: FieldKey<T>, value: unknown): Condition;
  neq(field: FieldKey<T>, value: unknown): Condition;
  gt(field: FieldKey<T>, value: unknown): Condition;
  gte(field: FieldKey<T>, value: unknown): Condition;
  lt(field: FieldKey<T>, value: unknown): Condition;
  lte(field: FieldKey<T>, value: unknown): Condition;
  in(field: FieldKey<T>, values: unknown[]): Condition;
  nin(field: FieldKey<T>, values: unknown[]): Condition;
  between(field: FieldKey<T>, lo: unknown, hi: unknown): Condition;
  isNull(field: FieldKey<T>, isNull?: boolean): Condition;
  empty(field: FieldKey<T>): Condition;
  nempty(field: FieldKey<T>): Condition;
  contains(field: FieldKey<T>, value: string): Condition;
  icontains(field: FieldKey<T>, value: string): Condition;
  startsWith(field: FieldKey<T>, value: string): Condition;
  endsWith(field: FieldKey<T>, value: string): Condition;
  and(...conds: Condition[]): Condition;
  or(...conds: Condition[]): Condition;
  not(cond: Condition): Condition;
  /** Traverse a relation: keys produced by `build` are prefixed with `head.`. */
  rel<R = Record<string, unknown>>(
    head: FieldKey<T>,
    build: (f: FilterBuilder<R>) => Condition,
  ): Condition;
  /** Relative-date value, e.g. `f.now({ sub: { months: 1 } })`. */
  now(opts?: { add?: DurationParts; sub?: DurationParts }): RelativeNow;
}

const makeFilterBuilder = <T>(): FilterBuilder<T> => {
  const leaf = (field: string, op: string, value: unknown): Condition =>
    ({ [field]: { [op]: value } }) as Condition;
  return {
    eq: (f, v) => leaf(f, "_eq", v),
    neq: (f, v) => leaf(f, "_neq", v),
    gt: (f, v) => leaf(f, "_gt", v),
    gte: (f, v) => leaf(f, "_gte", v),
    lt: (f, v) => leaf(f, "_lt", v),
    lte: (f, v) => leaf(f, "_lte", v),
    in: (f, v) => leaf(f, "_in", v),
    nin: (f, v) => leaf(f, "_nin", v),
    between: (f, lo, hi) => leaf(f, "_between", [lo, hi]),
    isNull: (f, isNull = true) => leaf(f, "_null", isNull),
    empty: (f) => leaf(f, "_empty", true),
    nempty: (f) => leaf(f, "_nempty", true),
    contains: (f, v) => leaf(f, "_contains", v),
    icontains: (f, v) => leaf(f, "_icontains", v),
    startsWith: (f, v) => leaf(f, "_starts_with", v),
    endsWith: (f, v) => leaf(f, "_ends_with", v),
    and: (...conds) => ({ $and: conds }),
    or: (...conds) => ({ $or: conds }),
    not: (cond) => ({ $not: cond }),
    rel: (head, build) =>
      prefixKeys(build(makeFilterBuilder()), head as string),
    now: (opts = {}) => ({ $now: { ...opts } }),
  };
};

export class QueryBuilder<T extends Record<string, unknown>> {
  private _filter?: Condition;
  private _sort: string[] = [];
  private _fields: string[] = [];
  private _limit?: number;
  private _offset?: number;
  private _meta?: "filter_count" | "total_count" | "*";

  constructor(private readonly listFn: (q: ListQuery) => Promise<ListResponse<T>>) {}

  where(build: (f: FilterBuilder<T>) => Condition): this {
    this._filter = normalizeCondition(build(makeFilterBuilder<T>()));
    return this;
  }
  /** Replace the filter with a raw canonical condition (escape hatch). */
  filter(cond: Condition): this {
    this._filter = normalizeCondition(cond);
    return this;
  }
  select(...fields: FieldKey<T>[]): this {
    this._fields.push(...(fields as string[]));
    return this;
  }
  orderBy(...sorts: SortKey<T>[]): this {
    this._sort.push(...(sorts as string[]));
    return this;
  }
  limit(n: number): this {
    this._limit = n;
    return this;
  }
  offset(n: number): this {
    this._offset = n;
    return this;
  }
  withMeta(m: "filter_count" | "total_count" | "*"): this {
    this._meta = m;
    return this;
  }
  /** Assemble the plain `ListQuery` — the canonical JSON the REST API takes. */
  toQuery(): ListQuery {
    const q: ListQuery = {};
    if (this._filter) q.filter = this._filter;
    if (this._sort.length) q.sort = this._sort;
    if (this._fields.length) q.fields = this._fields;
    if (this._limit !== undefined) q.limit = this._limit;
    if (this._offset !== undefined) q.offset = this._offset;
    if (this._meta) q.meta = this._meta;
    return q;
  }
  list(): Promise<ListResponse<T>> {
    return this.listFn(this.toQuery());
  }
}
