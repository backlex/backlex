import { and, eq, lte, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError } from "@backlex/core";
import type { Ctx } from "../context";
import type { Env } from "../env";
import { recordActivity } from "./activity";
import { filesTable } from "./storage/folders";

/**
 * Resumable upload sessions (TUS 1.0.0). Each session is backed by a native
 * object-store multipart upload (R2/S3) — or an offset-append temp file on the
 * fs backend — and tracked in the `uploads` table. `appendChunk` maps one TUS
 * PATCH to one multipart part; when the committed offset reaches the declared
 * length the parts are assembled and a `files` row is written. Abandoned
 * sessions past `expiresAt` are swept by `cronTick` (`sweepExpiredUploads`).
 */

export type UploadStatus = "pending" | "completed" | "aborted";

export interface UploadRow {
  id: string;
  tenantId: string | null;
  key: string;
  physicalKey: string;
  storageUploadId: string | null;
  size: number;
  offset: number;
  parts: { partNumber: number; etag: string; size: number }[];
  contentType: string | null;
  folderId: string | null;
  ownerId: string | null;
  metadata: Record<string, string>;
  status: UploadStatus;
  createdAt: Date | number;
  updatedAt: Date | number;
  expiresAt: Date | number;
}

export interface UploadPolicy {
  maxBytes: number;
  minPartBytes: number;
  ttlMs: number;
  partMax: number;
}

