/**
 * The flows page reads a saved trigger key into parts before it prints it.
 *
 * It used to print the key verbatim, so a date schedule showed its whole JSON
 * spec in the list and in the preview node. These pin the read for every shape
 * the runtime matches on — including the ones the builder cannot emit — and
 * the cron cadences that are allowed to become a sentence. A cadence that
 * would be wrong for part of its cycle must stay a raw pattern.
 */
import { describe, expect, test } from "bun:test";
import { formatScheduleTrigger } from "@backlex/core";
import { countFilters, cronCadence, readTrigger } from "../../src/client/admin/pages/automation/flow-trigger-view";

describe("readTrigger", () => {
  test("item events, with `*` and a channel-only key read as 'any'", () => {
    expect(readTrigger("event:items:posts:created")).toEqual({ kind: "item", event: "created", collection: "posts" });
    expect(readTrigger("event:items:*:deleted")).toEqual({ kind: "item", event: "deleted", collection: null });
    expect(readTrigger("event:items:orders")).toEqual({ kind: "item", event: null, collection: "orders" });
    expect(readTrigger("event:items:orders:*")).toEqual({ kind: "item", event: null, collection: "orders" });
    // The runtime matches an unprefixed key the same way.
    expect(readTrigger("items:posts:updated")).toEqual({ kind: "item", event: "updated", collection: "posts" });
  });

  test("a lifecycle move reads its edge, with `*` and absent segments as 'any'", () => {
    expect(readTrigger("event:items:returns:transition:status:*:received")).toEqual({
      kind: "transition",
      collection: "returns",
      field: "status",
      from: null,
      to: "received",
    });
    expect(readTrigger("event:items:invoices:transition:status:open:paid")).toEqual({
      kind: "transition",
      collection: "invoices",
      field: "status",
      from: "open",
      to: "paid",
    });
    expect(readTrigger("event:items:invoices:transition")).toEqual({
      kind: "transition",
      collection: "invoices",
      field: null,
      from: null,
      to: null,
    });
    // One segment past `<to>` is not a transition key the runtime publishes.
    expect(readTrigger("event:items:invoices:transition:status:open:paid:x")).toEqual({
      kind: "event",
      key: "items:invoices:transition:status:open:paid:x",
    });
  });

  test("an item event the collection channel does not publish is a plain event", () => {
    expect(readTrigger("event:items:posts:published")).toEqual({ kind: "event", key: "items:posts:published" });
    expect(readTrigger("event:payments:succeeded")).toEqual({ kind: "event", key: "payments:succeeded" });
  });

  test("the keys with no collection", () => {
    expect(readTrigger("event:auth:signup")).toEqual({ kind: "signup" });
    expect(readTrigger("webhook")).toEqual({ kind: "webhook" });
    expect(readTrigger("manual")).toEqual({ kind: "manual" });
    expect(readTrigger("manual:backfill")).toEqual({ kind: "manual" });
  });

  test("cron keeps its pattern and adds the cadence when there is one", () => {
    expect(readTrigger("cron:0 3 * * *")).toEqual({
      kind: "cron",
      pattern: "0 3 * * *",
      cadence: { every: "day", hour: 3, minute: 0 },
    });
    expect(readTrigger("cron:0 0 1 1 *")).toEqual({ kind: "cron", pattern: "0 0 1 1 *", cadence: null });
  });

  test("a date schedule comes back as its spec plus a filter count", () => {
    const spec = {
      collection: "orders",
      field: "placed_at",
      offset: { value: 1, unit: "days" as const, direction: "after" as const },
      at: 540,
      timeZone: null,
      where: {
        state: { _eq: "open" },
        status: { _eq: "paid" },
        fulfillment_status: { _in: ["unfulfilled", "partial"] },
      },
    };
    expect(readTrigger(formatScheduleTrigger(spec))).toEqual({ kind: "schedule", spec, filters: 3 });
  });

  test("a schedule that no longer validates is unknown, not a schedule", () => {
    const broken = 'schedule:{"collection":"orders"}';
    expect(readTrigger(broken)).toEqual({ kind: "unknown", raw: broken });
    expect(readTrigger("")).toEqual({ kind: "unknown", raw: "" });
  });
});

describe("cronCadence", () => {
  test.each([
    ["* * * * *", { every: "minute", step: 1 }],
    ["*/15 * * * *", { every: "minute", step: 15 }],
    ["0 * * * *", { every: "hour", step: 1, minute: 0 }],
    ["30 */6 * * *", { every: "hour", step: 6, minute: 30 }],
    ["0 9 * * *", { every: "day", hour: 9, minute: 0 }],
    ["0 9 * * 1-5", { every: "weekdays", hour: 9, minute: 0 }],
    ["0 9 * * mon-fri", { every: "weekdays", hour: 9, minute: 0 }],
    ["0 9 * * 0-6", { every: "day", hour: 9, minute: 0 }],
    ["15 8 * * 1", { every: "week", days: [1], hour: 8, minute: 15 }],
    // Monday first, and 7 is Sunday.
    ["0 18 * * 7,5,6", { every: "week", days: [5, 6, 0], hour: 18, minute: 0 }],
    ["0 4 1 * *", { every: "month", day: 1, hour: 4, minute: 0 }],
  ])("%s", (pattern, cadence) => {
    expect(cronCadence(pattern)).toEqual(cadence as ReturnType<typeof cronCadence>);
  });

  test.each([
    // Fires at :56 and then :00 — not every 7 minutes.
    "*/7 * * * *",
    "0 */5 * * *",
    "0 0 1 1 *",
    "0 9,17 * * *",
    "0 9 1 * 1",
    "*/15 */2 * * *",
    "0 0 * * * *",
    "0 25 * * *",
    "0 9 * * fri-mon",
  ])("%s has no plain reading", (pattern) => {
    expect(cronCadence(pattern)).toBeNull();
  });
});

describe("countFilters", () => {
  test("counts fields, through $and / $or / $not", () => {
    expect(countFilters(null)).toBe(0);
    expect(countFilters({ status: { _eq: "active" } })).toBe(1);
    expect(countFilters({ amount: { _gte: 1, _lte: 5 } })).toBe(1);
    expect(
      countFilters({
        $or: [{ status: { _eq: "paid" } }, { $and: [{ state: { _eq: "open" } }, { total: { _gt: 0 } }] }],
      }),
    ).toBe(3);
    expect(countFilters({ $not: { archived: { _eq: true } } })).toBe(1);
  });
});
