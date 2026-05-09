import type { ImageAdapter, ImageTransform } from "@workeros/core";

/**
 * Bun built-in image-resize adapter (`Bun.Image`).
 *
 * Constructor: `new Bun.Image(input, options?)` accepts Buffer / TypedArray /
 * ArrayBuffer / Blob / Bun.file(). Chainable transforms (`resize`, `rotate`,
 * `flip`, `flop`, `modulate`), then a format method (`jpeg`/`png`/`webp`/
 * `heic`/`avif`), then a terminal (`bytes`/`buffer`/`blob`/`write`).
 *
 * `Bun.Image` lands in a recent Bun release; older runtimes return `null`
 * here and the storage layer falls back to passthrough.
 */

interface BunImageInstance {
  resize: (
    width?: number,
    height?: number,
    opts?: { fit?: "fill" | "inside"; withoutEnlargement?: boolean },
  ) => BunImageInstance;
  jpeg: (opts?: { quality?: number; progressive?: boolean }) => BunImageInstance;
  png: (opts?: {
    compressionLevel?: number;
    palette?: boolean;
    colors?: number;
    dither?: boolean;
  }) => BunImageInstance;
  webp: (opts?: { quality?: number; lossless?: boolean }) => BunImageInstance;
  avif: (opts?: { quality?: number }) => BunImageInstance;
  heic: (opts?: { quality?: number }) => BunImageInstance;
  bytes: () => Promise<Uint8Array>;
}

interface BunImageCtor {
  new (
    input: ArrayBuffer | Uint8Array | Blob,
    options?: { maxPixels?: number; autoOrient?: boolean },
  ): BunImageInstance;
}

// Bun's `fit` only has two values; map our richer enum down.
const mapFit = (
  fit: ImageTransform["fit"],
): "fill" | "inside" | undefined => {
  if (fit === "contain" || fit === "inside") return "inside";
  if (fit === undefined) return undefined;
  return "fill";
};

const guessFormat = (
  contentType: string | undefined,
): "webp" | "jpeg" | "png" | "avif" | "heic" => {
  if (!contentType) return "webp";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpeg";
  if (contentType.includes("avif")) return "avif";
  if (contentType.includes("heic")) return "heic";
  return "webp";
};

export const bunImage = (): ImageAdapter | null => {
  const bun = (globalThis as { Bun?: { Image?: unknown } }).Bun;
  const Image = bun?.Image as BunImageCtor | undefined;
  if (typeof Image !== "function") return null;

  return {
    name: "bun-image",
    async transform(body, contentType, opts) {
      const input =
        body instanceof ReadableStream
          ? new Uint8Array(await new Response(body).arrayBuffer())
          : body instanceof Uint8Array
            ? body
            : new Uint8Array(body as ArrayBuffer);

      let img: BunImageInstance = new Image(input);

      if (opts.width !== undefined || opts.height !== undefined) {
        const fit = mapFit(opts.fit);
        img = img.resize(opts.width, opts.height, fit ? { fit } : undefined);
      }

      const format = opts.format ?? guessFormat(contentType);
      const qOpt =
        opts.quality !== undefined ? { quality: opts.quality } : undefined;
      switch (format) {
        case "jpeg":
          img = img.jpeg(qOpt);
          break;
        case "png":
          img = img.png();
          break;
        case "webp":
          img = img.webp(qOpt);
          break;
        case "avif":
          img = img.avif(qOpt);
          break;
        case "heic":
          img = img.heic(qOpt);
          break;
      }

      const bytes = await img.bytes();
      return {
        body: bytes,
        contentType: `image/${format}`,
      };
    },
  };
};
