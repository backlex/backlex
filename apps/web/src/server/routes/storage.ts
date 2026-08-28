import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, count, eq, gt, inArray, isNull, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { requirePermission } from "../middleware/permission";
import { logActivity } from "../services/activity";
import { signStorageUrl, verifyStorageUrl } from "../lib/crypto";
import { parsePagination } from "../lib/pagination";
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
import { isPrivateHost, fetchNoSSRF } from "../services/storage/hosts";
import {
  IMPORT_TIMEOUT_MS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_KEY_LENGTH,
} from "../services/storage/constants";
import {
  BackfillResponse,
  SplitBucketsInput,
  SplitBucketsResponse,
  FileListMeta,
  FileRowSchema,
  FolderCounts,
  FromUrlInput,
  PatchInput,
  SignInput,
  SignResponse,
  tags,
} from "../services/storage/schemas";
import { serveObject } from "../services/storage/serve";
import { baseContentType } from "../services/storage/content-type";
import {
  deleteFileScoped,
  listFilesScoped,
  patchFileScoped,
  aclForKey,
} from "../services/storage/files";
import {
  bucketFor,
  dropStaleCopy,
  hasSplitBuckets,
  moveBetweenBuckets,
} from "../services/storage/bucket-for";
import { FILES_COLLECTION } from "../services/storage/constants";
import { assertStorageWithinLimit } from "../services/usage";
import { defaultHook } from "../lib/openapi-router";
import { readJsonOr } from "../lib/body";

export { FILES_COLLECTION };

const filesCollection = () => FILES_COLLECTION;

// NOTE: storage uses Hono catch-all syntax (`/:key{.+}`) so keys with slashes
// like `photos/2024/spring/beach.jpg` route correctly. OpenAPI can't represent
// slash-containing path params, so the documented path uses `/{key}` (single
// segment) while the underlying Hono router still accepts slashes via the
// `.put()/.get()/.delete()/.patch()` calls below. See the per-route docs.

