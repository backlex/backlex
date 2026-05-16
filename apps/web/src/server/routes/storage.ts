import { Hono } from "hono";
import { and, count, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { AppError, type ImageTransform } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requirePermission } from "../middleware/permission";
import { logActivity } from "../services/activity";
import { signStorageUrl, verifyStorageUrl } from "../lib/crypto";
import { cfImageFromUrl, type CfImageTransform } from "../adapters/image.cf";

export const FILES_COLLECTION = "system_files";

/**
 * Reserved physical-key prefix that namespaces every uploaded object under
 * `tenants/<tenant-id>/`. Stored on disk + in `files.key`; never exposed to
 * API clients (we strip it on read and re-add it on write). Two tenants can
 * therefore reuse the same logical key (e.g. "logo.png") without colliding
 * either in the bucket or in the DB primary key.
 */
const TENANT_PREFIX = "tenants/";

const physicalKey = (tenantId: string, logical: string): string =>
  `${TENANT_PREFIX}${tenantId}/${logical}`;

const stripTenantPrefix = (tenantId: string, physical: string): string => {
  const prefix = `${TENANT_PREFIX}${tenantId}/`;
  return physical.startsWith(prefix) ? physical.slice(prefix.length) : physical;
};

const requireTenantId = (auth: { tenantId?: string | null }): string => {
  if (!auth.tenantId) {
    throw new AppError("VALIDATION", "Active tenant is required for storage operations");
  }
  return auth.tenantId;
};

const guardLogicalKey = (key: string) => {
  if (key.startsWith(TENANT_PREFIX)) {
    throw new AppError("VALIDATION", `Key prefix "${TENANT_PREFIX}" is reserved`);
  }
};

const filesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.files : sqlite.schema.files;

const filesCollection = () => FILES_COLLECTION;

interface FileRow {
  key: string;
  folderId: string | null;
  ownerId: string | null;
  acl: "public" | "private";
  size: number;
  contentType: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date | number;
}

// Only the values that work on BOTH transform backends without semantic
// drift: CF Image Resizing supports {cover, contain, scale-down, crop,
// pad}; Bun.Image's `fit` is {fill, inside}. `cover` and `contain` are
// the universally meaningful subset — anything else either errors at
// the edge (CF 9401) or maps to a different operation on Bun.
const FIT_VALUES = new Set(["cover", "contain"]);
const FORMAT_VALUES = new Set(["webp", "jpeg", "png", "avif"]);

interface ParsedTransform {
  transform: ImageTransform;
  focal?: { x: number; y: number };
  /** True when any transform-related query parameter was provided. */
  any: boolean;
}

/**
 * Validate the transform query string. Anything malformed throws VALIDATION
 * — silently dropping bad params would let `?width=abc` silently serve the
 * original at full quality, masking client bugs.
 */
const parseTransform = (q: Record<string, string | undefined>): ParsedTransform => {
  const out: ImageTransform = {};
  let any = false;
  let focal: { x: number; y: number } | undefined;

  const intInRange = (raw: string, name: string, min: number, max: number): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
      throw new AppError("VALIDATION", `${name} must be an integer between ${min} and ${max}`);
    }
    return n;
  };

  if (q.width !== undefined) { out.width = intInRange(q.width, "width", 1, 4096); any = true; }
  if (q.height !== undefined) { out.height = intInRange(q.height, "height", 1, 4096); any = true; }
  if (q.quality !== undefined) { out.quality = intInRange(q.quality, "quality", 1, 100); any = true; }
  if (q.fit !== undefined) {
    if (!FIT_VALUES.has(q.fit)) {
      throw new AppError("VALIDATION", `fit must be one of: ${[...FIT_VALUES].join(", ")}`);
    }
    out.fit = q.fit as ImageTransform["fit"];
    any = true;
  }
  if (q.format !== undefined) {
    if (!FORMAT_VALUES.has(q.format)) {
      throw new AppError("VALIDATION", `format must be one of: ${[...FORMAT_VALUES].join(", ")}`);
    }
    out.format = q.format as ImageTransform["format"];
    any = true;
  }
  if (q.focal !== undefined) {
    const m = q.focal.match(/^(\d{1,3}),(\d{1,3})$/);
    if (!m) throw new AppError("VALIDATION", `focal must be "x,y" with values 0–100`);
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (x < 0 || x > 100 || y < 0 || y > 100) {
      throw new AppError("VALIDATION", `focal x,y must be 0–100`);
    }
    focal = { x, y };
    any = true;
  }
  return { transform: out, focal, any };
};

