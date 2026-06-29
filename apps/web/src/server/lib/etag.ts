/**
 * Cheap weak-validator helpers for conditional GETs (ETag → 304 Not Modified).
 *
 * A weak ETag (`W/"…"`) asserts the responses are *semantically* equivalent,
 * not byte-identical — perfect for an API row, where the validator is derived
 * from a version column (`updated_at`) plus the params that change the body
 * (locale / expand / projection / the caller's field allow-list) rather than
 * hashing the serialized payload. When the client echoes the value back in
 * `If-None-Match` and it still matches, the server skips serialization and
 * sends an empty 304, so the round-trip costs no body bytes and no re-render.
 */

/** FNV-1a → base36. Not cryptographic — just a fast, stable digest for
 *  collapsing a validator key into a short token. */
export const weakHash = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

/** Build a weak ETag from the parts that uniquely identify this response
 *  version. Nullish parts collapse to "" so the key stays stable. */
export const weakETag = (
  parts: (string | number | null | undefined)[],
): string => `W/"${weakHash(parts.map((p) => p ?? "").join("|"))}"`;

/** Whether the request's `If-None-Match` satisfies `etag` (RFC 9110 weak
 *  comparison: the `W/` prefix is ignored, `*` matches anything, and the
 *  header may carry a comma-separated list). */
export const ifNoneMatch = (
  header: string | null | undefined,
  etag: string,
): boolean => {
  if (!header) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  const target = strip(etag);
  return header.split(",").some((t) => {
    const v = strip(t);
    return v === "*" || v === target;
  });
};
