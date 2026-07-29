/** Shared helpers for provider implementations. Pure, no runtime coupling. */

/** base64 (Workers/Bun/Node 18+ `btoa`); null if unavailable. */
export function b64(s: string): string | null {
  try {
    return typeof btoa === "function" ? btoa(s) : null;
  } catch {
    return null;
  }
}

/** Trim a trailing slash and default to https:// when no scheme is given. */
export function asHttpsBase(host: string): string {
  const s = host.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/** A stable id for search/analytics sinks: the record id when present. */
export function recordId(payload: Record<string, unknown>, fallback: string): string {
  const id = payload.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : fallback;
}
