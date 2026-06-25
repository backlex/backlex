import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Multi-surface parity for the schema-templates feature. REST + the admin SPA
 * already exist; this pins the three surfaces added alongside them — GraphQL
 * (`templates` / `applyTemplate`), the SDK (`client.templates.*`), and MCP
 * (`templates.list` / `templates.apply`) — to the same `/api/admin/templates`
 * semantics (catalog + idempotent, sample-seeding apply). Each surface gets a
 * fresh workspace so the apply counts stay deterministic.
 */
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
      `{ templates { id label category recommended sampleRows collections { slug fieldCount } } }`,
    );
    expect(res.errors).toBeUndefined();
    const ids = (res.data?.templates ?? []).map((t: any) => t.id);
    expect(ids).toContain("blog");
    expect(ids).toContain("ecommerce");
    const blog = res.data?.templates.find((t: any) => t.id === "blog");
    expect(blog.recommended).toBe(true);
    expect(blog.sampleRows).toBeGreaterThan(0);
    expect(blog.collections.length).toBeGreaterThan(0);
  });

  test("applyTemplate seeds collections + sample data (idempotent)", async () => {
    const applied = await gql(
      `mutation($id:String!){ applyTemplate(templateId:$id){ templateId created skipped seeded } }`,
      { id: "blog" },
    );
    expect(applied.errors).toBeUndefined();
    expect(applied.data?.applyTemplate.created).toContain("posts");
    expect(applied.data?.applyTemplate.seeded).toBeGreaterThan(0);

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
    expect(typeof catalog.defaultTemplateId).toBe("string");

    const applied = await client.templates.apply("ecommerce");
    expect(applied.data.templateId).toBe("ecommerce");
    expect(applied.data.created).toContain("products");
    expect(applied.data.seeded).toBeGreaterThan(0);

    // Catalog now reports the workspace as non-empty.
    const after = await client.templates.list();
    expect(after.hasCollections).toBe(true);
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
  });

  test("templates.apply on an unknown id reports an error", async () => {
    const r = await callTool("templates.apply", { templateId: "nope" });
    expect(r.result?.isError).toBe(true);
  });
});
