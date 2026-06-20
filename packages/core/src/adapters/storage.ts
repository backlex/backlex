export interface PutObjectInput {
  key: string;
  body: ReadableStream | ArrayBuffer | Uint8Array | string;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface StoredObject {
  key: string;
  size: number;
  contentType?: string;
  etag?: string;
  uploadedAt: Date;
}

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

export interface StorageAdapter {
  put(input: PutObjectInput): Promise<StoredObject>;
  get(key: string): Promise<{ body: ReadableStream; meta: StoredObject } | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<StoredObject[]>;
  signedUrl?(key: string, ttlSeconds: number): Promise<string>;

  // ── Resumable / multipart uploads (TUS) ──────────────────────────────────
  // Optional: only backends that can assemble an object from sequential parts
  // implement these. The uploads service feature-detects `createMultipart`.

  /** Begin a multipart upload; returns a backend-specific upload id. */
  createMultipart?(key: string, opts?: { contentType?: string }): Promise<{ uploadId: string }>;
  /** Upload one part (1-indexed). `size` is the byte length of `body`. */
  uploadPart?(
    key: string,
    uploadId: string,
    partNumber: number,
    body: ReadableStream | Uint8Array,
    size: number,
  ): Promise<MultipartPart>;
  /** Assemble the uploaded parts into the final object. */
  completeMultipart?(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<StoredObject>;
  /** Discard an in-progress multipart upload and any staged parts. */
  abortMultipart?(key: string, uploadId: string): Promise<void>;
}
