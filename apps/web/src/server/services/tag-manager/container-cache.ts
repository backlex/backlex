/**
 * The per-isolate memo in front of the public container endpoint.
 *
 * Its own module for one reason: the route owns the cache but the SERVICE knows
 * when it is stale. Publishing and rolling back both change what should be
 * served, and without a way to say so an operator publishes, immediately checks
 * their site, and sees the old container — which reads exactly like a broken
 * publish rather than a cache.
 *
 * ── What this can and cannot promise ──────────────────────────────────────
 * Module-level state is per ISOLATE, so invalidating clears the isolate that
 * handled the publish and no other. On Workers that means another isolate can
 * still serve up to `TTL_MS` of staleness. That is fine and is not worth
 * solving: the browser cache in front of this is fifteen minutes, so the memo
 * was never the binding constraint — it is only ever the difference between
 * "instant" and "within a minute" for the operator's own next request.
 *
 * The key carries the ORIGIN as well as the site. The served body embeds an
 * absolute collect endpoint derived from the request URL, so a memo keyed on
 * the site alone would let one request arriving on an attacker-controlled host
 * poison what the next minute of real visitors receive.
 */
export interface ContainerEntry {
  at: number;
  body: string;
  hash: string;
  tenantId: string | null;
  /** Which composition of tracker / banner / runtime this body actually is.
   *  Part of the ETag, because the composition varies per site now: a
   *  whole-constant fingerprint would leave a consent-only site's validator
   *  unmoved while its body changed, and a 304 refreshes freshness. */
  fingerprint: string;
}

const TTL_MS = 60_000;
/** Bounded so a workspace with thousands of sites cannot grow an isolate's
 *  heap without limit. */
const MAX_ENTRIES = 200;

const memo = new Map<string, ContainerEntry>();

const keyOf = (siteId: string, origin: string): string => `${siteId}|${origin}`;

export const getContainerEntry = (
  siteId: string,
  origin: string,
  now: number,
): ContainerEntry | undefined => {
  const key = keyOf(siteId, origin);
  const hit = memo.get(key);
  if (!hit) return undefined;
  if (now - hit.at > TTL_MS) {
    memo.delete(key);
    return undefined;
  }
  return hit;
};

export const setContainerEntry = (
  siteId: string,
  origin: string,
  entry: ContainerEntry,
): void => {
  if (memo.size >= MAX_ENTRIES) memo.clear();
  memo.set(keyOf(siteId, origin), entry);
};

/**
 * Drop every origin's entry for one site.
 *
 * Called from the publish and rollback paths. Origin is not a parameter there —
 * the service has no request — so this sweeps by site, which is a handful of
 * entries at most.
 */
export const invalidateContainer = (siteId: string): void => {
  for (const key of memo.keys()) {
    if (key.slice(0, key.lastIndexOf("|")) === siteId) memo.delete(key);
  }
};
