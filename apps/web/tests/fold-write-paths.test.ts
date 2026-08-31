/**
 * Every write path fills the folded companion — proven by SEARCHING, not by
 * looking at the column.
 *
 * This is the guard the whole feature needs, and the reason is the shape of its
 * failure. A path that writes the source column and forgets `<name>__fold`
 * raises nothing: the row is created, the API answers 201, the value reads back
 * correctly, and the row is simply **invisible** to `_icontains` for ever.
 * There is no error to notice and no column anybody looks at.
 *
 * This codebase has already been bitten by exactly that: a sidecar value three
 * of four writers maintained, found only when a feature that read it went
 * quiet. So the assertion here is deliberately behavioural — write a Turkish
 * name through each path, then look for it with the ASCII spelling. A path that
 * forgot the fold is the one whose row does not come back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("the folded companion, on every write path", () => {
  let h: TestHarness;

  /** Rows whose `name` contains the needle, found the ASCII way. */
  const foundBy = async (needle: string, slug = "people"): Promise<string[]> => {
    const filter = encodeURIComponent(JSON.stringify({ name: { _icontains: needle } }));
    const res = await h.fetch(`/api/items/${slug}?filter=${filter}&limit=50`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string }[] };
    return body.data.map((r) => r.name).sort();
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const made = await h.fetch(
      "/api/collections",
      json({ slug: "people", fields: [{ name: "name", type: "text" }] }),
    );
    expect(made.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("REST create", async () => {
    const res = await h.fetch("/api/items/people", json({ name: "Şule Çağlar" }));
    expect([200, 201]).toContain(res.status);
    expect(await foundBy("sule caglar")).toEqual(["Şule Çağlar"]);
  });

  test("REST update — a renamed row is found by its NEW name, not its old one", async () => {
    // The half a create-only fix misses: if the update path writes `name` and
    // leaves the companion holding the previous fold, the row stays findable
    // under a name it no longer has and invisible under the one it does.
    const made = await h.fetch("/api/items/people", json({ name: "Eski Ad" }));
    const { data } = (await made.json()) as { data: { id: string } };
    const patched = await h.fetch(`/api/items/people/${data.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Yıldız Öztürk" }),
    });
    expect(patched.status).toBe(200);
    expect(await foundBy("yildiz ozturk")).toEqual(["Yıldız Öztürk"]);
    expect(await foundBy("eski ad")).toEqual([]);
  });

  test("batch create", async () => {
    const res = await h.fetch(
      "/api/items/people/batch",
      json({
        operations: [
          { op: "create", data: { name: "Işıl Şahin" } },
          { op: "create", data: { name: "Gökhan Ünlü" } },
        ],
      }),
    );
    expect([200, 201, 207]).toContain(res.status);
    expect(await foundBy("isil sahin")).toEqual(["Işıl Şahin"]);
    expect(await foundBy("gokhan unlu")).toEqual(["Gökhan Ünlü"]);
  });

  test("GraphQL mutation", async () => {
    const res = await h.fetch(
      "/api/graphql",
      // Inlined rather than passed as a variable: the input type is generated
      // per collection (`PeopleInput!`), so naming it here would couple this
      // test to the generator's spelling.
      json({ query: `mutation { createPeople(data: { name: "Çiğdem Kılıç" }) { id } }` }),
    );
    const body = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
    // A write path nobody checks is the exact hole this file exists to close —
    // so a GraphQL error fails the test rather than being skipped past.
    expect(body.errors ?? []).toEqual([]);
    expect(await foundBy("cigdem kilic")).toEqual(["Çiğdem Kılıç"]);
  });

  test("template seeding — the sample rows a workspace opens on", async () => {
    // A template's own sample data is the first thing anybody filters, and it
    // is written by a path of its own that never touches the items router.
    //
    // The assertion works on ASCII sample data too, and that is deliberate: an
    // unwritten companion is NULL, and `NULL LIKE '%x%'` is NULL — so a seeded
    // row that comes back from ANY `_icontains` is a row whose fold was
    // written. Shouting the title exercises the fold rather than the column.
    const applied = await h.fetch(
      "/api/admin/templates/apply",
      json({ templateId: "blog" }),
    );
    expect(applied.status).toBe(201);

    const all = await h.fetch("/api/items/posts?limit=5");
    const seeded = ((await all.json()) as { data: { title: string }[] }).data;
    expect(seeded.length).toBeGreaterThan(0);
    const title = seeded[0]!.title;

    const f = encodeURIComponent(JSON.stringify({ title: { _icontains: title.toUpperCase() } }));
    const hit = await h.fetch(`/api/items/posts?filter=${f}&limit=20`);
    const found = ((await hit.json()) as { data: { title: string }[] }).data;
    expect(found.map((r) => r.title)).toContain(title);
  });

  test("the guard can actually fail — an unfolded needle finds nothing", async () => {
    // Proof this file is not vacuous. `zzz` matches no row, so every assertion
    // above is discriminating rather than matching everything.
    expect(await foundBy("zzzzz")).toEqual([]);
  });
});
