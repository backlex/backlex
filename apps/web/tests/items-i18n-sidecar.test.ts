/**
 * `localized` collection fields — per-locale values stored in the
 * `<table>__i18n` translations sidecar (the sidecar model), one native-typed
 * column per localized field. Unlike `i18n_text` (a base-table JSON map), ANY
 * field type can be localized and keeps its native storage type.
 *
 * Covers the write split (`?locale=` single vs object-of-locales), the read
 * projection (`?locale=xx` with default fallback, `?locale=*` full map) across
 * the single-get AND the list path, native typing round-trips (a localized
 * number reads back as a number), partial-locale merge on PATCH, and sidecar
 * row cleanup on delete.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("localized (sidecar) collection fields", () => {
  let h: TestHarness;
  const slug = `loc_${Date.now()}`;
  let id = "";

  const json = (path: string, body: unknown, method = "POST") =>
    h.fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // Pin workspace languages so the default-locale fallback is deterministic.
    const settings = await json(
      "/api/admin/settings",
      { i18nLocales: ["en", "tr"], i18nDefaultLocale: "en" },
      "PATCH",
    );
    expect(settings.status).toBe(200);
    // Any type can be localized: text, number, boolean here.
    const created = await json("/api/collections", {
      slug,
      fields: [
        { name: "title", type: "text", localized: true, required: true },
        { name: "price", type: "number", localized: true },
        { name: "in_stock", type: "boolean" },
      ],
    });
    expect(created.status).toBe(201);
    // Create with object-of-locales (no ?locale=): en fully set, tr partial.
    const row = await json(`/api/items/${slug}`, {
      title: { en: "Hello", tr: "Merhaba" },
      price: { en: 9.99, tr: 199 },
      in_stock: true,
    });
    expect(row.status).toBe(201);
    id = ((await row.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  const one = async (qs: string) => {
    const res = await h.fetch(`/api/items/${slug}/${id}${qs}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, unknown> }).data;
  };
  const list = async (qs: string) => {
    const res = await h.fetch(`/api/items/${slug}${qs}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
  };

  test("?locale=en collapses each localized field to its English value", async () => {
    const r = await one("?locale=en");
    expect(r.title).toBe("Hello");
    expect(r.price).toBe(9.99);
    expect(r.in_stock).toBe(true); // non-localized field unaffected
  });

  test("localized number keeps its native type (not stringified)", async () => {
    const r = await one("?locale=tr");
    expect(r.title).toBe("Merhaba");
    expect(r.price).toBe(199);
    expect(typeof r.price).toBe("number");
  });

  test("?locale=* returns the full per-locale map per field", async () => {
    const r = await one("?locale=*");
    expect(r.title).toEqual({ en: "Hello", tr: "Merhaba" });
    expect(r.price).toEqual({ en: 9.99, tr: 199 });
  });

  test("list path localizes the same way as single-get", async () => {
    const rows = await list("?locale=tr");
    const mine = rows.find((x) => x.id === id)!;
    expect(mine.title).toBe("Merhaba");
    expect(mine.price).toBe(199);
    const rowsStar = await list("?locale=*");
    const mineStar = rowsStar.find((x) => x.id === id)!;
    expect(mineStar.title).toEqual({ en: "Hello", tr: "Merhaba" });
  });

  test("missing locale falls back to the workspace default", async () => {
    // Create a row with ONLY an English title; reading tr should fall back to en.
    const created = await json(`/api/items/${slug}?locale=en`, { title: "OnlyEnglish" });
    expect(created.status).toBe(201);
    const fid = ((await created.json()) as { data: { id: string } }).data.id;
    const res = await h.fetch(`/api/items/${slug}/${fid}?locale=tr`);
    const r = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(r.title).toBe("OnlyEnglish");
  });

  test("PATCH ?locale=tr sets one locale without dropping the others", async () => {
    const res = await h.fetch(`/api/items/${slug}/${id}?locale=tr`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Selam", price: 250 }),
    });
    expect(res.status).toBe(200);
    const r = await one("?locale=*");
    expect(r.title).toEqual({ en: "Hello", tr: "Selam" });
    expect(r.price).toEqual({ en: 9.99, tr: 250 });
  });

  test("PATCH with an object-of-locales upserts multiple locales at once", async () => {
    const res = await json(
      `/api/items/${slug}/${id}`,
      { title: { en: "Hi", de: "Hallo" } },
      "PATCH",
    );
    expect(res.status).toBe(200);
    const r = await one("?locale=*");
    expect(r.title).toEqual({ en: "Hi", tr: "Selam", de: "Hallo" });
  });

  test("filter by a localized value (single locale) matches on that locale", async () => {
    // The row's tr title is "Selam" after the earlier PATCH. Filter tr = Selam.
    const filter = encodeURIComponent(JSON.stringify({ title: { _eq: "Selam" } }));
    const rows = await list(`?locale=tr&filter=${filter}`);
    expect(rows.some((x) => x.id === id)).toBe(true);
    // The SAME filter under ?locale=en must NOT match (en title is "Hi").
    const rowsEn = await list(`?locale=en&filter=${filter}`);
    expect(rowsEn.some((x) => x.id === id)).toBe(false);
  });

  test("sort by a localized value works with ?locale", async () => {
    const res = await h.fetch(`/api/items/${slug}?locale=tr&sort=title`);
    expect(res.status).toBe(200);
  });

  test("filtering a localized field without ?locale is a 422", async () => {
    const filter = encodeURIComponent(JSON.stringify({ title: { _eq: "x" } }));
    const res = await h.fetch(`/api/items/${slug}?filter=${filter}`);
    expect(res.status).toBe(422);
  });

  test("DELETE removes the row and its sidecar translations", async () => {
    const created = await json(`/api/items/${slug}`, {
      title: { en: "Doomed" },
    });
    const did = ((await created.json()) as { data: { id: string } }).data.id;
    const del = await h.fetch(`/api/items/${slug}/${did}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const gone = await h.fetch(`/api/items/${slug}/${did}?locale=*`);
    expect(gone.status).toBe(404);
  });
});

/**
 * A collection with NO localized field has no sidecar table: `applyCollection`
 * creates `<table>__i18n` only when `sidecarFields(fields)` is non-empty. The
 * read path has to agree with that, and one half of it did not — the SELECT
 * builder took the localized defs and returned nothing for an empty list,
 * while the JOIN builder asked only "was a single locale requested?" and
 * emitted a LEFT JOIN onto the table that was never created.
 *
 * `?locale=` is a general query parameter, not one a caller is expected to
 * withhold from a collection that happens to have no translations — the blog
 * example sends it on every list — so the whole collection answered 500.
 */
describe("?locale on a collection with nothing localized", () => {
  let h: TestHarness;
  const slug = `nolocale_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        name: "No localized fields",
        fields: [{ name: "title", type: "text" }],
      }),
    });
    expect(created.status).toBe(201);
    const row = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Plain" }),
    });
    expect(row.status).toBe(201);
  });

  afterAll(() => h.cleanup?.());

  test("listing with ?locale=en does not join a sidecar that was never created", async () => {
    const res = await h.fetch(`/api/items/${slug}?locale=en`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string }[] };
    expect(body.data.map((r) => r.title)).toEqual(["Plain"]);
  });

  test("a single get with ?locale=en behaves the same", async () => {
    const list = await h.fetch(`/api/items/${slug}`);
    const [first] = ((await list.json()) as { data: { id: string }[] }).data;
    const res = await h.fetch(`/api/items/${slug}/${first!.id}?locale=en`);
    expect(res.status).toBe(200);
  });

  test("?locale=* is unaffected — it never joined in the first place", async () => {
    const res = await h.fetch(`/api/items/${slug}?locale=*`);
    expect(res.status).toBe(200);
  });
});
