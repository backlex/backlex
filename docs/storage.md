# Storage

Object storage with per-tenant isolation, public/private ACL, on-the-fly
image transforms, and short-lived signed URLs. Runs on local fs (Bun
dev), Cloudflare R2 (Workers), or any S3-compatible bucket (AWS, R2, B2,
MinIO, DigitalOcean Spaces, Wasabi).

## Adapter selection

Picked by `buildContext(env)` in `apps/web/src/server/context.ts`:

| Condition                          | Adapter                              |
|------------------------------------|--------------------------------------|
| `env.R2` binding present           | `r2Storage` (Workers)                |
| `env.S3_BUCKET` set on Bun         | `s3BunStorage` (`Bun.S3Client`)      |
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
| POST   | `/:key/sign`          | `system_files.read`                 | Body `{ ttlSeconds?: number }` (60–86400, default 3600); returns `{ url, expiresAt }` |

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
   bunx wrangler r2 bucket dev-url enable workeros-files
   bunx wrangler r2 bucket dev-url get workeros-files
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

`POST /api/storage/:key/sign` issues a short-lived bearer that lets the
holder fetch the object without a cookie or API key. Useful for hand-off
to an `<img>` tag, a download anchor, or third parties (CDN purge
webhooks, etc.).

### Request

```bash
curl -X POST /api/storage/uploads/private.pdf/sign \
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

### Using a signed URL

```ts
const { url } = await fetch(`/api/storage/${key}/sign`, {
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

Enabling `wrangler r2 bucket dev-url enable workeros-files` makes
*every* object in the bucket fetchable at
`https://pub-<hash>.r2.dev/<key>` by anyone who knows the key path.

The storage route only hands the public URL to `cf.image` when the row's
ACL is `public`, but the bucket itself is wide open. Someone who can
guess `tenants/<uuid>/<logical-key>` can fetch a private file directly
from r2.dev, bypassing the Worker.

If that matters for your deployment:

- Drop `R2_PUBLIC_BASE` — transforms then reject on Workers with
  `VALIDATION`, but private files stay private.
- Or split into two buckets — one fully public for assets meant for the
  open web, one fully private for tenant data — and bind only the public
  one to the cf.image path. (No code for this yet; would need
  `R2_PUBLIC_BUCKET` + a per-row routing decision.)

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
