/**
 * Saved segments — a reusable filter applied to every analytics report.
 *
 * ── The threat this file exists to close ──────────────────────────────────
 * A segment is operator-authored JSON that ends up inside a SQL WHERE clause.
 * That is the single highest-severity surface in the analytics feature, and
 * the mitigation is structural rather than sanitizing:
 *
 *  - **Field names are never interpolated.** A predicate names a field from a
 *    CLOSED allowlist, which is looked up to a Drizzle column object. An
 *    unknown name is a validation error, not a string that reaches SQL.
 *  - **Values are always bound**, never spliced. Every leaf below produces a
 *    parameterized fragment. `sql.raw` appears exactly twice, in
 *    `compileSegmentRaw`, and in both places its argument is a literal written
 *    in this file — a `SEGMENT_COLUMNS` lookup or the word `revenue`. A caller
 *    string must never reach it; that is the invariant to check when editing.
 *  - **`props` keys are bound as a JSON path**, following the rule documented
 *    at `packages/db/src/permission.ts:176-189`, including the `json_valid`
 *    guard — `json_extract` RAISES on malformed input, so one junk row would
 *    otherwise take down every segmented report.
 *  - **Complexity is capped.** A definition has a maximum node count and a
 *    maximum depth, so a saved segment cannot become a way to make the
 *    database do unbounded work on every dashboard load.
 *
 * ── What this deliberately does NOT do ────────────────────────────────────
 * Sequence segments ("did A, then B, within N minutes") are not here. The
 * funnel report already answers that question directly and with a better UI,
 * and a sequence *segment* is a different composition — it filters visitors by
 * a behaviour over time, which needs the full funnel CTE threaded through
 * every other report. Worth doing; not worth conflating with this.
 */
import { and, eq, gt, gte, inArray, lt, lte, ne, not, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";

/**
 * Fields a segment may filter on.
 *
 * Closed by construction. Adding one is a deliberate edit here; it is not
 * something a caller can do by sending a different string.
 */
export const SEGMENT_FIELDS = [
  "name",
  "path",
  "referrer",
  "source",
  "country",
  "deviceType",
  "browser",
  "os",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "currency",
  "idScope",
  "release",
] as const;
export type SegmentField = (typeof SEGMENT_FIELDS)[number];

const TEXT_OPS = ["eq", "neq", "contains", "startsWith", "endsWith", "in", "isSet", "isNotSet"] as const;
const NUMBER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;

export type SegmentNode =
  | { field: SegmentField; op: (typeof TEXT_OPS)[number]; value?: string | string[] }
  | { prop: string; op: (typeof TEXT_OPS)[number]; value?: string | string[] }
  | { revenue: (typeof NUMBER_OPS)[number]; value: number }
  | { all: SegmentNode[] }
  | { any: SegmentNode[] }
  | { not: SegmentNode };

/** Total nodes in one definition. Generous for a human, bounded for a planner. */
const MAX_NODES = 40;
/** Nesting depth. Three levels of and/or is already more than a UI should offer. */
const MAX_DEPTH = 4;
/** Values in an `in` list. */
const MAX_IN_VALUES = 50;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Validate an untrusted definition into a `SegmentNode`.
 *
 * Throws `AppError("VALIDATION")` rather than returning a partial tree: a
 * segment that half-parsed would silently filter on less than the operator
 * asked for, which is worse than refusing it.
 */
export const parseSegment = (input: unknown): SegmentNode => {
  let nodes = 0;

  const walk = (raw: unknown, depth: number): SegmentNode => {
    if (++nodes > MAX_NODES) {
      throw new AppError("VALIDATION", `A segment may hold at most ${MAX_NODES} conditions.`);
    }
    if (depth > MAX_DEPTH) {
      throw new AppError("VALIDATION", `A segment may nest at most ${MAX_DEPTH} levels deep.`);
    }
    if (!isRecord(raw)) throw new AppError("VALIDATION", "Each condition must be an object.");

    if (Array.isArray(raw.all)) return { all: raw.all.map((n) => walk(n, depth + 1)) };
    if (Array.isArray(raw.any)) return { any: raw.any.map((n) => walk(n, depth + 1)) };
    if (raw.not !== undefined) return { not: walk(raw.not, depth + 1) };

    const op = String(raw.op ?? "");

    if (typeof raw.revenue === "string") {
      if (!(NUMBER_OPS as readonly string[]).includes(raw.revenue)) {
        throw new AppError("VALIDATION", `Unknown revenue comparison "${raw.revenue}".`);
      }
      const value = Number(raw.value);
      if (!Number.isFinite(value)) {
        throw new AppError("VALIDATION", "A revenue condition needs a numeric value.");
      }
      return { revenue: raw.revenue as (typeof NUMBER_OPS)[number], value };
    }

    if (!(TEXT_OPS as readonly string[]).includes(op)) {
      throw new AppError("VALIDATION", `Unknown condition operator "${op}".`);
    }
    const typedOp = op as (typeof TEXT_OPS)[number];

    const value = normalizeValue(typedOp, raw.value);

    if (typeof raw.prop === "string") {
      const key = raw.prop.trim();
      if (!key || key.length > 100) {
        throw new AppError("VALIDATION", "A props key must be 1-100 characters.");
      }
      return { prop: key, op: typedOp, value };
    }

    const field = String(raw.field ?? "");
    if (!(SEGMENT_FIELDS as readonly string[]).includes(field)) {
      // The message names what IS allowed rather than echoing the input back —
      // an error page is not a place to reflect an arbitrary caller string.
      throw new AppError(
        "VALIDATION",
        `Unknown segment field. Allowed: ${SEGMENT_FIELDS.join(", ")}.`,
      );
    }
    return { field: field as SegmentField, op: typedOp, value };
  };

  return walk(input, 1);
};

const normalizeValue = (
  op: (typeof TEXT_OPS)[number],
  raw: unknown,
): string | string[] | undefined => {
  if (op === "isSet" || op === "isNotSet") return undefined;
  if (op === "in") {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new AppError("VALIDATION", "An `in` condition needs a non-empty list.");
    }
    if (raw.length > MAX_IN_VALUES) {
      throw new AppError("VALIDATION", `An \`in\` list may hold at most ${MAX_IN_VALUES} values.`);
    }
    return raw.map((v) => String(v).slice(0, 500));
  }
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new AppError("VALIDATION", "This condition needs a string value.");
  }
  return String(raw).slice(0, 500);
};

