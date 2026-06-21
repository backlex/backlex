import { AppError } from "@backlex/core";

/**
 * Reserved physical-key prefix that namespaces every uploaded object under
 * `tenants/<tenant-id>/`. Stored on disk + in `files.key`; never exposed to
 * API clients (we strip it on read and re-add it on write). Two tenants can
 * therefore reuse the same logical key (e.g. "logo.png") without colliding
 * either in the bucket or in the DB primary key.
 */
export const TENANT_PREFIX = "tenants/";

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
  // key like `../../../etc/passwd` escapes both the `tenants/<tid>/` isolation
  // prefix (all adapters) AND the storage root on the fs adapter
  // (`join(root, key)`), enabling cross-tenant or out-of-root file writes.
  if (key.length === 0) {
    throw new AppError("VALIDATION", "Key must not be empty");
  }
  if (key.includes("\0")) {
    throw new AppError("VALIDATION", "Key must not contain null bytes");
  }
  if (key.startsWith("/") || key.startsWith("\\") || key.includes("\\")) {
    throw new AppError("VALIDATION", "Key must not contain backslashes or start with a slash");
  }
  // Normalize separators and check every segment: no `.`/`..` traversal,
  // no leading-slash collapse. Covers `a/../../b`, `./x`, `a//b`.
  const segments = key.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      throw new AppError("VALIDATION", "Key must not contain path-traversal segments");
    }
  }
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
