import type { ImageAdapter, ImageTransform } from "@backlex/core";

/**
 * WASM image-resize adapter (Photon) — the fallback for runtimes where neither
 * `Bun.Image` nor `sharp` (native) is available, chiefly **Deno**, which can't
 * load sharp's native addon. Pure WASM, so it runs anywhere; gated below to the
 * runtimes that actually need it so the Photon WASM blob never loads on
 * Bun/Workers (where `Bun.Image` / Cloudflare Image Resizing handle transforms).
 *
 * Photon is dynamically imported so the WASM stays out of every bundle's
 * cold-start graph; the 3 Node bundlers keep `@cf-wasm/photon` external and the
 * Workers build aliases it to a shim — it's only ever executed on Deno.
 */
interface PhotonImageInstance {
  get_width(): number;
  get_height(): number;
  get_bytes(): Uint8Array; // PNG
  get_bytes_jpeg(quality: number): Uint8Array;
  get_bytes_webp(): Uint8Array;
  free(): void;
}
interface PhotonModule {
  PhotonImage: { new_from_byteslice(bytes: Uint8Array): PhotonImageInstance };
  resize: (
    img: PhotonImageInstance,
    width: number,
    height: number,
    filter: number,
  ) => PhotonImageInstance;
}

const guessFormat = (
  contentType: string | undefined,
): "webp" | "jpeg" | "png" => {
  if (!contentType) return "webp";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpeg";
  return "webp";
};

/**
 * Returns the Photon-WASM adapter when needed (no Bun, no Workers) and Photon
 * loads, else `null` (caller falls through to passthrough). Async because it
 * probes the WASM module.
 */
export const wasmImage = async (): Promise<ImageAdapter | null> => {
  const g = globalThis as { Bun?: unknown; WebSocketPair?: unknown };
  // Bun → Bun.Image; Workers → CF Image Resizing. Don't pull WASM there.
  if (g.Bun || g.WebSocketPair) return null;

  let photon: PhotonModule;
  try {
    photon = (await import("@cf-wasm/photon")) as unknown as PhotonModule;
    if (typeof photon?.PhotonImage?.new_from_byteslice !== "function") return null;
  } catch {
    return null;
  }

  return {
    name: "wasm-photon",
    async transform(body, contentType, opts) {
      const input =
        body instanceof ReadableStream
          ? new Uint8Array(await new Response(body).arrayBuffer())
          : body instanceof Uint8Array
            ? body
            : new Uint8Array(body as ArrayBuffer);

      let img = photon.PhotonImage.new_from_byteslice(input);
      try {
        if (opts.width !== undefined || opts.height !== undefined) {
          const ow = img.get_width();
          const oh = img.get_height();
          // Photon's resize needs both dims; derive the missing one from aspect
          // ratio and never enlarge past the source (matches Bun/sharp).
          let w = opts.width ?? Math.round((ow * (opts.height ?? oh)) / oh);
          let h = opts.height ?? Math.round((oh * (opts.width ?? ow)) / ow);
          w = Math.min(w, ow);
          h = Math.min(h, oh);
          const resized = photon.resize(img, w, h, 1 /* Lanczos3 */);
          img.free();
          img = resized;
        }
        // Photon encodes webp/jpeg/png; avif isn't supported → fall back to webp.
        const requested = opts.format === "avif" ? "webp" : opts.format;
        const format = requested ?? guessFormat(contentType);
        const bytes =
          format === "jpeg"
            ? img.get_bytes_jpeg(opts.quality ?? 80)
            : format === "png"
              ? img.get_bytes()
              : img.get_bytes_webp();
        return { body: bytes, contentType: `image/${format}` };
      } finally {
        img.free();
      }
    },
  };
};
