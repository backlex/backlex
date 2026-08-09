import { appendFile, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { StorageAdapter, StoredObject } from "@backlex/core/adapters";

export const fsStorage = (root: string): StorageAdapter => {
  const rootAbs = resolve(root);
  /** Resolve a key under the storage root, refusing anything that escapes it.
   *  Callers are expected to have run `guardLogicalKey` already; this is the
   *  last line of defense, because a bare `join(root, key)` happily walks out
   *  of the root on a key made of parent-directory segments, turning any
   *  key-carrying field into an arbitrary host-file read. */
  const path = (key: string) => {
    const abs = resolve(rootAbs, key);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
      throw new Error(`storage key escapes the storage root: ${key}`);
    }
    return abs;
  };
  // Temp file backing an in-progress multipart upload. TUS is strictly
  // sequential by offset, so we just append each part to one file and rename
  // it into place on complete — the current file size IS the committed offset.
  const partPath = (key: string, uploadId: string) =>
    `${path(key)}.${uploadId}.uploading`;

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
      const buf =
        typeof body === "string"
          ? Buffer.from(body)
          : body instanceof Uint8Array
            ? Buffer.from(body)
            : body instanceof ArrayBuffer
              ? Buffer.from(body)
              : Buffer.from(await new Response(body as ReadableStream).arrayBuffer());
      await writeFile(target, buf);
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
      const dir = path(prefix);
      if (!existsSync(dir)) return [];
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
        const rel = join(prefix, relative(dir, join(parent, e.name)));
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
  };
};
