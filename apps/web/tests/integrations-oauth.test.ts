/**
 * OAuth connect flow for workspace integrations.
 *
 * The interesting assertions are all negative. An OAuth connection is a bearer
 * credential for someone else's Notion/Google/QuickBooks account, so the flow
 * has to survive a caller who controls the query string of the callback and
 * nothing else:
 *
 *   - a `state` that was not issued here, or was already used, or has expired
 *   - a valid `state` presented from a different workspace or a different admin
 *   - an attempt to write the token keys directly through the ordinary save
 *   - an ordinary save that omits them, which must not disconnect the account
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { OAUTH_ACCESS_TOKEN_KEY, OAUTH_REFRESH_TOKEN_KEY } from "@backlex/integrations";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BASE = "/api/admin/integrations";
const ACCESS = "notion-access-token-DO-NOT-LEAK";

let h: TestHarness;
let client: Database;

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Connect Notion with its OAuth client credentials but no tokens yet. */
const connectNotion = async (extra: Record<string, unknown> = {}) => {
  const res = await h.fetch(
    BASE,
    json({ kind: "notion", config: { clientId: "cid", clientSecret: "csecret", pageId: "page-1", ...extra } }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as any).data.id as string;
};

/** Pull the raw state row back out so a test can drive the callback. */
const pendingStates = () =>
  client.query("select * from integration_oauth_states").all() as {
    id: string;
    integration_id: string;
    tenant_id: string;
    user_id: string;
    redirect_uri: string;
    expires_at: number;
  }[];

/** Recover the raw `state` from an authorize URL. */
const stateOf = (url: string) => new URL(url).searchParams.get("state") as string;

const callback = (qs: string) => h.fetch(`${BASE}/oauth/callback?${qs}`, { redirect: "manual" });

/** Stand in for the provider's token endpoint. */
const mockToken = (body: unknown, status = 200) => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url.includes("api.notion.com/v1/oauth/token")) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return real(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
});
afterAll(() => h.cleanup());

describe("the catalog tells the UI which providers need OAuth", () => {
  test("notion is flagged, slack is not, and the redirect URI is server-derived", async () => {
    const body = (await (await h.fetch(`${BASE}/catalog`)).json()) as any;
    const byId = Object.fromEntries(body.data.providers.map((p: any) => [p.id, p]));
    expect(byId.notion.oauth).toBe(true);
    expect(byId.slack.oauth).toBe(false);
    // Computing this in the browser gets it wrong behind a proxy, and a wrong
    // value here is a registration the provider will reject at redirect time.
    expect(body.data.oauthRedirectUri).toEndWith("/api/admin/integrations/oauth/callback");
  });
});

describe("leg 1 — authorize", () => {
  test("the URL carries our state and the provider's own endpoint", async () => {
    const id = await connectNotion();
    const res = await h.fetch(`${BASE}/${id}/oauth/authorize`, { method: "POST" });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as any).data.url);

    expect(url.origin + url.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toEndWith("/api/admin/integrations/oauth/callback");
    expect(url.searchParams.get("state")).toBeTruthy();

    client.query("delete from integration_oauth_states").run();
  });

  test("the raw state is never stored — only its hash", async () => {
    const id = await connectNotion();
    const url = ((await (await h.fetch(`${BASE}/${id}/oauth/authorize`, { method: "POST" })).json()) as any).data.url;
    const state = stateOf(url);

    const rows = pendingStates();
    expect(rows).toHaveLength(1);
    // Someone with read access to the database must not be able to complete a
    // pending authorization, so the stored id has to be a one-way function of
    // the value that travels in the URL.
    expect(rows[0]!.id).not.toBe(state);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(rows[0]!.id).toBe(hex);

    client.query("delete from integration_oauth_states").run();
  });

  test("a non-OAuth provider is refused rather than half-started", async () => {
    const res = await h.fetch(BASE, json({ kind: "slack", config: { webhookUrl: "https://hooks.slack.test/x" } }));
    const slackId = ((await res.json()) as any).data.id as string;
    expect((await h.fetch(`${BASE}/${slackId}/oauth/authorize`, { method: "POST" })).status).toBe(400);
    expect(pendingStates()).toHaveLength(0);
  });

  test("connecting without client credentials is refused", async () => {
    // `connectIntegration` upserts per (tenant, kind), so clear the row first.
    client.query("delete from integrations where kind = 'notion'").run();
    const res = await h.fetch(BASE, json({ kind: "notion", config: { pageId: "page-1" } }));
    const id = ((await res.json()) as any).data.id as string;
    expect((await h.fetch(`${BASE}/${id}/oauth/authorize`, { method: "POST" })).status).toBe(400);
    // Nothing should be left pending after a refused start.
    expect(pendingStates()).toHaveLength(0);
  });

  test("starting a flow sweeps states that have aged out", async () => {
    client.query("delete from integrations where kind = 'notion'").run();
    client.query("delete from integration_oauth_states").run();
    const id = await connectNotion();
    await h.fetch(`${BASE}/${id}/oauth/authorize`, { method: "POST" });
    // An abandoned consent screen leaves this behind and nothing else deletes
    // it, so the table would only ever grow.
    client.query("update integration_oauth_states set expires_at = ?").run(Date.now() - 1000);
    await h.fetch(`${BASE}/${id}/oauth/authorize`, { method: "POST" });
    const rows = pendingStates();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expires_at).toBeGreaterThan(Date.now());

    client.query("delete from integration_oauth_states").run();
  });

  test("an unauthenticated caller cannot start a flow", async () => {
    const anon = makeHarness();
    try {
      const res = await anon.fetch(`${BASE}/anything/oauth/authorize`, { method: "POST" });
      expect([401, 403]).toContain(res.status);
    } finally {
      anon.cleanup();
    }
  });
});

