/**
 * SDK signal-plane hydration — the client half of the id-only data plane.
 *
 * A signal says only "row X changed". Everything the rest of the SDK relies on
 * (row data, permission filtering, membership transitions) has to be recovered
 * by reading the row back through the ordinary REST path. These tests pin the
 * three properties that read-back has to deliver:
 *
 *  1. a burst of signals costs ONE read, not one per row;
 *  2. an id that doesn't come back is reported as a removal — that's how
 *     permission filtering and query membership are preserved without the
 *     server ever putting a row on the wire;
 *  3. a failed read-back drops the batch instead of guessing (guessing would
 *     wipe rows that are still perfectly there).
 */
import { describe, expect, test } from "bun:test";
import {
  createSignalHydrator,
  idBatchFilter,
  signalChannel,
  type ItemSignal,
} from "../../../packages/client/src/signal";
import type { ItemEvent } from "../../../packages/client/src/types";

type Row = { id: string; title?: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const signal = (event: ItemSignal["event"], id: string): ItemSignal => ({
  event,
  collection: "todos",
  id,
  at: Date.now(),
});

/** Hydrator wired to an in-memory "server" that returns only `visible` rows. */
const mock = (visible: Row[]) => {
  const events: ItemEvent<Row>[] = [];
  const errors: unknown[] = [];
  const reads: string[][] = [];
  const h = createSignalHydrator<Row>(
    {
      fetchByIds: async (ids) => {
        reads.push([...ids]);
        return visible.filter((r) => ids.includes(r.id));
      },
    },
    (e) => events.push(e),
    (e) => errors.push(e),
  );
  return { h, events, errors, reads };
};

describe("signal hydration", () => {
  test("a burst of signals collapses into ONE read-back", async () => {
    const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, title: `t${i}` }));
    const m = mock(rows);
    for (const r of rows) m.h.push(signal("created", r.id));
    await m.h.flush();

    // A 5-row bulk insert fires 5 signals; without coalescing that would be 5
    // REST round-trips.
    expect(m.reads).toEqual([["r0", "r1", "r2", "r3", "r4"]]);
    expect(m.events.map((e) => e.event)).toEqual(Array(5).fill("created"));
    expect(m.events.map((e) => (e.data as Row).id)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(m.events[0]!.transition).toBe("enter");
  });

  test("repeated signals for one row are deduped, last one wins", async () => {
    const m = mock([{ id: "r1", title: "final" }]);
    m.h.push(signal("created", "r1"));
    m.h.push(signal("updated", "r1"));
    await m.h.flush();

    expect(m.reads).toEqual([["r1"]]);
    expect(m.events).toHaveLength(1);
    expect(m.events[0]!.event).toBe("updated");
    expect(m.events[0]!.transition).toBe("update");
  });

  test("the hydrated event carries the row the server actually returned", async () => {
    const m = mock([{ id: "r1", title: "from-server" }]);
    m.h.push(signal("updated", "r1"));
    await m.h.flush();
    expect(m.events[0]!.data).toEqual({ id: "r1", title: "from-server" });
  });

  test("an id the caller can't read comes back as a removal", async () => {
    // `visible` is empty: the read-back returns nothing for r1, which is what
    // a permission condition (or a filter the row no longer matches) looks like
    // from the client's side.
    const m = mock([]);
    m.h.push(signal("updated", "r1"));
    await m.h.flush();

    expect(m.events).toEqual([
      { event: "deleted", transition: "leave", data: { id: "r1" } as Row },
    ]);
  });

  test("an invisible CREATE is silent — there's nothing to remove", async () => {
    const m = mock([]);
    m.h.push(signal("created", "r1"));
    await m.h.flush();
    // Reporting a removal for a row the caller never had would be noise; a
    // create it can't see simply never entered its result set.
    expect(m.events).toEqual([]);
  });

  test("deletes need no read-back at all", async () => {
    const m = mock([{ id: "r1" }]);
    m.h.push(signal("deleted", "r1"));
    await m.h.flush();

    expect(m.reads).toEqual([]);
    expect(m.events).toEqual([
      { event: "deleted", transition: "leave", data: { id: "r1" } as Row },
    ]);
  });

  test("a mixed batch reads only what needs reading, and emits in order", async () => {
    const m = mock([{ id: "a", title: "A" }]);
    m.h.push(signal("created", "a"));
    m.h.push(signal("deleted", "b"));
    m.h.push(signal("updated", "c"));
    await m.h.flush();

    expect(m.reads).toEqual([["a", "c"]]);
    expect(m.events.map((e) => [e.event, (e.data as Row).id])).toEqual([
      ["created", "a"],
      ["deleted", "b"],
      ["deleted", "c"], // read back nothing → not visible → drop it
    ]);
  });

  test("a failed read-back reports the error and emits NOTHING", async () => {
    const events: ItemEvent<Row>[] = [];
    const errors: unknown[] = [];
    const h = createSignalHydrator<Row>(
      {
        fetchByIds: async () => {
          throw new Error("offline");
        },
      },
      (e) => events.push(e),
      (e) => errors.push(e),
    );
    h.push(signal("updated", "r1"));
    await h.flush();

    // Emitting removals here would wipe rows that are still there — the read
    // failed, the rows didn't.
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test("signals arriving in one tick auto-flush together", async () => {
    const m = mock([{ id: "r1" }, { id: "r2" }]);
    m.h.push(signal("updated", "r1"));
    m.h.push(signal("updated", "r2"));
    await sleep(120); // past the coalesce window

    expect(m.reads).toEqual([["r1", "r2"]]);
    expect(m.events).toHaveLength(2);
  });

  test("close() stops a pending batch from emitting after teardown", async () => {
    const m = mock([{ id: "r1" }]);
    m.h.push(signal("updated", "r1"));
    m.h.close();
    await sleep(120);

    expect(m.reads).toEqual([]);
    expect(m.events).toEqual([]);
  });
});

describe("read-back filter composition", () => {
  test("ids alone when the subscription has no filter", () => {
    expect(idBatchFilter(null, ["a", "b"])).toEqual({ id: { _in: ["a", "b"] } } as never);
  });

  test("the subscription filter is AND'd, never replaced", () => {
    // The ids must NARROW the query, not widen it: a row that matches the ids
    // but not the filter must still be excluded, so that "absent from the
    // response" keeps meaning "not a member".
    const filter = { done: { _eq: false } } as never;
    expect(idBatchFilter(filter, ["a"])).toEqual({
      $and: [filter, { id: { _in: ["a"] } }],
    } as never);
  });

  test("channel naming matches the server's", () => {
    expect(signalChannel("todos")).toBe("signal:items:todos");
  });
});
