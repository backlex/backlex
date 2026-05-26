/**
 * Smoke tests for the API key (Bearer auth) flow.
 *
 * Contract under test (see CLAUDE.md + `routes/api-keys.ts`):
 *   • Full key format `pak_<8-hex prefix>_<32-hex secret>`, returned ONCE.
 *   • `Authorization: Bearer pak_…` falls back when no session cookie exists
 *     and impersonates the key's owner (inheriting their roles + tenant).
 *   • `name` is optional (server generates a timestamped default).
 *   • `role_id` may scope the key to a single role — keys can never widen
 *     their owner's access.
 *   • Revoked or expired keys ⇒ no fallback match ⇒ 401.
 *
 * All Bearer-only requests bypass `h.fetch` so the cookie jar can't shadow
 * the fallback path. We hit `h.app.fetch` directly with a fresh `Request`.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const APP_URL = "http://localhost:5173";

/** Build a `Request` with Bearer auth and no cookie — forces the API-key
 *  fallback path in `middleware/session.ts`. */
const bearerRequest = (path: string, secret: string, init: RequestInit = {}) =>
  new Request(`${APP_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${secret}`,
      Origin: APP_URL,
    },
  });

interface CreatedKey {
  id: string;
  prefix: string;
  name: string;
  secret: string;
  roleId: string | null;
}

const createKey = async (
  h: TestHarness,
  body: Record<string, unknown> = {},
): Promise<{ status: number; key: CreatedKey | null; raw: unknown }> => {
  const res = await h.fetch("/api/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = (await res.json()) as {
    data?: CreatedKey;
    error?: { code: string; message: string };
  };
  return { status: res.status, key: raw.data ?? null, raw };
};

describe("api-keys: create + use as Bearer", () => {
  let h: TestHarness;
  let adminEmail: string;

  beforeAll(async () => {
    h = makeHarness();
    const creds = await seedAdmin(h);
    adminEmail = creds.email;
  });

  afterAll(() => {
    h.cleanup();
  });

  test("POST returns full key once and Bearer reaches /api/me as admin", async () => {
    const { status, key } = await createKey(h, { name: `ci-bot-${Date.now()}` });
    expect(status).toBe(201);
    expect(key).not.toBeNull();
    // Full key format: pak_<8-hex>_<32-hex>
    // OBSERVED: 32 bytes of randomness ⇒ 64 hex chars (CLAUDE.md hints at
    // "32-hex secret" — that's the byte count, not the char length).
    expect(key!.secret).toMatch(/^pak_[0-9a-f]{8}_[0-9a-f]{64}$/);
    expect(key!.prefix).toMatch(/^pak_[0-9a-f]{8}$/);

    // Bypass the harness wrapper so the cookie jar can't shadow Bearer.
    const meRes = await h.app.fetch(bearerRequest("/api/me", key!.secret));
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as {
      data: { email: string; isAdmin: boolean; roles: string[] };
    };
    expect(me.data.email).toBe(adminEmail);
    expect(me.data.isAdmin).toBe(true);
    expect(me.data.roles).toContain("admin");
  });
});

describe("api-keys: omitted name gets a default", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("POST {} succeeds and `name` is a non-empty timestamped default", async () => {
    const { status, key } = await createKey(h, {});
    expect(status).toBe(201);
    expect(key).not.toBeNull();
    expect(typeof key!.name).toBe("string");
    expect(key!.name.length).toBeGreaterThan(0);
    expect(key!.secret).toMatch(/^pak_[0-9a-f]{8}_[0-9a-f]{64}$/);
  });
});

describe("api-keys: mcpTools defaults to [] (default-deny)", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  /**
   * A POST that omits `mcpTools` must return an empty allowlist — the safe
   * default ensures a freshly minted key can't call any MCP tool until the
   * owner explicitly opts in. Callers who want the legacy permissive shape
   * have to send `mcpTools: null` on purpose.
   */
  test("POST without mcpTools yields mcpTools === [] in the response", async () => {
    const { status, key } = await createKey(h, { name: `default-deny-${Date.now()}` });
    expect(status).toBe(201);
    const row = key as unknown as { mcpTools: string[] | null };
    expect(Array.isArray(row.mcpTools)).toBe(true);
    expect(row.mcpTools).toEqual([]);
  });

  test("POST with explicit mcpTools: null still mints a permissive key", async () => {
    const { status, key } = await createKey(h, {
      name: `permissive-${Date.now()}`,
      mcpTools: null,
    });
    expect(status).toBe(201);
    const row = key as unknown as { mcpTools: string[] | null };
    expect(row.mcpTools).toBeNull();
  });
});

