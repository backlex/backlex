/**
 * Per-isolate cache for the collections-list response (`GET /api/collections`).
 *
 * The collection schema for a tenant changes rarely (create / rename / archive /
 * delete) but is read on nearly every admin page load and on the hot path of
 * MCP schema tools. Without this cache each list read costs one D1 round-trip;
 * with it the steady state is served from isolate memory.
 *
 * Same model as {@link ../services/permissions-cache}: module-level state =
 * one Map per isolate (fine on CF Workers and Bun). Mutating routes call
 * {@link invalidateTenantCollections} for same-isolate freshness; `TTL_MS` is
 * the cross-isolate convergence ceiling — a sibling isolate keeps a stale list
 * for at most that long after a schema change it didn't perform.
 *
 * Staleness is the safe direction here: a just-created collection is missing
 * from a sibling's list for ≤ TTL_MS (the UI refetches), and a just-deleted one
 * lingers ≤ TTL_MS. Neither leaks data — permission resolution still gates every
 * row read against live permission rows.
 */

// Keep aligned with permissions-cache TTL_MS so the whole schema/permission
// surface converges on the same window across isolates.
const TTL_MS = 30_000;
const MAX_ENTRIES = 2_000;

interface Key {
  tenantId: string;
  includeArchived: boolean;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
  tenantId: string;
}

const serialize = (k: Key): string => `${k.tenantId}|${k.includeArchived ? 1 : 0}`;

const cache = new Map<string, Entry<unknown[]>>();

/** Return the cached collection rows for a tenant, or `undefined` on miss /
 *  expiry. The returned array is shared — callers must treat it as read-only
 *  (the list handler only serializes it). */
export const getCachedCollections = (k: Key): unknown[] | undefined => {
  const sk = serialize(k);
  const entry = cache.get(sk);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(sk);
    return undefined;
  }
  // Bump to most-recent for true LRU eviction.
  cache.delete(sk);
  cache.set(sk, entry);
  return entry.value;
};

export const setCachedCollections = (k: Key, rows: unknown[]): void => {
  const sk = serialize(k);
  if (cache.has(sk)) cache.delete(sk);
  cache.set(sk, { value: rows, expiresAt: Date.now() + TTL_MS, tenantId: k.tenantId });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
};

/** Drop both list variants (archived + active) for a tenant. Call from every
 *  route that mutates the `collections` table: create, rename, archive,
 *  restore, delete. */
export const invalidateTenantCollections = (tenantId: string): void => {
  for (const [sk, entry] of cache) {
    if (entry.tenantId === tenantId) cache.delete(sk);
  }
};

/** Test-only — current entry count. */
export const __collectionsCacheSize = (): number => cache.size;
