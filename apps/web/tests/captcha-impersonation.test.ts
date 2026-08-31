/**
 * Captcha, and impersonation with an audit trail.
 *
 * The captcha half is driven through the REAL auth endpoints rather than the
 * service, because the whole question is whether the gate sits in front of
 * better-auth's router — a green service test says nothing about that.
 *
 * The impersonation half asserts the two properties that make it auditable
 * rather than merely convenient: the token's authority is the ROW (so ending it
 * is instant), and a read-only session can see everything and change nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;

const JSON_HEADERS = { "content-type": "application/json" };
const realFetch = globalThis.fetch;

/** Stand in for the captcha provider. `verdict` decides what it answers; the
 *  `mode` lets a test make it unreachable, which is the case `onError` exists
 *  for and the one an operator gets wrong. */
let providerMode: "pass" | "fail" | "down" = "pass";
let providerCalls: Array<Record<string, string>> = [];

const stubProvider = () => {
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (!/siteverify/.test(u)) return realFetch(url, init);
    const body = new URLSearchParams(String(init?.body ?? ""));
    providerCalls.push(Object.fromEntries(body));
    if (providerMode === "down") throw new Error("provider unreachable");
    return new Response(JSON.stringify({ success: providerMode === "pass" }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
};

const configureCaptcha = (over: Record<string, unknown> = {}) =>
  h.fetch("/api/admin/captcha", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      provider: "turnstile",
      siteKey: "site-key",
      secretKey: "secret-key",
      protect: ["sign-up"],
      onError: "deny",
      ...over,
    }),
  });

const signUp = (email: string, headers: Record<string, string> = {}) =>
  h.fetch("/api/t/default/auth/sign-up/email", {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "New" }),
  });

beforeEach(async () => {
  providerMode = "pass";
  providerCalls = [];
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
  stubProvider();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  h.cleanup();
});

