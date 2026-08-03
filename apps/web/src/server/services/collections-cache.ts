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
import type { RollupDependent } from "./items/rollup";

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

// --- Group-order cache ------------------------------------------------------
//
// The ordered group-header names for the Collections page + sidebar tree
// (the `collectionGroups` app_settings row). Read alongside every list GET,
// so it shares the list cache's isolate/TTL model and is cleared by the same
// invalidation call — `POST /collections/layout` rewrites both rows and order.

interface GroupOrderEntry {
  value: string[];
  expiresAt: number;
}

const groupOrderCache = new Map<string, GroupOrderEntry>();

/** Cached group-header order for a tenant, or `undefined` on miss/expiry. */
export const getCachedGroupOrder = (tenantId: string): string[] | undefined => {
  const entry = groupOrderCache.get(tenantId);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    groupOrderCache.delete(tenantId);
    return undefined;
  }
  return entry.value;
};

export const setCachedGroupOrder = (tenantId: string, groups: string[]): void => {
  groupOrderCache.set(tenantId, { value: groups, expiresAt: Date.now() + TTL_MS });
  if (groupOrderCache.size > MAX_ENTRIES) {
    const oldest = groupOrderCache.keys().next().value;
    if (oldest !== undefined) groupOrderCache.delete(oldest);
  }
};

// --- Rollup reverse-index cache --------------------------------------------
//
// "Which collections roll up FROM this one?", keyed by `(tenant, childSlug)`.
// A rollup is declared on the parent but refreshed by writes to the CHILD, so
// the items write path needs this reverse lookup on every single write — and
// for almost every collection the honest answer is an empty array, which is the
// case worth serving from memory.
//
// It lives HERE rather than beside the rollup service for one reason: it must
// be dropped by exactly the same invalidation the schema caches are, and there
// are eight call sites. Sharing `invalidateTenantCollections` means a new
// schema-mutating route can't forget this one specifically. (Type-only import
// above — erased at compile time, so no runtime cycle with the rollup service.)

interface RollupDepEntry {
  value: RollupDependent[];
  expiresAt: number;
  tenantId: string;
}

const rollupDepCache = new Map<string, RollupDepEntry>();

/** Cached rollup dependents for `(tenant, childSlug)`, or `undefined` on
 *  miss/expiry. Shared reference — treat as read-only. */
export const getCachedRollupDeps = (
  tenantId: string,
  childSlug: string,
): RollupDependent[] | undefined => {
  const sk = `${tenantId}|${childSlug}`;
  const entry = rollupDepCache.get(sk);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    rollupDepCache.delete(sk);
    return undefined;
  }
  rollupDepCache.delete(sk);
  rollupDepCache.set(sk, entry);
  return entry.value;
};

export const setCachedRollupDeps = (
  tenantId: string,
  childSlug: string,
  deps: RollupDependent[],
): void => {
  const sk = `${tenantId}|${childSlug}`;
  if (rollupDepCache.has(sk)) rollupDepCache.delete(sk);
  rollupDepCache.set(sk, { value: deps, expiresAt: Date.now() + TTL_MS, tenantId });
  if (rollupDepCache.size > MAX_ENTRIES) {
    const oldest = rollupDepCache.keys().next().value;
    if (oldest !== undefined) rollupDepCache.delete(oldest);
  }
};

/** Drop both list variants (archived + active), every single-collection
 *  entry, the rollup reverse index, and the group-header order for a tenant.
 *  Call from every route that mutates the `collections` table: create, rename,
 *  archive, restore, delete, add/drop field, layout. */
export const invalidateTenantCollections = (tenantId: string): void => {
  for (const [sk, entry] of cache) {
    if (entry.tenantId === tenantId) cache.delete(sk);
  }
  for (const [sk, entry] of singleCache) {
    if (entry.tenantId === tenantId) singleCache.delete(sk);
  }
  for (const [sk, entry] of rollupDepCache) {
    if (entry.tenantId === tenantId) rollupDepCache.delete(sk);
  }
  groupOrderCache.delete(tenantId);
};

/** Test-only — current entry count (list + single + rollup deps + group-order). */
export const __collectionsCacheSize = (): number =>
  cache.size + singleCache.size + rollupDepCache.size + groupOrderCache.size;
