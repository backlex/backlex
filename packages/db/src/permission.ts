import { sql, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type {
  AuthSubject,
  ComparisonObj,
  Condition,
  DurationParts,
  RelativeNow,
} from "@backlex/core";
import { type GeoNearPlan, isNear, planNear, tryParseGeoPoint } from "./geo";

/** {@link planNear}, but a bad operand leaves as the caller's 422 rather than
 *  an unhandled 500. Names the field so the message points at the right key in
 *  a filter with several. */
export const planNearOrThrow = (field: string, raw: unknown): GeoNearPlan => {
  try {
    return planNear(raw);
  } catch (e) {
    throw new AppError("VALIDATION", `${field}: ${(e as Error).message}`);
  }
};

const FALSE: SQL = sql`(1=0)`;
const TRUE: SQL = sql`(1=1)`;

export type Dialect = "pg" | "sqlite";

/**
 * Fold case the way the TARGET STORE folds it — never more, never less.
 *
 * Two folds that disagree are worse than no fold at all, and this operator had
 * exactly that: the needle was folded by JavaScript (full Unicode) and the
 * column by SQLite's `LOWER()` (ASCII only), so they could never meet for any
 * character whose fold either engine declines to perform. Measured on a Turkish
 * catalog, `_icontains: "İşlemci"` returned NOTHING against a row literally
 * named "İşlemci soğutucu", while `_contains` — the case-SENSITIVE operator —
 * returned it. The insensitive operator found strictly less than the sensitive
 * one, which is not a rough edge, it is backwards.
 *
 * So: on SQLite, fold ASCII and stop, because that is precisely what its
 * `LOWER()` does and both sides must agree. On Postgres, `lower()` is
 * locale-aware and the SQL path lets PG fold BOTH sides, so the JS side folds
 * fully to stay in step with it.
 *
 * What this deliberately does NOT do is make SQLite fold `İ` → `i`. It cannot:
 * D1 ships no ICU, and inventing a Turkish rule here would break every other
 * Latin language (`I` → `ı` is correct in Turkish and wrong everywhere else).
 * The guarantee on offer is agreement, not completeness — see
 * `docs/querying.md`.
 */
export const foldCase = (s: string, dialect: Dialect | undefined): string =>
  dialect === "sqlite" ? s.replace(/[A-Z]/g, (c) => c.toLowerCase()) : s.toLowerCase();

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
  /**
   * Compile a DSL variable to a SQL EXPRESSION instead of resolving it to this
   * request's value.
   *
   * Everything that compiles a condition today does so per request, so
   * `$user.id` becomes a bound parameter holding the caller's id. A row-level
   * security policy is compiled ONCE and evaluated by Postgres for whoever is
   * connected, so the same variable has to stay symbolic — `backlex.uid()`
   * rather than a literal. Returning `null` falls back to the value.
   *
   * This is a seam rather than a second compiler on purpose: the operator
   * dispatch below is the part that would drift if it were written twice.
   */
  varSql?: (v: string) => SQL | null;
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
  // App-plane organizations. `$org.id` is the active org (null when the
  // subject has none selected — a `_eq` against null compiles to FALSE, so an
  // org-scoped rule denies rather than leaking across orgs). `$user.orgs` is
  // every membership, for rules that should span all of them.
  if (v === "$org.id") return ctx.orgId ?? null;
  if (v === "$org.role") return ctx.orgRole ?? null;
  if (v === "$user.orgs") return ctx.orgIds ?? [];
  if (v === "$now") return temporal(now, dialect);
  return v;
};

