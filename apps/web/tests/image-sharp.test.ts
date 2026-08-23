/**
 * Unit test for the sharp image adapter (`adapters/image.sharp.ts`).
 *
 * The adapter powers image transforms on Node serverless runtimes
 * (Vercel / Netlify), where `Bun.Image` isn't available. `sharpImage()` gates
 * itself off under Bun (where this test runs), so we exercise the underlying
 * `makeSharpAdapter(sharp)` factory directly with the real `sharp` module —
 * proving the transform (resize + format + quality) produces a valid encoded
 * image with the requested dimensions and content type.
 */
import { describe, expect, test } from "bun:test";
import { AppError, MAX_SOURCE_PIXELS } from "@backlex/core";
import sharp from "sharp";
import { makeSharpAdapter } from "../src/server/adapters/image.sharp";

type Ctor = Parameters<typeof makeSharpAdapter>[0];

/** A real 120×60 JPEG tagged EXIF orientation 6 — "rotate 90° clockwise to
 *  display", which is what a phone held sideways writes. */
async function orientedJpeg(): Promise<Uint8Array> {
  return sharp({
    create: { width: 120, height: 60, channels: 3, background: { r: 0, g: 128, b: 255 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

// A 100×100 red PNG to feed the adapter.
async function sourcePng(): Promise<Uint8Array> {
  return sharp({
    create: {
      width: 100,
      height: 100,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
}

describe("sharp image adapter", () => {
  const adapter = makeSharpAdapter(sharp as unknown as Parameters<typeof makeSharpAdapter>[0]);

  test("resizes and converts to webp", async () => {
    const out = await adapter.transform(await sourcePng(), "image/png", {
      width: 40,
      format: "webp",
      quality: 80,
    });
    expect(out.contentType).toBe("image/webp");
    const meta = await sharp(out.body as Uint8Array).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(40);
  });

  test("keeps source format when none requested (png → png guess)", async () => {
    const out = await adapter.transform(await sourcePng(), "image/png", {
      width: 25,
    });
    expect(out.contentType).toBe("image/png");
    const meta = await sharp(out.body as Uint8Array).metadata();
    expect(meta.width).toBe(25);
  });

  test("does not enlarge beyond the source", async () => {
    const out = await adapter.transform(await sourcePng(), "image/png", {
      width: 500,
      format: "jpeg",
    });
    const meta = await sharp(out.body as Uint8Array).metadata();
    // withoutEnlargement caps at the 100px source width.
    expect(meta.width).toBe(100);
    expect(meta.format).toBe("jpeg");
  });
});

/**
 * The two input-side properties, which are about what the adapter accepts
 * rather than what it produces. Both were added to bring this backend into
 * agreement with `Bun.Image` — on the same tagged JPEG the two used to return
 * differently-shaped thumbnails, which is a worse bug than either one alone.
 */
describe("sharp image adapter — input handling", () => {
  const adapter = makeSharpAdapter(sharp as unknown as Ctor);

  test("applies EXIF orientation before resizing", async () => {
    const out = await adapter.transform(await orientedJpeg(), "image/jpeg", {
      width: 30,
      format: "jpeg",
    });
    const meta = await sharp(out.body as Uint8Array).metadata();
    // 120×60 landscape tagged "rotate 90" is 60×120 portrait once oriented, so
    // width 30 gives 30×60. Without `.rotate()` sharp ignores the tag and
    // returns 30×15 — the sideways thumbnail, and the shape `Bun.Image` never
    // produced because it auto-orients by default.
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 30, height: 60 });
  });

  test("constructs sharp with our pixel ceiling, not its own 268 MP default", async () => {
    let seen: { limitInputPixels?: number } | undefined;
    const spy = ((input: Uint8Array | ArrayBuffer, options?: { limitInputPixels?: number }) => {
      seen = options;
      return (sharp as unknown as Ctor)(input, options);
    }) as Ctor;

    await makeSharpAdapter(spy).transform(await sourcePng(), "image/png", { width: 10 });
    expect(seen?.limitInputPixels).toBe(MAX_SOURCE_PIXELS);
  });

  test("translates sharp's pixel-limit error into a VALIDATION", async () => {
    // sharp attaches no `code` to this one, so the adapter matches on the
    // message. A stub reproduces it exactly rather than allocating a real
    // 50-megapixel source just to be refused.
    const throwing = (() => ({
      rotate: () => throwing(0 as never),
      resize: () => throwing(0 as never),
      jpeg: () => throwing(0 as never),
      png: () => throwing(0 as never),
      webp: () => throwing(0 as never),
      avif: () => throwing(0 as never),
      toBuffer: () => Promise.reject(new Error("Input image exceeds pixel limit")),
    })) as unknown as Ctor;

    const err = await makeSharpAdapter(throwing)
      .transform(new Uint8Array([1, 2, 3]), "image/png", { width: 10 })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("VALIDATION");
    expect((err as AppError).message).toContain("50,000,000");
  });
});
