import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { __collectionsCacheSize } from "../src/server/services/collections-cache";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * The `GET /api/collections` list is served from a per-isolate cache. These
 * tests pin the contract that matters: the cache must never serve a stale list
 * across a mutation — create, rename, and delete each have to invalidate it, or
 * the admin UI would show a schema that no longer matches the database.
 */
describe("collections list cache invalidation", () => {
  let h: TestHarness;
  const slug = `cached_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  const list = async (): Promise<string[]> => {
    const res = await h.fetch("/api/collections");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { slug: string }[] };
    return body.data.map((c) => c.slug);
  };

  test("create is reflected immediately (no stale cached list)", async () => {
    // Prime the cache with a list that does NOT contain the new slug.
    expect(await list()).not.toContain(slug);
    // A second read should now be a cache hit (entry present).
    await list();
    expect(__collectionsCacheSize()).toBeGreaterThan(0);

    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });
    expect(create.status).toBe(201);

    // Without invalidation this would still serve the primed (stale) list.
    expect(await list()).toContain(slug);
  });

  test("rename is reflected immediately", async () => {
    const renamed = `${slug}_v2`;
    await list(); // re-prime
    const patch = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: renamed }),
    });
    expect(patch.status).toBe(200);
    const after = await list();
    expect(after).toContain(renamed);
    expect(after).not.toContain(slug);
  });

  test("delete is reflected immediately", async () => {
    const renamed = `${slug}_v2`;
    await list(); // re-prime so the entry is cached before delete
    const del = await h.fetch(`/api/collections/${renamed}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await list()).not.toContain(renamed);
  });
});
