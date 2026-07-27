/**
 * Per-op optimistic concurrency on the batch endpoint — the server half of the
 * sync engine's conflict policies. An offline client flushes a queue in one
 * request; each op carries the `updatedAt` it was based on, and only the stale
 * ones are refused. Independent ops in the same batch still land.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BatchResult {
  index: number;
  ok: boolean;
  id?: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: { currentUpdatedAt?: string } };
}

describe("Batch optimistic concurrency (sync conflicts)", () => {
  let h: TestHarness;
  const slug = `docs_${Date.now()}`;

  const mk = async (title: string): Promise<{ id: string; updatedAt: string }> => {
    const r = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title }),
    });
    expect(r.status).toBe(201);
    const { data } = (await r.json()) as { data: { id: string; updatedAt: string } };
    return data;
  };
  const patch = async (id: string, data: Record<string, unknown>) => {
    const r = await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    });
    expect(r.status).toBe(200);
  };
  const read = async (id: string): Promise<Record<string, unknown>> => {
    const r = await h.fetch(`/api/items/${slug}/${id}`);
    expect(r.status).toBe(200);
    return ((await r.json()) as { data: Record<string, unknown> }).data;
  };
  const batch = async (operations: unknown[]): Promise<BatchResult[]> => {
    const r = await h.fetch(`/api/items/${slug}/batch`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ operations }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: { results: BatchResult[] } };
    return body.data.results;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const c = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "note", type: "text" },
        ],
      }),
    });
    expect(c.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("a matching precondition lets the write through", async () => {
    const row = await mk("one");
    const [res] = await batch([
      { op: "update", id: row.id, data: { title: "mine" }, ifUnmodifiedSince: row.updatedAt },
    ]);
    expect(res?.ok).toBe(true);
    expect((await read(row.id)).title).toBe("mine");
  });

  test("a stale precondition is refused with CONFLICT, not a silent overwrite", async () => {
    const row = await mk("two");
    await sleep(3);
    await patch(row.id, { title: "theirs" }); // someone else got there first

    const [res] = await batch([
      { op: "update", id: row.id, data: { title: "mine" }, ifUnmodifiedSince: row.updatedAt },
    ]);
    expect(res?.ok).toBe(false);
    expect(res?.error?.code).toBe("CONFLICT");
    // The other edit stands — this is the whole point.
    expect((await read(row.id)).title).toBe("theirs");
  });

  test("the refusal carries the current updatedAt so a client can rebase", async () => {
    const row = await mk("three");
    await sleep(3);
    await patch(row.id, { title: "theirs" });
    const current = await read(row.id);

    const [res] = await batch([
      { op: "update", id: row.id, data: { title: "mine" }, ifUnmodifiedSince: row.updatedAt },
    ]);
    expect(res?.error?.details?.currentUpdatedAt).toBeTruthy();
    expect(new Date(String(res?.error?.details?.currentUpdatedAt)).getTime()).toBe(
      new Date(String(current.updatedAt)).getTime(),
    );
    // Retrying against the fresh value succeeds — that's `client-wins` rebased.
    const [retry] = await batch([
      {
        op: "update",
        id: row.id,
        data: { title: "mine" },
        ifUnmodifiedSince: String(res?.error?.details?.currentUpdatedAt),
      },
    ]);
    expect(retry?.ok).toBe(true);
  });

  test("one stale op doesn't take the rest of the flush down with it", async () => {
    const stale = await mk("stale");
    const fresh = await mk("fresh");
    await sleep(3);
    await patch(stale.id, { title: "moved" });

    const results = await batch([
      { op: "update", id: stale.id, data: { title: "a" }, ifUnmodifiedSince: stale.updatedAt },
      { op: "update", id: fresh.id, data: { title: "b" }, ifUnmodifiedSince: fresh.updatedAt },
      { op: "create", data: { title: "c" } },
    ]);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error?.code).toBe("CONFLICT");
    expect(results[1]?.ok).toBe(true);
    expect(results[2]?.ok).toBe(true);
    expect((await read(fresh.id)).title).toBe("b");
  });

  test("omitting the precondition keeps last-write-wins (v1 clients unaffected)", async () => {
    const row = await mk("lww");
    await sleep(3);
    await patch(row.id, { title: "theirs" });

    const [res] = await batch([{ op: "update", id: row.id, data: { title: "mine" } }]);
    expect(res?.ok).toBe(true);
    expect((await read(row.id)).title).toBe("mine");
  });

  test("a malformed precondition is a validation error on that op alone", async () => {
    const row = await mk("bad");
    const results = await batch([
      { op: "update", id: row.id, data: { title: "x" }, ifUnmodifiedSince: "not-a-date" },
      { op: "create", data: { title: "ok" } },
    ]);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error?.code).toBe("VALIDATION");
    expect(results[1]?.ok).toBe(true);
  });
});
