import { Hono, type MiddlewareHandler } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { requirePermission } from "../middleware/permission";
import { parsePagination } from "../lib/pagination";
import {
  guardLogicalKey,
  physicalKey,
  requireTenantId,
} from "../services/storage/keys";
import {
  findOrCreateFolderByName,
  folderNameFromKey,
} from "../services/storage/folders";
import {
  abortUpload,
  appendChunk,
  createUpload,
  getUpload,
  listUploads,
  uploadPolicy,
  type UploadRow,
  type UploadStatus,
} from "../services/uploads";
import { FILES_COLLECTION } from "./storage";

export const TUS_VERSION = "1.0.0";
const TUS_EXTENSIONS = "creation,creation-with-upload,termination,expiration";
const OFFSET_OCTET = "application/offset+octet-stream";

const filesCollection = () => FILES_COLLECTION;

/**
 * Sets the TUS discovery headers on every `/api/uploads*` response. Registered
 * **before** the global CORS middleware so that — because Hono's `cors()`
 * short-circuits OPTIONS using the already-accumulated `c.res.headers` — an
 * `OPTIONS` capability probe still comes back carrying `Tus-Version`,
 * `Tus-Extension`, and `Tus-Max-Size`. Non-OPTIONS requests fall through to the
 * route handlers, which add their own `Upload-Offset` etc.
 */
export const tusBaseHeaders =
  (maxBytes: number): MiddlewareHandler<AppBindings> =>
  async (c, next) => {
    c.header("Tus-Resumable", TUS_VERSION);
    if (c.req.method === "OPTIONS") {
      c.header("Tus-Version", TUS_VERSION);
      c.header("Tus-Extension", TUS_EXTENSIONS);
      c.header("Tus-Max-Size", String(maxBytes));
    }
    await next();
  };

/** Decode a TUS `Upload-Metadata` header (`name b64value,flag,…`) into a bag. */
const parseUploadMetadata = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(" ");
    if (sp === -1) {
      out[trimmed] = "";
      continue;
    }
    const name = trimmed.slice(0, sp);
    const b64 = trimmed.slice(sp + 1).trim();
    try {
      out[name] = new TextDecoder().decode(
        Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)),
      );
    } catch {
      out[name] = "";
    }
  }
  return out;
};