const isImageContentType = (ct: string | null | undefined): boolean =>
  Boolean(ct && ct.startsWith("image/"));

/** Stable ETag derived from the physical key + transform query — different
 *  transforms get distinct cache entries automatically. */
const computeEtag = async (physical: string, queryString: string): Promise<string> => {
  const data = new TextEncoder().encode(`${physical}::${queryString}`);
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 12; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return `W/"${hex}"`;
};

/** Serialize a transform back to the canonical query string so the ETag is
 *  stable regardless of param order. */
const canonicalizeTransformQuery = (t: ImageTransform, focal?: { x: number; y: number }): string => {
  const parts: string[] = [];
  if (t.width !== undefined) parts.push(`width=${t.width}`);
  if (t.height !== undefined) parts.push(`height=${t.height}`);
  if (t.format !== undefined) parts.push(`format=${t.format}`);
  if (t.quality !== undefined) parts.push(`quality=${t.quality}`);
  if (t.fit !== undefined) parts.push(`fit=${t.fit}`);
  if (focal) parts.push(`focal=${focal.x},${focal.y}`);
  return parts.join("&");
};

const TRANSFORM_CACHE_HEADERS: Record<string, string> = {
  // Transforms are content-addressed by query, so we can cache aggressively.
  "cache-control": "public, max-age=31536000, immutable",
};

