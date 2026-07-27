/**
 * Sync engine v2 client behaviour — shape-based partial replication, the
 * conflict policies, and the SQLite store. Driven against a scripted fake
 * client (no server) so every branch is deterministic.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { matchesCondition as serverMatches } from "@backlex/db";
import { matchesCondition, shapeKey } from "../../../packages/client/src/condition";
import {
  createSync,
  memoryStore,
  sqliteStore,
  type QueuedOp,
  type SyncClientLike,
  type SyncConflict,
} from "../../../packages/client/src/sync";

// `setOnline` replaces the global `navigator` with a bare `{ onLine }` stub (the
// sync layer only reads `navigator.onLine`). Snapshot the real one and restore
// it at FILE scope — a describe-scoped `afterAll` would fire before the later
// blocks run, and the stub would leak into the React render specs sharing this
// bun-test process, where `navigator.userAgent` is read.
const ORIGINAL_NAVIGATOR = globalThis.navigator;
afterAll(() => {
  Object.defineProperty(globalThis, "navigator", {
    value: ORIGINAL_NAVIGATOR,
    configurable: true,
  });
});
const setOnline = (v: boolean) =>
  Object.defineProperty(globalThis, "navigator", { value: { onLine: v }, configurable: true });

interface Page {
  data: Record<string, unknown>[];
  cursor: string | null;
  hasMore: boolean;
  shape?: string;
}

/** Scripted changefeed + a batch handler the test can program per-op. */
const makeFake = (
  pages: Page[],
  batchHandler?: (
    ops: { op: string; id?: string; data?: Record<string, unknown>; ifUnmodifiedSince?: string }[],
  ) => unknown[],
) => {
  let pull = 0;
  const paths: string[] = [];
  const batches: { op: string; id?: string; data?: Record<string, unknown>; ifUnmodifiedSince?: string }[][] = [];
  const client: SyncClientLike = {
    request: async <T>(_m: string, path: string, body?: unknown): Promise<T> => {
      if (path.includes("/changes")) {
        paths.push(path);
        return (pages[Math.min(pull++, pages.length - 1)] ?? {
          data: [],
          cursor: null,
          hasMore: false,
        }) as T;
      }
      if (path.endsWith("/batch")) {
        const ops = (body as { operations: typeof batches[number] }).operations;
        batches.push(ops);
        const results = batchHandler
          ? batchHandler(ops)
          : ops.map((o, index) => ({
              index,
              ok: true,
              id: o.op === "create" ? `srv_${index}` : o.id,
              data: o.op === "delete" ? undefined : { id: o.op === "create" ? `srv_${index}` : o.id, ...o.data },
            }));
        return { data: { results } } as T;
      }
      throw new Error(`unexpected ${path}`);
    },
    subscribe: () => () => {},
  };
  return { client, paths, batches };
};

