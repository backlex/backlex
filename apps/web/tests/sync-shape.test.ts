/**
 * Shape-based partial replication on the changefeed:
 * `GET /api/items/:slug/changes?shape=<filter>` replicates only the rows a
 * client cares about, and — the part that makes it *sound* — tells the client
 * when a row it already holds has left the shape (`_shape_exit`) so the local
 * store doesn't keep a stale copy forever.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Changes {
  data: Record<string, unknown>[];
  cursor: string | null;
  hasMore: boolean;
  shape?: string;
}

describe("Sync shapes (partial replication)", () => {
  let h: TestHarness;
  const slug = `tasks_${Date.now()}`;
  const mine = { status: { _eq: "open" } };

  const changes = async (
    opts: { since?: string; shape?: unknown; fields?: string; expect?: number } = {},
  ): Promise<Changes> => {
    const qs = new URLSearchParams();
    if (opts.since) qs.set("since", opts.since);
    if (opts.shape !== undefined) qs.set("shape", JSON.stringify(opts.shape));
    if (opts.fields) qs.set("fields", opts.fields);
    const r = await h.fetch(`/api/items/${slug}/changes${qs.toString() ? `?${qs}` : ""}`);
    expect(r.status).toBe(opts.expect ?? 200);
    return (await r.json()) as Changes;
  };
  const mk = async (title: string, status: string): Promise<string> => {
    const r = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title, status }),
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { data: { id: string } }).data.id;
  };
  const patch = async (id: string, data: Record<string, unknown>) => {
    const r = await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    });
    expect(r.status).toBe(200);
  };

  let openId = "";
  let doneId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const c = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        softDelete: true,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "status", type: "text" },
          { name: "secret", type: "hash" },
        ],
      }),
    });
    expect(c.status).toBe(201);
    openId = await mk("open one", "open");
    await sleep(3);
    doneId = await mk("done one", "done");
    await sleep(3);
  });
  afterAll(() => h.cleanup());

  test("a shape replicates only matching rows, in full", async () => {
    const res = await changes({ shape: mine });
    const inShape = res.data.filter((r) => r._shape_exit !== true);
    expect(inShape.map((r) => r.id)).toEqual([openId]);
    expect(inShape[0]?.title).toBe("open one");
  });

  test("non-matching rows arrive as id-only move-out markers", async () => {
    const res = await changes({ shape: mine });
    const exits = res.data.filter((r) => r._shape_exit === true);
    expect(exits.map((r) => r.id)).toEqual([doneId]);
    // Id and the marker — nothing else. A move-out carries no payload.
    expect(Object.keys(exits[0] ?? {}).sort()).toEqual(["_shape_exit", "id"]);
  });

  test("a row that leaves the shape shows up as an exit on the NEXT pull", async () => {
    // Catch up to head first, so the delta below is unambiguous.
    const base = await changes({ shape: mine });
    expect(base.cursor).toBeTruthy();
    await sleep(3);
    await patch(openId, { status: "done" });

    const delta = await changes({ since: base.cursor!, shape: mine });
    expect(delta.data.length).toBe(1);
    expect(delta.data[0]?.id).toBe(openId);
    expect(delta.data[0]?._shape_exit).toBe(true);
  });

  test("a row that re-enters the shape comes back in full", async () => {
    const base = await changes({ shape: mine });
    await sleep(3);
    await patch(openId, { status: "open" });

    const delta = await changes({ since: base.cursor!, shape: mine });
    expect(delta.data.length).toBe(1);
    expect(delta.data[0]?.id).toBe(openId);
    expect(delta.data[0]?._shape_exit).toBeUndefined();
    expect(delta.data[0]?.title).toBe("open one");
  });

  test("a soft-deleted row in the shape is still a tombstone, not an exit", async () => {
    const base = await changes({ shape: mine });
    await sleep(3);
    const del = await h.fetch(`/api/items/${slug}/${openId}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const delta = await changes({ since: base.cursor!, shape: mine });
    const row = delta.data.find((r) => r.id === openId);
    expect(row?._deleted).toBe(true);
    // Restore for the remaining tests.
    await sleep(3);
  });

  test("the response echoes a stable shape key", async () => {
    const a = await changes({ shape: { status: { _eq: "open" } } });
    const b = await changes({ shape: { status: { _eq: "open" } } });
    const other = await changes({ shape: { status: { _eq: "done" } } });
    expect(a.shape).toBeTruthy();
    expect(a.shape).toBe(b.shape!);
    expect(a.shape).not.toBe(other.shape!);
    // No shape → no key (the whole-collection v1 contract is untouched).
    const none = await changes({});
    expect(none.shape).toBeUndefined();
  });

  test("`fields` narrows the payload but always keeps id + updated_at", async () => {
    const res = await changes({ shape: mine, fields: "title" });
    const row = res.data.find((r) => r._shape_exit !== true);
    expect(row).toBeTruthy();
    expect(row?.title).toBe("open one");
    expect(row?.id).toBeTruthy();
    expect(row?.updatedAt).toBeTruthy();
    expect(row?.status).toBeUndefined();
  });

  test("shapes can't span relations", async () => {
    const r = await changes({ shape: { "author.name": { _eq: "x" } }, expect: 422 });
    expect(JSON.stringify(r)).toContain("can't span relations");
  });

  test("shapes reject unknown and hashed fields", async () => {
    await changes({ shape: { nope: { _eq: 1 } }, expect: 422 });
    await changes({ shape: { secret: { _eq: "x" } }, expect: 422 });
  });

  test("malformed shape JSON is a validation error, not a 500", async () => {
    const r = await h.fetch(`/api/items/${slug}/changes?shape=${encodeURIComponent("{not json")}`);
    expect(r.status).toBe(422);
  });
});
