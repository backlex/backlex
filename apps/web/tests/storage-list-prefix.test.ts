/**
 * Regression: `GET /api/storage?prefix=<p>` must return the files under that
 * key prefix.
 *
 * The prefix filter used to compile to `key LIKE 'prefix%'`. D1's SQLite
 * rejects a bound LIKE pattern with `D1_ERROR: LIKE or GLOB pattern too
 * complex`, so the endpoint 500'd for every prefixed list (and would have on
 * production D1, not just locally). It is now an index-friendly range scan
 * (`key >= prefix AND key < prefix + <high sentinel>`); these cases lock in the
 * filtering behavior so a revert to LIKE is caught.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("storage.list — key prefix filter", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    for (const key of [
      "invoices/2024/jan.pdf",
      "invoices/2024/feb.pdf",
      "invoices/2025/jan.pdf",
      "photos/beach.jpg",
    ]) {
      const put = await h.fetch(`/api/storage/${key}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: "x",
      });
      expect(put.status).toBe(201);
    }
  });
  afterAll(() => h.cleanup());

  const list = async (qs: string) => {
    const res = await h.fetch(`/api/storage${qs}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { key: string }[] };
    return body.data.map((f) => f.key).sort();
  };

  test("no prefix returns every file", async () => {
    expect(await list("")).toEqual([
      "invoices/2024/feb.pdf",
      "invoices/2024/jan.pdf",
      "invoices/2025/jan.pdf",
      "photos/beach.jpg",
    ]);
  });

  test("a shallow prefix returns only its subtree", async () => {
    expect(await list("?prefix=invoices")).toEqual([
      "invoices/2024/feb.pdf",
      "invoices/2024/jan.pdf",
      "invoices/2025/jan.pdf",
    ]);
  });

  test("a deeper prefix narrows further", async () => {
    expect(await list("?prefix=invoices/2024")).toEqual([
      "invoices/2024/feb.pdf",
      "invoices/2024/jan.pdf",
    ]);
  });

  test("a non-matching prefix returns nothing", async () => {
    expect(await list("?prefix=does-not-exist")).toEqual([]);
  });
});
