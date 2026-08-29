/**
 * MCP `2026-07-28` conformance — the revision that deleted the handshake.
 *
 * The server is deliberately **dual-era**: a request that declares the new
 * revision gets the new result shape, and a request that declares nothing gets
 * byte-for-byte what it got before. Both halves are asserted here, because the
 * failure mode that matters is not "the new fields are missing" — it is "the
 * new fields leaked into a legacy client's result", which no amount of
 * new-era testing would catch.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const MODERN = "2026-07-28";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

/** POST one JSON-RPC message with full control over the transport headers. */
const post = async (
  h: TestHarness,
  body: Rpc,
  headers: Record<string, string> = {},
  path = "/mcp",
): Promise<{ status: number; body: any }> => {
  const res = await h.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** The same message a conforming `2026-07-28` client would send: version in
 *  `_meta`, version + method (+ name) mirrored into the standard headers. */
const modern = async (
  h: TestHarness,
  body: Rpc,
  extraHeaders: Record<string, string> = {},
  path = "/mcp",
) => {
  const params = (body.params ?? {}) as Record<string, unknown>;
  const name =
    body.method === "tools/call" || body.method === "prompts/get"
      ? params.name
      : body.method === "resources/read"
        ? params.uri
        : undefined;
  return post(
    h,
    {
      ...body,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "conformance-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    {
      "mcp-protocol-version": MODERN,
      "mcp-method": body.method,
      ...(typeof name === "string" ? { "mcp-name": name } : {}),
      ...extraHeaders,
    },
    path,
  );
};

describe("MCP 2026-07-28 — discovery", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("server/discover advertises the revisions we speak, newest first", async () => {
    const { status, body } = await modern(h, { jsonrpc: "2.0", id: 1, method: "server/discover" });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result.supportedVersions[0]).toBe(MODERN);
    expect(body.result.supportedVersions).toContain("2025-11-25");
    expect(body.result.capabilities.tools).toBeDefined();
    // Declared-empty, not omitted: "supports no extensions" and "predates the
    // field" are different answers.
    expect(body.result.capabilities.extensions).toEqual({});
    expect(typeof body.result.instructions).toBe("string");
  });

  test("server/discover carries resultType, serverInfo and public cache hints", async () => {
    const { body } = await modern(h, { jsonrpc: "2.0", id: 2, method: "server/discover" });
    expect(body.result.resultType).toBe("complete");
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("backlex");
    expect(body.result.ttlMs).toBeGreaterThan(0);
    // Identical for every caller, so a shared intermediary may keep one copy.
    expect(body.result.cacheScope).toBe("public");
  });

  test("server/discover answers the modern shape even to a caller that declared nothing", async () => {
    // A dual-era client probes with this before it knows what we are, so the
    // probe must not depend on already speaking the new revision.
    const { body } = await post(h, { jsonrpc: "2.0", id: 3, method: "server/discover" });
    expect(body.result.resultType).toBe("complete");
    expect(body.result.supportedVersions).toContain(MODERN);
  });
});

