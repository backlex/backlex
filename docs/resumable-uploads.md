---
title: Resumable uploads
description: Chunked, resumable file uploads over the TUS 1.0.0 protocol — survive dropped connections, resume from the committed offset, and push files larger than a single request. Works with Uppy / tus-js-client out of the box.
---

backlex speaks the **[TUS 1.0.0](https://tus.io/) resumable upload protocol** at
`/api/uploads`. Instead of streaming a whole file in one `PUT` (which a dropped
connection loses, and which can blow the per-request memory/size limits on edge
runtimes), a TUS client splits the file into chunks and `PATCH`es them one at a
time. If the connection drops, it `HEAD`s the session to learn the committed
offset and continues from there.

Because it is **standard TUS**, any TUS client works against it directly —
[Uppy](https://uppy.io/docs/tus/), [tus-js-client](https://github.com/tus/tus-js-client),
the Go/Python/Swift/Kotlin clients — just point them at `/api/uploads`. The
backlex SDK also ships a thin helper (`storage.uploadResumable`).

## When it's used

The classic single-shot upload (`PUT /api/storage/:key`) is still there and is
the right tool for small files. Reach for resumable uploads when files are large
or networks are flaky:

- The **admin Storage page** automatically routes files **≥ 50 MiB** through the
  resumable path, with chunked progress and resume-on-reload (the session
  location is stashed in `localStorage`, keyed by the file's name+size+mtime —
  re-drop the same file after a reload and it continues).
- Your own apps choose per call via the SDK or a TUS client.

## How it works

Each in-flight upload is a row in the `uploads` table, backed by a **native
object-store multipart upload**:

| Backend | Multipart strategy |
|---|---|
| Cloudflare R2 | `createMultipartUpload` / `resumeMultipartUpload` (resumable across requests) |
| S3 (and S3-compatible: MinIO, B2, R2-via-S3, DO Spaces) | native S3 multipart (`CreateMultipartUpload` → `UploadPart` → `CompleteMultipartUpload`) |
| Filesystem (self-host) | offset-append to a temp file, atomically renamed into place on completion |

One TUS `PATCH` maps to one multipart part. When the committed offset reaches the
declared `Upload-Length`, the parts are assembled into the final object and a
`files` row is written — exactly as a normal upload would, so the file is then
served, transformed, signed, and listed like any other.

Object stores require every part except the last to be **≥ 5 MiB**, so use a
chunk size of **8 MiB** (the SDK default) for S3/R2. The filesystem backend has
no minimum.

Abandoned sessions are swept automatically: a session that sits unfinished past
its TTL (default 24 h) is aborted — the staged multipart upload is discarded and
the row removed — inside the same cross-runtime tick that drains the
[job queue](/jobs/) and cron functions. No extra infrastructure.

## Protocol surface

All endpoints carry `Tus-Resumable: 1.0.0`. Supported extensions:
`creation`, `creation-with-upload`, `termination`, `expiration`.

| Method | Path | Purpose |
|---|---|---|
| `OPTIONS` | `/api/uploads` | Discovery — returns `Tus-Version`, `Tus-Extension`, `Tus-Max-Size`. |
| `POST` | `/api/uploads` | Create a session. `Upload-Length` (required) + `Upload-Metadata`. Returns `201` + `Location`. May carry an inline first chunk (`creation-with-upload`). |
| `HEAD` | `/api/uploads/{id}` | Returns the committed `Upload-Offset` (resume point) + `Upload-Length`. |
| `PATCH` | `/api/uploads/{id}` | Append a chunk at `Upload-Offset` (`Content-Type: application/offset+octet-stream`). Returns `204` + the new `Upload-Offset`. |
| `DELETE` | `/api/uploads/{id}` | Terminate a session and discard staged parts. |

`Upload-Metadata` is the standard comma-separated `name base64(value)` list.
backlex reads:

- **`filename`** or **`key`** — the destination storage key (one required).
- **`contentType`** (`filetype` / `type` also accepted) — the object MIME type.
- **`folderId`** — target folder, or `__root__` to opt out of folder
  auto-derivation from the key path.

Creating a session requires `create` permission on the files collection (same
gate as `PUT /api/storage`); `PATCH`/`HEAD`/`DELETE` are tenant-scoped to the
session's workspace.

Errors follow the protocol: `409` on an `Upload-Offset` mismatch (another writer
moved the offset — `HEAD` to resync), `413` over `Tus-Max-Size`, `415` for a
wrong `Content-Type` on `PATCH`, `404` for a missing/terminated session.

## SDK

```ts
import { createClient } from "backlex";
const backlex = createClient({ url, apiKey });

// Upload a large File/Blob with progress + auto-resume on transient errors.
await backlex.storage.uploadResumable({
  key: "videos/keynote.mp4",
  data: file,                 // Blob | File | ArrayBuffer | Uint8Array
  contentType: "video/mp4",
  chunkSize: 8 * 1024 * 1024, // default
  onProgress: (sent, total) => console.log(`${Math.round((sent / total) * 100)}%`),
});

// Resume a previously-started session (e.g. after a reload) — persist the
// returned `location` and hand it back with the same data.
await backlex.storage.resumeUpload(location, file);
```

### Using Uppy

```ts
import Uppy from "@uppy/core";
import Tus from "@uppy/tus";

new Uppy().use(Tus, {
  endpoint: "https://your-app/api/uploads",
  chunkSize: 8 * 1024 * 1024,
  headers: { authorization: `Bearer ${apiKey}` },
});
```

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `UPLOAD_MAX_BYTES` | `5368709120` (5 GiB) | Largest allowed upload (`Tus-Max-Size`). |
| `UPLOAD_MIN_PART_BYTES` | `5242880` (5 MiB) | Minimum non-final part size for object backends. |
| `UPLOAD_TTL_MS` | `86400000` (24 h) | Idle lifetime before an unfinished session is swept. |
| `UPLOAD_PART_MAX` | `10000` | Max parts per upload (S3 limit). |

## Management

In-progress and finished sessions are listable for ops/automation:

- `GET /api/uploads` — list sessions (filter `?status=pending|completed|aborted`).
- `GET /api/uploads/{id}` — inspect one session (size, committed offset, status).
- MCP: `uploads.list`, `uploads.get`, `uploads.abort`. (The byte transfer itself
  is not exposed over MCP — use the SDK or a TUS client.)

## Limits & follow-ups

- Object backends require ≥ 5 MiB non-final chunks; sub-5 MiB chunk buffering is
  a planned follow-up. The fs backend accepts any chunk size.
- Storage backend selection is per-deployment (not per-tenant), same as
  non-resumable uploads — see [Storage](/storage/).
