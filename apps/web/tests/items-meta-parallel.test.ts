import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const J = { "Content-Type": "application/json" };

describe("items list meta=* (parallel count path)", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const c = await h.fetch("/api/collections", {
      method: "POST",
      headers: J,
      body: JSON.stringify({
        slug: "widgets",
        fields: [
          { name: "name", type: "text" },
          { name: "status", type: "text" },
        ],
      }),
    });
    expect(c.status).toBe(201);
    // 3 published, 2 draft → 5 total
    for (const [name, status] of [
      ["a", "published"], ["b", "published"], ["c", "published"],
      ["d", "draft"], ["e", "draft"],
    ] as const) {
      const r = await h.fetch("/api/items/widgets", {
        method: "POST", headers: J, body: JSON.stringify({ name, status }),
      });
      expect(r.status).toBe(201);
    }
  });

  afterAll(() => h.cleanup());

  test("meta=* returns correct filter_count AND total_count with a filter", async () => {
    const filter = encodeURIComponent(JSON.stringify({ status: { _eq: "published" } }));
    const res = await h.fetch(`/api/items/widgets?meta=*&filter=${filter}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      meta: { filter_count: number; total_count: number };
    };
    expect(body.data.length).toBe(3);        // filtered rows returned
    expect(body.meta.filter_count).toBe(3);  // matches filter
    expect(body.meta.total_count).toBe(5);   // whole tenant, ignores filter
  });

  test("no meta → no count fields", async () => {
    const res = await h.fetch(`/api/items/widgets`);
    const body = (await res.json()) as { meta?: unknown };
    expect(body.meta).toBeUndefined();
  });
});
