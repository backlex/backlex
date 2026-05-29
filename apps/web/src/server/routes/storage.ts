import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { requirePermission } from "../middleware/permission";
import { logActivity } from "../services/activity";
import { signStorageUrl, verifyStorageUrl } from "../lib/crypto";
import { SECURITY, OkSchema, errorResponses, apiRegistry } from "../lib/openapi";
import {
  guardLogicalKey,
  keyCandidates,
  physicalKey,
  requireTenantId,
  stripTenantPrefix,
} from "../services/storage/keys";
import {
  filesTable,
  findOrCreateFolderByName,
  folderNameFromKey,
  foldersTable,
} from "../services/storage/folders";
import { isPrivateHost } from "../services/storage/hosts";
import {
  IMPORT_TIMEOUT_MS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_KEY_LENGTH,
} from "../services/storage/constants";
import {
  BackfillResponse,
  FileListMeta,
  FileRowSchema,
  FolderCounts,
  FromUrlInput,
  PatchInput,
  SignInput,
  SignResponse,
  tags,
  type FileRow,
} from "../services/storage/schemas";
import { serveObject } from "../services/storage/serve";

export const FILES_COLLECTION = "system_files";

const filesCollection = () => FILES_COLLECTION;

// NOTE: storage uses Hono catch-all syntax (`/:key{.+}`) so keys with slashes
// like `photos/2024/spring/beach.jpg` route correctly. OpenAPI can't represent
// slash-containing path params, so the documented path uses `/{key}` (single
// segment) while the underlying Hono router still accepts slashes via the
// `.put()/.get()/.delete()/.patch()` calls below. See the per-route docs.

