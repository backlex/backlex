/**
 * Turning `localized: true` on a POPULATED field keeps its text.
 *
 * It did not. Measured before this file existed, on a row reading
 * `name: "Classic Tee"`:
 *
 *   PATCH the collection to localize `name`  → 200, no warning
 *   GET the row                              → name: {}
 *   GET the row ?locale=en                   → name: null
 *   search "Classic"                         → 1 hit
 *
 * Three failures in one move, and not one of them raised anything. The text was
 * still in the base column — `applyCollection` is additive, so it adds the
 * sidecar column and leaves the old one ORPHANED — while every read had moved
 * to the sidecar. And the search index still held the original string, so the
 * row came back for a query and rendered blank: a ghost.
 *
 * That is the shape of a schema toggle that eats data. It matters more now that
 * the commerce template ships fourteen localized columns, because the next
 * person to reach for the flag will be doing it to their own populated field.
 *
 * Two fixes, and both are needed: the values move into the sidecar under the
 * workspace default locale, and `ftsIndexSignature` counts the localized flag
 * so the index is rebuilt from where the text now lives. The base column is
 * deliberately left in place — losing a column is what `dropField` is for, and
 * leaving it keeps the toggle reversible.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("localizing a field that already has values", () => {
  let h: TestHarness;
  const slug = `lx_${Date.now()}`;
  let id = "";

  const json = (path: string, body: unknown, method = "POST") =>
    h.fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const one = async (qs: string) => {
    const res = await h.fetch(`/api/items/${slug}/${id}${qs}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, unknown> }).data;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await json("/api/admin/settings", { i18nLocales: ["en", "tr"], i18nDefaultLocale: "en" }, "PATCH");
    const created = await json("/api/collections", {
      slug,
      fts: true,
      fields: [
        { name: "name", type: "text", searchable: true },
        { name: "plain", type: "text", searchable: true },
      ],
    });
    expect(created.status).toBe(201);
    const row = await json(`/api/items/${slug}`, { name: "Wobbleflange", plain: "Controlword" });
    expect(row.status).toBe(201);
    id = ((await row.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("the text survives, filed under the workspace default locale", async () => {
    const patched = await json(
      `/api/collections/${slug}`,
      {
        fields: [
          { name: "name", type: "text", searchable: true, localized: true },
          { name: "plain", type: "text", searchable: true },
        ],
      },
      "PATCH",
    );
    expect(patched.status).toBe(200);
    // Reported, not silent: the caller is told which columns were moved.
    expect((await patched.json()) as Record<string, unknown>).toMatchObject({
      localizedBackfill: ["name"],
    });

    expect((await one("?locale=en")).name).toBe("Wobbleflange");
    expect((await one("?locale=*")).name).toEqual({ en: "Wobbleflange" });
  });

  test("and the search index is rebuilt from where the text now lives", async () => {
    // The ghost: before this, the index still held the base column's string, so
    // the row matched a query while rendering empty. It has to match because
    // the SIDECAR says so now, which is why the row is edited first.
    const hits = async (q: string): Promise<number> => {
      const res = await json(`/api/items/${slug}/search`, { q });
      expect(res.status).toBe(200);
      return ((await res.json()) as { data?: unknown[] }).data?.length ?? 0;
    };
    expect(await hits("Wobbleflange")).toBe(1);
    expect(await hits("Controlword")).toBe(1);

    // Replace the text through the sidecar and the index follows.
    const p = await json(`/api/items/${slug}/${id}?locale=en`, { name: "Zibbleflange" }, "PATCH");
    expect(p.status).toBe(200);
    expect(await hits("Zibbleflange")).toBe(1);
    expect(await hits("Wobbleflange")).toBe(0);
  });

  test("a field added localized in the same patch is not backfilled", async () => {
    // There is nothing to move, and a base column that never existed must not
    // be read. Guards the `beforeNames` half of the condition.
    const patched = await json(
      `/api/collections/${slug}`,
      {
        fields: [
          { name: "name", type: "text", searchable: true, localized: true },
          { name: "plain", type: "text", searchable: true },
          { name: "subtitle", type: "text", localized: true },
        ],
      },
      "PATCH",
    );
    expect(patched.status).toBe(200);
    expect((await patched.json()) as Record<string, unknown>).not.toHaveProperty("localizedBackfill");
  });
  test("un-localizing rebuilds the index from the base column, not the sidecar", async () => {
    // Where the signature actually earns its keep. Right after a localize the
    // two sources hold the SAME string, so a stale index is indistinguishable
    // from a correct one — this is the case where they differ.
    //
    // The base column still holds the original "Wobbleflange" (orphaned, never
    // dropped), while the sidecar now holds "Zibbleflange" from the edit above.
    // Turning the flag back off moves reads back to the base column, so an
    // index that was not rebuilt would answer "Zibbleflange" for a row that
    // renders "Wobbleflange".
    const patched = await json(
      `/api/collections/${slug}`,
      {
        fields: [
          { name: "name", type: "text", searchable: true },
          { name: "plain", type: "text", searchable: true },
          // Carried through: the previous test added it, and a PATCH states the
          // whole field list.
          { name: "subtitle", type: "text", localized: true },
        ],
      },
      "PATCH",
    );
    expect(patched.status).toBe(200);

    expect((await one("")).name).toBe("Wobbleflange");
    const hits = async (q: string): Promise<number> => {
      const res = await json(`/api/items/${slug}/search`, { q });
      expect(res.status).toBe(200);
      return ((await res.json()) as { data?: unknown[] }).data?.length ?? 0;
    };
    expect(await hits("Wobbleflange")).toBe(1);
    expect(await hits("Zibbleflange")).toBe(0);
  });

});