describe("sync v2 — shapes", () => {
  test("the shape travels to the changefeed as a filter param", async () => {
    const { client, paths } = makeFake([{ data: [], cursor: "c1", hasMore: false }]);
    const sync = createSync(client, {
      collection: "tasks",
      store: memoryStore(),
      shape: { status: { _eq: "open" } },
      fields: ["title", "status"],
    });
    await sync.pull();
    expect(paths[0]).toContain(`shape=${encodeURIComponent('{"status":{"_eq":"open"}}')}`);
    expect(paths[0]).toContain(`fields=${encodeURIComponent("title,status")}`);
  });

  test("a move-out marker drops the row without deleting anything else", async () => {
    const { client } = makeFake([
      {
        data: [
          { id: "1", title: "keep" },
          { id: "2", _shape_exit: true },
        ],
        cursor: "c1",
        hasMore: false,
      },
    ]);
    const store = memoryStore();
    await store.set("2", { id: "2", title: "was mine" });
    const sync = createSync(client, { collection: "tasks", store, shape: { status: { _eq: "open" } } });
    await sync.pull();
    expect((await sync.getAll()).map((r) => r.id)).toEqual(["1"]);
  });

  test("changing the shape wipes the store and re-syncs from scratch", async () => {
    const pages: Page[] = [{ data: [{ id: "new", title: "fresh" }], cursor: "c9", hasMore: false }];
    const store = memoryStore();
    // Pretend a previous run replicated a different shape.
    await store.set("stale", { id: "stale", title: "old shape" });
    await store.setMeta("cursor", "c-old");
    await store.setMeta("shape", "someotherkey");

    const { client, paths } = makeFake(pages);
    const sync = createSync(client, { collection: "tasks", store, shape: { status: { _eq: "done" } } });
    await sync.pull();

    expect((await sync.getAll()).map((r) => r.id)).toEqual(["new"]);
    // Re-synced from the beginning — no stale cursor carried over.
    expect(paths[0]).not.toContain("since=");
  });

  test("an unchanged shape keeps its cursor", async () => {
    const store = memoryStore();
    const { client, paths } = makeFake([{ data: [], cursor: "c2", hasMore: false }]);
    const shape = { status: { _eq: "open" } };
    const sync = createSync(client, { collection: "tasks", store, shape });
    await sync.pull();
    await sync.pull();
    expect(paths[1]).toContain("since=c2");
  });

  test("queued offline writes survive a shape change", async () => {
    const store = memoryStore();
    await store.setMeta("shape", "old");
    const queued: QueuedOp[] = [{ kind: "create", tempId: "tmp_1", data: { title: "mine" } }];
    await store.queueSet(queued);
    const { client } = makeFake([{ data: [], cursor: "c1", hasMore: false }]);
    const sync = createSync(client, { collection: "tasks", store, shape: { a: { _eq: 1 } } });
    await sync.pull();
    expect(await store.queueGet()).toEqual(queued);
  });
});

