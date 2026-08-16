import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { TEMPLATES } from "../src/server/templates/catalog";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Multi-surface parity for the schema-templates feature. REST + the admin SPA
 * already exist; this pins the three surfaces added alongside them — GraphQL
 * (`templates` / `applyTemplate`), the SDK (`client.templates.*`), and MCP
 * (`templates.list` / `templates.apply`) — to the same `/api/admin/templates`
 * semantics (catalog + idempotent, sample-seeding apply). Each surface gets a
 * fresh workspace so the apply counts stay deterministic.
 */
const blogTemplate = TEMPLATES.find((t) => t.id === "blog")!;
const blogGroups = blogTemplate.groups!;
const blogSamples = blogTemplate.collections.reduce((n, c) => n + (c.samples?.length ?? 0), 0);
/** Derived, never frozen as literals — the catalog is what these describe. */
const blogKpiSlugs = (blogTemplate.kpis ?? []).map((k) => k.slug);

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("templates — GraphQL surface", () => {
  let h: TestHarness;
  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("templates query lists the catalog with metadata", async () => {
    const res = await gql(
      `{ templates { id label category recommended sampleRows groups roles dashboards collections { slug fieldCount group } } }`,
    );
    expect(res.errors).toBeUndefined();
    const ids = (res.data?.templates ?? []).map((t: any) => t.id);
    expect(ids).toContain("blog");
    expect(ids).toContain("ecommerce");
    const blog = res.data?.templates.find((t: any) => t.id === "blog");
    expect(blog.recommended).toBe(true);
    expect(blog.sampleRows).toBeGreaterThan(0);
    expect(blog.collections.length).toBeGreaterThan(0);
    // Grouping + bundle metadata reach the GraphQL surface too.
    expect(blog.groups).toEqual(blogGroups);
    expect(blog.roles).toEqual(["Editor"]);
    expect(blog.dashboards).toEqual(["Content overview"]);
    expect(blog.collections.find((c: any) => c.slug === "posts").group).toBe("Content");
  });

  test("applyTemplate seeds collections + sample data (idempotent)", async () => {
    const applied = await gql(
      `mutation($id:String!){ applyTemplate(templateId:$id){ templateId created skipped seeded kpis } }`,
      { id: "blog" },
    );
    expect(applied.errors).toBeUndefined();
    expect(applied.data?.applyTemplate.created).toContain("posts");
    expect(applied.data?.applyTemplate.seeded).toBeGreaterThan(0);
    // `kpis` used to be missing from the GraphQL result type while REST, the
    // service and the docs all carried it — so a GraphQL caller could not tell
    // whether a KPI had been installed. Asserted against the catalog rather
    // than a literal list, which is what keeps it true as blog gains KPIs.
    expect(blogKpiSlugs.length).toBeGreaterThan(0);
    expect(applied.data?.applyTemplate.kpis).toEqual(blogKpiSlugs);

    // Re-apply → everything skipped, nothing re-seeded.
    const again = await gql(
      `mutation($id:String!){ applyTemplate(templateId:$id){ created skipped seeded } }`,
      { id: "blog" },
    );
    expect(again.data?.applyTemplate.created).toHaveLength(0);
    expect(again.data?.applyTemplate.seeded).toBe(0);
  });

  test("applyTemplate rejects an unknown template id", async () => {
    const res = await gql(`mutation{ applyTemplate(templateId:"nope"){ templateId } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("extractTemplate → applyCustomTemplate → clearTemplateSamples round-trip", async () => {
    // blog was applied above — extract it (JSON-encoded template).
    const extracted = await gql(`{ extractTemplate }`);
    expect(extracted.errors).toBeUndefined();
    const template = JSON.parse(extracted.data?.extractTemplate ?? "{}") as {
      groups: string[];
      collections: { slug: string; group?: string }[];
    };
    expect(template.groups).toEqual(blogGroups);
    expect(template.collections.find((c) => c.slug === "posts")?.group).toBe("Content");

    // Re-applying it to the SAME workspace converges (everything skipped).
    const applied = await gql(
      `mutation($tpl:String!){ applyCustomTemplate(template:$tpl){ templateId created skipped } }`,
      { tpl: JSON.stringify(template) },
    );
    expect(applied.errors).toBeUndefined();
    expect(applied.data?.applyCustomTemplate.templateId).toBe("custom");
    expect(applied.data?.applyCustomTemplate.created).toHaveLength(0);
    expect(applied.data?.applyCustomTemplate.skipped.length).toBeGreaterThan(0);

    // clearTemplateSamples removes the rows the blog apply seeded…
    const before = await gql(`{ templateSeedStatus { hasCollections sampleSeeds } }`);
    expect(before.data?.templateSeedStatus.hasCollections).toBe(true);
    expect(before.data?.templateSeedStatus.sampleSeeds).toBe(blogSamples);
    const cleared = await gql(`mutation{ clearTemplateSamples { removed collections } }`);
    expect(cleared.errors).toBeUndefined();
    expect(cleared.data?.clearTemplateSamples.removed).toBe(blogSamples);
    // …and the seed status reflects it (REST catalog-meta parity).
    const after = await gql(`{ templateSeedStatus { sampleSeeds } }`);
    expect(after.data?.templateSeedStatus.sampleSeeds).toBe(0);
  });
});

describe("templates — SDK surface", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });
  afterAll(() => h.cleanup());

  test("list → apply round-trips", async () => {
    const catalog = await client.templates.list();
    expect(catalog.data.some((t) => t.id === "ecommerce")).toBe(true);
    expect(catalog.hasCollections).toBe(false);
    expect(catalog.sampleSeeds).toBe(0);
    expect(typeof catalog.defaultTemplateId).toBe("string");
    const ecommerce = catalog.data.find((t) => t.id === "ecommerce")!;
    expect(ecommerce.groups[0]).toBe("Catalog");
    expect(ecommerce.roles).toEqual(["Store staff"]);
    expect(ecommerce.dashboards).toEqual(["Store overview"]);

    const applied = await client.templates.apply("ecommerce");
    expect(applied.data.templateId).toBe("ecommerce");
    expect(applied.data.created).toContain("products");
    expect(applied.data.seeded).toBeGreaterThan(0);
    expect(applied.data.roles).toEqual(["Store staff"]);
    expect(applied.data.dashboards).toEqual(["Store overview"]);
    expect(applied.data.kpis).toEqual(
      (TEMPLATES.find((t) => t.id === "ecommerce")?.kpis ?? []).map((k) => k.slug),
    );

    // Catalog now reports the workspace as non-empty + the seed manifest.
    const after = await client.templates.list();
    expect(after.hasCollections).toBe(true);
    expect(after.sampleSeeds).toBe(applied.data.seeded);
  });

  test("extract → applyCustom → clearSamples", async () => {
    const extracted = await client.templates.extract({
      collections: ["products", "brands", "categories", "media"],
    });
    const slugs = extracted.data.collections.map((c) => c.slug);
    expect(slugs.sort()).toEqual(["brands", "categories", "media", "products"].sort());
    expect(extracted.data.collections.find((c) => c.slug === "products")?.group).toBe("Catalog");

    // Same workspace → converges (all skipped).
    const applied = await client.templates.applyCustom(extracted.data);
    expect(applied.data.created).toHaveLength(0);
    expect(applied.data.skipped.length).toBe(4);

    const cleared = await client.templates.clearSamples();
    expect(cleared.data.removed).toBeGreaterThan(0);
    const after = await client.templates.list();
    expect(after.sampleSeeds).toBe(0);
  });
});

describe("templates — MCP surface", () => {
  let h: TestHarness;
  let rpcId = 1;
  const callTool = async (name: string, args: unknown) => {
    const res = await h.fetch(
      "/mcp",
      json({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
    );
    return (await res.json()) as {
      result?: { structuredContent?: any; isError?: boolean };
      error?: { message: string };
    };
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("templates.list returns the catalog", async () => {
    const r = await callTool("templates.list", {});
    expect(r.error).toBeUndefined();
    expect(r.result?.isError).toBeFalsy();
    const ids = (r.result?.structuredContent?.data ?? []).map((t: any) => t.id);
    expect(ids).toContain("crm");
  });

  test("templates.apply seeds the workspace", async () => {
    const r = await callTool("templates.apply", { templateId: "crm" });
    expect(r.error).toBeUndefined();
    expect(r.result?.isError).toBeFalsy();
    expect(r.result?.structuredContent?.data?.created).toContain("contacts");
    expect(r.result?.structuredContent?.data?.seeded).toBeGreaterThan(0);
    expect(r.result?.structuredContent?.data?.roles).toEqual(["Sales manager"]);
    expect(r.result?.structuredContent?.data?.dashboards).toEqual(["Sales overview"]);
  });

  test("templates.apply on an unknown id reports an error", async () => {
    const r = await callTool("templates.apply", { templateId: "nope" });
    expect(r.result?.isError).toBe(true);
  });

  test("templates.extract → templates.apply(template) → templates.clearSamples", async () => {
    const extracted = await callTool("templates.extract", { collections: ["companies", "contacts"] });
    expect(extracted.result?.isError).toBeFalsy();
    const template = extracted.result?.structuredContent?.data;
    expect(template?.collections?.map((c: any) => c.slug).sort()).toEqual([
      "companies",
      "contacts",
    ]);
    expect(template?.collections?.find((c: any) => c.slug === "contacts")?.group).toBe("People");

    // Inline custom apply on the same workspace converges (all skipped).
    const applied = await callTool("templates.apply", { template });
    expect(applied.result?.isError).toBeFalsy();
    expect(applied.result?.structuredContent?.data?.created).toHaveLength(0);

    const cleared = await callTool("templates.clearSamples", {});
    expect(cleared.result?.isError).toBeFalsy();
    expect(cleared.result?.structuredContent?.data?.removed).toBeGreaterThan(0);
  });
});
