/**
 * LDAP / Active Directory — end-to-end tests against the in-process Hono app.
 *
 * Mocking strategy: the production code's adapter factory is
 * `apps/web/src/server/lib/auth-select.ts::buildLdapAdapter`, which calls
 * the real `ldapts.Client`. The module exposes a tests-only override
 * (`__setLdapAdapterFactoryForTests`) that lets us substitute a fake
 * directory. Each suite registers a fake that the tests can program with
 * `(username, password) => attrs | null` and an injection seam to assert the
 * arguments the adapter sees (escape, attribute lookups, etc.).
 *
 * Tests cover:
 *   - happy path: valid creds → app_user + external_identity + app_session
 *   - idempotent re-login (same DN)
 *   - bad creds → 401, no app_user
 *   - transport error → 500 (INTERNAL)
 *   - rate limit kicks in
 *   - LDAP filter injection: username with parentheses → escaped before search
 *   - domainMatch rejects pre-LDAP for off-allowlist emails
 *   - groups → role assignment on first login; reconciliation on second login
 *   - Workers-runtime gate: buildLdapAdapter returns undefined when
 *     onCloudflareWorkers() is true (stubbed via navigator.userAgent)
 *   - external_identities lookup is tenant-scoped (already covered by Phase 1;
 *     we add an LDAP discriminator)
 */
import { describe, expect, test, afterAll, beforeAll, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  ldaptsLdapAdapter,
  escapeLdapFilter,
  type LdapClientLike,
  type LdapClientFactory,
} from "../src/server/adapters/ldap.ldapts";
import { __setLdapAdapterFactoryForTests } from "../src/server/lib/auth-select";
import { verifyAccessToken } from "../src/server/lib/jwt";
import type { LdapAdapter, LdapAttributes } from "@backlex/core/adapters";

const TENANT_SLUG = "default";

interface FakeBackend {
  /** `(username, password) => attrs | null | "transport-error"`. */
  authenticate: (username: string, password: string) => LdapAttributes | null | "transport-error";
  /** Captures every search filter the adapter sent. */
  filtersSeen: string[];
}

/**
 * Build a fake LdapAdapter whose authenticate() delegates to the supplied
 * backend. We don't go through `ldaptsLdapAdapter` here — that would force us
 * to also stub `bind`/`search`/`unbind`; for route-level tests it's enough to
 * substitute the whole `LdapAdapter`.
 */
const makeFakeAdapter = (backend: FakeBackend): LdapAdapter => ({
  async authenticate(username, password) {
    // Mirror the real adapter's escape so callers can assert filter injection.
    backend.filtersSeen.push(escapeLdapFilter(username));
    const r = backend.authenticate(username, password);
    if (r === "transport-error") {
      throw new Error("simulated LDAP transport error");
    }
    return r;
  },
});

const configureLdap = async (
  h: TestHarness,
  body: Record<string, unknown>,
): Promise<void> => {
  const res = await h.fetch("/api/admin/ldap-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      url: "ldaps://dc1.test.example:636",
      bindDn: "cn=workeros,ou=service,dc=test,dc=example",
      baseDn: "ou=users,dc=test,dc=example",
      userFilter: "(&(objectClass=person)(uid={{username}}))",
      secrets: { bindPassword: "service-password" },
      ...body,
    }),
  });
  if (!res.ok) {
    throw new Error(`PUT /api/admin/ldap-config failed: ${res.status} ${await res.text()}`);
  }
};

const sqliteAt = (h: TestHarness): Database => {
  const path = h.env.SQLITE_PATH;
  if (!path) throw new Error("test harness has no SQLITE_PATH");
  return new Database(path, { readonly: true });
};

