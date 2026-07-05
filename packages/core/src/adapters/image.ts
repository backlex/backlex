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

/** Focal point for `fit=cover` crops, in 0–100 percent coordinates (the same
 *  units the `?focal=x,y` query param carries). Adapters map to their
 *  backend's convention; backends without focal support ignore it. */
export interface EdgeImageFocal {
  x: number;
  y: number;
}

/**
 * URL-based edge transform backend (Cloudflare Image Resizing, Netlify Image
 * CDN, …). Unlike {@link ImageAdapter} it never sees the object bytes — the
 * source must be publicly reachable, and the returned `Response` either
 * carries the transformed bytes (edge fetch) or redirects the client to a CDN
 * endpoint that will. Selected per-runtime in `buildContext`; callers treat it
 * as an optimization in front of `ImageAdapter`, not a replacement.
 */
export interface EdgeImageAdapter {
  /** Stable name for diagnostics (`cf-image-resizing`, `netlify-image-cdn`). */
  readonly name: string;
  transformFromUrl(
    sourceUrl: string,
    opts: ImageTransform,
    focal?: EdgeImageFocal,
  ): Promise<Response>;
}
