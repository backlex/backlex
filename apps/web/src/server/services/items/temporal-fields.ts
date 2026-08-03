import type { FieldDef } from "@backlex/db";
import { serialize } from "./serialize";

/**
 * Put a filter's date operands into the form the column actually holds.
 *
 * ## The bug this fixes, which predates date ranges
 *
 * A `timestamp` column is `INTEGER` epoch-ms on SQLite and `timestamptz` on
 * Postgres. The DSL compiler binds a comparison operand exactly as it arrived,
 * so an ISO string — *the form every read hands back* — reached SQLite as TEXT
 * and was compared against an integer column. SQLite's type ordering puts every
 * number before every string, so the comparison does not merely fail: it
 * INVERTS.
 *
 * Against a row dated 2026-09-15, on SQLite/D1, before this existed:
 *
 *     ?filter={"at":{"_gte":"2026-09-01T00:00:00Z"}}   → []      (wrong)
 *     ?filter={"at":{"_lte":"2026-09-01T00:00:00Z"}}   → [row]   (wrong)
 *
 * Both answers are confidently wrong, in opposite directions, with nothing in
 * the response to suggest it. Passing epoch numbers worked, so the API was
 * usable only by callers who happened not to use the format it emits. The same
 * query against Postgres was correct throughout, which is why it survived: it is
 * invisible on the dialect most development happens against.
 *
 * ## The fix, and why it is this one
 *
 * Operands are put through `serialize` — **the same function the write path uses
 * to produce the column's contents**. Not a parallel date coercion that happens
 * to agree today: the only way a filter and a column cannot drift is for one
 * function to decide both. It also inherits, for free, every input shape the
 * write path already accepts (`Date`, epoch number, numeric string, ISO string).
 *
 * Applied at the same chokepoints money's scaling and phone's canonicalization
 * are, and AFTER the range rewrite — so the comparisons that rewrite emits are
 * coerced too, rather than needing their own copy of this.
 *
 * `$now` and the relative-now objects are deliberately untouched: the compiler
 * resolves those itself, with the dialect in hand, and they are not strings by
 * the time they reach SQL.
 */

/** Operators on a timestamp column whose operand is a moment. */
const TEMPORAL_VALUE_OPS = new Set(["_eq", "_neq", "_gt", "_gte", "_lt", "_lte"]);
/** …and the ones whose operand is a list of moments. */
const TEMPORAL_LIST_OPS = new Set(["_in", "_nin", "_between"]);

/** True when the value is one the DSL compiler resolves itself. */
const isDynamic = (v: unknown): boolean =>
  v === "$now" ||
  (typeof v === "string" && v.startsWith("$")) ||
  (v !== null && typeof v === "object" && "$now" in (v as Record<string, unknown>));

const coerce = (v: unknown, dialect: "pg" | "sqlite"): unknown => {
  if (v === null || v === undefined || v === "" || isDynamic(v)) return v;
  // On SQLite a bare number is already epoch-ms and needs nothing; passing it
  // through `serialize` is a no-op anyway, but skipping keeps the common
  // already-correct caller on an identical path.
  if (dialect === "sqlite" && typeof v === "number") return v;
  return serialize(v, "timestamp", dialect);
};

/**
 * Rewrite every timestamp operand in a filter tree into the column's storage
 * form. Returns a NEW tree; the caller's condition is left alone. A collection
 * with no timestamp field is returned untouched.
 */
export const normalizeTemporalOperands = <T>(
  cond: T,
  fields: FieldDef[],
  dialect: "pg" | "sqlite",
): T => {
  const temporal = new Set(fields.filter((f) => f.type === "timestamp").map((f) => f.name));
  if (temporal.size === 0) return cond;
  const walk = (node: unknown): unknown => {
    if (node === null || node === undefined || typeof node !== "object") return node;
    const c = node as Record<string, unknown>;
    if (Array.isArray(c.$and)) return { $and: (c.$and as unknown[]).map(walk) };
    if (Array.isArray(c.$or)) return { $or: (c.$or as unknown[]).map(walk) };
    if (c.$not !== undefined) return { $not: walk(c.$not) };
    const out: Record<string, unknown> = {};
    for (const [key, cmp] of Object.entries(c)) {
      if (!temporal.has(key)) {
        out[key] = cmp;
        continue;
      }
      if (cmp === null || typeof cmp !== "object" || Array.isArray(cmp)) {
        // Shorthand equality — `{"at": "2026-09-01T00:00:00Z"}`.
        out[key] = coerce(cmp, dialect);
        continue;
      }
      const next: Record<string, unknown> = {};
      for (const [op, operand] of Object.entries(cmp as Record<string, unknown>)) {
        if (TEMPORAL_VALUE_OPS.has(op)) {
          next[op] = coerce(operand, dialect);
        } else if (TEMPORAL_LIST_OPS.has(op) && Array.isArray(operand)) {
          next[op] = operand.map((v) => coerce(v, dialect));
        } else {
          // `_null` / `_empty` take no moment, and anything unrecognised is left
          // for the compiler to reject rather than silently reinterpreted.
          next[op] = operand;
        }
      }
      out[key] = next;
    }
    return out;
  };
  return walk(cond) as T;
};