const numEnv = (raw: string | undefined, fallback: number): number => {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const uploadPolicy = (env: Env): UploadPolicy => ({
  maxBytes: numEnv(env.UPLOAD_MAX_BYTES, 5 * 1024 * 1024 * 1024),
  minPartBytes: numEnv(env.UPLOAD_MIN_PART_BYTES, 5 * 1024 * 1024),
  ttlMs: numEnv(env.UPLOAD_TTL_MS, 24 * 60 * 60 * 1000),
  partMax: numEnv(env.UPLOAD_PART_MAX, 10_000),
});

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.uploads : sqlite.schema.uploads;

const nowFor = (dialect: "pg" | "sqlite"): Date | number =>
  dialect === "pg" ? new Date() : Date.now();

const tsValue = (date: Date, dialect: "pg" | "sqlite"): Date | number =>
  dialect === "pg" ? date : date.getTime();

const asMs = (v: Date | number | null | undefined): number =>
  v == null ? 0 : v instanceof Date ? v.getTime() : v;

/** Throws UNAVAILABLE if the active storage backend can't do multipart. */
const requireMultipart = (ctx: Ctx) => {
  if (
    !ctx.storage.createMultipart ||
    !ctx.storage.uploadPart ||
    !ctx.storage.completeMultipart ||
    !ctx.storage.abortMultipart
  ) {
    throw new AppError(
      "UNAVAILABLE",
      "Resumable uploads are not supported by this storage backend",
    );
  }
};

export interface CreateUploadInput {
  tenantId: string;
  key: string;
  physicalKey: string;
  size: number;
  contentType?: string | null;
  folderId?: string | null;
  ownerId?: string | null;
  metadata?: Record<string, string>;
}

export const createUpload = async (
  ctx: Ctx,
  input: CreateUploadInput,
  policy: UploadPolicy = uploadPolicy(ctx.env),
): Promise<UploadRow> => {
  requireMultipart(ctx);
  const t = tableFor(ctx.dialect);
  const id = crypto.randomUUID();
  const now = nowFor(ctx.dialect);
  const expiresAt = tsValue(new Date(asMs(now) + policy.ttlMs), ctx.dialect);
  const { uploadId } = await ctx.storage.createMultipart!(input.physicalKey, {
    contentType: input.contentType ?? undefined,
  });
  const row = {
    id,
    tenantId: input.tenantId,
    key: input.key,
    physicalKey: input.physicalKey,
    storageUploadId: uploadId,
    size: input.size,
    offset: 0,
    parts: [],
    contentType: input.contentType ?? null,
    folderId: input.folderId ?? null,
    ownerId: input.ownerId ?? null,
    metadata: input.metadata ?? {},
    status: "pending" as const,
    createdAt: now,
    updatedAt: now,
    expiresAt,
  };
  await (ctx.db as any).insert(t).values(row);
  return row as unknown as UploadRow;
};

export const getUpload = async (
  ctx: Ctx,
  id: string,
  tenantId?: string | null,
): Promise<UploadRow | null> => {
  const t = tableFor(ctx.dialect);
  const where =
    tenantId !== undefined
      ? and(eq(t.id, id), eq(t.tenantId, tenantId as any))
      : eq(t.id, id);
  const rows = (await (ctx.db as any).select().from(t).where(where).limit(1)) as UploadRow[];
  return rows[0] ?? null;
};

/**
 * Append one chunk (one TUS PATCH) to an upload. `expectedOffset` must equal the
 * session's current committed offset (TUS concurrency guard → 409). When the
 * upload reaches its declared `size`, the multipart parts are assembled and a
 * `files` row is written. Returns the new committed offset and whether the
 * upload finished.
 */
export const appendChunk = async (
  ctx: Ctx,
  id: string,
  expectedOffset: number,
  body: Uint8Array,
  tenantId?: string | null,
): Promise<{ offset: number; completed: boolean }> => {
  requireMultipart(ctx);
  const t = tableFor(ctx.dialect);
  const upload = await getUpload(ctx, id, tenantId);
  if (!upload || upload.status !== "pending") {
    throw new AppError("NOT_FOUND", "Upload session not found");
  }
  if (expectedOffset !== upload.offset) {
    throw new AppError(
      "CONFLICT",
      `Offset mismatch: expected ${upload.offset}, got ${expectedOffset}`,
    );
  }
  const size = body.byteLength;
  if (upload.offset + size > upload.size) {
    throw new AppError("VALIDATION", "Chunk would exceed the declared upload length");
  }
  const prevParts = (upload.parts ?? []) as { partNumber: number; etag: string; size: number }[];
  const partNumber = prevParts.length + 1;
  const part = await ctx.storage.uploadPart!(
    upload.physicalKey,
    upload.storageUploadId!,
    partNumber,
    body,
    size,
  );
  const parts = [...prevParts, { partNumber: part.partNumber, etag: part.etag, size }];
  const offset = upload.offset + size;
  const now = nowFor(ctx.dialect);
  const completed = offset >= upload.size;

  if (!completed) {
    await (ctx.db as any)
      .update(t)
      .set({ parts, offset, updatedAt: now })
      .where(eq(t.id, id));
    return { offset, completed: false };
  }

  // Final chunk: assemble + record the file.
  await ctx.storage.completeMultipart!(
    upload.physicalKey,
    upload.storageUploadId!,
    parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
  );
  const ft = filesTable(ctx.dialect);
  const fileValues = {
    key: upload.physicalKey,
    folderId: upload.folderId,
    ownerId: upload.ownerId,
    tenantId: upload.tenantId,
    size: offset,
    contentType: upload.contentType ?? null,
  };
  await (ctx.db as any)
    .insert(ft)
    .values(fileValues)
    .onConflictDoUpdate({ target: ft.key, set: fileValues });
  await (ctx.db as any)
    .update(t)
    .set({ parts, offset, status: "completed", updatedAt: now })
    .where(eq(t.id, id));
  await recordActivity(ctx, {
    userId: upload.ownerId,
    tenantId: upload.tenantId,
    action: "upload",
    collection: "system_files",
    itemId: upload.key,
    payload: {
      size: offset,
      contentType: upload.contentType,
      folderId: upload.folderId,
      resumable: true,
    },
  });
  return { offset, completed: true };
};

/** Abort a pending upload: discard the multipart upload and mark the row. */
export const abortUpload = async (
  ctx: Ctx,
  id: string,
  tenantId?: string | null,
): Promise<boolean> => {
  const upload = await getUpload(ctx, id, tenantId);
  if (!upload || upload.status !== "pending") return false;
  const t = tableFor(ctx.dialect);
  const now = nowFor(ctx.dialect);
  try {
    if (upload.storageUploadId && ctx.storage.abortMultipart) {
      await ctx.storage.abortMultipart(upload.physicalKey, upload.storageUploadId);
    }
  } catch (e) {
    console.error(`[uploads] abort multipart failed for ${id}`, e);
  }
  await (ctx.db as any)
    .update(t)
    .set({ status: "aborted", updatedAt: now })
    .where(eq(t.id, id));
  return true;
};

export interface ListUploadsInput {
  tenantId?: string | null;
  status?: UploadStatus;
  limit?: number;
}

export const listUploads = async (
  ctx: Ctx,
  input: ListUploadsInput,
): Promise<UploadRow[]> => {
  const t = tableFor(ctx.dialect);
  const conds = [] as unknown[];
  if (input.tenantId !== undefined) conds.push(eq(t.tenantId, input.tenantId as any));
  if (input.status) conds.push(eq(t.status, input.status));
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const q = (ctx.db as any).select().from(t);
  const rows = (await (conds.length ? q.where(and(...(conds as any))) : q)
    .orderBy(sql`${t.createdAt} DESC`)
    .limit(limit)) as UploadRow[];
  return rows;
};

/**
 * Abort every pending upload whose `expiresAt` has passed. Called from
 * `cronTick`; uses the already-built ctx so no adapters are re-assembled.
 */
export const sweepExpiredUploads = async (ctx: Ctx): Promise<void> => {
  const t = tableFor(ctx.dialect);
  const now = nowFor(ctx.dialect);
  // Cast to any — the pg|sqlite union types `expiresAt` as `Date`, so
  // `lte(col, number)` won't resolve (see CLAUDE.md dual-dialect note).
  const tt = t as any;
  const stale = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(tt.status, "pending"), lte(tt.expiresAt, now as number)))
    .limit(100)) as UploadRow[];
  for (const upload of stale) {
    try {
      await abortUpload(ctx, upload.id, undefined);
    } catch (e) {
      console.error(`[uploads] sweep failed for ${upload.id}`, e);
    }
  }
};
