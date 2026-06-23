import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("bulk update", () => {
  let h: TestHarness;
  const slug = `bulk_${Date.now()}`;

  const bulk = (body: unknown) =>
    h.fetch(`/api/items/${slug}/bulk-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const createOne = async (title: string): Promise<string> => {
    const r = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    return ((await r.json()) as { data: { id: string } }).data.id;
  };
  const getField = async (id: string, field: string): Promise<unknown> => {
    const r = await h.fetch(`/api/items/${slug}/${id}`);
    return ((await r.json()) as { data: Record<string, unknown> }).data[field];
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "n", type: "integer" },
          { name: "active", type: "boolean" },
          { name: "meta", type: "json" },
        ],
      }),
    });
  });
  afterAll(() => h.cleanup());

  test("sets shared fields across all selected keys", async () => {
    const ids = [await createOne("a"), await createOne("b"), await createOne("c")];
    const res = await bulk({ keys: ids, data: { n: 7, active: true } });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { total: number; updated: number; failed: number; results: any[] };
    };
    expect(data.total).toBe(3);
    expect(data.updated).toBe(3);
    expect(data.failed).toBe(0);
    for (const id of ids) {
      expect(await getField(id, "n")).toBe(7);
      expect(await getField(id, "active")).toBe(true);
      // untouched field is left intact
      expect(typeof (await getField(id, "title"))).toBe("string");
    }
  });

  test("de-duplicates repeated keys", async () => {
    const id = await createOne("dup");
    const res = await bulk({ keys: [id, id, id], data: { n: 3 } });
    const { data } = (await res.json()) as { data: { total: number; updated: number } };
    expect(data.total).toBe(1);
    expect(data.updated).toBe(1);
    expect(await getField(id, "n")).toBe(3);
  });

  test("partial success: a missing key is reported, the rest still commit", async () => {
    const id = await createOne("real");
    const res = await bulk({ keys: [id, "does-not-exist"], data: { n: 9 } });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { updated: number; failed: number; results: any[] };
    };
    expect(data.updated).toBe(1);
    expect(data.failed).toBe(1);
    const missing = data.results.find((r) => r.id === "does-not-exist");
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe("NOT_FOUND");
    expect(await getField(id, "n")).toBe(9);
  });

  test("rejects a structured field for bulk (json)", async () => {
    const id = await createOne("j");
    const res = await bulk({ keys: [id], data: { meta: { a: 1 } } });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("bulk-edited");
  });

  test("rejects an empty patch", async () => {
    const id = await createOne("e");
    const res = await bulk({ keys: [id], data: {} });
    expect(res.status).toBe(422);
  });

  test("rejects an unknown field", async () => {
    const id = await createOne("u");
    const res = await bulk({ keys: [id], data: { nope: 1 } });
    expect(res.status).toBe(422);
  });

  test("rejects an over-size key list", async () => {
    const keys = Array.from({ length: 1001 }, (_, i) => `k-${i}`);
    const res = await bulk({ keys, data: { n: 1 } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("a caller without update permission is denied", async () => {
    // Second user on the same DB gets no roles → no update permission. (Last
    // test in the block; switching the session cookie here is fine.)
    const up = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `bu2-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "BU2",
      }),
    });
    expect(up.ok).toBe(true);
    const res = await bulk({ keys: ["whatever"], data: { n: 1 } });
    expect(res.status).toBe(403);
  });
});