describe("captcha", () => {
  test("with none configured, sign-up is untouched", async () => {
    expect((await signUp("free@example.test")).status).toBe(200);
    expect(providerCalls.length).toBe(0);
  });

  test("a gated sign-up without a token is refused before anything is written", async () => {
    await configureCaptcha();
    const res = await signUp("blocked@example.test");
    expect(res.status).toBeGreaterThanOrEqual(400);
    // The gate runs in FRONT of better-auth, so there is no half-created user.
    const row = client
      .query("select id from app_users where email = 'blocked@example.test'")
      .get();
    expect(row).toBeNull();
    // …and no provider call either: a missing token needs no round trip.
    expect(providerCalls.length).toBe(0);
  });

  test("a token the provider accepts lets the sign-up through", async () => {
    await configureCaptcha();
    const res = await signUp("ok@example.test", { "x-captcha-token": "tok" });
    expect(res.status).toBe(200);
    expect(providerCalls[0]).toMatchObject({ secret: "secret-key", response: "tok" });
  });

  test("a token the provider rejects is refused", async () => {
    await configureCaptcha();
    providerMode = "fail";
    expect((await signUp("bot@example.test", { "x-captcha-token": "tok" })).status).toBeGreaterThanOrEqual(400);
  });

  test("only the LISTED targets are gated", async () => {
    // `sign-up` is protected and `sign-in` is not, so an existing user signs in
    // with no token at all. A global switch would have broken this.
    await signUp("member@example.test");
    await configureCaptcha({ protect: ["sign-up"] });
    const res = await h.fetch("/api/t/default/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "member@example.test", password: "correct-horse-battery" }),
    });
    expect(res.status).toBe(200);
  });

  test("`onError: deny` refuses when the provider is unreachable", async () => {
    await configureCaptcha({ onError: "deny" });
    providerMode = "down";
    expect(
      (await signUp("down@example.test", { "x-captcha-token": "tok" })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  test("`onError: allow` lets it through — the operator's choice, made explicit", async () => {
    await configureCaptcha({ onError: "allow" });
    providerMode = "down";
    expect((await signUp("lenient@example.test", { "x-captcha-token": "tok" })).status).toBe(200);
  });

  test("`onError` is required — neither answer is safe to assume", async () => {
    const res = await h.fetch("/api/admin/captcha", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        provider: "turnstile",
        siteKey: "s",
        secretKey: "k",
        protect: ["sign-up"],
      }),
    });
    expect(res.status).toBe(422);
  });

  test("an unknown target is refused rather than dropped", async () => {
    const res = await configureCaptcha({ protect: ["sign-up", "everything"] });
    expect(res.status).toBe(422);
  });

  test("the secret never comes back; the site key does", async () => {
    await configureCaptcha();
    const read = (await (await h.fetch("/api/admin/captcha")).json()) as {
      data: { siteKey: string; hasSecret: boolean };
    };
    expect(read.data.siteKey).toBe("site-key");
    expect(read.data.hasSecret).toBe(true);
    expect(JSON.stringify(read)).not.toContain("secret-key");
  });

  test("the public auth surface carries the site key and nothing else", async () => {
    await configureCaptcha();
    const res = await h.app.request(
      "/api/t/default/auth/providers",
      { headers: { origin: "http://localhost:5173" } } as RequestInit,
      h.env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("site-key");
    // The secret and the operator's failure policy are not the browser's
    // business — a widget needs the site key and nothing more.
    expect(body).not.toContain("secret-key");
    expect(body).not.toContain("onError");
  });

  test("removing the config stops the gate on the next request", async () => {
    await configureCaptcha();
    expect((await signUp("a@example.test")).status).toBeGreaterThanOrEqual(400);
    await h.fetch("/api/admin/captcha", { method: "DELETE" });
    expect((await signUp("b@example.test")).status).toBe(200);
  });

  test("a stored config that cannot be understood means NO captcha, not a broken gate", async () => {
    await configureCaptcha();
    client.query("update auth_config set captcha = ?").run("not json");
    // Fails open here on purpose, and it is the safe direction for THIS field:
    // a half-read captcha would gate some endpoints and not others with no way
    // to tell which, where "no captcha" is a state the operator can see.
    expect((await signUp("readable@example.test")).status).toBe(200);
  });
});

describe("impersonation", () => {
  const appUser = async (email: string) => {
    const res = await h.fetch("/api/t/default/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "Sub" }),
    });
    expect(res.status).toBe(200);
    return (
      client.query("select id from app_users where email = ?").get(email) as { id: string }
    ).id;
  };

  const start = (subjectUserId: string, over: Record<string, unknown> = {}) =>
    h.fetch("/api/admin/impersonation", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ subjectUserId, reason: "ticket #42", ...over }),
    });

  const asSubject = (token: string, path: string, init: RequestInit = {}) =>
    h.app.request(
      path,
      {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          authorization: `Bearer ${token}`,
          origin: "http://localhost:5173",
        },
      } as RequestInit,
      h.env,
    );

  test("a reason is required", async () => {
    const id = await appUser("who@example.test");
    expect((await start(id, { reason: "" })).status).toBe(422);
    expect((await start(id, { reason: "x" })).status).toBe(422);
  });

  /** A collection the bundled `authenticated` role may read, plus one row per
   *  owner. Reading it through an impersonation token is the strongest
   *  available proof of WHOSE identity the request carries: the permission
   *  condition is evaluated against `$user.id`. */
  const ownedNotes = async () => {
    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "Notes",
        slug: "notes",
        // `owner_id` is a system column that only exists on an owner-scoped
        // collection — which is also the realistic shape for "rows a customer
        // sees", the thing impersonation exists to reproduce.
        ownerScoped: true,
        fields: [{ name: "title", type: "text" }],
      }),
    });
    const roles = (await (await h.fetch("/api/roles")).json()) as {
      data: Array<{ id: string; name: string }>;
    };
    const authenticated = roles.data.find((r) => r.name === "authenticated")!;
    for (const action of ["read", "create"]) {
      await h.fetch(`/api/roles/${authenticated.id}/permissions`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          collection: "notes",
          action,
          ...(action === "read" ? { condition: { owner_id: { _eq: "$user.id" } } } : {}),
        }),
      });
    }
  };

  test("the token acts as the subject, not as the operator", async () => {
    await ownedNotes();
    const mine = await appUser("subject@example.test");
    const theirs = await appUser("other@example.test");
    // One row per owner, written directly so neither depends on the feature
    // under test.
    const table = (
      client
        .query("select physical_table from collections where slug = 'notes'")
        .get() as { physical_table: string }
    ).physical_table;
    const tenantId = (
      client.query("select id from tenants where slug = 'default'").get() as { id: string }
    ).id;
    for (const [id, title] of [
      [mine, "belongs to subject"],
      [theirs, "belongs to someone else"],
    ] as Array<[string, string]>) {
      client
        .query(
          `insert into "${table}" (id, tenant_id, owner_id, title, created_at, updated_at) values (?,?,?,?,?,?)`,
        )
        .run(crypto.randomUUID(), tenantId, id, title, Date.now(), Date.now());
    }

    const res = await start(mine);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; data: { readOnly: boolean } };
    // Read-only unless asked otherwise.
    expect(body.data.readOnly).toBe(true);

    const read = await asSubject(body.token, "/api/items/notes");
    expect(read.status).toBe(200);
    const rows = (await read.json()) as { data: Array<{ title: string }> };
    // The row condition resolved `$user.id` to the SUBJECT — which is the
    // whole point, and what a token carrying the operator's identity would
    // have got wrong.
    expect(rows.data.map((r) => r.title)).toEqual(["belongs to subject"]);
  });

  test("ending it takes effect on the very next request", async () => {
    await ownedNotes();
    const id = await appUser("ends@example.test");
    const started = (await (await start(id)).json()) as { token: string; data: { id: string } };
    expect((await asSubject(started.token, "/api/items/notes")).status).toBe(200);

    await h.fetch(`/api/admin/impersonation/${started.data.id}/end`, { method: "POST" });
    // The token is still cryptographically valid — the ROW is what stopped it.
    // A self-contained token would still be working here.
    const after = await asSubject(started.token, "/api/items/notes");
    expect(after.status).toBeGreaterThanOrEqual(400);
  });

  test("an expired impersonation stops working even before the token expires", async () => {
    await ownedNotes();
    const id = await appUser("expires@example.test");
    const started = (await (await start(id, { minutes: 60 })).json()) as {
      token: string;
      data: { id: string };
    };
    // Age the ROW only. The JWT still has an hour on it.
    client
      .query("update impersonations set expires_at = ? where id = ?")
      .run(Date.now() - 1000, started.data.id);
    expect(
      (await asSubject(started.token, "/api/items/notes")).status,
    ).toBeGreaterThanOrEqual(400);
  });

  test("a read-only impersonation can read and cannot write", async () => {
    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Notes", slug: "notes", fields: [{ name: "title", type: "text" }] }),
    });
    // The bundled `authenticated` role is what an end-user holds; grant it
    // read+create so the refusal below is the IMPERSONATION's, not a missing
    // permission. Without this the test would pass vacuously.
    const roles = (await (await h.fetch("/api/roles")).json()) as {
      data: Array<{ id: string; name: string }>;
    };
    const authenticated = roles.data.find((r) => r.name === "authenticated");
    if (authenticated) {
      for (const action of ["read", "create"]) {
        await h.fetch(`/api/roles/${authenticated.id}/permissions`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ collection: "notes", action }),
        });
      }
    }

    const id = await appUser("ro@example.test");
    const started = (await (await start(id)).json()) as { token: string };

    expect((await asSubject(started.token, "/api/items/notes")).status).toBe(200);
    const write = await asSubject(started.token, "/api/items/notes", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "written by support" }),
    });
    expect(write.status).toBe(403);
    expect(await write.text()).toContain("read-only impersonation");
  });

  test("a read-write impersonation may write, and the audit names both parties", async () => {
    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Notes", slug: "notes", fields: [{ name: "title", type: "text" }] }),
    });
    const roles = (await (await h.fetch("/api/roles")).json()) as {
      data: Array<{ id: string; name: string }>;
    };
    const authenticated = roles.data.find((r) => r.name === "authenticated");
    if (authenticated) {
      for (const action of ["read", "create"]) {
        await h.fetch(`/api/roles/${authenticated.id}/permissions`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ collection: "notes", action }),
        });
      }
    }
    const id = await appUser("rw@example.test");
    const started = (await (await start(id, { readOnly: false })).json()) as { token: string };
    const write = await asSubject(started.token, "/api/items/notes", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "on their behalf" }),
    });
    expect(write.status).toBe(201);

    const row = client
      .query(
        "select user_id, impersonated_by from activity where collection = 'notes' order by rowid desc limit 1",
      )
      .get() as { user_id: string; impersonated_by: string | null } | null;
    expect(row).not.toBeNull();
    // The write is genuinely the SUBJECT's — that is what makes it a faithful
    // reproduction — and the operator rides in its own column, so "what did
    // support do" stays a query rather than a JSON grep.
    expect(row!.user_id).toBe(id);
    expect(row!.impersonated_by).not.toBeNull();
  });

  test("a read-only impersonation cannot write through GraphQL either", async () => {
    // GraphQL never passes through the permission middleware — it hand-builds
    // its own resolvers, and has repeatedly been the surface a guard was
    // missing from. Fails without the check inside the write core.
    await ownedNotes();
    const id = await appUser("gql@example.test");
    const started = (await (await start(id)).json()) as { token: string };
    const res = await asSubject(started.token, "/api/graphql", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        query: `mutation { createNotes(data: { title: "sneaky" }) { id } }`,
      }),
    });
    const body = (await res.json()) as { errors?: Array<{ message: string }> };
    expect(body.errors?.[0]?.message ?? "").toContain("read-only impersonation");
  });

  test("a platform user cannot be impersonated", async () => {
    const platform = client
      .query("select id from users limit 1")
      .get() as { id: string } | null;
    if (!platform) return;
    // The subject lookup is scoped to `app_users`, so an operator id simply
    // is not found — one operator acting as another is not support.
    expect((await start(platform.id)).status).toBe(404);
  });

  test("an impersonated session cannot start another", async () => {
    const id = await appUser("hop@example.test");
    const started = (await (await start(id)).json()) as { token: string };
    const res = await asSubject(started.token, "/api/admin/impersonation", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ subjectUserId: id, reason: "hopping" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("the window is capped in code, and asking for more is refused not clamped", async () => {
    const id = await appUser("long@example.test");
    const res = await start(id, { minutes: 480 });
    expect(res.status).toBe(422);
  });

  test("the list is the audit trail", async () => {
    const id = await appUser("audited@example.test");
    await start(id, { reason: "investigating a missing invoice" });
    const listed = (await (await h.fetch("/api/admin/impersonation")).json()) as {
      data: Array<{ reason: string; subjectUserId: string; active: boolean }>;
    };
    expect(listed.data[0]!.reason).toBe("investigating a missing invoice");
    expect(listed.data[0]!.subjectUserId).toBe(id);
    expect(listed.data[0]!.active).toBe(true);
  });

  test("IMPERSONATION_DISABLED removes the feature entirely", async () => {
    h.cleanup();
    h = makeHarness({ IMPERSONATION_DISABLED: "1" } as never);
    await seedAdmin(h);
    client = new Database(h.env.SQLITE_PATH as string);
    const id = await appUser("nope@example.test");
    expect((await start(id)).status).toBeGreaterThanOrEqual(400);
  });
});
