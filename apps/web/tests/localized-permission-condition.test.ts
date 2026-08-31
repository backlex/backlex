/**
 * A permission condition keyed on a `localized` column is actually enforced.
 *
 * It was not, and the way it failed is specific to the production dialect.
 * `defaultColRef` emits a bare `"region"`, and a localized field has no base
 * column — so the predicate read `"region" != 'confidential'` against a column
 * that does not exist. **SQLite treats a double-quoted identifier matching no
 * column as a STRING LITERAL**, so that compiles to
 * `'region' != 'confidential'`: always true. The rule evaporated and every row
 * came back.
 *
 * Measured on a restricted end-user, same token, three reads:
 *
 *   ?locale=en  → clean, mixed        (filtered — by ACCIDENT: the sidecar JOIN
 *                                      that single-locale mode adds gives the
 *                                      bare identifier something to bind to)
 *   ?locale=tr  → clean               (filtered, against the Turkish value)
 *   (no locale) → clean, dirty, mixed (NOT filtered — `dirty` is confidential
 *                                      in every language and still came back)
 *
 * So whether an access rule applied depended on whether the caller happened to
 * name a locale, and the un-named case is the one that fails open. On D1 —
 * which is SQLite — that is the shipped path.
 *
 * The rule is now judged against the WORKSPACE DEFAULT locale, everywhere and
 * predictably: the same locale reads fall back to, the slug fold takes, a
 * locale-less write files under, and a bare template sample means.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const J = (m: string, b: unknown): RequestInit => ({
  method: m,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(b),
});

describe("a permission condition on a localized column", () => {
  let h: TestHarness;
  const slug = `lpc_${Date.now()}`;
  let token = "";

  const asUser = (path: string, init: RequestInit = {}) =>
    h.app.request(path, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
    });
  const titles = async (qs: string): Promise<string[]> => {
    const res = await asUser(`/api/items/${slug}${qs}`);
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { data: { title: string }[] }).data;
    return rows.map((r) => r.title).sort();
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/admin/settings", J("PATCH", { i18nLocales: ["en", "tr"], i18nDefaultLocale: "en" }));
    const created = await h.fetch(
      "/api/collections",
      J("POST", {
        slug,
        fields: [
          { name: "title", type: "text" },
          { name: "region", type: "text", localized: true },
        ],
      }),
    );
    expect(created.status).toBe(201);

    // `clean` passes in every language, `dirty` fails in every language, and
    // `mixed` is the one that makes the rule's meaning visible: allowed in the
    // default language, forbidden in the other.
    for (const [title, region] of [
      ["clean", { en: "public", tr: "public" }],
      ["dirty", { en: "confidential", tr: "confidential" }],
      ["mixed", { en: "public", tr: "confidential" }],
    ] as const) {
      const r = await h.fetch(`/api/items/${slug}`, J("POST", { title, region }));
      expect(r.status).toBe(201);
    }

    const roles = await h.fetch("/api/roles");
    const roleId = ((await roles.json()) as { data: { id: string; name: string }[] }).data.find(
      (r) => r.name === "authenticated",
    )!.id;
    const granted = await h.fetch(
      `/api/roles/${roleId}/permissions`,
      J("POST", { collection: slug, action: "read", condition: { region: { _neq: "confidential" } } }),
    );
    expect(granted.status).toBeLessThan(300);

    const invited = await h.fetch("/api/app-users/invite", J("POST", { email: `p-${Date.now()}@cond.test` }));
    expect(invited.status).toBe(201);
    const { data } = (await invited.json()) as { data: { token: string } };
    const accepted = await h.app.request(
      "/api/t/default/auth/invite/accept",
      J("POST", { token: data.token, password: "cond-pass-12345" }),
    );
    expect(accepted.status).toBe(200);
    token = ((await accepted.json()) as { token: string }).token;
  });
  afterAll(() => h.cleanup());

  test("a read that names no locale is still filtered", async () => {
    // THE bug. This returned all three rows, `dirty` included.
    expect(await titles("")).toEqual(["clean", "mixed"]);
  });

  test("naming a locale gives the same answer, not a different one", async () => {
    // `mixed` is confidential in Turkish, and used to disappear at `?locale=tr`
    // — so the same row was visible or not depending on the query string. The
    // rule now means one thing: the default language's value.
    expect(await titles("?locale=en")).toEqual(["clean", "mixed"]);
    expect(await titles("?locale=tr")).toEqual(["clean", "mixed"]);
    expect(await titles("?locale=*")).toEqual(["clean", "mixed"]);
  });

  test("the row forbidden in every language is never returned", async () => {
    // The control that would fail if the predicate had evaporated a second way.
    for (const qs of ["", "?locale=en", "?locale=tr"]) {
      expect(await titles(qs)).not.toContain("dirty");
    }
  });

  test("reading one row by id obeys the same rule", async () => {
    const all = await h.fetch(`/api/items/${slug}?limit=10`);
    const rows = ((await all.json()) as { data: { id: string; title: string }[] }).data;
    const dirty = rows.find((r) => r.title === "dirty")!;
    const clean = rows.find((r) => r.title === "clean")!;
    expect((await asUser(`/api/items/${slug}/${clean.id}`)).status).toBe(200);
    expect((await asUser(`/api/items/${slug}/${dirty.id}`)).status).toBe(404);
  });
});
