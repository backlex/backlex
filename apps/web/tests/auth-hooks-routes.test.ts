/**
 * Auth hooks against the REAL auth surface.
 *
 * `auth-hooks.test.ts` pins the service in isolation. This one drives the four
 * hook points through the endpoints a customer's app actually calls, because
 * three of the four live in code the service never sees: a better-auth database
 * hook, a Hono middleware wrapped around better-auth's own router, and the
 * token mint inside the refresh route. A green service test says nothing about
 * whether any of them is wired up.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;
let tenantId: string;
let admin: { email: string; password: string };

let seen: { body: any }[] = [];
const realFetch = globalThis.fetch;

const app = (handler: (body: any) => Response) => {
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (!u.startsWith("https://hook.test/")) return realFetch(url, init);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ body });
    return handler(body);
  }) as typeof fetch;
};

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const JSON_HEADERS = { "content-type": "application/json" };

const insertHook = (event: string, over: Record<string, unknown> = {}) => {
  const row = {
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    event,
    target_type: "url",
    url: "https://hook.test/a",
    function_name: null,
    secret: null,
    headers: null,
    timeout_ms: 2000,
    on_error: "deny",
    enabled: 1,
    ...over,
  };
  client
    .query(
      `insert into auth_hooks (id, tenant_id, event, target_type, url, function_name, secret,
        headers, timeout_ms, on_error, enabled, consecutive_failures, created_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    )
    .run(
      row.id, row.tenant_id, row.event, row.target_type, row.url, row.function_name,
      row.secret, row.headers, row.timeout_ms, row.on_error, row.enabled,
      Date.now(), Date.now(),
    );
  return row.id;
};

const signUp = (email: string, password = "hook-pass-12345") =>
  h.fetch("/api/t/default/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password, name: "Hooked" }),
  });

const signIn = (email: string, password = "hook-pass-12345") =>
  h.fetch("/api/t/default/auth/sign-in/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password }),
  });

const decode = (jwt: string): Record<string, unknown> =>
  JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      ),
    ),
  );

beforeEach(async () => {
  seen = [];
  h = makeHarness();
  admin = await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
  tenantId = (client.query("select id from tenants where slug = 'default'").get() as { id: string })
    .id;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  h.cleanup();
});

describe("before-user-created reaches the real sign-up", () => {
  test("a refusal stops the sign-up and leaves no app_users row", async () => {
    insertHook("before-user-created");
    app(() => json({ allow: false, reason: "invite only" }));

    const res = await signUp("blocked@example.test");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).toContain("invite only");

    const row = client
      .query("select id from app_users where email = 'blocked@example.test'")
      .get();
    expect(row).toBeNull();
    expect(seen[0]!.body.data).toMatchObject({ email: "blocked@example.test", via: "password" });
  });

  test("an allow lets the sign-up through", async () => {
    insertHook("before-user-created");
    app(() => json({ allow: true }));
    expect((await signUp("allowed@example.test")).status).toBe(200);
  });

  test("turning a hook on takes effect immediately, not after the auth cache expires", async () => {
    // The tenant's better-auth instance is cached for five minutes. An
    // admission gate that took that long to apply would be a gate nobody could
    // trust, so the hook row is read inside the closure — this is the test that
    // fails if someone captures it at build time instead.
    app(() => json({ allow: false, reason: "closed now" }));
    expect((await signUp("first@example.test")).status).toBe(200); // no hook yet

    insertHook("before-user-created");
    const res = await signUp("second@example.test");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).toContain("closed now");
  });
});

describe("password-verification reaches the real sign-in", () => {
  const email = "pv@example.test";

  test("a refusal turns a correct password into a 401 AND kills the session", async () => {
    app(() => json({ allow: true }));
    insertHook("before-user-created");
    expect((await signUp(email)).status).toBe(200);
    const before = client.query("select count(*) as n from app_sessions").get() as { n: number };

    insertHook("password-verification");
    app(() => json({ allow: false, reason: "device not recognised" }));

    const res = await signIn(email);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("device not recognised");

    // The whole point: better-auth had already written a session row by the
    // time the verdict arrived. A refusal that left it behind would be handing
    // out a working credential with a rejection printed on it.
    const after = client.query("select count(*) as n from app_sessions").get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  test("the hook is told about a WRONG password too", async () => {
    app(() => json({ allow: true }));
    insertHook("before-user-created");
    await signUp(email);

    insertHook("password-verification");
    seen = [];
    app(() => json({ allow: true }));

    const res = await signIn(email, "not-the-password");
    expect(res.status).toBe(401);
    const pv = seen.find((s) => s.body.event === "password-verification");
    expect(pv!.body.data).toMatchObject({ email, valid: false });
  });

  test("an allow verdict leaves the sign-in working", async () => {
    app(() => json({ allow: true }));
    insertHook("before-user-created");
    await signUp(email);

    insertHook("password-verification");
    const res = await signIn(email);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token?: string }).token).toBeTruthy();
  });

  test("the platform plane is NOT hooked", async () => {
    // A workspace admin is a customer on managed cloud; a hook that could veto
    // operator sign-ins would be one customer gating the whole instance.
    insertHook("password-verification");
    app(() => json({ allow: false, reason: "should never apply" }));
    const res = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { ...JSON_HEADERS, origin: "http://localhost:5173" },
      body: JSON.stringify({ email: admin.email, password: admin.password }),
    });
    // A 200 is what makes this assertion mean something: signing in with
    // credentials that do NOT exist would also "not contain" the refusal.
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(0);
  });
});

describe("custom-access-token reaches the real token mint", () => {
  const email = "cat@example.test";

  test("the hook's claims land in the JWT and the identity claims still win", async () => {
    app(() => json({ allow: true }));
    insertHook("before-user-created");
    const up = await signUp(email);
    const refreshToken = ((await up.json()) as { token: string }).token;

    insertHook("custom-access-token");
    app(() =>
      json({ claims: { plan: "enterprise", seats: 12, tid: "some-other-workspace" } }),
    );

    const res = await h.fetch("/api/t/default/auth/token/refresh", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ refreshToken }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    const claims = decode(accessToken);
    expect(claims.plan).toBe("enterprise");
    expect(claims.seats).toBe(12);
    // Reserved: the workspace the token is for is decided by us, not the hook.
    expect(claims.tid).toBe(tenantId);
  });

  test("the payload carries the end-user's roles", async () => {
    app(() => json({ allow: true }));
    insertHook("before-user-created");
    const up = await signUp(email);
    const refreshToken = ((await up.json()) as { token: string }).token;

    insertHook("custom-access-token");
    seen = [];
    app(() => json({ claims: {} }));
    await h.fetch("/api/t/default/auth/token/refresh", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ refreshToken }),
    });
    const call = seen.find((s) => s.body.event === "custom-access-token");
    expect(call!.body.data.roles).toContain("authenticated");
    expect(call!.body.data.email).toBe(email);
  });

  test("with no hook the refresh still mints a plain token", async () => {
    app(() => json({ allow: true }));
    const up = await signUp(email);
    const refreshToken = ((await up.json()) as { token: string }).token;
    const res = await h.fetch("/api/t/default/auth/token/refresh", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ refreshToken }),
    });
    expect(res.status).toBe(200);
    expect(decode(((await res.json()) as { accessToken: string }).accessToken).tid).toBe(tenantId);
  });
});
