/**
 * `backlex gen-types` module rendering (pure, no network) + the typed-client
 * proxy that the generated `--sdk` factory wires up. Driven against a scripted
 * collection list and a fake fetch — deterministic, no server.
 */
import { describe, expect, test } from "bun:test";
import { renderModule } from "../../../packages/cli/src/gen-types";
import {
  createClient,
  typedCollections,
  type CollectionsMap,
} from "../../../packages/client/src/index";

const COLLECTIONS = [
  {
    slug: "posts",
    fields: [
      { name: "title", type: "text" as const, required: true },
      { name: "body", type: "longtext" as const },
      { name: "tags", type: "relation_many" as const },
      { name: "hero", type: "file" as const },
      { name: "name_i18n", type: "i18n_text" as const },
    ],
    ownerScoped: true,
  },
  {
    slug: "products",
    fields: [{ name: "price", type: "number" as const, required: true }],
    ownerScoped: false,
  },
];

describe("renderModule", () => {
  test("plain mode emits interfaces + registry, no SDK import", () => {
    const out = renderModule(COLLECTIONS, { apiUrl: "https://api.test" });
    expect(out).toContain("export interface Posts {");
    expect(out).toContain("  id: string;");
    // ownerScoped → ownerId; required vs nullable; field-type mapping.
    expect(out).toContain("  ownerId: string | null;");
    expect(out).toContain("  title: string;");
    expect(out).toContain("  body: string | null;");
    expect(out).toContain("  tags: string[] | null;");
    expect(out).toContain("  hero: string | null;");
    expect(out).toContain("  nameI18n: string | Record<string, string> | null;");
    // non-owner-scoped collection omits ownerId.
    expect(out).toContain("export interface Products {");
    expect(out).not.toContain("import {");
    expect(out).toContain("export interface Collections {");
    expect(out).toContain("  posts: Posts;");
    expect(out).toContain("  products: Products;");
    expect(out).not.toContain("createTypedClient");
  });

  test("--sdk mode adds the client import + typed factory", () => {
    const out = renderModule(COLLECTIONS, { apiUrl: "https://api.test", sdk: true });
    expect(out).toContain('from "@backlex/client"');
    expect(out).toContain("typedCollections<Collections>(createClient(opts))");
    expect(out).toContain("export const createTypedClient");
    // interfaces still present
    expect(out).toContain("export interface Posts {");
  });

  test("output is deterministic", () => {
    const a = renderModule(COLLECTIONS, { apiUrl: "https://api.test", sdk: true });
    const b = renderModule(COLLECTIONS, { apiUrl: "https://api.test", sdk: true });
    expect(a).toBe(b);
  });
});

describe("typedCollections proxy", () => {
  test("routes db.collections.<slug> through client.from(slug)", async () => {
    const calls: { method: string; path: string }[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push({ method: "GET", path: String(url) });
      return new Response(JSON.stringify({ data: [], limit: 10, offset: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    type Registry = CollectionsMap & {
      posts: { id: string; title: string };
    };
    const db = typedCollections<Registry>(
      createClient({ url: "https://api.test", fetch: fakeFetch }),
    );

    const res = await db.collections.posts.list();
    expect(res.data).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("https://api.test/api/items/posts");
    // the raw client surface is still reachable on the same object.
    expect(typeof db.from).toBe("function");
    expect(typeof db.auth).toBe("object");
  });
});
