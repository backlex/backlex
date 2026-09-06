import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { AppError, COMPARISON_OPERATORS, normalizeCondition } from "@backlex/core";
import type { AuthSubject } from "@backlex/core";
import {
  compileCondition,
  currencyExponent,
  type FieldDef,
  fromMinorUnits,
  getChoices,
  isDecimalStorage,
  normalizeCurrency,
} from "@backlex/db";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { normalizeMoneyOperands } from "./money-fields";
import { normalizeEmailOperands } from "./email-fields";
import { normalizeUrlOperands } from "./url-fields";
import { normalizePhoneOperands } from "./phone-fields";
import { expandRangeOperators, rangeFieldsOf } from "@backlex/db/range";
import { normalizeTemporalOperands } from "./temporal-fields";
import { queryAll } from "./sql-helpers";

/**
 * Item aggregation engine — `count` / `sum` / `avg` / `min` / `max`, with an
 * optional `groupBy`. Extracted from routes/panels.ts so both dashboard panels
 * AND the items REST/aggregate endpoint + the `collections.aggregate` MCP tool
 * share one tested implementation.
 *
 * Permission posture: panels call this admin-only with no `perm` opts (legacy
 * behavior — tenant scope only). The REST endpoint passes the caller's resolved
 * read permission (`whereSql` AND-ed into the query; `fields` allow-list gating
 * the agg target, groupBy AND every filter key), so a non-admin can never
 * aggregate over rows or columns they can't read — including by narrowing on a
 * hidden column and reading its value out of the row counts.
 */

/**
 * Walk a normalized condition and reject any leaf key that is not a real
 * column of the collection.
 *
 * Combinators (`$and` / `$or` / `$not`) recurse; everything else is a field
 * map whose keys must resolve. A dotted key is rejected outright rather than
 * left to SQL: aggregate is single-table, so a relation path was never going
 * to work, and saying so is more use than "no such column: customer.name".
 */
const assertKnownFilterColumns = (
  cond: unknown,
  isKnownColumn: (name: string) => boolean,
  collection: string,
  columnHint: () => string,
  gateField: (name: string) => void,
): void => {
  const recurse = (c: unknown) =>
    assertKnownFilterColumns(c, isKnownColumn, collection, columnHint, gateField);
  if (cond === null || typeof cond !== "object") return;
  const node = cond as Record<string, unknown>;
  if (Array.isArray(node.$and)) {
    for (const c of node.$and) recurse(c);
    return;
  }
  if (Array.isArray(node.$or)) {
    for (const c of node.$or) recurse(c);
    return;
  }
  if (node.$not !== undefined) {
    recurse(node.$not);
    return;
  }
  for (const key of Object.keys(node)) {
    if (key.includes(".")) {
      throw new AppError(
        "VALIDATION",
        `Filter on "${key}" traverses a relation, which aggregate cannot do (it is single-table). Filter on a column of "${collection}" instead.`,
      );
    }
    if (!isKnownColumn(key)) {
      throw new AppError(
        "VALIDATION",
        `Filter field "${key}" is not in collection "${collection}". Valid columns: ${columnHint()}`,
      );
    }
    // …and the operators it carries must be ones something implements. Same
    // reason as the list door (`lib/query.ts`): an unrecognised operator used
    // to compile to `(1=1)`, which on an AGGREGATE means the tile shows the
    // unfiltered total and reads exactly like a correct number.
    const cmp = node[key];
    if (cmp && typeof cmp === "object" && !Array.isArray(cmp)) {
      const ops = Object.keys(cmp as Record<string, unknown>);
      if (ops.length > 0 && ops.every((op) => op.startsWith("_"))) {
        const unknownOps = ops.filter((op) => !COMPARISON_OPERATORS.has(op));
        if (unknownOps.length > 0) {
          throw new AppError(
            "VALIDATION",
            `Unknown filter operator(s) on "${key}": ${unknownOps.join(", ")}`,
          );
        }
      }
    }
    // …and it must be a column this caller may READ.
    //
    // The agg target and groupBy were already gated; a filter key was not, so a
    // caller holding a field allow-list could narrow on a column outside it and
    // read the excluded value out of the counts — ask for
    // `{salary: {_gte: N}}` at a few values of N and the row count binary-
    // searches it. The value never appears in the response, which is exactly
    // why it went unnoticed.
    gateField(key);
  }
};

