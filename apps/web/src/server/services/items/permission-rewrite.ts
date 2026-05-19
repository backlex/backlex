import type { CollectionRow } from "./collection-loader";
import { physicalSystemCol } from "./sql-helpers";

// Re-exported so consumers that need to check the ownership side-table
// path next to a condition rewrite can pull both from this module.
export { usesOwnershipSideTable } from "./sql-helpers";

/**
 * Rewrite a permission/filter Condition tree so logical system-field keys
 * (`created_at`, `updated_at`, `owner_id`) become the actual physical
 * column names this collection uses. Without this, `compileCondition`
 * would emit `WHERE "created_at" = ?` against a table whose timestamp
 * column is actually called `inserted_at` and the query would fail.
 */
export const rewriteSystemFieldsInCondition = (
  cond: any,
  collection: CollectionRow,
): any => {
  if (cond === null || cond === undefined) return cond;
  if (Array.isArray(cond.$and)) {
    return { $and: cond.$and.map((c: any) => rewriteSystemFieldsInCondition(c, collection)) };
  }
  if (Array.isArray(cond.$or)) {
    return { $or: cond.$or.map((c: any) => rewriteSystemFieldsInCondition(c, collection)) };
  }
  if (cond.$not !== undefined) {
    return { $not: rewriteSystemFieldsInCondition(cond.$not, collection) };
  }
  // Leaf — a `{field: comparison}` map. Rewrite system-field keys.
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(cond)) {
    if (key === "created_at" || key === "updated_at" || key === "owner_id") {
      const physical = physicalSystemCol(collection, key);
      if (physical) {
        out[physical] = val;
        continue;
      }
      // For owner_id on the side-table path: keep the logical key so the
      // LEFT JOIN's `owner_id` resolves it (the join surfaces the column
      // unqualified — see fromOf + selectStar).
      out[key] = val;
      continue;
    }
    out[key] = val;
  }
  return out;
};

/**
 * Walk a Condition tree and collect every unique relation chain implied
 * by a nested-filter key — `customer_id.address_id.city` contributes the
 * chain `["customer_id", "address_id"]` (the leaf `city` is NOT part of
 * the chain — it's a column on the last target). Used by the list
 * handler to wire up the multi-hop LEFT JOIN ladder.
 *
 * Returned map key is the dot-joined chain (`"customer_id.address_id"`),
 * which collision-safely deduplicates: two filter clauses that share the
 * exact same join path produce a single join.
 *
 * `parseQuery` already validated that each head is a `relation` /
 * `relation_many` field that the caller may read and that every
 * subsequent segment has safe identifier shape, so we don't re-validate
 * here.
 */
export const collectNestedRelationChains = (cond: any): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  const walk = (c: any): void => {
    if (c === null || c === undefined) return;
    if (Array.isArray(c.$and)) {
      for (const sub of c.$and) walk(sub);
      return;
    }
    if (Array.isArray(c.$or)) {
      for (const sub of c.$or) walk(sub);
      return;
    }
    if (c.$not !== undefined) {
      walk(c.$not);
      return;
    }
    for (const k of Object.keys(c)) {
      if (k.includes(".")) {
        const segments = k.split(".");
        // Last segment is the leaf column on the final target — strip it.
        const chain = segments.slice(0, -1);
        if (chain.length === 0) continue;
        const key = chain.join(".");
        if (!out.has(key)) out.set(key, chain);
      }
    }
  };
  walk(cond);
  return out;
};

/** Rewrite a sort field name to its physical column. Returns the input
 *  unchanged when no mapping applies. */
export const rewriteSortField = (field: string, collection: CollectionRow): string => {
  if (field === "created_at" || field === "updated_at" || field === "owner_id") {
    const physical = physicalSystemCol(collection, field);
    if (physical) return physical;
  }
  return field;
};
