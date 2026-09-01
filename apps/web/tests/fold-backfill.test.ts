/**
 * Rows that predate the folded companion.
 *
 * Every existing workspace is in this state the moment the feature ships: the
 * ALTER adds the column, and every row already in the table has NULL in it. And
 * a NULL companion is not a degraded filter — `NULL LIKE '%x%'` is NULL, so the
 * row is **invisible** to `_icontains`. Shipping the column without filling it
 * would turn a working search into an empty one for every row anybody already
 * had, silently.
 *
 * The same mechanism carries a second case that is easy to miss: a RESTORE
 * writes columns verbatim from the dump, so a backup taken before this existed
 * brings its rows back unfolded. `restoreBackup` runs the backfill after the
 * inserts for exactly that reason.
 *
 * Simulated here by NULLing the companion through the admin SQL surface, which
 * is what both cases look like from the table's point of view.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = { "Content-Type": "application/json" };

describe("the fold backfill", () => {
  let h: TestHarness;
  let table = "";
  const slug = "legacy";

  const post = (path: string, body: unknown) =>
    h.fetch(path, { method: "POST", headers: json, body: JSON.stringify(body) });

  /** Writes need both the query flag AND the confirm header — the admin SQL
   *  surface is read-only until a caller says twice that it means it. */
  const runSql = async (statement: string) => {
    const res = await h.fetch("/api/admin/db/sql/run?writes=1", {
      method: "POST",
      headers: { ...json, "x-backlex-confirm": "yes" },
      body: JSON.stringify({ sql: statement }),
    });
    expect([200, 201]).toContain(res.status);
    return res;
  };

  const foundBy = async (needle: string): Promise<string[]> => {
    const filter = encodeURIComponent(JSON.stringify({ name: { _icontains: needle } }));
    const res = await h.fetch(`/api/items/${slug}?filter=${filter}&limit=50`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { name: string }[] }).data
      .map((r) => r.name)
      .sort();
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const made = await post("/api/collections", {
      slug,
      fields: [{ name: "name", type: "text" }],
    });
    expect(made.status).toBe(201);
    const body = (await made.json()) as { data: { physicalTable: string } };
    table = body.data.physicalTable;
    expect(table).toBeTruthy();

    for (const name of ["Şule Çağlar", "Öztürk Yıldız", "Straße 12"]) {
      const r = await post(`/api/items/${slug}`, { name });
      expect([200, 201]).toContain(r.status);
    }
  });
  afterAll(() => h.cleanup());

  test("a row whose companion is NULL is invisible — which is why this matters", async () => {
    // Written normally, all three are findable the ASCII way.
    expect(await foundBy("sule")).toEqual(["Şule Çağlar"]);
    expect(await foundBy("ozturk")).toEqual(["Öztürk Yıldız"]);
    expect(await foundBy("strasse")).toEqual(["Straße 12"]);

    // Now they look like rows that predate the column.
    await runSql(`UPDATE "${table}" SET "name__fold" = NULL`);

    // Not "fewer results" — NONE. This is the failure the backfill prevents,
    // and asserting it here is what stops the next test from passing vacuously.
    expect(await foundBy("sule")).toEqual([]);
    expect(await foundBy("ozturk")).toEqual([]);
    expect(await foundBy("strasse")).toEqual([]);
  });

  test("applying the schema fills them, and they come back", async () => {
    // `applyCollection` runs the backfill after its ALTERs — the same call an
    // existing workspace makes the first time its schema is touched.
    const patched = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ fields: [{ name: "name", type: "text" }] }),
    });
    expect([200, 201]).toContain(patched.status);

    expect(await foundBy("sule")).toEqual(["Şule Çağlar"]);
    expect(await foundBy("ozturk")).toEqual(["Öztürk Yıldız"]);
    expect(await foundBy("strasse")).toEqual(["Straße 12"]);
  });

  test("it is idempotent — a second pass changes nothing", async () => {
    // Operationally load-bearing: the backfill runs on EVERY apply, and an
    // apply happens whenever a schema is touched. A pass that re-folded already
    // folded text, or double-applied the map, would drift the column away from
    // what the write path produces.
    const before = await foundBy("sule");
    const again = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ fields: [{ name: "name", type: "text" }] }),
    });
    expect([200, 201]).toContain(again.status);
    expect(await foundBy("sule")).toEqual(before);
  });

  test("it only touches unfolded rows, leaving a hand-set value alone", async () => {
    // The WHERE is `companion IS NULL AND source IS NOT NULL`, which is what
    // makes the pass resumable: a run that stops halfway leaves the rest for the
    // next one, and nothing has to be recorded. A pass that re-folded every row
    // would also be correct but would rewrite the whole table on every apply.
    await runSql(`UPDATE "${table}" SET "name__fold" = 'sentinel' WHERE "name" = 'Straße 12'`);
    const patched = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ fields: [{ name: "name", type: "text" }] }),
    });
    expect([200, 201]).toContain(patched.status);
    // Untouched: the sentinel survived, so the pass skipped a non-NULL companion.
    expect(await foundBy("sentinel")).toEqual(["Straße 12"]);
    expect(await foundBy("strasse")).toEqual([]);
  });
});
