/**
 * Phase 3 grammar additions — new comparison operators (`_between`,
 * `_icontains`/`_istarts_with`/`_iends_with`, `_empty`/`_nempty`) and
 * first-class relative dates (`{ $now: { sub|add: {...} } }`).
 *
 * Operators are exercised end-to-end through the REST list endpoint (SQL path)
 * and, where the JS predicate must agree, cross-checked against
 * `matchesCondition` (@backlex/db) on the same rows — the realtime/SQL parity
 * guard. Timestamps are stored as epoch-ms on SQLite, so the relative-date
 * test inserts numeric instants.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { matchesCondition } from "@backlex/db";
import type { AuthSubject, Condition } from "@backlex/core";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const AUTH: AuthSubject = { userId: null, email: null, roles: [] };

const listWithFilter = async (
  h: TestHarness,
  slug: string,
  filter: unknown,
): Promise<Record<string, unknown>[]> => {
  const res = await h.fetch(
    `/api/items/${slug}?filter=${encodeURIComponent(JSON.stringify(filter))}&limit=100`,
  );
  if (!res.ok) throw new Error(`list → ${res.status} ${await res.text()}`);
  return ((await res.json()) as { data: Record<string, unknown>[] }).data;
};

describe("Phase 3 — comparison operators + relative dates", () => {
  let h: TestHarness;
  const slug = `ops_${Date.now()}`;
  let all: Record<string, unknown>[] = [];
  const now = Date.now();
  const DAY = 86_400_000;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const json = async (path: string, body: unknown) => {
      const res = await h.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
      return res.json();
    };
    await json("/api/collections", {
      slug,
      fields: [
        { name: "name", type: "text", required: true },
        { name: "score", type: "integer" },
        { name: "note", type: "text" },
        { name: "event_at", type: "timestamp" },
      ],
    });
    await json(`/api/items/${slug}`, { name: "Alice", score: 5, note: "hi", event_at: now });
    await json(`/api/items/${slug}`, { name: "alice cooper", score: 15, note: "", event_at: now - 2 * DAY });
    await json(`/api/items/${slug}`, { name: "Bob", score: 25, event_at: now - 10 * DAY });
    all = await listWithFilter(h, slug, {});
    expect(all.length).toBe(3);
  });
  afterAll(() => h.cleanup());

  test("_between (integer) — SQL result matches matchesCondition", async () => {
    const filter: Condition = { score: { _between: [10, 20] } } as Condition;
    const rows = await listWithFilter(h, slug, filter);
    expect(rows.map((r) => r.name)).toEqual(["alice cooper"]);
    // Parity: same membership when evaluated in JS.
    const jsMatched = all.filter((r) => matchesCondition(r, filter, AUTH)).map((r) => r.name);
    expect(jsMatched.sort()).toEqual(rows.map((r) => r.name).sort());
  });

  test("_icontains (case-insensitive) — SQL result matches matchesCondition", async () => {
    const filter: Condition = { name: { _icontains: "ALICE" } } as Condition;
    const rows = await listWithFilter(h, slug, filter);
    expect(rows.map((r) => r.name).sort()).toEqual(["Alice", "alice cooper"]);
    const jsMatched = all.filter((r) => matchesCondition(r, filter, AUTH)).map((r) => r.name);
    expect(jsMatched.sort()).toEqual(["Alice", "alice cooper"]);
  });

  test("_istarts_with matches across case", async () => {
    const rows = await listWithFilter(h, slug, { name: { _istarts_with: "ali" } });
    expect(rows.map((r) => r.name).sort()).toEqual(["Alice", "alice cooper"]);
  });

  test("_empty / _nempty (null OR empty string)", async () => {
    // Bob has no note (null), "alice cooper" has "" → both empty.
    const empty = await listWithFilter(h, slug, { note: { _empty: true } });
    expect(empty.map((r) => r.name).sort()).toEqual(["Bob", "alice cooper"]);
    const nempty = await listWithFilter(h, slug, { note: { _nempty: true } });
    expect(nempty.map((r) => r.name)).toEqual(["Alice"]);
  });

  test("relative date — _gte { $now: { sub: { days: 1 } } } keeps only recent rows", async () => {
    const rows = await listWithFilter(h, slug, {
      event_at: { _gte: { $now: { sub: { days: 1 } } } },
    });
    // Only the row stamped `now` is within the last day.
    expect(rows.map((r) => r.name)).toEqual(["Alice"]);
  });

  test("relative date — _between [ $now-7d, $now ] window", async () => {
    const rows = await listWithFilter(h, slug, {
      event_at: {
        _between: [{ $now: { sub: { days: 7 } } }, { $now: {} }],
      },
    });
    expect(rows.map((r) => r.name).sort()).toEqual(["Alice", "alice cooper"]);
  });
});
