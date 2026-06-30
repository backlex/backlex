/**
 * SDK liveQuery ⇄ reactive Stage 1/2 wiring: a filter is forwarded to the
 * server for narrowing, and when the server annotates an event with a
 * membership `transition` the client TRUSTS it (so `$user`/`$now` filters the
 * client can't evaluate in JS still maintain correctly). With no transition
 * (older server) it falls back to the local filter.
 */
import { describe, expect, test } from "bun:test";
import { createLiveQuery, type LiveQueryDeps } from "../../../packages/client/src/live";

type Row = { id: string; done?: boolean };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mock = (initial: Row[]) => {
  let fire: (e: {
    event: "created" | "updated" | "deleted";
    data: Row;
    transition?: "enter" | "leave" | "update";
  }) => void = () => {};
  let capturedQuery: string | undefined;
  const deps: LiveQueryDeps<Row> = {
    list: async () => ({ data: [...initial], limit: 50, offset: 0 }),
    subscribe: (_ch, onEvent, _onErr, query) => {
      fire = onEvent as typeof fire;
      capturedQuery = query;
      return () => {};
    },
  };
  return { deps, fire: (e: Parameters<typeof fire>[0]) => fire(e), query: () => capturedQuery };
};

describe("liveQuery reactive wiring", () => {
  test("a simple filter is forwarded to the server subscribe", async () => {
    const m = mock([]);
    const stop = createLiveQuery<Row>(m.deps, "todos", { filter: { done: { _eq: false } } }, () => {});
    await sleep(5);
    expect(m.query()).toBeDefined();
    const decoded = JSON.parse(decodeURIComponent(m.query()!.replace(/^filter=/, "")));
    expect(decoded).toEqual({ done: { _eq: false } });
    stop();
  });

  test("a nested-path filter is NOT forwarded (server can't evaluate a flat row)", async () => {
    const m = mock([]);
    const stop = createLiveQuery<Row>(m.deps, "todos", { filter: { "rel.x": { _eq: 1 } } }, () => {});
    await sleep(5);
    expect(m.query()).toBeUndefined();
    stop();
  });

  test("a server `leave` transition removes the row even if it still matches locally", async () => {
    const m = mock([{ id: "1", done: false }]);
    const results: Row[][] = [];
    const stop = createLiveQuery<Row>(m.deps, "todos", { filter: { done: { _eq: false } } }, (r) =>
      results.push(r),
    );
    await sleep(5);
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["1"]);
    // data STILL matches the local filter (done:false), but the server says it
    // left the window — trust it.
    m.fire({ event: "updated", transition: "leave", data: { id: "1", done: false } });
    expect(results.at(-1)!.map((r) => r.id)).toEqual([]);
    stop();
  });

  test("a server `enter` transition inserts even if it does NOT match locally", async () => {
    const m = mock([]);
    const results: Row[][] = [];
    const stop = createLiveQuery<Row>(m.deps, "todos", { filter: { done: { _eq: false } } }, (r) =>
      results.push(r),
    );
    await sleep(5);
    // data does NOT match the local filter (done:true) — but the server
    // resolved membership (e.g. a $user/$now clause) and says it entered.
    m.fire({ event: "updated", transition: "enter", data: { id: "2", done: true } });
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["2"]);
    stop();
  });

  test("no transition (older server) falls back to the local filter", async () => {
    const m = mock([]);
    const results: Row[][] = [];
    const stop = createLiveQuery<Row>(m.deps, "todos", { filter: { done: { _eq: false } } }, (r) =>
      results.push(r),
    );
    await sleep(5);
    // No transition + doesn't match the local filter → ignored.
    m.fire({ event: "created", data: { id: "3", done: true } });
    expect(results.at(-1)?.map((r) => r.id) ?? []).toEqual([]);
    // No transition + matches → inserted.
    m.fire({ event: "created", data: { id: "4", done: false } });
    expect(results.at(-1)!.map((r) => r.id)).toEqual(["4"]);
    stop();
  });
});
