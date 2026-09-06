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
import { buildContext } from "../src/server/context";
import { restoreBackupById } from "../src/server/services/backup";

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

  test("a restore that cannot finish folding says how many rows it left", async () => {
    // The second case this file's header names: a dump taken before folded
    // search existed brings its rows back unfolded, and `restoreBackup` runs
    // the pass afterwards for exactly that reason.
    //
    // The pass is CAPPED, and what it could not reach used to be discarded
    // inside an empty `catch` — so a restore too large to finish folding
    // reported plain success while `_icontains` matched nothing past the cap.
    // Driven here at `batch: 1, maxBatches: 1` because the real cap is 100,000
    // rows and a branch you cannot reach is a branch nobody tests.
    const made = await h.fetch("/api/admin/db/backups/now", {
      method: "POST",
      headers: json,
      body: JSON.stringify({}),
    });
    expect([200, 201]).toContain(made.status);
    const backupId = ((await made.json()) as { data: { id: string } }).data.id;

    // Rows that predate the companion column, and an ADDITIVE restore — the
    // rows still exist, so `ON CONFLICT DO NOTHING` leaves them exactly as they
    // are and the fold pass is the only thing with work to do.
    await runSql(`UPDATE "${table}" SET "name__fold" = NULL`);
    expect(await foundBy("sule")).toEqual([]);

    // The workspace the harness's admin is in — the same value the route reads
    // off `auth`. Asked for rather than assumed: `Ctx` carries no tenant, and a
    // `null` here would ask for an INSTANCE-WIDE restore, which is a different
    // operation that would not find this workspace's backup.
    const meRes = await h.fetch("/api/me");
    expect(meRes.status).toBe(200);
    const tenantId = ((await meRes.json()) as { data: { tenantId: string | null } }).data
      .tenantId;
    expect(tenantId).toBeTruthy();

    const ctx = await buildContext(h.env);
    const result = await restoreBackupById(ctx, tenantId, backupId, {
      fold: { batch: 1, maxBatches: 1 },
    });

    // TWO fold passes run over a restore and both are capped here: the
    // `applyCollection` the collections loop performs (one row) and the pass
    // after the inserts (one more). Three rows minus two folded leaves one, and
    // that one is what the caller is told about.
    //
    // The NUMBER is the assertion. A build that merely carries the field
    // reports 0, which is indistinguishable from "the restore finished" — and
    // being indistinguishable from success is the entire defect.
    expect(result.unfoldedRows).toBe(1);
    // The report is true of the data: exactly two of the three are findable.
    const found =
      (await foundBy("sule")).length +
      (await foundBy("ozturk")).length +
      (await foundBy("strasse")).length;
    expect(found).toBe(2);
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

  test("the reapply endpoint upgrades a whole workspace at once", async () => {
    // The gap this closes: `applyCollection` runs on create, patch, restore,
    // provisioning and migrate — and nothing re-applies at boot. So a workspace
    // that upgrades keeps its old physical tables, and the feature stays asleep
    // on every collection anybody already had, until somebody happens to edit a
    // schema. One call brings the whole workspace forward.
    const made = await post("/api/collections", {
      slug: "bulk1",
      fields: [{ name: "name", type: "text" }],
    });
    expect(made.status).toBe(201);
    const meta = (await made.json()) as {
      data: { physicalTable: string; tenantId?: string; tenant_id?: string };
    };
    const r = await post("/api/items/bulk1", { name: "Öztürk Şahin" });
    expect([200, 201]).toContain(r.status);

    // Make it look like a collection from before the release: no companion, and
    // therefore no folded value either.
    await runSql(`ALTER TABLE "${meta.data.physicalTable}" DROP COLUMN "name__fold"`);
    invalidateTenantCollections((meta.data.tenantId ?? meta.data.tenant_id) as string);

    const find = async () => {
      const f = encodeURIComponent(JSON.stringify({ name: { _icontains: "ozturk" } }));
      const res = await h.fetch(`/api/items/bulk1?filter=${f}&limit=10`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { name: string }[] }).data.map((x) => x.name);
    };

    // Before: the fallback cannot reach an accented name from the plain one.
    expect(await find()).toEqual([]);

    const applied = await post("/api/admin/db/schema/reapply", {});
    expect(applied.status).toBe(200);
    const body = (await applied.json()) as {
      data: { applied: number; skipped: number; failed: { slug: string }[] };
    };
    expect(body.data.failed).toEqual([]);
    expect(body.data.applied).toBeGreaterThan(0);

    // After: the column is there, the existing row was backfilled, and the
    // cache was dropped so the compiler can see it — all three, or this is
    // still nothing.
    expect(await find()).toEqual(["Öztürk Şahin"]);
  });
});
