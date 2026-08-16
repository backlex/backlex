/**
 * The S3-compatible endpoint.
 *
 * ## Why this exists
 *
 * backlex already has object storage, a REST API for it, signed URLs and
 * resumable uploads. What it did not have is the one protocol every tool
 * already speaks: `rclone`, `aws-cli`, `mc`, Cyberduck, restic, duplicity, and
 * every backup product written in the last fifteen years talk S3. Speaking it
 * costs one route and buys all of them, with no adapter on either side.
 *
 * ## What it is, and what it deliberately is not
 *
 * A USEFUL SUBSET, chosen by what the tools above actually call: object GET /
 * PUT / DELETE / HEAD, `ListObjectsV2`, `DeleteObjects`, and the four multipart
 * verbs. Not implemented, and answered with a proper S3 error rather than a
 * 404: versioning, ACLs, bucket policies, lifecycle, replication, tagging,
 * CORS configuration, website hosting. Each of those is a whole subsystem whose
 * absence a tool copes with, where a wrong answer would make it misbehave.
 *
 * **One bucket per workspace.** The bucket name is the workspace slug, because
 * a SigV4 request carries no workspace header — the credential names the
 * workspace, and the bucket in the path is checked against it rather than used
 * to select it. A credential can therefore never reach another workspace's
 * objects by changing the URL.
 *
 * **Every object goes through the same `StorageAdapter` the REST API uses**, and
 * every key through the same `guardLogicalKey`. This endpoint is a second
 * PROTOCOL, not a second storage path: an object written by `rclone` is
 * immediately visible in the admin's file browser, and a key that the REST API
 * would refuse is refused here identically.
 */
import { Hono } from "hono";
import type { AppBindings } from "../app";
import type { Ctx } from "../context";
import { buildContext } from "../context";
import {
  UNSIGNED_PAYLOAD,
  decodeAwsChunked,
  isStreamingPayload,
  parseSigV4,
  sha256Hex,
  verifySigV4,
} from "../services/s3/sigv4";
import {
  resolveS3Credential,
  touchS3Credential,
  withinPrefix,
  type S3CredentialRow,
} from "../services/s3/credentials";
import { guardLogicalKey, physicalKey, stripTenantPrefix } from "../services/storage/keys";
import { bucketFor, deleteEverywhere } from "../services/storage/bucket-for";
import { aclForKey } from "../services/storage/files";
import { assertStorageWithinLimit } from "../services/usage";
import { filesTable } from "../services/storage/folders";
import { xml, xmlError, escapeXml } from "../services/s3/xml";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { eq } from "drizzle-orm";

type AnyDb = any;

/** Objects returned by one `ListObjectsV2`. S3's own default and maximum. */
const LIST_MAX_KEYS = 1000;
/** Ceiling on a single buffered PUT.
 *
 *  The adapter contract takes a stream, but the signature has to be checked
 *  against the WHOLE body before a byte of it is stored — so a signed upload is
 *  bounded, and anything larger is what multipart is for. 16 MB rather than
 *  something generous because this body sits in memory on a runtime whose whole
 *  isolate may have 128 MB: two copies of a 64 MB upload is the entire budget.
 *  Every client's default multipart threshold is well under this (aws-cli 8 MB,
 *  rclone 5 MB), so in practice nothing hits it. */
const MAX_SIGNED_PUT_BYTES = 16 * 1024 * 1024;
/**
 * Failed-authentication budget per IP.
 *
 * The signature is 256 bits and not worth guessing, but every ATTEMPT costs a
 * row read and an AES-GCM decrypt, and this route is mounted outside `/api`
 * where the usual API rate limit does not reach.
 *
 * Only FAILURES consume the budget. A sync tool makes thousands of successful
 * requests a minute and must never be throttled by a counter meant for someone
 * guessing — which is exactly what a plain "requests per IP" limiter here would
 * do, and did, until the tests caught it.
 */
const AUTH_FAIL_MAX = 30;
const AUTH_FAIL_WINDOW_MS = 60_000;
const authFailures = new Map<string, { count: number; resetAt: number }>();

/** True when this IP has spent its failure budget. */
const inPenalty = (ip: string, now: number): boolean => {
  const w = authFailures.get(ip);
  return Boolean(w && w.resetAt > now && w.count >= AUTH_FAIL_MAX);
};

