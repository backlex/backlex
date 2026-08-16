import { and, eq, inArray, type SQL } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../../app";
import { safeServeHeaders } from "./content-type";
import { filesTable } from "./folders";
import { keyCandidates } from "./keys";
import { bucketFor, type FileAcl } from "./bucket-for";
import {
  canonicalizeTransformQuery,
  computeEtag,
  isImageContentType,
  parseTransform,
  TRANSFORM_CACHE_HEADERS,
} from "./transforms";
import type { FileRow } from "./schemas";

/**
 * Shared GET handler — used by both the cookie/session path and the token
 * bypass path. `skipPermissionFilter` is true on the token path because the
 * token itself proved authorization for this exact (tenant, key).
 */
export async function serveObject(
  c: import("hono").Context<AppBindings>,
  tenantId: string,
  logicalKey: string,
  skipPermissionFilter: boolean,
): Promise<Response> {
  const ctx = c.get("ctx");
  const perm = skipPermissionFilter ? null : c.get("permission");
  const t = filesTable(ctx.dialect);

  const conds: SQL[] = [
    inArray(t.key, keyCandidates(tenantId, logicalKey)),
    eq(t.tenantId, tenantId),
  ];
  if (perm?.whereSql) conds.push(perm.whereSql);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(...conds))
    .limit(1)) as FileRow[];
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "Object not found");
  // Storage adapter operates on whatever key the row actually carries —
  // legacy rows without the tenant prefix kept their R2/fs object at the
  // un-prefixed location, so we must follow it.
  const key = row.key;
  // …and from whichever bucket the row's ACL puts it in. One answer, asked
  // once: reading "from either bucket" is how a half-migrated pair stays half
  // migrated. On a single-bucket deployment this is `ctx.storage`, unchanged.
  const bucket = bucketFor(ctx, row.acl as FileAcl);

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
    const obj = await bucket.get(key);
    if (!obj) throw new AppError("NOT_FOUND", "Object not found");
    const contentType =
      obj.meta.contentType ?? row.contentType ?? "application/octet-stream";
    return new Response(obj.body, {
      headers: {
        "content-type": contentType,
        "content-length": String(obj.meta.size),
        // User-supplied bytes on the app origin — never let them execute as a
        // document. See services/storage/content-type.ts.
        ...safeServeHeaders(contentType),
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

  const publicBase = ctx.env.R2_PUBLIC_BASE;

  // Edge/URL path — CF Image Resizing or the Netlify Image CDN, whichever the
  // runtime wired into `ctx.edgeImage`. Cheapest path: no bytes through the
  // runtime. Requires the file to be reachable publicly, which is only honest
  // when the row's ACL is public.
  if (ctx.edgeImage && publicBase && row.acl === "public") {
    const origin = publicBase.replace(/\/$/, "");
    const resp = await ctx.edgeImage.transformFromUrl(
      `${origin}/${key}`,
      parsed.transform,
      parsed.focal,
    );
    const headers = new Headers(resp.headers);
    headers.set("etag", etag);
    for (const [k, v] of Object.entries(safeServeHeaders(ct))) headers.set(k, v);
    // A redirect (Netlify CDN) is cached by the CDN itself; only decorate
    // byte-carrying responses with our transform cache policy.
    if (resp.status !== 302) {
      for (const [k, v] of Object.entries(TRANSFORM_CACHE_HEADERS)) headers.set(k, v);
    }
    return new Response(resp.body, { status: resp.status, headers });
  }

  // An edge-only runtime (edge backend present, no byte backend) can't fall
  // through to `ctx.image` — surface the unmet precondition rather than
  // silently no-op'ing the transform.
  if (ctx.edgeImage && ctx.image.name === "passthrough") {
    if (!publicBase) {
      throw new AppError(
        "VALIDATION",
        `Image transform via ${ctx.edgeImage.name} requires R2_PUBLIC_BASE to be set and the file to be public`,
      );
    }
    throw new AppError(
      "VALIDATION",
      `Image transform via ${ctx.edgeImage.name} is only available for public files`,
    );
  }
  if (ctx.image.name === "passthrough") {
    throw new AppError(
      "VALIDATION",
      "This runtime has no image-transform backend (Netlify needs R2_PUBLIC_BASE + a public file for the Image CDN; install Bun ≥ 1.2; or deploy on Cloudflare Workers with R2_PUBLIC_BASE)",
    );
  }

  const source = await bucket.get(key);
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
      ...safeServeHeaders(transformed.contentType),
    },
  });
}
