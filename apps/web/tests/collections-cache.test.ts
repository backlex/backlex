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

/**
 * `loadCollection` resolves the single `(tenant, slug)` collection row on the
 * items CRUD hot path from a per-isolate cache. The risk a cache introduces is
 * a *stale schema*: if a field is added but the cached row still lists the old
 * field set, a write referencing the new field would be silently dropped. These
 * tests pin that a schema mutation invalidates the single-collection cache too,
 * exercised end-to-end through the items endpoints (not the cache API directly).
 */
describe("single-collection cache invalidation (items hot path)", () => {
  let h: TestHarness;
  const slug = `hotpath_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });
    expect(create.status).toBe(201);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("a field added after the schema is cached is honored on the next write", async () => {
    // Prime the single-collection cache via the items read path.
    const primed = await h.fetch(`/api/items/${slug}`);
    expect(primed.status).toBe(200);

    // Add a second field. PATCH runs the additive applyCollection, so the
    // physical column exists; the route must also invalidate the cached row.
    const patch = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: [
          { name: "title", type: "text", required: true },
          { name: "subtitle", type: "text" },
        ],
      }),
    });
    expect(patch.status).toBe(200);

    // Write a row using the new field. With a stale cached schema the handler
    // wouldn't know `subtitle` and would drop it; invalidation makes it persist.
    const post = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "t", subtitle: "kept" }),
    });
    expect(post.status).toBe(201);
    const created = (await post.json()) as { data: { id: string; subtitle?: string } };

    const get = await h.fetch(`/api/items/${slug}/${created.data.id}`);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { data: { subtitle?: string } };
    expect(body.data.subtitle).toBe("kept");
  });
});
