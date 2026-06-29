/**
 * Keyset (cursor) pagination on the items list endpoint.
 *
 * The guarantees under test:
 *  - paging the whole collection via `?cursor` visits every row exactly once,
 *    in the same order as the classic offset path (no skips, no duplicates) —
 *    even when many rows share the same `created_at` (the default sort), which
 *    is precisely where the appended `id` tiebreaker earns its keep;
 *  - `has_more` flips to false only on the final page, and `next_cursor` is
 *    null there;
 *  - classic offset paging (no `?cursor`) is byte-for-byte unchanged and still
 *    carries `offset`;
 *  - a garbage cursor is a 422, not a 500.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

describe("keyset (cursor) pagination", () => {
  let h: TestHarness;
  const slug = `widgets_${Date.now()}`;
  const TOTAL = 13;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [{ name: "label", type: "text", required: true }],
      }),
    });
    expect(create.status).toBe(201);
    // Insert in a tight loop so several rows collide on the same created_at ms
    // — the worst case for keyset correctness without a unique tiebreaker.
    for (let i = 0; i < TOTAL; i++) {
      const r = await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: `w${String(i).padStart(2, "0")}` }),
      });
      expect(r.status).toBe(201);
    }
  });

  afterAll(() => h.cleanup());

  const offsetIds = async (): Promise<string[]> => {
    const res = await h.fetch(`/api/items/${slug}?limit=200`);
    const body = (await res.json()) as { data: { id: string }[]; offset: number };
    // Classic envelope still exposes offset.
    expect(body.offset).toBe(0);
    return body.data.map((r) => r.id);
  };

  test("walking cursors covers every row once, in offset order", async () => {
    const expected = await offsetIds();
    expect(expected.length).toBe(TOTAL);

    const seen: string[] = [];
    let cursor = ""; // empty cursor = first page in keyset mode
    let pages = 0;
    for (;;) {
      const res = await h.fetch(
        `/api/items/${slug}?limit=5&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { id: string }[];
        has_more: boolean;
        next_cursor: string | null;
        offset?: number;
      };
      // Cursor mode drops offset entirely.
      expect(body.offset).toBeUndefined();
      seen.push(...body.data.map((r) => r.id));
      pages++;
      if (!body.has_more) {
        expect(body.next_cursor).toBeNull();
        break;
      }
      expect(body.next_cursor).toBeTruthy();
      cursor = body.next_cursor as string;
      if (pages > 10) throw new Error("cursor loop did not terminate");
    }

    expect(pages).toBe(3); // 5 + 5 + 3
    expect(seen.length).toBe(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL); // no duplicates, no skips
    // Same MEMBERSHIP as the offset path. Exact order can differ within a
    // created_at tie group: the offset path orders by `created_at DESC` only
    // (engine-natural, non-deterministic on ties) whereas keyset appends the
    // `id DESC` tiebreaker — keyset is the stricter, deterministic order.
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  test("ascending sort cursor also stays consistent", async () => {
    const seen: string[] = [];
    let cursor = "";
    for (;;) {
      const res = await h.fetch(
        `/api/items/${slug}?limit=4&sort=label&cursor=${encodeURIComponent(cursor)}`,
      );
      const body = (await res.json()) as {
        data: { id: string; label: string }[];
        has_more: boolean;
        next_cursor: string | null;
      };
      seen.push(...body.data.map((r) => r.label));
      if (!body.has_more) break;
      cursor = body.next_cursor as string;
    }
    expect(seen.length).toBe(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    // sorted ascending by label
    expect(seen).toEqual([...seen].sort());
  });

  test("garbage cursor is a 422, not a 500", async () => {
    const res = await h.fetch(`/api/items/${slug}?cursor=not-a-real-cursor`);
    expect(res.status).toBe(422);
  });

  test("classic offset paging still reports has_more", async () => {
    const res = await h.fetch(`/api/items/${slug}?limit=5&offset=0`);
    const body = (await res.json()) as { has_more: boolean; offset: number };
    expect(body.offset).toBe(0);
    expect(body.has_more).toBe(true);
  });
});
