export interface FilterEntry {
  field: string;
  op: string;
  value: unknown;
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

/** Merge a list of `{ field, op, value }` entries back into the workeros DSL shape. */
export const buildFilterDSL = (
  filters: FilterEntry[],
): Record<string, Record<string, unknown>> => {
  const out: Record<string, Record<string, unknown>> = {};
  for (const f of filters) {
    out[f.field] = { ...(out[f.field] ?? {}), [f.op]: f.value };
  }
  return out;
};

/**
 * Combine multiple DSL fragments into one — used to mix the chip-based filter
 * list with the quick search and the status quick-filter without losing any
 * field+op pairs (last wins on conflict, which is rare since each fragment
 * uses different fields).
 */
export const mergeFilters = (
  ...parts: (Record<string, Record<string, unknown>> | null | undefined)[]
): Record<string, Record<string, unknown>> | null => {
  const out: Record<string, Record<string, unknown>> = {};
  let any = false;
  for (const p of parts) {
    if (!p) continue;
    for (const [field, ops] of Object.entries(p)) {
      out[field] = { ...(out[field] ?? {}), ...ops };
      any = true;
    }
  }
  return any ? out : null;
};

/** Friendly URL (used in the live preview) — non-encoded JSON for readability. */
export const previewFilterUrl = (
  slug: string,
  dsl: Record<string, Record<string, unknown>> | null,
): string => {
  if (!dsl) return `GET /api/items/${slug}`;
  return `GET /api/items/${slug}?filter=${encodeURIComponent(JSON.stringify(dsl))}`;
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
