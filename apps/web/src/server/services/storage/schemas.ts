import { z } from "@hono/zod-openapi";
import { httpUrl } from "../../lib/openapi";

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
    url: httpUrl(),
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

export const SplitBucketsInput = z
  .object({
    limit: z.number().int().min(1).max(500).optional().openapi({
      description:
        "Rows to examine in this call. Default 100. Each moved object is copied and then deleted, so this is a byte budget as much as a row budget — keep it small on an edge runtime.",
    }),
    after: z.string().max(1024).optional().openapi({
      description: "The `cursor` from the previous call. Omit to start.",
    }),
    dryRun: z.boolean().optional().openapi({
      description:
        "Report what would move without moving anything. The default is `false` — this endpoint moves bytes, so the caller says so explicitly either way.",
    }),
  })
  .openapi("StorageSplitBucketsInput");

export const SplitBucketsResponse = z
  .object({
    scanned: z.number().int().nonnegative(),
    moved: z.number().int().nonnegative(),
    alreadySited: z.number().int().nonnegative().openapi({
      description: "Rows already in the right bucket — the steady state.",
    }),
    failed: z.number().int().nonnegative(),
    failedKeys: z.array(z.string()).openapi({
      description:
        "Keys whose bytes could not be moved, capped at 50. A missing source object lands here rather than being counted as moved.",
    }),
    cursor: z.string().nullable().openapi({
      description: "Pass as `after` to continue. `null` means the walk is done.",
    }),
    dryRun: z.boolean(),
  })
  .openapi("StorageSplitBucketsResponse");

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
