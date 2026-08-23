import { AppError, MAX_SOURCE_PIXELS } from "@backlex/core";
import type { ImageAdapter, ImageTransform } from "@backlex/core";

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
 *
 * Two constructor options are always passed, and both matter:
 *
 * - `maxPixels` — this adapter decodes bytes a tenant uploaded, reached through
 *   `?width=` on a stored object, which needs no credentials at all when that
 *   object's ACL is public. Bun already defaults to
 *   268.44 MP (16384^2, measured), so this LOWERS an existing ceiling rather
 *   than adding a missing one; see `MAX_SOURCE_PIXELS` for why 268 MP is too
 *   generous to be useful here. Bun raises `ERR_IMAGE_TOO_MANY_PIXELS`, which
 *   we translate to VALIDATION (422) so a hostile image is a bad request
 *   rather than a server error.
 * - `autoOrient` — a PIN, not a fix: Bun 1.4 already defaults it to true, and
 *   it is spelled out here so a future default flip cannot silently start
 *   serving every phone photo's thumbnail sideways. (sharp is the backend
 *   where this was genuinely missing — see the `.rotate()` call in
 *   `image.sharp.ts`, which is what brought the two into agreement.)
 *
 * Available on the instance and deliberately unused for now, so nobody has to
 * re-read the docs to find them: `metadata()` probes {width,height,format}
 * without a full decode, `placeholder()` returns a ~400-700 byte ThumbHash
 * data: URL for LQIP, and `png({palette:true})` quantises to <=256 colours
 * (3-5x smaller for screenshot-shaped images). Each needs a caller before it
 * earns its place here.
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
  metadata: () => Promise<{ width: number; height: number; format: string }>;
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

      let img: BunImageInstance = new Image(input, {
        maxPixels: MAX_SOURCE_PIXELS,
        autoOrient: true,
      });

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

      const bytes = await img.bytes().catch((err: unknown) => {
        // The decode is where `maxPixels` fires, not the constructor — a
        // pipeline does no work until a terminal is awaited.
        if ((err as { code?: string })?.code === "ERR_IMAGE_TOO_MANY_PIXELS") {
          throw new AppError(
            "VALIDATION",
            `Source image exceeds the ${MAX_SOURCE_PIXELS.toLocaleString("en-US")}-pixel transform limit`,
          );
        }
        throw err;
      });
      return {
        body: bytes,
        contentType: `image/${format}`,
      };
    },
  };
};
