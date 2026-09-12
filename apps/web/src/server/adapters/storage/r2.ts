import type { StorageAdapter } from "@backlex/core/adapters";

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

  // ── Multipart (TUS) ───────────────────────────────────────────────────────
  // R2 multipart uploads are resumable across requests/isolates: the upload id
  // is stable, so each PATCH re-opens the handle with `resumeMultipartUpload`.
  async createMultipart(key, opts) {
    const mpu = await bucket.createMultipartUpload(key, {
      httpMetadata: opts?.contentType ? { contentType: opts.contentType } : undefined,
    });
    return { uploadId: mpu.uploadId };
  },
  async uploadPart(key, uploadId, partNumber, body, _size) {
    const mpu = bucket.resumeMultipartUpload(key, uploadId);
    const part = await mpu.uploadPart(partNumber, body as ReadableStream);
    return { partNumber: part.partNumber, etag: part.etag };
  },
  async completeMultipart(key, uploadId, parts) {
    const mpu = bucket.resumeMultipartUpload(key, uploadId);
    const obj = await mpu.complete(
      parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    );
    return {
      key,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType,
      etag: obj.etag,
      uploadedAt: obj.uploaded,
    };
  },
  async abortMultipart(key, uploadId) {
    const mpu = bucket.resumeMultipartUpload(key, uploadId);
    await mpu.abort();
  },
});
