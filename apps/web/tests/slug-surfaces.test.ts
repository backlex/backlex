/**
 * Multi-surface parity for slug fields.
 *
 * Two guarantees, each with its own way of quietly not shipping:
 *
 *   1. **Every surface that WRITES a row folds its slug.** This is the one the
 *      parity gate exists for. The REST write core does it in `performCreate`,
 *      but the GraphQL create resolver hand-builds its own INSERT and does not
 *      go through that function — the same gap that made #38's rollups, #39's
 *      sequence numbers, #40's points and #48's positions ship on REST only
 *      until a test like this caught it. GraphQL additionally keys its input by
 *      camelCase while a `slug.from` entry is snake_case, so the shared
 *      resolver has to be handed a translated view or it finds `undefined` at
 *      every source column and silently generates nothing.
 *   2. **Every surface can BACKFILL**, and they all reach the same service — so
 *      the fold, the collision search and the permission scope cannot drift.
 *
 * The CLI is checked structurally rather than by spawning a shell — it is a
 * thin argv parser over the SDK, and what rots is a subcommand disappearing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../../../packages/client/src/index";
import { slugTools } from "../src/server/mcp/tools/slug";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const gql = async (query: string, variables?: unknown) =>
  (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
    data?: Record<string, any>;
    errors?: { message: string }[];
  };

const sdk = () => createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

const mcp = (name: string, args: Record<string, unknown>) => {
  const tool = slugTools.find((x) => x.name === name)!;
  return tool.handler(args, {
    fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init),
  } as never);
};

const posts = "parslug_posts";

const slugOf = async (id: string): Promise<string | null> => {
  const r = await h.fetch(`/api/items/${posts}/${id}`);
  return ((await r.json()).data as Record<string, any>).slug ?? null;
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  await h.fetch(
    "/api/collections",
    json({
      slug: posts,
      fields: [
        { name: "title", type: "text" },
        { name: "slug", type: "text", unique: true, interface: "slug", slug: { from: ["title"] } },
      ],
    }),
  );
});

afterAll(() => h?.cleanup());

describe("slug parity — every write surface folds", () => {
  test("REST create", async () => {
    const r = await h.fetch(`/api/items/${posts}`, json({ title: "Rest Made This" }));
    expect(r.status).toBe(201);
    expect(((await r.json()).data as any).slug).toBe("rest-made-this");
  });

  test("SDK create", async () => {
    const row = (await sdk().from(posts).create({ title: "Sdk Made This" })) as any;
    expect(row.data.slug).toBe("sdk-made-this");
  });

  test("GraphQL create — the resolver that hand-builds its own INSERT", async () => {
    const r = await gql(`mutation {
      createParslugPosts(data: { title: "Graphql Made This" }) { id slug }
    }`);
    expect(r.errors).toBeUndefined();
    const made = r.data?.createParslugPosts;
    // Asserted on the MUTATION's own response as well as on a re-read: the
    // resolver has to write the value back onto its payload, or a client that
    // just created a post cannot link to it without a second round trip.
    expect(made.slug).toBe("graphql-made-this");
    expect(await slugOf(made.id)).toBe("graphql-made-this");
  });

  test("GraphQL create dedupes against rows every other surface made", async () => {
    await h.fetch(`/api/items/${posts}`, json({ title: "Shared Headline" }));
    const r = await gql(`mutation {
      createParslugPosts(data: { title: "Shared Headline" }) { slug }
    }`);
    expect(r.errors).toBeUndefined();
    expect(r.data?.createParslugPosts.slug).toBe("shared-headline-2");
  });

  test("GraphQL update re-derives on a cleared slug, and only then", async () => {
    const made = await gql(`mutation {
      createParslugPosts(data: { title: "Gql First" }) { id slug }
    }`);
    const id = made.data?.createParslugPosts.id;
    // Editing the title alone must NOT move a published URL.
    await gql(`mutation { updateParslugPosts(id: "${id}", data: { title: "Gql Second" }) { id } }`);
    expect(await slugOf(id)).toBe("gql-first");
    // Clearing it re-derives from the title the row now has.
    await gql(`mutation { updateParslugPosts(id: "${id}", data: { slug: "" }) { id } }`);
    expect(await slugOf(id)).toBe("gql-second");
  });

  test("CSV import folds too — the path with no bound on row count", async () => {
    const csv = "title\nImported One\nImported Two\nImported One\n";
    const r = await h.fetch(`/api/items/${posts}/import?format=csv`, {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: csv,
    });
    expect(r.status).toBeLessThan(300);
    const listed = (await (await h.fetch(`/api/items/${posts}?limit=200`)).json()) as any;
    const slugs = (listed.data as any[]).map((x) => x.slug);
    expect(slugs).toContain("imported-one");
    expect(slugs).toContain("imported-two");
    // The duplicate title inside ONE import still gets its own URL.
    expect(slugs).toContain("imported-one-2");
  });
});

describe("slug parity — backfill reaches the same service everywhere", () => {
  // A collection whose slug column PREDATES the spec — created as plain text,
  // filled with rows nothing folded, and only then declared a slug field. That
  // is the state every pre-existing workspace is in, and the only honest way to
  // produce an empty slug: through the API a cleared slug RE-DERIVES, which is
  // the documented behaviour and precisely what makes this seeding indirect.
  const legacy = "parslug_legacy";
  let declared = false;

  const seedEmpty = async (title: string): Promise<string> => {
    if (declared) throw new Error("seed before declaring the spec");
    const r = await h.fetch(`/api/items/${legacy}`, json({ title }));
    return ((await r.json()).data as any).id as string;
  };
  const declareSpec = async () => {
    const r = await h.fetch(
      `/api/collections/${legacy}`,
      json(
        {
          fields: [
            { name: "title", type: "text" },
            {
              name: "slug",
              type: "text",
              unique: true,
              interface: "slug",
              slug: { from: ["title"] },
            },
          ],
        },
        "PATCH",
      ),
    );
    expect(r.status).toBeLessThan(300);
    declared = true;
  };
  const legacySlugOf = async (id: string): Promise<string | null> => {
    const r = await h.fetch(`/api/items/${legacy}/${id}`);
    return ((await r.json()).data as Record<string, any>).slug ?? null;
  };

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await h.fetch(
      "/api/collections",
      json({
        slug: legacy,
        fields: [
          { name: "title", type: "text" },
          { name: "slug", type: "text", unique: true },
        ],
      }),
    );
    for (const title of [
      "Needs A Handle",
      "Apply Me Please",
      "Sdk Backfills This",
      "Gql Backfills This",
      "Mcp Backfills This",
    ]) {
      ids[title] = await seedEmpty(title);
    }
    // One row that already has a URL somebody may be linking to.
    const kept = await h.fetch(`/api/items/${legacy}`, json({ title: "Keep My Url", slug: "legacy-url" }));
    ids["Keep My Url"] = ((await kept.json()).data as any).id;
    await declareSpec();
  });

  test("REST backfill is a DRY RUN by default and writes nothing", async () => {
    const id = ids["Needs A Handle"]!;
    const r = await h.fetch(`/api/items/${legacy}/slugs/backfill`, json({}));
    expect(r.status).toBe(200);
    const data = (await r.json()).data;
    expect(data.dryRun).toBe(true);
    expect(data.fields[0].filled).toBeGreaterThan(0);
    // The report names what it WOULD write, which is the point of the default.
    expect(data.fields[0].entries.some((e: any) => e.slug === "needs-a-handle")).toBe(true);
    // …and nothing is written.
    expect(await legacySlugOf(id)).toBeNull();
  });

  test("REST backfill with apply writes, and is idempotent", async () => {
    const r = await h.fetch(`/api/items/${legacy}/slugs/backfill`, json({ apply: true }));
    expect(r.status).toBe(200);
    expect((await r.json()).data.dryRun).toBe(false);
    expect(await legacySlugOf(ids["Apply Me Please"]!)).toBe("apply-me-please");
    expect(await legacySlugOf(ids["Needs A Handle"]!)).toBe("needs-a-handle");
    // A second run finds nothing left to do.
    const again = await h.fetch(`/api/items/${legacy}/slugs/backfill`, json({ apply: true }));
    expect((await again.json()).data.fields[0].filled).toBe(0);
  });

  test("backfill never revises a slug that is already set", async () => {
    // It may be a published URL. Asserted AFTER the apply run above.
    expect(await legacySlugOf(ids["Keep My Url"]!)).toBe("legacy-url");
  });

  test("SDK backfill reaches the same service", async () => {
    const rep = await sdk().from(legacy).backfillSlugs({});
    expect(rep.dryRun).toBe(true);
    expect(rep.fields[0]!.field).toBe("slug");
  });

  test("GraphQL backfill reaches the same service", async () => {
    const r = await gql(`mutation {
      backfillSlugs(collection: "${legacy}") { dryRun fields { field filled } }
    }`);
    expect(r.errors).toBeUndefined();
    expect(r.data?.backfillSlugs.dryRun).toBe(true);
    expect(r.data?.backfillSlugs.fields[0].field).toBe("slug");
  });

  test("MCP backfill reaches the same service", async () => {
    const out = (await mcp("slug.backfill", { collection: legacy })) as any;
    expect(out.structuredContent).toBeDefined();
    expect(out.structuredContent.data.dryRun).toBe(true);
  });

  test("CLI exposes the subcommand", () => {
    // Structural: the CLI is a thin argv parser over the SDK, and what rots is
    // a subcommand quietly disappearing from the dispatch or the usage text.
    const src = readFileSync(
      resolve(import.meta.dir, "../../../packages/cli/src/items.ts"),
      "utf8",
    );
    expect(src).toContain('case "backfill-slugs"');
    expect(src).toContain("backfill-slugs <slug>");
    expect(src).toContain("backfillSlugs(");
  });

  test("an unknown field name is refused on every surface that takes one", async () => {
    const rest = await h.fetch(`/api/items/${posts}/slugs/backfill`, json({ field: "nope" }));
    expect(rest.status).toBe(422);
    const g = await gql(`mutation {
      backfillSlugs(collection: "${posts}", field: "nope") { dryRun }
    }`);
    expect(g.errors?.[0]?.message).toContain("not a slug field");
  });
});
