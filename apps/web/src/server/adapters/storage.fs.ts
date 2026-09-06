import { appendFile, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StorageAdapter, StoredObject } from "@backlex/core/adapters";

/**
 * Charset a multipart upload id may use, checked because on this backend the id
 * becomes part of a FILENAME.
 *
 * Every id this adapter issues is a `randomUUID()`, and R2's and S3's are
 * base64url-ish, so no legitimate caller is narrowed by this — including an
 * upload already in flight when the check landed, whose temp file keeps exactly
 * the name it had. What it refuses is an id carrying a path separator, which is
 * the only reason a caller would choose one.
 */
const SAFE_UPLOAD_ID = /^[A-Za-z0-9._~-]{1,200}$/;

export const fsStorage = (root: string): StorageAdapter => {
  const rootAbs = resolve(root);
  /** Refuse an already-resolved absolute path that is not under the storage
   *  root. Split out from `path` because the multipart temp name is built by
   *  appending to a resolved key, and the check has to run on the RESULT of
   *  that — checking the key half alone is what let an upload id containing
   *  parent-directory segments write outside the root. */
  const underRoot = (abs: string, what: string): string => {
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
      throw new Error(`storage key escapes the storage root: ${what}`);
    }
    return abs;
  };
  /** Resolve a key under the storage root, refusing anything that escapes it.
   *  Callers are expected to have run `guardLogicalKey` already; this is the
   *  last line of defense, because a bare `join(root, key)` happily walks out
   *  of the root on a key made of parent-directory segments, turning any
   *  key-carrying field into an arbitrary host-file read. */
  const path = (key: string) => underRoot(resolve(rootAbs, key), key);
  // Temp file backing an in-progress multipart upload. TUS is strictly
  // sequential by offset, so we just append each part to one file and rename
  // it into place on complete — the current file size IS the committed offset.
  //
  // The upload id is caller-supplied on the S3 endpoint (`?uploadId=`), so it
  // gets both halves of the treatment: a charset that cannot express a
  // separator, and a root check on the FINISHED path rather than on the key it
  // was appended to. `resolve` collapses any parent-directory segment first, so
  // what `underRoot` judges is the same path the kernel would open.
  const partPath = (key: string, uploadId: string) => {
    if (!SAFE_UPLOAD_ID.test(uploadId)) {
      throw new Error("storage: multipart upload id is not a valid path fragment");
    }
    const keyPath = path(key);
    return underRoot(resolve(`${keyPath}.${uploadId}.uploading`), `${key}.${uploadId}`);
  };

  const ensureDir = async (file: string) => {
    await mkdir(dirname(file), { recursive: true });
  };

  const toBuffer = async (
    body: ReadableStream | Uint8Array | ArrayBuffer | string,
  ): Promise<Buffer> =>
    typeof body === "string"
      ? Buffer.from(body)
      : body instanceof Uint8Array
        ? Buffer.from(body)
        : body instanceof ArrayBuffer
          ? Buffer.from(body)
          : Buffer.from(await new Response(body as ReadableStream).arrayBuffer());

  return {
    async put({ key, body, contentType }) {
      const target = path(key);
      await ensureDir(target);
      if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer) {
        await writeFile(target, Buffer.from(body as never));
      } else {
        // STREAM it. This used to be `Buffer.from(await new
        // Response(body).arrayBuffer())` — the entire upload materialised in
        // memory before the first byte reached disk, so process RSS tracked the
        // request and a large upload took the server down. `PUT
        // /api/storage/:key` had no byte ceiling either, which is what made a
        // multi-gigabyte chunked body reachable in the first place (fixed in
        // `routes/storage.ts`); this makes the adapter honest regardless.
        try {
          await pipeline(Readable.fromWeb(body as never), createWriteStream(target));
        } catch (e) {
          // A stream that errors mid-flight leaves a TRUNCATED file behind, and
          // the caller is about to throw — so no `files` row will point at it.
          // `limitStream` makes that a routine outcome rather than a rare one
          // (a body over the ceiling errors on purpose), which is exactly when
          // unreferenced bytes start accumulating on disk.
          await unlink(target).catch(() => {});
          throw e;
        }
      }
      const s = await stat(target);
      return {
        key,
        size: s.size,
        contentType,
        uploadedAt: new Date(s.mtimeMs),
      };
    },
    async get(key) {
      const target = path(key);
      if (!existsSync(target)) return null;
      const s = await stat(target);
      const stream = Readable.toWeb(createReadStream(target)) as unknown as ReadableStream;
      return {
        body: stream,
        meta: { key, size: s.size, uploadedAt: new Date(s.mtimeMs) },
      };
    },
    async delete(key) {
      const target = path(key);
      if (existsSync(target)) await unlink(target);
    },
    async list(prefix = "") {
      // `prefix` is a STRING prefix, not a directory path — that is what the
      // `StorageAdapter` contract means and what R2 and S3 do. Treating it as a
      // directory diverges in two reachable ways, and `routes/s3.ts` hands this
      // a caller-supplied value straight from `?prefix=`:
      //
      //   - a full object key (`aws s3 ls s3://b/a/file.txt`, which is legal
      //     S3) resolved to a FILE and `readdir` threw ENOTDIR → a 500 on fs
      //     deploys and one listed object on R2;
      //   - a partial name (`…/inv`) resolved to a directory that does not
      //     exist and answered `[]` instead of the invoices under it.
      //
      // So: list from the nearest existing ancestor directory and filter by the
      // string, which collapses all three cases (exact directory, exact file,
      // partial name) into the one behaviour the other backends already have.
      //
      // The cost: a prefix with no `/` at all walks the whole root before
      // filtering, where R2 answers from an index. Bounded in practice — the
      // only caller, `routes/s3.ts`, passes `physicalKey(tenantId, …)`, which
      // always carries a tenant segment — but worth knowing before this is
      // called from somewhere new.
      let dir = path(prefix);
      let scope = prefix;
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        scope = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/") + 1) : "";
        dir = path(scope);
        if (!existsSync(dir)) return [];
      }
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      const out: StoredObject[] = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (e.name.endsWith(".uploading")) continue; // skip in-progress parts
        // A recursive `readdir` reports `name` as the BASENAME and the
        // directory separately, so joining prefix+name flattens `a/b/c.txt`
        // to `a/c.txt` — a key that does not exist, which then made `stat`
        // throw and took the whole listing down. Rebuild the key from the
        // entry's own directory instead.
        const parent = (e as { parentPath?: string; path?: string }).parentPath
          ?? (e as { path?: string }).path
          ?? dir;
        const rel = join(scope, relative(dir, join(parent, e.name)));
        // The string filter, applied after the key is rebuilt: listing from an
        // ancestor directory is how a partial prefix is served at all, and
        // without this it would also serve the siblings that do not match.
        if (!rel.startsWith(prefix)) continue;
        const s = await stat(path(rel));
        out.push({ key: rel, size: s.size, uploadedAt: new Date(s.mtimeMs) });
      }
      return out;
    },

    // ── Multipart (TUS) — offset-append to a single temp file ────────────────
    async createMultipart(key) {
      const uploadId = randomUUID();
      const target = partPath(key, uploadId);
      await ensureDir(target);
      await writeFile(target, Buffer.alloc(0)); // create empty
      return { uploadId };
    },
    async uploadPart(key, uploadId, partNumber, body, _size) {
      const target = partPath(key, uploadId);
      await appendFile(target, await toBuffer(body));
      return { partNumber, etag: String(partNumber) };
    },
    async completeMultipart(key, uploadId, _parts) {
      const target = partPath(key, uploadId);
      const final = path(key);
      await ensureDir(final);
      await rename(target, final);
      const s = await stat(final);
      return { key, size: s.size, uploadedAt: new Date(s.mtimeMs) };
    },
    async abortMultipart(key, uploadId) {
      const target = partPath(key, uploadId);
      if (existsSync(target)) await unlink(target);
    },
    // No minimum: this backend appends every part to one file, so a 1-byte
    // chunk assembles exactly as well as a 5 MiB one. S3 and R2 do not, which
    // is why the number belongs to the adapter — see `StorageAdapter`.
    minPartBytes: 0,
  };
};