const parseIntHeader = (raw: string | undefined): number | null => {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** JSON view of an upload session for the management API (no internal part etags). */
const toView = (u: UploadRow) => ({
  id: u.id,
  key: u.key,
  size: u.size,
  offset: u.offset,
  status: u.status,
  contentType: u.contentType,
  folderId: u.folderId,
  parts: u.parts.length,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
  expiresAt: u.expiresAt,
});

export const uploadsRoutes = new Hono<AppBindings>()
  // Creation. `Upload-Length` + `Upload-Metadata` (filename/key, contentType,
  // folderId). Optionally accepts an inline first chunk (creation-with-upload).
  .post("/", requirePermission(filesCollection, "create"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenantId(auth);
    const policy = uploadPolicy(ctx.env);

    const size = parseIntHeader(c.req.header("upload-length"));
    if (size == null) {
      throw new AppError("BAD_REQUEST", "Upload-Length header is required");
    }
    if (size > policy.maxBytes) {
      return c.body(null, 413, { "Tus-Resumable": TUS_VERSION });
    }

    const meta = parseUploadMetadata(c.req.header("upload-metadata"));
    const logicalKey = (meta.key || meta.filename || "").trim();
    if (!logicalKey) {
      throw new AppError(
        "BAD_REQUEST",
        "Upload-Metadata must include a 'filename' or 'key'",
      );
    }
    guardLogicalKey(logicalKey);
    const contentType = meta.contentType || meta.filetype || meta.type || undefined;

    let folderId: string | null;
    const folderMeta = meta.folderId ?? null;
    if (folderMeta === "__root__") {
      folderId = null;
    } else if (folderMeta) {
      folderId = folderMeta;
    } else {
      const inferred = folderNameFromKey(logicalKey);
      folderId = inferred
        ? await findOrCreateFolderByName(ctx, tenantId, inferred, auth.userId)
        : null;
    }

    const physical = physicalKey(tenantId, logicalKey);
    const upload = await createUpload(
      ctx,
      {
        tenantId,
        key: logicalKey,
        physicalKey: physical,
        size,
        contentType,
        folderId,
        ownerId: auth.userId,
        metadata: meta,
      },
      policy,
    );

    // creation-with-upload: an inline body finalizes-or-advances in one round-trip.
    let offset = 0;
    if (c.req.header("content-type")?.startsWith(OFFSET_OCTET)) {
      const buf = new Uint8Array(await c.req.arrayBuffer());
      if (buf.byteLength > 0) {
        const res = await appendChunk(ctx, upload.id, 0, buf, tenantId);
        offset = res.offset;
      }
    }

    c.header("Location", `/api/uploads/${upload.id}`);
    c.header("Upload-Offset", String(offset));
    c.header("Tus-Resumable", TUS_VERSION);
    return c.body(null, 201);
  })
  // JSON management list (admin UI + MCP). Filter by `status`.
  .get("/", requirePermission(filesCollection, "read"), async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenantId(c.get("auth"));
    const status = c.req.query("status") as UploadStatus | undefined;
    const { limit } = parsePagination(c, { defaultLimit: 100 });
    const rows = await listUploads(ctx, { tenantId, status, limit });
    return c.json({ uploads: rows.map(toView) });
  })
  // HEAD = TUS offset probe (clients HEAD before resuming); GET = JSON
  // management view (admin UI + MCP). Registered together so Hono's auto-HEAD
  // (which derives HEAD from a GET handler) can't shadow the protocol HEAD.
  .on(["HEAD", "GET"], "/:id", requirePermission(filesCollection, "read"), async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenantId(c.get("auth"));
    const upload = await getUpload(ctx, c.req.param("id"), tenantId);
    if (c.req.method === "HEAD") {
      // A terminated session is gone as far as the TUS protocol is concerned.
      if (!upload || upload.status === "aborted") {
        throw new AppError("NOT_FOUND", "Upload session not found");
      }
      c.header("Upload-Offset", String(upload.offset));
      c.header("Upload-Length", String(upload.size));
      c.header("Cache-Control", "no-store");
      c.header("Tus-Resumable", TUS_VERSION);
      return c.body(null, 200);
    }
    if (!upload) throw new AppError("NOT_FOUND", "Upload session not found");
    return c.json(toView(upload));
  })
  // Append one chunk at `Upload-Offset`. Finalizes when the offset hits the
  // declared length (a `files` row is written by the service).
  .patch("/:id", requirePermission(filesCollection, "create"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenantId(auth);
    if (!c.req.header("content-type")?.startsWith(OFFSET_OCTET)) {
      return c.body(null, 415, { "Tus-Resumable": TUS_VERSION });
    }
    const offset = parseIntHeader(c.req.header("upload-offset"));
    if (offset == null) {
      throw new AppError("BAD_REQUEST", "Upload-Offset header is required");
    }
    const buf = new Uint8Array(await c.req.arrayBuffer());
    const res = await appendChunk(ctx, c.req.param("id"), offset, buf, tenantId);
    c.header("Upload-Offset", String(res.offset));
    c.header("Tus-Resumable", TUS_VERSION);
    return c.body(null, 204);
  })
  // Termination — discard an in-progress (or finished) session.
  .delete("/:id", requirePermission(filesCollection, "delete"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenantId(auth);
    const upload = await getUpload(ctx, c.req.param("id"), tenantId);
    if (!upload) throw new AppError("NOT_FOUND", "Upload session not found");
    await abortUpload(ctx, upload.id, tenantId);
    c.header("Tus-Resumable", TUS_VERSION);
    return c.body(null, 204);
  });
