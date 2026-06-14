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
import sharp from "sharp";
import { makeSharpAdapter } from "../src/server/adapters/image.sharp";

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
