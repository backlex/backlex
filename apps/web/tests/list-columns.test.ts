import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

// The `listColumns` workspace setting (per-collection list-view columns) round-
// trips through /api/admin/settings — the no-migration app_settings convention.
describe("listColumns setting round-trip", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("PATCH then GET returns the saved per-collection columns", async () => {
    const cols = { posts: ["title", "price", "published_at"], authors: ["name"] };
    const patch = await h.fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listColumns: cols }),
    });
    expect(patch.status).toBeLessThan(400);

    const get = await h.fetch("/api/admin/settings");
    const body = (await get.json()) as { data: { listColumns?: Record<string, string[]> } };
    expect(body.data.listColumns).toEqual(cols);
  });

  test("rejects a malformed listColumns (non-string entries)", async () => {
    const res = await h.fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listColumns: { posts: [1, 2, 3] } }),
    });
    expect(res.status).toBe(400);
  });
});
