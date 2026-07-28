/**
 * A field type the current build doesn't recognise must degrade THAT FIELD, not
 * take down a whole endpoint.
 *
 * `collections.fields` is a JSON blob that the code asserts is `FieldDef[]` but
 * nothing re-validates on read, so a row written by an older build can carry a
 * type this one has since dropped. `i18n_text` is the real example: it was
 * removed in 6bd2f601 (July 2026) in favour of the `localized` flag, with no
 * data migration for workspaces that already had one.
 *
 * The tests below write such a row directly, the way an old build would have
 * left it, and pin the blast radius.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

describe("a collection carrying a legacy/unknown field type", () => {
  let h: TestHarness;
  const legacy = "legacyfields";
  const healthy = "healthyfields";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    // A normal collection, so we can prove an unrelated one still works.
    expect(
      (
        await h.fetch(
          "/api/collections",
          post({ slug: healthy, fields: [{ name: "title", type: "text" }] }),
        )
      ).status,
    ).toBe(201);

    // The legacy collection is created normally, then its metadata is rewritten
    // to carry a type the current build has no case for — exactly the state an
    // older build left behind.
    expect(
      (
        await h.fetch(
          "/api/collections",
          post({
            slug: legacy,
            fields: [
              { name: "title", type: "text" },
              { name: "body", type: "text", required: true },
            ],
          }),
        )
      ).status,
    ).toBe(201);

    const db = new Database(h.env.SQLITE_PATH as string);
    const row = db
      .query("SELECT id, fields FROM collections WHERE slug = ?")
      .get(legacy) as { id: string; fields: string };
    const fields = JSON.parse(row.fields) as { name: string; type: string }[];
    // `body` becomes the dropped type — and it's `required`, which is what turns
    // an unknown type into a thrown `GraphQLNonNull(undefined)` rather than a
    // merely-wrong nullable field.
    for (const f of fields) if (f.name === "body") f.type = "i18n_text";
    db.query("UPDATE collections SET fields = ? WHERE id = ?").run(
      JSON.stringify(fields),
      row.id,
    );
    db.close();
  });
  afterAll(() => h.cleanup());

  test("GraphQL still answers — one bad field can't kill the whole schema", async () => {
    const res = (await (
      await h.fetch("/api/graphql", post({ query: `query{ __typename }` }))
    ).json()) as { data?: Record<string, unknown>; error?: unknown; errors?: unknown[] };
    expect(res.error).toBeUndefined();
    expect(res.data?.__typename).toBe("Query");
  });

  test("an unrelated collection is still queryable over GraphQL", async () => {
    const res = (await (
      await h.fetch("/api/graphql", post({ query: `query{ healthyfields { id title } }` }))
    ).json()) as { data?: Record<string, unknown[]>; errors?: { message: string }[] };
    expect(res.errors).toBeUndefined();
    expect(Array.isArray(res.data?.healthyfields)).toBe(true);
  });

  test("the legacy collection itself is still readable, minus the bad field", async () => {
    const res = (await (
      await h.fetch("/api/graphql", post({ query: `query{ legacyfields { id title } }` }))
    ).json()) as { data?: Record<string, unknown[]>; errors?: { message: string }[] };
    expect(res.errors).toBeUndefined();
    expect(Array.isArray(res.data?.legacyfields)).toBe(true);
  });

  test("REST list still works on the legacy collection", async () => {
    const r = await h.fetch(`/api/items/${legacy}`);
    expect(r.status).toBe(200);
  });

  test("the admin can still load the collection to repair it", async () => {
    const r = await h.fetch("/api/collections");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: { slug: string }[] };
    expect(body.data.some((c) => c.slug === legacy)).toBe(true);
  });

  test("an operator can repair the field by writing a valid type back", async () => {
    // Degrading gracefully is only half the job — the workspace has to be
    // fixable. The collections PATCH validates the WHOLE fields array against
    // the type enum, so this also proves the bad row doesn't wedge the editor.
    const r = await h.fetch(`/api/collections/${legacy}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        fields: [
          { name: "title", type: "text" },
          { name: "body", type: "json", required: true },
        ],
      }),
    });
    expect(r.status).toBe(200);

    // …and GraphQL now types it properly rather than via the fallback.
    const gql = (await (
      await h.fetch("/api/graphql", post({ query: `query{ legacyfields { id title body } }` }))
    ).json()) as { data?: Record<string, unknown[]>; errors?: { message: string }[] };
    expect(gql.errors).toBeUndefined();
    expect(Array.isArray(gql.data?.legacyfields)).toBe(true);
  });
});

describe("the operator is told, rather than the rot degrading silently", () => {
  let h: TestHarness;
  const slug = "warnfields";

  // The shared harness above pins LOG_LEVEL to `error`, which would swallow the
  // warning this test is about. Raise it for this one workspace.
  beforeAll(async () => {
    h = makeHarness({ LOG_LEVEL: "warn" });
    await seedAdmin(h);
    expect(
      (
        await h.fetch(
          "/api/collections",
          post({ slug, fields: [{ name: "body", type: "text", required: true }] }),
        )
      ).status,
    ).toBe(201);

    const db = new Database(h.env.SQLITE_PATH as string);
    const row = db
      .query("SELECT id, fields FROM collections WHERE slug = ?")
      .get(slug) as { id: string; fields: string };
    const fields = JSON.parse(row.fields) as { name: string; type: string }[];
    for (const f of fields) if (f.name === "body") f.type = "i18n_text";
    db.query("UPDATE collections SET fields = ? WHERE id = ?").run(
      JSON.stringify(fields),
      row.id,
    );
    db.close();
  });
  afterAll(() => h.cleanup());

  test("a schema build naming an unknown type logs which field it was", async () => {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
    try {
      const r = await h.fetch("/api/graphql", post({ query: `query{ __typename }` }));
      expect(r.status).toBe(200);
    } finally {
      console.warn = original;
    }
    const hit = seen.find((l) => l.includes("unknown_field_type"));
    expect(hit).toBeTruthy();
    // Names the exact field, so the fix is obvious without spelunking.
    expect(hit).toContain(`${slug}.body`);
    expect(hit).toContain("i18n_text");
  });
});
