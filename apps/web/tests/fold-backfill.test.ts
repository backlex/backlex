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
import { invalidateTenantCollections } from "../src/server/services/collections-cache";
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

  test("a table WITHOUT the companion falls back — it does not return silently empty", async () => {
    // The release blocker this catches. A collection created before folded
    // search existed has `text` fields and no companion columns until its
    // schema is next applied. Inferring "foldable" from the field TYPES made
    // the compiler name a column that is not there — and on SQLite that does
    // not raise: an unresolvable double-quoted identifier is read as a STRING
    // LITERAL, so `"name__fold" LIKE '%x%'` is `'name__fold' LIKE '%x%'` and
    // matches nothing. Every `_icontains` on every pre-existing collection
    // would have answered 200 with zero rows.
    //
    // The predicate reads the table instead, so the column's absence means
    // "fall back", not "match nothing".
    const made = await post("/api/collections", {
      slug: "legacy2",
      fields: [{ name: "name", type: "text" }],
    });
    expect(made.status).toBe(201);
    const t2 = ((await made.json()) as { data: { physicalTable: string } }).data.physicalTable;
    const r = await post("/api/items/legacy2", { name: "İşlemci soğutucu" });
    expect([200, 201]).toContain(r.status);

    // Make it look like a table from before the feature. The cache is dropped
    // with it: the loader introspects on a cache FILL, so an entry written when
    // the column still existed would keep answering for it. A real upgrade
    // never has that entry — the column was never there to cache.
    const meta = (await (await h.fetch("/api/collections/legacy2")).json()) as {
      data: { tenantId?: string; tenant_id?: string };
    };
    await runSql(`ALTER TABLE "${t2}" DROP COLUMN "name__fold"`);
    invalidateTenantCollections((meta.data.tenantId ?? meta.data.tenant_id) as string);

    const find = async (needle: string) => {
      const f = encodeURIComponent(JSON.stringify({ name: { _icontains: needle } }));
      const res = await h.fetch(`/api/items/legacy2?filter=${f}&limit=10`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { name: string }[] }).data.map((x) => x.name);
    };

    // The fallback is the OLD behaviour: ASCII folds, a non-ASCII letter has to
    // be typed as stored. Narrower than the companion, and NOT empty.
    expect(await find("İşlemci")).toEqual(["İşlemci soğutucu"]);
    expect(await find("SOğutucu")).toEqual(["İşlemci soğutucu"]);
    // And the thing only a companion can do is simply unavailable here, rather
    // than taking the whole operator down with it.
    expect(await find("islemci")).toEqual([]);
  });
});
