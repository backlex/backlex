/**
 * MCP OAuth (better-auth `mcp` plugin) — the flow hosted Claude drives:
 * discovery → dynamic client registration → PKCE authorize (with the
 * forced-consent gate) → consent accept → token exchange → bearer-authed
 * JSON-RPC against /mcp. Also pins the guard mapping (no `mcp:write` scope →
 * read-only), the expiry check the plugin itself skips, and the RFC 9728
 * WWW-Authenticate challenge unauthenticated clients bootstrap from.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const APP_URL = "http://localhost:5173";
const CALLBACK = "http://localhost:9999/callback";

const b64url = (buf: ArrayBuffer): string => Buffer.from(buf).toString("base64url");

const pkcePair = async () => {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
};

/** Raw app fetch WITHOUT the harness cookie jar — bearer-only identity. */
const rawFetch = (h: TestHarness, path: string, init: RequestInit = {}) =>
  h.app.fetch(new Request(`${APP_URL}${path}`, init));

const registerClient = async (h: TestHarness): Promise<string> => {
  const res = await rawFetch(h, "/api/auth/mcp/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test-hosted-claude",
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  expect(body.client_id).toBeTruthy();
  return body.client_id;
};

/** Drive authorize → forced consent → accept → code for the harness admin. */
const obtainCode = async (
  h: TestHarness,
  clientId: string,
  scope: string,
  challenge: string,
): Promise<string> => {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: CALLBACK,
    response_type: "code",
    scope,
    state: "st4te",
    code_challenge: challenge,
    code_challenge_method: "s256",
  });
  // First hit: the consent gate must bounce us back with prompt=consent.
  const first = await h.fetch(`/api/auth/mcp/authorize?${q}`, { redirect: "manual" });
  expect(first.status).toBe(302);
  const bounced = new URL(first.headers.get("location")!, APP_URL);
  expect(bounced.searchParams.get("prompt")).toBe("consent");
  // Second hit (prompt=consent): plugin redirects to the consent page.
  const second = await h.fetch(
    `${bounced.pathname}?${bounced.searchParams}`,
    { redirect: "manual" },
  );
  expect(second.status).toBe(302);
  const consentUrl = new URL(second.headers.get("location")!, APP_URL);
  expect(consentUrl.pathname).toBe("/oauth/consent");
  const consentCode = consentUrl.searchParams.get("consent_code");
  expect(consentCode).toBeTruthy();
  // Accept — the endpoint answers with the client redirect carrying the code.
  const accept = await h.fetch("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accept: true, consent_code: consentCode }),
  });
  expect(accept.status).toBe(200);
  const { redirectURI } = (await accept.json()) as { redirectURI: string };
  const cb = new URL(redirectURI);
  expect(`${cb.origin}${cb.pathname}`).toBe(CALLBACK);
  expect(cb.searchParams.get("state")).toBe("st4te");
  return cb.searchParams.get("code")!;
};

const exchangeCode = async (
  h: TestHarness,
  clientId: string,
  code: string,
  verifier: string,
): Promise<string> => {
  const res = await rawFetch(h, "/api/auth/mcp/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { access_token: string; token_type: string };
  expect(body.access_token).toBeTruthy();
  return body.access_token;
};

const mcpRpc = (h: TestHarness, token: string | null, body: unknown) =>
  rawFetch(h, "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

describe("MCP OAuth — discovery + challenge", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("root authorization-server metadata advertises the plugin endpoints", async () => {
    const res = await rawFetch(h, "/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, string>;
    expect(meta.authorization_endpoint).toContain("/api/auth/mcp/authorize");
    expect(meta.token_endpoint).toContain("/api/auth/mcp/token");
    expect(meta.registration_endpoint).toContain("/api/auth/mcp/register");
    expect(meta.code_challenge_methods_supported).toContain("S256");
    // Custom scopes must be ADVERTISED, not just accepted — clients request
    // what discovery lists, and without mcp:write every token is read-only.
    expect(meta.scopes_supported).toContain("mcp:write");
  });

  test("root protected-resource metadata names the /mcp resource", async () => {
    const res = await rawFetch(h, "/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { resource: string };
    expect(meta.resource).toBe(`${APP_URL}/mcp`);
    // Path-suffixed variant (RFC 9728) answers identically.
    const suffixed = await rawFetch(h, "/.well-known/oauth-protected-resource/mcp");
    expect(suffixed.status).toBe(200);
  });

  test("unauthenticated POST /mcp answers 401 + WWW-Authenticate challenge", async () => {
    const res = await mcpRpc(h, null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain("/.well-known/oauth-protected-resource");
  });
});

describe("MCP OAuth — full PKCE flow against /mcp", () => {
  let h: TestHarness;
  let clientId: string;
  let writeToken: string;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    clientId = await registerClient(h);
    const { verifier, challenge } = await pkcePair();
    const code = await obtainCode(h, clientId, "openid mcp:read mcp:write", challenge);
    writeToken = await exchangeCode(h, clientId, code, verifier);
  });
  afterAll(() => h.cleanup());

  test("bearer token lists MCP tools", async () => {
    const res = await mcpRpc(h, writeToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { tools?: unknown[] } };
    expect(Array.isArray(body.result?.tools)).toBe(true);
    expect((body.result!.tools!).length).toBeGreaterThan(10);
  });

  test("re-authorize after consent skips the consent screen", async () => {
    const { challenge } = await pkcePair();
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: CALLBACK,
      response_type: "code",
      scope: "openid mcp:read mcp:write",
      state: "again",
      code_challenge: challenge,
      code_challenge_method: "s256",
    });
    const res = await h.fetch(`/api/auth/mcp/authorize?${q}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    // Straight to the client callback with a fresh code — no consent bounce.
    const loc = new URL(res.headers.get("location")!, APP_URL);
    expect(`${loc.origin}${loc.pathname}`).toBe(CALLBACK);
    expect(loc.searchParams.get("code")).toBeTruthy();
  });

  test("expired access token is rejected (plugin skips this check — we don't)", async () => {
    const db = new Database(h.env.SQLITE_PATH!);
    db.exec(
      `UPDATE oauth_access_tokens SET access_token_expires_at = 1000 WHERE access_token = '${writeToken}'`,
    );
    db.close();
    const res = await mcpRpc(h, writeToken, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });
    expect(res.status).toBe(401);
  });
});

describe("MCP OAuth — scope → guard mapping", () => {
  let h: TestHarness;
  let readToken: string;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const clientId = await registerClient(h);
    const { verifier, challenge } = await pkcePair();
    const code = await obtainCode(h, clientId, "openid mcp:read", challenge);
    readToken = await exchangeCode(h, clientId, code, verifier);
  });
  afterAll(() => h.cleanup());

  test("token without mcp:write scope still reads", async () => {
    const res = await mcpRpc(h, readToken, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "schema.list_collections", arguments: {} },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { isError?: boolean } };
    expect(body.result?.isError ?? false).toBe(false);
  });

  test("token without mcp:write scope is refused write tools", async () => {
    const res = await mcpRpc(h, readToken, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "collections.insert",
        arguments: { collection: "whatever", data: { a: 1 } },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.map((c) => c.text ?? "").join(" ") ?? "";
    expect(text).toMatch(/read.?only/i);
  });
});