const recordAuthFailure = (ip: string, now: number): void => {
  const w = authFailures.get(ip);
  if (!w || w.resetAt <= now) {
    // Opportunistic GC so the map does not grow with stale keys.
    if (authFailures.size > 5_000) {
      for (const [k, v] of authFailures) if (v.resetAt <= now) authFailures.delete(k);
    }
    authFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
    return;
  }
  w.count += 1;
};

interface S3Auth {
  ctx: Ctx;
  credential: S3CredentialRow;
  tenantSlug: string;
}

const tenantsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.tenants : sqlite.schema.tenants;

/**
 * Authenticate a request and buffer its body.
 *
 * The body is read HERE and not by the handler, because the signature covers
 * it: verifying after the handler has already streamed it to storage would be
 * checking a signature on something already written.
 */
const authenticate = async (
  c: { req: { raw: Request }; env?: unknown },
  env: AnyDb,
): Promise<
  | { ok: true; auth: S3Auth; body: Uint8Array | null }
  | { ok: false; response: Response }
> => {
  const req = c.req.raw;
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local";
  const now = Date.now();
  if (inPenalty(ip, now)) {
    return {
      ok: false,
      response: xmlError("SlowDown", "Too many failed authentication attempts", 429),
    };
  }
  const refuse = (code: string, message: string, status: number) => {
    recordAuthFailure(ip, now);
    return { ok: false as const, response: xmlError(code, message, status) };
  };

  const parsed = parseSigV4(req);
  if (!parsed) {
    return refuse("AccessDenied", "Missing or unsupported authentication", 403);
  }
  const ctx = await buildContext(env);
  const resolved = await resolveS3Credential(ctx, parsed.accessKeyId, now);
  if (!resolved) {
    // One answer for absent / disabled / expired / undecryptable — telling a
    // caller which would let them enumerate valid key ids.
    return refuse("InvalidAccessKeyId", "The access key id does not exist", 403);
  }

  const contentSha = req.headers.get("x-amz-content-sha256");
  let body: Uint8Array | null = null;
  let payloadHash: string;

  if (parsed.presigned) {
    // A presigned URL's signature never covers the body.
    payloadHash = UNSIGNED_PAYLOAD;
  } else if (contentSha === UNSIGNED_PAYLOAD) {
    payloadHash = UNSIGNED_PAYLOAD;
  } else if (isStreamingPayload(contentSha)) {
    // The seed signature covers the headers and this marker, not the chunks.
    payloadHash = contentSha!;
  } else if (contentSha) {
    payloadHash = contentSha;
  } else {
    payloadHash = await sha256Hex("");
  }

  if (req.method === "PUT" || req.method === "POST") {
    // Checked BEFORE buffering. Reading the body first and measuring after
    // would let a caller make us hold a gigabyte in memory to be told it was
    // too large.
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_SIGNED_PUT_BYTES) {
      return {
        ok: false,
        response: xmlError(
          "EntityTooLarge",
          `A single request is limited to ${MAX_SIGNED_PUT_BYTES} bytes — use multipart upload`,
          400,
        ),
      };
    }
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.length > MAX_SIGNED_PUT_BYTES) {
      return {
        ok: false,
        response: xmlError(
          "EntityTooLarge",
          `A single request is limited to ${MAX_SIGNED_PUT_BYTES} bytes — use multipart upload`,
          400,
        ),
      };
    }
    body = isStreamingPayload(contentSha) ? decodeAwsChunked(raw) : raw;
    // When the client hashed the body, check it: the signature covers the hash,
    // so a matching signature with a mismatched body would otherwise store
    // something nobody signed.
    if (payloadHash !== UNSIGNED_PAYLOAD && !isStreamingPayload(contentSha)) {
      const actual = await sha256Hex(raw);
      if (actual !== payloadHash) {
        return {
          ok: false,
          response: xmlError(
            "XAmzContentSHA256Mismatch",
            "The provided x-amz-content-sha256 does not match what we calculated",
            400,
          ),
        };
      }
    }
  }

  const verdict = await verifySigV4({
    req,
    auth: parsed,
    secretKey: resolved.secret,
    payloadHash,
  });
  if (!verdict.ok) {
    return refuse(verdict.code, verdict.message, 403);
  }

  const rows = (await (ctx.db as AnyDb)
    .select({ slug: tenantsTable(ctx.dialect).slug })
    .from(tenantsTable(ctx.dialect))
    .where(eq(tenantsTable(ctx.dialect).id, resolved.row.tenantId))
    .limit(1)) as Array<{ slug: string }>;
  const tenantSlug = rows[0]?.slug;
  if (!tenantSlug) {
    return { ok: false, response: xmlError("NoSuchBucket", "Workspace not found", 404) };
  }

  void touchS3Credential(ctx, resolved.row.id);
  return { ok: true, auth: { ctx, credential: resolved.row, tenantSlug }, body };
};

