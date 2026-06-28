/**
 * `?expand=` on `relation_many` (to-many) fields — the batch-fetch path that
 * turns a stored array of foreign ids into an array of inlined target rows,
 * without multiplying the base rows. Covers list + by-id, sub-field trim,
 * empty arrays, and dropping ids with no live target row.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("expand relation_many", () => {
  let h: TestHarness;
  let tagRed: string;
  let tagBlue: string;
  let tagGreen: string;
  let postA: string; // [red, blue]
  let postB: string; // [] (no tags)
  let postC: string; // [green, <dangling>]

  const json = async (method: string, path: string, body?: unknown) => {
    const res = await h.fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return res.json();
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    await json("POST", "/api/collections", {
      slug: "tags",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "color", type: "text" },
      ],
    });
    await json("POST", "/api/collections", {
      slug: "posts",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "tags", type: "relation_many", to: "tags" },
      ],
    });

    tagRed = (await json("POST", "/api/items/tags", { name: "Red", color: "#f00" })).data.id;
    tagBlue = (await json("POST", "/api/items/tags", { name: "Blue", color: "#00f" })).data.id;
    tagGreen = (await json("POST", "/api/items/tags", { name: "Green", color: "#0f0" })).data.id;
    // A throwaway tag we'll reference then delete, to exercise the
    // "dangling id is dropped from the expanded array" path. (POST validates
    // relation_many ids at write time, so the reference must be live first.)
    const tagTemp = (await json("POST", "/api/items/tags", { name: "Temp" })).data.id;

    postA = (await json("POST", "/api/items/posts", { title: "A", tags: [tagRed, tagBlue] })).data.id;
    postB = (await json("POST", "/api/items/posts", { title: "B", tags: [] })).data.id;
    postC = (
      await json("POST", "/api/items/posts", { title: "C", tags: [tagGreen, tagTemp] })
    ).data.id;
    // Delete the throwaway tag — postC.tags now carries a dangling id.
    await json("DELETE", `/api/items/tags/${tagTemp}`);
  });

  afterAll(() => h.cleanup());

  test("without expand, the field stays a raw array of ids (regression)", async () => {
    const body = (await json("GET", `/api/items/posts/${postA}`)) as {
      data: { tags: unknown };
    };
    expect(Array.isArray(body.data.tags)).toBe(true);
    expect(body.data.tags).toEqual([tagRed, tagBlue]);
  });

  test("list ?expand=tags inlines the target rows (order preserved)", async () => {
    const body = (await json("GET", "/api/items/posts?expand=tags&sort=title")) as {
      data: { title: string; tags: { id: string; name: string; color: string }[] }[];
    };
    const a = body.data.find((p) => p.title === "A")!;
    expect(a.tags.map((t) => t.name)).toEqual(["Red", "Blue"]);
    expect(a.tags[0]).toMatchObject({ id: tagRed, name: "Red", color: "#f00" });
  });

  test("by-id ?expand=tags inlines the target rows", async () => {
    const body = (await json("GET", `/api/items/posts/${postA}?expand=tags`)) as {
      data: { tags: { id: string; name: string }[] };
    };
    expect(body.data.tags.map((t) => t.id).sort()).toEqual([tagRed, tagBlue].sort());
  });

  test("empty array expands to []", async () => {
    const body = (await json("GET", `/api/items/posts/${postB}?expand=tags`)) as {
      data: { tags: unknown[] };
    };
    expect(body.data.tags).toEqual([]);
  });

  test("dangling / deleted ids are dropped from the expanded array", async () => {
    const body = (await json("GET", `/api/items/posts/${postC}?expand=tags`)) as {
      data: { tags: { id: string; name: string }[] };
    };
    // Only the live tag survives; the bogus uuid is dropped.
    expect(body.data.tags.map((t) => t.name)).toEqual(["Green"]);
  });

  test("sub-field projection trims the inlined objects (fields=tags.name)", async () => {
    // `fields=tags.name` alone routes `tags` into expand with a sub-trim.
    // (Adding `expand=tags` too would mean "expand whole" and win over the trim.)
    const body = (await json(
      "GET",
      `/api/items/posts?fields=title,tags.name&sort=title`,
    )) as {
      data: { title: string; tags: Record<string, unknown>[] }[];
    };
    const a = body.data.find((p) => p.title === "A")!;
    expect(a.tags.length).toBe(2);
    for (const t of a.tags) {
      // id is always present; name requested; color trimmed out.
      expect(Object.keys(t).sort()).toEqual(["id", "name"]);
    }
  });

  test("expand on a non-relation field is a 422", async () => {
    const res = await h.fetch("/api/items/posts?expand=title");
    expect(res.status).toBe(422);
  });

  test("multi-hop expand chain is still rejected (422)", async () => {
    const res = await h.fetch("/api/items/posts?expand=tags.author");
    expect(res.status).toBe(422);
  });
});
