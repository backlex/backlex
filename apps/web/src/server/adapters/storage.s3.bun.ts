import type { StorageAdapter, StoredObject } from "@backlex/core/adapters";

export interface BunS3Config {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
}

interface BunS3File {
  write(
    data: ArrayBuffer | Uint8Array | ReadableStream | string | Blob,
    opts?: { type?: string },
  ): Promise<number>;
  bytes(): Promise<Uint8Array>;
  stream(): ReadableStream;
  delete(): Promise<void>;
  stat(): Promise<{ size: number; type?: string; lastModified?: Date | number }>;
  presign(opts: { expiresIn: number; acl?: string }): string;
}

interface BunS3ClientCtor {
  new (
    cfg: BunS3Config,
  ): {
    file(key: string): BunS3File;
  };
  list(
    opts: { prefix?: string; maxKeys?: number },
    creds: BunS3Config,
  ): Promise<{
    contents?: { key: string; size: number; lastModified: Date | string }[];
  }>;
}

/**
 * `Bun.S3Client`-backed S3 storage adapter — fast native path on Bun. Falls
 * back to `null` when run under a non-Bun runtime; the cross-runtime
 * `s3FetchStorage` adapter takes over there.
 */
export const bunS3Storage = (cfg: BunS3Config): StorageAdapter | null => {
  const bun = (globalThis as { Bun?: { S3Client?: unknown } }).Bun;
  const S3Client = bun?.S3Client as BunS3ClientCtor | undefined;
  if (typeof S3Client !== "function") return null;

  const client = new S3Client(cfg);
  const toDate = (v: Date | string | number | undefined): Date =>
    v instanceof Date ? v : v === undefined ? new Date() : new Date(v);

  return {
    async put({ key, body, contentType }) {
      const file = client.file(key);
      const data =
        typeof body === "string"
          ? body
          : body instanceof Uint8Array
            ? body
            : body instanceof ArrayBuffer
              ? new Uint8Array(body)
              : body;
      const size = await file.write(
        data,
        contentType ? { type: contentType } : undefined,
      );
      return {
        key,
        size,
        contentType,
        uploadedAt: new Date(),
      };
    },
    async get(key) {
      const file = client.file(key);
      let stat;
      try {
        stat = await file.stat();
      } catch {
        return null;
      }
      return {
        body: file.stream(),
        meta: {
          key,
          size: stat.size,
          contentType: stat.type,
          uploadedAt: toDate(stat.lastModified),
        },
      };
    },
    async delete(key) {
      try {
        await client.file(key).delete();
      } catch {
        // S3 delete is idempotent — ignore "not found".
      }
    },
    async list(prefix = "") {
      const res = await S3Client.list(
        { prefix, maxKeys: 1000 },
        cfg,
      );
      const contents = res.contents ?? [];
      return contents.map(
        (c): StoredObject => ({
          key: c.key,
          size: c.size,
          uploadedAt: toDate(c.lastModified),
        }),
      );
    },
    async signedUrl(key, ttlSeconds) {
      return client.file(key).presign({ expiresIn: ttlSeconds });
    },
  };
};
