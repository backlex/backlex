import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { Readable } from "node:stream";
import type { StorageAdapter, StoredObject } from "@workeros/core/adapters";

export const fsStorage = (root: string): StorageAdapter => {
  const path = (key: string) => join(root, key);

  const ensureDir = async (file: string) => {
    await mkdir(dirname(file), { recursive: true });
  };

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
      const stream = Readable.toWeb(createReadStream(target)) as ReadableStream;
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
        const rel = join(prefix, e.name);
        const s = await stat(path(rel));
        out.push({ key: rel, size: s.size, uploadedAt: new Date(s.mtimeMs) });
      }
      return out;
    },
  };
};
