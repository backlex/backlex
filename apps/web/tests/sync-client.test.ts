/**
 * Client sync reducer logic — pull/apply, tombstone removal, offline write queue
 * + flush with temp-id reconciliation, and last-write-wins vs. a pending local
 * write. Driven against an in-memory store and a scripted fake client (no
 * server), so it's deterministic.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createSync, memoryStore, type SyncClientLike } from "../../../packages/client/src/sync";

// `setOnline` below replaces the global `navigator` with a bare `{ onLine }`
// stub (the sync layer only reads `navigator.onLine`). Snapshot the real one so
// we can put it back — otherwise the stub leaks into later specs in the shared
// bun-test process, and the React render tests (which read
// `navigator.userAgent`) blow up.
const ORIGINAL_NAVIGATOR = globalThis.navigator;

/** A fake client whose changefeed serves scripted pages and whose batch echoes
 *  back server-assigned rows. */
const makeFake = (pages: { data: Record<string, unknown>[]; cursor: string | null; hasMore: boolean }[]) => {
  let pull = 0;
  const batched: unknown[] = [];
  const client: SyncClientLike = {
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      if (path.includes("/changes")) {
        return (pages[Math.min(pull++, pages.length - 1)] ?? { data: [], cursor: null, hasMore: false }) as T;
      }
      if (path.endsWith("/batch")) {
        batched.push(body);
        const ops = (body as { operations: { op: string; id?: string; data?: Record<string, unknown> }[] }).operations;
        const results = ops.map((o, index) => ({
          index,
          ok: true,
          id: o.op === "create" ? `srv_${index}` : o.id,
          data: o.op === "delete" ? undefined : { id: o.op === "create" ? `srv_${index}` : o.id, ...o.data },
        }));
        return { data: { results } } as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    subscribe: () => () => {},
  };
  return { client, batched };
};

describe("client sync", () => {
  afterAll(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: ORIGINAL_NAVIGATOR,
      configurable: true,
    });
  });

  test("pull applies rows and drops tombstones", async () => {
    const { client } = makeFake([
      {
        data: [
          { id: "1", title: "a" },
          { id: "2", title: "b" },
          { id: "3", title: "gone", _deleted: true },
        ],
        cursor: "c1",
        hasMore: false,
      },
    ]);
    const store = memoryStore();
    const sync = createSync(client, { collection: "notes", store });
    await sync.pull();
    const all = await sync.getAll();
    expect(all.map((r) => r.id).sort()).toEqual(["1", "2"]);
    expect(await store.getMeta("cursor")).toBe("c1");
  });

  const setOnline = (v: boolean) =>
    Object.defineProperty(globalThis, "navigator", { value: { onLine: v }, configurable: true });

  test("offline create queues optimistically, flush reconciles the temp id", async () => {
    const { client, batched } = makeFake([{ data: [], cursor: null, hasMore: false }]);
    const store = memoryStore();
    const sync = createSync(client, { collection: "notes", store });

    setOnline(false);
    const tempId = await sync.create({ title: "draft" });
    // offline: optimistic row present under the temp id, write queued, no batch yet
    expect(tempId.startsWith("tmp_")).toBe(true);
    expect((await sync.get(tempId))?.title).toBe("draft");
    expect((await store.queueGet()).length).toBe(1);
    expect(batched.length).toBe(0);

    setOnline(true);
    await sync.flush();
    // temp row replaced by the server-assigned row; queue drained
    expect(await sync.get(tempId)).toBeUndefined();
    expect((await sync.get("srv_0"))?.title).toBe("draft");
    expect(await store.queueGet()).toEqual([]);
    expect(batched.length).toBe(1);
    setOnline(true);
  });

  test("a pulled row does not clobber a pending local write", async () => {
    // changefeed would set title back to "server", but a local update is queued.
    const { client } = makeFake([
      { data: [{ id: "x", title: "server" }], cursor: "c1", hasMore: false },
    ]);
    const store = memoryStore();
    await store.set("x", { id: "x", title: "local0" });
    const sync = createSync(client, { collection: "notes", store });
    // queue a local update WITHOUT flushing (simulate offline)
    await store.queueSet([{ kind: "update", id: "x", data: { title: "local-pending" } }]);
    await store.set("x", { id: "x", title: "local-pending" });

    await sync.pull();
    // pending id is skipped, so the local value survives the pull
    expect((await sync.get("x"))?.title).toBe("local-pending");
  });

  test("delete removes locally and queues a delete op", async () => {
    const { client } = makeFake([{ data: [], cursor: null, hasMore: false }]);
    const store = memoryStore();
    await store.set("d", { id: "d", title: "bye" });
    const sync = createSync(client, { collection: "notes", store });
    await sync.remove("d");
    expect(await sync.get("d")).toBeUndefined();
    // flush sends the delete
    await sync.flush();
    expect(await store.queueGet()).toEqual([]);
  });
});
