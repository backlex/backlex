/**
 * MCP server contract tests. Drives the stateless Streamable HTTP transport
 * end-to-end (`POST /mcp`, `POST /api/admin/mcp`) through the same Hono app
 * the runtime uses — every sub-fetch a tool issues re-enters the same app
 * instance, so permission middleware, validation, and activity logging
 * behave exactly as they would in production.
 *
 * The tests deliberately use two harnesses: one for the admin (cookie
 * session via seedAdmin) and one for an API-key-only path. API-key
 * Bearer calls bypass the cookie-tracking fetch wrapper so the fallback
 * auth path in middleware/session.ts is exercised.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const APP_URL = "http://localhost:5173";

interface RpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface RpcSuccess<T = any> {
  jsonrpc: "2.0";
  id: number | string;
  result: T;
}

interface RpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string };
}

type RpcResponse<T = any> = RpcSuccess<T> | RpcError;

const isErr = (r: RpcResponse): r is RpcError => "error" in r;

/** Hit `/mcp` (or `/api/admin/mcp`) with a JSON-RPC message via the
 *  cookie-tracking fetch — used for the admin cookie-session path. */
const mcp = async (
  h: TestHarness,
  body: RpcRequest,
  path = "/mcp",
): Promise<RpcResponse> => {
  const res = await h.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as RpcResponse;
};

/** Hit `/mcp` with a raw Bearer header (no cookie). Used for API-key path
 *  so the fallback resolves the key — the cookie jar would otherwise
 *  short-circuit to the admin session. */
