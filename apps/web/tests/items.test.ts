import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("collections + items CRUD as admin", () => {
  let h: TestHarness;
  const slug = `notes_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("create collection, list it, fetch by slug", async () => {
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "body", type: "longtext" },
        ],
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { data: { slug: string; physicalTable: string } };
    expect(created.data.slug).toBe(slug);
    expect(created.data.physicalTable.endsWith(slug)).toBe(true);

    const list = await h.fetch("/api/collections");
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { data: { slug: string }[] };
    expect(listed.data.some((c) => c.slug === slug)).toBe(true);

    const get = await h.fetch(`/api/collections/${slug}`);
    expect(get.status).toBe(200);
  });

  test("insert, list, update, delete an item", async () => {
    const create = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "hello", body: "first note" }),
    });
    expect(create.status).toBe(201);
    const inserted = (await create.json()) as { data: { id: string; title: string } };
    expect(inserted.data.title).toBe("hello");
    const id = inserted.data.id;

    const list = await h.fetch(`/api/items/${slug}`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: { id: string }[] };
    expect(body.data.some((r) => r.id === id)).toBe(true);

    const patch = await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "renamed" }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { data: { title: string } };
    expect(patched.data.title).toBe("renamed");

    const del = await h.fetch(`/api/items/${slug}/${id}`, { method: "DELETE" });
    expect(del.status).toBeLessThan(400);

    const after = await h.fetch(`/api/items/${slug}/${id}`);
    expect(after.status).toBe(404);
  });

  test("filter DSL: _eq matches inserted row, _neq excludes it", async () => {
    await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "unique-match", body: "x" }),
    });
    const filterEq = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(JSON.stringify({ title: { _eq: "unique-match" } }))}`,
    );
    expect(filterEq.status).toBe(200);
    const eqBody = (await filterEq.json()) as { data: { title: string }[] };
    expect(eqBody.data.length).toBe(1);

    const filterNeq = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(JSON.stringify({ title: { _neq: "unique-match" } }))}`,
    );
    const neqBody = (await filterNeq.json()) as { data: { title: string }[] };
    expect(neqBody.data.every((r) => r.title !== "unique-match")).toBe(true);
  });
});
