import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

/**
 * Regression: CollectionInput's boolean `.default()`s (versioned, softDelete,
 * fts, …) used to leak through `.partial()` on PATCH — zod fills omitted
 * defaulted fields, so the route's `!== undefined` guards saw `false` and a
 * bare rename/note PATCH silently reset every flag to its create default
 * (and `tenantScoped` back to true). Pin: a partial PATCH must not touch
 * flags it does not mention.
 */
describe("collections — PATCH keeps unspecified flags", () => {
  let h: TestHarness;
  const slug = "patch_flags_probe";
  const JSON_HEADERS = { "content-type": "application/json" };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        versioned: true,
        fts: true,
        auditReads: true,
        fields: [{ name: "title", type: "text", searchable: true }],
      }),
    });
    expect(create.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("a note-only PATCH leaves versioned/fts/auditReads on", async () => {
    const patch = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ note: "just a note" }),
    });
    expect(patch.status).toBe(200);

    const res = await h.fetch(`/api/collections/${slug}`);
    expect(res.status).toBe(200);
    const row = ((await res.json()) as {
      data: { note: string | null; versioned: boolean; fts: boolean; auditReads: boolean; tenantScoped: boolean };
    }).data;
    expect(row.note).toBe("just a note");
    expect(Boolean(row.versioned)).toBe(true);
    expect(Boolean(row.fts)).toBe(true);
    expect(Boolean(row.auditReads)).toBe(true);
    expect(Boolean(row.tenantScoped)).toBe(true);
  });
});