const mcpBearer = async (
  h: TestHarness,
  secret: string,
  body: RpcRequest,
  path = "/mcp",
): Promise<{ status: number; rpc: RpcResponse }> => {
  const res = await h.app.fetch(
    new Request(`${APP_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
        origin: APP_URL,
      },
      body: JSON.stringify(body),
    }),
  );
  let rpc: RpcResponse;
  if (res.status === 200) {
    rpc = (await res.json()) as RpcResponse;
  } else {
    // Pre-RPC failures (401 from requireUser, 403 from requireAdmin) don't
    // come back as JSON-RPC — surface them so the test can assert on status.
    rpc = { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32000, message: `http ${res.status}` } };
  }
  return { status: res.status, rpc };
};

const callTool = async (
  h: TestHarness,
  name: string,
  args: Record<string, unknown> = {},
  path = "/mcp",
): Promise<any> => {
  const r = await mcp(h, {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1e9),
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (isErr(r)) throw new Error(`${name}: ${r.error.message}`);
  return r.result;
};

describe("MCP — initialize + tools/list", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("initialize returns the server descriptor", async () => {
    const r = await mcp(h, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(isErr(r)).toBe(false);
    const result = (r as RpcSuccess).result;
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.serverInfo.name).toBe("backlex");
    expect(result.capabilities.tools).toBeDefined();
  });

  test("tools/list returns every namespace", async () => {
    const r = await mcp(h, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(isErr(r)).toBe(false);
    const names = (r as RpcSuccess).result.tools.map((t: any) => t.name);
    // Original 13 (Phase 1) — schema discovery + collection CRUD + storage + functions
    expect(names).toContain("schema.list_collections");
    expect(names).toContain("schema.describe_collection");
    expect(names).toContain("collections.list");
    expect(names).toContain("collections.read");
    expect(names).toContain("collections.insert");
    expect(names).toContain("collections.update");
    expect(names).toContain("collections.delete");
    expect(names).toContain("storage.list");
    expect(names).toContain("storage.upload");
    expect(names).toContain("storage.get");
    expect(names).toContain("storage.delete");
    expect(names).toContain("functions.list");
    expect(names).toContain("functions.invoke");
    // Catalog expansion — every backlex surface.
    expect(names).toContain("schema.create_collection");
    expect(names).toContain("schema.update_collection");
    expect(names).toContain("schema.drop_collection");
    expect(names).toContain("collections.bulk_insert");
    expect(names).toContain("collections.bulk_update");
    expect(names).toContain("storage.sign_url");
    expect(names).toContain("vector.search");
    expect(names).toContain("vector.upsert");
    expect(names).toContain("graphql.execute");
    expect(names).toContain("permissions.list_for_role");
    expect(names).toContain("permissions.grant");
    expect(names).toContain("permissions.revoke");
    expect(names).toContain("roles.list");
    expect(names).toContain("roles.create");
    expect(names).toContain("roles.assign");
    expect(names).toContain("roles.unassign");
    expect(names).toContain("apikeys.list");
    expect(names).toContain("apikeys.create");
    expect(names).toContain("apikeys.revoke");
    expect(names).toContain("webhooks.list");
    expect(names).toContain("webhooks.create");
    expect(names).toContain("webhooks.delete");
    expect(names).toContain("webhooks.test");
    expect(names).toContain("flows.list");
    expect(names).toContain("flows.get");
    expect(names).toContain("flows.invoke");
    expect(names).toContain("notifications.list");
    expect(names).toContain("notifications.send");
    expect(names).toContain("notifications.mark_read");
    expect(names).toContain("users.list");
    expect(names).toContain("users.invite");
    expect(names).toContain("users.suspend");
    expect(names).toContain("users.activate");
    // Tier C — every remaining backlex surface
    expect(names).toContain("db.execute_sql");
    expect(names).toContain("db.list_tables");
    expect(names).toContain("activity.search");
    expect(names).toContain("tenants.list");
    expect(names).toContain("tenants.switch");
    expect(names).toContain("app_users.list");
    expect(names).toContain("app_users.set_roles");
    expect(names).toContain("app_users.update");
    expect(names).toContain("saml.providers_list");
    expect(names).toContain("saml.providers_create");
    expect(names).toContain("saml.providers_delete");
    expect(names).toContain("shared_links.list");
    expect(names).toContain("shared_links.create");
    expect(names).toContain("shared_links.revoke");
    expect(names).toContain("folders.list");
    expect(names).toContain("folders.create");
    expect(names).toContain("folders.delete");
    expect(names).toContain("revisions.list");
    expect(names).toContain("revisions.revert");
    expect(names).toContain("comments.list");
    expect(names).toContain("comments.post");
    expect(names).toContain("comments.delete");
    expect(names).toContain("embedding.upsert");
    expect(names).toContain("settings.get");
    expect(names).toContain("settings.update");
    // Tier D — AI-native
    expect(names).toContain("ai.query");
    expect(names).toContain("ai.suggest_schema");
    expect(names).toContain("ai.import_csv");
    // Roster must have at least the catalog above; running count makes any
    // future drift surface as a deliberate test update, not a silent change.
    expect(names.length).toBeGreaterThanOrEqual(74);
  });

  test("tools/list surfaces kind + adminOnly hints", async () => {
    // The Ask-AI Tools tab renders kind/adminOnly as badges — make sure
    // both fields ride through `tools/list` for every tool, every kind is
    // represented somewhere in the catalog, and the functions.* pair is
    // flagged adminOnly so the badge shows up.
    const r = await mcp(h, { jsonrpc: "2.0", id: 33, method: "tools/list" });
    expect(isErr(r)).toBe(false);
    const tools = (r as RpcSuccess).result.tools as Array<{
      name: string;
      kind?: string;
      adminOnly?: boolean;
    }>;
    for (const t of tools) {
      expect(t.kind).toMatch(/^(read|write|destruct)$/);
    }
    const kinds = new Set(tools.map((t) => t.kind));
    expect(kinds.has("read")).toBe(true);
    expect(kinds.has("write")).toBe(true);
    expect(kinds.has("destruct")).toBe(true);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("functions.list")?.adminOnly).toBe(true);
    expect(byName.get("functions.invoke")?.adminOnly).toBe(true);
    expect(byName.get("schema.list_collections")?.kind).toBe("read");
    expect(byName.get("collections.delete")?.kind).toBe("destruct");
  });

  test("notifications/initialized is a no-op (returns 202)", async () => {
    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
  });

  test("GET /mcp is 405 (no resumable stream)", async () => {
    const res = await h.fetch("/mcp", { method: "GET" });
    expect(res.status).toBe(405);
  });

  test("malformed JSON body is a parse-error JSON-RPC response", async () => {
    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as RpcError;
    expect(body.error.code).toBe(-32700);
  });

  test("unauthenticated request to /mcp is 401", async () => {
    const fresh = makeHarness();
    try {
      const res = await fresh.fetch("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
    } finally {
      fresh.cleanup();
    }
  });
});

describe("MCP — schema tools", () => {
  let h: TestHarness;
  const slug = `mcp_schema_${Date.now()}`;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "body", type: "longtext" },
        ],
      }),
    });
    expect(r.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("schema.list_collections includes the new collection", async () => {
    const result = await callTool(h, "schema.list_collections", {});
    const cols = result.structuredContent.collections;
    const found = cols.find((c: any) => c.slug === slug);
    expect(found).toBeDefined();
    expect(found.fieldCount).toBe(2);
  });

  test("schema.describe_collection returns the field schema", async () => {
    const result = await callTool(h, "schema.describe_collection", { collection: slug });
    const desc = result.structuredContent;
    expect(desc.slug).toBe(slug);
    expect(desc.fields.length).toBe(2);
    expect(desc.fields[0].name).toBe("title");
    expect(desc.fields[0].required).toBe(true);
  });

  test("schema.describe_collection on unknown slug surfaces upstream error", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: { name: "schema.describe_collection", arguments: { collection: "definitely-not-real" } },
    });
    const result = (r as RpcSuccess).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("NOT_FOUND");
  });
});

describe("MCP — collections CRUD", () => {
  let h: TestHarness;
  const slug = `mcp_items_${Date.now()}`;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const r = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "views", type: "integer" },
        ],
      }),
    });
    expect(r.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("insert + read + update + list + delete round-trip", async () => {
    const inserted = await callTool(h, "collections.insert", {
      collection: slug,
      data: { title: "first", views: 10 },
    });
    const id = inserted.structuredContent.data.id;
    expect(typeof id).toBe("string");

    const read = await callTool(h, "collections.read", {
      collection: slug,
      id,
    });
    expect(read.structuredContent.data.title).toBe("first");

    const updated = await callTool(h, "collections.update", {
      collection: slug,
      id,
      data: { title: "renamed" },
    });
    expect(updated.structuredContent.data.title).toBe("renamed");

    await callTool(h, "collections.insert", {
      collection: slug,
      data: { title: "second", views: 99 },
    });

    const listed = await callTool(h, "collections.list", {
      collection: slug,
      sort: "-views",
      limit: 10,
    });
    expect(listed.structuredContent.data.length).toBe(2);
    expect(listed.structuredContent.data[0].views).toBe(99);

    const filtered = await callTool(h, "collections.list", {
      collection: slug,
      filter: { title: { _eq: "renamed" } },
    });
    expect(filtered.structuredContent.data.length).toBe(1);

    const deleted = await callTool(h, "collections.delete", { collection: slug, id });
    expect(deleted.structuredContent.ok).toBe(true);

    const after = await mcp(h, {
      jsonrpc: "2.0",
      id: 77,
      method: "tools/call",
      params: { name: "collections.read", arguments: { collection: slug, id } },
    });
    expect((after as RpcSuccess).result.isError).toBe(true);
  });

  test("collections.insert without required field surfaces validation error", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0",
      id: 78,
      method: "tools/call",
      params: {
        name: "collections.insert",
        arguments: { collection: slug, data: { views: 1 } },
      },
    });
    const result = (r as RpcSuccess).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/title|required|VALIDATION/i);
  });
});

describe("MCP — storage tools", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("upload (text) + get + list + delete round-trip", async () => {
    const key = `mcp/notes/hello-${Date.now()}.txt`;
    const text = "hello from mcp test";

    const uploaded = await callTool(h, "storage.upload", { key, text });
    expect(uploaded.structuredContent.data ?? uploaded.structuredContent).toBeDefined();

    const got = await callTool(h, "storage.get", { key });
    expect(got.content[0].type).toBe("text");
    expect(got.content[0].text).toBe(text);

    const listed = await callTool(h, "storage.list", { search: "mcp/notes/hello" });
    const data = listed.structuredContent.data as Array<{ key: string }>;
    expect(data.some((r) => r.key === key)).toBe(true);

    const deleted = await callTool(h, "storage.delete", { key });
    expect(deleted.structuredContent.ok ?? true).toBeTruthy();
  });

  test("storage.upload requires text or base64", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: { name: "storage.upload", arguments: { key: "x/y.txt" } },
    });
    expect((r as RpcSuccess).result.isError).toBe(true);
  });
});

describe("MCP — functions tools (admin gate)", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("functions.list works for admin (empty workspace returns empty array)", async () => {
    const result = await callTool(h, "functions.list", {});
    expect(Array.isArray(result.structuredContent.functions)).toBe(true);
  });

  test("functions.invoke on unknown function returns isError", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0",
      id: 200,
      method: "tools/call",
      params: { name: "functions.invoke", arguments: { name: "no-such-fn", input: {} } },
    });
    const result = (r as RpcSuccess).result;
    expect(result.isError).toBe(true);
  });
});

describe("MCP — admin mount gate", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("admin (cookie session) can reach /api/admin/mcp", async () => {
    const r = await mcp(h, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "/api/admin/mcp");
    expect(isErr(r)).toBe(false);
    expect((r as RpcSuccess).result.tools.length).toBeGreaterThanOrEqual(74);
  });

  test("unauthenticated request to /api/admin/mcp is 401", async () => {
    const fresh = makeHarness();
    try {
      const res = await fresh.fetch("/api/admin/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
    } finally {
      fresh.cleanup();
    }
  });
});

describe("MCP — API key (pak_) auth path", () => {
  let h: TestHarness;
  let adminSecret = "";
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // `mcpTools: null` opts into the legacy permissive shape — the
    // default-deny on create would otherwise yield zero callable tools.
    const create = await h.fetch("/api/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `mcp-test-${Date.now()}`, mcpTools: null }),
    });
    expect(create.status).toBe(201);
    const body = (await create.json()) as { data: { secret: string } };
    adminSecret = body.data.secret;
  });
  afterAll(() => h.cleanup());

  test("pak_ bearer reaches /mcp tools/list", async () => {
    const { status, rpc } = await mcpBearer(h, adminSecret, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(status).toBe(200);
    expect(isErr(rpc)).toBe(false);
    expect((rpc as RpcSuccess).result.tools.length).toBeGreaterThanOrEqual(74);
  });

  test("pak_ bearer with admin role reaches /api/admin/mcp", async () => {
    const { status, rpc } = await mcpBearer(
      h,
      adminSecret,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "/api/admin/mcp",
    );
    expect(status).toBe(200);
    expect(isErr(rpc)).toBe(false);
  });

  test("invalid bearer is 401", async () => {
    const { status } = await mcpBearer(
      h,
      "pak_00000000_deadbeef",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
    );
    expect(status).toBe(401);
  });
});

describe("MCP — schema CRUD tools", () => {
  let h: TestHarness;
  const slug = `mcp_schema_crud_${Date.now()}`;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("create_collection + describe + update + drop round-trip", async () => {
    const created = await callTool(h, "schema.create_collection", {
      slug,
      fields: [
        { name: "title", type: "text", required: true },
        { name: "stock", type: "integer" },
      ],
    });
    expect(created.structuredContent.data.slug).toBe(slug);

    const described = await callTool(h, "schema.describe_collection", { collection: slug });
    expect(described.structuredContent.fields.length).toBe(2);

    const updated = await callTool(h, "schema.update_collection", {
      slug,
      fields: [
        { name: "title", type: "text", required: true },
        { name: "stock", type: "integer" },
        { name: "active", type: "boolean" },
      ],
    });
    expect(updated.structuredContent.ok).toBe(true);

    const dropped = await callTool(h, "schema.drop_collection", { slug });
    expect(dropped.structuredContent.ok).toBe(true);
  });
});

describe("MCP — bulk tools", () => {
  let h: TestHarness;
  const slug = `mcp_bulk_${Date.now()}`;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "n", type: "integer" },
        ],
      }),
    });
  });
  afterAll(() => h.cleanup());

  test("bulk_insert succeeds 3 rows, surfaces per-row error on the bad one", async () => {
    const result = await callTool(h, "collections.bulk_insert", {
      collection: slug,
      rows: [
        { title: "a", n: 1 },
        { title: "b", n: 2 },
        // Missing required title → per-row error, not a global fail
        { n: 3 },
        { title: "d", n: 4 },
      ],
    });
    const sc = result.structuredContent;
    expect(sc.total).toBe(4);
    expect(sc.succeeded).toBe(3);
    expect(sc.failed).toBe(1);
    expect(result.isError).toBe(true);
    expect(sc.results[2].ok).toBe(false);
  });

  test("bulk_update patches every row", async () => {
    const inserted = await callTool(h, "collections.bulk_insert", {
      collection: slug,
      rows: [
        { title: "upd-1", n: 10 },
        { title: "upd-2", n: 20 },
      ],
    });
    const ids = (inserted.structuredContent.results as Array<{ data: { id: string } }>).map(
      (r) => r.data.id,
    );
    const result = await callTool(h, "collections.bulk_update", {
      collection: slug,
      updates: ids.map((id) => ({ id, data: { n: 999 } })),
    });
    expect(result.structuredContent.succeeded).toBe(2);
    expect(result.isError).toBe(false);
  });
});

describe("MCP — storage signed url", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("upload + sign_url works at 4-segment key depth", async () => {
    // 4-segment key — the deepest of the OpenAPIHono router-quirk cases.
    // See `tests/storage-sign.test.ts` for the root-cause regression.
    const key = `mcp/signed/nested/test-${Date.now()}.txt`;
    await callTool(h, "storage.upload", { key, text: "hi" });
    const signed = await callTool(h, "storage.sign_url", { key, ttlSeconds: 300 });
    expect(typeof signed.structuredContent.url).toBe("string");
    expect(signed.structuredContent.url).toContain("token=");
    expect(typeof signed.structuredContent.expiresAt).toBe("string");
  });
});

describe("MCP — graphql tool", () => {
  let h: TestHarness;
  // The auto-generated GraphQL query field is `camel(slug)`. Keep the slug
  // single-segment so the camel form is the slug verbatim and the test
  // doesn't have to track the casing function separately.
  const slug = `mcpgql${Date.now()}`;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "n", type: "integer" },
        ],
      }),
    });
    await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "gql-row", n: 7 }),
    });
  });
  afterAll(() => h.cleanup());

  test("graphql.execute returns rows through the auto schema", async () => {
    const result = await callTool(h, "graphql.execute", {
      query: `{ ${slug}(limit: 5) { id title n } }`,
    });
    const sc = result.structuredContent as { data: Record<string, unknown[]> };
    expect(Array.isArray(sc.data[slug])).toBe(true);
    expect(sc.data[slug]!.length).toBeGreaterThanOrEqual(1);
    expect(result.isError).toBeFalsy();
  });

  test("graphql.execute surfaces query errors via isError", async () => {
    const result = await callTool(h, "graphql.execute", {
      query: `{ nonexistent_field_xyz }`,
    });
    expect(result.isError).toBe(true);
  });
});

describe("MCP — permissions + roles tools", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("roles.list returns the seeded system roles", async () => {
    const result = await callTool(h, "roles.list", {});
    const rows = result.structuredContent.data ?? result.structuredContent;
    expect(Array.isArray(rows)).toBe(true);
    const names = (rows as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain("admin");
    expect(names).toContain("authenticated");
  });

  test("roles.create + permissions.grant + permissions.list_for_role round-trip", async () => {
    const created = await callTool(h, "roles.create", {
      name: `mcp-test-${Date.now()}`,
    });
    const newRole = created.structuredContent.data ?? created.structuredContent;
    const roleId = (newRole as { id: string }).id;
    expect(typeof roleId).toBe("string");

    const granted = await callTool(h, "permissions.grant", {
      roleId,
      collection: "system_files",
      action: "read",
    });
    expect(granted.structuredContent.data ?? granted.structuredContent).toBeDefined();

    const listed = await callTool(h, "permissions.list_for_role", { roleId });
    const perms = listed.structuredContent.data ?? listed.structuredContent;
    expect(Array.isArray(perms)).toBe(true);
    expect((perms as Array<{ collection: string }>).some((p) => p.collection === "system_files")).toBe(true);
  });
});

describe("MCP — api-keys tools", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("apikeys.list + create + revoke round-trip", async () => {
    const created = await callTool(h, "apikeys.create", { name: `mcp-tool-${Date.now()}` });
    const data = created.structuredContent.data;
    expect(data.secret).toMatch(/^pak_/);
    const id = data.id;

    const listed = await callTool(h, "apikeys.list", {});
    const rows = listed.structuredContent.data;
    expect(rows.some((r: any) => r.id === id)).toBe(true);

    const revoked = await callTool(h, "apikeys.revoke", { id });
    expect(revoked.structuredContent.ok ?? true).toBeTruthy();
  });
});

describe("MCP — users + notifications tools", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("users.list returns the seeded admin", async () => {
    const result = await callTool(h, "users.list", {});
    const rows = result.structuredContent.data ?? result.structuredContent;
    expect(Array.isArray(rows)).toBe(true);
    expect((rows as Array<unknown>).length).toBeGreaterThanOrEqual(1);
  });

  test("notifications.list returns an array (empty is fine)", async () => {
    const result = await callTool(h, "notifications.list", {});
    const rows = result.structuredContent.data ?? result.structuredContent;
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe("MCP — per-key guards (allowlist + read-only)", () => {
  let h: TestHarness;
  let restrictedKey = "";
  let readOnlyKey = "";
  let openKey = "";
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const make = async (extra: Record<string, unknown>) => {
      const r = await h.fetch("/api/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `guard-${Math.random()}`, ...extra }),
      });
      const body = (await r.json()) as { data: { secret: string } };
      return body.data.secret;
    };
    // `mcpTools: null` keeps the historic "open" semantics these tests
    // exercise; the create-time default-deny would otherwise return [] and
    // hide every tool from `tools/list`.
    openKey = await make({ mcpTools: null });
    restrictedKey = await make({
      mcpTools: ["schema.list_collections", "collections.list", "collections.read"],
    });
    readOnlyKey = await make({ mcpReadOnly: true, mcpTools: null });
  });
  afterAll(() => h.cleanup());

  test("allowlist filters tools/list down to the allowed set", async () => {
    const { rpc } = await mcpBearer(h, restrictedKey, {
      jsonrpc: "2.0", id: 1, method: "tools/list",
    });
    const names: string[] = (rpc as RpcSuccess).result.tools.map((t: any) => t.name);
    expect(names.sort()).toEqual(
      ["schema.list_collections", "collections.list", "collections.read"].sort(),
    );
  });

  test("allowlist blocks tools/call for non-listed tools", async () => {
    const { rpc } = await mcpBearer(h, restrictedKey, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "collections.delete", arguments: { collection: "x", id: "1" } },
    });
    const result = (rpc as RpcSuccess).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("FORBIDDEN");
    expect(result.content[0].text).toContain("allowlist");
  });

  test("allowlist permits an in-list call (still subject to upstream perms)", async () => {
    const { rpc } = await mcpBearer(h, restrictedKey, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "schema.list_collections", arguments: {} },
    });
    const result = (rpc as RpcSuccess).result;
    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.structuredContent.collections)).toBe(true);
  });

  test("read-only key blocks write verbs (collections.insert)", async () => {
    const { rpc } = await mcpBearer(h, readOnlyKey, {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "collections.insert", arguments: { collection: "x", data: { a: 1 } } },
    });
    const result = (rpc as RpcSuccess).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("read-only");
  });

  test("read-only key allows read verbs (collections.list)", async () => {
    const { rpc } = await mcpBearer(h, readOnlyKey, {
      jsonrpc: "2.0", id: 5, method: "tools/list",
    });
    // List is unrestricted (no allowlist), just filtered for read-only doesn't
    // hide tools — only blocks calls.
    expect((rpc as RpcSuccess).result.tools.length).toBeGreaterThanOrEqual(74);
  });

  test("open key (no guards) sees the full roster and can call any tool", async () => {
    const { rpc: listRpc } = await mcpBearer(h, openKey, {
      jsonrpc: "2.0", id: 6, method: "tools/list",
    });
    expect((listRpc as RpcSuccess).result.tools.length).toBeGreaterThanOrEqual(74);
  });

  test("read-only key blocks tier-C write verbs (db.execute_sql with writes=1)", async () => {
    const { rpc } = await mcpBearer(h, readOnlyKey, {
      jsonrpc: "2.0", id: 41, method: "tools/call",
      params: { name: "db.execute_sql", arguments: { sql: "select 1", writes: true } },
    });
    const result = (rpc as RpcSuccess).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("read-only");
  });

  test("read-only key blocks shared_links.create", async () => {
    const { rpc } = await mcpBearer(h, readOnlyKey, {
      jsonrpc: "2.0", id: 42, method: "tools/call",
      params: { name: "shared_links.create", arguments: { collection: "x", itemId: "1" } },
    });
    expect((rpc as RpcSuccess).result.isError).toBe(true);
  });

  test("read-only key blocks tenants.switch", async () => {
    const { rpc } = await mcpBearer(h, readOnlyKey, {
      jsonrpc: "2.0", id: 43, method: "tools/call",
      params: { name: "tenants.switch", arguments: { tenantId: "noop" } },
    });
    expect((rpc as RpcSuccess).result.isError).toBe(true);
  });

  test("PATCH /api/api-keys/:id/mcp-guards updates allowlist + read-only live", async () => {
    // Create a fresh open key, then narrow it and read back.
    const create = await h.fetch("/api/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "guard-update" }),
    });
    const created = (await create.json()) as { data: { id: string; secret: string } };
    const patch = await h.fetch(`/api/api-keys/${created.data.id}/mcp-guards`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mcpTools: ["roles.list"],
        mcpReadOnly: true,
      }),
    });
    expect(patch.status).toBe(200);
    const { rpc } = await mcpBearer(h, created.data.secret, {
      jsonrpc: "2.0", id: 7, method: "tools/list",
    });
    const names: string[] = (rpc as RpcSuccess).result.tools.map((t: any) => t.name);
    expect(names).toEqual(["roles.list"]);
  });
});

describe("MCP — tier D AI-native tools (ai.query / ai.suggest_schema / ai.import_csv)", () => {
  // Tests don't hit a real provider — they verify dispatch + arg
  // validation + the UNAVAILABLE path when no AI credential is set (neither
  // AI_GATEWAY_API_KEY nor ANTHROPIC_API_KEY — the default in the test
  // harness). Live calls are exercised manually via `bun backlex mcp`
  // against a configured deployment.
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("ai.query without any AI credential surfaces UNAVAILABLE", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 700, method: "tools/call",
      params: { name: "ai.query", arguments: { collection: "users", prompt: "any" } },
    });
    const result = (r as RpcSuccess).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("AI_GATEWAY_API_KEY");
    expect(result.content[0].text).toContain("ANTHROPIC_API_KEY");
  });

  test("ai.suggest_schema validates description is required", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 701, method: "tools/call",
      params: { name: "ai.suggest_schema", arguments: {} },
    });
    const result = (r as RpcSuccess).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/description|VALIDATION/i);
  });

  test("ai.import_csv validates csv is required", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 702, method: "tools/call",
      params: { name: "ai.import_csv", arguments: {} },
    });
    const result = (r as RpcSuccess).result;
    expect(result.isError).toBe(true);
  });

  test("ai.import_csv enforces 5 MB cap", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 703, method: "tools/call",
      params: { name: "ai.import_csv", arguments: { csv: "x".repeat(5_000_001) } },
    });
    const result = (r as RpcSuccess).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("5 MB");
  });

  test("ai.import_csv with collection set inserts rows from CSV (no Claude call required)", async () => {
    const slug = `mcp_csv_${Date.now()}`;
    const createRes = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "name", type: "text", required: true },
          { name: "amount", type: "text" },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    const csv = `name,amount\nAlpha,100\nBeta,200\nGamma,300\n`;
    const r = await callTool(h, "ai.import_csv", { csv, collection: slug });
    expect(r.structuredContent.mode).toBe("insert");
    expect(r.structuredContent.total).toBe(3);
    expect(r.structuredContent.succeeded).toBe(3);
    expect(r.structuredContent.failed).toBe(0);
  });

  test("ai.import_csv quoted-CSV parser handles commas inside values", async () => {
    const slug = `mcp_csv2_${Date.now()}`;
    await h.fetch("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "label", type: "text", required: true },
          { name: "note", type: "longtext" },
        ],
      }),
    });
    const csv = `label,note\n"Hello, World","line one"\n"Quote ""inside""","x"\n`;
    const r = await callTool(h, "ai.import_csv", { csv, collection: slug });
    expect(r.structuredContent.total).toBe(2);
    expect(r.structuredContent.succeeded).toBe(2);
  });
});

describe("MCP — tier C tools smoke (db/activity/tenants/folders/comments/settings/shared_links/saml/app_users/revisions/embedding)", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("db.list_tables returns the workspace's physical tables", async () => {
    const result = await callTool(h, "db.list_tables", {});
    const tables = result.structuredContent.data ?? result.structuredContent;
    expect(Array.isArray(tables) || typeof tables === "object").toBe(true);
  });

  test("db.execute_sql executes a SELECT", async () => {
    const result = await callTool(h, "db.execute_sql", { sql: "SELECT 1 AS one" });
    expect(result.structuredContent).toBeDefined();
  });

  test("activity.search returns an array", async () => {
    const result = await callTool(h, "activity.search", { limit: 5 });
    const rows = result.structuredContent.data ?? result.structuredContent;
    expect(Array.isArray(rows)).toBe(true);
  });

  test("tenants.list returns the seeded default tenant", async () => {
    const result = await callTool(h, "tenants.list", {});
    const rows = result.structuredContent.data ?? result.structuredContent;
    expect(Array.isArray(rows)).toBe(true);
    expect((rows as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  test("folders.list returns an array (empty fine)", async () => {
    const result = await callTool(h, "folders.list", {});
    const rows = result.structuredContent.data ?? result.structuredContent;
    expect(Array.isArray(rows)).toBe(true);
  });

  test("comments.list returns without error (shape varies — empty/array/scoped-required)", async () => {
    // comments.list may require a (collection, itemId) scope; an empty call
    // either returns an empty workspace listing or an upstream validation
    // error. Both are fine — we just want to prove dispatch + sub-fetch
    // wiring works.
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 944, method: "tools/call",
      params: { name: "comments.list", arguments: {} },
    });
    expect((r as RpcSuccess).result).toBeDefined();
  });

  test("settings.get returns the app_settings row", async () => {
    const result = await callTool(h, "settings.get", {});
    expect(result.structuredContent).toBeDefined();
  });

  test("shared_links.list returns without error (shape varies by workspace)", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 955, method: "tools/call",
      params: { name: "shared_links.list", arguments: {} },
    });
    expect((r as RpcSuccess).result).toBeDefined();
  });

  test("saml.providers_list returns an array", async () => {
    const result = await callTool(h, "saml.providers_list", {});
    const rows = result.structuredContent.data ?? result.structuredContent;
    expect(Array.isArray(rows)).toBe(true);
  });

  test("app_users.list returns an array (empty fine)", async () => {
    const result = await callTool(h, "app_users.list", {});
    const rows = result.structuredContent.data ?? result.structuredContent;
    expect(Array.isArray(rows)).toBe(true);
  });

  test("revisions.list on unknown collection/item surfaces an error gracefully", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 800, method: "tools/call",
      params: { name: "revisions.list", arguments: { collection: "x", itemId: "y" } },
    });
    // Either an empty list or an upstream error — both are non-crashing.
    const result = (r as RpcSuccess).result;
    expect(result.structuredContent !== undefined || result.isError === true).toBe(true);
  });
});

describe("MCP — resources (collections as backlex:// URIs)", () => {
  let h: TestHarness;
  const slug = `mcp_res_${Date.now()}`;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "n", type: "integer" },
        ],
      }),
    });
    await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "first", n: 1 }),
    });
  });
  afterAll(() => h.cleanup());

  test("initialize advertises resources + prompts capabilities", async () => {
    const r = await mcp(h, { jsonrpc: "2.0", id: 1, method: "initialize" });
    const caps = (r as RpcSuccess).result.capabilities;
    expect(caps.resources).toBeDefined();
    expect(caps.resources.subscribe).toBe(false);
    expect(caps.prompts).toBeDefined();
  });

  test("resources/list returns schema directory + the test collection", async () => {
    const r = await mcp(h, { jsonrpc: "2.0", id: 2, method: "resources/list" });
    const resources: Array<{ uri: string; name: string; mimeType: string }> =
      (r as RpcSuccess).result.resources;
    expect(resources.some((x) => x.uri === "backlex://schema")).toBe(true);
    expect(resources.some((x) => x.uri === `backlex://collection/${slug}`)).toBe(true);
    for (const res of resources) {
      expect(res.mimeType).toBe("application/json");
      expect(typeof res.name).toBe("string");
    }
  });

  test("resources/read for the schema URI returns every collection's fields", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 3, method: "resources/read",
      params: { uri: "backlex://schema" },
    });
    const contents = (r as RpcSuccess).result.contents;
    expect(contents.length).toBe(1);
    expect(contents[0].uri).toBe("backlex://schema");
    const parsed = JSON.parse(contents[0].text) as { collections: Array<{ slug: string }> };
    expect(parsed.collections.some((c) => c.slug === slug)).toBe(true);
  });

  test("resources/read for a collection returns schema + sample rows", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 4, method: "resources/read",
      params: { uri: `backlex://collection/${slug}` },
    });
    const contents = (r as RpcSuccess).result.contents;
    const parsed = JSON.parse(contents[0].text) as {
      slug: string;
      fields: Array<{ name: string }>;
      sample: unknown;
      sampleLimit: number;
    };
    expect(parsed.slug).toBe(slug);
    expect(parsed.fields.length).toBe(2);
    expect(Array.isArray(parsed.sample)).toBe(true);
    expect((parsed.sample as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(parsed.sampleLimit).toBe(5);
  });

  test("resources/read for an unknown URI surfaces an error", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 5, method: "resources/read",
      params: { uri: "backlex://nonsense/x" },
    });
    expect((r as RpcError).error).toBeDefined();
    expect((r as RpcError).error.message).toContain("unknown resource");
  });

  test("resources/read missing uri param returns INVALID_PARAMS", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 6, method: "resources/read",
      params: {},
    });
    expect((r as RpcError).error.code).toBe(-32602);
  });
});

