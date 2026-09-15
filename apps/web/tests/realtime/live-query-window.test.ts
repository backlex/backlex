/**
 * Reactive Stage 3 — windowed (`limit`) live queries maintain the window
 * WITHOUT a reconcile refetch on the common insert cases:
 *   - a new row that sorts off-window is dropped (no refetch);
 *   - a new row that sorts in-window evicts the overflow row (no refetch);
 * while the genuinely ambiguous cases still reconcile:
 *   - a removal from a FULL window (a slot opens for an uncached off-window row).
 * Asserted by counting `list()` calls across the debounce window.
 */
import { describe, expect, test } from "bun:test";
import { createLiveQuery, type LiveQueryDeps } from "../../../../packages/client/src/live";

type Row = { id: string; n: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mock = (initial: Row[]) => {
  const state = { data: [...initial], listCalls: 0 };
  let fire: (e: { event: "created" | "updated" | "deleted"; data: Row }) => void = () => {};
  const deps: LiveQueryDeps<Row> = {
    list: async () => {
      state.listCalls++;
      return { data: [...state.data], limit: 50, offset: 0 };
    },
    subscribe: (_ch, onEvent) => {
      fire = onEvent as typeof fire;
      return () => {};
    },
  };
  return { deps, state, fire: (e: Parameters<typeof fire>[0]) => fire(e) };
};

describe("Stage 3 windowed maintenance (no insert refetch)", () => {
  test("off-window insert is dropped with no refetch", async () => {
    const m = mock([
      { id: "a", n: 3 },
      { id: "b", n: 2 },
    ]);
    const results: Row[][] = [];
    createLiveQuery<Row>(m.deps, "nums", { sort: "-n", limit: 2 }, (r) => results.push(r));
    await sleep(10);
    expect(m.state.listCalls).toBe(1); // initial load only

    // n=1 sorts after the boundary (n=2) → off-window.
    m.fire({ event: "created", data: { id: "c", n: 1 } });
    await sleep(150); // past the refetch debounce
    expect(m.state.listCalls).toBe(1); // NO refetch
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["a", "b"]); // unchanged
  });

  test("in-window insert evicts the overflow row with no refetch", async () => {
    const m = mock([
      { id: "a", n: 3 },
      { id: "b", n: 2 },
    ]);
    const results: Row[][] = [];
    createLiveQuery<Row>(m.deps, "nums", { sort: "-n", limit: 2 }, (r) => results.push(r));
    await sleep(10);

    // n=2.5 sorts between a(3) and b(2) → in-window; b is evicted.
    m.fire({ event: "created", data: { id: "d", n: 2.5 } });
    await sleep(150);
    expect(m.state.listCalls).toBe(1); // NO refetch
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["a", "d"]);
  });

  test("removal from a full window reconciles (refetch)", async () => {
    const m = mock([
      { id: "a", n: 3 },
      { id: "b", n: 2 },
    ]);
    const results: Row[][] = [];
    createLiveQuery<Row>(m.deps, "nums", { sort: "-n", limit: 2 }, (r) => results.push(r));
    await sleep(10);
    expect(m.state.listCalls).toBe(1); // loaded [a, b] (full window)
    // After the delete the server would surface the next off-window row.
    m.state.data = [{ id: "b", n: 2 }];

    m.fire({ event: "deleted", data: { id: "a", n: 3 } });
    await sleep(150);
    expect(m.state.listCalls).toBe(2); // reconciled
  });

  test("insert into a NON-full window doesn't refetch", async () => {
    const m = mock([{ id: "a", n: 3 }]);
    const results: Row[][] = [];
    createLiveQuery<Row>(m.deps, "nums", { sort: "-n", limit: 3 }, (r) => results.push(r));
    await sleep(10);

    m.fire({ event: "created", data: { id: "b", n: 5 } });
    await sleep(150);
    expect(m.state.listCalls).toBe(1); // NO refetch
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("sorting and filtering on a system column (#390)", () => {
  // The sort and filter name the COLUMN (`created_at`), which is what the list
  // endpoint accepts; rows arrive with the API's wire names (`createdAt`). Read
  // literally, both sides of every comparison were `undefined`, so a newer row
  // on a full `-created_at` window was appended and then sliced off.
  type Stamped = { id: string; createdAt: string; ownerId?: string };
  const stamped = (initial: Stamped[]) => {
    const state = { data: [...initial], listCalls: 0 };
    let fire: (e: { event: "created" | "updated"; data: Stamped }) => void = () => {};
    const deps: LiveQueryDeps<Stamped> = {
      list: async () => {
        state.listCalls++;
        return { data: [...state.data], limit: 50, offset: 0 };
      },
      subscribe: (_ch, onEvent) => {
        fire = onEvent as typeof fire;
        return () => {};
      },
    };
    return { deps, state, fire: (e: Parameters<typeof fire>[0]) => fire(e) };
  };

  test("a newer row takes the top of a full `-created_at` window and the oldest leaves", async () => {
    const m = stamped([
      { id: "b", createdAt: "2026-09-02T00:00:00.000Z" },
      { id: "a", createdAt: "2026-09-01T00:00:00.000Z" },
    ]);
    const results: Stamped[][] = [];
    createLiveQuery<Stamped>(m.deps, "products", { sort: "-created_at", limit: 2 }, (r) => results.push(r));
    await sleep(10);

    m.fire({ event: "created", data: { id: "c", createdAt: "2026-09-03T00:00:00.000Z" } });
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["c", "b"]);
    await sleep(150);
    expect(m.state.listCalls).toBe(1); // placed by the sort, not by a reconcile
  });

  test("an older row stays off a full `-created_at` window", async () => {
    const m = stamped([
      { id: "b", createdAt: "2026-09-02T00:00:00.000Z" },
      { id: "a", createdAt: "2026-09-01T00:00:00.000Z" },
    ]);
    const results: Stamped[][] = [];
    createLiveQuery<Stamped>(m.deps, "products", { sort: "-created_at", limit: 2 }, (r) => results.push(r));
    await sleep(10);

    m.fire({ event: "created", data: { id: "z", createdAt: "2026-08-01T00:00:00.000Z" } });
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["b", "a"]);
  });

  test("the local filter reads a system column the same way the sort does", async () => {
    const m = stamped([]);
    const results: Stamped[][] = [];
    createLiveQuery<Stamped>(m.deps, "products", { filter: { owner_id: { _eq: "u1" } } }, (r) =>
      results.push(r),
    );
    await sleep(10);

    m.fire({ event: "updated", data: { id: "theirs", createdAt: "x", ownerId: "u2" } });
    m.fire({ event: "updated", data: { id: "mine", createdAt: "x", ownerId: "u1" } });
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["mine"]);
  });
});
