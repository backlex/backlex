import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { Ctx } from "../../context";
import { filesTable } from "./folders";
import { guardLogicalKey, keyCandidates, physicalKey, stripTenantPrefix } from "./keys";
import { bucketFor, moveBetweenBuckets, type FileAcl } from "./bucket-for";
import type { FileRow } from "./schemas";

// ── Shared surface helpers ───────────────────────────────────────────────────
// REST (routes/storage.ts) and GraphQL (services/graphql/storage.ts) both call
// these. Permission scoping is the CALLER's job: REST gets `perm.whereSql`
// from the requirePermission middleware, GraphQL from resolvePermission — the
// helpers just apply whatever row filter they're handed on top of the hard
// `tenant_id` isolation.

/** API-shaped file row (tenant prefix stripped, ISO upload timestamp). */
export interface ApiFileRow {
  key: string;
  folderId: string | null;
  size: number;
  contentType?: string;
  ownerId: string | null;
  acl: "public" | "private";
  metadata: Record<string, unknown> | null;
  uploadedAt: string;
}

export interface FileListOptions {
  tenantId: string;
  prefix?: string;
  folderId?: string;
  search?: string;
  limit: number;
  offset: number;
  permWhere?: SQL | null;
}

export const listFilesScoped = async (
  ctx: Ctx,
  opts: FileListOptions,
): Promise<{ data: ApiFileRow[]; meta: { total: number; limit: number; offset: number } }> => {
  const t = filesTable(ctx.dialect);
  const prefix = opts.prefix ?? "";
  const physicalPrefix = physicalKey(opts.tenantId, prefix);
  const search = (opts.search ?? "").trim();

  const conds: SQL[] = [eq(t.tenantId, opts.tenantId)];
  // The key-prefix filter is purely organizational: only enforced when the
  // caller is browsing into a sub-path. Tenant isolation is already handled by
  // `tenant_id = ?`, and legacy rows (uploaded before the `tenants/<tid>/`
  // physical prefix was introduced) would otherwise never show up in the list.
  if (prefix) {
    // Prefix match as an index-friendly range scan rather than `key LIKE
    // 'prefix%'`. D1's SQLite rejects a bound LIKE pattern with "LIKE or GLOB
    // pattern too complex" (and the range form also hits the index instead of
    // a full scan). The upper sentinel is the prefix with a code point above
    // any byte a normal key contains.
    conds.push(gte(t.key, physicalPrefix), lt(t.key, `${physicalPrefix}\u{10FFFF}`));
  }
  if (opts.folderId === "__root__") conds.push(isNull(t.folderId));
  else if (opts.folderId) conds.push(eq(t.folderId, opts.folderId));
  if (search) {
    // Substring match — tolerant of legacy rows without the `tenants/<tid>/`
    // physical prefix. SQLite LIKE is case-insensitive for ASCII; Postgres
    // uses ILIKE for portability.
    const esc = search.replace(/[\\%_]/g, (m) => `\\${m}`);
    const pattern = `%${esc}%`;
    conds.push(
      ctx.dialect === "pg"
        ? sql`${sql.identifier("key")} ILIKE ${pattern} ESCAPE '\\'`
        : sql`${sql.identifier("key")} LIKE ${pattern} ESCAPE '\\'`,
    );
  }
  if (opts.permWhere) conds.push(opts.permWhere);

  const where = and(...conds);
  const [rows, totalRows] = await Promise.all([
    (ctx.db as any)
      .select()
      .from(t)
      .where(where)
      .orderBy(desc(t.createdAt))
      .limit(opts.limit)
      .offset(opts.offset) as Promise<FileRow[]>,
    (ctx.db as any).select({ value: count() }).from(t).where(where) as Promise<
      { value: number }[]
    >,
  ]);
  const total = Number(totalRows[0]?.value ?? 0);

  return {
    data: rows.map((r: any) => ({
      key: stripTenantPrefix(opts.tenantId, r.key),
      folderId: r.folderId,
      size: r.size,
      contentType: r.contentType ?? undefined,
      ownerId: r.ownerId,
      acl: r.acl,
      metadata: r.metadata ?? null,
      uploadedAt:
        r.createdAt instanceof Date
          ? r.createdAt.toISOString()
          : new Date(r.createdAt).toISOString(),
    })),
    meta: { total, limit: opts.limit, offset: opts.offset },
  };
};

export interface FilePatchInput {
  acl?: "public" | "private";
  folderId?: string | null;
  /** Free-form bag for display name, description, tags[], author, location,
   *  etc. Merged onto the existing row — keys explicitly set to `null` are
   *  removed so callers can clear a field; a top-level `null` wipes it all. */
  metadata?: Record<string, unknown> | null;
}

/** Update a file's ACL/folder/metadata. Throws NOT_FOUND when the key doesn't
 *  resolve inside the tenant + row-filter scope. Returns the wire-shape patch
 *  (`{ key, ...applied }`) the REST endpoint has always echoed. */
