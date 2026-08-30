/**
 * One conformance suite, run against every storage backend.
 *
 * `packages/core/src/adapters/storage.ts` declares a `StorageAdapter` interface
 * and four files implement it. TypeScript checks their SHAPES agree; nothing
 * checked their BEHAVIOUR does. Measured before this file: `storage.fs` was
 * well covered because it is what the test harness runs on, and `storage.r2`
 * sat at 1.4%, `storage.s3.bun` at 2.3%, `storage.s3.fetch` at 3.5% — the three
 * that only execute on a real deploy.
 *
 * That is the worst place for an untested divergence. The service layer above
 * feature-detects and otherwise treats them as interchangeable, so a backend
 * that returns `undefined` where another returns `null`, or a `size` read off
 * the wrong field, produces a working local dev server and a broken production
 * one — and the symptom is a file that uploads "successfully" and cannot be
 * read back. This repo's house bug is a 2xx that did nothing.
 *
 * **What a fake can and cannot prove.** The R2 backend is exercised against an
 * in-memory bucket implementing the binding's API. That checks the adapter's
 * own translation — which fields it reads, what it returns for a miss, whether
 * it forwards a prefix — and it does NOT check that Cloudflare's R2 behaves as
 * modelled here. A fake written to agree with the adapter would make the suite
 * agree with itself, so the fake is written against the R2 API's documented
 * shape (`put` → `{size, etag, uploaded}`, `get` → `null` on miss,
 * `list` → `{objects}`) and never against what the adapter happens to want.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageAdapter } from "@backlex/core/adapters";
import { fsStorage } from "../src/server/adapters/storage.fs";
import { r2Storage } from "../src/server/adapters/storage.r2";

/**
 * An in-memory R2Bucket, modelled on the binding's documented surface.
 *
 * Deliberately strict where R2 is strict: `get` answers `null` for a missing
 * key rather than an empty object, and `list` always returns an `objects`
 * array. A lenient fake would let a broken adapter pass.
 */
const fakeR2 = () => {
  const store = new Map<
    string,
    { body: Uint8Array; contentType?: string; etag: string; uploaded: Date }
  >();
  let seq = 0;
  return {
    async put(key: string, body: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      const bytes =
        typeof body === "string"
          ? new TextEncoder().encode(body)
          : body instanceof Uint8Array
            ? body
            : new Uint8Array(await new Response(body as ReadableStream).arrayBuffer());
      const rec = {
        body: bytes,
        contentType: opts?.httpMetadata?.contentType,
        etag: `etag-${++seq}`,
        uploaded: new Date(),
      };
      store.set(key, rec);
      return { size: bytes.byteLength, etag: rec.etag, uploaded: rec.uploaded };
    },
    async get(key: string) {
      const rec = store.get(key);
      if (!rec) return null;
      return {
        body: new Response(rec.body).body,
        size: rec.body.byteLength,
        etag: rec.etag,
        uploaded: rec.uploaded,
        httpMetadata: { contentType: rec.contentType },
      };
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts?: { prefix?: string }) {
      const objects = [...store.entries()]
        .filter(([k]) => !opts?.prefix || k.startsWith(opts.prefix))
        .map(([k, r]) => ({
          key: k,
          size: r.body.byteLength,
          etag: r.etag,
          uploaded: r.uploaded,
          httpMetadata: { contentType: r.contentType },
        }));
      return { objects };
    },
  };
};

let fsRoot: string;
beforeAll(() => {
  fsRoot = mkdtempSync(join(tmpdir(), "backlex-storage-contract-"));
});
afterAll(() => rmSync(fsRoot, { recursive: true, force: true }));

const BACKENDS: Array<[string, () => StorageAdapter]> = [
  ["fs", () => fsStorage(fsRoot)],
  ["r2", () => r2Storage(fakeR2() as never)],
];

const textOf = async (body: ReadableStream) => await new Response(body).text();

