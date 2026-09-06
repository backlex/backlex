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

  /**
   * The smallest a non-final part may be, in bytes, on THIS backend.
   *
   * `0` means the backend has no minimum. Omitted means "use the deployment
   * policy's default", which is 5 MiB — the figure S3 and R2 both enforce.
   *
   * It has to come from the adapter because the constraint is physical and the
   * backends disagree: S3 and R2 reject an undersized part at COMPLETE, not at
   * upload, so a client chunking at 1 MB transferred an entire file with every
   * PATCH answering 204 and then lost all of it to `EntityTooSmall`. The fs
   * adapter appends to one file and has no such limit, so enforcing 5 MiB there
   * would refuse uploads that work perfectly. Declaring it here is what lets
   * `appendChunk` refuse the FIRST short part on the backends where it matters
   * and stay out of the way on the ones where it does not.
   */
  minPartBytes?: number;
}
