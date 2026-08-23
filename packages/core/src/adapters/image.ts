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

/**
 * Ceiling on the *decoded* pixel count of a transform source, enforced by every
 * byte-in/byte-out {@link ImageAdapter}.
 *
 * The transform query already caps the OUTPUT at 4096x4096, but the input is
 * whatever a tenant uploaded, and image formats compress geometry as cheaply as
 * they compress colour: a few kilobytes of PNG can declare a canvas of a
 * hundred thousand square, and decoding it is what allocates. Without a cap,
 * `?width=` on a public object is a way to ask the runtime for gigabytes with
 * one cheap request.
 *
 * Neither backend was unbounded before this: `Bun.Image` defaults to 268.44 MP
 * (16384^2, measured) and sharp to 268.40 MP (0x3FFF^2). Those are the same
 * number twice, and it is a sanity ceiling rather than a budget — 268 MP of
 * RGBA is about 1.07 GB, which no serverless runtime here survives. 50 MP
 * takes the worst case to roughly 200 MB while still clearing every camera
 * anyone actually uploads from: 48 MP phone sensors, every current full-frame
 * body.
 *
 * Exceeding it is a VALIDATION error (422), not a 500: the request is bad, the
 * server is fine.
 */
export const MAX_SOURCE_PIXELS = 50_000_000;

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