describe("MCP 2026-07-28 — result shape by era", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("a modern tools/list carries resultType, serverInfo and PRIVATE cache hints", async () => {
    const { body } = await modern(h, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(body.result.resultType).toBe("complete");
    expect(body.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "backlex",
      version: "0.0.1",
    });
    expect(body.result.ttlMs).toBeGreaterThan(0);
    // The catalog is narrowed by the caller's key + role allowlist. A shared
    // cache holding one copy would hand one caller's catalog to the next.
    expect(body.result.cacheScope).toBe("private");
  });

  test("a legacy tools/list is untouched — none of the new fields leak into it", async () => {
    const { body } = await post(h, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(Array.isArray(body.result.tools)).toBe(true);
    expect(body.result.resultType).toBeUndefined();
    expect(body.result.ttlMs).toBeUndefined();
    expect(body.result.cacheScope).toBeUndefined();
    expect(body.result._meta).toBeUndefined();
  });

  test("tools/list is in a deterministic order", async () => {
    const { body } = await modern(h, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names: string[] = body.result.tools.map((t: any) => t.name);
    expect(names.length).toBeGreaterThan(50);
    expect(names).toEqual([...names].sort());
  });

  test("prompts/list is public, resources/list is private", async () => {
    const prompts = await modern(h, { jsonrpc: "2.0", id: 3, method: "prompts/list" });
    expect(prompts.body.result.cacheScope).toBe("public");
    const resources = await modern(h, { jsonrpc: "2.0", id: 4, method: "resources/list" });
    expect(resources.body.result.cacheScope).toBe("private");
  });

  test("legacy initialize still negotiates a handshake-era revision", async () => {
    // The handshake does not exist in 2026-07-28, so answering it with that
    // version would send the client into `notifications/initialized` on a
    // revision that deleted the concept.
    const { body } = await post(h, { jsonrpc: "2.0", id: 5, method: "initialize" });
    expect(body.result.protocolVersion).toBe("2025-11-25");
    const asked = await post(h, {
      jsonrpc: "2.0",
      id: 6,
      method: "initialize",
      params: { protocolVersion: MODERN },
    });
    expect(asked.body.result.protocolVersion).toBe("2025-11-25");
  });
});

describe("MCP 2026-07-28 — version negotiation", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("an unsupported version is 400 + -32022 and lists what we do support", async () => {
    const { status, body } = await post(
      h,
      { jsonrpc: "2.0", id: 9, method: "tools/list" },
      { "mcp-protocol-version": "1900-01-01" },
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.requested).toBe("1900-01-01");
    expect(body.error.data.supported).toContain(MODERN);
    // Attributed to the request, not to `null` — the client is using this
    // answer to work out whether it is talking to a modern server at all.
    expect(body.id).toBe(9);
  });

  test("header and _meta disagreeing about the version is 400 + -32020", async () => {
    const { status, body } = await post(
      h,
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
      },
      { "mcp-protocol-version": "2025-11-25", "mcp-method": "tools/list" },
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32020);
  });

  test("_meta alone is enough to select the modern era", async () => {
    const { body } = await post(
      h,
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
      },
      { "mcp-protocol-version": MODERN, "mcp-method": "tools/list" },
    );
    expect(body.result.resultType).toBe("complete");
  });
});

describe("MCP 2026-07-28 — standard request headers", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("a modern request missing Mcp-Method is rejected", async () => {
    const { status, body } = await post(
      h,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
      },
      { "mcp-protocol-version": MODERN },
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32020);
    expect(body.error.message).toContain("Mcp-Method");
  });

  test("a modern tools/call missing Mcp-Name is rejected", async () => {
    const { status, body } = await post(
      h,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "schema-list_collections",
          arguments: {},
          _meta: { "io.modelcontextprotocol/protocolVersion": MODERN },
        },
      },
      { "mcp-protocol-version": MODERN, "mcp-method": "tools/call" },
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32020);
    expect(body.error.message).toContain("Mcp-Name");
  });

  test("Mcp-Name naming a different tool than the body is rejected", async () => {
    // The whole point of the mirrored headers: a gateway routing on the header
    // and a server executing the body must never be able to disagree.
    const { status, body } = await modern(
      h,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "schema-list_collections", arguments: {} },
      },
      { "mcp-name": "collections-delete" },
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32020);
  });

  test("a mismatched header is refused even from a legacy caller", async () => {
    // A legacy client never sends these, so a mismatch here is a broken proxy
    // or someone trying to split the router from the executor.
    const { status, body } = await post(
      h,
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      { "mcp-method": "tools/call" },
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32020);
  });

  test("a Base64-sentinel Mcp-Name is decoded before it is compared", async () => {
    const uri = "backlex://collection/ürünler";
    const encoded = Buffer.from(uri, "utf8").toString("base64");
    const { status, body } = await modern(
      h,
      { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri } },
      { "mcp-name": `=?base64?${encoded}?=` },
    );
    // The header matched, so this is NOT a transport rejection — it reaches
    // the dispatcher and fails there as an unknown resource instead.
    expect(status).toBe(200);
    expect(body.error.code).toBe(-32602);
  });

  test("a notification is exempt from the header requirement", async () => {
    const { status } = await post(
      h,
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
      },
      { "mcp-protocol-version": MODERN },
    );
    expect(status).toBe(202);
  });
});

describe("MCP 2026-07-28 — error codes", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("an unknown resource URI is -32602, not an internal error", async () => {
    const { body } = await modern(h, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "backlex://nope/whatever" },
    });
    expect(body.error.code).toBe(-32602);
  });

  test("an unknown method is HTTP 404 for a modern caller and 200 for a legacy one", async () => {
    const modernCall = await modern(h, { jsonrpc: "2.0", id: 2, method: "does/not_exist" });
    expect(modernCall.status).toBe(404);
    expect(modernCall.body.error.code).toBe(-32601);

    const legacyCall = await post(h, { jsonrpc: "2.0", id: 3, method: "does/not_exist" });
    expect(legacyCall.status).toBe(200);
    expect(legacyCall.body.error.code).toBe(-32601);
  });
});
