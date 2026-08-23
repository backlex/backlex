---
title: Storage
description: Per-tenant object storage with ACLs, image transforms, and signed URLs on fs, R2, or S3.
---

Object storage with per-tenant isolation, public/private ACL, on-the-fly
image transforms, and short-lived signed URLs. Runs on local fs (Bun
dev), Cloudflare R2 (Workers), or any S3-compatible bucket (AWS, R2, B2,
MinIO, DigitalOcean Spaces, Wasabi).

For large files or flaky networks, use [resumable uploads](/docs/resumable-uploads/)
(TUS 1.0.0 at `/api/uploads`) instead of the single-shot `PUT` below — they
chunk the transfer and resume from the committed offset after a drop.

## Adapter selection

Picked by `buildContext(env)` in `apps/web/src/server/context.ts`:

| Condition                          | Adapter                              |
|------------------------------------|--------------------------------------|
| `env.R2` binding present           | `r2Storage` (Workers)                |
| `env.S3_BUCKET` set on Bun         | `bunS3Storage` (`Bun.S3Client`)      |
| `env.S3_BUCKET` set elsewhere      | `s3FetchStorage` (`aws4fetch`)       |
| otherwise                          | `fsStorage("./.data/files")` (dev)   |

The adapter contract is in `packages/core/src/adapters/storage.ts`; each
adapter is in `apps/web/src/server/adapters/storage.*.ts`.

## Tenant prefix

