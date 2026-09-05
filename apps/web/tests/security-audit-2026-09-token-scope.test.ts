/**
 * Regression gates for the 2026-09 pre-production audit, phase 6:
 * **a credential is only good for the resource it was issued for, and a token
 * only speaks for the session it names.**
 *
 * Two findings, one subject — the gap between "this credential verifies" and
 * "this credential may be used HERE, as THIS person".
 *
 * ── finding 1: an MCP OAuth token was a full API credential ─────────────────
 *
 * `sessionMiddleware` resolved a better-auth `mcp`-plugin access token into a
 * complete platform-plane identity and then read its `scopes` exactly once, to
 * set `apiKeyMcpReadOnly` — a flag `mcp/guards.ts` consumes and nothing else
 * does. So the scope existed only inside the MCP dispatcher. Measured against
 * the real app before the fix, a token granted `openid mcp:read` was refused
 * `collections.insert` over `/mcp` and, in the same second, took `201` from
 * `POST /api/items/<slug>`, `201` from `POST /api/collections` and `200` from
 * `POST /api/admin/db/sql/run` — arbitrary SQL. Dynamic client registration is
 * deliberately open for the MCP flow, so one consent click was the whole
 * precondition.
 *
 * `middleware/credential-scope.ts` refuses the credential anywhere that is not
 * an MCP mount. The half of this block that matters as much as the refusals is
 * that MCP ITSELF still works: its tools do their work by sub-fetching this
 * same Hono app on `/api/...` paths carrying the caller's `Authorization`, so a
 * naive path check would have taken the entire MCP surface down for OAuth
 * clients. A spec that only asserted 403s would have called that a pass.
 *
 * ── finding 4: an access token's `sub`/`tid` were self-asserted ─────────────
 *
 * The app-plane access JWT carries `sub`, `tid` and `sid`. Only `sid` was
 * checked, and only for liveness — `plane`, `userId` and `appSessionTenantId`
 * were then assigned straight from the claims, and `tenantMiddleware` pins the
 * request to `auth.appSessionTenantId` without re-deriving it. A token whose
 * `sid` named the attacker's OWN live session while its `sub`/`tid` named
 * somebody in another workspace passed every check on that path, and revoking
 * the VICTIM'S sessions did nothing because the token rode a session the
 * attacker still owned. `middleware/session.ts::appSessionOwner` now returns
 * who the row belongs to and all three claims must agree with it.
 *
 * The forgery below is minted with `signAccessToken` against the harness env,
 * which is the honest model of the threat: this is the damage a token-forging
 * primitive does, not a hole you can reach through the HTTP API. Phase 1 of
 * this audit found one such primitive.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { signAccessToken } from "../src/server/lib/jwt";
import * as mounts from "../src/server/mcp/mounts";

const APP_URL = "http://localhost:5173";
const CALLBACK = "http://localhost:9999/callback";
const JSON_HEADERS = { "Content-Type": "application/json" };
const SLUG = "default";

// ---------------------------------------------------------------------------
// MCP OAuth: register a client, consent, exchange a code for a bearer.
// ---------------------------------------------------------------------------

const b64url = (buf: ArrayBuffer): string => Buffer.from(buf).toString("base64url");

const pkcePair = async (): Promise<{ verifier: string; challenge: string }> => {
  const verifier = b64url(
    crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer,
  );
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
};

/** A request with NO cookie jar — the OAuth client is not the browser that
 *  consented, and the token endpoint must not be answered by a session. */
const rawFetch = (h: TestHarness, path: string, init: RequestInit = {}) =>
  h.app.fetch(new Request(`${APP_URL}${path}`, init));

const registerClient = async (h: TestHarness): Promise<string> => {
  const res = await rawFetch(h, "/api/auth/mcp/register", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      client_name: "audit-faz6",
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  expect(res.status, "dynamic registration is open for the MCP flow").toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
};

/** Walk authorize → login bounce → consent screen → accept, and return the
 *  authorization code. Uses the harness jar, i.e. the signed-in operator. */
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
  const first = await h.fetch(`/api/auth/mcp/authorize?${q}`, { redirect: "manual" });
  const bounced = new URL(first.headers.get("location") ?? "", APP_URL);
  const second = await h.fetch(`${bounced.pathname}?${bounced.searchParams}`, {
    redirect: "manual",
  });
  const consentUrl = new URL(second.headers.get("location") ?? "", APP_URL);
  const consentCode = consentUrl.searchParams.get("consent_code");
  const accept = await h.fetch("/api/auth/oauth2/consent", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ accept: true, consent_code: consentCode }),
  });
  const { redirectURI } = (await accept.json()) as { redirectURI: string };
  const code = new URL(redirectURI).searchParams.get("code");
  if (!code) throw new Error(`no authorization code in ${redirectURI}`);
  return code;
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
  expect(res.status, "code → access token").toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
};