const resolve = (
  v: unknown,
  ctx: AuthSubject,
  now: number,
  dialect?: Dialect,
  varSql?: (v: string) => SQL | null,
): unknown => {
  if (isVar(v)) {
    // A symbolic mapping wins over this request's value — see EvalOpts.varSql.
    const asSql = varSql?.(v);
    if (asSql) return asSql;
    return resolveVar(v, ctx, now, dialect);
  }
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

/**
 * Read one number out of a `geo` column, dialect-correctly.
 *
 * A point is stored the way `json` is — `jsonb` on Postgres, a TEXT string of
 * JSON on SQLite — so getting at `lat` differs by dialect and the result has to
 * be forced to a float either way (`->>` yields text; `json_extract` yields
 * whatever the JSON had, which for an adopted column might be a string).
 *
 * The SQLite branch guards with `json_valid`. `json_extract` RAISES on
 * malformed input rather than returning NULL, so one junk row in an adopted
 * TEXT column would turn a filter into a 500 for the whole collection instead
 * of quietly not matching. Managed writes can't produce junk — `validateValue`
 * parses every point before it lands — but an adopted table arrives with
 * whatever it already had.
 */
const geoMember = (col: SQL, member: "lat" | "lng", dialect: Dialect | undefined): SQL =>
  dialect === "pg"
    ? sql`(${col} ->> ${member})::double precision`
    : sql`CAST(json_extract(CASE WHEN json_valid(${col}) THEN ${col} END, ${`$.${member}`}) AS REAL)`;

/**
 * Compile `_near` into a single arithmetic predicate.
 *
 * The emitted shape, with every capitalised name a bound constant computed in
 * JS from the query origin (see `geo.ts` for why it can be):
 *
 *     (LAT_OF(col) - LAT0) * (LAT_OF(col) - LAT0)
 *   + (WRAPPED_LNG_DELTA * SCALE) * (WRAPPED_LNG_DELTA * SCALE)
 *   <= MAX_DIST_SQ
 *
 * Three properties are load-bearing:
 *
 *  - **No `sqrt`, no trig.** Both sides are squared, and squaring is monotonic
 *    over non-negative reals, so the answer is identical to comparing real
 *    distances. SQLite only has `sqrt`/`cos` when its build enabled the math
 *    extension, which is a property of the deploy target, not of the query.
 *  - **The longitude difference is wrapped.** Plain subtraction says 179°E and
 *    179°W are 358° apart. The `CASE` folds it to the short way round, matching
 *    `lngDelta` in the JS twin exactly, so realtime and SQL agree in Fiji.
 *  - **A NULL column stays NULL** all the way to the comparison, which is
 *    UNKNOWN, which excludes the row. A place with no location is not near
 *    anything — including, correctly, not near the origin.
 */
const compileNear = (col: SQL, plan: GeoNearPlan, dialect: Dialect | undefined): SQL =>
  sql`(${geoDistanceSql(col, plan, dialect)} <= ${plan.maxDistSq})`;

/**
 * The ORDER BY expression for "nearest first" — the left-hand side of
 * {@link compileNear}, without the comparison.
 *
 * Squared distance sorts identically to distance, so the sort never needs the
 * square root either. Exported because the list handler resolves a sort on a
 * `geo` field into this, using the origin the request's own `_near` filter
 * supplied; there is no other origin it could mean.
 */
export const geoDistanceSql = (
  col: SQL,
  plan: GeoNearPlan,
  dialect: Dialect | undefined,
): SQL => {
  const lat = geoMember(col, "lat", dialect);
  const lng = geoMember(col, "lng", dialect);
  const dLat = sql`(${lat} - ${plan.lat})`;
  const rawDLng = sql`(${lng} - ${plan.lng})`;
  const dLng = sql`(CASE WHEN ${rawDLng} > 180 THEN ${rawDLng} - 360 WHEN ${rawDLng} < -180 THEN ${rawDLng} + 360 ELSE ${rawDLng} END * ${plan.lngScale})`;
  return sql`(${dLat} * ${dLat} + ${dLng} * ${dLng})`;
};

/**
 * Normalize the right-hand side of `_in` / `_nin` to a concrete array.
 *
 * Two accepted shapes:
 *   - a literal array, whose elements may themselves be variables
 *     (`{ status: { _in: ["draft", "$user.id"] } }`);
 *   - a bare variable that RESOLVES to an array — `$user.roles`, `$user.orgs`.
 *     Without this branch the compiler called `.map` on a string and threw a
 *     500, which made the array-valued variables unusable in the very operator
 *     they exist for.
 *
 * Anything else (a variable that resolved to null, a scalar) yields `[]`, which
 * the callers turn into FALSE for `_in` and TRUE for `_nin` — the same
 * fail-closed reading an explicitly empty list already had.
 */
const resolveList = (raw: unknown, r: (v: unknown) => unknown): unknown[] => {
  if (Array.isArray(raw)) return raw.map(r);
  if (isVar(raw)) {
    const resolved = r(raw);
    // Already-resolved values are concrete — don't re-resolve the elements.
    return Array.isArray(resolved) ? resolved : [];
  }
  return [];
};

const compileComparison = (
  field: string,
  cmp: ComparisonObj,
  ctx: AuthSubject,
  now: number,
  dialect: Dialect | undefined,
  colRef: ColRefResolver = defaultColRef,
  leaf?: LeafCompiler,
  varSql?: (v: string) => SQL | null,
): SQL => {
  if (leaf) {
    const override = leaf(field, cmp, ctx);
    if (override) return override;
  }
  const id = colRef(field);
  const r = (v: unknown) => resolve(v, ctx, now, dialect, varSql);
  /** A bare variable that maps to a SQL ARRAY expression (`$user.roles` →
   *  `backlex.roles()`). `resolveList` cannot help here: it expects a JS array
   *  and yields `[]` for anything else, which the callers read as "matches
   *  nothing" — so without this branch an RLS policy would silently deny. */
  const varArray = (raw: unknown): SQL | null =>
    varSql && isVar(raw) ? varSql(raw) : null;
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
    const asArray = varArray(cmp._in);
    if (asArray) {
      parts.push(sql`${id} = ANY(${asArray})`);
    } else {
      const arr = resolveList(cmp._in, r);
      if (arr.length === 0) return FALSE;
      parts.push(sql`${id} IN (${sql.join(arr.map((v) => sql`${v}`), sql`, `)})`);
    }
  }
  if (cmp._nin !== undefined) {
    const asArray = varArray(cmp._nin);
    if (asArray) {
      parts.push(sql`NOT (${id} = ANY(${asArray}))`);
    } else {
      const arr = resolveList(cmp._nin, r);
      if (arr.length === 0) return TRUE;
      parts.push(sql`${id} NOT IN (${sql.join(arr.map((v) => sql`${v}`), sql`, `)})`);
    }
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
  // Case-insensitive: ONE engine folds BOTH sides.
  //
  // The comment that used to sit here said the JS fold was "so PG and SQLite
  // agree regardless of column collation", which is exactly the trap — agreeing
  // takes one fold, and folding the needle in JS while the column went through
  // SQL's `LOWER()` is two. See {@link foldCase}.
  //
  // On Postgres the needle is handed to `lower()` so the database performs both
  // folds with its own locale rules. On SQLite the needle is folded in JS to
  // the ASCII-only standard `LOWER()` itself applies, which is the same thing
  // by the only means available — `LOWER(?)` there would be a second call to
  // the same weak function, and D1 has been touchy about what it will accept
  // inside a LIKE pattern.
  const ineedle = (v: unknown, wrap: (s: string) => string): SQL => {
    const raw = String(r(v));
    return dialect === "pg"
      ? sql`LOWER(${wrap(raw)})`
      : sql`${wrap(foldCase(raw, "sqlite"))}`;
  };
  if (cmp._icontains !== undefined) {
    parts.push(sql`LOWER(${id}) LIKE ${ineedle(cmp._icontains, (s) => `%${s}%`)}`);
  }
  if (cmp._istarts_with !== undefined) {
    parts.push(sql`LOWER(${id}) LIKE ${ineedle(cmp._istarts_with, (s) => `${s}%`)}`);
  }
  if (cmp._iends_with !== undefined) {
    parts.push(sql`LOWER(${id}) LIKE ${ineedle(cmp._iends_with, (s) => `%${s}`)}`);
  }
  if (cmp._near !== undefined) {
    // A malformed origin or radius is the CALLER's mistake, so it has to leave
    // as a 422. `planNear` throws a plain Error, which the global handler maps
    // to 500 — `AppError` is what makes the difference between "you sent
    // `radius: "soon"`" and an opaque server failure. Silently degrading to
    // "matches everything" would be worse than either.
    parts.push(compileNear(id, planNearOrThrow(field, r(cmp._near)), dialect));
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
  varSql?: (v: string) => SQL | null,
): SQL => {
  if (isAnd(cond)) {
    const parts = cond.$and.map((c) => compileInner(c, ctx, now, dialect, colRef, leaf, varSql));
    if (parts.length === 0) return TRUE;
    return sql`(${sql.join(parts, sql` AND `)})`;
  }
  if (isOr(cond)) {
    const parts = cond.$or.map((c) => compileInner(c, ctx, now, dialect, colRef, leaf, varSql));
    if (parts.length === 0) return FALSE;
    return sql`(${sql.join(parts, sql` OR `)})`;
  }
  if (isNot(cond)) {
    return sql`NOT (${compileInner(cond.$not, ctx, now, dialect, colRef, leaf, varSql)})`;
  }
  const fieldMap = cond as Record<string, ComparisonObj>;
  const keys = Object.keys(fieldMap);
  if (keys.length === 0) return TRUE;
  const parts = keys.map((k) =>
    compileComparison(k, fieldMap[k]!, ctx, now, dialect, colRef, leaf, varSql),
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
  compileInner(cond, ctx, opts.now ?? Date.now(), opts.dialect, colRef, leaf, opts.varSql);

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
    compileInner(c as Condition, ctx, now, opts.dialect, colRef, leaf, opts.varSql),
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
  if (field in row) return unwrapMoney(row[field]);
  const camel = snakeToCamel(field);
  if (camel !== field && camel in row) return unwrapMoney(row[camel]);
  return undefined;
};

/**
 * A money field's value is `{ amount, currency }`; comparisons are against the
 * amount.
 *
 * This matcher runs on ROWS — a realtime event, the permission simulator, a
 * cross-field validation rule — and those rows carry money in its canonical API
 * shape. Without this, `{ price: { _gt: 100 } }` would compare an object to a
 * number: `>` coerces the object to `NaN` and the clause silently never
 * matches, so a realtime subscriber filtering on price would receive nothing
 * and see no error.
 *
 * Comparing the amount alone is right because the SQL side does the same thing
 * — `normalizeMoneyOperands` pins the currency as a separate clause rather than
 * folding it into the comparison — so the two evaluators agree on the same
 * filter. Both are in the field's own major units.
 *
 * The shape test is EXACT — those two keys and nothing else — because this
 * function sees every field, not just money ones, and this evaluator decides
 * what a realtime subscriber is allowed to receive. A `json` column that merely
 * happens to carry an `amount` alongside other keys must keep comparing as the
 * object it is; widening a permission predicate is not a thing to do by
 * coincidence of shape.
 */
const unwrapMoney = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const keys = Object.keys(value as object);
  if (keys.length !== 2) return value;
  const v = value as { amount?: unknown; currency?: unknown };
  return typeof v.amount === "number" && typeof v.currency === "string" ? v.amount : value;
};

const matchesInner = (
  row: Record<string, unknown>,
  cond: Condition,
  ctx: AuthSubject,
  now: number,
  dialect: Dialect | undefined,
): boolean => {
  if (isAnd(cond)) return cond.$and.every((c) => matchesInner(row, c, ctx, now, dialect));
  if (isOr(cond)) return cond.$or.some((c) => matchesInner(row, c, ctx, now, dialect));
  if (isNot(cond)) return !matchesInner(row, cond.$not, ctx, now, dialect);
  // JS predicate is dialect-agnostic: relative dates resolve to epoch-ms so the
  // numeric comparisons below stay comparable. A comparison value of the form
  // `"$field.<name>"` resolves to a sibling row value — this is what powers
  // cross-field validation rules (`{ end_date: { _gte: "$field.start_date" } }`).
  const r = (v: unknown): unknown => {
    if (typeof v === "string" && v.startsWith("$field.")) {
      return lookup(row, v.slice("$field.".length));
    }
    return resolve(v, ctx, now, undefined);
  };
  // Numeric coercion with a date fallback so ordered comparisons on ISO-string
  // timestamps (incl. cross-field date rules) sort by instant instead of
  // NaN-failing. Non-date strings keep `Number()`'s existing behaviour.
  const num = (x: unknown): number => {
    const n = Number(x);
    if (!Number.isNaN(n)) return n;
    if (typeof x === "string") {
      const t = Date.parse(x);
      if (!Number.isNaN(t)) return t;
    }
    return Number.NaN;
  };
  for (const [field, cmp] of Object.entries(cond as Record<string, ComparisonObj>)) {
    // The JS matcher is row-local — it can't traverse relations, so a dotted
    // key (`employee.app_user_id`) has no value it could compare against.
    // Report NO MATCH (fail closed) instead of falling through to comparisons
    // against `undefined`, which could accidentally match (`_neq`, `_null`,
    // `_nin`, …). The SQL compiler lowers these keys to correlated EXISTS
    // subqueries; realtime + the permission simulator simply never match.
    if (field.includes(".")) return false;
    const left = lookup(row, field);
    if (cmp._eq !== undefined && left !== r(cmp._eq)) return false;
    if (cmp._neq !== undefined && left === r(cmp._neq)) return false;
    // Same variable-resolving list handling as the SQL compiler, so realtime
    // and the permission simulator agree with what the query layer produced.
    if (cmp._in !== undefined) {
      const arr = resolveList(cmp._in, r);
      if (!arr.includes(left)) return false;
    }
    if (cmp._nin !== undefined) {
      const arr = resolveList(cmp._nin, r);
      if (arr.includes(left)) return false;
    }
    if (cmp._gt !== undefined && !(num(left) > num(r(cmp._gt)))) return false;
    if (cmp._gte !== undefined && !(num(left) >= num(r(cmp._gte)))) return false;
    if (cmp._lt !== undefined && !(num(left) < num(r(cmp._lt)))) return false;
    if (cmp._lte !== undefined && !(num(left) <= num(r(cmp._lte)))) return false;
    if (cmp._between !== undefined) {
      const lo = num(r(cmp._between[0]));
      const hi = num(r(cmp._between[1]));
      const n = num(left);
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
    // Folded with the STORE's rules, not JavaScript's, so this predicate and
    // the SQL above answer the same question. Left unqualified (no dialect),
    // it keeps JS semantics — which is what every caller had before, so nothing
    // silently narrows for one that has not been told which store it stands in
    // for. `realtime-filter.ts` is told, because that is where a disagreement
    // becomes a row delivered over a socket that REST would have withheld.
    const fold = (v: unknown) => foldCase(String(v ?? ""), dialect);
    if (
      cmp._icontains !== undefined &&
      !fold(left).includes(fold(r(cmp._icontains)))
    ) {
      return false;
    }
    if (
      cmp._istarts_with !== undefined &&
      !fold(left).startsWith(fold(r(cmp._istarts_with)))
    ) {
      return false;
    }
    if (
      cmp._iends_with !== undefined &&
      !fold(left).endsWith(fold(r(cmp._iends_with)))
    ) {
      return false;
    }
    if (cmp._near !== undefined) {
      // Same projection, same origin-derived scale factor as the SQL — so a
      // realtime subscriber and the list query that seeded it agree about which
      // rows are in the radius. Nothing here throws: this predicate runs in a
      // realtime fan-out and in the permission simulator, where one bad row (or
      // one bad stored rule) must not take down the whole delivery. Both
      // failures fail CLOSED — an unreadable point is not near anything, and an
      // unusable rule matches nothing.
      const point = tryParseGeoPoint(left);
      if (!point) return false;
      let plan: GeoNearPlan;
      try {
        plan = planNear(r(cmp._near));
      } catch {
        return false;
      }
      if (!isNear(point, plan)) return false;
    }
  }
  return true;
};

export const matchesCondition = (
  row: Record<string, unknown>,
  cond: Condition,
  ctx: AuthSubject,
  opts: EvalOpts = {},
): boolean => matchesInner(row, cond, ctx, opts.now ?? Date.now(), opts.dialect);

/** Operators that ORDER two values. These are the ones with nothing to say
 *  when either side is missing — an equality still has an answer (`_eq` against
 *  an absent column is simply false, and that is a real verdict). */
const ORDERED_OPS = new Set(["_gt", "_gte", "_lt", "_lte", "_between"]);

/** Absent for the purpose of "is there anything to compare?" — including the
 *  empty string, which is how the admin form clears a box. */
const absent = (v: unknown): boolean => v === undefined || v === null || v === "";

/**
 * Is `value` a `$field.` reference that travels through a relation
 * (`$field.zone.warehouse`) and has no hydrated value on this row? The write
 * path fills these in before judging a rule — see `hydrateRuleHops` — so an
 * absent one means the relation itself is unset, not that the hop is
 * unsupported. A same-row ref (`$field.start_date`) is never "absent" by this
 * test, which is what keeps the older narrowing rules intact.
 */
const isAbsentHop = (row: Record<string, unknown>, value: string): boolean => {
  if (!value.startsWith("$field.")) return false;
  const path = value.slice("$field.".length);
  if (!path.includes(".")) return false;
  return absent(lookup(row, path));
};

/**
 * Narrow a condition to the part this row can actually be judged on, for the
 * VALIDATION path only. Returns `null` when the row supports no verdict at all.
 *
 * The problem this exists for: {@link matchesCondition} answers "does this row
 * match?", and for a filter its treatment of a missing value is exactly right —
 * `amount >= 100` must not match a row with no amount, because a permission
 * that fell open on absence would be a hole. A cross-field VALIDATION rule asks
 * a different question — "is this row invalid?" — and there the same answer is
 * wrong: `due_date >= issue_date` on a draft that has neither date yet is not a
 * violation, it is a question with no operands. Before this, an invoice created
 * without dates was refused with "An invoice can't fall due before it is
 * issued", which is not what happened and does not say what to do.
 *
 * `range` already reached this conclusion for the ordering it enforces itself —
 * `rangeOrderError` returns null when either endpoint is missing, "fine by
 * construction: an open period has nothing to compare". This is the same rule
 * for the hand-written half.
 *
 * The narrowing is per-operator, not per-rule, so a rule keeps every part that
 * IS answerable: `{a: {_gte: "$field.b", _lte: 100}}` with `b` absent still
 * enforces the ceiling. Unknown propagates the way it must through the
 * connectives — an `$or` branch that cannot be judged might have been the one
 * that satisfied it, and a `$not` of an unknown is unknown — so only `$and`
 * survives partially, which is sound because a conjunction only ever gets
 * stricter as branches drop.
 *
 * The one operand that steps aside for EVERY operator, not just the ordered
 * ones, is a relation hop (`$field.zone.warehouse`) the row has no value for —
 * see {@link isAbsentHop}. An unset relation is not a disagreement about a
 * value, it is the absence of the row that would have held one, and `_eq`
 * cannot say that: it would refuse a bin for not having a zone yet. Same-row
 * refs keep the narrower rule above, so nothing already in production moves.
 *
 * Deliberately NOT a flag on `matchesCondition`: one boolean away from turning
 * a permission's fail-closed into a fail-open is not a place to put an option.
 */
export const checkableRule = (
  row: Record<string, unknown>,
  cond: Condition,
): Condition | null => {
  const walk = (node: unknown): unknown => {
    if (node === null || node === undefined || typeof node !== "object") return node;
    const c = node as Record<string, unknown>;
    if (Array.isArray(c.$and)) {
      const kept = (c.$and as unknown[]).map(walk).filter((x) => x !== null);
      if (kept.length === 0) return null;
      return kept.length === 1 ? kept[0] : { $and: kept };
    }
    if (Array.isArray(c.$or)) {
      const parts = (c.$or as unknown[]).map(walk);
      // One unjudgeable branch makes the whole disjunction unjudgeable.
      if (parts.some((x) => x === null)) return null;
      return { $or: parts };
    }
    if (c.$not !== undefined) {
      const inner = walk(c.$not);
      return inner === null ? null : { $not: inner };
    }
    const out: Record<string, unknown> = {};
    for (const [field, cmp] of Object.entries(c)) {
      if (cmp === null || typeof cmp !== "object" || Array.isArray(cmp)) {
        out[field] = cmp;
        continue;
      }
      const left = lookup(row, field);
      const rest: Record<string, unknown> = {};
      for (const [op, operand] of Object.entries(cmp as Record<string, unknown>)) {
        const sides = Array.isArray(operand) ? operand : [operand];
        // A hop through a relation the row does not set has no row on the
        // other side, so there is nothing to compare against — the rule is a
        // question, not a violation. Narrowed for EVERY operator, unlike the
        // same-row case below: `_eq` against an absent operand is false for
        // every real left value, so leaving it in would refuse a bin merely for
        // having no zone yet. Same-row `$field.` refs keep the older, narrower
        // behaviour (only orderings step aside) — widening that would quietly
        // weaken rules already in production.
        if (sides.some((x) => typeof x === "string" && isAbsentHop(row, x))) continue;
        if (ORDERED_OPS.has(op)) {
          if (absent(left)) continue;
          const missing = sides.some(
            (s) =>
              typeof s === "string" &&
              s.startsWith("$field.") &&
              absent(lookup(row, s.slice("$field.".length))),
          );
          if (missing) continue;
        }
        rest[op] = operand;
      }
      if (Object.keys(rest).length > 0) out[field] = rest;
    }
    return Object.keys(out).length === 0 ? null : out;
  };
  return walk(cond) as Condition | null;
};