describe("leg 2 — callback", () => {
  const start = async () => {
    client.query("delete from integrations where kind = 'notion'").run();
    client.query("delete from integration_oauth_states").run();
    const id = await connectNotion();
    const url = ((await (await h.fetch(`${BASE}/${id}/oauth/authorize`, { method: "POST" })).json()) as any).data.url;
    return { id, state: stateOf(url) };
  };

  const storedConfig = (id: string) =>
    JSON.parse(
      (client.query("select config from integrations where id = ?").get(id) as { config: string }).config,
    ) as Record<string, unknown>;

  test("a successful exchange stores the tokens and clears the state row", async () => {
    const { id, state } = await start();
    const restore = mockToken({
      access_token: ACCESS,
      workspace_name: "Acme HQ",
      workspace_id: "ws-1",
    });
    try {
      const res = await callback(`code=abc&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/integrations?oauth=connected");
    } finally {
      restore();
    }

    const config = storedConfig(id);
    // Stored, but encrypted: the plaintext must not be sitting in the row.
    expect(config[OAUTH_ACCESS_TOKEN_KEY]).toBeTruthy();
    expect(JSON.stringify(config)).not.toContain(ACCESS);
    // Non-secret metadata the provider asked us to keep rides along as-is.
    expect(config.workspace_name).toBe("Acme HQ");
    expect(pendingStates()).toHaveLength(0);
  });

  test("the access token is never readable back through the API", async () => {
    const { state } = await start();
    const restore = mockToken({ access_token: ACCESS });
    try {
      await callback(`code=abc&state=${encodeURIComponent(state)}`);
    } finally {
      restore();
    }
    const list = await (await h.fetch(BASE)).text();
    expect(list).not.toContain(ACCESS);
  });

  test("the same state cannot be redeemed twice", async () => {
    const { state } = await start();
    const restore = mockToken({ access_token: ACCESS });
    try {
      expect((await callback(`code=abc&state=${encodeURIComponent(state)}`)).headers.get("location")).toBe(
        "/integrations?oauth=connected",
      );
      // A replay is what a leaked callback URL in a proxy log looks like.
      expect((await callback(`code=abc&state=${encodeURIComponent(state)}`)).headers.get("location")).toBe(
        "/integrations?oauth=failed",
      );
    } finally {
      restore();
    }
  });

  test("a state this instance never issued is refused", async () => {
    await start();
    const res = await callback("code=abc&state=state-we-never-issued");
    expect(res.headers.get("location")).toBe("/integrations?oauth=failed");
  });

  test("an expired state is refused", async () => {
    const { state } = await start();
    client.query("update integration_oauth_states set expires_at = ?").run(Date.now() - 1000);
    const restore = mockToken({ access_token: ACCESS });
    try {
      expect((await callback(`code=abc&state=${encodeURIComponent(state)}`)).headers.get("location")).toBe(
        "/integrations?oauth=failed",
      );
    } finally {
      restore();
    }
  });

  test("a state belonging to another admin is refused", async () => {
    const { state } = await start();
    // Same workspace, different person: the code was issued for their consent,
    // not this session's, so grafting it onto this session must not work.
    client.query("update integration_oauth_states set user_id = 'someone-else'").run();
    const restore = mockToken({ access_token: ACCESS });
    try {
      expect((await callback(`code=abc&state=${encodeURIComponent(state)}`)).headers.get("location")).toBe(
        "/integrations?oauth=failed",
      );
    } finally {
      restore();
    }
  });

  test("a state belonging to another workspace is refused", async () => {
    const { id, state } = await start();
    client.query("update integration_oauth_states set tenant_id = 'some-other-tenant'").run();
    const restore = mockToken({ access_token: ACCESS });
    try {
      expect((await callback(`code=abc&state=${encodeURIComponent(state)}`)).headers.get("location")).toBe(
        "/integrations?oauth=failed",
      );
    } finally {
      restore();
    }
    expect(storedConfig(id)[OAUTH_ACCESS_TOKEN_KEY]).toBeUndefined();
  });

  test("an unauthenticated callback lands on sign-in, not on an exchange", async () => {
    const { state } = await start();
    const anon = makeHarness();
    let called = false;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      if (url.includes("api.notion.com")) called = true;
      return real(input, init);
    }) as typeof fetch;
    try {
      const res = await anon.fetch(`${BASE}/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, {
        redirect: "manual",
      });
      expect(res.headers.get("location")).toBe("/integrations?oauth=signed_out");
      // The point is not the redirect but that no exchange was attempted.
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = real;
      anon.cleanup();
    }
  });

  test("a declined consent screen is reported as denied, not as a failure", async () => {
    const res = await callback("error=access_denied&state=whatever");
    expect(res.headers.get("location")).toBe("/integrations?oauth=denied");
  });

  test("a token endpoint that answers non-2xx does not connect the integration", async () => {
    const { id, state } = await start();
    const restore = mockToken({ error: "invalid_client", client_secret: "csecret" }, 401);
    try {
      const res = await callback(`code=abc&state=${encodeURIComponent(state)}`);
      // The provider's error body echoes the client secret back; nothing from
      // it may reach the redirect the browser follows.
      expect(res.headers.get("location")).toBe("/integrations?oauth=failed");
      expect(res.headers.get("location")).not.toContain("csecret");
    } finally {
      restore();
    }
    expect(storedConfig(id)[OAUTH_ACCESS_TOKEN_KEY]).toBeUndefined();
  });
});

