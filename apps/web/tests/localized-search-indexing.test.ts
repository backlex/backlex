/**
 * A `localized` field that is also `searchable` has to reach the search index.
 *
 * Before this file it did not, and the way it failed depended on which endpoint
 * wrote the row — three different wrong answers, none of them an error:
 *
 *  | write                    | what landed in the index                    |
 *  |--------------------------|---------------------------------------------|
 *  | create (`{en,tr}` map)   | nothing — `splitLocalized` had already       |
 *  |                          | deleted the field from the payload the       |
 *  |                          | indexer was handed                           |
 *  | `PATCH ?locale=tr`       | the Turkish value ALONE, rebuilding the whole|
 *  |                          | blob and dropping English out of the index   |
 *  | locale-less `PATCH`      | `"[object Object]"` — `String({en,tr})`.     |
 *  |                          | Searching "object" returned the row          |
 *
 * Every one of those is a 2xx that did nothing, or did something absurd,
 * quietly. The schema accepted `localized: true` next to `searchable: true`
 * with no complaint, the value read back correctly through `?locale=`, and only
 * search disagreed — so on the ecommerce model, localizing `products.name`
 * would have traded multi-language for product search without a single failing
 * assertion anywhere.
 *
 * The fix reads the `__i18n` sidecar at index time instead of trusting the row
 * the caller passed, which makes the index a function of what is STORED rather
 * than of which endpoint wrote last. These tests are written against that
 * property: after any write, in any shape, every locale's text finds the row.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { embedAndUpsert, type VectorizeMeta } from "../src/server/services/vectorize";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("localized fields reach the full-text index", () => {
  let h: TestHarness;
  const slug = `lsi_${Date.now()}`;
  let id = "";

  const json = (path: string, body: unknown, method = "POST") =>
    h.fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  /** How many rows a keyword search returns. */
  const hits = async (term: string): Promise<number> => {
    const res = await json(`/api/items/${slug}/search`, { q: term });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data?: unknown[] }).data?.length ?? 0;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const settings = await json(
      "/api/admin/settings",
      { i18nLocales: ["en", "tr"], i18nDefaultLocale: "en" },
      "PATCH",
    );
    expect(settings.status).toBe(200);
    const created = await json("/api/collections", {
      slug,
      fts: true,
      fields: [
        { name: "title", type: "text", localized: true, searchable: true },
        // Not localized, and the control for every assertion below: if the
        // index itself were broken this would stop matching too, and the
        // localized failures would be indistinguishable from a dead index.
        { name: "plain", type: "text", searchable: true },
      ],
    });
    expect(created.status).toBe(201);
    const row = await json(`/api/items/${slug}`, {
      title: { en: "Alphaword", tr: "Betaword" },
      plain: "Controlword",
    });
    expect(row.status).toBe(201);
    id = ((await row.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("a create with a per-locale map indexes every locale", async () => {
    expect(await hits("Controlword")).toBe(1);
    expect(await hits("Alphaword")).toBe(1);
    expect(await hits("Betaword")).toBe(1);
  });

  test("searching a locale's own word finds the row whichever locale asked", async () => {
    // One blob per row is the deliberate shape (see `sidecarText`): both
    // dialects keep a single index per row, so a match in ANY locale returns
    // it and the read path renders the row in the locale that was asked for.
    const res = await json(`/api/items/${slug}/search?locale=tr`, { q: "Alphaword" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  test("a single-locale PATCH does not evict the other locale from the index", async () => {
    // The sharpest of the three: rebuilding the blob from `?locale=tr`'s single
    // value used to delete English from the index while leaving it perfectly
    // readable through the API.
    const p = await json(`/api/items/${slug}/${id}?locale=tr`, { title: "Gammaword" }, "PATCH");
    expect(p.status).toBe(200);
    expect(await hits("Gammaword")).toBe(1);
    expect(await hits("Alphaword")).toBe(1); // English survives
    expect(await hits("Betaword")).toBe(0); // and the replaced Turkish is gone
    expect(await hits("Controlword")).toBe(1);
  });

  test("a locale-less PATCH indexes the values, not the stringified map", async () => {
    const p = await json(
      `/api/items/${slug}/${id}`,
      { title: { en: "Deltaword", tr: "Epsilonword" } },
      "PATCH",
    );
    expect(p.status).toBe(200);
    expect(await hits("Deltaword")).toBe(1);
    expect(await hits("Epsilonword")).toBe(1);
    // The old failure, named so a regression cannot hide as a passing count:
    // `String({en,tr})` is "[object Object]", and this used to return the row.
    expect(await hits("object")).toBe(0);
  });

  test("clearing a locale removes only that locale's text", async () => {
    const p = await json(`/api/items/${slug}/${id}?locale=tr`, { title: null }, "PATCH");
    expect(p.status).toBe(200);
    expect(await hits("Epsilonword")).toBe(0);
    expect(await hits("Deltaword")).toBe(1);
    expect(await hits("Controlword")).toBe(1);
  });
});

/**
 * The same defect, one service over. `vectorize.ts`'s `buildText` read
 * `row[f.name]` exactly as the FTS builder did, so a localized field was
 * embedded as nothing, as one locale, or as "[object Object]" — and a wrong
 * embedding is worse than a missing one, because the row still comes back for
 * some query and nobody can tell which text produced it.
 *
 * Driven through a stub rather than the harness because the bun-test
 * environment has no embedding provider or vector store at all
 * (`vector-search-contract` asserts that): `embed` records the texts it was
 * handed, which is the thing under test.
 */
describe("localized fields reach the embedding text", () => {
  const meta: VectorizeMeta = {
    slug: "articles",
    physicalTable: "c_t1_articles",
    vectorize: true,
    vectorizeModel: "bge-m3",
    fields: [
      { name: "body", type: "longtext", vectorize: true },
      { name: "title", type: "text", vectorize: true, localized: true },
    ] as never,
  };

  /** A ctx whose `db.all` answers the sidecar SELECT with two locales. */
  const stub = (sidecarRows: Array<Record<string, unknown>>) => {
    const embedded: string[][] = [];
    const ctx = {
      dialect: "sqlite",
      env: { EMBEDDING_DEFAULT_MODEL: "bge-m3" },
      db: { all: async () => sidecarRows },
      embedding: {
        embed: async ({ texts }: { texts: string[] }) => {
          embedded.push(texts);
          return { values: texts.map((_, i) => [i, 0, 0]) };
        },
      },
      vector: { upsert: async () => {}, delete: async () => {}, query: async () => [] },
    } as never;
    return { ctx, embedded };
  };

  test("every locale's text is embedded, and the map is never stringified", async () => {
    const { ctx, embedded } = stub([
      { locale: "en", title: "Alphaword" },
      { locale: "tr", title: "Betaword" },
    ]);
    // The row as the write path hands it over: the localized field is either
    // absent (create) or an echoed map (locale-less PATCH). Both are here.
    await embedAndUpsert(ctx, meta, "t1", "item-1", {
      body: "Controlword",
      title: { en: "Alphaword", tr: "Betaword" },
    });
    const text = embedded.flat().join("\n");
    expect(text).toContain("Controlword");
    expect(text).toContain("Alphaword");
    expect(text).toContain("Betaword");
    expect(text).not.toContain("[object Object]");
  });

  test("a row whose only vectorized text is localized still gets embedded", async () => {
    // Before the fix this produced an empty string, which `embedAndUpsert`
    // treats as "nothing to embed" — so the row was deleted from the vector
    // index rather than added to it.
    const localOnly: VectorizeMeta = {
      ...meta,
      fields: [{ name: "title", type: "text", vectorize: true, localized: true }] as never,
    };
    const { ctx, embedded } = stub([{ locale: "tr", title: "Betaword" }]);
    await embedAndUpsert(ctx, localOnly, "t1", "item-2", { title: { tr: "Betaword" } });
    expect(embedded.flat().join("\n")).toContain("Betaword");
  });
});

/**
 * And the exclusion that had to come with it: a `private` field never reaches
 * either index.
 *
 * This was already wrong before the localized work, and in a shape that hid it
 * — the two writers disagreed. The item write path scrubs private fields off
 * the payload before its side effects (`scrubPrivateFields`), so a create never
 * indexed one; `backfillFts` reads its rows with `SELECT *` and scrubs nothing,
 * so `POST /collections/:slug/fts-reindex` put them in. Whether a private value
 * was searchable therefore depended on whether anyone had ever pressed reindex.
 *
 * Search does not return the column, but it returns the ROW — so a caller can
 * guess a value and read the answer off the hit count. That is an oracle over a
 * field the API deliberately never renders, which is why the rule now lives in
 * `isFtsField` where both writers share it.
 */
describe("a private field never reaches the search index", () => {
  let h: TestHarness;
  const slug = `pfs_${Date.now()}`;

  const json = (path: string, body: unknown, method = "POST") =>
    h.fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const hits = async (term: string): Promise<number> => {
    const res = await json(`/api/items/${slug}/search`, { q: term });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data?: unknown[] }).data?.length ?? 0;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await json("/api/collections", {
      slug,
      fts: true,
      fields: [
        { name: "secret_note", type: "text", private: true, searchable: true },
        { name: "plain", type: "text", searchable: true },
      ],
    });
    expect(created.status).toBe(201);
    const row = await json(`/api/items/${slug}`, { secret_note: "Hushword", plain: "Controlword" });
    expect(row.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("not after a create, and not after a reindex either", async () => {
    expect(await hits("Controlword")).toBe(1);
    expect(await hits("Hushword")).toBe(0);

    // The half that used to differ. Without the reindex this test passes on the
    // old code too, so the assertion below is the one doing the work.
    const reindex = await json(`/api/collections/${slug}/fts-reindex`, {});
    expect(reindex.status).toBe(200);
    expect(await hits("Controlword")).toBe(1);
    expect(await hits("Hushword")).toBe(0);
  });
});
