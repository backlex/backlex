/**
 * Read paths that had no ceiling.
 *
 * `GET /api/items/:slug/export` materialized every matching row, mapped it, and
 * built one string — so on a large collection it did not return a big response,
 * it exhausted the isolate. `?offset=` had no maximum, and `OFFSET n` costs O(n)
 * on both dialects (on D1, billed per row scanned).
 *
 * Each boundary is pinned exactly — `n` passes and `n + 1` is refused — rather
 * than asserting "some large number errors", which would pass against any cap
 * at all, including one an order of magnitude off.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { pgClientOptions } from "@backlex/db/pg";

const json = { "content-type": "application/json" };

describe("bounded reads", () => {
  let h: TestHarness;
  const slug = `bound_${Date.now()}`;

  beforeAll(async () => {
    // A tiny cap so the over-limit arm is reachable without seeding 100k rows.
    h = makeHarness({ EXPORT_MAX_ROWS: "3" });
    await seedAdmin(h);
    const made = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ slug, fields: [{ name: "title", type: "text" }] }),
    });
    expect(made.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  const addItems = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i += 1) {
      const r = await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ title: `row-${i}` }),
      });
      expect(r.status).toBe(201);
    }
  };

  test("export succeeds AT the cap and is refused one row past it", async () => {
    await addItems(3);
    const ok = await h.fetch(`/api/items/${slug}/export?format=json`);
    expect(ok.status).toBe(200);
    // Exactly at the limit returns every row — an off-by-one in the `LIMIT
    // cap + 1` fetch would silently hand back 3 of 3 or refuse at 3, and only a
    // count assertion sees the difference.
    expect((await ok.json()) as unknown[]).toHaveLength(3);

    await addItems(1);
    const over = await h.fetch(`/api/items/${slug}/export?format=json`);
    expect(over.status).toBe(422);
    const body = (await over.json()) as { error?: { message?: string } };
    // The message must point at the path that actually works, or the ceiling is
    // just a dead end for whoever hits it.
    expect(body.error?.message).toContain("cursor");
    expect(body.error?.message).toContain("EXPORT_MAX_ROWS");
  });

  test("offset is accepted at the ceiling and refused above it", async () => {
    const at = await h.fetch(`/api/items/${slug}?offset=100000&limit=1`);
    expect(at.status).toBe(200);
    const over = await h.fetch(`/api/items/${slug}?offset=100001&limit=1`);
    expect(over.status).toBe(422);
  });
});

describe("pg client options", () => {
  // pglite does not use postgres-js, so the real client's behaviour cannot be
  // observed from any harness here. Asserting the resolved options object is the
  // honest substitute — and it is the object that matters, since the risk is a
  // setting silently applying to the migration handle.
  test("pools and connect-timeouts by default, with no statement timeout", () => {
    const o = pgClientOptions();
    expect(o.prepare).toBe(false);
    expect(o.max).toBe(10);
    expect(o.connect_timeout).toBe(10);
    // The load-bearing assertion: ON by default would make a slow CREATE INDEX
    // a failed migration retried on every cold start.
    expect(o.connection).toBeUndefined();
  });

  test("statement timeout is applied only when explicitly set", () => {
    expect(pgClientOptions({ statementTimeoutMs: "" }).connection).toBeUndefined();
    expect(pgClientOptions({ statementTimeoutMs: 0 }).connection).toBeUndefined();
    expect(pgClientOptions({ statementTimeoutMs: null }).connection).toBeUndefined();
    expect(pgClientOptions({ statementTimeoutMs: "30000" }).connection).toEqual({
      statement_timeout: "30000",
    });
  });
});
