import {
  type Condition,
  type DurationParts,
  type RelativeNow,
  normalizeCondition,
} from "./condition";
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

/** Fluent condition factory passed to `QueryBuilder.where(...)`. Each method
 *  returns a canonical {@link Condition}; multiple are combined with `and`/`or`. */
export interface FilterBuilder<T> {
  /** `field = value`. */
  eq(field: FieldKey<T>, value: unknown): Condition;
  /** `field != value`. */
  neq(field: FieldKey<T>, value: unknown): Condition;
  /** `field > value`. */
  gt(field: FieldKey<T>, value: unknown): Condition;
  /** `field >= value`. */
  gte(field: FieldKey<T>, value: unknown): Condition;
  /** `field < value`. */
  lt(field: FieldKey<T>, value: unknown): Condition;
  /** `field <= value`. */
  lte(field: FieldKey<T>, value: unknown): Condition;
  /** `field IN (values)`. */
  in(field: FieldKey<T>, values: unknown[]): Condition;
  /** `field NOT IN (values)`. */
  nin(field: FieldKey<T>, values: unknown[]): Condition;
  /** `field BETWEEN lo AND hi` (inclusive). */
  between(field: FieldKey<T>, lo: unknown, hi: unknown): Condition;
  /** `field IS NULL` (or `IS NOT NULL` when `isNull` is false). */
  isNull(field: FieldKey<T>, isNull?: boolean): Condition;
  /** `field` is NULL or empty string. */
  empty(field: FieldKey<T>): Condition;
  /** `field` is neither NULL nor empty string. */
  nempty(field: FieldKey<T>): Condition;
  /** `field` contains the substring `value`. */
  contains(field: FieldKey<T>, value: string): Condition;
  /** Case-insensitive {@link contains}. */
  icontains(field: FieldKey<T>, value: string): Condition;
  /** `field` starts with `value`. */
  startsWith(field: FieldKey<T>, value: string): Condition;
  /** `field` ends with `value`. */
  endsWith(field: FieldKey<T>, value: string): Condition;
  /** Logical AND of the given conditions. */
  and(...conds: Condition[]): Condition;
  /** Logical OR of the given conditions. */
  or(...conds: Condition[]): Condition;
  /** Logical NOT of a condition. */
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

/** Fluent, type-safe query builder returned by `from(slug).query()`. Chain
 *  `.where`/`.select`/`.orderBy`/… and finish with `.list()` (or `.toQuery()`). */
export class QueryBuilder<T extends Record<string, unknown>> {
  private _filter?: Condition;
  private _sort: string[] = [];
  private _fields: string[] = [];
  private _expand: string[] = [];
  private _limit?: number;
  private _offset?: number;
  private _cursor?: string;
  private _meta?: "filter_count" | "total_count" | "*";
  private _locale?: string;
  private _q?: string;

  constructor(private readonly listFn: (q: ListQuery) => Promise<ListResponse<T>>) {}

  /** Build the filter fluently with a {@link FilterBuilder}. */
  where(build: (f: FilterBuilder<T>) => Condition): this {
    this._filter = normalizeCondition(build(makeFilterBuilder<T>()));
    return this;
  }
  /** Replace the filter with a raw canonical condition (escape hatch). */
  filter(cond: Condition): this {
    this._filter = normalizeCondition(cond);
    return this;
  }
  /** Project only these fields (column allow-list). */
  select(...fields: FieldKey<T>[]): this {
    this._fields.push(...(fields as string[]));
    return this;
  }
  /** Sort by one or more keys (`"-field"` for descending). */
  orderBy(...sorts: SortKey<T>[]): this {
    this._sort.push(...(sorts as string[]));
    return this;
  }
  /** Inline single-hop relations (replaces each FK with the related object). */
  expand(...rels: FieldKey<T>[]): this {
    this._expand.push(...(rels as string[]));
    return this;
  }
  /** Project `localized` fields to one locale, or `"*"` for the full map. */
  locale(loc: string): this {
    this._locale = loc;
    return this;
  }
  /** Free-text search across readable text fields. */
  search(text: string): this {
    this._q = text;
    return this;
  }
  /** Max rows to return. */
  limit(n: number): this {
    this._limit = n;
    return this;
  }
  /** Number of rows to skip (paging). */
  offset(n: number): this {
    this._offset = n;
    return this;
  }
  /** Keyset (seek) pagination — pass `""` for the first page, then echo each
   *  response's `next_cursor`. Flat latency at any depth; supersedes `offset`. */
  cursor(c: string): this {
    this._cursor = c;
    return this;
  }
  /** Ask the server for a count alongside the page (`filter_count` / `total_count`). */
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
    if (this._expand.length) q.expand = this._expand;
    if (this._limit !== undefined) q.limit = this._limit;
    if (this._offset !== undefined) q.offset = this._offset;
    if (this._cursor !== undefined) q.cursor = this._cursor;
    if (this._meta) q.meta = this._meta;
    if (this._locale) q.locale = this._locale;
    if (this._q) q.q = this._q;
    return q;
  }
  /** Run the query and return the page of rows. */
  list(): Promise<ListResponse<T>> {
    return this.listFn(this.toQuery());
  }
}
