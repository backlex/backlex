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
    .select({ key: t.key, metadata: t.metadata })
    .from(t)
    .where(and(...conds))
    .limit(1)) as { key: string; metadata: Record<string, unknown> | null }[];
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
  await (ctx.db as any)
    .update(t)
    .set(patch)
    .where(and(eq(t.key, matchedKey), eq(t.tenantId, opts.tenantId)));
  return { key: opts.logicalKey, ...patch };
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
    .select({ key: t.key })
    .from(t)
    .where(and(...conds))
    .limit(1)) as { key: string }[];
  if (!rows[0]) throw new AppError("NOT_FOUND", "Object not found");
  const matchedKey = rows[0].key;

  await ctx.storage.delete(matchedKey);
  await (ctx.db as any)
    .delete(t)
    .where(and(eq(t.key, matchedKey), eq(t.tenantId, opts.tenantId)));
};
