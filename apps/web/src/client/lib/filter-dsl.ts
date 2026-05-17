import type { Condition } from "@workeros/core";

export type FilterMode = "and" | "or";

export interface FilterEntry {
  /** Stable id so the UI can key/remove rows even when two chips share the same field+op. */
  id: string;
  /**
   * Either a flat column name (`title`) or a nested-relation key
   * (`customer_id.name`). When nested, {@link nestedSub} mirrors the part
   * after the dot so the builder can hydrate its dropdowns without
   * re-splitting at render time.
   */
  field: string;
  op: string;
  value: unknown;
  /**
   * Sub-field of the target collection for nested-relation filters. Only set
   * when `field` is a `head.sub` pair; carried as a separate slot so a chip
   * round-tripped from URL preserves the structured form. The compiled DSL
   * still reads from {@link field} — this is UI metadata only.
   */
  nestedSub?: string;
}

/** Operators surfaced by the FilterBuilder, indexed by the underlying field type. */
export const FIELD_OPS: Record<string, string[]> = {
  text: ["_eq", "_neq", "_contains", "_starts_with", "_ends_with", "_in", "_null"],
  longtext: ["_contains", "_eq", "_null"],
  integer: ["_eq", "_neq", "_gt", "_gte", "_lt", "_lte", "_in"],
  number: ["_eq", "_gt", "_gte", "_lt", "_lte"],
  uuid: ["_eq", "_neq", "_in", "_null"],
  timestamp: ["_gt", "_gte", "_lt", "_lte", "_null"],
  boolean: ["_eq"],
  json: ["_contains", "_null"],
  relation: ["_eq", "_neq", "_in", "_null"],
};

/**
 * Split a field key into head + sub when it carries a nested-relation dot
 * (`customer_id.name` → `{head: "customer_id", sub: "name"}`). Returns null
 * for flat keys. Multi-level keys (`a.b.c`) are rejected here too — the
 * server's filter parser doesn't accept them yet.
 */
export const splitNestedField = (
  field: string,
): { head: string; sub: string } | null => {
  if (!field.includes(".")) return null;
  const parts = field.split(".");
  if (parts.length !== 2) return null;
  const [head, sub] = parts as [string, string];
  if (!head || !sub) return null;
  return { head, sub };
};

/** Generate a stable id for a new chip. Falls back to a counter on older runtimes. */
let _filterIdCounter = 0;
export const newFilterId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `f${Date.now()}-${++_filterIdCounter}`;

const entryToCondition = (f: FilterEntry): Condition =>
  ({ [f.field]: { [f.op]: f.value } }) as Condition;

/**
 * Build a server-shaped {@link Condition} from a list of chip entries.
 *
 * Each chip becomes its own `{ field: { _op: value } }` clause. Multiple chips
 * are joined by `$and` or `$or` depending on `mode` (default `and`) so nothing
 * is silently overwritten — the previous shape used object keys for each field,
 * which collapsed `tags _contains "a"` + `tags _contains "b"` into a single
 * clause.
 */
export const buildFilterDSL = (
  filters: FilterEntry[],
  mode: FilterMode = "and",
): Condition | null => {
  if (filters.length === 0) return null;
  if (filters.length === 1) return entryToCondition(filters[0]!);
  const clauses = filters.map(entryToCondition);
  return mode === "or" ? { $or: clauses } : { $and: clauses };
};

/**
 * Combine multiple {@link Condition} fragments into one via `$and`. Nested
 * `$and` clauses are flattened so the URL stays readable. Returns null if every
 * fragment is empty.
 */
export const mergeFilters = (
  ...parts: (Condition | null | undefined)[]
): Condition | null => {
  const flat: Condition[] = [];
  for (const p of parts) {
    if (!p) continue;
    const c = p as Record<string, unknown>;
    if (Array.isArray(c.$and)) {
      for (const sub of c.$and as Condition[]) flat.push(sub);
    } else {
      flat.push(p);
    }
  }
  if (flat.length === 0) return null;
  if (flat.length === 1) return flat[0]!;
  return { $and: flat };
};

/** Friendly URL (used in the live preview) — non-encoded JSON for readability. */
export const previewFilterUrl = (
  slug: string,
  dsl: Condition | null,
  q?: string,
): string => {
  const parts: string[] = [];
  if (dsl) parts.push(`filter=${encodeURIComponent(JSON.stringify(dsl))}`);
  if (q && q.trim()) parts.push(`q=${encodeURIComponent(q.trim())}`);
  if (parts.length === 0) return `GET /api/items/${slug}`;
  return `GET /api/items/${slug}?${parts.join("&")}`;
};

/** Format a chip's value for display. */
export const formatChipValue = (op: string, value: unknown): string => {
  if (op === "_null") return value ? "is null" : "is not null";
  if (Array.isArray(value)) return `[${value.map(String).join(", ")}]`;
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  return String(value);
};

/** Parse user input into the right shape for the chosen op + field type. */
export const parseFilterValue = (
  op: string,
  fieldType: string,
  raw: string,
): unknown => {
  if (op === "_null") return true;
  if (op === "_in" || op === "_nin") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (fieldType === "integer" || fieldType === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (fieldType === "boolean") {
    return raw === "true";
  }
  return raw;
};
