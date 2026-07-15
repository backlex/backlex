/**
 * Presentational field blocks (divider / notice) + form-layout metadata.
 *
 * Divider and notice are layout-only field types: they render in the item form
 * but own NO physical column and carry NO value. The contract verified here:
 *  - a collection can mix them with real fields and still create/CRUD normally;
 *  - `loadCollection` strips them, so item reads never surface their names and
 *    item writes never choke on them (no phantom column);
 *  - the schema GET still returns them (the editor + item-form need them);
 *  - `validateFields` rejects storage flags on them (they own no column);
 *  - the pure-UI layout metadata (`group`, `width`, section-collapse flags)
 *    round-trips through create → GET unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("presentational fields + layout metadata", () => {
  let h: TestHarness;
  const ts = Date.now();
  const slug = `pres_${ts}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        fields: [
          { name: "first_name", type: "text", group: "Profile", width: "half" },
          { name: "last_name", type: "text", group: "Profile", width: "half" },
          { name: "sep_1", type: "divider", label: "Contact", interface: "divider" },
          { name: "note_1", type: "notice", description: "Public info", interface: "notice" },
          { name: "email", type: "text", group: "Contact", sectionCollapsible: true, sectionCollapsed: true, sectionsAsTabs: true },
        ],
      }),
    });
    expect(r.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("schema GET keeps the presentational blocks + layout metadata", async () => {
    const res = await h.fetch(`/api/collections/${slug}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { fields: any[] } };
    const byName = Object.fromEntries(data.fields.map((f) => [f.name, f]));

    // Presentational blocks survive in the stored schema (the editor needs them).
    expect(byName.sep_1?.type).toBe("divider");
    expect(byName.note_1?.type).toBe("notice");
    expect(byName.note_1?.description).toBe("Public info");

    // Layout metadata round-trips untouched.
    expect(byName.first_name?.width).toBe("half");
    expect(byName.first_name?.group).toBe("Profile");
    expect(byName.email?.sectionCollapsible).toBe(true);
    expect(byName.email?.sectionCollapsed).toBe(true);
    expect(byName.email?.sectionsAsTabs).toBe(true);
  });

  test("item CRUD works with presentational blocks in the schema (no phantom column, no leak)", async () => {
    const create = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { data: Record<string, unknown> };
    const row = created.data;

    // Real fields persisted…
    expect(row.first_name).toBe("Ada");
    expect(row.email).toBe("ada@example.com");
    // …presentational names never appear on the row (no column exists for them).
    expect("sep_1" in row).toBe(false);
    expect("note_1" in row).toBe(false);

    // Read-back agrees.
    const get = await h.fetch(`/api/items/${slug}/${row.id}`);
    expect(get.status).toBe(200);
    const fetched = (await get.json()) as { data: Record<string, unknown> };
    expect(fetched.data.last_name).toBe("Lovelace");
    expect("sep_1" in fetched.data).toBe(false);
  });

  test("writing a presentational field's name is rejected (unknown column, fail-closed)", async () => {
    const res = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ first_name: "Grace", sep_1: "nope" }),
    });
    // `loadCollection` strips presentational fields, so `sep_1` is an unknown
    // column to the write path — rejected, never written.
    expect(res.status).toBe(422);
  });

  test("storage flags on a presentational field → 422", async () => {
    for (const bad of [
      { name: "d", type: "divider", required: true },
      { name: "d", type: "divider", unique: true },
      { name: "d", type: "notice", indexed: true },
      { name: "d", type: "notice", to: "authors" },
    ]) {
      const res = await h.fetch("/api/collections", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ slug: `pres_bad_${ts}_${bad.type}_${Object.keys(bad)[2]}`, fields: [bad] }),
      });
      expect(res.status).toBe(422);
    }
  });
});