/** A window sliced into equal buckets, for a series over time. */
export interface AggregateBucket {
  /** Timestamp column the slices are cut on. */
  field: string;
  /** Window start, epoch ms — bucket 0 begins here. */
  from: number;
  /** Slice width in ms. */
  widthMs: number;
  /** How many slices; also the row cap. */
  count: number;
}

/**
 * SQL for "which bucket does this row's timestamp fall in".
 *
 * The dialects store the column differently and neither conversion is
 * optional: SQLite keeps epoch **milliseconds** in an INTEGER, Postgres keeps
 * a `timestamptz` whose epoch comes back in **seconds** as a float. Getting
 * this wrong does not error — it produces a series bucketed a thousand times
 * too coarse or too fine, which looks like data.
 */
const bucketIndexSql = (b: AggregateBucket, dialect: "pg" | "sqlite"): SQL => {
  const col = sql.identifier(b.field);
  // Inlined rather than bound. Postgres cannot infer a type for a bare `$n`
  // sitting in `numeric - $1`, and the query fails with "could not determine
  // data type of parameter". These two are server-computed integers — the
  // window bound and the slice width, both derived from validated input and
  // re-floored here — so there is no untrusted text to inline, and the guard
  // below is what keeps that true.
  const from = Math.trunc(b.from);
  const width = Math.trunc(b.widthMs);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(width) || width < 1) {
    throw new AppError("VALIDATION", "Series window is not a usable range");
  }
  if (dialect === "pg") {
    return sql`FLOOR(((EXTRACT(EPOCH FROM ${col}) * 1000) - ${sql.raw(String(from))}) / ${sql.raw(String(width))})`;
  }
  return sql`CAST((${col} - ${sql.raw(String(from))}) / ${sql.raw(String(width))} AS INTEGER)`;
};

export const ITEMS_AGG_FUNCS = ["count", "sum", "avg", "min", "max"] as const;
export type ItemsAggFunc = (typeof ITEMS_AGG_FUNCS)[number];

/**
 * True for the multi-select shape — a `json` column whose field defines the
 * choices it may hold, so its value is an ARRAY of those choices.
 *
 * `relation_many` is the same storage but deliberately not included: its
 * elements are foreign ids, and a chart labelled with ids is not more readable
 * than one labelled with the raw array. Grouping those wants a join, which
 * aggregate (single-table by design) does not do.
 */
const isMultiChoiceField = (f: FieldDef | undefined): boolean =>
  f?.type === "json" && getChoices(f).length > 0;

/**
 * `GROUP BY` over the ELEMENTS of a JSON-array column.
 *
 * The rows are filtered in an inner select first, so the explode joins against
 * exactly two projected columns. Doing it the other way — joining the physical
 * table directly — puts the unpacker's own output columns (`value`, `key`,
 * `type`, `path` on SQLite) in the same namespace as the collection's, and a
 * collection with a column named `value` would turn every unqualified
 * reference in the WHERE clause into an ambiguity error. The WHERE fragments
 * are built deep inside `compileCondition` with bare identifiers, so keeping
 * them alone with the base table is the only way to keep them unambiguous.
 *
 * Rows whose column is NULL, absent or not an array simply produce no
 * elements, so they are counted in no bucket rather than in a null one.
 */