/** Reject a mutating verb on a read-only credential. */
const mutationAllowed = (cred: S3CredentialRow): Response | null =>
  cred.readOnly
    ? xmlError("AccessDenied", "This credential is read-only", 403)
    : null;

/** The bucket in the path must be the workspace the CREDENTIAL names. It is
 *  never used to select a workspace — that would make the URL the authority. */
const bucketMatches = (bucket: string, slug: string): Response | null =>
  bucket === slug
    ? null
    : xmlError(
        "NoSuchBucket",
        `This credential's bucket is "${slug}"`,
        404,
      );

const keyAllowed = (cred: S3CredentialRow, key: string): Response | null =>
  withinPrefix(cred, key)
    ? null
    : xmlError("AccessDenied", "The key is outside this credential's prefix", 403);

const etagOf = (etag?: string): string => `"${(etag ?? "").replaceAll('"', "")}"`;

/**
 * Register (or refresh) the `files` row for an object written over S3.
 *
 * Without this the endpoint would be a second STORE rather than a second
 * PROTOCOL: the bytes would be in the bucket and the object would be invisible
 * to `/api/storage`, to the admin's file browser, to backups and to the usage
 * gauges — an object nobody could find through the product that wrote it.
 *
 * `acl: private` always. A protocol client has no way to say "publish this",
 * and defaulting to public would make an S3 upload quietly more exposed than
 * the same upload through the API.
 */
const registerFile = async (
  ctx: Ctx,
  tenantId: string,
  physical: string,
  size: number,
  contentType: string | null,
): Promise<void> => {
  const t = filesTable(ctx.dialect);
  const values = {
    key: physical,
    folderId: null,
    ownerId: null,
    tenantId,
    size,
    contentType,
    acl: "private" as const,
  };
  await (ctx.db as AnyDb)
    .insert(t)
    .values(values)
    .onConflictDoUpdate({ target: t.key, set: { size, contentType, tenantId } });
};

/** Drop the `files` row for an object removed over S3, so the browser does not
 *  keep listing something the bucket no longer holds. */
const unregisterFile = async (ctx: Ctx, physical: string): Promise<void> => {
  const t = filesTable(ctx.dialect);
  await (ctx.db as AnyDb).delete(t).where(eq(t.key, physical));
};

const httpDate = (d: Date): string => d.toUTCString();
const isoDate = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, ".000Z");

export const s3Routes = new Hono<AppBindings>();

/**
 * One catch-all, because S3 is not a REST API in the shape Hono routes well:
 * the operation is decided by the verb PLUS a query sub-resource
 * (`?uploads`, `?uploadId=`, `?delete`, `?list-type=2`), and splitting those
 * across route definitions would put the dispatch in two places.
 */
