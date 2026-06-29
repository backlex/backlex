/**
 * Conditional GET on the single-item read: a weak ETag + `If-None-Match` →
 * 304 Not Modified with no body, and the validator changes when the row is
 * updated so a stale cache never wins.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("ETag / 304 conditional GET", () => {
  let h: TestHarness;
  const slug = `etag_${Date.now()}`;
  let id = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug, fields: [{ name: "title", type: "text" }] }),
    });
    const r = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "v1" }),
    });
    id = ((await r.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("GET returns a weak ETag + private revalidation headers", async () => {
    const res = await h.fetch(`/api/items/${slug}/${id}`);
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^W\//);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary") ?? "").toContain("Authorization");
  });

  test("If-None-Match with the current ETag → 304 with empty body", async () => {
    const first = await h.fetch(`/api/items/${slug}/${id}`);
    const etag = first.headers.get("etag")!;
    const res = await h.fetch(`/api/items/${slug}/${id}`, {
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    // The 304 still carries a usable ETag for the next round.
    expect(res.headers.get("etag")).toBe(etag);
  });

  test("a stale ETag does NOT 304", async () => {
    const res = await h.fetch(`/api/items/${slug}/${id}`, {
      headers: { "If-None-Match": 'W/"deadbeef"' },
    });
    expect(res.status).toBe(200);
  });

  test("updating the row invalidates the old ETag", async () => {
    const before = (await h.fetch(`/api/items/${slug}/${id}`)).headers.get("etag")!;
    // Bump updated_at via a PATCH.
    const patch = await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "v2" }),
    });
    expect(patch.status).toBeLessThan(400);
    const after = await h.fetch(`/api/items/${slug}/${id}`, {
      headers: { "If-None-Match": before },
    });
    // Old validator must NOT match the updated row.
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(before);
  });
});