export const storageRoutes = new Hono<AppBindings>()
  /**
   * Paginated listing for this tenant. Defaults are friendly to the admin
   * UI; the response stays the same shape (`{ data, meta }`) for clients
   * that didn't ask for pagination — `meta.total` lets them tell whether
   * there's more.
   *
   * Query params:
   *   - prefix    Logical key prefix (e.g. "uploads/")
   *   - folderId  UUID of a folder to filter by, OR `"__root__"` to match
   *               only files with no folder. Composes with `prefix`.
   *   - search    Substring match on the logical key (case-insensitive
   *               via LIKE; escapes %_\\ in the user input).
   *   - limit     1–200, default 50
   *   - offset    ≥0, default 0
   */
  .get("/", requirePermission(filesCollection, "read"), async (c) => {
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

    const conds: SQL[] = [
      eq(t.tenantId, tenantId),
      sql`${sql.identifier("key")} LIKE ${`${physicalPrefix}%`}`,
    ];
    if (folderId === "__root__") conds.push(isNull(t.folderId));
    else if (folderId) conds.push(eq(t.folderId, folderId));
    if (search) {
      // Escape LIKE wildcards in user input, then anchor the match inside the
      // already-tenant-scoped key prefix. SQLite LIKE is case-insensitive for
      // ASCII; Postgres uses ILIKE for portability.
      const esc = search.replace(/[\\%_]/g, (m) => `\\${m}`);
      const pattern = `${physicalPrefix}%${esc}%`;
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
  })
  /**
   * Aggregate count per folder for the sidebar badge. One DB round-trip
   * replaces the client's O(files × depth) per-render computation. Returns
   * `{ root: number, byFolderId: { [id]: number }, total: number }`.
   */
  .get("/folder-counts", requirePermission(filesCollection, "read"), async (c) => {
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
  })
  .put("/:key{.+}", requirePermission(filesCollection, "create"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenantId(auth);
    const logicalKey = c.req.param("key");
    guardLogicalKey(logicalKey);
    const key = physicalKey(tenantId, logicalKey);
    const contentType = c.req.header("content-type") ?? undefined;
    const folderId = c.req.query("folderId") ?? null;
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
      const expectedKey = physicalKey(payload.t, logicalKey);
      if (payload.k !== expectedKey) {
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
  /**
   * Issue a short-lived signed URL for an object the caller can already
   * read. Useful for handing a private file off to an `<img>` tag or a
   * download anchor without exposing a session cookie. The URL is a normal
   * `GET /api/storage/:key?token=…`; the GET handler validates the token
   * before falling through to the permission middleware.
   */
  .post("/:key{.+}/sign", requirePermission(filesCollection, "read"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const tenantId = requireTenantId(auth);
    const logicalKey = c.req.param("key");
    guardLogicalKey(logicalKey);
    const key = physicalKey(tenantId, logicalKey);
    const body = (await c.req.json().catch(() => ({}))) as { ttlSeconds?: number };
    const ttl = Math.max(60, Math.min(86400, body.ttlSeconds ?? 3600));

    // Confirm the object exists *and* is visible to this caller (the
    // permission middleware only proved they have `read`; the row-level
    // condition is enforced here so a scoped role can't sign a sibling row).
    const t = filesTable(ctx.dialect);
    const conds: SQL[] = [eq(t.key, key), eq(t.tenantId, tenantId)];
    if (perm.whereSql) conds.push(perm.whereSql);
    const rows = (await (ctx.db as any)
      .select({ key: t.key })
      .from(t)
      .where(and(...conds))
      .limit(1)) as { key: string }[];
    if (!rows[0]) throw new AppError("NOT_FOUND", "Object not found");

    const exp = Math.floor(Date.now() / 1000) + ttl;
    const token = await signStorageUrl(
      { k: key, t: tenantId, exp },
      ctx.env.AUTH_SECRET,
    );
    return c.json({
      url: `/api/storage/${encodeURI(logicalKey)}?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  })
  .delete("/:key{.+}", requirePermission(filesCollection, "delete"), async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const tenantId = requireTenantId(auth);
    const logicalKey = c.req.param("key");
    guardLogicalKey(logicalKey);
    const key = physicalKey(tenantId, logicalKey);
    const t = filesTable(ctx.dialect);

    const conds: SQL[] = [eq(t.key, key), eq(t.tenantId, tenantId)];
    if (perm.whereSql) conds.push(perm.whereSql);
    const rows = (await (ctx.db as any)
      .select({ key: t.key })
      .from(t)
      .where(and(...conds))
      .limit(1)) as { key: string }[];
    if (!rows[0]) throw new AppError("NOT_FOUND", "Object not found");

    await ctx.storage.delete(key);
    await (ctx.db as any)
      .delete(t)
      .where(and(eq(t.key, key), eq(t.tenantId, tenantId)));
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
    const key = physicalKey(tenantId, logicalKey);
    const body = (await c.req.json().catch(() => ({}))) as {
      acl?: "public" | "private";
      folderId?: string | null;
      /** Free-form bag for display name, description, tags[], author,
       *  location, etc. Merged onto the existing row — keys explicitly set
       *  to `null` are removed so the UI can clear a field. */
      metadata?: Record<string, unknown> | null;
    };
    const t = filesTable(ctx.dialect);
    const conds: SQL[] = [eq(t.key, key), eq(t.tenantId, tenantId)];
    if (perm.whereSql) conds.push(perm.whereSql);
    const existing = (await (ctx.db as any)
      .select({ key: t.key, metadata: t.metadata })
      .from(t)
      .where(and(...conds))
      .limit(1)) as { key: string; metadata: Record<string, unknown> | null }[];
    if (!existing[0]) throw new AppError("NOT_FOUND", "Object not found");

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
      .where(and(eq(t.key, key), eq(t.tenantId, tenantId)));
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

/**
 * Shared GET handler — used by both the cookie/session path and the token
 * bypass path. `skipPermissionFilter` is true on the token path because the
 * token itself proved authorization for this exact (tenant, key).
 */
async function serveObject(
  c: import("hono").Context<AppBindings>,
  tenantId: string,
  logicalKey: string,
  skipPermissionFilter: boolean,
): Promise<Response> {
  const ctx = c.get("ctx");
  const perm = skipPermissionFilter ? null : c.get("permission");
  const key = physicalKey(tenantId, logicalKey);
  const t = filesTable(ctx.dialect);

  const conds: SQL[] = [eq(t.key, key), eq(t.tenantId, tenantId)];
  if (perm?.whereSql) conds.push(perm.whereSql);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(...conds))
    .limit(1)) as FileRow[];
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "Object not found");

  const parsed = parseTransform({
    width: c.req.query("width"),
    height: c.req.query("height"),
    quality: c.req.query("quality"),
    format: c.req.query("format"),
    fit: c.req.query("fit"),
    focal: c.req.query("focal"),
  });

  // Fast path — no transform requested, stream the raw object.
  if (!parsed.any) {
    const obj = await ctx.storage.get(key);
    if (!obj) throw new AppError("NOT_FOUND", "Object not found");
    return new Response(obj.body, {
      headers: {
        "content-type":
          obj.meta.contentType ?? row.contentType ?? "application/octet-stream",
        "content-length": String(obj.meta.size),
      },
    });
  }

  // Transform path — only meaningful on image content types.
  const ct = row.contentType;
  if (!isImageContentType(ct)) {
    throw new AppError(
      "VALIDATION",
      "Transform parameters only apply to image content types",
    );
  }

  const queryString = canonicalizeTransformQuery(parsed.transform, parsed.focal);
  const etag = await computeEtag(key, queryString);
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const isWorker = typeof (ctx.env as { R2?: unknown }).R2 !== "undefined";
  const publicBase = (ctx.env as { R2_PUBLIC_BASE?: string }).R2_PUBLIC_BASE;

  // Workers + public R2 origin: let the edge resize. Cheapest path — no
  // bytes through the Worker isolate. Requires the file to be reachable
  // publicly, which is only honest when the row's ACL is public.
  if (isWorker && publicBase && row.acl === "public") {
    const origin = publicBase.replace(/\/$/, "");
    const sourceUrl = `${origin}/${key}`;
    // CF Image Resizing wants a gravity object — focal x/y in 0..1.
    const cf: CfImageTransform = {
      ...parsed.transform,
      ...(parsed.focal
        ? { gravity: { x: parsed.focal.x / 100, y: parsed.focal.y / 100 } }
        : {}),
    };
    const resp = await cfImageFromUrl(sourceUrl, cf);
    const headers = new Headers(resp.headers);
    headers.set("etag", etag);
    for (const [k, v] of Object.entries(TRANSFORM_CACHE_HEADERS)) headers.set(k, v);
    return new Response(resp.body, { status: resp.status, headers });
  }

  // Bun / fs / passthrough — read the object and run it through ctx.image.
  // Workers without a public origin would fall here, but ctx.image is the
  // passthrough adapter (no Bun.Image), so transforms are a no-op. We'd
  // rather surface that than silently lie.
  if (isWorker && !publicBase) {
    throw new AppError(
      "VALIDATION",
      "Image transform on Workers requires R2_PUBLIC_BASE to be set and the file to be public",
    );
  }
  if (isWorker && row.acl !== "public") {
    throw new AppError(
      "VALIDATION",
      "Image transform on Workers is only available for public files",
    );
  }
  if (ctx.image.name === "passthrough") {
    throw new AppError(
      "VALIDATION",
      "This runtime has no image-transform backend (install Bun ≥ 1.2, or deploy on Cloudflare Workers with R2_PUBLIC_BASE)",
    );
  }

  const source = await ctx.storage.get(key);
  if (!source) throw new AppError("NOT_FOUND", "Object not found");
  const transformed = await ctx.image.transform(
    source.body,
    ct ?? undefined,
    parsed.transform,
  );
  // Bun.Image returns a Uint8Array; compute the length so clients see a
  // sensible content-length and HEAD requests can read it.
  const bytes =
    transformed.body instanceof Uint8Array
      ? transformed.body
      : transformed.body instanceof ArrayBuffer
        ? new Uint8Array(transformed.body)
        : null;
  const responseBody: BodyInit = bytes
    ? (bytes as unknown as BodyInit)
    : (transformed.body as unknown as BodyInit);
  return new Response(responseBody, {
    headers: {
      "content-type": transformed.contentType,
      ...(bytes ? { "content-length": String(bytes.byteLength) } : {}),
      etag,
      ...TRANSFORM_CACHE_HEADERS,
    },
  });
}
