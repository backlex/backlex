/**
 * Pure, framework-free helpers for the admin item list. Kept out of
 * `queries.ts` (which pulls in React Query + the api transport) so they can be
 * unit-tested in isolation — no DOM, no network, no React.
 */
import type { Post } from "./config";
import type { FilterCondition } from "./items";

/** Server-query inputs that change the item-list result set. Mirrors exactly
 *  what the old app.tsx list effect built: limit, sort, free-text `q`, and a
 *  pre-serialised `filter` JSON string (chips + the status quick-filter). */
export interface ItemsQueryParams {
  limit: number;
  sort: string;
  q?: string;
  filter?: string;
}

/**
 * Build the item-list query params from the admin's filter UI state. The status
 * field NAME is resolved by the caller (`resolveStatusField(schema)?.name`) and
 * baked into the `filter` string here — that's why the query key never needs
 * the whole schema object: the key changes exactly when the status clause does.
 */
export function buildItemsParams(input: {
  sort: string;
  q: string;
  filters: FilterCondition[];
  statusTab: string;
  statusFieldName: string | null;
}): ItemsQueryParams {
  const { sort, q, filters, statusTab, statusFieldName } = input;
  const params: ItemsQueryParams = { limit: 50, sort: sort || "-updated_at" };
  if (q.trim()) params.q = q.trim();
  // Each chip is its own `$and` clause so duplicate field+op pairs survive.
  const clauses: Record<string, Record<string, unknown>>[] = filters.map((f) => ({
    [f.field]: { [f.op]: f.value },
  }));
  if (statusTab !== "all" && statusFieldName) {
    clauses.push({ [statusFieldName]: { _eq: statusTab } });
  }
  if (clauses.length === 1) params.filter = JSON.stringify(clauses[0]);
  else if (clauses.length > 1) params.filter = JSON.stringify({ $and: clauses });
  return params;
}

/** After a full snapshot-restore, re-apply a bulk patch to ONLY the ids the
 *  server confirmed — the partial-success reconcile for bulk update. */
export function reconcileBulkUpdate(
  rows: Post[],
  okIds: Set<string>,
  data: Record<string, unknown>,
  now: string,
): Post[] {
  return rows.map((r) =>
    okIds.has(r.id) ? ({ ...r, ...data, updated_at: now } as Post) : r,
  );
}
