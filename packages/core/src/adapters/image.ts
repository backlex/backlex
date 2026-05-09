export interface ImageTransform {
  width?: number;
  height?: number;
  /** `cover` (default), `contain`, `fill`, `inside`, `outside`. */
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";
  /** Output format. Omit to keep the source content type. */
  format?: "webp" | "jpeg" | "png" | "avif";
  /** 0–100. Ignored for lossless formats. */
  quality?: number;
}

export interface TransformedImage {
  body: ReadableStream | ArrayBuffer | Uint8Array;
  contentType: string;
}

export interface ImageAdapter {
  /** Stable name for diagnostics (`bun-image`, `cf-image`, `passthrough`). */
  readonly name: string;
  /**
   * Apply the transform to `body` (any blob shape) and return the encoded
   * result. The original `contentType` is what the caller had on disk.
   */
  transform(
    body: ReadableStream | ArrayBuffer | Uint8Array,
    contentType: string | undefined,
    opts: ImageTransform,
  ): Promise<TransformedImage>;
}
