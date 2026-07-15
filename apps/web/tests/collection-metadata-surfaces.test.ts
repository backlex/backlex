import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Multi-surface parity for collection-level presentation metadata
 * (icon / color / hidden / previewUrl), the active⇄inactive lifecycle status,
 * and schema clone.
 *
 * Pins:
 *  - REST create/PATCH round-trips the new metadata columns.
 *  - `status: "inactive"` blocks item traffic (404) while the collection
 *    stays visible in the admin list + GET /:slug; flipping back restores it.
 *  - `POST /:slug/clone` copies schema + metadata but never data; conflicts
 *    and missing sources map to CONFLICT / NOT_FOUND.
 *  - GraphQL `cloneCollection` and SDK `schema.cloneCollection` hit the same
 *    service (one implementation, several transports).
 *  - Template extract keeps the new metadata (extract↔apply fidelity).
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const patch = (body: unknown): RequestInit => ({ ...json(body), method: "PATCH" });

describe("collection metadata — REST", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("create echoes icon/color/hidden/previewUrl and list returns them", async () => {
    const res = await h.fetch(
      "/api/collections",
      json({
        slug: "articles",
        icon: "FileText",
        color: "teal",
        hidden: true,
        previewUrl: "https://example.com/blog/{{slug}}?preview=1",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "slug", type: "text" },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const created = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(created.icon).toBe("FileText");
    expect(created.color).toBe("teal");
    expect(created.hidden).toBe(true);
    expect(created.previewUrl).toBe("https://example.com/blog/{{slug}}?preview=1");

    const list = (await (await h.fetch("/api/collections")).json()) as {
      data: Record<string, unknown>[];
    };
    const row = list.data.find((c) => c.slug === "articles")!;
    expect(row.icon).toBe("FileText");
    expect(Boolean(row.hidden)).toBe(true);
  });

  test("PATCH updates presentation metadata without touching flags", async () => {
    const res = await h.fetch(
      "/api/collections/articles",
      patch({ icon: "Star", color: "#a1b2c3", hidden: false, previewUrl: null }),
    );
    expect(res.status).toBe(200);
    const got = (await (await h.fetch("/api/collections/articles")).json()) as {
      data: Record<string, unknown>;
    };
    expect(got.data.icon).toBe("Star");
    expect(got.data.color).toBe("#a1b2c3");
    expect(Boolean(got.data.hidden)).toBe(false);
    expect(got.data.previewUrl ?? null).toBeNull();
  });

  test("previewUrl must be absolute http(s); color must be token or hex", async () => {
    const badUrl = await h.fetch(
      "/api/collections/articles",
      patch({ previewUrl: "javascript:alert(1)" }),
    );
    expect(badUrl.status).toBe(422);
    const badColor = await h.fetch("/api/collections/articles", patch({ color: "not a color!" }));
    expect(badColor.status).toBe(422);
  });

  test("inactive blocks item traffic but keeps the collection manageable", async () => {
    // Active: items work.
    const created = await h.fetch("/api/items/articles", json({ title: "Hello" }));
    expect(created.status).toBe(201);

    // Flip inactive via PATCH.
    const flip = await h.fetch("/api/collections/articles", patch({ status: "inactive" }));
    expect(flip.status).toBe(200);

    // Item traffic 404s…
    const blocked = await h.fetch("/api/items/articles");
    expect(blocked.status).toBe(404);

    // …but the collection stays in the default list AND GET /:slug works.
    const list = (await (await h.fetch("/api/collections")).json()) as {
      data: { slug: string; status?: string }[];
    };
    const row = list.data.find((c) => c.slug === "articles");
    expect(row).toBeDefined();
    expect(row?.status).toBe("inactive");
    const got = await h.fetch("/api/collections/articles");
    expect(got.status).toBe(200);

    // Back to active → items flow again (data was never touched).
    await h.fetch("/api/collections/articles", patch({ status: "active" }));
    const back = (await (await h.fetch("/api/items/articles")).json()) as {
      data: unknown[];
    };
    expect(back.data.length).toBe(1);
  });

  test("PATCH cannot resurrect an archived collection via status", async () => {
    // status only accepts active|inactive; "archived" is rejected by zod.
    const res = await h.fetch("/api/collections/articles", patch({ status: "archived" }));
    expect(res.status).toBe(422);
  });

  test("clone copies schema + metadata, never data", async () => {
    await h.fetch(
      "/api/collections/articles",
      patch({ displayTemplate: "{{title}}", icon: "Star", color: "#a1b2c3" }),
    );
    const res = await h.fetch("/api/collections/articles/clone", json({ slug: "articles_copy" }));
    expect(res.status).toBe(201);
    const clone = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(clone.slug).toBe("articles_copy");
    expect(clone.icon).toBe("Star");
    expect(clone.color).toBe("#a1b2c3");
    expect(clone.displayTemplate).toBe("{{title}}");
    expect((clone.fields as { name: string }[]).map((f) => f.name)).toEqual([
      "title",
      "slug",
    ]);
    // Schema only — the source's rows do NOT come along.
    const items = (await (await h.fetch("/api/items/articles_copy")).json()) as {
      data: unknown[];
    };
    expect(items.data.length).toBe(0);
  });

  test("clone conflicts and missing sources map to proper errors", async () => {
    const dup = await h.fetch("/api/collections/articles/clone", json({ slug: "articles_copy" }));
    expect(dup.status).toBe(409);
    const missing = await h.fetch("/api/collections/nope/clone", json({ slug: "whatever" }));
    expect(missing.status).toBe(404);
    const badSlug = await h.fetch("/api/collections/articles/clone", json({ slug: "Bad Slug" }));
    expect(badSlug.status).toBe(422);
  });
});

describe("collection metadata — GraphQL + SDK + extract parity", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;
  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
    await h.fetch(
      "/api/collections",
      json({
        slug: "posts",
        icon: "Zap",
        color: "violet",
        previewUrl: "https://example.com/p/{{id}}",
        fields: [{ name: "title", type: "text", required: true }],
      }),
    );
  });
  afterAll(() => h.cleanup());

  test("GraphQL cloneCollection mirrors REST clone", async () => {
    const res = await gql(
      `mutation($slug:String!,$newSlug:String!){ cloneCollection(slug:$slug,newSlug:$newSlug) }`,
      { slug: "posts", newSlug: "posts_gql" },
    );
    expect(res.errors).toBeUndefined();
    const got = (await (await h.fetch("/api/collections/posts_gql")).json()) as {
      data: Record<string, unknown>;
    };
    expect(got.data.icon).toBe("Zap");
    expect(got.data.previewUrl).toBe("https://example.com/p/{{id}}");

    // Error parity: taken slug → CONFLICT, missing source → NOT_FOUND.
    const dup = await gql(
      `mutation{ cloneCollection(slug:"posts",newSlug:"posts_gql") }`,
    );
    expect(dup.errors?.[0]?.extensions?.code).toBe("CONFLICT");
    const missing = await gql(
      `mutation{ cloneCollection(slug:"nope",newSlug:"whatever_x") }`,
    );
    expect(missing.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  test("SDK schema.cloneCollection round-trips", async () => {
    const res = await client.schema.cloneCollection("posts", "posts_sdk");
    expect(res.data.slug).toBe("posts_sdk");
    expect(res.data.color).toBe("violet");
  });

  test("template extract carries the new metadata (apply fidelity)", async () => {
    const extracted = await client.templates.extract({ collections: ["posts"] });
    const posts = extracted.data.collections.find((c) => c.slug === "posts")!;
    expect(posts.icon).toBe("Zap");
    expect(posts.color).toBe("violet");
    expect(posts.previewUrl).toBe("https://example.com/p/{{id}}");
  });
});