Every physical key on disk / in the bucket is prefixed with
`tenants/<tenant-id>/`. The API hides this — clients use logical keys
(`uploads/photo.jpg`), and the route adds/strips the prefix. Two tenants
can reuse the same logical key without colliding either in the bucket or
in `files.key` (which is the row's primary key).

Logical keys starting with `tenants/` are rejected with `VALIDATION` so
clients can't sneak into another workspace.

## Endpoints

All routes are under `/api/storage` and require a session cookie or a
bearer API key (except `GET` with a valid `?token=`).

| Method | Path                  | Permission                          | Notes                                       |
|--------|-----------------------|-------------------------------------|---------------------------------------------|
| GET    | `/`                   | `system_files.read`                 | List files for the current tenant (filterable by `?prefix=`) |
| PUT    | `/:key`               | `system_files.create`               | Stream body to storage; row upserted        |
| GET    | `/:key`               | `system_files.read` *or* `?token=`  | Stream object — see [Image transform](#image-transform) and [Signed URLs](#signed-urls) |
| PATCH  | `/:key`               | `system_files.update`               | Body `{ acl?: "public"\|"private", folderId?: string\|null }` |
| DELETE | `/:key`               | `system_files.delete`               | Removes object + row                        |
| POST   | `/_sign/:key`         | `system_files.read`                 | Body `{ ttlSeconds?: number }` (60–86400, default 3600); returns `{ url, expiresAt }` |

The collection slug used by the permission system is `system_files`; the
`ownerScoped`-style auto-permissions seeded for `authenticated` cover
read/update/delete for own files plus unrestricted create.

## ACL semantics

The `files.acl` column (`public` | `private`, default `private`) is the
source of truth for the API and the UI. Storage adapters that don't
track ACLs natively (fs, R2 with default settings, dev S3) ignore the
bit — but every read still goes through the Worker, so private files
stay behind permission + session checks.

`public` *only* relaxes the gate when the storage GET is served via the
edge-resize fast path described below — the public r2.dev URL is *only*
ever handed out for public-ACL rows.

## Image transform

Query parameters on `GET /api/storage/:key`:

| Param     | Range / values                                    |
|-----------|---------------------------------------------------|
| `width`   | 1–4096 (integer)                                  |
| `height`  | 1–4096 (integer)                                  |
| `quality` | 1–100 (integer; ignored for lossless formats)     |
| `format`  | `webp` \| `jpeg` \| `png` \| `avif`               |
| `fit`     | `cover` \| `contain` (only values that work on both backends) |
| `focal`   | `"x,y"` with `x`/`y` in 0–100 (percent)           |

Invalid params throw `VALIDATION` (HTTP 422) — silently dropping bad
input would let UI bugs ship without notice.

### Runtime matrix

| Runtime / config                                     | Transform path                       |
|------------------------------------------------------|--------------------------------------|
| Cloudflare Workers + `R2_PUBLIC_BASE` set, ACL=public | `cf.image` at the edge (no bytes through the Worker) |
| Cloudflare Workers, no `R2_PUBLIC_BASE` *or* ACL=private | **rejected with 422** — see notes below |
| Bun (≥ 1.2 with `Bun.Image`)                         | In-process via `ctx.image` (`bunImage()`) |
| Bun without `Bun.Image` / passthrough adapter        | **rejected with 422**                |

The edge path requires the bucket to be reachable at a stable origin so
the Workers runtime can re-fetch the source. We only ask for that origin
when the row's `acl = "public"`; mixing private files into edge resize
would mean exposing them via the public URL anyway.

### Enabling edge resize (Workers)

1. Enable a public origin for the R2 bucket:
   ```bash
   bunx wrangler r2 bucket dev-url enable backlex-files
   bunx wrangler r2 bucket dev-url get backlex-files
   # → Public URL: https://pub-<hash>.r2.dev
   ```
2. Set `R2_PUBLIC_BASE` in `apps/web/wrangler.toml` under `[vars]` to
   that URL.
3. Deploy. The storage route will switch public-ACL files to the
   `cfImageFromUrl` path automatically.

For production traffic, prefer a custom domain bound to the bucket
(`wrangler r2 bucket domain add`) over the r2.dev URL — Cloudflare
treats r2.dev as a development origin and may rate-limit it.

### Caching

Transformed responses include:

```
ETag: W/"<sha256-prefix-of-key+canonical-query>"
Cache-Control: public, max-age=31536000, immutable
```

The ETag is content-addressed by the canonical transform query, so
distinct param sets get distinct cache entries. Clients that round-trip
`If-None-Match` get a `304 Not Modified` (no body, same ETag). The
`immutable` directive lets the browser skip re-validation — safe because
*any* parameter change produces a new URL.

## Signed URLs

`POST /api/storage/_sign/:key` issues a short-lived bearer that lets the
holder fetch the object without a cookie or API key. Useful for hand-off
to an `<img>` tag, a download anchor, or third parties (CDN purge
webhooks, etc.).

:::note[Why `_sign/` is a prefix, not a `/sign` suffix]
A key may contain `/`, so it is a catch-all — and the router falls back to a
greedy matcher when a literal-suffix route sits alongside sibling catch-alls,
which made `…/a/b/c.txt/sign` 404 on keys of three or more segments. The
sentinel prefix has no such ambiguity, so the key stays the *last* thing in the
path. This page and the generated OpenAPI spec both advertised the suffix form
for a while; it never worked. See `tests/storage-sign.test.ts`.
:::

### Request

```bash
curl -X POST /api/storage/_sign/uploads/private.pdf \
  -H "content-type: application/json" \
  -d '{"ttlSeconds": 600}'      # 60–86400, default 3600
# → { "url": "/api/storage/uploads/private.pdf?token=…", "expiresAt": "…" }
```

The caller must already have `system_files.read` on that key — any
per-row `condition` is enforced before the token is issued, so a scoped
role can't sign a sibling row.

### Token format

`<base64url payload>.<base64url HMAC-SHA256>` where the payload is

```json
{ "k": "tenants/<tid>/<logical-key>", "t": "<tid>", "exp": <epoch-seconds> }
```

HMAC key is derived from `AUTH_SECRET` (`signStorageUrl`/
`verifyStorageUrl` in `apps/web/src/server/lib/crypto.ts`). Rotating
`AUTH_SECRET` invalidates every outstanding token. Tokens are tenant-
and key-pinned: the GET handler rejects a token whose `(t, k)` don't
match the requested path.

### From the SDK

```ts
// A short-lived URL for a private object.
const { url, expiresAt } = await backlex.storage.signUrl(key, 300);

// For a public one, compose the address directly — no request, so it goes
// straight into an `<img>` and the browser caches, lazy-loads and gets the
// server-side resize.
<img src={backlex.storage.url(key, { width: 480, format: "webp" })} loading="lazy" />
```

A key containing a `.` or `..` path segment is refused by `url()` / `signUrl()`
rather than encoded: every URL parser normalizes dot segments away *after*
percent-decoding, so there is no encoding that survives one, and composing the
link anyway would address something outside `/api/storage/`.

### Using a signed URL

```ts
const { url } = await fetch(`/api/storage/_sign/${key}`, {
  method: "POST",
  body: JSON.stringify({ ttlSeconds: 300 }),
}).then((r) => r.json());

img.src = url;          // serves the original
img.src = url + "&width=400&format=webp";  // token + transform combined
```

S3-flavoured adapters expose `signedUrl(key, ttlSeconds)` natively; the
route currently always uses the HMAC path so behaviour is identical
across runtimes, but a future change may prefer the S3 presigned URL
when available.

## Security tradeoffs (R2 r2.dev)

Enabling `wrangler r2 bucket dev-url enable backlex-files` makes
*every* object in the bucket fetchable at
`https://pub-<hash>.r2.dev/<key>` by anyone who knows the key path.

The storage route only hands the public URL to `cf.image` when the row's
ACL is `public`, but the bucket itself is wide open. Someone who can
guess `tenants/<uuid>/<logical-key>` can fetch a private file directly
from r2.dev, bypassing the Worker.

If that matters for your deployment, there are two answers:

- **Drop `R2_PUBLIC_BASE`.** Transforms then reject on Workers with
  `VALIDATION`, but private files stay private.
- **Or split into two buckets** — the supported fix, described below.

## Splitting public and private into two buckets

Bind a second bucket and `acl: "public"` files move into it. Nothing else does:
private files, backups (`backups/…`), generated documents, avatars and CDC
exports all stay in the private bucket, because they have no ACL to consult and
defaulting them to private is a rule that cannot rot as new writers appear.

```toml
# apps/web/wrangler.toml
[[r2_buckets]]
binding = "R2"            # private — never enable its dev URL
bucket_name = "my-files"

[[r2_buckets]]
binding = "R2_PUBLIC"     # public — this is the one r2.dev may serve
bucket_name = "my-public"
```

On S3-compatible storage the twin is `S3_PUBLIC_BUCKET` (same credentials,
same endpoint, different bucket).

**Leaving it unset is the single-bucket behaviour every install has today.**
Nothing moves and nothing changes until you opt in.

### Turning it on, in this order

1. Create the bucket and bind it as `R2_PUBLIC`, then deploy.
2. Enable the dev URL on the **new** bucket, and point `R2_PUBLIC_BASE` at it.
3. Move what is already there:

   ```http
   POST /api/storage/_split-buckets   { "dryRun": true }
   POST /api/storage/_split-buckets   { "limit": 100 }
   POST /api/storage/_split-buckets   { "limit": 100, "after": "<cursor>" }
   ```

   Admin-only, cursor-paged over `files.key`, and copy-then-delete — an
   interrupted run leaves a duplicate rather than a gap, and re-running tidies
   it. Repeat until `cursor` is `null`.
4. **Last**, disable the dev URL on the old bucket. In the other order every
   public asset 404s until step 3 finishes.

### What changes once it is on

| Path | Behaviour |
|---|---|
| `PUT /api/storage/{key}` | Writes to the bucket the **existing row's** ACL names, so an overwrite of a public file does not silently leave the old copy serving. A new file is private. |
| `POST /api/storage/from-url` | Places by the `acl` it is given, and removes any copy the other bucket still holds under that key. |
| `PATCH /api/storage/{key}` with `acl` | Becomes a **move**: the bytes are copied to the other bucket and deleted from the first, before the row is updated. It throws rather than leaving a row whose ACL and bytes disagree. |
| `GET /api/storage/{key}` | Reads from the bucket the row's ACL names. |
| `DELETE` | Deletes from that same bucket — deleting from the wrong one is a silent no-op, which would leave the bytes public with no row to find them by. |

Objects keep their key across the move, so outstanding signed URLs stay valid.

## Upload reference

```ts
await fetch(`/api/storage/uploads/${name}`, {
  method: "PUT",
  credentials: "include",
  headers: { "content-type": file.type },
  body: file,           // any BodyInit — File / Blob / ReadableStream
});
```

The body is streamed straight to the storage adapter — no buffering in
memory beyond what the runtime imposes. The route then upserts a `files`
row with `{ size, contentType, ownerId, tenantId, folderId }`.

There is no per-request size cap in the route; the runtime sets it
(Workers: ~100 MB single-request; Bun: bounded by `BUN_REQUEST_BODY_LIMIT`).

## Folders

`folders` is a metadata-only table (`POST /api/folders`); the storage
adapter has no concept of folders. The UI groups files by the `folder_id`
column and uses `/` in folder names for visual nesting.

## See also

- `docs/permissions.md` — the `system_files` collection + condition DSL.
- `docs/deployment.md` — adapter selection per runtime, S3 env vars.
- Source of truth: `apps/web/src/server/routes/storage.ts`.
