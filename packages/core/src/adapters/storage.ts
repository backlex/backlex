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

export interface StorageAdapter {
  put(input: PutObjectInput): Promise<StoredObject>;
  get(key: string): Promise<{ body: ReadableStream; meta: StoredObject } | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<StoredObject[]>;
  signedUrl?(key: string, ttlSeconds: number): Promise<string>;
}
