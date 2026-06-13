/**
 * Control-plane (admin) LDAP SSO — end-to-end against the in-process app.
 *
 * Mirrors tests/ldap.test.ts but for the PLATFORM plane: sign-in provisions a
 * `users` row, writes `platform_external_identities`, assigns roles in the
 * default tenant via `user_roles`, and mints a better-auth cookie session that
 * `GET /api/auth/get-session` accepts. The real `ldapts` adapter is swapped for
 * a programmable fake via `__setLdapAdapterFactoryForTests`.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { escapeLdapFilter } from "../src/server/adapters/ldap.ldapts";
import { __setLdapAdapterFactoryForTests } from "../src/server/lib/auth-select";
import type { LdapAdapter, LdapAttributes } from "@backlex/core/adapters";

interface FakeBackend {
  authenticate: (u: string, p: string) => LdapAttributes | null | "transport-error";
  filtersSeen: string[];
}

const makeFakeAdapter = (backend: FakeBackend): LdapAdapter => ({
  async authenticate(username, password) {
    backend.filtersSeen.push(escapeLdapFilter(username));
    const r = backend.authenticate(username, password);
    if (r === "transport-error") throw new Error("simulated LDAP transport error");
    return r;
  },
});

const configure = async (h: TestHarness, body: Record<string, unknown>): Promise<void> => {
  const res = await h.fetch("/api/admin/platform-ldap-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      url: "ldaps://dc1.test.example:636",
      bindDn: "cn=backlex,ou=service,dc=test,dc=example",
      baseDn: "ou=users,dc=test,dc=example",
      userFilter: "(&(objectClass=person)(uid={{username}}))",
      secrets: { bindPassword: "service-password" },
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`PUT platform-ldap-config failed: ${res.status} ${await res.text()}`);
};

const signIn = (h: TestHarness, username: string, password: string) =>
  h.fetch("/api/auth/ldap/sign-in", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

const sqliteAt = (h: TestHarness): Database => new Database(h.env.SQLITE_PATH!, { readonly: true });

describe("platform ldap: sign-in provisions users + mints an accepted cookie session", () => {
  let h: TestHarness;
  const backend: FakeBackend = {
    filtersSeen: [],
    authenticate: (u, p) =>
      u === "alice" && p === "correct-horse"
        ? {
            dn: "uid=alice,ou=users,dc=test,dc=example",
            email: "alice@test.example",
            firstName: "Alice",
            lastName: "Doe",
            groups: [],
          }
        : null,
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    __setLdapAdapterFactoryForTests(() => makeFakeAdapter(backend));
    await configure(h, {});
  });

  afterAll(() => {
    h.cleanup();
    __setLdapAdapterFactoryForTests(null);
  });

  test("happy path: 200 + cookie, provisions users + platform_external_identities", async () => {
    const res = await signIn(h, "alice", "correct-horse");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; user: { id: string; email: string } };
    expect(body.ok).toBe(true);
    expect(body.user.email).toBe("alice@test.example");
    expect((res.headers.getSetCookie?.() ?? []).some((sc) => sc.includes("session_token"))).toBe(true);

    const db = sqliteAt(h);
    const users = db
      .query("SELECT id FROM users WHERE email = ?")
      .all("alice@test.example") as { id: string }[];
    expect(users.length).toBe(1);
    const idents = db
      .query("SELECT subject FROM platform_external_identities WHERE provider_type = 'ldap'")
      .all() as { subject: string }[];
    expect(idents.some((r) => r.subject === "uid=alice,ou=users,dc=test,dc=example")).toBe(true);
    db.close();
  });

  test("load-bearing: the minted cookie is accepted by get-session", async () => {
    const res = await h.fetch("/api/auth/get-session");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { email?: string } } | null;
    expect(body?.user?.email).toBe("alice@test.example");
  });

  test("idempotent re-login: no duplicate users", async () => {
    expect((await signIn(h, "alice", "correct-horse")).status).toBe(200);
    const db = sqliteAt(h);
    const n = (db.query("SELECT count(*) as n FROM users WHERE email = ?").get("alice@test.example") as { n: number }).n;
    expect(n).toBe(1);
    db.close();
  });

  test("bad creds → 401", async () => {
    expect((await signIn(h, "alice", "WRONG")).status).toBe(401);
  });
});

describe("platform ldap: rate limit + domainMatch", () => {
  let h: TestHarness;
  const backend: FakeBackend = { filtersSeen: [], authenticate: () => null };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    __setLdapAdapterFactoryForTests(() => makeFakeAdapter(backend));
    await configure(h, { rateLimitPerMinute: 3, domainMatch: ["corp.example"] });
  });

  afterAll(() => {
    h.cleanup();
    __setLdapAdapterFactoryForTests(null);
  });

  test("4th attempt within a minute → 429", async () => {
    for (let i = 0; i < 3; i++) expect((await signIn(h, "mallory", "x")).status).toBe(401);
    expect((await signIn(h, "mallory", "x")).status).toBe(429);
  });

  test("domainMatch rejects off-allowlist email before the LDAP roundtrip", async () => {
    backend.filtersSeen.length = 0;
    const res = await signIn(h, "alice@elsewhere.example", "x");
    expect(res.status).toBe(422);
    expect(backend.filtersSeen.length).toBe(0);
  });
});

describe("platform ldap: groups → user_roles reconciliation", () => {
  let h: TestHarness;
  const groups: Record<string, string[]> = {
    carol: ["cn=editors,dc=test", "cn=hr,dc=test"],
  };
  const backend: FakeBackend = {
    filtersSeen: [],
    authenticate: (u, p) =>
      u === "carol" && p === "ok"
        ? { dn: "uid=carol,dc=test", email: "carol@test.example", firstName: "Carol", lastName: "Doe", groups: groups.carol }
        : null,
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    __setLdapAdapterFactoryForTests(() => makeFakeAdapter(backend));
    const db = new Database(h.env.SQLITE_PATH!);
    const tenantId = (db.query("SELECT id FROM tenants WHERE slug = 'default'").get() as { id: string }).id;
    const now = Date.now();
    db.run("INSERT INTO roles (id, tenant_id, name, description, admin, created_at, updated_at) VALUES ('p-editor', ?, 'editor-pldap', 'e', 0, ?, ?)", [tenantId, now, now]);
    db.run("INSERT INTO roles (id, tenant_id, name, description, admin, created_at, updated_at) VALUES ('p-hr', ?, 'hr-pldap', 'h', 0, ?, ?)", [tenantId, now, now]);
    db.close();
    await configure(h, {
      groupsToRoles: {
        "cn=editors,dc=test": { tenantId, roleId: "p-editor" },
        "cn=hr,dc=test": { tenantId, roleId: "p-hr" },
      },
    });
  });

  afterAll(() => {
    h.cleanup();
    __setLdapAdapterFactoryForTests(null);
  });

  test("first login assigns both group-mapped roles; second login drops removed group", async () => {
    expect((await signIn(h, "carol", "ok")).status).toBe(200);
    let db = sqliteAt(h);
    const uid = (db.query("SELECT id FROM users WHERE email = ?").get("carol@test.example") as { id: string }).id;
    let ids = new Set((db.query("SELECT role_id FROM user_roles WHERE user_id = ?").all(uid) as { role_id: string }[]).map((r) => r.role_id));
    expect(ids.has("p-editor")).toBe(true);
    expect(ids.has("p-hr")).toBe(true);
    db.close();

    groups.carol = ["cn=editors,dc=test"]; // drop hr
    expect((await signIn(h, "carol", "ok")).status).toBe(200);
    db = sqliteAt(h);
    ids = new Set((db.query("SELECT role_id FROM user_roles WHERE user_id = ?").all(uid) as { role_id: string }[]).map((r) => r.role_id));
    expect(ids.has("p-editor")).toBe(true);
    expect(ids.has("p-hr")).toBe(false);
    db.close();
  });
});

describe("platform ldap: feature gate", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness({ PLATFORM_SSO_ENABLED: "false" });
    await seedAdmin(h);
  });

  afterAll(() => h.cleanup());

  test("sign-in 404s when PLATFORM_SSO_ENABLED=false", async () => {
    expect((await signIn(h, "alice", "x")).status).toBe(404);
  });

  test("admin config 404s when disabled", async () => {
    expect((await h.fetch("/api/admin/platform-ldap-config")).status).toBe(404);
  });
});