describe("sync v2 — conflict policies", () => {
  /** A batch that refuses every update as stale, once. */
  const conflicting = (refuse: Set<number>) =>
    (ops: { op: string; id?: string; data?: Record<string, unknown>; ifUnmodifiedSince?: string }[]) =>
      ops.map((o, index) =>
        refuse.has(index) && o.ifUnmodifiedSince
          ? {
              index,
              ok: false,
              id: o.id,
              error: {
                code: "CONFLICT",
                message: "This record was modified after you loaded it",
                details: { currentUpdatedAt: "2026-01-02T00:00:00.000Z" },
              },
            }
          : { index, ok: true, id: o.id, data: { id: o.id, ...o.data } },
      );

  /** Store seeded with one row the client has already edited locally. */
  const seeded = async () => {
    const store = memoryStore();
    await store.set("x", { id: "x", title: "base", updatedAt: "2026-01-01T00:00:00.000Z" });
    return store;
  };

  test("last-write-wins sends no precondition (v1 semantics preserved)", async () => {
    const store = await seeded();
    const { client, batches } = makeFake([{ data: [], cursor: "c1", hasMore: false }]);
    setOnline(true);
    const sync = createSync(client, { collection: "tasks", store });
    await sync.update("x", { title: "mine" });
    expect(batches[0]?.[0]?.ifUnmodifiedSince).toBeUndefined();
  });

  test("a non-default policy sends the ancestor as the precondition", async () => {
    const store = await seeded();
    const { client, batches } = makeFake([{ data: [], cursor: "c1", hasMore: false }]);
    setOnline(true);
    const sync = createSync(client, { collection: "tasks", store, conflict: "server-wins" });
    await sync.update("x", { title: "mine" });
    expect(batches[0]?.[0]?.ifUnmodifiedSince).toBe("2026-01-01T00:00:00.000Z");
  });

  test("server-wins drops the local write and keeps the server row", async () => {
    const store = await seeded();
    const { client } = makeFake(
      [{ data: [{ id: "x", title: "theirs", updatedAt: "2026-01-02T00:00:00.000Z" }], cursor: "c2", hasMore: false }],
      conflicting(new Set([0])),
    );
    setOnline(true);
    const seen: SyncConflict[] = [];
    const sync = createSync(client, {
      collection: "tasks",
      store,
      conflict: "server-wins",
      onConflict: (c) => seen.push(c),
    });
    await sync.update("x", { title: "mine" });

    expect((await sync.get("x"))?.title).toBe("theirs");
    expect(await store.queueGet()).toEqual([]);
    expect(seen.length).toBe(1);
    expect(seen[0]?.local).toEqual({ title: "mine" });
    expect(seen[0]?.server?.title).toBe("theirs");
    expect(seen[0]?.base?.title).toBe("base");
  });

  test("client-wins retries without the precondition and wins", async () => {
    const store = await seeded();
    const { client, batches } = makeFake(
      [{ data: [{ id: "x", title: "theirs", updatedAt: "2026-01-02T00:00:00.000Z" }], cursor: "c2", hasMore: false }],
      conflicting(new Set([0])),
    );
    setOnline(true);
    const sync = createSync(client, { collection: "tasks", store, conflict: "client-wins" });
    await sync.update("x", { title: "mine" });

    expect(batches.length).toBe(2);
    expect(batches[1]?.[0]?.ifUnmodifiedSince).toBeUndefined();
    expect((await sync.get("x"))?.title).toBe("mine");
    expect(await store.queueGet()).toEqual([]);
  });

  test("merge gets local, server and the common ancestor", async () => {
    const store = await seeded();
    const { client } = makeFake(
      [
        {
          data: [{ id: "x", title: "base", note: "theirs", updatedAt: "2026-01-02T00:00:00.000Z" }],
          cursor: "c2",
          hasMore: false,
        },
      ],
      conflicting(new Set([0])),
    );
    setOnline(true);
    let got: SyncConflict | null = null;
    const sync = createSync(client, {
      collection: "tasks",
      store,
      conflict: "merge",
      merge: (c) => {
        got = c;
        // Keep the other side's field, apply ours on top — the point of a
        // three-way merge is that neither edit is lost.
        return { ...(c.server ?? {}), ...c.local };
      },
    });
    await sync.update("x", { title: "mine" });

    expect(got).not.toBeNull();
    expect((got as unknown as SyncConflict).base?.title).toBe("base");
    const row = await sync.get("x");
    expect(row?.title).toBe("mine");
    expect(row?.note).toBe("theirs");
  });

  test("manual leaves resolution to the app and drops the op", async () => {
    const store = await seeded();
    const { client, batches } = makeFake(
      [{ data: [{ id: "x", title: "theirs", updatedAt: "2026-01-02T00:00:00.000Z" }], cursor: "c2", hasMore: false }],
      conflicting(new Set([0])),
    );
    setOnline(true);
    const seen: SyncConflict[] = [];
    const sync = createSync(client, {
      collection: "tasks",
      store,
      conflict: "manual",
      onConflict: (c) => seen.push(c),
    });
    await sync.update("x", { title: "mine" });

    expect(seen.length).toBe(1);
    expect(batches.length).toBe(1); // no automatic retry
    expect(await store.queueGet()).toEqual([]);
  });

  test("merge without a merge function is a clear error, not a silent overwrite", async () => {
    const store = await seeded();
    const { client } = makeFake(
      [{ data: [], cursor: "c2", hasMore: false }],
      conflicting(new Set([0])),
    );
    setOnline(true);
    const sync = createSync(client, { collection: "tasks", store, conflict: "merge" });
    await store.queueSet([
      { kind: "update", id: "x", data: { title: "mine" }, baseUpdatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await expect(sync.flush()).rejects.toThrow(/requires a `merge` function/);
  });

  test("successive edits keep the FIRST ancestor, so a racing edit stays visible", async () => {
    const store = await seeded();
    const { client, batches } = makeFake([{ data: [], cursor: "c1", hasMore: false }]);
    setOnline(false);
    const sync = createSync(client, { collection: "tasks", store, conflict: "server-wins" });
    await sync.update("x", { title: "one" });
    // Local store now says "one"; a naive implementation would re-baseline here.
    await sync.update("x", { title: "two" });
    setOnline(true);
    await sync.flush();
    for (const op of batches[0] ?? []) {
      expect(op.ifUnmodifiedSince).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  test("a row held back during a pull is still available to rebase against", async () => {
    // The pull sees a newer server row but must not clobber the pending write.
    // v1 advanced the cursor and lost it; v2 stashes it, so the conflict can be
    // resolved without a second fetch even though the cursor has moved on.
    const store = memoryStore();
    await store.set("x", { id: "x", title: "base", updatedAt: "2026-01-01T00:00:00.000Z" });
    const { client } = makeFake(
      [
        { data: [{ id: "x", title: "theirs", updatedAt: "2026-01-02T00:00:00.000Z" }], cursor: "c2", hasMore: false },
        { data: [], cursor: "c2", hasMore: false }, // cursor is past it now
      ],
      conflicting(new Set([0])),
    );
    setOnline(false);
    const seen: SyncConflict[] = [];
    const sync = createSync(client, {
      collection: "tasks",
      store,
      conflict: "server-wins",
      onConflict: (c) => seen.push(c),
    });
    await sync.update("x", { title: "mine" });
    await sync.pull(); // holds "theirs" back — pending write outstanding
    expect((await sync.get("x"))?.title).toBe("mine");

    setOnline(true);
    await sync.flush();
    expect(seen[0]?.server?.title).toBe("theirs");
    expect((await sync.get("x"))?.title).toBe("theirs");
  });
});

describe("sync v2 — local shape matching", () => {
  test("mirrors the server's operator semantics", () => {
    const row = { id: "1", status: "open", count: 5, title: "Hello", note: null };
    const yes = (c: Parameters<typeof matchesCondition>[1]) => expect(matchesCondition(row, c)).toBe(true);
    const no = (c: Parameters<typeof matchesCondition>[1]) => expect(matchesCondition(row, c)).toBe(false);

    yes({ status: { _eq: "open" } });
    no({ status: { _eq: "done" } });
    yes({ status: { _neq: "done" } });
    yes({ status: { _in: ["open", "blocked"] } });
    no({ status: { _nin: ["open"] } });
    yes({ count: { _gt: 4, _lte: 5 } });
    no({ count: { _gte: 6 } });
    yes({ count: { _between: [1, 10] } });
    yes({ note: { _null: true } });
    no({ note: { _null: false } });
    yes({ note: { _empty: true } });
    yes({ title: { _contains: "ell" } });
    yes({ title: { _icontains: "HELL" } });
    yes({ title: { _istarts_with: "he" } });
    yes({ title: { _iends_with: "LO" } });
    no({ title: { _starts_with: "he" } }); // case-sensitive variant
    yes({ $and: [{ status: { _eq: "open" } }, { count: { _gt: 1 } }] });
    yes({ $or: [{ status: { _eq: "done" } }, { count: { _gt: 1 } }] });
    yes({ $not: { status: { _eq: "done" } } });
  });

  test("system columns match through their camelCase wire name", () => {
    const row = { id: "1", updatedAt: "2026-01-02T00:00:00.000Z" };
    expect(matchesCondition(row, { updated_at: { _gte: "2026-01-01T00:00:00.000Z" } })).toBe(true);
  });

  test("what it can't resolve is undecidable, never a guess", () => {
    const row = { id: "1", owner_id: "u1", status: "open" };
    // `$user.id` needs the request identity — the client doesn't have it.
    expect(matchesCondition(row, { owner_id: { _eq: "$user.id" } })).toBeNull();
    // A relation hop can't be answered from one row.
    expect(matchesCondition(row, { "customer.tier": { _eq: "gold" } })).toBeNull();
    // A definite miss on one branch still settles an AND...
    expect(
      matchesCondition(row, { $and: [{ status: { _eq: "done" } }, { owner_id: { _eq: "$user.id" } }] }),
    ).toBe(false);
    // ...and a definite hit settles an OR.
    expect(
      matchesCondition(row, { $or: [{ status: { _eq: "open" } }, { owner_id: { _eq: "$user.id" } }] }),
    ).toBe(true);
    // But an AND that's otherwise satisfied stays undecidable.
    expect(
      matchesCondition(row, { $and: [{ status: { _eq: "open" } }, { owner_id: { _eq: "$user.id" } }] }),
    ).toBeNull();
  });

  test("relative $now values resolve locally", () => {
    const row = { id: "1", due: Date.now() - 60_000 };
    expect(matchesCondition(row, { due: { _lt: "$now" } })).toBe(true);
    expect(matchesCondition(row, { due: { _gte: { $now: { sub: { hours: 1 } } } } })).toBe(true);
    expect(matchesCondition(row, { due: { _gte: { $now: { add: { hours: 1 } } } } })).toBe(false);
  });

  test("agrees with the server's matcher case for case", () => {
    // The client matcher is a deliberate re-implementation (the published SDK
    // can't depend on `@backlex/db`), so the two WILL drift unless something
    // holds them together. This is that something: every case is evaluated by
    // both, and a decided client answer must equal the server's.
    const rows: Record<string, unknown>[] = [
      { id: "1", status: "open", count: 5, title: "Hello", note: null, tag: "" },
      { id: "2", status: "done", count: 0, title: "", note: "x", tag: "a" },
      { id: "3", status: null, count: -3, title: "ÅNGSTRÖM", note: "y", tag: "b" },
    ];
    const conditions = [
      { status: { _eq: "open" } },
      { status: { _neq: "open" } },
      { status: { _null: true } },
      { status: { _null: false } },
      { status: { _in: ["open", "done"] } },
      { status: { _nin: ["open"] } },
      { count: { _gt: 0 } },
      { count: { _gte: 5 } },
      { count: { _lt: 0 } },
      { count: { _lte: 0 } },
      { count: { _between: [-5, 5] } },
      { title: { _contains: "ell" } },
      { title: { _starts_with: "H" } },
      { title: { _ends_with: "o" } },
      { title: { _icontains: "ÅNGST" } },
      { title: { _istarts_with: "hello" } },
      { title: { _iends_with: "RÖM" } },
      { title: { _empty: true } },
      { tag: { _nempty: true } },
      { $and: [{ status: { _eq: "open" } }, { count: { _gt: 1 } }] },
      { $or: [{ status: { _eq: "done" } }, { count: { _lt: 0 } }] },
      { $not: { status: { _eq: "open" } } },
      { status: { _eq: "open" }, count: { _gte: 5 } },
    ];
    const subject = { userId: "u1", email: "u@example.com", roles: [], tenantId: "t1" };
    let compared = 0;
    for (const row of rows) {
      for (const cond of conditions) {
        const mine = matchesCondition(row, cond as never);
        if (mine === null) continue; // undecidable is always a safe answer
        const theirs = serverMatches(row, cond as never, subject as never);
        expect(`${JSON.stringify(cond)} on ${row.id} → ${mine}`).toBe(
          `${JSON.stringify(cond)} on ${row.id} → ${theirs}`,
        );
        compared++;
      }
    }
    expect(compared).toBe(rows.length * conditions.length);
  });

  test("the client and server agree on a shape's key", () => {
    // Key order must not matter — the server sorts before hashing, so a client
    // that writes the object differently still recognises its own store.
    expect(shapeKey({ $and: [{ a: { _eq: 1 } }, { b: { _eq: 2 } }] })).toBe(
      shapeKey({ $and: [{ a: { _eq: 1 } }, { b: { _eq: 2 } }] }),
    );
    expect(shapeKey({ a: { _eq: 1 }, b: { _eq: 2 } })).toBe(shapeKey({ b: { _eq: 2 }, a: { _eq: 1 } }));
    expect(shapeKey({ a: { _eq: 1 } })).not.toBe(shapeKey({ a: { _eq: 2 } }));
    expect(shapeKey(null)).toBe("all");
  });
});

describe("sync v2 — live updates under a shape", () => {
  /** A fake whose realtime channel the test can drive by hand. */
  const makeLive = (pages: Page[]) => {
    let emit: ((e: { event: "created" | "updated" | "deleted"; data: Record<string, unknown> }) => void) | null = null;
    let pulls = 0;
    const client: SyncClientLike = {
      request: async <T>(_m: string, path: string): Promise<T> => {
        if (path.includes("/changes")) {
          pulls++;
          return (pages[Math.min(pulls - 1, pages.length - 1)] ?? { data: [], cursor: null, hasMore: false }) as T;
        }
        return { data: { results: [] } } as T;
      },
      subscribe: (_ch, onEvent) => {
        emit = onEvent;
        return () => { emit = null; };
      },
    };
    return { client, send: (e: Parameters<NonNullable<typeof emit>>[0]) => emit?.(e), pulls: () => pulls };
  };

  test("an in-shape event lands, an out-of-shape one is dropped", async () => {
    const { client, send } = makeLive([{ data: [], cursor: "c1", hasMore: false }]);
    const store = memoryStore();
    const sync = createSync(client, { collection: "tasks", store, shape: { status: { _eq: "open" } } });
    sync.live();

    send({ event: "created", data: { id: "a", status: "open", title: "mine" } });
    send({ event: "created", data: { id: "b", status: "done", title: "not mine" } });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));

    expect((await sync.getAll()).map((r) => r.id)).toEqual(["a"]);
    sync.stop();
  });

  test("a row edited out of the shape is removed live", async () => {
    const { client, send } = makeLive([{ data: [], cursor: "c1", hasMore: false }]);
    const store = memoryStore();
    await store.set("a", { id: "a", status: "open" });
    const sync = createSync(client, { collection: "tasks", store, shape: { status: { _eq: "open" } } });
    sync.live();

    send({ event: "updated", data: { id: "a", status: "done" } });
    await new Promise((r) => setTimeout(r, 5));

    expect(await sync.get("a")).toBeUndefined();
    sync.stop();
  });

  test("an undecidable shape falls back to a pull instead of guessing", async () => {
    const { client, send, pulls } = makeLive([{ data: [], cursor: "c1", hasMore: false }]);
    const sync = createSync(client, {
      collection: "tasks",
      store: memoryStore(),
      shape: { owner_id: { _eq: "$user.id" } },
    });
    sync.live();

    send({ event: "updated", data: { id: "a", owner_id: "someone" } });
    await new Promise((r) => setTimeout(r, 5));

    expect(pulls()).toBe(1);
    sync.stop();
  });

  test("a delete is honoured regardless of the shape", async () => {
    const { client, send } = makeLive([{ data: [], cursor: "c1", hasMore: false }]);
    const store = memoryStore();
    await store.set("a", { id: "a", status: "open" });
    const sync = createSync(client, { collection: "tasks", store, shape: { status: { _eq: "open" } } });
    sync.live();

    send({ event: "deleted", data: { id: "a" } });
    await new Promise((r) => setTimeout(r, 5));

    expect(await sync.get("a")).toBeUndefined();
    sync.stop();
  });
});

describe("sync v2 — sqliteStore", () => {
  const open = (name: string) => {
    const db = new Database(":memory:");
    return sqliteStore({
      collection: name,
      db: {
        run: (sql, p = []) => db.prepare(sql).run(...(p as never[])),
        all: (sql, p = []) => db.prepare(sql).all(...(p as never[])),
      },
    });
  };

  test("round-trips rows, meta and the write queue", async () => {
    const store = open("notes");
    await store.set("1", { id: "1", title: "a", nested: { x: 1 } });
    await store.set("2", { id: "2", title: "b" });
    expect((await store.get("1"))?.title).toBe("a");
    expect(((await store.get("1"))?.nested as { x: number }).x).toBe(1);
    expect((await store.all()).length).toBe(2);

    await store.remove("1");
    expect(await store.get("1")).toBeUndefined();
    expect((await store.all()).length).toBe(1);

    expect(await store.getMeta("cursor")).toBeNull();
    await store.setMeta("cursor", "c1");
    await store.setMeta("cursor", "c2"); // upsert, not a duplicate-key crash
    expect(await store.getMeta("cursor")).toBe("c2");

    const ops: QueuedOp[] = [{ kind: "update", id: "2", data: { title: "z" } }];
    await store.queueSet(ops);
    expect(await store.queueGet()).toEqual(ops);
  });

  test("drives a full sync cycle end to end", async () => {
    const store = open("tasks");
    const { client } = makeFake([{ data: [{ id: "s1", title: "server" }], cursor: "c1", hasMore: false }]);
    setOnline(true);
    const sync = createSync(client, { collection: "tasks", store });
    await sync.pull();
    expect((await sync.get("s1"))?.title).toBe("server");
    await sync.create({ title: "local" });
    expect((await sync.getAll()).length).toBe(2);
    expect(await store.queueGet()).toEqual([]);
  });

  test("a collection name can't smuggle SQL into the table name", async () => {
    const store = open('notes"; DROP TABLE x; --');
    await store.set("1", { id: "1" });
    expect((await store.get("1"))?.id).toBe("1");
  });
});
