/** Shared helpers for provider implementations. Pure, no runtime coupling. */

/** base64 (Workers/Bun/Node 18+ `btoa`); null if unavailable. */
export function b64(s: string): string | null {
  try {
    return typeof btoa === "function" ? btoa(s) : null;
  } catch {
    return null;
  }
}

/**
 * Trim a trailing slash and default to https:// when no scheme is given.
 *
 * An EXPLICIT `http://` is passed through, deliberately. A self-hosted
 * Meilisearch, Elasticsearch or Typesense on a private network is normally
 * plain http, and refusing it here would break those deployments without adding
 * any containment: what decides whether a host is reachable at all is the SSRF
 * guard on the `FetchLike` the engine is handed
 * (`services/integrations-fetch.ts`), which sees the finished URL and applies
 * the deployment's actual policy. The name promises a default, not a
 * guarantee — read it as "https unless told otherwise".
 */
export function asHttpsBase(host: string): string {
  const s = host.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/** A stable id for search/analytics sinks: the record id when present. */
export function recordId(payload: Record<string, unknown>, fallback: string): string {
  const id = payload.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : fallback;
}
