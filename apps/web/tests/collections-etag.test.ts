/**
 * Conditional GET on the schema reads (`/api/collections` + `/:slug`). These
 * are hit on nearly every admin page load and MCP schema tool, so a warm
 * client that already holds the current schema should revalidate into an empty
 * 304 instead of re-transferring the whole list. The validator must bust when
 * the schema changes (a new collection / field).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("collections schema ETag / 304", () => {
  let h: TestHarness;
  const slug = `etagcol_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug, fields: [{ name: "title", type: "text" }] }),
    });
  });
  afterAll(() => h.cleanup());

  test("list GET returns a weak ETag + private revalidation headers", async () => {
    const res = await h.fetch("/api/collections");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^W\//);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
  });

  test("matching If-None-Match → 304 empty body on the list", async () => {
    const etag = (await h.fetch("/api/collections")).headers.get("etag")!;
    const res = await h.fetch("/api/collections", {
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  test("creating a collection busts the list ETag", async () => {
    const before = (await h.fetch("/api/collections")).headers.get("etag")!;
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: `${slug}_b`,
        fields: [{ name: "x", type: "text" }],
      }),
    });
    expect(r.status).toBe(201);
    const res = await h.fetch("/api/collections", {
      headers: { "If-None-Match": before },
    });
    expect(res.status).toBe(200); // schema changed → no 304
  });

  test("single-collection GET supports 304", async () => {
    const first = await h.fetch(`/api/collections/${slug}`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\//);
    const res = await h.fetch(`/api/collections/${slug}`, {
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
  });
});