export const storageRoutes = new OpenAPIHono<AppBindings>()
  /**
   * Paginated listing for this tenant. Defaults are friendly to the admin
   * UI; the response stays the same shape (`{ data, meta }`) for clients
   * that didn't ask for pagination — `meta.total` lets them tell whether
   * there's more.
   */
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List files",
      description:
        "Paginated listing for the active workspace. Supports prefix, folder, and substring search filters.",
      security: SECURITY,
      middleware: [requirePermission(filesCollection, "read")],
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
              schema: z.object({ data: z.array(FileRowSchema), meta: FileListMeta }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const tenantId = requireTenantId(auth);
      const t = filesTable(ctx.dialect);
      const prefix = c.req.query("prefix") ?? "";
      const physicalPrefix = physicalKey(tenantId, prefix);
      const folderId = c.req.query("folderId");
      const search = (c.req.query("search") ?? "").trim();
      const rawLimit = Number(c.req.query("limit") ?? 50);
      const rawOffset = Number(c.req.query("offset") ?? 0);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(200, Math.floor(rawLimit)))
        : 50;
      const offset = Number.isFinite(rawOffset)
        ? Math.max(0, Math.floor(rawOffset))
        : 0;

      const conds: SQL[] = [eq(t.tenantId, tenantId)];
      // The key-prefix filter is purely organizational: only enforced when
      // the caller is browsing into a sub-path. Tenant isolation is already
      // handled by `tenant_id = ?`, and legacy rows (uploaded before the
      // `tenants/<tid>/` physical prefix was introduced) would otherwise
      // never show up in the list.
      if (prefix) {
        conds.push(sql`${sql.identifier("key")} LIKE ${`${physicalPrefix}%`}`);
      }
      if (folderId === "__root__") conds.push(isNull(t.folderId));
      else if (folderId) conds.push(eq(t.folderId, folderId));
      if (search) {
        // Substring match — tolerant of legacy rows without the
        // `tenants/<tid>/` physical prefix. SQLite LIKE is case-insensitive
        // for ASCII; Postgres uses ILIKE for portability.
        const esc = search.replace(/[\\%_]/g, (m) => `\\${m}`);
        const pattern = `%${esc}%`;
        conds.push(
          ctx.dialect === "pg"
            ? sql`${sql.identifier("key")} ILIKE ${pattern} ESCAPE '\\'`
            : sql`${sql.identifier("key")} LIKE ${pattern} ESCAPE '\\'`,
        );
      }
      if (perm.whereSql) conds.push(perm.whereSql);

      const where = and(...conds);
      const [rows, totalRows] = await Promise.all([
        (ctx.db as any)
          .select()
          .from(t)
          .where(where)
          .orderBy(desc(t.createdAt))
          .limit(limit)
          .offset(offset) as Promise<FileRow[]>,
        (ctx.db as any)
          .select({ value: count() })
          .from(t)
          .where(where) as Promise<{ value: number }[]>,
      ]);
      const total = Number(totalRows[0]?.value ?? 0);

      return c.json({
        data: rows.map((r) => ({
          key: stripTenantPrefix(tenantId, r.key),
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
        meta: { total, limit, offset },
      });
    },
  )
  /**
   * Aggregate count per folder for the sidebar badge. One DB round-trip
   * replaces the client's O(files × depth) per-render computation.
   */
  .openapi(
    createRoute({
      method: "get",
      path: "/folder-counts",
      tags,
      summary: "Aggregate file counts per folder",
      security: SECURITY,
      middleware: [requirePermission(filesCollection, "read")],
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: FolderCounts } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const perm = c.get("permission");
      const tenantId = requireTenantId(auth);
      const t = filesTable(ctx.dialect);

      const conds: SQL[] = [eq(t.tenantId, tenantId)];
      if (perm.whereSql) conds.push(perm.whereSql);

      const rows = (await (ctx.db as any)
        .select({ folderId: t.folderId, value: count() })
        .from(t)
        .where(and(...conds))
        .groupBy(t.folderId)) as { folderId: string | null; value: number }[];

      let root = 0;
      const byFolderId: Record<string, number> = {};
      let total = 0;
      for (const r of rows) {
        const n = Number(r.value);
        total += n;
        if (r.folderId === null) root = n;
        else byFolderId[r.folderId] = n;
      }
      return c.json({ root, byFolderId, total });
    },
  )
  /**
   * One-shot migration: walks every file in the current tenant whose
   * `folder_id` is NULL and derives a folder from the key path, creating
   * the matching folder row (find-or-create) and pinning the file to it.
   * Idempotent — running it again after new uploads only touches rows the
   * upload route hasn't already attached. Admin-only because it can mass-
   * modify other users' rows.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/_backfill-folders",
      tags,
      summary: "Backfill folders from key paths (admin)",
      description:
        "Walks every NULL-folder file in the active tenant, deriving a folder from the key path.",
      security: SECURITY,
      middleware: [requirePermission(filesCollection, "update")],
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: BackfillResponse } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenantId(auth);
      if (!auth.roles?.includes("admin")) {
        throw new AppError("FORBIDDEN", "Admin role required to run backfill");
      }
      const t = filesTable(ctx.dialect);
      const rows = (await (ctx.db as any)
        .select({ key: t.key })
        .from(t)
        .where(and(eq(t.tenantId, tenantId), isNull(t.folderId)))) as { key: string }[];

      const scanned = rows.length;
      let updated = 0;
      let foldersCreatedBefore = 0;
      let foldersCreatedAfter = 0;
      if (rows.length > 0) {
        const foldersT = foldersTable(ctx.dialect);
        const beforeCount = (await (ctx.db as any)
          .select({ value: count() })
          .from(foldersT)
          .where(eq(foldersT.tenantId, tenantId))) as { value: number }[];
        foldersCreatedBefore = Number(beforeCount[0]?.value ?? 0);

        for (const row of rows) {
          const logical = stripTenantPrefix(tenantId, row.key);
          const inferred = folderNameFromKey(logical);
          if (!inferred) continue;
          const fid = await findOrCreateFolderByName(ctx, tenantId, inferred, auth.userId);
          await (ctx.db as any)
            .update(t)
            .set({ folderId: fid })
            .where(and(eq(t.key, row.key), eq(t.tenantId, tenantId)));
          updated++;
        }

        const afterCount = (await (ctx.db as any)
          .select({ value: count() })
          .from(foldersT)
          .where(eq(foldersT.tenantId, tenantId))) as { value: number }[];
        foldersCreatedAfter = Number(afterCount[0]?.value ?? 0);
      }
      return c.json({
        scanned,
        filesUpdated: updated,
        foldersCreated: foldersCreatedAfter - foldersCreatedBefore,
      });
    },
  )
  /**
   * Server-side import: pull an HTTP(S) URL into storage. Avoids the CORS
   * tax of a client-side fetch + PUT — the Worker fetches the source
   * directly. Useful for migrating remote assets, OG-image scrapes,
   * arXiv PDF copies, etc.
   *
   * Caps: 100 MB body, 30 s connect+read timeout. Errors surface as
   * AppError VALIDATION/BAD_REQUEST so the UI can show the reason.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/from-url",
      tags,
      summary: "Import a remote URL into storage",
      description: "Server-side fetch + store. SSRF-guarded; 100 MB cap; 30 s timeout.",
      security: SECURITY,
      middleware: [requirePermission(filesCollection, "create")],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: FromUrlInput } },
        },
      },
      responses: {
        201: {
          description: "Imported",
          content: {
            "application/json": {
              schema: z.any(),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenantId(auth);
      const body = c.req.valid("json");
      if (!body.url || typeof body.url !== "string") {
        throw new AppError("VALIDATION", "url is required");
      }

      let parsed: URL;
      try { parsed = new URL(body.url); } catch {
        throw new AppError("VALIDATION", "url must be a valid URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new AppError("VALIDATION", "url must use http or https");
      }
      if (isPrivateHost(parsed.hostname)) {
        throw new AppError("VALIDATION", "url points to a private/internal host");
      }

      // Derive logical key
      let logicalKey = (body.key ?? "").trim();
      if (!logicalKey) {
        const pathParts = parsed.pathname.split("/").filter(Boolean);
        logicalKey = pathParts[pathParts.length - 1] ?? "";
        // Decode percent-escapes (URL paths often carry them) but keep slashes.
        try { logicalKey = decodeURIComponent(logicalKey); } catch { /* leave as-is */ }
        if (!logicalKey) logicalKey = `import-${Date.now()}`;
      }
      if (logicalKey.length > MAX_IMPORT_KEY_LENGTH) {
        throw new AppError("VALIDATION", `derived key longer than ${MAX_IMPORT_KEY_LENGTH} chars; pass an explicit \`key\``);
      }
      guardLogicalKey(logicalKey);

      // Fetch with bounded timeout. Workers + Bun both honor AbortSignal here.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(body.url, {
          signal: controller.signal,
          redirect: "follow",
          headers: { "user-agent": "workeros-storage-import/1.0" },
        });
      } catch (e) {
        clearTimeout(timer);
        throw new AppError("BAD_REQUEST", `fetch failed: ${(e as Error).message}`);
      }
      clearTimeout(timer);
      if (!resp.ok) {
        throw new AppError("BAD_REQUEST", `source returned HTTP ${resp.status}`);
      }
      const contentTypeHeader = resp.headers.get("content-type") ?? "";
      const contentType = contentTypeHeader.split(";")[0]?.trim() || undefined;
      const contentLengthHeader = resp.headers.get("content-length");
      if (contentLengthHeader && Number(contentLengthHeader) > MAX_IMPORT_BYTES) {
        throw new AppError("VALIDATION", `source body advertises ${contentLengthHeader} bytes; cap is ${MAX_IMPORT_BYTES}`);
      }
      if (!resp.body) throw new AppError("BAD_REQUEST", "source returned no body");

      // Auto folder from key path — same rule as PUT.
      const folderIdQuery = body.folderId;
      let folderId: string | null;
      if (folderIdQuery === "__root__" || folderIdQuery === null) {
        folderId = null;
      } else if (typeof folderIdQuery === "string" && folderIdQuery !== "") {
        folderId = folderIdQuery;
      } else {
        const inferredName = folderNameFromKey(logicalKey);
        folderId = inferredName
          ? await findOrCreateFolderByName(ctx, tenantId, inferredName, auth.userId)
          : null;
      }

      const key = physicalKey(tenantId, logicalKey);
      const obj = await ctx.storage.put({ key, body: resp.body, contentType });
      const t = filesTable(ctx.dialect);
      const aclValue = body.acl === "public" ? "public" : "private";
      await (ctx.db as any)
        .insert(t)
        .values({
          key,
          folderId,
          ownerId: auth.userId,
          tenantId,
          size: obj.size,
          contentType: obj.contentType ?? null,
          acl: aclValue,
        })
        .onConflictDoUpdate({
          target: t.key,
          set: {
            folderId,
            ownerId: auth.userId,
            tenantId,
            size: obj.size,
            contentType: obj.contentType ?? null,
            acl: aclValue,
          },
        });
      const uploaded = {
        ...obj,
        key: logicalKey,
        folderId,
        ownerId: auth.userId,
        acl: aclValue,
        sourceUrl: body.url,
      };
      await logActivity(c, {
        action: "upload",
        collection: FILES_COLLECTION,
        itemId: logicalKey,
        payload: { sourceUrl: body.url, size: obj.size, contentType: obj.contentType, folderId, acl: aclValue },
        response: { data: uploaded },
      });
      return c.json({ data: uploaded }, 201);
    },
  )
  // The PUT / GET / DELETE / PATCH endpoints below carry catch-all keys
  // (`/:key{.+}`) so logical paths like `photos/2024/spring/beach.jpg`
  // route correctly. `@hono/zod-openapi`'s `createRoute({ path })` converts
  // `/{name}` → `/:name` for Hono and cannot express a multi-segment param —
  // so we register these directly on the underlying Hono router and document
  // them via `apiRegistry` in the legacy sibling pattern (which we keep for
  // these handlers only). The OpenAPI surface still covers them through the
  // metadata loader.
  //
  // The signed-URL endpoint lives under a SENTINEL PREFIX
  // (`POST /_sign/:key{.+}`) instead of the natural suffix form
  // (`POST /:key{.+}/sign`). `@hono/zod-openapi`'s router silently falls
  // back to a greedy matcher when a literal-suffix catch-all is registered
  // alongside sibling `/:key{.+}` catch-alls — the suffix route then misses
  // on 3+ segment keys (`a/b/c.txt/sign` → 404) even though plain Hono
  // handles it fine. The prefix form has no such ambiguity. See
  // `tests/storage-sign.test.ts` for the regression that locks this in.
  .post("/_sign/:key{.+}", requirePermission(filesCollection, "read"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const tenantId = requireTenantId(auth);
    const logicalKey = c.req.param("key");
    guardLogicalKey(logicalKey);
    const body = (await c.req.json().catch(() => ({}))) as { ttlSeconds?: number };
    const ttl = Math.max(60, Math.min(86400, body.ttlSeconds ?? 3600));

    // Confirm the object exists *and* is visible to this caller (the
    // permission middleware only proved they have `read`; the row-level
    // condition is enforced here so a scoped role can't sign a sibling row).
    const t = filesTable(ctx.dialect);
    const conds: SQL[] = [
      inArray(t.key, keyCandidates(tenantId, logicalKey)),
      eq(t.tenantId, tenantId),
    ];
    if (perm.whereSql) conds.push(perm.whereSql);
    const rows = (await (ctx.db as any)
      .select({ key: t.key })
      .from(t)
      .where(and(...conds))
      .limit(1)) as { key: string }[];
    if (!rows[0]) throw new AppError("NOT_FOUND", "Object not found");
    const matchedKey = rows[0].key;

    const exp = Math.floor(Date.now() / 1000) + ttl;
    const token = await signStorageUrl(
      { k: matchedKey, t: tenantId, exp },
      ctx.env.AUTH_SECRET,
    );
    return c.json({
      url: `/api/storage/${encodeURI(logicalKey)}?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  })
  .put("/:key{.+}", requirePermission(filesCollection, "create"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenantId(auth);
    const logicalKey = c.req.param("key");
    guardLogicalKey(logicalKey);
    const key = physicalKey(tenantId, logicalKey);
    const contentType = c.req.header("content-type") ?? undefined;
    // Auto-derive folder from the key path so an upload at
    // `photos/2024/spring/beach.jpg` lands in the matching folder row
    // (created on the fly when missing). An explicit `?folderId=` always
    // wins; `?folderId=__root__` opts out of auto-derive and forces null.
    const folderIdQuery = c.req.query("folderId") ?? null;
    let folderId: string | null;
    if (folderIdQuery === "__root__") {
      folderId = null;
    } else if (folderIdQuery) {
      folderId = folderIdQuery;
    } else {
      const inferredName = folderNameFromKey(logicalKey);
      folderId = inferredName
        ? await findOrCreateFolderByName(ctx, tenantId, inferredName, auth.userId)
        : null;
    }
    const body = c.req.raw.body;
    if (!body) throw new AppError("BAD_REQUEST", "Empty body");
    const obj = await ctx.storage.put({ key, body, contentType });
    const t = filesTable(ctx.dialect);
    await (ctx.db as any)
      .insert(t)
      .values({
        key,
        folderId,
        ownerId: auth.userId,
        tenantId,
        size: obj.size,
        contentType: obj.contentType ?? null,
      })
      .onConflictDoUpdate({
        target: t.key,
        set: {
          folderId,
          ownerId: auth.userId,
          tenantId,
          size: obj.size,
          contentType: obj.contentType ?? null,
        },
      });
    const uploaded = {
      ...obj,
      key: logicalKey,
      folderId,
      ownerId: auth.userId,
    };
    await logActivity(c, {
      action: "upload",
      collection: FILES_COLLECTION,
      itemId: logicalKey,
      payload: { size: obj.size, contentType: obj.contentType, folderId },
      response: { data: uploaded },
    });
    return c.json({ data: uploaded }, 201);
  })
  /**
   * Read an object.
   *
   * Two non-default behaviors share this handler:
   *
   * 1. `?token=…` — HMAC-signed bearer that bypasses session + permission
   *    when it validates against `AUTH_SECRET` and pins to this tenant+key.
   *    Lets the admin UI hand out short-lived links for download / sharing
   *    of private files without going through the cookie session.
   * 2. `?width=…&format=…&quality=…&fit=…&focal=…` — image transform. We
   *    run the bytes through `ctx.image` (Bun) or, on Workers, ask the
   *    edge to do it via `cf.image` when the file's ACL is public and
   *    `R2_PUBLIC_BASE` is set. Transform on a non-image throws 400.
   */
  .get("/:key{.+}", async (c, next) => {
    // Token-based bypass: validate before falling through to permission gate.
    const token = c.req.query("token");
    if (token) {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const logicalKey = c.req.param("key");
      guardLogicalKey(logicalKey);
      // We don't know the tenant yet (token bypass means we can be anonymous);
      // verify token first, then use its pinned tenantId.
      const payload = await verifyStorageUrl(token, ctx.env.AUTH_SECRET);
      if (!payload) throw new AppError("UNAUTHORIZED", "Invalid or expired token");
      // Tokens signed for legacy rows carry the bare key; modern tokens
      // carry the tenant-prefixed one. Accept either as long as it points
      // to the same logical key under the same tenant.
      const allowedKeys = keyCandidates(payload.t, logicalKey);
      if (!allowedKeys.includes(payload.k)) {
        throw new AppError("UNAUTHORIZED", "Token does not match this object");
      }
      // Pin the request to the token's tenant so the rest of the handler
      // can use the same code path as a cookie-session call.
      auth.tenantId = payload.t;
      return serveObject(c, payload.t, logicalKey, /* skipPermissionFilter */ true);
    }
    return next();
  }, requirePermission(filesCollection, "read"), async (c) => {
    const auth = c.get("auth");
    const tenantId = requireTenantId(auth);
    const logicalKey = c.req.param("key");
    guardLogicalKey(logicalKey);
    return serveObject(c, tenantId, logicalKey, /* skipPermissionFilter */ false);
  })
  // The signed-URL handler (`POST /:key{.+}/sign`) is registered ABOVE
  // the catch-all PUT for ordering reasons — see the comment block there.
  .delete("/:key{.+}", requirePermission(filesCollection, "delete"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const tenantId = requireTenantId(auth);
    const logicalKey = c.req.param("key");
    guardLogicalKey(logicalKey);
    const t = filesTable(ctx.dialect);

    const conds: SQL[] = [
      inArray(t.key, keyCandidates(tenantId, logicalKey)),
      eq(t.tenantId, tenantId),
    ];
    if (perm.whereSql) conds.push(perm.whereSql);
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
      .where(and(eq(t.key, matchedKey), eq(t.tenantId, tenantId)));
    await logActivity(c, {
      action: "delete",
      collection: FILES_COLLECTION,
      itemId: logicalKey,
      response: { ok: true },
    });
    return c.json({ ok: true });
  })
  /**
   * Toggle a file's ACL between public/private. Storage adapters that don't
   * track ACLs (fs/dev) ignore the bit; the row's `acl` column is the source
   * of truth for the API + UI either way.
   */
  .patch("/:key{.+}", requirePermission(filesCollection, "update"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const tenantId = requireTenantId(auth);
    const logicalKey = c.req.param("key");
    guardLogicalKey(logicalKey);
    const body = (await c.req.json().catch(() => ({}))) as {
      acl?: "public" | "private";
      folderId?: string | null;
      /** Free-form bag for display name, description, tags[], author,
       *  location, etc. Merged onto the existing row — keys explicitly set
       *  to `null` are removed so the UI can clear a field. */
      metadata?: Record<string, unknown> | null;
    };
    const t = filesTable(ctx.dialect);
    const conds: SQL[] = [
      inArray(t.key, keyCandidates(tenantId, logicalKey)),
      eq(t.tenantId, tenantId),
    ];
    if (perm.whereSql) conds.push(perm.whereSql);
    const existing = (await (ctx.db as any)
      .select({ key: t.key, metadata: t.metadata })
      .from(t)
      .where(and(...conds))
      .limit(1)) as { key: string; metadata: Record<string, unknown> | null }[];
    if (!existing[0]) throw new AppError("NOT_FOUND", "Object not found");
    const matchedKey = existing[0].key;

    const patch: Record<string, unknown> = {};
    if (body.acl) patch.acl = body.acl;
    if (body.folderId !== undefined) patch.folderId = body.folderId;
    if (body.metadata !== undefined) {
      // null = wipe everything; an object = merge (null leaves on keys remove them)
      if (body.metadata === null) {
        patch.metadata = null;
      } else {
        const merged: Record<string, unknown> = { ...(existing[0].metadata ?? {}) };
        for (const [k, v] of Object.entries(body.metadata)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        patch.metadata = Object.keys(merged).length > 0 ? merged : null;
      }
    }
    await (ctx.db as any)
      .update(t)
      .set(patch)
      .where(and(eq(t.key, matchedKey), eq(t.tenantId, tenantId)));
    const updateResponse = { ok: true, data: { key: logicalKey, ...patch } };
    await logActivity(c, {
      action: "update",
      collection: FILES_COLLECTION,
      itemId: logicalKey,
      payload: patch,
      response: updateResponse,
    });
    return c.json(updateResponse);
  });

// Inline OpenAPI metadata for the catch-all `/:key{.+}` routes that can't be
// expressed through `createRoute({ path: ... })`. Registered via the shared
// `apiRegistry` so they still appear in the generated spec — this is the only
// remaining use of the legacy registry pattern in this file.

apiRegistry.registerPath({
  method: "put",
  path: "/api/storage/{key}",
  tags,
  summary: "Upload an object",
  description:
    "Stream the request body to the storage adapter. The `{key}` path param may contain `/` (catch-all). Folder is auto-derived from the key path unless `?folderId=` is set.",
  security: SECURITY,
  request: {
    params: z.object({
      key: z.string().openapi({ description: "Logical key (may contain `/`)." }),
    }),
    query: z.object({
      folderId: z.string().optional().openapi({
        description: "Folder UUID, or `__root__` to opt out of auto-derive.",
      }),
    }),
    body: {
      required: true,
      content: {
        "application/octet-stream": {
          schema: z.string().openapi({ type: "string", format: "binary" }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Uploaded",
      content: { "application/json": { schema: z.object({ data: FileRowSchema }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/storage/{key}",
  tags,
  summary: "Download or transform an object",
  description:
    "Streams the object bytes. The `{key}` path param may contain `/` (catch-all). Supports `?token=` signed bypass and image transform params (`width,height,quality,fit,format,focal`).",
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
    200: {
      description: "Object bytes",
      content: {
        "application/octet-stream": {
          schema: z.string().openapi({ type: "string", format: "binary" }),
        },
      },
    },
    304: { description: "Not modified (ETag matched)." },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/storage/{key}/sign",
  tags,
  summary: "Issue a signed URL",
  description:
    "Generates a short-lived signed URL that bypasses session auth. The `{key}` path param may contain `/` (catch-all).",
  security: SECURITY,
  request: {
    params: z.object({ key: z.string() }),
    body: { required: false, content: { "application/json": { schema: SignInput } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: SignResponse } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/storage/{key}",
  tags,
  summary: "Delete an object",
  description: "The `{key}` path param may contain `/` (catch-all).",
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
  description: "The `{key}` path param may contain `/` (catch-all).",
  security: SECURITY,
  request: {
    params: z.object({ key: z.string() }),
    body: { required: true, content: { "application/json": { schema: PatchInput } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            data: z.record(z.string(), z.unknown()),
          }),
        },
      },
    },
    ...errorResponses,
  },
});