export const storageRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
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
      const { limit, offset } = parsePagination(c);
      const result = await listFilesScoped(ctx, {
        tenantId,
        prefix: c.req.query("prefix") ?? "",
        folderId: c.req.query("folderId"),
        search: c.req.query("search") ?? "",
        limit,
        offset,
        permWhere: perm.whereSql,
      });
      return c.json(result);
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
   * Move existing public objects into the public bucket, a page at a time.
   *
   * The split is opt-in and arrives after the objects do, so turning it on
   * leaves every `acl: "public"` file sitting in the private bucket, where the
   * CDN path cannot reach it. This walks them across.
   *
   * Deliberately NOT shaped like `_backfill-folders` above, which sweeps a
   * whole tenant in one unbounded synchronous pass. That is survivable for a
   * column update; this one copies BYTES, and a workspace with fifty thousand
   * objects would exhaust the runtime on the first call. So it takes the shape
   * `phone.ts`'s normalizer uses: a `files.key` cursor, a small page, and a dry
   * run — because the first thing anyone sensibly does before moving data is
   * ask what would move.
   *
   * Admin-only, like the folder backfill, because it touches every user's rows.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/_split-buckets",
      tags,
      summary: "Move public objects into the public bucket (admin)",
      description:
        "Walks this workspace's files in key order and moves each `acl: \"public\"` object into the public bucket, page by page. Copy-then-delete, so an interrupted run leaves a duplicate rather than a gap and re-running tidies it. Requires a public bucket to be configured (`R2_PUBLIC` / `S3_PUBLIC_BUCKET`); without one there is nowhere to move to and the call is refused.",
      security: SECURITY,
      middleware: [requirePermission(filesCollection, "update")],
      request: {
        body: {
          content: { "application/json": { schema: SplitBucketsInput } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: SplitBucketsResponse } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenantId(auth);
      if (!auth.roles?.includes("admin")) {
        throw new AppError("FORBIDDEN", "Admin role required to move objects between buckets");
      }
      if (!hasSplitBuckets(ctx)) {
        throw new AppError(
          "VALIDATION",
          "No public bucket is configured — bind R2_PUBLIC (Cloudflare) or set S3_PUBLIC_BUCKET before splitting. Without a second bucket there is nowhere to move to, and the r2.dev URL keeps exposing everything.",
        );
      }
      let body: { limit?: number; after?: string; dryRun?: boolean } = {};
      try {
        body = c.req.valid("json");
      } catch {
        body = {};
      }
      const batch = Math.min(Math.max(body.limit ?? 100, 1), 500);
      const dryRun = body.dryRun === true;

      const t = filesTable(ctx.dialect);
      const conds = [eq(t.tenantId, tenantId)];
      if (body.after) conds.push(gt(t.key, body.after));
      const rows = (await (ctx.db as any)
        .select({ key: t.key, acl: t.acl })
        .from(t)
        .where(and(...conds))
        .orderBy(t.key)
        .limit(batch)) as { key: string; acl: string | null }[];

      let moved = 0;
      let alreadySited = 0;
      const failedKeys: string[] = [];
      for (const row of rows) {
        const acl = (row.acl ?? "private") as "public" | "private";
        // Only public rows have anywhere to go: private is already the private
        // bucket's job, and every non-`files` writer (backups, documents,
        // avatars) never leaves it at all.
        if (acl !== "public") {
          alreadySited += 1;
          continue;
        }
        if (dryRun) {
          moved += 1;
          continue;
        }
        try {
          // `from: "private"` is the claim being repaired — the object is in
          // the private bucket precisely because it predates the split.
          const did = await moveBetweenBuckets(ctx, row.key, "private", "public");
          if (did) moved += 1;
          else alreadySited += 1;
        } catch (e) {
          // A missing source is the interesting failure: the row says the
          // object exists and it does not. Recorded by key rather than
          // aborting, so one broken row cannot stop the migration.
          if (failedKeys.length < 50) failedKeys.push(row.key);
          console.error(`[storage] split-buckets could not move "${row.key}"`, e);
        }
      }

      // A short page is the last page — same rule as every other cursor walk
      // in this repo.
      const last = rows[rows.length - 1];
      const cursor = rows.length === batch && last ? last.key : null;
      const result = {
        scanned: rows.length,
        moved,
        alreadySited,
        failed: failedKeys.length,
        failedKeys,
        cursor,
        dryRun,
      };
      if (!dryRun && moved > 0) {
        await logActivity(c, {
          action: "update",
          collection: FILES_COLLECTION,
          itemId: "__split_buckets__",
          payload: { moved, failed: failedKeys.length, cursor },
          response: { ok: true },
        });
      }
      return c.json(result);
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
        // fetchNoSSRF follows redirects MANUALLY and re-validates every hop, so
        // a 30x into 169.254.169.254 / localhost can't bypass the host guard
        // above (which only sees the initial URL).
        resp = await fetchNoSSRF(body.url, {
          signal: controller.signal,
          headers: { "user-agent": "backlex-storage-import/1.0" },
        });
      } catch (e) {
        if (e instanceof AppError) {
          clearTimeout(timer);
          throw e;
        }
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
      await assertStorageWithinLimit(
        ctx,
        ctx.env,
        tenantId,
        Number(contentLengthHeader ?? 0) || 0,
      );
      const t = filesTable(ctx.dialect);
      const aclValue = body.acl === "public" ? "public" : "private";
      // `/from-url` is the one write path that DOES set an ACL, so it decides
      // the bucket outright. It also resets the ACL on re-import, which can
      // flip an existing object's side — `dropStaleCopy` removes whatever the
      // other bucket still holds under this key, so a re-import to `private`
      // cannot leave the old public copy fetchable.
      const obj = await bucketFor(ctx, aclValue).put({
        key,
        body: resp.body,
        contentType,
      });
      await dropStaleCopy(ctx, key, aclValue);
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
    const body = (await readJsonOr(c.req, {})) as { ttlSeconds?: number };
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
    // Normalized: parameters stripped so the serve-path guard cannot be
    // side-stepped with `text/html ;x=1`. See services/storage/content-type.ts.
    const contentType =
      baseContentType(c.req.header("content-type")) || undefined;
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
    // Hard storage cap (#12). Content-Length is advisory (absent on chunked
    // bodies) — the post-upload `files` row still records the true size, so
    // an under-declared body only overshoots by one file.
    await assertStorageWithinLimit(
      ctx,
      ctx.env,
      tenantId,
      Number(c.req.header("content-length") ?? 0) || 0,
    );
    const t = filesTable(ctx.dialect);
    // A PUT cannot set the ACL — but it CAN overwrite a row that already has
    // one, and when public objects live in their own bucket the new bytes have
    // to land where the row says they are. Writing them to the private bucket
    // while the row still says `public` would leave the old copy serving from
    // the CDN forever, with no error anywhere. One SELECT on a path that is
    // already doing an upsert.
    // Keyed on the EXACT key about to be written, not on the candidate set a
    // read would match — see `aclForKey`. Routing an upload by a legacy
    // un-prefixed row's ACL would put private bytes in the public bucket.
    const priorAcl = await aclForKey(ctx, key);
    const obj = await bucketFor(ctx, priorAcl).put({ key, body, contentType });
    await (ctx.db as any)
      .insert(t)
      .values({
        key,
        folderId,
        ownerId: auth.userId,
        tenantId,
        size: obj.size,
        contentType: obj.contentType ?? null,
        // Stated, not left to the column default, so the row can never disagree
        // with the bucket the bytes actually went into. On the insert path this
        // IS the default (`private`); on the conflict path it restates what the
        // row already said. Either way the two are written from one value.
        acl: priorAcl ?? "private",
      })
      .onConflictDoUpdate({
        target: t.key,
        set: {
          folderId,
          ownerId: auth.userId,
          tenantId,
          size: obj.size,
          contentType: obj.contentType ?? null,
          acl: priorAcl ?? "private",
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
    await deleteFileScoped(ctx, { tenantId, logicalKey, permWhere: perm.whereSql });
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
    const body = (await readJsonOr(c.req, {})) as {
      acl?: "public" | "private";
      folderId?: string | null;
      /** Free-form bag for display name, description, tags[], author,
       *  location, etc. Merged onto the existing row — keys explicitly set
       *  to `null` are removed so the UI can clear a field. */
      metadata?: Record<string, unknown> | null;
    };
    const data = await patchFileScoped(ctx, {
      tenantId,
      logicalKey,
      permWhere: perm.whereSql,
      patch: body,
    });
    const { key: _key, ...patch } = data;
    const updateResponse = { ok: true, data };
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
  // Sentinel-PREFIX form, matching the handler above. The suffix form
  // (`/{key}/sign`) is what this registration and docs/storage.md used to
  // advertise, and it 404s — anyone following the generated spec got a dead
  // endpoint while the MCP tool, which had it right, worked.
  path: "/api/storage/_sign/{key}",
  tags,
  summary: "Issue a signed URL",
  description:
    "Generates a short-lived signed URL that bypasses session auth. The `{key}` path param may contain `/` (catch-all), so it is the LAST segment: `POST /api/storage/_sign/invoices/2026/q1.pdf`.",
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
