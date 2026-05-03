import type { StorageAdapter } from "@workeros/core/adapters";

export const r2Storage = (bucket: R2Bucket): StorageAdapter => ({
  async put({ key, body, contentType, metadata }) {
    const res = await bucket.put(key, body as ReadableStream, {
      httpMetadata: contentType ? { contentType } : undefined,
      customMetadata: metadata,
    });
    return {
      key,
      size: res.size,
      contentType,
      etag: res.etag,
      uploadedAt: res.uploaded,
    };
  },
  async get(key) {
    const obj = await bucket.get(key);
    if (!obj) return null;
    return {
      body: obj.body,
      meta: {
        key,
        size: obj.size,
        contentType: obj.httpMetadata?.contentType,
        etag: obj.etag,
        uploadedAt: obj.uploaded,
      },
    };
  },
  async delete(key) {
    await bucket.delete(key);
  },
  async list(prefix) {
    const res = await bucket.list({ prefix });
    return res.objects.map((o: any) => ({
      key: o.key,
      size: o.size,
      contentType: o.httpMetadata?.contentType,
      etag: o.etag,
      uploadedAt: o.uploaded,
    }));
  },
});
