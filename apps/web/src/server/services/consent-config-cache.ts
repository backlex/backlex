/**
 * The per-isolate memo in front of the public consent-config endpoint.
 *
 * Its own module for the reason `tag-container-cache.ts` is: the route owns the
 * cache but the SERVICE knows when it is stale. Saving a policy changes what
 * should be served, and without a way to say so an operator edits their wording,
 * immediately reloads their site, and sees the old text — which reads exactly
 * like a broken save rather than a cache.
 *
 * ── Keyed on the SITE ALONE, deliberately ─────────────────────────────────
 * The container cache next door keys on `${siteId}|${origin}` because its body
 * embeds an absolute collect endpoint derived from the request URL, so a memo
 * keyed on the site would let one request on an attacker-controlled host poison
 * the next minute of real visitors. **This body embeds nothing request-derived**
 * — it is compiled from the policy row and nothing else — so the site key is
 * correct here and the origin component would only fragment the memo. Do not
 * "restore" it by symmetry with the neighbour.
 *
 * It is also a separate Map rather than a shared one: `tag-container-cache`'s
 * `keyOf` would collide key-for-key with `/tm/:file` for the same site, and its
 * `invalidateContainer` sweeps by site prefix, so one module would have each
 * feature's invalidation clearing the other's entries.
 *
 * ── What this can and cannot promise ──────────────────────────────────────
 * Module-level state is per ISOLATE, so invalidating clears the isolate that
 * handled the save and no other. On Workers another isolate can still serve up
 * to `TTL_MS` of staleness, behind a browser cache that is longer again. An
 * operator who edits wording and immediately reloads a second tab may see the
 * old text for up to a minute; that is documented rather than solved, because
 * the browser cache in front of this was always the binding constraint.
 */
export interface ConsentConfigEntry {
  at: number;
  /** The canonical artifact JSON, exactly as served. */
  body: string;
  /** SHA-256 of `body` — the ETag's payload. */
  hash: string;
  /** Resolved from the site, so a cache hit still meters the right workspace. */
  tenantId: string | null;
}

const TTL_MS = 60_000;
/** Bounded so a workspace with thousands of sites cannot grow an isolate's
 *  heap without limit. Cleared wholesale rather than evicted LRU — the same
 *  choice the container cache makes, and at this size the difference is not
 *  worth a second data structure. */
const MAX_ENTRIES = 200;

const memo = new Map<string, ConsentConfigEntry>();

export const getConsentEntry = (
  siteId: string,
  now: number,
): ConsentConfigEntry | undefined => {
  const hit = memo.get(siteId);
  if (!hit) return undefined;
  if (now - hit.at > TTL_MS) {
    memo.delete(siteId);
    return undefined;
  }
  return hit;
};

export const setConsentEntry = (siteId: string, entry: ConsentConfigEntry): void => {
  if (memo.size >= MAX_ENTRIES) memo.clear();
  memo.set(siteId, entry);
};

/**
 * Drop a site's entry.
 *
 * Called from every write path in `services/consent.ts` — save, delete, and the
 * site-deletion cascade. Deletion matters as much as saving: without it a
 * removed policy keeps being served from the memo for a minute after the row is
 * gone, on somebody's live site.
 */
export const invalidateConsentConfig = (siteId: string): void => {
  memo.delete(siteId);
};