const multiChoiceGroupSql = (args: {
  dialect: "pg" | "sqlite";
  physical: string;
  groupBy: string;
  /** Numeric column the agg runs over, or null for `count`. */
  aggField: string | null;
  agg: ItemsAggFunc;
  whereClause: SQL;
  limit: number;
}): SQL => {
  const { dialect, physical, groupBy, aggField, agg, whereClause, limit } = args;
  const src = sql.identifier("src");
  const gCol = sql`${src}.${sql.identifier("__g")}`;
  const projection = aggField
    ? sql`${sql.identifier(groupBy)} AS ${sql.identifier("__g")}, ${sql.identifier(aggField)} AS ${sql.identifier("__v")}`
    : sql`${sql.identifier(groupBy)} AS ${sql.identifier("__g")}`;
  const inner = sql`SELECT ${projection} FROM ${sql.identifier(physical)}${whereClause}`;
  const valueExpr =
    agg === "count"
      ? sql`COUNT(*)`
      : sql`${sql.raw(agg.toUpperCase())}(${src}.${sql.identifier("__v")})`;
  // Ordered by ordinal: `value` is both the output alias and, on SQLite, a
  // column of the unpacker — naming it would be ambiguous.
  if (dialect === "pg") {
    const elem = sql`${sql.identifier("elem")}.${sql.identifier("choice")}`;
    const asArray = sql`CASE WHEN jsonb_typeof(${gCol}::jsonb) = 'array' THEN ${gCol}::jsonb ELSE '[]'::jsonb END`;
    return sql`SELECT ${elem} AS label, ${valueExpr} AS value FROM (${inner}) AS ${src} CROSS JOIN LATERAL jsonb_array_elements_text(${asArray}) AS ${sql.identifier("elem")}(${sql.identifier("choice")}) GROUP BY ${elem} ORDER BY 2 DESC LIMIT ${sql.raw(String(limit))}`;
  }
  const elem = sql`${sql.identifier("elem")}.${sql.identifier("value")}`;
  const asArray = sql`CASE WHEN json_valid(${gCol}) AND json_type(${gCol}) = 'array' THEN ${gCol} ELSE '[]' END`;
  return sql`SELECT ${elem} AS label, ${valueExpr} AS value FROM (${inner}) AS ${src}, json_each(${asArray}) AS ${sql.identifier("elem")} GROUP BY ${elem} ORDER BY 2 DESC LIMIT ${sql.raw(String(limit))}`;
};

/**
 * Numeric column types accepted as the agg target for sum/avg/min/max.
 *
 * `money` is aggregatable — that is most of the point of the type — but only
 * under the rule enforced below: a column whose currency varies per row may be
 * summed exactly when the query groups by that currency, because a total of
 * mixed denominations is not a smaller number, it is not a number.
 */
export const NUMERIC_FIELD_TYPES = new Set<string>(["integer", "number", "money"]);