for (const [label, make] of BACKENDS) {
  describe(`StorageAdapter conformance — ${label}`, () => {
    test("a stored object reads back byte-for-byte", async () => {
      const s = make();
      const key = `contract/${label}/round-trip.txt`;
      await s.put({ key, body: "hello contract", contentType: "text/plain" });

      const got = await s.get(key);
      expect(`${label}: get returned something: ${got !== null}`).toBe(
        `${label}: get returned something: true`,
      );
      expect(await textOf(got!.body)).toBe("hello contract");
    });

    test("put reports the real size, not zero and not undefined", async () => {
      // `size` reaches the files table and the storage UI. A backend reading it
      // off the wrong field returns `undefined`, which stores as NULL and
      // renders as "NaN KB" — never as an error.
      const s = make();
      const key = `contract/${label}/size.bin`;
      const body = "0123456789"; // ten bytes
      const put = await s.put({ key, body });
      expect(`${label}: ${put.size}`).toBe(`${label}: 10`);
      expect(`${label}: uploadedAt is a Date: ${put.uploadedAt instanceof Date}`).toBe(
        `${label}: uploadedAt is a Date: true`,
      );
    });

    test("a missing key is null, not a throw and not an empty object", async () => {
      // The single most important divergence: the service layer branches on
      // `=== null`. A backend that resolves `undefined` makes that branch fall
      // through and the caller serves an empty body as a 200.
      const s = make();
      const got = await s.get(`contract/${label}/definitely-absent-${Date.now()}`);
      expect(`${label}: ${got}`).toBe(`${label}: null`);
    });

    test("delete makes the object unreadable, and is quiet about a repeat", async () => {
      const s = make();
      const key = `contract/${label}/deleted.txt`;
      await s.put({ key, body: "temporary" });
      expect(await s.get(key)).not.toBeNull();

      await s.delete(key);
      expect(`${label}: after delete: ${await s.get(key)}`).toBe(`${label}: after delete: null`);
      // Deleting twice must not throw — the uploads service retries cleanup,
      // and a backend that throws on the second call turns a tidy-up into a
      // 500 the user sees.
      await s.delete(key);
    });

    test("list filters by prefix and returns an array either way", async () => {
      const s = make();
      const ns = `contract/${label}/list-${Date.now()}`;
      await s.put({ key: `${ns}/a.txt`, body: "a" });
      await s.put({ key: `${ns}/b.txt`, body: "b" });
      await s.put({ key: `${ns}-other/c.txt`, body: "c" });

      const hit = await s.list(`${ns}/`);
      expect(`${label}: ${hit.map((o) => o.key.split("/").pop()).sort().join(",")}`).toBe(
        `${label}: a.txt,b.txt`,
      );

      // An empty result must be `[]`. `undefined` here is the shape that makes
      // the storage page throw on `.map` rather than render an empty state.
      const miss = await s.list(`${ns}/nothing-under-here/`);
      expect(`${label}: empty list is an array: ${Array.isArray(miss)}`).toBe(
        `${label}: empty list is an array: true`,
      );
      expect(miss).toEqual([]);
    });

    test("a full object key is a valid prefix — it lists that one object", async () => {
      // `aws s3 ls s3://bucket/a/file.txt` is legal S3 and `routes/s3.ts` hands
      // `?prefix=` straight to this method. R2 matched the one key; the fs
      // backend resolved the prefix to a FILE and `readdir` threw ENOTDIR, so
      // the same request was a 200 on a Cloudflare deploy and a 500 on a
      // self-hosted one. Found by this suite, fixed in storage.fs.ts.
      const s = make();
      const ns = `contract/${label}/exact-${Date.now()}`;
      await s.put({ key: `${ns}/one.txt`, body: "one" });
      await s.put({ key: `${ns}/two.txt`, body: "two" });

      const hit = await s.list(`${ns}/one.txt`);
      expect(`${label}: ${hit.map((o) => o.key).join(",")}`).toBe(`${label}: ${ns}/one.txt`);
    });

    test("a partial name is a prefix too, not a missing directory", async () => {
      // The other half of the same divergence: `…/inv` is not a directory, and
      // the fs backend answered `[]` where R2 answers with everything under it.
      const s = make();
      const ns = `contract/${label}/partial-${Date.now()}`;
      await s.put({ key: `${ns}/invoice-1.txt`, body: "1" });
      await s.put({ key: `${ns}/invoice-2.txt`, body: "2" });
      await s.put({ key: `${ns}/receipt-1.txt`, body: "3" });

      const hit = await s.list(`${ns}/invoice`);
      expect(`${label}: ${hit.length}`).toBe(`${label}: 2`);
      expect(hit.every((o) => o.key.includes("invoice"))).toBe(true);
    });

    test("every listed object carries the fields the service reads", async () => {
      // `key`, `size` and `uploadedAt` are read unconditionally by the storage
      // listing. A backend omitting one produces a row that renders blank.
      const s = make();
      const key = `contract/${label}/fields-${Date.now()}.txt`;
      await s.put({ key, body: "fields", contentType: "text/plain" });
      const found = (await s.list(key)).find((o) => o.key === key);
      expect(`${label}: object listed: ${Boolean(found)}`).toBe(`${label}: object listed: true`);
      expect(typeof found!.size).toBe("number");
      expect(`${label}: uploadedAt is a Date: ${found!.uploadedAt instanceof Date}`).toBe(
        `${label}: uploadedAt is a Date: true`,
      );
    });
  });
}

describe("the conformance suite covers the backends that exist", () => {
  test("every storage adapter file is either exercised or named as absent", async () => {
    // A new backend added beside these four gets no coverage and nothing says
    // so. This fails the day one appears, which is the only moment anyone is
    // in a position to write its entry.
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(new URL("../src/server/adapters", import.meta.url))
      .filter((f) => /^storage\..*\.ts$/.test(f))
      .map((f) => f.replace(/^storage\.|\.ts$/g, ""));
    expect(files.sort()).toEqual(["fs", "r2", "s3.bun", "s3.fetch"]);

    // The two S3 backends are NOT covered here, and the reason is honest: both
    // sign real AWS SigV4 requests against a live endpoint, so a fake would be
    // re-implementing the signing this suite is meant to check. Their signing
    // is covered separately by `services/s3/sigv4`; what stays untested is
    // their translation layer.
    const covered = BACKENDS.map(([l]) => l);
    expect(covered.sort()).toEqual(["fs", "r2"]);
  });
});
