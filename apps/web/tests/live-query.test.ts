/**
 * Unit tests for the SDK reactive-query engine (`createLiveQuery`) — pure JS,
 * no server. Deps (`list` + `subscribe`) are mocked so we can drive realtime
 * events deterministically and assert how the result array is maintained:
 * incremental insert/update/remove + sort + limit window, and the refetch
 * fallback for queries the engine can't maintain in JS.
 */
import { describe, expect, test } from "bun:test";
import {
  createLiveQuery,
  matchesRow,
  isIncrementalSafe,
  type LiveQueryDeps,
} from "../../../packages/client/src/live";

type Row = { id: string; n: number; tag?: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A mock client: `list` returns the current `data` snapshot; `subscribe`
 *  captures the event callback so tests can fire realtime events. */
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

describe("matchesRow", () => {
  test("operators", () => {
    expect(matchesRow({ n: 5 }, { n: { _eq: 5 } })).toBe(true);
    expect(matchesRow({ n: 5 }, { n: { _gt: 4, _lt: 10 } })).toBe(true);
    expect(matchesRow({ n: 5 }, { n: { _gt: 5 } })).toBe(false);
    expect(matchesRow({ t: "abc" }, { t: { _contains: "b" } })).toBe(true);
    expect(matchesRow({ t: "ABC" }, { t: { _icontains: "abc" } })).toBe(true);
    expect(matchesRow({ s: "x" }, { s: { _in: ["x", "y"] } })).toBe(true);
    expect(matchesRow({ s: null }, { s: { _null: true } })).toBe(true);
    expect(
      matchesRow({ a: 1, b: 2 }, { $or: [{ a: { _eq: 9 } }, { b: { _eq: 2 } }] }),
    ).toBe(true);
    expect(matchesRow({ a: 1 }, { $not: { a: { _eq: 1 } } })).toBe(false);
  });
});

describe("isIncrementalSafe", () => {
  test("plain top-level filter+sort is safe", () => {
    expect(isIncrementalSafe({ filter: { n: { _gt: 1 } }, sort: "-n" })).toBe(true);
  });
  test("nested path, q search, expand, and $now/$user values force refetch mode", () => {
    expect(isIncrementalSafe({ filter: { "rel.x": { _eq: 1 } } })).toBe(false);
    expect(isIncrementalSafe({ sort: "rel.x" })).toBe(false);
    expect(isIncrementalSafe({ q: "hi" })).toBe(false);
    expect(isIncrementalSafe({ expand: "rel" })).toBe(false);
    expect(isIncrementalSafe({ filter: { created_at: { _gte: { $now: { sub: { days: 1 } } } } } })).toBe(false);
    expect(isIncrementalSafe({ filter: { owner_id: { _eq: "$user.id" } } })).toBe(false);
  });
});

describe("createLiveQuery — incremental maintenance", () => {
  test("initial result, then insert/update/remove keep the sorted array consistent", async () => {
    const { deps, fire } = mock([
      { id: "3", n: 1 },
      { id: "1", n: 2 },
    ]);
    const results: Row[][] = [];
    const stop = createLiveQuery<Row>(
      deps,
      "nums",
      { filter: { n: { _lt: 10 } }, sort: "n" },
      (rows) => results.push(rows),
    );
    await sleep(10);
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["3", "1"]); // initial

    // created, matches → inserted at the sorted position (n=1.5 between 1 and 2)
    fire({ event: "created", data: { id: "2", n: 1.5 } });
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["3", "2", "1"]);

    // updated → moves to the front (n=0)
    fire({ event: "updated", data: { id: "1", n: 0 } });
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["1", "3", "2"]);

    // created, does NOT match the filter → ignored
    fire({ event: "created", data: { id: "9", n: 99 } });
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["1", "3", "2"]);

    // an existing row updated OUT of the filter → removed
    fire({ event: "updated", data: { id: "3", n: 50 } });
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["1", "2"]);

    // deleted → removed
    fire({ event: "deleted", data: { id: "1", n: 0 } });
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["2"]);
    stop();
  });

  test("limit window: a removal triggers a reconcile refetch", async () => {
    const { deps, state, fire } = mock([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    const results: Row[][] = [];
    const stop = createLiveQuery<Row>(deps, "nums", { sort: "n", limit: 2 }, (rows) =>
      results.push(rows),
    );
    await sleep(10);
    const callsAfterInit = state.listCalls;
    // The off-window next row exists on the server; simulate it being there.
    state.data = [
      { id: "b", n: 2 },
      { id: "c", n: 3 },
    ];
    fire({ event: "deleted", data: { id: "a", n: 1 } });
    // Optimistic removal is immediate…
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["b"]);
    // …and a debounced reconcile refetch pulls the window back to full.
    await sleep(150);
    expect(state.listCalls).toBeGreaterThan(callsAfterInit);
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["b", "c"]);
    stop();
  });
});

describe("createLiveQuery — refetch fallback", () => {
  test("a q-search query refetches on any event instead of incremental apply", async () => {
    const { deps, state, fire } = mock([{ id: "a", n: 1 }]);
    const results: Row[][] = [];
    const stop = createLiveQuery<Row>(deps, "nums", { q: "hello" }, (rows) =>
      results.push(rows),
    );
    await sleep(10);
    const before = state.listCalls;
    state.data = [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ];
    fire({ event: "created", data: { id: "b", n: 2 } });
    await sleep(150);
    expect(state.listCalls).toBeGreaterThan(before); // refetched, not incremental
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["a", "b"]);
    stop();
  });
});
