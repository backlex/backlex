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
      { name: "tags", type: "relation_many" as const, to: "categories" },
      { name: "category", type: "relation" as const, to: "categories", required: true },
      { name: "hero", type: "file" as const },
      { name: "name_i18n", type: "text" as const, localized: true },
      {
        name: "status",
        type: "text" as const,
        interface: "dropdown",
        options: { choices: [{ value: "draft" }, { value: "live" }] },
      },
    ],
    ownerScoped: true,
    versioned: true,
  },
  {
    slug: "categories",
    fields: [{ name: "name", type: "text" as const, required: true }],
    ownerScoped: false,
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
    expect(out).toContain("export type Posts = {");
    expect(out).toContain("  id: string;");
    // ownerScoped → ownerId; required vs nullable; field-type mapping.
    expect(out).toContain("  ownerId: string | null;");
    expect(out).toContain("  title: string;");
    expect(out).toContain("  body: string | null;");
    // FK fields are id-typed; the wire returns ids (or expanded objects).
    expect(out).toContain("  tags: string[] | null;");
    expect(out).toContain("  category: string;");
    expect(out).toContain("  hero: string | null;");
    // User fields keep their snake_case wire name — NOT camelCased. This is the
    // bug fix: `row.name_i18n` exists at runtime; `row.nameI18n` was undefined.
    expect(out).toContain("  name_i18n: string | Record<string, string> | null;");
    expect(out).not.toContain("nameI18n");
    // dropdown choices → string-literal union.
    expect(out).toContain('  status: "draft" | "live" | null;');
    // versioned → version columns (camelCased system fields).
    expect(out).toContain("  _status: string;");
    expect(out).toContain("  _publishedAt: string | null;");
    // non-owner-scoped collection omits ownerId.
    expect(out).toContain("export type Products = {");
    expect(out).not.toContain("import {");
    expect(out).toContain("export type Collections = {");
    expect(out).toContain("  posts: Posts;");
    expect(out).toContain("  products: Products;");
    expect(out).not.toContain("createTypedClient");
  });

  test("relations emit a typed expand map + Expand helper", () => {
    const out = renderModule(COLLECTIONS, { apiUrl: "https://api.test" });
    expect(out).toContain("export type Expand<");
    expect(out).toContain("export type PostsRelations = {");
    // relation → single target; relation_many → target array; nullability kept.
    expect(out).toContain("  category: Categories;");
    expect(out).toContain("  tags: Categories[] | null;");
    expect(out).toContain(
      "export type PostsExpanded = Expand<Posts, PostsRelations>;",
    );
    // a collection with no relations gets no relations block.
    expect(out).not.toContain("ProductsRelations");
  });

  test("--sdk mode adds the client import + typed factory", () => {
    const out = renderModule(COLLECTIONS, { apiUrl: "https://api.test", sdk: true });
    expect(out).toContain('from "backlex"');
    expect(out).toContain("typedCollections<Collections>(createClient(opts))");
    expect(out).toContain("export const createTypedClient");
    // interfaces still present
    expect(out).toContain("export type Posts = {");
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

/**
 * The generated module must satisfy its own consumer.
 *
 * `--sdk` output ends in `typedCollections<Collections>(…)`, and
 * `typedCollections<R extends CollectionsMap>` constrains `R` to
 * `Record<string, Record<string, unknown>>`. TypeScript grants implicit index
 * signatures to `type` aliases but NOT to `interface` declarations — so an
 * emitter that reaches for `interface` produces a file that fails to compile
 * in every consumer's build with `TS2344`, while every unit test on the
 * emitted *text* still passes. That is exactly what shipped: 23 interfaces,
 * and `next build` red on the first try.
 *
 * So this asserts against the compiler, not against a substring. Fixing only
 * the registry is not enough — the row types are the `Record<string, unknown>`
 * on the right-hand side and need the index signature too — which is why the
 * assertion below names both.
 */
describe("generated module compiles against CollectionsMap", () => {
  test("Collections and its row types satisfy the typedCollections constraint", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "backlex-gen-types-"));
    try {
      const file = join(dir, "generated.ts");
      writeFileSync(
        file,
        `${renderModule(COLLECTIONS, { apiUrl: "https://api.test" })}
type CollectionsMapProbe = Record<string, Record<string, unknown>>;
// The registry as a whole…
const _registry: CollectionsMapProbe = null as unknown as Collections;
// …and a single row, which is the half a registry-only fix leaves broken.
const _row: Record<string, unknown> = null as unknown as Posts;
export { _registry, _row };
`,
      );

      const proc = Bun.spawnSync([
        join(import.meta.dir, "../../../node_modules/.bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        // Without this, tsc refuses to run at all when a tsconfig.json is
        // present anywhere above the file it was handed (TS5112).
        "--ignoreConfig",
        file,
      ]);
      const out = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
      expect(out).toBe("");
      expect(proc.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
