import type { ImageAdapter, ImageTransform } from "@backlex/core";

/**
 * `sharp`-based image-resize adapter for Node serverless runtimes
 * (Vercel / Netlify Functions on Node 22) and any plain Node host.
 *
 * Bun self-host uses `Bun.Image` (selected first); Cloudflare Workers resize
 * at the edge via CF Image Resizing. `sharp` fills the gap for Node Lambdas,
 * which otherwise fell back to passthrough (transform → 422).
 *
 * `sharp` is a native addon (`@img/sharp-<platform>`), so it can't run on the
 * Workers V8 isolate and can't be bundled into the single-file Lambda. The
 * selector is therefore:
 *   1. gated to Node-only runtimes (no Bun, no Workers), and
 *   2. resolved with a guarded dynamic import — if `sharp` isn't actually
 *      installed / loadable in this Lambda, `sharpImage()` returns `null` and
 *      the storage layer falls back to passthrough (a clean 422), never a 500.
 *
 * Unlike `Bun.Image`'s two-value `fit`, sharp's `fit` enum is exactly our
 * `ImageTransform["fit"]` (cover/contain/fill/inside/outside) — no mapping.
 */

interface SharpInstance {
  resize: (
    width?: number,
    height?: number,
    opts?: { fit?: ImageTransform["fit"]; withoutEnlargement?: boolean },
  ) => SharpInstance;
  jpeg: (opts?: { quality?: number }) => SharpInstance;
  png: (opts?: { quality?: number }) => SharpInstance;
  webp: (opts?: { quality?: number }) => SharpInstance;
  avif: (opts?: { quality?: number }) => SharpInstance;
  toBuffer: () => Promise<Uint8Array>;
}
type SharpCtor = (input: Uint8Array | ArrayBuffer) => SharpInstance;

const guessFormat = (
  contentType: string | undefined,
): "webp" | "jpeg" | "png" | "avif" => {
  if (!contentType) return "webp";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpeg";
  if (contentType.includes("avif")) return "avif";
  return "webp";
};

/**
 * Returns the sharp adapter on Node runtimes where `sharp` loads, else `null`.
 * Async because it probes the native module with a dynamic import; `null` keeps
 * the caller on the passthrough path (no transform backend → 422), never a 500.
 */
export const sharpImage = async (): Promise<ImageAdapter | null> => {
  const g = globalThis as {
    Bun?: unknown;
    WebSocketPair?: unknown;
    process?: { versions?: { node?: string } };
  };
  // Bun has its own adapter; Workers (WebSocketPair, V8 isolate) can't load a
  // native addon. Only continue on a real Node runtime.
  if (g.Bun || g.WebSocketPair || !g.process?.versions?.node) return null;

  let sharp: SharpCtor;
  try {
    // Dynamic import so the Workers bundler never statically pulls the native
    // addon, and so a Lambda missing the binary degrades to passthrough.
    sharp = ((await import("sharp")) as { default: SharpCtor }).default;
    if (typeof sharp !== "function") return null;
  } catch {
    return null;
  }

  return makeSharpAdapter(sharp);
};

/**
 * Builds the adapter from a resolved `sharp` constructor. Separated from the
 * runtime gate/import above so it's unit-testable directly (the gate returns
 * null under Bun, where the test runner lives).
 */
export const makeSharpAdapter = (sharp: SharpCtor): ImageAdapter => {
  return {
    name: "sharp",
    async transform(body, contentType, opts) {
      const input =
        body instanceof ReadableStream
          ? new Uint8Array(await new Response(body).arrayBuffer())
          : body instanceof Uint8Array
            ? body
            : new Uint8Array(body as ArrayBuffer);

      let img = sharp(input);
      if (opts.width !== undefined || opts.height !== undefined) {
        img = img.resize(opts.width, opts.height, {
          ...(opts.fit ? { fit: opts.fit } : {}),
          withoutEnlargement: true,
        });
      }

      const format = opts.format ?? guessFormat(contentType);
      const qOpt =
        opts.quality !== undefined ? { quality: opts.quality } : undefined;
      switch (format) {
        case "jpeg":
          img = img.jpeg(qOpt);
          break;
        case "png":
          img = img.png(qOpt);
          break;
        case "webp":
          img = img.webp(qOpt);
          break;
        case "avif":
          img = img.avif(qOpt);
          break;
      }

      return { body: await img.toBuffer(), contentType: `image/${format}` };
    },
  };
};
