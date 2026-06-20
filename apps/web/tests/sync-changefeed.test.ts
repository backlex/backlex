/**
 * Offline-sync changefeed: `GET /api/items/:slug/changes` returns rows past a
 * keyset cursor (including soft-deleted tombstones), paginates, and is
 * read-gated. Plus the per-item revisions endpoint.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Changes {
  data: Record<string, unknown>[];
  cursor: string | null;
  hasMore: boolean;
}

describe("Sync changefeed", () => {
  let h: TestHarness;
  const slug = `notes_${Date.now()}`;
  const ids: string[] = [];

  const changes = async (since?: string, limit?: number): Promise<Changes> => {
    const qs = new URLSearchParams();
    if (since) qs.set("since", since);
    if (limit) qs.set("limit", String(limit));
    const r = await h.fetch(`/api/items/${slug}/changes${qs.toString() ? `?${qs}` : ""}`);
    expect(r.status).toBe(200);
    return (await r.json()) as Changes;
  };
  const mk = async (title: string): Promise<string> => {
    const r = await h.fetch(`/api/items/${slug}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ title }) });
    expect(r.status).toBe(201);
    return ((await r.json()) as { data: { id: string } }).data.id;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const c = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug, softDelete: true, fields: [{ name: "title", type: "text", required: true }] }),
    });
    expect(c.status).toBe(201);
    for (const n of ["a", "b", "c"]) { ids.push(await mk(n)); await sleep(3); }
  });
  afterAll(() => h.cleanup());

  test("full initial pull returns all rows + a cursor", async () => {
    const res = await changes();
    expect(res.data.length).toBe(3);
    expect(res.cursor).toBeTruthy();
    expect(res.hasMore).toBe(false);
    // ordered by updated_at asc
    expect(res.data.map((r) => r.title)).toEqual(["a", "b", "c"]);
  });

  test("incremental pull returns only rows changed after the cursor", async () => {
    const first = await changes();
    await sleep(5);
    // touch the first item → its updated_at jumps to the head
    const upd = await h.fetch(`/api/items/${slug}/${ids[0]}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ title: "a2" }) });
    expect(upd.status).toBe(200);
    const delta = await changes(first.cursor!);
    expect(delta.data.length).toBe(1);
    expect(delta.data[0]!.id).toBe(ids[0]);
    expect(delta.data[0]!.title).toBe("a2");
  });

  test("soft-deletes appear as tombstones (_deleted)", async () => {
    const before = await changes();
    await sleep(5);
    const del = await h.fetch(`/api/items/${slug}/${ids[1]}`, { method: "DELETE" });
    expect(del.status).toBeLessThan(300);
    const delta = await changes(before.cursor!);
    const tomb = delta.data.find((r) => r.id === ids[1]);
    expect(tomb).toBeTruthy();
    expect(tomb!._deleted).toBe(true);
  });

  test("keyset pagination walks the whole set without gaps", async () => {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const page: Changes = await changes(cursor, 1);
      for (const r of page.data) seen.add(String(r.id));
      if (!page.hasMore) break;
      cursor = page.cursor!;
    }
    // all three originals observed across pages (one is now a tombstone)
    expect(seen.size).toBe(3);
  });

  test("changefeed is read-gated", async () => {
    const res = await h.app.fetch(
      new Request(`http://localhost:5173/api/items/${slug}/changes`, {
        headers: { Origin: "http://localhost:5173" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("revisions endpoint returns an item's history", async () => {
    const r = await h.fetch(`/api/items/${slug}/${ids[0]}/revisions`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1); // at least the create snapshot
  });
});