/**
 * String matching WITHOUT `LIKE`, on purpose.
 *
 * D1 rejects a bound LIKE pattern outright — `D1_ERROR: LIKE or GLOB pattern
 * too complex: SQLITE_ERROR` — even for a trivial `col LIKE ?`. It works in
 * bun:sqlite and in the sqlite3 CLI, so a test suite does NOT catch it; it
 * fails only on D1, which is production. Interpolating the pattern instead
 * would trade that for an injection surface, which is not a trade.
 *
 * So these three use position and substring functions with bound values. The
 * spelling differs by dialect, which is a legitimate branch of the same kind
 * as `elapsedMsSql` — how a string is indexed into, not what is being asked.
 */
const containsExpr = (dialect: "pg" | "sqlite", expr: SQL, value: string): SQL =>
  dialect === "pg"
    ? sql`strpos(coalesce(${expr}, ''), ${value}) > 0`
    : sql`instr(coalesce(${expr}, ''), ${value}) > 0`;

/** `substr(x, 1, n)` means the same thing in both dialects. */
const startsWithExpr = (_dialect: "pg" | "sqlite", expr: SQL, value: string): SQL =>
  sql`substr(coalesce(${expr}, ''), 1, ${value.length}) = ${value}`;

/** SQLite counts from the end with a negative offset; Postgres has `right()`. */
const endsWithExpr = (dialect: "pg" | "sqlite", expr: SQL, value: string): SQL =>
  dialect === "pg"
    ? sql`right(coalesce(${expr}, ''), ${value.length}) = ${value}`
    : sql`substr(coalesce(${expr}, ''), -${value.length}) = ${value}`;

/**
 * Read a `props` key portably.
 *
 * Follows `geoMember` in `packages/db/src/permission.ts`: `->>` yields text on
 * Postgres, `json_extract` yields the JSON type on SQLite — and `json_extract`
 * RAISES on malformed input, hence the `json_valid` guard. The key is BOUND as
 * a path, never interpolated.
 */
const propExpr = (dialect: "pg" | "sqlite", key: string): SQL =>
  dialect === "pg"
    ? sql`(props ->> ${key})`
    : sql`CAST(json_extract(CASE WHEN json_valid(props) THEN props END, ${`$.${key}`}) AS TEXT)`;

export interface SegmentCompileCtx {
  dialect: "pg" | "sqlite";
  /** The events table, so column objects are looked up rather than named. */
  table: Record<string, unknown>;
}

/**
 * Compile a validated tree into a parameterized `SQL` fragment.
 *
 * Returns `undefined` for a node that filters nothing, so a caller can `and()`
 * it in without a special case.
 */