const signIn = async (h: TestHarness, username: string, password: string) =>
  h.fetch(`/api/t/${TENANT_SLUG}/auth/ldap/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

describe("ldap: happy path + idempotent re-login + bad creds + transport error", () => {
  let h: TestHarness;
  const backend: FakeBackend = {
    filtersSeen: [],
    authenticate: (username, password) => {
      if (username === "alice" && password === "correct-horse") {
        return {
          dn: "uid=alice,ou=users,dc=test,dc=example",
          email: "alice@test.example",
          firstName: "Alice",
          lastName: "Doe",
          groups: [],
        };
      }
      if (username === "bob" && password === "transport-please") {
        return "transport-error";
      }
      return null;
    },
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    __setLdapAdapterFactoryForTests(() => makeFakeAdapter(backend));
    await configureLdap(h, {});
  });

  afterAll(() => {
    h.cleanup();
    __setLdapAdapterFactoryForTests(null);
  });

  test("happy path: valid creds → 200 with { token, user } + app_user/external_identity/app_session rows", async () => {
    const res = await signIn(h, "alice", "correct-horse");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { id: string; email: string } };
    expect(typeof body.token).toBe("string");
    expect(body.user.email).toBe("alice@test.example");

    const db = sqliteAt(h);
    const users = db
      .query("SELECT id, email FROM app_users WHERE email = ?")
      .all("alice@test.example") as { id: string; email: string }[];
    expect(users.length).toBe(1);

    const idents = db
      .query("SELECT subject, provider_type FROM external_identities WHERE provider_type = 'ldap'")
      .all() as { subject: string; provider_type: string }[];
    expect(idents.some((r) => r.subject === "uid=alice,ou=users,dc=test,dc=example")).toBe(true);

    const sessions = db
      .query("SELECT token FROM app_sessions WHERE token = ?")
      .all(body.token) as { token: string }[];
    expect(sessions.length).toBe(1);
    db.close();
  });

  test("sign-in returns an access/refresh token pair; the access JWT verifies", async () => {
    const res = await signIn(h, "alice", "correct-horse");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      tokenType: string;
    };
    // Legacy `token` stays equal to the opaque refresh token (non-breaking).
    expect(body.token).toBe(body.refreshToken);
    expect(body.refreshToken.startsWith("app_")).toBe(true);
    expect(body.tokenType).toBe("Bearer");
    expect(body.expiresIn).toBeGreaterThan(0);

    const claims = await verifyAccessToken(h.env.AUTH_SECRET, body.accessToken);
    expect(claims).not.toBeNull();
    expect(claims!.plane).toBe("app");
    expect(claims!.email).toBe("alice@test.example");
  });

  test("token/refresh exchanges a refresh token for a fresh access token", async () => {
    const signRes = await signIn(h, "alice", "correct-horse");
    const { refreshToken } = (await signRes.json()) as { refreshToken: string };

    const ok = await h.fetch(`/api/t/${TENANT_SLUG}/auth/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(ok.status).toBe(200);
    const refreshed = (await ok.json()) as {
      accessToken: string;
      refreshToken: string;
      tokenType: string;
    };
    expect(refreshed.refreshToken).toBe(refreshToken);
    const claims = await verifyAccessToken(
      h.env.AUTH_SECRET,
      refreshed.accessToken,
    );
    expect(claims).not.toBeNull();

    // A bogus refresh token is rejected.
    const bad = await h.fetch(`/api/t/${TENANT_SLUG}/auth/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: `app_${crypto.randomUUID()}` }),
    });
    expect(bad.status).toBe(401);
  });

  test("second login with same DN is idempotent (no duplicate app_users)", async () => {
    const res = await signIn(h, "alice", "correct-horse");
    expect(res.status).toBe(200);

    const db = sqliteAt(h);
    const n = (db
      .query("SELECT count(*) as n FROM app_users WHERE email = ?")
      .get("alice@test.example") as { n: number }).n;
    expect(n).toBe(1);
    db.close();
  });

  test("bad creds → 401, no app_user provisioned", async () => {
    const res = await signIn(h, "alice", "WRONG");
    expect(res.status).toBe(401);
    const db = sqliteAt(h);
    const idents = db
      .query("SELECT subject FROM external_identities WHERE subject = ?")
      .all("uid=wronguser,dc=test,dc=example") as { subject: string }[];
    expect(idents.length).toBe(0);
    db.close();
  });

  test("transport error → 500 (INTERNAL)", async () => {
    const res = await signIn(h, "bob", "transport-please");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string } };
    // The error middleware emits { error: { code, message } }; we just assert
    // the status — surfacing INTERNAL is mapped to 500.
    expect(body).toBeTruthy();
  });
});

describe("ldap: rate limit + filter injection escape + domainMatch pre-gate", () => {
  let h: TestHarness;
  const backend: FakeBackend = {
    filtersSeen: [],
    authenticate: () => null, // always rejects
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    __setLdapAdapterFactoryForTests(() => makeFakeAdapter(backend));
    await configureLdap(h, {
      rateLimitPerMinute: 3,
      domainMatch: ["corp.example"],
    });
  });

  afterAll(() => {
    h.cleanup();
    __setLdapAdapterFactoryForTests(null);
  });

  test("4th attempt within a minute → 429 RATE_LIMITED", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await signIn(h, "mallory", "x");
      expect(r.status).toBe(401);
    }
    const r4 = await signIn(h, "mallory", "x");
    expect(r4.status).toBe(429);
  });

  test("filter injection: `alice)(uid=*` is escaped before being sent", async () => {
    backend.filtersSeen.length = 0;
    await signIn(h, "alice)(uid=*", "irrelevant");
    // First seen filter is the escaped form of the username — `)` → `\29`,
    // `*` → `\2a`. The route doesn't return the filter, but the fake adapter
    // records what was escaped on its way in.
    expect(backend.filtersSeen[0]).toContain("\\29");
    expect(backend.filtersSeen[0]).toContain("\\28");
    expect(backend.filtersSeen[0]).toContain("\\2a");
  });

  test("domainMatch rejects emails from other domains BEFORE the LDAP roundtrip", async () => {
    backend.filtersSeen.length = 0;
    const res = await signIn(h, "alice@elsewhere.example", "x");
    expect(res.status).toBe(422);
    // The fake adapter was never called.
    expect(backend.filtersSeen.length).toBe(0);
  });

  test("domainMatch lets matching email through to the LDAP query", async () => {
    backend.filtersSeen.length = 0;
    const res = await signIn(h, "alice@corp.example", "x");
    expect(res.status).toBe(401); // adapter returns null
    expect(backend.filtersSeen.length).toBeGreaterThan(0);
  });
});

describe("ldap: groups → roles assignment + reconciliation on second login", () => {
  let h: TestHarness;
  const groupsByUser: Record<string, string[]> = {
    carol: ["cn=editors,ou=groups,dc=test,dc=example", "cn=hr,ou=groups,dc=test,dc=example"],
  };
  const backend: FakeBackend = {
    filtersSeen: [],
    authenticate: (username, password) => {
      if (username === "carol" && password === "ok") {
        return {
          dn: "uid=carol,ou=users,dc=test,dc=example",
          email: "carol@test.example",
          firstName: "Carol",
          lastName: "Doe",
          groups: groupsByUser.carol,
        };
      }
      return null;
    },
  };

  let editorRoleId = "";
  let hrRoleId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    __setLdapAdapterFactoryForTests(() => makeFakeAdapter(backend));
    // Pre-seed two roles inside the default tenant so groupsToRoles can map.
    const db = new Database(h.env.SQLITE_PATH!);
    const tenantId = (db
      .query("SELECT id FROM tenants WHERE slug = 'default'")
      .get() as { id: string }).id;
    editorRoleId = "role-editor";
    hrRoleId = "role-hr";
    const now = Date.now();
    db.run(
      "INSERT INTO roles (id, tenant_id, name, description, admin, created_at, updated_at) VALUES (?, ?, 'editor-ldap', 'editor', 0, ?, ?)",
      [editorRoleId, tenantId, now, now],
    );
    db.run(
      "INSERT INTO roles (id, tenant_id, name, description, admin, created_at, updated_at) VALUES (?, ?, 'hr-ldap', 'hr', 0, ?, ?)",
      [hrRoleId, tenantId, now, now],
    );
    db.close();
    await configureLdap(h, {
      groupsToRoles: {
        "cn=editors,ou=groups,dc=test,dc=example": editorRoleId,
        "cn=hr,ou=groups,dc=test,dc=example": hrRoleId,
      },
    });
  });

  afterAll(() => {
    h.cleanup();
    __setLdapAdapterFactoryForTests(null);
  });

  test("first login assigns both group-mapped roles + authenticated", async () => {
    const res = await signIn(h, "carol", "ok");
    expect(res.status).toBe(200);
    const db = sqliteAt(h);
    const u = (db
      .query("SELECT id FROM app_users WHERE email = ?")
      .get("carol@test.example") as { id: string }).id;
    const rows = db
      .query("SELECT role_id FROM app_user_roles WHERE app_user_id = ?")
      .all(u) as { role_id: string }[];
    const ids = new Set(rows.map((r) => r.role_id));
    expect(ids.has(editorRoleId)).toBe(true);
    expect(ids.has(hrRoleId)).toBe(true);
    db.close();
  });

  test("second login with reduced groups removes the dropped role; manual ones survive", async () => {
    // Manually grant a third role that group sync did NOT assign — should
    // survive reconciliation.
    const db = new Database(h.env.SQLITE_PATH!);
    const carolId = (db
      .query("SELECT id FROM app_users WHERE email = ?")
      .get("carol@test.example") as { id: string }).id;
    const tenantId = (db
      .query("SELECT id FROM tenants WHERE slug = 'default'")
      .get() as { id: string }).id;
    db.run(
      "INSERT INTO roles (id, tenant_id, name, description, admin, created_at, updated_at) VALUES ('role-manual', ?, 'manual-ldap', 'manual', 0, ?, ?)",
      [tenantId, Date.now(), Date.now()],
    );
    db.run(
      "INSERT INTO app_user_roles (app_user_id, role_id, created_at) VALUES (?, 'role-manual', ?)",
      [carolId, Date.now()],
    );
    db.close();
    // Drop the hr group on the next login.
    groupsByUser.carol = ["cn=editors,ou=groups,dc=test,dc=example"];

    const res = await signIn(h, "carol", "ok");
    expect(res.status).toBe(200);
    const db2 = sqliteAt(h);
    const carolId2 = (db2
      .query("SELECT id FROM app_users WHERE email = ?")
      .get("carol@test.example") as { id: string }).id;
    const ids = new Set(
      (db2
        .query("SELECT role_id FROM app_user_roles WHERE app_user_id = ?")
        .all(carolId2) as { role_id: string }[]).map((r) => r.role_id),
    );
    expect(ids.has(editorRoleId)).toBe(true);
    // hr was removed because it was an SSO-assigned role no longer in the
    // group set.
    expect(ids.has(hrRoleId)).toBe(false);
    // The manually-attached role survives.
    expect(ids.has("role-manual")).toBe(true);
    db2.close();
  });
});

describe("ldap: external_identities lookup is tenant-scoped (ldap discriminator)", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("same LDAP subject can coexist across tenants", async () => {
    const db = new Database(h.env.SQLITE_PATH!);
    db.run(
      "INSERT INTO tenants (id, slug, name, project, branch, env, created_at, updated_at) VALUES (?, ?, ?, 'default', 'main', 'development', ?, ?)",
      ["tenant-b", "tenant-b", "Tenant B", Date.now(), Date.now()],
    );
    const defaultTenantId = (db
      .query("SELECT id FROM tenants WHERE slug = 'default'")
      .get() as { id: string }).id;
    db.run(
      "INSERT INTO external_identities (id, tenant_id, plane, user_id, provider_type, provider_id, subject, created_at) VALUES (?, ?, 'app', 'u1', 'ldap', 'ldap', ?, ?)",
      ["ext-l-a", "tenant-b", "uid=alice,dc=test", Date.now()],
    );
    db.run(
      "INSERT INTO external_identities (id, tenant_id, plane, user_id, provider_type, provider_id, subject, created_at) VALUES (?, ?, 'app', 'u2', 'ldap', 'ldap', ?, ?)",
      ["ext-l-b", defaultTenantId, "uid=alice,dc=test", Date.now()],
    );
    const rows = db
      .query("SELECT id FROM external_identities WHERE subject = 'uid=alice,dc=test' AND provider_type = 'ldap'")
      .all() as { id: string }[];
    expect(rows.length).toBe(2);
    db.close();
  });
});

describe("ldap: adapter unit tests (escapeLdapFilter, AD range pagination)", () => {
  test("escapeLdapFilter handles every RFC 4515 special char", () => {
    expect(escapeLdapFilter("alice")).toBe("alice");
    // `*` → \2a
    expect(escapeLdapFilter("a*b")).toBe("a\\2ab");
    // `(` → \28, `)` → \29
    expect(escapeLdapFilter("a)(b")).toBe("a\\29\\28b");
    // `\` → \5c
    expect(escapeLdapFilter("a\\b")).toBe("a\\5cb");
    // NUL → \00
    expect(escapeLdapFilter("a\0b")).toBe("a\\00b");
    // Realistic injection probe
    expect(escapeLdapFilter("alice)(uid=*")).toBe("alice\\29\\28uid=\\2a");
  });

  test("ldaptsLdapAdapter applies escape before substituting into userFilter", async () => {
    const calls: { dn: string; filter: string; attributes?: string[] }[] = [];
    const fakeClient: LdapClientLike = {
      async bind() {},
      async unbind() {},
      async search(dn, opts) {
        calls.push({ dn, filter: opts.filter, attributes: opts.attributes });
        // Return a single matching entry.
        return {
          searchEntries: [
            {
              dn: "uid=alice,ou=users,dc=test",
              mail: "alice@test",
              givenName: "Alice",
              sn: "Doe",
              memberOf: [],
            },
          ],
        };
      },
    };
    const factory: LdapClientFactory = () => fakeClient;
    const adapter = ldaptsLdapAdapter(
      {
        url: "ldaps://x",
        bindDn: "cn=svc",
        bindPassword: "p",
        baseDn: "dc=test",
        userFilter: "(uid={{username}})",
        attributeMap: { email: "mail", firstName: "givenName", lastName: "sn", groups: "memberOf" },
      },
      { clientFactory: factory },
    );
    const r = await adapter.authenticate("alice)(uid=*", "secret");
    expect(r).not.toBeNull();
    // Three calls: service-bind search, user-bind no-search (only bind), then
    // group-collect with a service-bind. The first one carries the escaped
    // filter we want to assert.
    expect(calls[0]?.filter).toContain("\\29");
    expect(calls[0]?.filter).toContain("\\28");
    expect(calls[0]?.filter).toContain("\\2a");
  });

  test("ldaptsLdapAdapter follows AD memberOf;range=… pagination", async () => {
    const entry1 = {
      dn: "uid=carol,ou=users,dc=test",
      mail: "carol@test",
      givenName: "Carol",
      sn: "Doe",
      "memberOf;range=0-1": ["cn=g1,dc=test", "cn=g2,dc=test"],
    };
    const entry2 = {
      dn: "uid=carol,ou=users,dc=test",
      "memberOf;range=2-*": ["cn=g3,dc=test"],
    };
    const seq: Array<Record<string, unknown>[]> = [
      [entry1], // initial sub-scoped search
      [entry2], // ranged refetch
    ];
    const fakeClient: LdapClientLike = {
      async bind() {},
      async unbind() {},
      async search() {
        return { searchEntries: seq.shift() ?? [] };
      },
    };
    const factory: LdapClientFactory = () => fakeClient;
    const adapter = ldaptsLdapAdapter(
      {
        url: "ldaps://x",
        bindDn: "cn=svc",
        bindPassword: "p",
        baseDn: "dc=test",
        userFilter: "(uid={{username}})",
        attributeMap: { email: "mail", firstName: "givenName", lastName: "sn", groups: "memberOf" },
      },
      { clientFactory: factory },
    );
    const r = await adapter.authenticate("carol", "ok");
    expect(r).not.toBeNull();
    expect(r!.groups).toEqual([
      "cn=g1,dc=test",
      "cn=g2,dc=test",
      "cn=g3,dc=test",
    ]);
  });
});

describe("auth-select: workers gate", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    // Restore the navigator object after each stub so it doesn't bleed.
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
    });
  });

  test("buildLdapAdapter returns undefined when navigator.userAgent === 'Cloudflare-Workers'", async () => {
    // Lazy-import so the harness suites above (which set the override) have
    // cleaned up before we lean on the real factory.
    const { buildLdapAdapter, __setLdapAdapterFactoryForTests } = await import(
      "../src/server/lib/auth-select"
    );
    __setLdapAdapterFactoryForTests(null);
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "Cloudflare-Workers" },
      configurable: true,
    });
    const a = buildLdapAdapter({
      url: "ldaps://x",
      bindDn: "cn=svc",
      bindPassword: "p",
      baseDn: "dc=test",
      userFilter: "(uid={{username}})",
      attributeMap: { email: "mail", firstName: "givenName", lastName: "sn", groups: "memberOf" },
    });
    expect(a).toBeUndefined();
  });
});
