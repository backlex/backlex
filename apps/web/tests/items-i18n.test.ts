/**
 * `i18n_text` collection fields — localized text stored as a `{ en, tr, … }`
 * map, collapsed to one language by `?locale=xx` on read.
 *
 * Regression guards:
 *  - The collections API must ACCEPT `i18n_text` as a field type. It is a
 *    first-class `FieldType` in @backlex/db (storage + read/write handling all
 *    exist) but was missing from the create/patch zod enum, so a collection
 *    could never declare one — the feature was unreachable via API/admin.
 *  - `deserialize` must be FORGIVING when an i18n_text column holds a bare
 *    (non-JSON) legacy string — a column converted from `text` to `i18n_text`
 *    keeps its old plain values, and one bad row must not 500 the whole list.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deserialize } from "../src/server/services/items/serialize";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("i18n_text collection field", () => {
  let h: TestHarness;
  const slug = `i18n_${Date.now()}`;
  let id = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const json = (path: string, body: unknown, method = "POST") =>
      h.fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    // The create endpoint must accept the i18n_text type (the enum-sync fix).
    const created = await json("/api/collections", {
      slug,
      fields: [{ name: "title", type: "i18n_text", required: true }],
    });
    expect(created.status).toBe(201);
    // Write the localized map.
    const row = await json(`/api/items/${slug}`, {
      title: { en: "Hello", tr: "Merhaba" },
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

  test("?locale=en collapses to the English string", async () => {
    expect((await one("?locale=en")).title).toBe("Hello");
  });

  test("?locale=tr collapses to the Turkish string", async () => {
    expect((await one("?locale=tr")).title).toBe("Merhaba");
  });

  test("?locale=* returns the full per-locale map", async () => {
    expect((await one("?locale=*")).title).toEqual({ en: "Hello", tr: "Merhaba" });
  });

  test("PATCH ?locale=tr merges one locale without dropping the others", async () => {
    const res = await h.fetch(`/api/items/${slug}/${id}?locale=tr`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Selam" }),
    });
    expect(res.status).toBe(200);
    expect((await one("?locale=*")).title).toEqual({ en: "Hello", tr: "Selam" });
  });
});

describe("deserialize — forgiving i18n_text", () => {
  test("a bare legacy string returns as-is instead of throwing", () => {
    expect(deserialize("Plain legacy title", "i18n_text", "sqlite")).toBe("Plain legacy title");
  });

  test("a JSON map string parses to the object", () => {
    expect(deserialize('{"en":"Hi"}', "i18n_text", "sqlite")).toEqual({ en: "Hi" });
  });
});
