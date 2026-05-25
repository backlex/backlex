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
    expect(result.serverInfo.name).toBe("workeros");
    expect(result.capabilities.tools).toBeDefined();
  });

  test("tools/list returns the 13-tool roster", async () => {
    const r = await mcp(h, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(isErr(r)).toBe(false);
    const names = (r as RpcSuccess).result.tools.map((t: any) => t.name);
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
    expect(names.length).toBe(13);
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
    expect((r as RpcSuccess).result.tools.length).toBe(13);
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
    const create = await h.fetch("/api/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `mcp-test-${Date.now()}` }),
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
    expect((rpc as RpcSuccess).result.tools.length).toBe(13);
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
