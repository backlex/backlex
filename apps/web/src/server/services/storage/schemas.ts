import { z } from "@hono/zod-openapi";

export const FileRowSchema = z
  .object({
    key: z.string().openapi({ description: "Logical key (tenant prefix stripped)." }),
    folderId: z.string().nullable(),
    size: z.number().int().nonnegative(),
    contentType: z.string().optional(),
    ownerId: z.string().nullable(),
    acl: z.enum(["public", "private"]),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    uploadedAt: z.string().datetime(),
  })
  .openapi("FileRow");

export const FileListMeta = z
  .object({
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .openapi("FileListMeta");

export const FromUrlInput = z
  .object({
    url: z.string().url(),
    key: z.string().optional(),
    folderId: z.string().nullable().optional(),
    acl: z.enum(["public", "private"]).optional(),
  })
  .openapi("StorageFromUrlInput");

export const PatchInput = z
  .object({
    acl: z.enum(["public", "private"]).optional(),
    folderId: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("StoragePatchInput");

export const SignInput = z
  .object({
    ttlSeconds: z.number().int().min(60).max(86400).optional().openapi({
      description: "Token lifetime in seconds (60–86400). Defaults to 3600.",
    }),
  })
  .openapi("StorageSignInput");

export const SignResponse = z
  .object({
    url: z.string(),
    expiresAt: z.string().datetime(),
  })
  .openapi("StorageSignResponse");

export const FolderCounts = z
  .object({
    root: z.number().int().nonnegative(),
    byFolderId: z.record(z.string(), z.number().int().nonnegative()),
    total: z.number().int().nonnegative(),
  })
  .openapi("StorageFolderCounts");

export const BackfillResponse = z
  .object({
    scanned: z.number().int().nonnegative(),
    filesUpdated: z.number().int().nonnegative(),
    foldersCreated: z.number().int().nonnegative(),
  })
  .openapi("StorageBackfillResponse");

export const tags = ["storage"];

export interface FileRow {
  key: string;
  folderId: string | null;
  ownerId: string | null;
  acl: "public" | "private";
  size: number;
  contentType: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date | number;
}