export const compileSegment = (
  ctx: SegmentCompileCtx,
  node: SegmentNode,
): SQL | undefined => {
  if ("all" in node) {
    const parts = node.all.map((n) => compileSegment(ctx, n)).filter(Boolean) as SQL[];
    return parts.length ? and(...parts) : undefined;
  }
  if ("any" in node) {
    const parts = node.any.map((n) => compileSegment(ctx, n)).filter(Boolean) as SQL[];
    return parts.length ? or(...parts) : undefined;
  }
  if ("not" in node) {
    const inner = compileSegment(ctx, node.not);
    return inner ? not(inner) : undefined;
  }

  if ("revenue" in node) {
    const col = ctx.table.revenue as never;
    switch (node.revenue) {
      case "gt":
        return gt(col, node.value);
      case "gte":
        return gte(col, node.value);
      case "lt":
        return lt(col, node.value);
      case "lte":
        return lte(col, node.value);
      case "neq":
        return ne(col, node.value);
      default:
        return eq(col, node.value);
    }
  }

  // A column object from the closed allowlist, or a bound JSON path. Neither
  // is a caller-supplied string reaching SQL as an identifier.
  const expr: SQL | never =
    "prop" in node
      ? propExpr(ctx.dialect, node.prop)
      : (ctx.table[node.field] as never);

  switch (node.op) {
    case "isSet":
      return sql`${expr} IS NOT NULL AND ${expr} <> ''`;
    case "isNotSet":
      return sql`(${expr} IS NULL OR ${expr} = '')`;
    case "in":
      return inArray(expr as never, node.value as string[]);
    case "neq":
      return ne(expr as never, node.value as string);
    case "contains":
      return containsExpr(ctx.dialect, sql`${expr}`, node.value as string);
    case "startsWith":
      return startsWithExpr(ctx.dialect, sql`${expr}`, node.value as string);
    case "endsWith":
      return endsWithExpr(ctx.dialect, sql`${expr}`, node.value as string);
    default:
      return eq(expr as never, node.value as string);
  }
};

/**
 * Raw-SQL twin, for the CTE-based reports.
 *
 * Sessions, channels and funnels build raw `WITH` chains rather than Drizzle
 * builders, so they need the predicate as a fragment against bare column names.
 * The names still come from the same closed allowlist — `SEGMENT_COLUMNS` maps
 * a field to its column, and nothing else can reach this.
 */
const SEGMENT_COLUMNS: Record<SegmentField, string> = {
  name: "name",
  path: "path",
  referrer: "referrer",
  source: "source",
  country: "country",
  deviceType: "device_type",
  browser: "browser",
  os: "os",
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  currency: "currency",
  idScope: "id_scope",
  release: "release",
};

export const compileSegmentRaw = (
  dialect: "pg" | "sqlite",
  node: SegmentNode,
): SQL | undefined => {
  const join = (parts: (SQL | undefined)[], sep: SQL) => {
    const kept = parts.filter(Boolean) as SQL[];
    if (!kept.length) return undefined;
    return sql`(${sql.join(kept, sep)})`;
  };

  if ("all" in node) return join(node.all.map((n) => compileSegmentRaw(dialect, n)), sql` AND `);
  if ("any" in node) return join(node.any.map((n) => compileSegmentRaw(dialect, n)), sql` OR `);
  if ("not" in node) {
    const inner = compileSegmentRaw(dialect, node.not);
    return inner ? sql`(NOT ${inner})` : undefined;
  }

  if ("revenue" in node) {
    const col = sql.raw("revenue");
    const v = node.value;
    switch (node.revenue) {
      case "gt":
        return sql`(${col} > ${v})`;
      case "gte":
        return sql`(${col} >= ${v})`;
      case "lt":
        return sql`(${col} < ${v})`;
      case "lte":
        return sql`(${col} <= ${v})`;
      case "neq":
        return sql`(${col} <> ${v})`;
      default:
        return sql`(${col} = ${v})`;
    }
  }

  // `sql.raw` appears here on a value that is NOT caller-controlled: it is a
  // lookup result from SEGMENT_COLUMNS, whose keys are the closed allowlist and
  // whose values are literals written above.
  //
  // The lookup is re-checked rather than trusted to the type. `SegmentNode` is
  // only ever produced by `parseSegment`, but that is a convention TypeScript
  // cannot enforce against a hand-built object literal — and this is the one
  // line in the feature where being wrong about that would matter. An unknown
  // field throws here instead of reaching `sql.raw`.
  let expr: SQL;
  if ("prop" in node) {
    expr = propExpr(dialect, node.prop);
  } else {
    const column = SEGMENT_COLUMNS[node.field];
    if (!column) {
      throw new AppError("VALIDATION", "Unknown segment field.");
    }
    expr = sql.raw(column);
  }

  switch (node.op) {
    case "isSet":
      return sql`(${expr} IS NOT NULL AND ${expr} <> '')`;
    case "isNotSet":
      return sql`(${expr} IS NULL OR ${expr} = '')`;
    case "in": {
      const list = node.value as string[];
      return sql`(${expr} IN (${sql.join(list.map((v) => sql`${v}`), sql`, `)}))`;
    }
    case "neq":
      return sql`(${expr} <> ${node.value as string})`;
    case "contains":
      return sql`(${containsExpr(dialect, expr, node.value as string)})`;
    case "startsWith":
      return sql`(${startsWithExpr(dialect, expr, node.value as string)})`;
    case "endsWith":
      return sql`(${endsWithExpr(dialect, expr, node.value as string)})`;
    default:
      return sql`(${expr} = ${node.value as string})`;
  }
};
