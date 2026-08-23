/**
 * Unit test for the Bun image adapter (`adapters/image.bun.ts`).
 *
 * This is the transform backend on self-hosted Bun, and it is the one that
 * decodes bytes a tenant uploaded — reached through `?width=` on a stored
 * object. So the two properties worth pinning are about the INPUT, not the
 * resize: a declared-huge image must be refused before it is decoded, and a
 * phone photo's EXIF rotation must be applied so the thumbnail matches what
 * every other viewer shows.
 *
 * `bunImage()` feature-detects and returns `null` where `Bun.Image` is absent;
 * the suite runs on Bun, so it is always present here.
 */
import { describe, expect, test } from "bun:test";
import { AppError, MAX_SOURCE_PIXELS } from "@backlex/core";
import sharp from "sharp";
import { bunImage } from "../src/server/adapters/image.bun";

const adapter = bunImage();
if (!adapter) throw new Error("Bun.Image missing — this suite runs on Bun");

/**
 * A 45-byte PNG that declares a huge canvas and carries no pixel data at all.
 * This is the shape of the attack: the cost is in the geometry the header
 * claims, not in the bytes on the wire, so a guard that only looks at
 * Content-Length never sees it. Decoders read IHDR first, which is exactly
 * where `maxPixels` gets to say no — before anything is allocated.
 */
function pixelBombPng(width: number, height: number): Uint8Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (const b of bytes) c = (table[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const tag = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(tag, 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(new Uint8Array([...tag, ...data])));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", ihdr),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
}

/** A real 120x60 JPEG tagged EXIF orientation 6 — "rotate 90° clockwise to
 *  display", which is what a phone held sideways writes. */
async function orientedJpeg(): Promise<Uint8Array> {
  return sharp({
    create: { width: 120, height: 60, channels: 3, background: { r: 0, g: 128, b: 255 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

async function sourcePng(): Promise<Uint8Array> {
  return sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
}

describe("bun image adapter", () => {
  test("resizes and converts to webp", async () => {
    const out = await adapter.transform(await sourcePng(), "image/png", {
      width: 40,
      format: "webp",
      quality: 80,
    });
    expect(out.contentType).toBe("image/webp");
    const meta = await new Bun.Image(out.body as Uint8Array).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(40);
  });

  test("refuses a declared-huge source as VALIDATION, not a 500", async () => {
    // 8192^2 = 67.1 MP is chosen to sit in the gap that makes this test mean
    // something: OVER our 50 MP cap, but well UNDER Bun's own 268.44 MP
    // default. Pick a bigger number (20000^2 = 400 MP was the first draft) and
    // Bun's default rejects it too, so the test passes even with our
    // `maxPixels` deleted — asserting nothing while looking green.
    const bomb = pixelBombPng(8192, 8192);
    expect(bomb.byteLength).toBeLessThan(100);
    expect(8192 * 8192).toBeGreaterThan(MAX_SOURCE_PIXELS);
    expect(8192 * 8192).toBeLessThan(268_000_000);

    const err = await adapter
      .transform(bomb, "image/png", { width: 10, format: "webp" })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("VALIDATION");
    expect((err as AppError).message).toContain("50,000,000");
  });

  test("a source under the limit still transforms", async () => {
    // Guards that reject everything pass their own test. This is the other half.
    const out = await adapter.transform(await sourcePng(), "image/png", { width: 10 });
    expect((out.body as Uint8Array).byteLength).toBeGreaterThan(0);
  });

  // Bun 1.4 already defaults `autoOrient` to true, so this does not prove the
  // option is passed — it guards our own code against someone setting it to
  // false, and it pins the behaviour the sharp adapter was brought into line
  // with (`image-sharp.test.ts` has the version of this test that discriminates).
  test("applies EXIF orientation before resizing", async () => {
    const out = await adapter.transform(await orientedJpeg(), "image/jpeg", {
      width: 30,
      format: "jpeg",
    });
    const meta = await new Bun.Image(out.body as Uint8Array).metadata();
    // Source is 120x60 landscape tagged "rotate 90". Auto-oriented it is 60x120
    // portrait, so a width of 30 gives 30x60. Without autoOrient it would be
    // 30x15 — the sideways thumbnail this guards against.
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 30, height: 60 });
  });
});
