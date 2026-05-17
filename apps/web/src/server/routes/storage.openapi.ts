import { z } from "../lib/openapi";
import {
  apiRegistry,
  SECURITY,
  AppErrorSchema,
  OkSchema,
  errorResponses,
} from "../lib/openapi";

const FileRow = z
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

const FileListMeta = z
  .object({
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .openapi("FileListMeta");

const FromUrlInput = z
  .object({
    url: z.string().url(),
    key: z.string().optional(),
    folderId: z.string().nullable().optional(),
    acl: z.enum(["public", "private"]).optional(),
  })
  .openapi("StorageFromUrlInput");

const PatchInput = z
  .object({
    acl: z.enum(["public", "private"]).optional(),
    folderId: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("StoragePatchInput");

const SignInput = z
  .object({
    ttlSeconds: z.number().int().min(60).max(86400).optional().openapi({
      description: "Token lifetime in seconds (60–86400). Defaults to 3600.",
    }),
  })
  .openapi("StorageSignInput");

const SignResponse = z
  .object({
    url: z.string(),
    expiresAt: z.string().datetime(),
  })
  .openapi("StorageSignResponse");

const FolderCounts = z
  .object({
    root: z.number().int().nonnegative(),
    byFolderId: z.record(z.string(), z.number().int().nonnegative()),
    total: z.number().int().nonnegative(),
  })
  .openapi("StorageFolderCounts");

const BackfillResponse = z
  .object({
    scanned: z.number().int().nonnegative(),
    filesUpdated: z.number().int().nonnegative(),
    foldersCreated: z.number().int().nonnegative(),
  })
  .openapi("StorageBackfillResponse");

const tags = ["storage"];

apiRegistry.registerPath({
  method: "get",
  path: "/api/storage",
  tags,
  summary: "List files",
  description: "Paginated listing for the active workspace. Supports prefix, folder, and substring search filters.",
  security: SECURITY,
  request: {
    query: z.object({
      prefix: z.string().optional(),
      folderId: z.string().optional().openapi({
        description: "Folder UUID, or `__root__` to match files with no folder.",
      }),
      search: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ data: z.array(FileRow), meta: FileListMeta }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/storage/folder-counts",
  tags,
  summary: "Aggregate file counts per folder",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: FolderCounts } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/storage/_backfill-folders",
  tags,
  summary: "Backfill folders from key paths (admin)",
  description: "Walks every NULL-folder file in the active tenant, deriving a folder from the key path.",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: BackfillResponse } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/storage/from-url",
  tags,
  summary: "Import a remote URL into storage",
  description: "Server-side fetch + store. SSRF-guarded; 100 MB cap; 30 s timeout.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: FromUrlInput } } } },
  responses: {
    201: { description: "Imported", content: { "application/json": { schema: z.object({ data: FileRow.extend({ sourceUrl: z.string().url() }) }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "put",
  path: "/api/storage/{key}",
  tags,
  summary: "Upload an object",
  description: "Stream the request body to the storage adapter. Folder is auto-derived from the key path unless `?folderId=` is set.",
  security: SECURITY,
  request: {
    params: z.object({ key: z.string().openapi({ description: "Logical key (may contain `/`)." }) }),
    query: z.object({
      folderId: z.string().optional().openapi({ description: "Folder UUID, or `__root__` to opt out of auto-derive." }),
    }),
    body: { required: true, content: { "application/octet-stream": { schema: z.string().openapi({ type: "string", format: "binary" }) } } },
  },
  responses: {
    201: { description: "Uploaded", content: { "application/json": { schema: z.object({ data: FileRow }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/storage/{key}",
  tags,
  summary: "Download or transform an object",
  description: "Streams the object bytes. Supports `?token=` signed bypass and image transform params (`width,height,quality,fit,format,focal`).",
  security: SECURITY,
  request: {
    params: z.object({ key: z.string() }),
    query: z.object({
      token: z.string().optional(),
      width: z.coerce.number().int().min(1).max(4096).optional(),
      height: z.coerce.number().int().min(1).max(4096).optional(),
      quality: z.coerce.number().int().min(1).max(100).optional(),
      fit: z.enum(["cover", "contain"]).optional(),
      format: z.enum(["webp", "jpeg", "png", "avif"]).optional(),
      focal: z.string().optional().openapi({ description: "`x,y` (0–100 each)." }),
    }),
  },
  responses: {
    200: { description: "Object bytes", content: { "application/octet-stream": { schema: z.string().openapi({ type: "string", format: "binary" }) } } },
    304: { description: "Not modified (ETag matched)." },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/storage/{key}/sign",
  tags,
  summary: "Issue a signed URL",
  description: "Generates a short-lived signed URL that bypasses session auth.",
  security: SECURITY,
  request: {
    params: z.object({ key: z.string() }),
    body: { required: false, content: { "application/json": { schema: SignInput } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SignResponse } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/storage/{key}",
  tags,
  summary: "Delete an object",
  security: SECURITY,
  request: { params: z.object({ key: z.string() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/storage/{key}",
  tags,
  summary: "Update file ACL/folder/metadata",
  security: SECURITY,
  request: {
    params: z.object({ key: z.string() }),
    body: { required: true, content: { "application/json": { schema: PatchInput } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }) } } },
    ...errorResponses,
  },
});

export const _StorageFileRow = FileRow;
export const _StoragePatchInput = PatchInput;
export const _StorageAppErrorSchema = AppErrorSchema;
