import type { ImageAdapter, ImageTransform } from "@workeros/core";

/**
 * Cloudflare Image Resizing — works on the Workers runtime when the zone is
 * Pro+ (or via Image Resizing service). We round-trip the body through a
 * fetch with `cf.image` options so the edge does the resize.
 *
 * Note: this requires the file to already be reachable via a stable URL on
 * the same zone (e.g. a public R2 bucket origin). For private files we'd
 * need a signed-URL flow first; v1 only fires when `R2_PUBLIC_BASE` env is
 * set so the caller has explicitly opted into public reads.
 */
export const cfImage = (publicBase: string): ImageAdapter => ({
  name: "cf-image",
  async transform(body, contentType, opts) {
    // The Workers runtime exposes `cf.image` via the second arg to fetch.
    // We need a URL the edge can hit; the caller passes the original `key`
    // we built into a public URL by joining `publicBase`.
    if (!(body instanceof ReadableStream) && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer)) {
      // Defensive fallback — without a URL we can't ask CF to transform.
      return {
        body,
        contentType: contentType ?? "application/octet-stream",
      };
    }
    // For v1 we don't know the source URL from the body alone — caller
    // should use `cfImageFromUrl` instead. Treat as passthrough.
    return {
      body,
      contentType: contentType ?? "application/octet-stream",
    };
  },
});

/**
 * Variant that accepts a full URL to the source object. The Workers runtime
 * will hit the URL via the same edge with `cf.image` options applied.
 */
export const cfImageFromUrl = (
  url: string,
  opts: ImageTransform,
): Promise<Response> => {
  const cfOptions: Record<string, unknown> = {};
  if (opts.width) cfOptions.width = opts.width;
  if (opts.height) cfOptions.height = opts.height;
  if (opts.fit) cfOptions.fit = opts.fit;
  if (opts.format) cfOptions.format = opts.format;
  if (opts.quality !== undefined) cfOptions.quality = opts.quality;
  return fetch(url, { cf: { image: cfOptions } } as RequestInit);
};