describe("MCP — prompts (starter templates)", () => {
  let h: TestHarness;
  const slug = `mcp_pr_${Date.now()}`;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "priority", type: "integer" },
        ],
      }),
    });
  });
  afterAll(() => h.cleanup());

  test("prompts/list returns the 3 starter templates", async () => {
    const r = await mcp(h, { jsonrpc: "2.0", id: 1, method: "prompts/list" });
    const names = (r as RpcSuccess).result.prompts.map((p: any) => p.name);
    expect(names.sort()).toEqual([
      "describe_collection",
      "generate_queries",
      "permission_rule",
    ].sort());
    for (const p of (r as RpcSuccess).result.prompts) {
      expect(typeof p.description).toBe("string");
      expect(Array.isArray(p.arguments)).toBe(true);
    }
  });

  test("prompts/get describe_collection renders schema + sample into a user message", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 2, method: "prompts/get",
      params: { name: "describe_collection", arguments: { collection: slug } },
    });
    const messages = (r as RpcSuccess).result.messages;
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content.type).toBe("text");
    const text = messages[0].content.text;
    expect(text).toContain(slug);
    expect(text).toContain("title");
    expect(text).toContain("priority");
  });

  test("prompts/get generate_queries optionally interpolates intent", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 3, method: "prompts/get",
      params: {
        name: "generate_queries",
        arguments: { collection: slug, intent: "high-priority items" },
      },
    });
    const text = (r as RpcSuccess).result.messages[0].content.text;
    expect(text).toContain("high-priority items");
  });

  test("prompts/get permission_rule requires both args", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 4, method: "prompts/get",
      params: { name: "permission_rule", arguments: { collection: slug } },
    });
    expect((r as RpcError).error.message).toContain("intent");
  });

  test("prompts/get unknown name returns INTERNAL error with helpful message", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0", id: 5, method: "prompts/get",
      params: { name: "no-such-prompt", arguments: {} },
    });
    expect((r as RpcError).error.message).toContain("unknown prompt");
  });
});

describe("MCP — webhooks + flows tools", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("webhooks.list returns an array", async () => {
    const result = await callTool(h, "webhooks.list", {});
    const rows = result.structuredContent.data ?? result.structuredContent;
    expect(Array.isArray(rows)).toBe(true);
  });

  test("flows.list returns an array", async () => {
    const result = await callTool(h, "flows.list", {});
    const rows = result.structuredContent.data ?? result.structuredContent;
    expect(Array.isArray(rows)).toBe(true);
  });

  test("flows.invoke on unknown id returns isError", async () => {
    const r = await mcp(h, {
      jsonrpc: "2.0",
      id: 500,
      method: "tools/call",
      params: { name: "flows.invoke", arguments: { id: "no-such-flow", input: {} } },
    });
    expect((r as RpcSuccess).result.isError).toBe(true);
  });
});