const tokenFor = async (h: TestHarness, clientId: string, scope: string) => {
  const p = await pkcePair();
  return exchangeCode(
    h,
    clientId,
    await obtainCode(h, clientId, scope, p.challenge),
    p.verifier,
  );
};

const bearer = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

const rpc = (h: TestHarness, token: string, mount: string, body: unknown) =>
  rawFetch(h, mount, { method: "POST", headers: bearer(token), body: JSON.stringify(body) });

const errorOf = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error?: { code?: string; message?: string } };
  return `${body.error?.code ?? "?"}: ${body.error?.message ?? "?"}`;
};

describe("faz6: an MCP OAuth token is refused off the MCP mounts", () => {
  let h: TestHarness;
  let readToken: string;
  let writeToken: string;
  let bareToken: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const clientId = await registerClient(h);
    readToken = await tokenFor(h, clientId, "openid mcp:read");
    writeToken = await tokenFor(h, clientId, "openid mcp:read mcp:write");
    // A grant that names neither MCP scope. Before the gate this was a FULL
    // read credential on the MCP surface — the advertised scopes were optional
    // decoration on the way in.
    bareToken = await tokenFor(h, clientId, "openid profile");

    // The collection the write paths below target. Created with the OPERATOR'S
    // cookie, so a later 403 is about the credential and not about the schema.
    const made = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "Faz6 Notes",
        slug: "faz6_notes",
        fields: [{ name: "title", type: "text" }],
      }),
    });
    expect(made.status, "seed the target collection as the operator").toBe(201);
  });
  afterAll(() => h.cleanup());

  // Each of these took a 2xx before the fix. `POST /api/admin/db/sql/run` is
  // the one to read twice: it executes arbitrary SQL against the instance DB.
  test.each([
    ["GET", "/api/me", undefined],
    ["POST", "/api/collections", { name: "X", slug: "x_ff", fields: [] }],
    ["POST", "/api/items/faz6_notes", { title: "written-by-an-mcp-token" }],
    ["POST", "/api/admin/db/sql/run", { sql: "select 1 as x" }],
    ["POST", "/api/graphql", { query: "{ __typename }" }],
  ] as const)("REST %s %s is refused", async (method, path, body) => {
    const res = await rawFetch(h, path, {
      method,
      headers: bearer(readToken),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(res.status, `${method} ${path}`).toBe(403);
    expect(await errorOf(res)).toContain("scoped to the MCP endpoint");
  });

  test("a write refused off /mcp really did not happen", async () => {
    // `silent success is the house bug`: a 403 that had already written the
    // row would still turn this block green. Read it back.
    const rows = await h.fetch("/api/items/faz6_notes");
    expect(rows.status).toBe(200);
    const { data } = (await rows.json()) as { data: Array<{ title?: string }> };
    expect(data.some((r) => r.title === "written-by-an-mcp-token")).toBe(false);
  });

  test("the MCP surface itself still works — tools sub-fetch the same app", async () => {
    // THE test of this block. `collections.insert` re-enters the middleware
    // stack as `POST /api/items/faz6_notes`, which the case above just proved
    // is refused for this credential. It must nevertheless succeed here,
    // because the gate exempts requests THIS process issued (object identity
    // on the `Request`, unforgeable from the wire).
    const res = await rpc(h, writeToken, mounts.MCP_TENANT_MOUNT, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "collections.insert",
        arguments: { collection: "faz6_notes", data: { title: "via-mcp-write" } },
      },
    });
    expect(res.status, "POST /mcp collections.insert").toBe(200);
    const text = await res.text();
    expect(text).not.toContain("scoped to the MCP endpoint");
    expect(text).toContain("via-mcp-write");
  });

  test("read-only stays read-only ON the mount", async () => {
    const listed = await rpc(h, readToken, mounts.MCP_TENANT_MOUNT, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(listed.status, "an mcp:read grant may list tools").toBe(200);

    const wrote = await rpc(h, readToken, mounts.MCP_TENANT_MOUNT, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "collections.insert",
        arguments: { collection: "faz6_notes", data: { title: "nope" } },
      },
    });
    // The MCP guard's own refusal, unchanged by this phase — asserted so the
    // block cannot pass by the credential-scope gate refusing everything.
    expect(await wrote.text()).toMatch(/read-only|read only|not permitted|forbidden/i);
  });

  test("a grant naming neither MCP scope no longer reaches the resource", async () => {
    const res = await rpc(h, bareToken, mounts.MCP_TENANT_MOUNT, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
    });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain("no `mcp:read` or `mcp:write` scope");
  });

  test("the resource the token names is the one the gate enforces", async () => {
    // The whole design rests on the server ALREADY saying what this credential
    // is for. If this ever stops being `<APP_URL>/mcp`, refusing the token
    // elsewhere stops being the server's own claim and becomes our opinion.
    const res = await rawFetch(h, "/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { resource: string };
    expect(meta.resource).toBe(`${APP_URL}${mounts.MCP_TENANT_MOUNT}`);
  });

  test("discovery still answers a client that kept its bearer attached", async () => {
    // These documents are public and answer without any credential, so a 403
    // here would guard nothing and break an ordinary client: the endpoint that
    // TELLS it which resource its token is for would start refusing the token.
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]) {
      const withBearer = await rawFetch(h, path, {
        headers: { authorization: `Bearer ${readToken}` },
      });
      expect(withBearer.status, `${path} with the bearer attached`).toBe(200);
    }
  });

  test("the token's own issuer is still reachable", async () => {
    // `/api/auth/*` is exempt because it MINTED this credential. Refusing it
    // would break the flow the gate protects.
    //
    // Asserted as "not the gate's refusal" rather than as a 200 on purpose:
    // the discovery document advertises
    // `userinfo_endpoint: <APP_URL>/api/auth/mcp/userinfo` and this build
    // answers it with a 404 — a real gap, and one that predates this phase.
    // What matters here is that the request reaches better-auth at all, which
    // a 404 proves and a 403 would disprove.
    const res = await rawFetch(h, "/api/auth/mcp/userinfo", {
      headers: { authorization: `Bearer ${readToken}` },
    });
    expect(res.status, "the gate did not intercept the issuer").not.toBe(403);
  });

  test("every other credential shape is untouched", async () => {
    // The control that says this gate has exactly one subject. Same route, same
    // instant, cookie session instead of the bearer.
    const res = await h.fetch("/api/me");
    expect(res.status, "the operator's cookie session on /api/me").toBe(200);

    const key = await h.fetch("/api/api-keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "faz6-control" }),
    });
    expect(key.status).toBe(201);
    const { data } = (await key.json()) as { data: { secret: string } };
    const withKey = await rawFetch(h, "/api/me", {
      headers: { authorization: `Bearer ${data.secret}` },
    });
    expect(withKey.status, "a `pak_` API key on /api/me").toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe("faz6: the MCP mount list is derived, not restated", () => {
  /**
   * `mcp/mounts.ts` is only worth having if it cannot fall out of date, and a
   * hand-written list is exactly the shape that covered 46 of 131 tables in
   * phase 2 of this audit. So the check reads `app.ts` and asks it.
   *
   * A third MCP router mounted at a string literal fails here. A third mounted
   * at a NEW constant fails too, unless that constant is also added to
   * `MCP_MOUNT_PREFIXES` — which is what makes the guard in
   * `middleware/credential-scope.ts` cover it.
   */
  const source = readFileSync(join(import.meta.dir, "../src/server/app.ts"), "utf8");

  test("app.ts mounts the MCP routers only through mounts.ts constants", () => {
    const found = [...source.matchAll(/app\.route\(\s*([^,]+?)\s*,\s*([^)]*?McpRoutes\()/g)].map(
      (m) => (m[1] ?? "").trim(),
    );
    expect(found.length, "app.ts still mounts MCP routers").toBeGreaterThan(0);

    for (const arg of found) {
      expect(
        /^[A-Z][A-Z0-9_]*$/.test(arg),
        `MCP mount \`${arg}\` is a literal — declare it in mcp/mounts.ts instead`,
      ).toBe(true);
      const value = (mounts as unknown as Record<string, unknown>)[arg];
      expect(typeof value, `mcp/mounts.ts exports \`${arg}\``).toBe("string");
      expect(
        mounts.MCP_MOUNT_PREFIXES as readonly string[],
        `\`${arg}\` is listed in MCP_MOUNT_PREFIXES`,
      ).toContain(value as string);
    }

    expect(
      new Set(found).size,
      "MCP_MOUNT_PREFIXES has an entry per mount and no stale extras",
    ).toBe(mounts.MCP_MOUNT_PREFIXES.length);
  });

  test("the prefix test has a boundary", () => {
    expect(mounts.isMcpMountPath("/mcp")).toBe(true);
    expect(mounts.isMcpMountPath("/mcp/anything")).toBe(true);
    expect(mounts.isMcpMountPath("/api/admin/mcp")).toBe(true);
    // The reason `startsWith` alone is not enough.
    expect(mounts.isMcpMountPath("/mcpanel")).toBe(false);
    expect(mounts.isMcpMountPath("/api/items/mcp")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("faz6: an access token speaks only for the session it names", () => {
  const PASSWORD = "correct-horse-battery-app";
  let h: TestHarness;
  let victim: { id: string; sid: string; tenantId: string; email: string };
  let attacker: { id: string; sid: string; tenantId: string; email: string };

  /**
   * `h.app.request(...)` bypasses the harness's synthetic-client-IP proxy: that
   * Proxy only traps `fetch`, and Hono's `request` helper holds the original.
   * The auth rate limiter keys on IP, allows five sign-ups a minute, and keeps
   * its window in MODULE-level state shared by every harness in one bun-test
   * worker — so without this header these app-plane sign-ups land in the same
   * bucket as every other spec's, and the file passes alone and 429s in
   * company. `TestHarness.clientIp` is exposed for exactly this.
   */
  const appFetch = (path: string, init: RequestInit = {}) =>
    h.app.request(path, {
      ...init,
      headers: { ...(init.headers ?? {}), "X-Forwarded-For": h.clientIp },
    });

  /** Sign up on the app plane and read back the identity the session carries.
   *  `sid`/`sub`/`tid` come off the minted token rather than being guessed —
   *  which claim names which row is the whole subject here. */
  const enrol = async (email: string) => {
    const res = await appFetch(`/api/t/${SLUG}/auth/sign-up/email`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password: PASSWORD, name: email }),
    });
    if (!res.ok) throw new Error(`app sign-up ${email}: ${res.status} ${await res.text()}`);
    const { token } = (await res.json()) as { token: string };
    const refreshed = await appFetch(`/api/t/${SLUG}/auth/token/refresh`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ refreshToken: token }),
    });
    expect(refreshed.status, `access token for ${email}`).toBe(200);
    const { accessToken } = (await refreshed.json()) as { accessToken: string };
    const payload = accessToken.split(".")[1];
    if (!payload) throw new Error("not a JWT");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub: string;
      tid: string;
      sid: string;
    };
    return { id: claims.sub, sid: claims.sid, tenantId: claims.tid, email, accessToken };
  };

  const asEndUser = (token: string) =>
    appFetch(`/api/t/${SLUG}/orgs`, {
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    victim = await enrol(`victim-${Date.now()}@example.test`);
    attacker = await enrol(`attacker-${Date.now()}@example.test`);
  });
  afterAll(() => h.cleanup());

  test("a well-formed token still works (the control)", async () => {
    const { token } = await signAccessToken(h.env, {
      sub: attacker.id,
      tid: attacker.tenantId,
      sid: attacker.sid,
      email: attacker.email,
    });
    expect((await asEndUser(token)).status, "the attacker as themselves").toBe(200);
  });

  test("the attacker's own live session cannot carry the victim's identity", async () => {
    const { token } = await signAccessToken(h.env, {
      sub: victim.id,
      tid: victim.tenantId,
      // ...on a session row that belongs to somebody else and is very much
      // alive, so the liveness-only check this replaced said yes.
      sid: attacker.sid,
      email: victim.email,
    });
    const res = await asEndUser(token);
    expect(res.status, "sub does not match the session's owner").toBe(401);
  });

  test("a tenant claim that the session row does not agree with is refused", async () => {
    const other = await h.fetch("/api/tenants", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: `Faz6 Other ${Date.now()}` }),
    });
    expect(other.status).toBe(201);
    const { data } = (await other.json()) as { data: { id: string } };

    const { token } = await signAccessToken(h.env, {
      sub: attacker.id,
      tid: data.id,
      sid: attacker.sid,
      email: attacker.email,
    });
    expect((await asEndUser(token)).status, "tid does not match the session row").toBe(401);
  });

  test("a session id nothing backs is still refused", async () => {
    const { token } = await signAccessToken(h.env, {
      sub: attacker.id,
      tid: attacker.tenantId,
      sid: crypto.randomUUID(),
      email: attacker.email,
    });
    expect((await asEndUser(token)).status).toBe(401);
  });
});
