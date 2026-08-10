/**
 * The OAuth client registry, and the parts of the authorization server that
 * were unobservable before it.
 *
 * The assertions that matter are about OPERATING the server rather than about
 * the protocol, which the MCP suite already covers:
 *   - a public client is issued no secret, and a confidential one's is shown
 *     exactly once;
 *   - disabling keeps the history, deleting takes it away;
 *   - revoking a grant kills the TOKENS, not just the consent row;
 *   - both discovery names resolve to the same document.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;

const JSON_HEADERS = { "content-type": "application/json" };
const BASE = "/api/admin/oauth-clients";

const register = (over: Record<string, unknown> = {}) =>
  h.fetch(BASE, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      name: "Portal",
      redirectUrls: ["https://portal.example.com/callback"],
      ...over,
    }),
  });

const anon = (path: string, init?: RequestInit) =>
  h.app.request(
    path,
    { ...init, headers: { origin: "http://localhost:5173" } } as RequestInit,
    h.env,
  );

beforeEach(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
});
afterEach(() => h.cleanup());

describe("discovery", () => {
  test("both well-known names resolve, and to the same document", async () => {
    // An OIDC library looks for `openid-configuration`; an OAuth 2.1 client
    // looks for `oauth-authorization-server`. Serving only the second meant a
    // library that speaks OIDC could not discover this server at all.
    const oidc = await anon("/.well-known/openid-configuration");
    const oauth = await anon("/.well-known/oauth-authorization-server");
    expect(oidc.status).toBe(200);
    expect(oauth.status).toBe(200);
    expect(await oidc.text()).toBe(await oauth.text());
  });

  test("discovery is public and CORS-open — a browser client reads it", async () => {
    const res = await anon("/.well-known/openid-configuration");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("the registry", () => {
  test("a public client is issued no secret", async () => {
    const res = await register();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { type: string }; clientSecret: string | null };
    expect(body.data.type).toBe("public");
    // PKCE protects it; a secret shipped in a browser is not a secret, and
    // issuing one would only encourage somebody to rely on it.
    expect(body.clientSecret).toBeNull();
  });

  test("a confidential client's secret is shown once and never listed", async () => {
    const body = (await (await register({ type: "confidential" })).json()) as {
      data: { clientId: string };
      clientSecret: string;
    };
    expect(body.clientSecret.length).toBeGreaterThan(20);
    const listed = await (await h.fetch(BASE)).text();
    expect(listed).not.toContain(body.clientSecret);
  });

  test("an http redirect URI is refused unless it is loopback", async () => {
    // The authorization code is delivered TO this URL.
    expect((await register({ redirectUrls: ["http://portal.example.com/cb"] })).status).toBe(422);
    // …and a native app's local callback genuinely is http.
    expect((await register({ redirectUrls: ["http://127.0.0.1:8976/cb"] })).status).toBe(201);
  });

  test("a redirect URI with a fragment is refused", async () => {
    // A fragment never reaches the server, so it would silently not match.
    const res = await register({ redirectUrls: ["https://portal.example.com/cb#/done"] });
    expect(res.status).toBe(422);
  });

  test("an operator-created client is marked differently from a self-registered one", async () => {
    await register();
    const listed = (await (await h.fetch(BASE)).json()) as {
      data: Array<{ dynamic: boolean }>;
      dynamicRegistration: boolean;
    };
    expect(listed.data[0]!.dynamic).toBe(false);
    // On by default — the hosted MCP connectors register dynamically, and
    // defaulting it off would break the one client everybody uses.
    expect(listed.dynamicRegistration).toBe(true);
  });

  test("disabling keeps the row; deleting removes it", async () => {
    const made = (await (await register()).json()) as { data: { clientId: string } };
    const id = made.data.clientId;

    expect(
      (
        await h.fetch(`${BASE}/${id}`, {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ disabled: true }),
        })
      ).status,
    ).toBe(200);
    let rows = (await (await h.fetch(BASE)).json()) as { data: Array<{ disabled: boolean }> };
    expect(rows.data[0]!.disabled).toBe(true);

    expect((await h.fetch(`${BASE}/${id}`, { method: "DELETE" })).status).toBe(200);
    rows = (await (await h.fetch(BASE)).json()) as { data: unknown[] };
    expect(rows.data.length).toBe(0);
  });

  test("the registry is admin-only", async () => {
    expect((await anon(BASE)).status).toBeGreaterThanOrEqual(400);
    expect((await anon(BASE, { method: "POST" })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("grants", () => {
  /** A consent with a live token under it, written directly — the OAuth dance
   *  itself is the MCP suite's subject; this is about taking the grant back. */
  const seedGrant = (clientId: string, userId: string) => {
    const now = Date.now();
    client
      .query(
        `insert into oauth_consents (id, client_id, user_id, scopes, consent_given, created_at, updated_at)
         values (?,?,?,?,1,?,?)`,
      )
      .run(crypto.randomUUID(), clientId, userId, "openid profile", now, now);
    client
      .query(
        `insert into oauth_access_tokens
           (id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at,
            client_id, user_id, scopes, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        crypto.randomUUID(),
        `at_${crypto.randomUUID()}`,
        `rt_${crypto.randomUUID()}`,
        now + 3_600_000,
        now + 86_400_000,
        clientId,
        userId,
        "openid profile",
        now,
        now,
      );
  };

  test("revoking a grant kills the tokens, not just the consent", async () => {
    const made = (await (await register()).json()) as { data: { clientId: string } };
    const clientId = made.data.clientId;
    const userId = (
      client.query("select id from users limit 1").get() as { id: string }
    ).id;
    seedGrant(clientId, userId);

    const before = (await (await h.fetch(`${BASE}/grants`)).json()) as { data: unknown[] };
    expect(before.data.length).toBe(1);

    const res = await h.fetch(`${BASE}/grants/revoke`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ clientId, userId }),
    });
    expect(res.status).toBe(200);
    // The whole point: removing only the consent would leave the access token
    // working until it expired and the refresh token minting more.
    expect(((await res.json()) as { tokensRevoked: number }).tokensRevoked).toBe(1);
    const tokens = client
      .query("select count(*) as n from oauth_access_tokens where client_id = ?")
      .get(clientId) as { n: number };
    expect(tokens.n).toBe(0);
    const after = (await (await h.fetch(`${BASE}/grants`)).json()) as { data: unknown[] };
    expect(after.data.length).toBe(0);
  });

  test("grants can be listed for one user — an 'apps with access' screen", async () => {
    const made = (await (await register()).json()) as { data: { clientId: string } };
    const userId = (client.query("select id from users limit 1").get() as { id: string }).id;
    seedGrant(made.data.clientId, userId);
    const mine = (await (await h.fetch(`${BASE}/grants?userId=${userId}`)).json()) as {
      data: Array<{ clientName: string; scopes: string[] }>;
    };
    expect(mine.data[0]!.clientName).toBe("Portal");
    expect(mine.data[0]!.scopes).toEqual(["openid", "profile"]);

    const nobody = (await (await h.fetch(`${BASE}/grants?userId=someone-else`)).json()) as {
      data: unknown[];
    };
    expect(nobody.data.length).toBe(0);
  });

  test("deleting a client takes its grants and tokens with it", async () => {
    const made = (await (await register()).json()) as { data: { clientId: string } };
    const userId = (client.query("select id from users limit 1").get() as { id: string }).id;
    seedGrant(made.data.clientId, userId);
    await h.fetch(`${BASE}/${made.data.clientId}`, { method: "DELETE" });
    const rows = client
      .query("select count(*) as n from oauth_access_tokens where client_id = ?")
      .get(made.data.clientId) as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("dynamic registration can be closed", () => {
  test("with the switch off, the endpoint answers in the shape clients expect", async () => {
    h.cleanup();
    h = makeHarness({ OAUTH_DYNAMIC_REGISTRATION: "off" } as never);
    await seedAdmin(h);
    const res = await anon("/api/auth/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://x.example/cb"] }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    // RFC 7591's shape, not our JSON envelope — a client that gets ours
    // reports an unknown failure it cannot explain.
    expect(body.error).toBe("access_denied");
    const listed = (await (await h.fetch(BASE)).json()) as { dynamicRegistration: boolean };
    expect(listed.dynamicRegistration).toBe(false);
  });

  test("with it on (the default), the endpoint is not blocked by this gate", async () => {
    // Not asserting a 201 — the plugin has its own validation. The point is
    // that the gate does not stand in the way.
    const res = await anon("/api/auth/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://x.example/cb"] }),
    });
    expect(res.status).not.toBe(403);
  });
});
