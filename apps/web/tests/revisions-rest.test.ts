/**
 * REST coverage for `/api/revisions` (routes/revisions.ts).
 *
 * Revisions are written as a side effect of item update/delete (see
 * services/items/write.ts — `recordRevision` receives the BEFORE-state row),
 * and the route replays a snapshot back into the physical table on revert.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

interface RevisionRow {
  id: string;
  collection: string;
  itemId: string;
  parentRevisionId: string | null;
  snapshot: { title?: string; rank?: number } | string;
  createdBy: string | null;
}

const snapshotOf = (r: RevisionRow): { title?: string; rank?: number } =>
  typeof r.snapshot === "string" ? JSON.parse(r.snapshot) : r.snapshot;

describe("revisions REST", () => {
  let h: TestHarness;
  const slug = `rev_probe_${Date.now()}`;
  let itemId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "rank", type: "integer" },
        ],
      }),
    });
    expect(create.status).toBe(201);

    const ins = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "v1", rank: 1 }),
    });
    expect(ins.status).toBe(201);
    itemId = ((await ins.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("no revisions before the first update", async () => {
    const res = await h.fetch(`/api/revisions/${slug}/${itemId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: RevisionRow[] };
    expect(body.data).toEqual([]);
  });

  test("each item update records a before-state snapshot", async () => {
    const p1 = await h.fetch(`/api/items/${slug}/${itemId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "v2", rank: 2 }),
    });
    expect(p1.status).toBe(200);
    const p2 = await h.fetch(`/api/items/${slug}/${itemId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "v3", rank: 3 }),
    });
    expect(p2.status).toBe(200);

    const res = await h.fetch(`/api/revisions/${slug}/${itemId}`);
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { data: RevisionRow[] }).data;
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.collection).toBe(slug);
      expect(r.itemId).toBe(itemId);
      expect(typeof r.id).toBe("string");
      expect(typeof r.createdBy).toBe("string"); // stamped with the actor
    }
    // Snapshots are the row state BEFORE each update — v1 and v2 (never v3).
    const titles = rows.map((r) => snapshotOf(r).title).sort();
    expect(titles).toEqual(["v1", "v2"]);
  });

  test("POST /{id}/revert rewrites the live row from the snapshot", async () => {
    const list = await h.fetch(`/api/revisions/${slug}/${itemId}`);
    const rows = ((await list.json()) as { data: RevisionRow[] }).data;
    const v1 = rows.find((r) => snapshotOf(r).title === "v1");
    expect(v1).toBeDefined();

    const revert = await h.fetch(`/api/revisions/${v1!.id}/revert`, {
      method: "POST",
    });
    expect(revert.status).toBe(200);
    const body = (await revert.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // The live item actually reverted.
    const item = await h.fetch(`/api/items/${slug}/${itemId}`);
    expect(item.status).toBe(200);
    const data = ((await item.json()) as {
      data: { title: string; rank: number };
    }).data;
    expect(data.title).toBe("v1");
    expect(data.rank).toBe(1);

    // The revert itself was recorded as a new revision (history grew to 3).
    const after = await h.fetch(`/api/revisions/${slug}/${itemId}`);
    const afterRows = ((await after.json()) as { data: RevisionRow[] }).data;
    expect(afterRows.length).toBe(3);
  });

  test("reverting an unknown revision id 404s", async () => {
    const res = await h.fetch(`/api/revisions/${crypto.randomUUID()}/revert`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("anonymous list is rejected with 401", async () => {
    const res = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/revisions/${slug}/${itemId}`, {
        headers: { Origin: h.env.APP_URL },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("anonymous revert is rejected with 401", async () => {
    const list = await h.fetch(`/api/revisions/${slug}/${itemId}`);
    const rows = ((await list.json()) as { data: RevisionRow[] }).data;
    const anyId = rows[0]!.id;
    const res = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/revisions/${anyId}/revert`, {
        method: "POST",
        headers: { Origin: h.env.APP_URL },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
