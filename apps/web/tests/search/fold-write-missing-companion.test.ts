/**
 * A table that predates the folded companion must still accept WRITES.
 *
 * `fold-backfill.test.ts` proves the READ path degrades correctly when the
 * `<name>__fold` column is absent: `foldablePredicate` introspects the table
 * and falls back instead of naming a column nobody declared. This file is the
 * other half, and it is the half that was missing — the writer inferred the
 * companion from the field TYPE and named it unconditionally, so every INSERT
 * and UPDATE against such a table died with
 *
 *   table c_… has no column named name__fold
 *
 * i.e. the collection read fine (degraded) and 500'd on every write, until
 * somebody happened to re-apply its schema. See #324.
 *
 * There are TWO write paths and they have separate loaders: the items service
 * (`items/collection-loader.ts`, which introspects) and the slim admin-trust
 * one in `items-helpers.ts` behind flows / booking / payments / signatures /
 * approvals (which did not). Both are driven here, through the product rather
 * than by calling the helper, because "a function can be called" is not the
 * property at issue.
 *
 * The assertions are behavioural on purpose. Asserting that the writer
 * "consults foldColumns" would pass on a writer that consults it and ignores
 * the answer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { invalidateTenantCollections } from "../../src/server/services/collections/cache";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

const json = { "Content-Type": "application/json" };

describe("writing to a collection whose table predates folded search", () => {
  let h: TestHarness;
  let tenantId = "";
  let table = "";
  const slug = "prefold";
  const trigger = "prefoldsrc";

  const post = (path: string, body: unknown) =>
    h.fetch(path, { method: "POST", headers: json, body: JSON.stringify(body) });

  const runSql = async (statement: string, writes = false) => {
    const res = await h.fetch(`/api/admin/db/sql/run${writes ? "?writes=1" : ""}`, {
      method: "POST",
      headers: writes ? { ...json, "x-backlex-confirm": "yes" } : json,
      body: JSON.stringify({ sql: statement }),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { data: { rows: Record<string, unknown>[] }[] };
    return body.data[0]?.rows ?? [];
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const made = await post("/api/collections", {
      slug,
      fields: [
        { name: "name", type: "text" },
        { name: "meta", type: "json" },
      ],
    });
    expect(made.status).toBe(201);
    const body = (await made.json()) as {
      data: { physicalTable: string; tenantId?: string; tenant_id?: string };
    };
    table = body.data.physicalTable;
    tenantId = (body.data.tenantId ?? body.data.tenant_id) as string;

    // A separate, ordinary collection to fire the flow from. It keeps its
    // companions — the point is the flow's TARGET being pre-fold, not its
    // trigger.
    const src = await post("/api/collections", {
      slug: trigger,
      fields: [{ name: "title", type: "text" }],
    });
    expect(src.status).toBe(201);

    // Make the physical table look like one created before folded search: the
    // companions are gone, and so is the cache entry that was filled while they
    // still existed. A real upgrade never has that entry — the columns were
    // never there to cache — so dropping it is what reproduces the real state
    // rather than a state only this test can reach.
    await runSql(`ALTER TABLE "${table}" DROP COLUMN "name__fold"`, true);
    await runSql(`ALTER TABLE "${table}" DROP COLUMN "meta__fold"`, true);
    invalidateTenantCollections(tenantId);
  });
  afterAll(() => h.cleanup());

  test("the companions really are gone (the fixture is the fixture)", async () => {
    // Without this the whole file could pass against a table that still has its
    // companions, i.e. by testing nothing. Ask the table, not the code.
    const names = (await runSql(`PRAGMA table_info("${table}")`)).map((r) => r.name);
    expect(names).toContain("name");
    expect(names).toContain("meta");
    expect(names).not.toContain("name__fold");
    expect(names).not.toContain("meta__fold");
  });

  test("REST create succeeds and the row reads back", async () => {
    const res = await post(`/api/items/${slug}`, {
      name: "Şule Çağlar",
      meta: { note: "kayıt" },
    });
    expect([200, 201]).toContain(res.status);
    const created = (await res.json()) as { data: { id: string; name: string } };
    expect(created.data.name).toBe("Şule Çağlar");

    const read = await h.fetch(`/api/items/${slug}/${created.data.id}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { data: { name: string } }).data.name).toBe("Şule Çağlar");
  });

  test("REST update succeeds", async () => {
    const made = await post(`/api/items/${slug}`, { name: "Ali Veli" });
    expect([200, 201]).toContain(made.status);
    const id = ((await made.json()) as { data: { id: string } }).data.id;

    const patched = await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ name: "Ali Sönmez", meta: { note: "güncel" } }),
    });
    expect(patched.status).toBe(200);

    const read = await h.fetch(`/api/items/${slug}/${id}`);
    expect(((await read.json()) as { data: { name: string } }).data.name).toBe("Ali Sönmez");
  });

  test("the admin-trust write path (items-helpers, via a flow) succeeds too", async () => {
    const flow = await post("/api/flows", {
      name: "prefold_writer",
      trigger: `items:${trigger}:created`,
      operations: [{ type: "item.create", collection: slug, data: { name: "Zeynep Öz" } }],
    });
    expect(flow.status).toBe(201);

    const fired = await post(`/api/items/${trigger}`, { title: "fire" });
    expect(fired.status).toBe(201);

    // Read the TARGET. A flow whose op threw leaves no row, and so does a flow
    // that never fired — which is why the fix has to be break-verified in both
    // directions rather than trusted because this went green.
    const res = await h.fetch(`/api/items/${slug}?limit=50`);
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { data: { name: string }[] }).data;
    expect(rows.map((r) => r.name)).toContain("Zeynep Öz");
  });

  test("_icontains still degrades rather than erroring", async () => {
    // The read-side guarantee `fold-backfill.test.ts` establishes must survive
    // the write-side fix: a missing companion falls back, it does not raise and
    // it does not match everything.
    const find = async (needle: string) => {
      const f = encodeURIComponent(JSON.stringify({ name: { _icontains: needle } }));
      const res = await h.fetch(`/api/items/${slug}?filter=${f}&limit=10`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { name: string }[] }).data.map((r) => r.name);
    };
    // The fallback is the OLD behaviour: ASCII case folds, a non-ASCII letter
    // has to be typed as stored — `ö` matches `ö`, and NOT `Ö`. Narrower than
    // the companion, and NOT empty, which is what distinguishes a degraded
    // filter from a broken one.
    expect(await find("SöNMEZ")).toEqual(["Ali Sönmez"]);
    // And the thing only a companion can do stays unavailable, rather than
    // erroring or quietly matching everything. This is the assertion that
    // proves the write fix did not smuggle the companion back in: if it had,
    // this would return the row.
    expect(await find("sonmez")).toEqual([]);
  });
});
