/**
 * Per-isolate cache for the collections-list response (`GET /api/collections`).
 *
 * The collection schema for a tenant changes rarely (create / rename / archive /
 * delete) but is read on nearly every admin page load and on the hot path of
 * MCP schema tools. Without this cache each list read costs one D1 round-trip;
 * with it the steady state is served from isolate memory.
 *
 * (imports a type-only reference to `CollectionRow`, erased at compile time.)
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
 *
 * @module
 */
import type { CollectionRow } from "./items/collection-loader";

/*
 * A second cache below holds the per-`(tenant, slug)` *single* collection row
 * that `loadCollection` resolves on the hot path of every items CRUD / GraphQL /
 * realtime request. Same isolate/TTL/invalidation model; both caches are cleared
 * together by {@link invalidateTenantCollections}.
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

// --- Single-collection cache (loadCollection hot path) ---------------------
//
// Keyed by `(tenantId, slug)`. Stores the parsed `CollectionRow` that
// `loadCollection` returns, so a warm items read/write skips its one
// collection-metadata SELECT. Type-only import — erased at compile time, so no
// runtime cycle with collection-loader (which imports the helpers below).
//
// The stored row is SHARED by reference: callers must treat `CollectionRow`
// (and its `fields` array) as read-only, the same contract the list cache
// already relies on. Only successful, active resolutions are cached — misses
// and archived (NOT_FOUND) rows are never stored, so a just-created collection
// resolves immediately rather than being negatively cached.

interface SingleEntry {
  value: CollectionRow;
  expiresAt: number;
  tenantId: string;
}

const singleSerialize = (tenantId: string, slug: string): string =>
  `${tenantId}|${slug}`;

const singleCache = new Map<string, SingleEntry>();

/** Cached `CollectionRow` for `(tenant, slug)`, or `undefined` on miss/expiry.
 *  Shared reference — treat as read-only. */
export const getCachedCollection = (
  tenantId: string,
  slug: string,
): CollectionRow | undefined => {
  const sk = singleSerialize(tenantId, slug);
  const entry = singleCache.get(sk);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    singleCache.delete(sk);
    return undefined;
  }
  // Bump to most-recent for true LRU eviction.
  singleCache.delete(sk);
  singleCache.set(sk, entry);
  return entry.value;
};

export const setCachedCollection = (
  tenantId: string,
  slug: string,
  row: CollectionRow,
): void => {
  const sk = singleSerialize(tenantId, slug);
  if (singleCache.has(sk)) singleCache.delete(sk);
  singleCache.set(sk, { value: row, expiresAt: Date.now() + TTL_MS, tenantId });
  if (singleCache.size > MAX_ENTRIES) {
    const oldest = singleCache.keys().next().value;
    if (oldest !== undefined) singleCache.delete(oldest);
  }
};

/** Drop both list variants (archived + active) AND every single-collection
 *  entry for a tenant. Call from every route that mutates the `collections`
 *  table: create, rename, archive, restore, delete, add/drop field. */
export const invalidateTenantCollections = (tenantId: string): void => {
  for (const [sk, entry] of cache) {
    if (entry.tenantId === tenantId) cache.delete(sk);
  }
  for (const [sk, entry] of singleCache) {
    if (entry.tenantId === tenantId) singleCache.delete(sk);
  }
};

/** Test-only — current entry count (list + single). */
export const __collectionsCacheSize = (): number =>
  cache.size + singleCache.size;