export const patchFileScoped = async (
  ctx: Ctx,
  opts: {
    tenantId: string;
    logicalKey: string;
    permWhere?: SQL | null;
    patch: FilePatchInput;
  },
): Promise<Record<string, unknown>> => {
  guardLogicalKey(opts.logicalKey);
  const t = filesTable(ctx.dialect);
  const conds: SQL[] = [
    inArray(t.key, keyCandidates(opts.tenantId, opts.logicalKey)),
    eq(t.tenantId, opts.tenantId),
  ];
  if (opts.permWhere) conds.push(opts.permWhere);
  const existing = (await (ctx.db as any)
    .select({ key: t.key, acl: t.acl, metadata: t.metadata })
    .from(t)
    .where(and(...conds))
    .limit(1)) as {
    key: string;
    acl: string | null;
    metadata: Record<string, unknown> | null;
  }[];
  if (!existing[0]) throw new AppError("NOT_FOUND", "Object not found");
  const matchedKey = existing[0].key;

  const patch: Record<string, unknown> = {};
  if (opts.patch.acl) patch.acl = opts.patch.acl;
  if (opts.patch.folderId !== undefined) patch.folderId = opts.patch.folderId;
  if (opts.patch.metadata !== undefined) {
    // null = wipe everything; an object = merge (null leaves on keys remove them)
    if (opts.patch.metadata === null) {
      patch.metadata = null;
    } else {
      const merged: Record<string, unknown> = { ...(existing[0].metadata ?? {}) };
      for (const [k, v] of Object.entries(opts.patch.metadata)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      patch.metadata = Object.keys(merged).length > 0 ? merged : null;
    }
  }
  // Flipping the ACL is a MOVE when the deployment keeps public objects in
  // their own bucket, because the exposure is a property of the bucket: leaving
  // a now-private object in the world-readable one is the exact hole the split
  // exists to close, and leaving a now-public one behind means the CDN path
  // 404s. Done BEFORE the row is updated, and it throws — a row that claims
  // `public` while its bytes sit in the private bucket is worse than a refused
  // PATCH, because nothing afterwards would notice.
  const fromAcl = (existing[0].acl ?? "private") as FileAcl;
  const toAcl = (opts.patch.acl ?? existing[0].acl ?? "private") as FileAcl;
  if (opts.patch.acl && toAcl !== fromAcl) {
    await moveBetweenBuckets(ctx, matchedKey, fromAcl, toAcl);
  }

  await (ctx.db as any)
    .update(t)
    .set(patch)
    .where(and(eq(t.key, matchedKey), eq(t.tenantId, opts.tenantId)));
  return { key: opts.logicalKey, ...patch };
};

/**
 * The ACL of the row stored under EXACTLY this physical key, or `"private"`
 * when there is no such row.
 *
 * Used by write paths that need to know which bucket to put bytes in, and the
 * exactness is the whole point. Every *read* here resolves through
 * `keyCandidates`, which deliberately matches two keys — the tenant-prefixed
 * one and the legacy un-prefixed one, because rows written before the prefix
 * existed kept their object at the bare location. That is right for a read and
 * wrong for a write: an upload writes to the PREFIXED key, so routing it by an
 * ACL that may have come from the legacy row lands private bytes in the public
 * bucket while the new row says `private`. The API then 404s the file (it looks
 * in the private bucket) while the object is served to anyone at the public
 * URL, and nothing reports the disagreement.
 *
 * So: match the key that is about to be written, and nothing else.
 */
export const aclForKey = async (ctx: Ctx, physicalKeyValue: string): Promise<FileAcl> => {
  const t = filesTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ acl: t.acl })
    .from(t)
    .where(eq(t.key, physicalKeyValue))
    .limit(1)) as { acl: string | null }[];
  return (rows[0]?.acl ?? "private") as FileAcl;
};

/** Delete the object bytes + tracking row. Throws NOT_FOUND when the key
 *  doesn't resolve inside the tenant + row-filter scope. */
export const deleteFileScoped = async (
  ctx: Ctx,
  opts: { tenantId: string; logicalKey: string; permWhere?: SQL | null },
): Promise<void> => {
  guardLogicalKey(opts.logicalKey);
  const t = filesTable(ctx.dialect);
  const conds: SQL[] = [
    inArray(t.key, keyCandidates(opts.tenantId, opts.logicalKey)),
    eq(t.tenantId, opts.tenantId),
  ];
  if (opts.permWhere) conds.push(opts.permWhere);
  const rows = (await (ctx.db as any)
    .select({ key: t.key, acl: t.acl })
    .from(t)
    .where(and(...conds))
    .limit(1)) as { key: string; acl: string | null }[];
  if (!rows[0]) throw new AppError("NOT_FOUND", "Object not found");
  const matchedKey = rows[0].key;

  // Delete from the bucket the row says it is in. Deleting from the wrong one
  // is a silent no-op on both adapters (delete is idempotent by contract), so
  // the row would vanish and the bytes would stay world-readable — which is
  // precisely the failure the split exists to prevent.
  await bucketFor(ctx, rows[0].acl as FileAcl).delete(matchedKey);
  await (ctx.db as any)
    .delete(t)
    .where(and(eq(t.key, matchedKey), eq(t.tenantId, opts.tenantId)));
};
