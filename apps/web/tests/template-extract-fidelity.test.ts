import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Extract fidelity — the 2026-07 template follow-ups. Two things the original
 * extract dropped now round-trip: (1) the singleton / softDelete / auditReads
 * collection flags, plumbed template → createManagedCollection → extract;
 * (2) opt-in sample rows (`?samples=N`), with relations rewritten to
 * `{ ref: "slug:index" }` links, hash/computed/file fields skipped, and
 * soft-deleted rows excluded.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("template extract fidelity (flags + samples)", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // Apply an inline custom template exercising every new axis: flags on
    // collections, a relation sample ref, and a hash field in a sample.
    const res = await h.fetch(
      "/api/admin/templates/apply",
      json({
        template: {
          label: "fidelity",
          collections: [
            {
              slug: "exsrc_authors",
              fields: [{ name: "name", type: "text" }],
              samples: [{ name: "Jane" }, { name: "Bob" }],
            },
            {
              slug: "exsrc_posts",
              softDelete: true,
              auditReads: true,
              fields: [
                { name: "title", type: "text" },
                { name: "author", type: "relation", to: "exsrc_authors" },
                { name: "secret", type: "hash" },
              ],
              samples: [{ title: "Hello", author: { ref: "exsrc_authors:0" } }],
            },
            {
              slug: "exsrc_config",
              singleton: true,
              fields: [{ name: "motto", type: "text" }],
              samples: [{ motto: "ship it" }],
            },
          ],
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { created: string[]; seeded: number } };
    expect(body.data.created).toEqual(["exsrc_authors", "exsrc_posts", "exsrc_config"]);
    expect(body.data.seeded).toBe(4);
  });
  afterAll(() => h.cleanup());

  test("flags land on the created collections", async () => {
    const posts = (
      (await (await h.fetch("/api/collections/exsrc_posts")).json()) as { data: any }
    ).data;
    expect(Boolean(posts.softDelete)).toBe(true);
    expect(Boolean(posts.auditReads)).toBe(true);
    expect(Boolean(posts.singleton)).toBe(false);
    const config = (
      (await (await h.fetch("/api/collections/exsrc_config")).json()) as { data: any }
    ).data;
    expect(Boolean(config.singleton)).toBe(true);
  });

  test("extract emits the flags and opt-in samples with ref-rewritten relations", async () => {
    const res = await h.fetch(
      "/api/admin/templates/extract?collections=exsrc_authors,exsrc_posts,exsrc_config&samples=10",
    );
    expect(res.status).toBe(200);
    const tpl = ((await res.json()) as { data: any }).data;

    const posts = tpl.collections.find((c: any) => c.slug === "exsrc_posts");
    expect(posts.softDelete).toBe(true);
    expect(posts.auditReads).toBe(true);
    expect(posts.singleton).toBeUndefined(); // false flags stay omitted
    const config = tpl.collections.find((c: any) => c.slug === "exsrc_config");
    expect(config.singleton).toBe(true);

    const authors = tpl.collections.find((c: any) => c.slug === "exsrc_authors");
    const names = authors.samples.map((s: any) => s.name).sort();
    expect(names).toEqual(["Bob", "Jane"]);

    expect(posts.samples).toHaveLength(1);
    const sample = posts.samples[0];
    expect(sample.title).toBe("Hello");
    // The relation value came back as a ref pointing at Jane's row in THIS
    // extract's author window — not a dangling concrete id.
    const janeIdx = authors.samples.findIndex((s: any) => s.name === "Jane");
    expect(sample.author).toEqual({ ref: `exsrc_authors:${janeIdx}` });
    // Hash fields never leave the workspace via samples.
    expect("secret" in sample).toBe(false);
  });

  test("extract without samples stays schema-only; bounds validate", async () => {
    const bare = (
      (await (
        await h.fetch("/api/admin/templates/extract?collections=exsrc_authors")
      ).json()) as { data: any }
    ).data;
    expect(bare.collections[0].samples).toBeUndefined();

    const bad = await h.fetch("/api/admin/templates/extract?samples=51");
    expect(bad.status).toBe(422);
    const badZero = await h.fetch("/api/admin/templates/extract?samples=0");
    expect(badZero.status).toBe(422);
  });

  test("soft-deleted rows drop out of the sample window", async () => {
    const list = (
      (await (await h.fetch("/api/items/exsrc_posts")).json()) as {
        data: { id: string }[];
      }
    ).data;
    expect(list).toHaveLength(1);
    const del = await h.fetch(`/api/items/exsrc_posts/${list[0]!.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const res = await h.fetch(
      "/api/admin/templates/extract?collections=exsrc_posts&samples=10",
    );
    const tpl = ((await res.json()) as { data: any }).data;
    expect(tpl.collections[0].samples).toBeUndefined();
  });
});
