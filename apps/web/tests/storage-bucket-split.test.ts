/**
 * Public and private objects in separate buckets.
 *
 * **The hole.** Enabling R2's dev URL makes *every* object in the bucket
 * fetchable at `https://pub-<hash>.r2.dev/<key>` by anyone who can guess the
 * key. The product needs that URL — it is how a public image gets resized at
 * the edge instead of streaming through the Worker — but a workspace's private
 * files, its backups, its generated PDFs and its avatars were in the same
 * bucket. `acl` was enforced at the Worker, and that URL is exactly what skips
 * the Worker. A flag on `put()` could never fix it: the exposure is a property
 * of the bucket, so the fix is that they are not the same bucket.
 *
 * These tests drive the seam directly with two in-memory adapters rather than
 * through R2, because what has to be proven is *which bucket an object is in* —
 * and no HTTP response can show that. The one thing that would make the split
 * useless is a private object sitting in the world-readable bucket, so most of
 * what follows is an assertion about the private adapter NOT holding something,
 * or the public one not holding it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StorageAdapter, StoredObject } from "@backlex/core/adapters";
import {
  bucketFor,
  deleteEverywhere,
  dropStaleCopy,
  hasSplitBuckets,
  moveBetweenBuckets,
} from "../src/server/services/storage/bucket-for";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/** A bucket you can look inside. `list`/multipart are unused by these paths. */
const fakeBucket = (name: string) => {
  const objects = new Map<string, { body: Uint8Array<ArrayBuffer>; contentType?: string }>();
  const adapter: StorageAdapter = {
    async put({ key, body, contentType }) {
      const bytes =
        body instanceof Uint8Array
          ? (body as Uint8Array<ArrayBuffer>)
          : typeof body === "string"
            ? new TextEncoder().encode(body)
            : body instanceof ArrayBuffer
              ? new Uint8Array(body)
              : new Uint8Array(await new Response(body as ReadableStream).arrayBuffer());
      objects.set(key, { body: bytes, contentType });
      return {
        key,
        size: bytes.byteLength,
        contentType,
        uploadedAt: new Date(),
      } satisfies StoredObject;
    },
    async get(key) {
      const hit = objects.get(key);
      if (!hit) return null;
      return {
        body: new Response(hit.body).body as ReadableStream,
        meta: {
          key,
          size: hit.body.byteLength,
          contentType: hit.contentType,
          uploadedAt: new Date(),
        },
      };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list() {
      return [];
    },
  };
  return { name, adapter, objects };
};

describe("storage — public/private bucket split", () => {
  let priv: ReturnType<typeof fakeBucket>;
  let pub: ReturnType<typeof fakeBucket>;
  let ctx: { storage: StorageAdapter; publicStorage?: StorageAdapter };

  beforeEach(() => {
    priv = fakeBucket("private");
    pub = fakeBucket("public");
    ctx = { storage: priv.adapter, publicStorage: pub.adapter };
  });

  test("a deployment with one bucket behaves exactly as it always has", () => {
    const single = { storage: priv.adapter };
    expect(hasSplitBuckets(single)).toBe(false);
    // Both ACLs answer with the same adapter, so no existing install moves,
    // re-reads, or breaks by upgrading.
    expect(bucketFor(single, "public")).toBe(priv.adapter);
    expect(bucketFor(single, "private")).toBe(priv.adapter);
  });

  test("only a public ACL reaches the public bucket", () => {
    expect(hasSplitBuckets(ctx)).toBe(true);
    expect(bucketFor(ctx, "public")).toBe(pub.adapter);
    expect(bucketFor(ctx, "private")).toBe(priv.adapter);
    // A row written before the column existed, and anything with no ACL at all
    // — backups, generated documents, avatars — reads as private. That is the
    // safe direction and the one that cannot rot as new writers are added.
    expect(bucketFor(ctx, null)).toBe(priv.adapter);
    expect(bucketFor(ctx, undefined)).toBe(priv.adapter);
  });

  test("making a file public moves the bytes, and leaves none behind", async () => {
    await priv.adapter.put({ key: "tenants/t1/a.png", body: "PNG", contentType: "image/png" });

    expect(await moveBetweenBuckets(ctx, "tenants/t1/a.png", "private", "public")).toBe(true);

    // The whole point: the public bucket has it and the private one does not.
    expect(pub.objects.has("tenants/t1/a.png")).toBe(true);
    expect(priv.objects.has("tenants/t1/a.png")).toBe(false);
    // And the bytes survived the trip — a move that empties the file is worse
    // than one that does not happen.
    const moved = await pub.adapter.get("tenants/t1/a.png");
    expect(await new Response(moved!.body).text()).toBe("PNG");
    expect(moved!.meta.contentType).toBe("image/png");
  });

  test("making a file private takes it OUT of the world-readable bucket", async () => {
    await pub.adapter.put({ key: "tenants/t1/leak.pdf", body: "SECRET" });

    expect(await moveBetweenBuckets(ctx, "tenants/t1/leak.pdf", "public", "private")).toBe(true);

    // This is the assertion the feature exists for. While that object stays in
    // the public bucket, `https://pub-….r2.dev/tenants/t1/leak.pdf` serves it
    // to anyone, no matter what the row says.
    expect(pub.objects.has("tenants/t1/leak.pdf")).toBe(false);
    expect(priv.objects.has("tenants/t1/leak.pdf")).toBe(true);
  });

  test("a move whose source is missing refuses instead of reporting success", async () => {
    // A row that claims an object which is not there is a real problem. Moving
    // it "successfully" would write the row as public with nothing behind it,
    // and the 404 would arrive much later, to somebody else.
    await expect(
      moveBetweenBuckets(ctx, "tenants/t1/ghost.png", "private", "public"),
    ).rejects.toThrow(/missing from its current bucket/);
    expect(pub.objects.size).toBe(0);
  });

  test("a move to the same side is a no-op that says so", async () => {
    await priv.adapter.put({ key: "k", body: "x" });
    expect(await moveBetweenBuckets(ctx, "k", "private", "private")).toBe(false);
    // And with no public bucket there is nothing to move to, which must also
    // answer false rather than throwing — the single-bucket path runs this.
    expect(await moveBetweenBuckets({ storage: priv.adapter }, "k", "private", "public")).toBe(
      false,
    );
    expect(priv.objects.has("k")).toBe(true);
  });

  test("re-importing over a key clears whatever the other bucket still held", async () => {
    // `/from-url` resets the ACL on re-import, so an object can change sides
    // without a move. The old copy has to go, or a file re-imported as private
    // keeps serving from the CDN.
    await pub.adapter.put({ key: "tenants/t1/logo.png", body: "OLD-PUBLIC" });
    await priv.adapter.put({ key: "tenants/t1/logo.png", body: "NEW-PRIVATE" });

    await dropStaleCopy(ctx, "tenants/t1/logo.png", "private");

    expect(pub.objects.has("tenants/t1/logo.png")).toBe(false);
    expect(priv.objects.has("tenants/t1/logo.png")).toBe(true);
  });

  test("a delete removes the object from EVERY bucket, without being told which", async () => {
    // The rule the read path deliberately does NOT follow, and the asymmetry is
    // the reason: a read from the wrong bucket is a 404 — visible, recoverable.
    // A delete from the wrong bucket is a SILENT no-op, because delete is
    // idempotent by contract on every adapter. The row goes, the bytes stay
    // world-readable, and nothing is left that points at them.
    //
    // This is not hypothetical: data-subject erasure and the playground reset
    // both select `{ key }` with no ACL to route on, and would have reported a
    // complete erasure while leaving the person's public files served forever.
    await pub.adapter.put({ key: "tenants/t1/erase-me.png", body: "PII" });
    await priv.adapter.put({ key: "tenants/t1/erase-me.png", body: "PII" });

    expect((await deleteEverywhere(ctx, "tenants/t1/erase-me.png")).ok).toBe(true);

    expect(pub.objects.has("tenants/t1/erase-me.png")).toBe(false);
    expect(priv.objects.has("tenants/t1/erase-me.png")).toBe(false);
  });

  test("a delete reports a bucket it could not reach, instead of throwing", async () => {
    // An unreachable public bucket must not abort an erasure that has already
    // destroyed rows — but the caller has to be able to count it.
    const exploding: StorageAdapter = {
      ...pub.adapter,
      async delete() {
        throw new Error("bucket unreachable");
      },
    };
    await priv.adapter.put({ key: "k", body: "x" });
    const out = await deleteEverywhere(
      { storage: priv.adapter, publicStorage: exploding },
      "k",
    );
    expect(out.ok).toBe(false);
    // …and it still deleted what it could.
    expect(priv.objects.has("k")).toBe(false);
  });

  test("tidying is best-effort — it reports, it does not fail the write", async () => {
    const exploding: StorageAdapter = {
      ...pub.adapter,
      async delete() {
        throw new Error("bucket unreachable");
      },
    };
    // The object is already correctly placed by the time this runs, so a
    // failure to tidy must not turn a good upload into a 500.
    await dropStaleCopy({ storage: priv.adapter, publicStorage: exploding }, "k", "private");
  });
});

describe("storage — the split migration endpoint", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  test("refuses when there is no public bucket to move into", async () => {
    const res = await h.fetch("/api/storage/_split-buckets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    // Refusing beats reporting "0 moved": a caller who ran this expecting the
    // hole to be closed must not be told it succeeded.
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("No public bucket is configured");
  });
});