s3Routes.all("/*", async (c) => {
  const env = c.env as AnyDb;
  const url = new URL(c.req.raw.url);
  // `/s3/<bucket>/<key…>`
  const path = url.pathname.replace(/^\/s3\/?/, "");
  const slash = path.indexOf("/");
  const bucket = decodeURIComponent(slash < 0 ? path : path.slice(0, slash));
  const rawKey = slash < 0 ? "" : decodeURIComponent(path.slice(slash + 1));

  const authed = await authenticate(c, env);
  if (!authed.ok) return authed.response;
  const { ctx, credential, tenantSlug } = authed.auth;
  const tenantId = credential.tenantId;
  const method = c.req.raw.method.toUpperCase();
  const qs = url.searchParams;

  // ── Service level: ListBuckets ────────────────────────────────────────────
  if (!bucket) {
    if (method !== "GET") return xmlError("MethodNotAllowed", "Unsupported", 405);
    return xml(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<ListAllMyBucketsResult><Owner><ID>${escapeXml(tenantId)}</ID>` +
        `<DisplayName>${escapeXml(tenantSlug)}</DisplayName></Owner><Buckets><Bucket>` +
        `<Name>${escapeXml(tenantSlug)}</Name><CreationDate>${isoDate(new Date(0))}</CreationDate>` +
        `</Bucket></Buckets></ListAllMyBucketsResult>`,
    );
  }

  const wrongBucket = bucketMatches(bucket, tenantSlug);
  if (wrongBucket) return wrongBucket;

  // ── Bucket level ──────────────────────────────────────────────────────────
  if (!rawKey) {
    if (method === "HEAD") return new Response(null, { status: 200 });
    if (method === "GET") {
      // `list-type=2` is ListObjectsV2; the v1 shape is answered the same way,
      // which every client tolerates because the fields it reads are shared.
      return listObjects(ctx, tenantId, credential, qs, bucket);
    }
    if (method === "POST" && qs.has("delete")) {
      const denied = mutationAllowed(credential);
      if (denied) return denied;
      return deleteObjects(ctx, tenantId, credential, authed.body);
    }
    return xmlError(
      "NotImplemented",
      "This endpoint implements object and multipart operations only",
      501,
    );
  }

  // ── Object level ──────────────────────────────────────────────────────────
  let key: string;
  try {
    guardLogicalKey(rawKey);
    key = rawKey;
  } catch {
    return xmlError("InvalidArgument", "The key is not acceptable", 400);
  }
  const outOfScope = keyAllowed(credential, key);
  if (outOfScope) return outOfScope;
  const physical = physicalKey(tenantId, key);
  // Which bucket this object lives in, on a deployment that keeps public files
  // in their own. The REST surface routes on the row's ACL; this endpoint is its
  // twin over the same objects and has to ask the same question — otherwise a
  // public object 404s on GET, an overwrite leaves the old bytes serving from
  // the CDN, and a DELETE removes the row while the bytes stay world-readable.
  const acl = await aclForKey(ctx, physical);

  if (method === "GET" || method === "HEAD") {
    if (qs.has("uploadId")) return listParts(qs);
    const got = await bucketFor(ctx, acl).get(physical);
    if (!got) return xmlError("NoSuchKey", "The specified key does not exist", 404);
    const headers = new Headers({
      "content-type": got.meta.contentType ?? "application/octet-stream",
      "content-length": String(got.meta.size),
      etag: etagOf(got.meta.etag),
      "last-modified": httpDate(got.meta.uploadedAt),
      "accept-ranges": "none",
    });
    if (method === "HEAD") {
      // The body has to be drained or the adapter's stream leaks; HEAD carries
      // no body by definition.
      void got.body.cancel().catch(() => {});
      return new Response(null, { status: 200, headers });
    }
    return new Response(got.body, { status: 200, headers });
  }

  if (method === "PUT") {
    const denied = mutationAllowed(credential);
    if (denied) return denied;
    const partNumber = qs.get("partNumber");
    const uploadId = qs.get("uploadId");
    if (partNumber && uploadId) {
      await assertStorageWithinLimit(ctx, ctx.env, tenantId, authed.body?.length ?? 0);
      return uploadPart(ctx, physical, uploadId, Number(partNumber), authed.body);
    }
    const contentType = c.req.raw.headers.get("content-type") ?? null;
    // The same plan-quota gate the REST upload path applies. Without it the S3
    // endpoint would be a way around a workspace's storage limit — a hole that
    // only appears once somebody points a sync tool at it.
    await assertStorageWithinLimit(ctx, ctx.env, tenantId, authed.body?.length ?? 0);
    const stored = await bucketFor(ctx, acl).put({
      key: physical,
      body: authed.body ?? new Uint8Array(0),
      contentType: contentType ?? undefined,
    });
    await registerFile(ctx, tenantId, physical, stored.size, stored.contentType ?? contentType);
    return new Response(null, { status: 200, headers: { etag: etagOf(stored.etag) } });
  }

  if (method === "POST") {
    const denied = mutationAllowed(credential);
    if (denied) return denied;
    if (qs.has("uploads")) {
      return createMultipart(ctx, tenantSlug, key, physical, c.req.raw);
    }
    const uploadId = qs.get("uploadId");
    if (uploadId) {
      return completeMultipart(ctx, tenantId, tenantSlug, key, physical, uploadId, authed.body, url);
    }
    return xmlError("NotImplemented", "Unsupported POST", 501);
  }

  if (method === "DELETE") {
    const denied = mutationAllowed(credential);
    if (denied) return denied;
    const uploadId = qs.get("uploadId");
    if (uploadId) {
      await ctx.storage.abortMultipart?.(physical, uploadId);
      return new Response(null, { status: 204 });
    }
    // Every bucket: deleting from the wrong one is a silent no-op, and the row
    // is about to be removed, so the bytes would be left with nothing pointing
    // at them. See `bucket-for.ts::deleteEverywhere`.
    await deleteEverywhere(ctx, physical);
    await unregisterFile(ctx, physical);
    // S3 returns 204 whether or not the object existed — deleting an absent
    // key is not an error, and clients rely on that for idempotent cleanup.
    return new Response(null, { status: 204 });
  }

  return xmlError("MethodNotAllowed", "Unsupported method", 405);
});

// --- operations -------------------------------------------------------------

const listObjects = async (
  ctx: Ctx,
  tenantId: string,
  credential: S3CredentialRow,
  qs: URLSearchParams,
  bucket: string,
): Promise<Response> => {
  const prefix = qs.get("prefix") ?? "";
  const delimiter = qs.get("delimiter") ?? "";
  const requested = Number(qs.get("max-keys") ?? LIST_MAX_KEYS);
  const maxKeys = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : LIST_MAX_KEYS,
    LIST_MAX_KEYS,
  );
  const after = qs.get("continuation-token") ?? qs.get("start-after") ?? "";

  // The credential's own prefix wins over the request's: a caller may narrow
  // its view, never widen it.
  const scope = credential.prefix ?? "";
  const effective = prefix.startsWith(scope) ? prefix : scope;

  const objects = await ctx.storage.list(physicalKey(tenantId, effective));
  const logical = objects
    .map((o) => ({ ...o, key: stripTenantPrefix(tenantId, o.key) }))
    .filter((o) => withinPrefix(credential, o.key))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const contents: string[] = [];
  const commonPrefixes = new Set<string>();
  let count = 0;
  let nextToken: string | null = null;

  for (const o of logical) {
    if (after && o.key <= after) continue;
    if (delimiter) {
      const rest = o.key.slice(effective.length);
      const at = rest.indexOf(delimiter);
      if (at >= 0) {
        commonPrefixes.add(effective + rest.slice(0, at + delimiter.length));
        continue;
      }
    }
    if (count >= maxKeys) {
      // Truncated: the token is the last key we DID return, which is what
      // `start-after` semantics need. Reporting truncation without a token
      // would make a client loop forever on the same page.
      nextToken = contents.length ? logical[count - 1]!.key : null;
      break;
    }
    contents.push(
      `<Contents><Key>${escapeXml(o.key)}</Key>` +
        `<LastModified>${isoDate(o.uploadedAt)}</LastModified>` +
        `<ETag>${escapeXml(etagOf(o.etag))}</ETag>` +
        `<Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
    );
    count += 1;
  }

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ListBucketResult><Name>${escapeXml(bucket)}</Name>` +
    `<Prefix>${escapeXml(prefix)}</Prefix>` +
    `<KeyCount>${count}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>` +
    `<Delimiter>${escapeXml(delimiter)}</Delimiter>` +
    `<IsTruncated>${nextToken ? "true" : "false"}</IsTruncated>` +
    (nextToken
      ? `<NextContinuationToken>${escapeXml(nextToken)}</NextContinuationToken>`
      : "") +
    contents.join("") +
    [...commonPrefixes]
      .sort()
      .map((p) => `<CommonPrefixes><Prefix>${escapeXml(p)}</Prefix></CommonPrefixes>`)
      .join("") +
    `</ListBucketResult>`;
  return xml(body);
};

const deleteObjects = async (
  ctx: Ctx,
  tenantId: string,
  credential: S3CredentialRow,
  body: Uint8Array | null,
): Promise<Response> => {
  const text = body ? new TextDecoder().decode(body) : "";
  const keys = [...text.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1]!.trim());
  const deleted: string[] = [];
  const errors: string[] = [];
  for (const raw of keys) {
    const key = raw
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'");
    try {
      guardLogicalKey(key);
      if (!withinPrefix(credential, key)) throw new Error("out of scope");
      // Every bucket — same reason as the single-object DELETE above: the row
      // is about to go, and a delete aimed at the wrong bucket is silent.
      await deleteEverywhere(ctx, physicalKey(tenantId, key));
      await unregisterFile(ctx, physicalKey(tenantId, key));
      deleted.push(`<Deleted><Key>${escapeXml(key)}</Key></Deleted>`);
    } catch {
      // Per-key failure, per S3: the request succeeds and the body reports it.
      // Throwing would abandon the keys that were fine.
      errors.push(
        `<Error><Key>${escapeXml(key)}</Key><Code>AccessDenied</Code>` +
          `<Message>Refused</Message></Error>`,
      );
    }
  }
  return xml(
    `<?xml version="1.0" encoding="UTF-8"?><DeleteResult>${deleted.join("")}${errors.join("")}</DeleteResult>`,
  );
};

const createMultipart = async (
  ctx: Ctx,
  bucket: string,
  key: string,
  physical: string,
  req: Request,
): Promise<Response> => {
  if (!ctx.storage.createMultipart) {
    return xmlError(
      "NotImplemented",
      "This deployment's storage backend cannot assemble multipart uploads",
      501,
    );
  }
  const { uploadId } = await ctx.storage.createMultipart(physical, {
    contentType: req.headers.get("content-type") ?? undefined,
  });
  return xml(
    `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult>` +
      `<Bucket>${escapeXml(bucket)}</Bucket><Key>${escapeXml(key)}</Key>` +
      `<UploadId>${escapeXml(uploadId)}</UploadId></InitiateMultipartUploadResult>`,
  );
};

const uploadPart = async (
  ctx: Ctx,
  physical: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array | null,
): Promise<Response> => {
  if (!ctx.storage.uploadPart) {
    return xmlError("NotImplemented", "Multipart is unavailable on this backend", 501);
  }
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    return xmlError("InvalidArgument", "partNumber must be 1..10000", 400);
  }
  const bytes = body ?? new Uint8Array(0);
  const part = await ctx.storage.uploadPart(physical, uploadId, partNumber, bytes, bytes.length);
  return new Response(null, { status: 200, headers: { etag: etagOf(part.etag) } });
};

const completeMultipart = async (
  ctx: Ctx,
  tenantId: string,
  bucket: string,
  key: string,
  physical: string,
  uploadId: string,
  body: Uint8Array | null,
  url: URL,
): Promise<Response> => {
  if (!ctx.storage.completeMultipart) {
    return xmlError("NotImplemented", "Multipart is unavailable on this backend", 501);
  }
  const text = body ? new TextDecoder().decode(body) : "";
  const parts = [...text.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => {
    const chunk = m[1]!;
    const n = /<PartNumber>(\d+)<\/PartNumber>/.exec(chunk);
    const e = /<ETag>([\s\S]*?)<\/ETag>/.exec(chunk);
    return {
      partNumber: Number(n?.[1] ?? 0),
      etag: (e?.[1] ?? "").trim().replaceAll("&quot;", "").replaceAll('"', ""),
    };
  });
  if (parts.some((p) => !p.partNumber)) {
    return xmlError("MalformedXML", "A part is missing its PartNumber", 400);
  }
  const stored = await ctx.storage.completeMultipart(physical, uploadId, parts);
  await registerFile(ctx, tenantId, physical, stored.size, stored.contentType ?? null);
  return xml(
    `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult>` +
      `<Location>${escapeXml(url.origin)}/s3/${escapeXml(bucket)}/${escapeXml(key)}</Location>` +
      `<Bucket>${escapeXml(bucket)}</Bucket><Key>${escapeXml(key)}</Key>` +
      `<ETag>${escapeXml(etagOf(stored.etag))}</ETag></CompleteMultipartUploadResult>`,
  );
};

/** `ListParts` — answered as an empty list rather than a 501.
 *
 *  The adapters stage parts in the backend, not in a table we can enumerate,
 *  so there is nothing truthful to return. Every client that calls this uses it
 *  to RESUME, and an empty list means "start over", which is correct here and
 *  which they all handle. A 501 would abort the upload instead. */
const listParts = (qs: URLSearchParams): Response =>
  xml(
    `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult>` +
      `<UploadId>${escapeXml(qs.get("uploadId") ?? "")}</UploadId>` +
      `<IsTruncated>false</IsTruncated></ListPartsResult>`,
  );