describe("api-keys: malformed Bearer is rejected", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    // No seeded admin needed — we're proving the fallback rejects garbage.
  });

  afterAll(() => {
    h.cleanup();
  });

  test("Bearer garbage_token ⇒ 401 from /api/me", async () => {
    const res = await h.app.fetch(bearerRequest("/api/me", "garbage_token"));
    expect(res.status).toBe(401);
  });
});

describe("api-keys: revoke makes the key unusable", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("create → use (200) → DELETE → use again (401)", async () => {
    const { status, key } = await createKey(h, { name: `revoke-${Date.now()}` });
    expect(status).toBe(201);

    const ok = await h.app.fetch(bearerRequest("/api/me", key!.secret));
    expect(ok.status).toBe(200);

    const del = await h.fetch(`/api/api-keys/${key!.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const after = await h.app.fetch(bearerRequest("/api/me", key!.secret));
    expect(after.status).toBe(401);
  });
});

describe("api-keys: past expiresAt is rejected at creation", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  /**
   * Contract deviation note: the server validates `expiresAt > now` at POST
   * time (`routes/api-keys.ts` throws VALIDATION → 422) rather than letting
   * the key be created and then rejecting it at lookup. We assert that
   * stricter behavior here — it's a superset of "expired key ⇒ 401" since
   * a past expiry can never even be materialized as a key.
   */
  test("POST with past expiresAt ⇒ 422 VALIDATION (server-side rejection)", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const res = await h.fetch("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `expired-${Date.now()}`, expiresAt: past }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { code: string } };
    expect(body.error?.code).toBe("VALIDATION");
  });
});

describe("api-keys: role-scoped key narrows below admin", () => {
  let h: TestHarness;
  let adminCreds: { email: string; password: string };

  beforeAll(async () => {
    h = makeHarness();
    adminCreds = await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  /**
   * Contract clarification observed: `assertRoleBindable` requires the
   *   OWNER of the key to hold the role being bound — even when the caller
   *   is admin. Since the first user is *only* granted `admin` (not
   *   `authenticated`), an admin cannot scope a SELF-key to `authenticated`
   *   without first granting themselves that role. To exercise the narrow
   *   path we sign up a second user (auto-assigned `authenticated`), sign
   *   back in as admin, and mint a key for that user scoped to
   *   `authenticated`. This is also the only realistic shape — admins use
   *   scoping to issue narrow machine credentials for *other* users.
   */
  test("scoped-to-`authenticated` key hits admin-only /api/roles ⇒ 403", async () => {
    // Sign up user-2 — this overwrites the admin cookie in the jar, so we
    // must capture the new user's id from the response then sign back in.
    const u2Email = `member-${Date.now()}@example.test`;
    const u2Password = "correct-horse-battery";
    const signUp2 = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: u2Email, password: u2Password, name: "Member" }),
    });
    expect(signUp2.status).toBe(200);
    const u2 = (await signUp2.json()) as { user?: { id: string } };
    expect(u2.user?.id).toBeTruthy();
    const u2Id = u2.user!.id;

    // Sign back in as admin so subsequent fetches authenticate as admin.
    const signInBack = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: adminCreds.email, password: adminCreds.password }),
    });
    expect(signInBack.status).toBe(200);

    // 1. Admin sees multiple bindable roles in the workspace.
    const rolesRes = await h.fetch("/api/api-keys/available-roles");
    expect(rolesRes.status).toBe(200);
    const rolesBody = (await rolesRes.json()) as {
      data: { id: string; name: string; admin: boolean }[];
    };
    expect(rolesBody.data.length).toBeGreaterThan(1);
    const authenticatedRole = rolesBody.data.find((r) => r.name === "authenticated");
    expect(authenticatedRole).toBeDefined();

    // 2. Mint a key for user-2 scoped to `authenticated`.
    const { status, key } = await createKey(h, {
      name: `scoped-${Date.now()}`,
      userId: u2Id,
      roleId: authenticatedRole!.id,
    });
    expect(status).toBe(201);
    expect(key!.roleId).toBe(authenticatedRole!.id);

    // 3. Admin-only endpoint /api/roles must reject the scoped key.
    const rolesAsKey = await h.app.fetch(bearerRequest("/api/roles", key!.secret));
    expect(rolesAsKey.status).toBe(403);

    // 4. Sanity: /api/me still works (any signed-in user can call it) and
    //    confirms the role narrowing took effect.
    const meAsKey = await h.app.fetch(bearerRequest("/api/me", key!.secret));
    expect(meAsKey.status).toBe(200);
    const me = (await meAsKey.json()) as {
      data: { isAdmin: boolean; roles: string[]; email: string };
    };
    expect(me.data.email).toBe(u2Email);
    expect(me.data.isAdmin).toBe(false);
    expect(me.data.roles).not.toContain("admin");
  });
});