export const ItemsAggregateConfig = z.object({
  collection: z.string().min(1),
  agg: z.enum(ITEMS_AGG_FUNCS),
  field: z.string().min(1).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  groupBy: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type ItemsAggregateConfigInput = z.input<typeof ItemsAggregateConfig>;

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

export interface AggregateOpts {
  /** Permission whereSql AND-ed into the aggregate (null = unrestricted). */
  permWhere?: SQL | null;
  /** Readable field allow-list (null = all). When set, the agg `field` and
   *  `groupBy` must be inside it (or a system column) — else FORBIDDEN. */
  allowedFields?: Set<string> | null;
  /** Exclude soft-deleted rows (`deleted_at IS NULL`). Set by permission-scoped
   *  read callers (REST endpoint / MCP) so a non-privileged user can't infer the
   *  count / min / max of rows they can't otherwise see. Left unset by the
   *  admin dashboard-panel path, which intentionally aggregates over the managed
   *  lifecycle columns (e.g. count grouped by `deleted_at`). No-op when the
   *  collection has no soft-delete column. */
  excludeSoftDeleted?: boolean;
  /** Exclude unpublished drafts (`_status = 'published'`). Set by read callers
   *  who can't see drafts (no publish/update grant), mirroring the list/get/
   *  search draft filter. No-op for non-versioned collections. */
  excludeDrafts?: boolean;
  /** Return one row per slice of a time window instead of a single value.
   *  Takes precedence over `groupBy` — a query has one grouping dimension, and
   *  a ranking-over-time is two questions wearing one hat. */
  bucket?: AggregateBucket;
}

/**
 * Run an items aggregate. Returns either `[{ value }]` (no groupBy) or
 * `[{ label, value }, …]` (grouped, ordered by value desc, capped by `limit`).
 */
export const runItemsAggregate = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  auth: AuthSubject,
  tenantId: string,
  rawConfig: unknown,
  opts: AggregateOpts = {},
): Promise<Record<string, unknown>[]> => {
  const parsed = ItemsAggregateConfig.safeParse(rawConfig ?? {});
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION",
      `Invalid aggregate config: ${parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`,
    );
  }
  const cfg = parsed.data;

  const colTable = collectionsTable(ctx.dialect);
  const cRows = await (ctx.db as any)
    .select()
    .from(colTable)
    .where(and(eq(colTable.tenantId, tenantId), eq(colTable.slug, cfg.collection)))
    .limit(1);
  const cRow = cRows[0] as Record<string, unknown> | undefined;
  if (!cRow) throw new AppError("NOT_FOUND", `Collection "${cfg.collection}" not found`);
  const physical = (cRow.physicalTable ?? cRow.physical_table) as string;
  const fields = (cRow.fields ?? []) as FieldDef[];
  const tenantScoped = (cRow.tenantScoped ?? cRow.tenant_scoped ?? true) ? true : false;
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const systemColumns = new Set(["id", "owner_id", "created_at", "updated_at"]);
  // Versioned and soft-delete collections carry managed lifecycle columns that
  // are absent from `fields` but are real, aggregatable columns — counting rows
  // grouped by `_status` (draft vs published) is a textbook dashboard query. Add
  // them only when the collection actually has them, so a non-versioned
  // collection still gets the friendly "not in collection" error.
  if (cRow.versioned ?? cRow.is_versioned) {
    systemColumns.add("_status").add("_published_at").add("_publish_at");
  }
  if (cRow.softDelete ?? cRow.soft_delete) systemColumns.add("deleted_at");
  const isKnownColumn = (name: string) => fieldByName.has(name) || systemColumns.has(name);
  const allowed = opts.allowedFields;
  // Surface the real column names so a caller (or the AI planner's dry-run
  // retry) can correct a near-miss like `customer_id` → `customer` instead of
  // guessing again. Relations are flagged so the model doesn't append `_id`.
  const columnHint = (): string => {
    const names = [
      ...fields
        .filter((f) => !allowed || allowed.has(f.name))
        .map((f) =>
          f.type === "relation" || f.type === "relation_many"
            ? `${f.name} (relation)`
            : f.name,
        ),
      "id",
      "created_at",
      "updated_at",
    ];
    return names.join(", ");
  };
  const gateField = (name: string) => {
    if (allowed && !systemColumns.has(name) && !allowed.has(name)) {
      throw new AppError("FORBIDDEN", `No permission to read field: ${name}`);
    }
  };
  const numericHint = (): string =>
    fields
      .filter((f) => NUMERIC_FIELD_TYPES.has(f.type) && (!allowed || allowed.has(f.name)))
      .map((f) => f.name)
      .join(", ") || "(none)";

  if (cfg.agg !== "count") {
    if (!cfg.field) throw new AppError("VALIDATION", `field is required for agg "${cfg.agg}"`);
    const f = fieldByName.get(cfg.field);
    if (!f) {
      throw new AppError(
        "VALIDATION",
        `Field "${cfg.field}" is not in collection "${cfg.collection}". Numeric columns: ${numericHint()}`,
      );
    }
    if (!NUMERIC_FIELD_TYPES.has(f.type)) {
      throw new AppError(
        "VALIDATION",
        `Field "${cfg.field}" must be numeric for agg "${cfg.agg}" (got "${f.type}"). Numeric columns: ${numericHint()}`,
      );
    }
    gateField(cfg.field);
    if (f.type === "money") {
      const per = f.money?.currencyField;
      if (per && cfg.groupBy !== per) {
        // Adding ₺ to $ produces a number with no unit, and a dashboard tile
        // would print it as if it had one. Grouping by the currency column
        // turns the same query into one total per denomination, which is the
        // answer the caller can actually use.
        throw new AppError(
          "VALIDATION",
          `"${cfg.field}" holds a different currency per row, so \`${cfg.agg}\` over it needs groupBy: "${per}" — one total per currency`,
        );
      }
    }
  } else if (cfg.field && cfg.field !== "*" && !isKnownColumn(cfg.field)) {
    throw new AppError(
      "VALIDATION",
      `Field "${cfg.field}" is not in collection "${cfg.collection}". Valid columns: ${columnHint()}`,
    );
  }

  if (cfg.groupBy) {
    if (!isKnownColumn(cfg.groupBy)) {
      throw new AppError(
        "VALIDATION",
        `groupBy field "${cfg.groupBy}" is not in collection "${cfg.collection}". Valid columns: ${columnHint()}`,
      );
    }
    gateField(cfg.groupBy);
  }

  const valueExpr: SQL =
    cfg.agg === "count"
      ? sql`COUNT(*)`
      : sql`${sql.raw(cfg.agg.toUpperCase())}(${sql.identifier(cfg.field!)})`;

  const wheres: SQL[] = [];
  if (tenantScoped) wheres.push(sql`${sql.identifier("tenant_id")} = ${tenantId}`);
  if (cfg.filter && Object.keys(cfg.filter).length > 0) {
    // Accept the same input shapes as the list endpoint (aliases, implicit-eq).
    // Schema-blind: aggregate has no relation joins, so nested-object relation
    // filters aren't flattened here — a dotted relation filter would error at
    // SQL, which is the correct signal that aggregate is single-table.
    // Money operands in the filter are major units and may name a currency —
    // rewritten to the column's own units exactly as the list endpoint does, so
    // `price_gte: 100` means the same thing on both.
    let cond = normalizeCondition(cfg.filter);
    try {
      cond = normalizeMoneyOperands(cond, fields);
      // …and phone operands to the canonical form the column holds, so a
      // "how many orders from this number" aggregate agrees with the list
      // endpoint instead of counting zero.
      cond = normalizePhoneOperands(cond, fields);
      // …and email operands, so "how many contacts at this domain" counts the
      // same rows the list endpoint would show.
      cond = normalizeEmailOperands(cond, fields);
      // …and url operands, so "how many rows link to this site" counts the same
      // rows the list endpoint would show.
      cond = normalizeUrlOperands(cond, fields);
      // …and `_overlaps` into the comparisons it stands for, so "how many
      // bookings clash with this window" agrees with the list endpoint.
      cond = expandRangeOperators(cond, rangeFieldsOf(fields));
      cond = normalizeTemporalOperands(cond, fields, ctx.dialect);
    } catch (e) {
      throw new AppError("VALIDATION", (e as Error).message);
    }
    // Reject a filter on a column this collection does not have.
    //
    // `field` and `groupBy` were already checked; filter keys were not, and on
    // SQLite that silence is worse than an error. An unresolved double-quoted
    // identifier degrades to a STRING LITERAL of its own name, so
    // `{"placed_at": {"_gte": <ts>}}` against a table with no `placed_at`
    // compares the text 'placed_at' to a number — text sorts after every
    // number, so the clause is TRUE for every row and the "filtered" count
    // comes back as the UNFILTERED total. Swap the operator to `_eq` and it is
    // FALSE for every row and the same query answers zero. Neither errors.
    //
    // That is the exact shape of a confidently wrong number: a stale filter
    // column on a dashboard tile, or a KPI written against a schema that has
    // since been renamed, reports a total nobody has reason to doubt.
    assertKnownFilterColumns(cond, isKnownColumn, cfg.collection, columnHint, gateField);
    wheres.push(
      compileCondition(cond, auth, undefined, undefined, {
        dialect: ctx.dialect,
      }),
    );
  }
  if (opts.permWhere) wheres.push(opts.permWhere);
  // Lifecycle filters for permission-scoped read callers — match the row
  // visibility of list/get/search so aggregates can't be used as an oracle to
  // infer values of soft-deleted or draft rows the caller can't read directly.
  if (opts.excludeSoftDeleted && (cRow.softDelete ?? cRow.soft_delete)) {
    wheres.push(sql`${sql.identifier("deleted_at")} IS NULL`);
  }
  if (opts.excludeDrafts && (cRow.versioned ?? cRow.is_versioned)) {
    wheres.push(sql`${sql.identifier("_status")} = 'published'`);
  }
  const whereClause: SQL = wheres.length === 0 ? sql`` : sql` WHERE ${sql.join(wheres, sql` AND `)}`;

  let q: SQL;
  if (opts.bucket) {
    // Time buckets — one row per slice of the window, ordered oldest-first.
    //
    // A grouping EXPRESSION rather than a column, which is why it cannot go
    // through `cfg.groupBy`: the bucket index is `(when - from) / width`, so
    // the shape of the series is decided here and not by a value in the data.
    // Ordered ASC because a series is a shape over time; the grouped path's
    // `ORDER BY value DESC` is for rankings and would scramble it.
    const b = opts.bucket;
    gateField(b.field);
    if (!isKnownColumn(b.field)) {
      throw new AppError(
        "VALIDATION",
        `Series column "${b.field}" is not in collection "${cfg.collection}". Valid columns: ${columnHint()}`,
      );
    }
    const bucketExpr = bucketIndexSql(b, ctx.dialect);
    q = sql`SELECT ${bucketExpr} AS label, ${valueExpr} AS value FROM ${sql.identifier(physical)}${whereClause} GROUP BY ${bucketExpr} ORDER BY label ASC LIMIT ${sql.raw(String(b.count))}`;
  } else if (cfg.groupBy && isMultiChoiceField(fieldByName.get(cfg.groupBy))) {
    // A multi-select answer is a JSON ARRAY of chosen values, so grouping by
    // the column verbatim buckets by the whole array: `["a","b"]` and
    // `["b","a"]` land in two different bars and neither says how many people
    // chose "b". Explode the array first, one row per choice, and the counts
    // become the answer the question was asking.
    //
    // A row appears once per value it holds, so the counts sum to more than
    // the number of rows — which is what "how many people picked each" means
    // for a question that takes several answers.
    const limit = cfg.limit ?? 50;
    q = multiChoiceGroupSql({
      dialect: ctx.dialect,
      physical,
      groupBy: cfg.groupBy,
      aggField: cfg.agg === "count" ? null : cfg.field!,
      agg: cfg.agg,
      whereClause,
      limit,
    });
  } else if (cfg.groupBy) {
    const limit = cfg.limit ?? 50;
    q = sql`SELECT ${sql.identifier(cfg.groupBy)} AS label, ${valueExpr} AS value FROM ${sql.identifier(physical)}${whereClause} GROUP BY ${sql.identifier(cfg.groupBy)} ORDER BY value DESC LIMIT ${sql.raw(String(limit))}`;
  } else {
    q = sql`SELECT ${valueExpr} AS value FROM ${sql.identifier(physical)}${whereClause}`;
  }

  let rows: Record<string, unknown>[];
  try {
    rows = await queryAll<Record<string, unknown>>(
      { db: ctx.db, dialect: ctx.dialect } as Parameters<typeof queryAll>[0],
      q,
    );
  } catch (e) {
    throw new AppError("VALIDATION", `Aggregate query failed: ${(e as Error).message}`);
  }
  return scaleMoneyResults(rows, cfg, fieldByName.get(cfg.field ?? ""));
};

