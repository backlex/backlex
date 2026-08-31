/**
 * The commerce model's storefront text is per-language, and the three features
 * that had to be taught about that first.
 *
 * `localized: true` was a complete engine feature — sidecar storage, `?locale=`
 * reads with default fallback, a per-locale editor with a compare mode — and
 * NO template used it, across all 26 verticals. Switching the ecommerce model's
 * shopper-facing text over turned out not to be a flag flip, because three
 * collaborators read a localized field off the base row, where it does not
 * live:
 *
 *  1. the search index (fixed separately — `localized-search-indexing`);
 *  2. the TEMPLATE SEEDER, which builds its INSERT from the sample's keys and
 *     so named a column the base table does not have;
 *  3. SLUG DERIVATION, which folds from sibling columns that `splitLocalized`
 *     has already removed — so `products.slug` came out NULL, with a 201 and no
 *     warning, for every product in a seeded workspace.
 *
 * (3) is the one worth restating: `slug` is `unique`, and a localized column
 * cannot be unique, so a row has ONE handle whatever language it is read in.
 * The fold now takes the workspace's default locale.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("ecommerce — localized storefront text", () => {
  let h: TestHarness;

  const json = (path: string, body: unknown, method = "POST") =>
    h.fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = async (path: string) => {
    const res = await h.fetch(`/api/items/${path}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, unknown>[] }).data;
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
    const applied = await json("/api/admin/templates/apply", { templateId: "ecommerce" });
    expect(applied.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("a seeded category carries both languages", async () => {
    // The seeder used to be unable to carry ANY of this: a localized field's
    // sample value reached the base INSERT as a column that does not exist.
    const all = await get("categories?locale=*&limit=10");
    const apparel = all.find((c) => (c.name as Record<string, string>)?.en === "Apparel");
    expect(apparel).toBeTruthy();
    expect(apparel?.name).toEqual({ en: "Apparel", tr: "Giyim" });

    const tr = await get("categories?locale=tr&limit=10");
    expect(tr.map((c) => c.name)).toContain("Giyim");
    const en = await get("categories?locale=en&limit=10");
    expect(en.map((c) => c.name)).toContain("Apparel");
  });

  test("the slug is one handle for every language, and it is not null", async () => {
    // The defect this whole branch exists for. A slug folds from `name`, and a
    // localized `name` is absent from the payload the fold reads, so every
    // seeded row came out with no URL handle at all.
    const cats = await get("categories?locale=tr&limit=10");
    for (const c of cats) expect(typeof c.slug).toBe("string");
    const giyim = cats.find((c) => c.name === "Giyim");
    // Folded from the DEFAULT locale (en), not from the language being read.
    expect(giyim?.slug).toBe("apparel");

    // The seeded rows STATE their slug, so they prove the column survives but
    // not the fold. A row created without one, in both languages at once, is
    // what actually exercises it — and is the shape the admin sends.
    const made = await json("/api/items/categories", {
      name: { en: "Winter Coats", tr: "Kışlık Montlar" },
      position: 9,
    });
    expect([200, 201]).toContain(made.status);
    const { data } = (await made.json()) as { data: Record<string, unknown> };
    // Default locale is `en` here, so the handle is the English one — not null,
    // and not whichever key happened to come first in the object.
    expect(data.slug).toBe("winter-coats");
  });

  test("a product created in one language still gets a handle", async () => {
    const made = await json("/api/items/products?locale=tr", {
      name: "Yün Atkı",
      status: "active",
      price: 12,
      currency: "USD",
    });
    expect([200, 201]).toContain(made.status);
    const { data } = (await made.json()) as { data: Record<string, unknown> };
    // No English text exists for this row, so the fold falls back to the only
    // locale that has any — deterministically, rather than to null.
    expect(data.slug).toBe("yun-atki");
  });

  test("localized storefront text is searchable in either language", async () => {
    // `pages` is the `fts` collection whose title and body are both localized.
    // One blob per row, so the row is found whichever language was typed — and
    // the read still renders it in the locale that was asked for.
    const made = await json("/api/items/pages", {
      title: { en: "Returns policy", tr: "İade koşulları" },
      body: { en: "Ship it back within Wobbleflange days.", tr: "Zıpzıpkanat gün içinde geri gönderin." },
      visible: true,
    });
    expect([200, 201]).toContain(made.status);

    const hits = async (q: string): Promise<number> => {
      const res = await json("/api/items/pages/search", { q });
      expect(res.status).toBe(200);
      return ((await res.json()) as { data?: unknown[] }).data?.length ?? 0;
    };
    expect(await hits("Wobbleflange")).toBe(1);
    expect(await hits("Zıpzıpkanat")).toBe(1);
    expect(await hits("İade")).toBe(1);
  });

  test("a bare value is the workspace default language, and is echoed back bare", async () => {
    // The contract that makes localizing an EXISTING column adoptable. This
    // used to be a 422 telling the caller to name a locale, which meant
    // `products.create({ name })` — the first line of both examples, every doc
    // snippet and the SDK quickstart — stopped working the day a field was
    // localized. So no field already in use could ever adopt it.
    const made = await json("/api/items/products", {
      name: "Widget",
      status: "active",
      price: 9.99,
      currency: "USD",
    });
    expect([200, 201]).toContain(made.status);
    const { data } = (await made.json()) as { data: Record<string, unknown> };
    // Echoed exactly as written. Answering `{en: "Widget"}` here would move the
    // break rather than remove it — an optimistic client reconciles from this.
    expect(data.name).toBe("Widget");
    const id = data.id as string;

    // Stored under the workspace default, which is what a per-locale read sees.
    const en = await h.fetch(`/api/items/products/${id}?locale=en`);
    expect(en.status).toBe(200);
    expect(((await en.json()) as { data: Record<string, unknown> }).data.name).toBe("Widget");
    const all = await h.fetch(`/api/items/products/${id}?locale=*`);
    expect(((await all.json()) as { data: Record<string, unknown> }).data.name).toEqual({
      en: "Widget",
    });

    // And a stated locale still wins over the default.
    const tr = await json(`/api/items/products/${id}?locale=tr`, { name: "Alet" }, "PATCH");
    expect(tr.status).toBe(200);
    const both = await h.fetch(`/api/items/products/${id}?locale=*`);
    expect(((await both.json()) as { data: Record<string, unknown> }).data.name).toEqual({
      en: "Widget",
      tr: "Alet",
    });
  });

  test("the generic translations table no longer restates a localized column", async () => {
    // Two sources of truth for one string is worse than one inconvenient one.
    // The seeded rows now point at columns the schema does NOT localize, which
    // is what that table is for.
    const rows = await get("translations?limit=20");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.collection)).not.toContain("categories");
  });
});

/**
 * A catalog-wide property, because the failure it prevents is a 422 on the most
 * ordinary request there is.
 *
 * `defaultSort` names a column applied to EVERY list read, and the engine
 * refuses a sort on a localized column without `?locale=` — correctly, since it
 * cannot know which language to order by. Put together, a template that
 * localizes the column its `defaultSort` names makes a bare
 * `GET /api/items/<slug>` fail for that collection, for every caller, forever.
 *
 * That is exactly what happened here: `products.defaultSort` was `"name"` and
 * localizing `name` 422'd four unrelated specs. They caught it by accident —
 * they read products for another reason entirely. This asks the question
 * directly, for every template, so the next one does not need the accident.
 */
describe("a template's defaultSort never names a localized column", () => {
  test("across the whole catalog", async () => {
    const { TEMPLATES } = await import("../src/server/templates/catalog");
    const offenders: string[] = [];
    let checked = 0;
    for (const t of TEMPLATES) {
      for (const c of t.collections ?? []) {
        const sort = (c as { defaultSort?: string }).defaultSort;
        if (!sort) continue;
        checked += 1;
        const col = sort.replace(/^-/, "");
        const f = (c.fields as Array<{ name: string; localized?: boolean }>).find(
          (x) => x.name === col,
        );
        if (f?.localized) {
          offenders.push(
            `${t.id}/${c.slug}: defaultSort "${sort}" is localized — every bare list read 422s`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
    // A sweep that inspected nothing would report zero offenders.
    expect(checked).toBeGreaterThan(100);
  });
});
