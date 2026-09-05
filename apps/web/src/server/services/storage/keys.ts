import { AppError } from "@backlex/core";

/**
 * Reserved physical-key prefix that namespaces every uploaded object under
 * `tenants/<tenant-id>/`. Stored on disk + in `files.key`; never exposed to
 * API clients (we strip it on read and re-add it on write). Two tenants can
 * therefore reuse the same logical key (e.g. "logo.png") without colliding
 * either in the bucket or in the DB primary key.
 */
export const TENANT_PREFIX = "tenants/";

/**
 * Suffix the fs storage adapter gives the temp file backing an in-progress
 * multipart upload. Declared here rather than in the adapter because it is the
 * logical-key namespace that has to reserve it: `guardLogicalKey` refuses a key
 * ending in it, so no uploaded object can take the name of an upload in flight
 * (which `completeMultipart` then renames into place) or hide from `list`,
 * which skips exactly these.
 */
export const UPLOADING_SUFFIX = ".uploading";

export const physicalKey = (tenantId: string, logical: string): string =>
  `${TENANT_PREFIX}${tenantId}/${logical}`;

export const stripTenantPrefix = (tenantId: string, physical: string): string => {
  const prefix = `${TENANT_PREFIX}${tenantId}/`;
  return physical.startsWith(prefix) ? physical.slice(prefix.length) : physical;
};

export const requireTenantId = (auth: { tenantId?: string | null }): string => {
  if (!auth.tenantId) {
    throw new AppError("VALIDATION", "Active tenant is required for storage operations");
  }
  return auth.tenantId;
};

export const guardLogicalKey = (key: string) => {
  if (key.startsWith(TENANT_PREFIX)) {
    throw new AppError("VALIDATION", `Key prefix "${TENANT_PREFIX}" is reserved`);
  }
  // Reject path-traversal and absolute/backslash/null-byte keys. Without this a
  // key built from parent-directory segments escapes both the `tenants/<tid>/`
  // isolation prefix (all adapters) AND the storage root on the fs adapter
  // (`join(root, key)`), enabling cross-tenant or out-of-root file writes.
  // (Kept in prose deliberately: a literal traversal payload in a comment ships
  // in the worker bundle and trips Cloudflare's managed WAF on template upload.)
  if (key.length === 0) {
    throw new AppError("VALIDATION", "Key must not be empty");
  }
  if (key.includes("\0")) {
    throw new AppError("VALIDATION", "Key must not contain null bytes");
  }
  if (key.startsWith("/") || key.startsWith("\\") || key.includes("\\")) {
    throw new AppError("VALIDATION", "Key must not contain backslashes or start with a slash");
  }
  // `?` / `#` are parsed as query / fragment by the S3 fetch adapter, which
  // builds its URL by interpolation — a key carrying either can inject S3
  // sub-resource parameters or truncate the object path.
  if (key.includes("?") || key.includes("#")) {
    throw new AppError("VALIDATION", 'Key must not contain "?" or "#"');
  }
  // A key may not end in the suffix the fs adapter gives an in-progress
  // multipart part: `list` skips those, so such an object is invisible to
  // listings and to storage accounting, and the name collides with the temp
  // file of an upload in flight that `completeMultipart` renames into place.
  if (key.endsWith(UPLOADING_SUFFIX)) {
    throw new AppError("VALIDATION", `Key must not end in "${UPLOADING_SUFFIX}"`);
  }
  // Normalize separators and check every segment: no traversal hop, no
  // leading-slash collapse, no doubled separator.
  //
  // The second rule is the one this audit added, and it is what widened the
  // guard: no segment may END in a dot or a space. A trailing-dot segment is
  // not itself a hop, but it is a directory a hop can be taken FROM once
  // created — which is precisely what made the fs adapter's multipart temp path
  // reachable — and Windows/NTFS strips trailing dots and spaces when opening a
  // file, so such a segment silently names a different existing object.
  //
  // It also SUBSUMES any all-dots segment, since one always ends in a dot. The
  // explicit pair is kept ahead of it only so a traversal hop still reports as
  // one; a `/^\.+$/` rule alongside it was tried and removed, because breaking
  // it left the suite green — it guarded nothing its neighbour did not.
  const assertNoTraversal = (value: string) => {
    for (const seg of value.split("/")) {
      if (seg === "." || seg === "..") {
        throw new AppError("VALIDATION", "Key must not contain path-traversal segments");
      }
      if (seg.endsWith(".") || seg.endsWith(" ")) {
        throw new AppError("VALIDATION", "Key segments must not end in a dot or a space");
      }
    }
  };
  assertNoTraversal(key);
  // A key that looks clean can still traverse once a URL parser sees it: the
  // S3 fetch adapter interpolates it through `encodeURI`, which leaves an
  // already-encoded `%2e%2e` untouched, and WHATWG URL parsing then collapses
  // it back into `..`. Re-check the decoded form.
  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    throw new AppError("VALIDATION", "Key must not contain invalid percent-encoding");
  }
  if (decoded !== key) assertNoTraversal(decoded);
};

/**
 * The same judgement for a LIST prefix, which is not a key.
 *
 * `routes/s3.ts` hands `?prefix=` to the storage adapter without ever building
 * a key from it, and the fs adapter resolves it against the storage root — so
 * an unguarded prefix carrying parent-directory segments made the adapter throw
 * a bare `Error`, i.e. an unhandled 500 rather than a refusal.
 *
 * Deliberately a SMALLER rule set than `guardLogicalKey`, because a prefix is a
 * string prefix and not a filename. It may be empty (list everything in scope),
 * and its last segment is a PARTIAL name — so `report.` is an ordinary request
 * for the invoices under it, and the trailing-dot and reserved-suffix rules a
 * whole key gets would refuse legitimate listings. What is left is everything
 * that could still leave the tenant's subtree.
 */
export const guardLogicalPrefix = (prefix: string) => {
  if (prefix.length === 0) return;
  if (prefix.startsWith(TENANT_PREFIX)) {
    throw new AppError("VALIDATION", `Key prefix "${TENANT_PREFIX}" is reserved`);
  }
  if (prefix.includes("\0")) {
    throw new AppError("VALIDATION", "Prefix must not contain null bytes");
  }
  if (prefix.startsWith("/") || prefix.includes("\\")) {
    throw new AppError(
      "VALIDATION",
      "Prefix must not contain backslashes or start with a slash",
    );
  }
  if (prefix.includes("?") || prefix.includes("#")) {
    throw new AppError("VALIDATION", 'Prefix must not contain "?" or "#"');
  }
  const assertNoTraversal = (value: string) => {
    for (const seg of value.split("/")) {
      if (seg === "." || seg === "..") {
        throw new AppError("VALIDATION", "Prefix must not contain path-traversal segments");
      }
    }
  };
  assertNoTraversal(prefix);
  let decoded: string;
  try {
    decoded = decodeURIComponent(prefix);
  } catch {
    throw new AppError("VALIDATION", "Prefix must not contain invalid percent-encoding");
  }
  if (decoded !== prefix) assertNoTraversal(decoded);
};

/** Both forms a row's `key` might take in production: the modern, tenant-
 *  prefixed `tenants/<tid>/<logical>` AND the bare logical key for rows
 *  uploaded before that prefix was introduced. Lookups, signs, deletes,
 *  and reads all match either form — the storage adapter then uses
 *  whatever key the row actually carries, so R2 GETs the right object. */
export function keyCandidates(tenantId: string, logicalKey: string): string[] {
  const physical = physicalKey(tenantId, logicalKey);
  if (physical === logicalKey) return [physical];
  return [physical, logicalKey];
}