/**
 * Rescale a money aggregate from the column's minor units back to the major
 * units every other surface reads in, and say which currency the number is in.
 *
 * `SUM` over a column of cents is a number of cents; handing that back as
 * `199900` next to a REST read of `1999.00` would make the two disagree about
 * the same rows. `count` is left alone — it counts rows, not money.
 *
 * When the query grouped by the currency column, each row's own `label` IS the
 * currency, so each is scaled by its own exponent: a JPY bucket is not divided
 * by a hundred and a KWD one is divided by a thousand.
 */
const scaleMoneyResults = (
  rows: Record<string, unknown>[],
  cfg: z.output<typeof ItemsAggregateConfig>,
  field: FieldDef | undefined,
): Record<string, unknown>[] => {
  if (cfg.agg === "count" || field?.type !== "money") return rows;
  const fixed = field.money?.currency ? normalizeCurrency(field.money.currency) : null;
  return rows.map((row) => {
    const raw = row.value;
    if (raw === null || raw === undefined) return row;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return row;
    const currency =
      fixed ?? (typeof row.label === "string" ? safeCurrency(row.label) : null);
    if (!currency) return row;
    const exponent = currencyExponent(currency, field.money);
    // `avg` lands between minor units, so it is divided rather than digit-
    // shifted — the result is a report, not a stored amount.
    const value = isDecimalStorage(field.money)
      ? n
      : cfg.agg === "avg"
        ? n / 10 ** exponent
        : fromMinorUnits(n, exponent);
    return { ...row, value, currency };
  });
};

/** A group label that is supposed to be a currency code, or null if the column
 *  holds something else — an adopted table can carry anything. */
const safeCurrency = (label: string): string | null => {
  try {
    return normalizeCurrency(label);
  } catch {
    return null;
  }
};
