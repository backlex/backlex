import type {
  EdgeImageAdapter,
  EdgeImageFocal,
  ImageTransform,
} from "@backlex/core";

/**
 * Edge adapter for the native Netlify Image CDN (`/.netlify/images`) — used
 * instead of bundling sharp's native addon into the function. The source must
 * be publicly reachable (public ACL + `R2_PUBLIC_BASE`) and allowlisted via
 * the build's `.netlify/deploy/v1/config.json` `images.remote_images` (written
 * by scripts/build-netlify-fn.ts). Returns a 302 so the edge fetches the
 * source, transforms, and caches; the browser/img tag follows it. Focal has no
 * Netlify equivalent and is ignored.
 */
export const netlifyEdgeImage = (): EdgeImageAdapter => ({
  name: "netlify-image-cdn",
  transformFromUrl(sourceUrl: string, opts: ImageTransform, _focal?: EdgeImageFocal) {
    const p = new URLSearchParams({ url: sourceUrl });
    if (opts.width !== undefined) p.set("w", String(opts.width));
    if (opts.height !== undefined) p.set("h", String(opts.height));
    if (opts.fit) {
      // Netlify supports contain/cover/fill; map our richer enum down.
      const fit =
        opts.fit === "cover" || opts.fit === "outside"
          ? "cover"
          : opts.fit === "fill"
            ? "fill"
            : "contain";
      p.set("fit", fit);
    }
    if (opts.format) p.set("fm", opts.format === "jpeg" ? "jpg" : opts.format);
    if (opts.quality !== undefined) p.set("q", String(opts.quality));
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: `/.netlify/images?${p.toString()}` },
      }),
    );
  },
});