describe("the token keys belong to the flow, not to the admin form", () => {
  const storedConfig = (id: string) =>
    JSON.parse(
      (client.query("select config from integrations where id = ?").get(id) as { config: string }).config,
    ) as Record<string, unknown>;

  test("a pasted access token is dropped rather than stored", async () => {
    client.query("delete from integrations where kind = 'notion'").run();
    const id = await connectNotion({
      [OAUTH_ACCESS_TOKEN_KEY]: "pasted-by-hand",
      [OAUTH_REFRESH_TOKEN_KEY]: "also-pasted-by-hand",
    });
    const config = storedConfig(id);
    // Accepting these would make "this token came from the provider" false,
    // and the value would be masked on read so nobody could tell.
    expect(config[OAUTH_ACCESS_TOKEN_KEY]).toBeUndefined();
    expect(config[OAUTH_REFRESH_TOKEN_KEY]).toBeUndefined();
  });

  test("saving an unrelated field keeps the connected account", async () => {
    client.query("delete from integrations where kind = 'notion'").run();
    client.query("delete from integration_oauth_states").run();
    const id = await connectNotion();
    const url = ((await (await h.fetch(`${BASE}/${id}/oauth/authorize`, { method: "POST" })).json()) as any).data.url;
    const restore = mockToken({ access_token: ACCESS });
    try {
      await callback(`code=abc&state=${encodeURIComponent(stateOf(url))}`);
    } finally {
      restore();
    }
    const before = storedConfig(id)[OAUTH_ACCESS_TOKEN_KEY];
    expect(before).toBeTruthy();

    // The admin fixes a typo in the page id. The save replaces `config`
    // wholesale, so without the carry-over this silently disconnects Notion.
    await h.fetch(
      BASE,
      json({ kind: "notion", config: { clientId: "cid", clientSecret: "csecret", pageId: "page-2" } }),
    );
    const after = storedConfig(id);
    expect(after.pageId).toBe("page-2");
    expect(after[OAUTH_ACCESS_TOKEN_KEY]).toBe(before as string);
  });
});
