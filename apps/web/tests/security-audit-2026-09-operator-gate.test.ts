/**
 * Regression gates for the 2026-09 pre-production audit, phase 1:
 * **instance-global routes gated on the self-serve workspace `admin` role.**
 *
 * The premise, unchanged since the 2026-07 audit and now confirmed on six more
 * route groups: `POST /api/tenants` is open to any authenticated user
 * (`WORKSPACE_CREATION` defaults to `open`) and grants the creator
 * `SYSTEM_ROLES.admin` **in the workspace they just made**, while
 * `tenantMiddleware` recomputes `auth.roles` per ACTIVE workspace. So
 * "workspace admin" is a self-serve, low-trust principal and can never
 * authorize power that spans the whole database. `services/roles/guards.ts`
 * has said so in writing since that audit; these six route groups were not
 * honouring it.
 *
 * Each block asserts BOTH directions, because only the pair distinguishes the
 * two gates. Every spec in the suite that already touched these routes drove
 * the FIRST signup — who is the operator — so all of them passed under either
 * gate and none of them would have caught the regression. That is the hole
 * this file fills, and it is why the "operator still can" test in each block
 * matters as much as the refusal.
 *
 * What is deliberately NOT here: the `tenantId IS NULL` write clauses on
 * panels/dashboards, the public embed's unauthenticated `sql` execution, and
 * `groupsToRoles` write-time validation. All three are real and all three are
 * separate findings — see the audit roadmap's later phases.
 *
 * Cast, per `security-audit-2026-07.test.ts`:
 *   - **operator** — the first signup. Auto-promoted to `admin` in the default
 *     workspace, which is what `isInstanceOperator` recognises.
 *   - **attacker** — a later signup, `admin` in the `evil` workspace they
 *     created and nowhere else.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { dbKeyMaterial, invalidateSigningKeys } from "../src/server/services/signing-keys";

const JSON_HEADERS = { "Content-Type": "application/json" };
const PASSWORD = "correct-horse-battery";

const signIn = (h: TestHarness, email: string) =>
  h.fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: PASSWORD }),
  });

const signOut = (h: TestHarness) => h.fetch("/api/auth/sign-out", { method: "POST" });

const signUp = async (h: TestHarness, email: string) => {
  const res = await h.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: PASSWORD, name: email }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
};

interface Cast {
  h: TestHarness;
  operatorEmail: string;
  attackerEmail: string;
  /** The attacker's own workspace — pinned via `X-Backlex-Tenant` so they are
   *  admin of the ACTIVE workspace, which is the exact shape of the bypass. */
  evilSlug: string;
  evilTenantId: string;
}

/** operator → default workspace; attacker → self-created `evil` workspace.
 *  Leaves the jar holding the ATTACKER, so a block's refusal tests need no
 *  sign-in of their own. */
const buildCast = async (h: TestHarness): Promise<Cast> => {
  const suffix = `${Date.now()}`.slice(-7);
  const operator = await seedAdmin(h, `operator-${suffix}@example.test`);

  await signOut(h);
  const attackerEmail = `attacker-${suffix}@example.test`;
  await signUp(h, attackerEmail);

  const created = await h.fetch("/api/tenants", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: `Evil ${suffix}` }),
  });
  expect(created.status, "the attacker can mint their own workspace").toBe(201);
  const evil = (await created.json()) as { data: { id: string; slug: string } };

  return {
    h,
    operatorEmail: operator.email,
    attackerEmail,
    evilSlug: evil.data.slug,
    evilTenantId: evil.data.id,
  };
};

/** Headers that pin the attacker to the workspace they administer. */
const asAttacker = (cast: Cast, extra: Record<string, string> = {}) => ({
  ...extra,
  "X-Backlex-Tenant": cast.evilSlug,
});

/** Switch the jar to the operator, active in `default`. */
const becomeOperator = async (cast: Cast) => {
  await signOut(cast.h);
  expect((await signIn(cast.h, cast.operatorEmail)).ok).toBe(true);
};

const asOperator = (extra: Record<string, string> = {}) => ({
  ...extra,
  "X-Backlex-Tenant": "default",
});

// ---------------------------------------------------------------------------
// 1 — signing keys
// ---------------------------------------------------------------------------

describe("signing keys require the instance operator", () => {
  let cast: Cast;
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    cast = await buildCast(h);
  });
  afterAll(() => h.cleanup());

  // The keyring is one list for the whole instance — `services/signing-keys.ts`
  // never reads `tenantId` and the `in_use` row signs every workspace's
  // app-plane access tokens. Importing a key you hold is therefore a token
  // forgery primitive against every OTHER workspace.
  test("a self-created workspace admin cannot list the keyring", async () => {
    const res = await h.fetch("/api/admin/signing-keys", { headers: asAttacker(cast) });
    expect(res.status).toBe(403);
  });

  test("nor generate a key", async () => {
    const res = await h.fetch("/api/admin/signing-keys", {
      method: "POST",
      headers: asAttacker(cast, JSON_HEADERS),
      body: JSON.stringify({ alg: "ES256" }),
    });
    expect(res.status).toBe(403);
  });

  // The finding's actual exploit: a key whose PRIVATE half the caller already
  // holds. Refused before the PEM is even parsed, so the 403 is about who is
  // asking rather than about what they sent.
  test("nor import one they hold the private half of", async () => {
    const res = await h.fetch("/api/admin/signing-keys/import", {
      method: "POST",
      headers: asAttacker(cast, JSON_HEADERS),
      body: JSON.stringify({ privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----" }),
    });
    expect(res.status).toBe(403);
  });

  test("the instance operator still can", async () => {
    await becomeOperator(cast);
    const list = await h.fetch("/api/admin/signing-keys", { headers: asOperator() });
    expect(list.status).toBe(200);

    const gen = await h.fetch("/api/admin/signing-keys", {
      method: "POST",
      headers: asOperator(JSON_HEADERS),
      body: JSON.stringify({ alg: "ES256" }),
    });
    expect(gen.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// 2 — a standby key is published, not trusted
// ---------------------------------------------------------------------------

describe("a standby signing key is published but does not verify", () => {
  let h: TestHarness;
  let kid: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h, `operator-standby-${`${Date.now()}`.slice(-7)}@example.test`);
    const gen = await h.fetch("/api/admin/signing-keys", {
      method: "POST",
      headers: asOperator(JSON_HEADERS),
      body: JSON.stringify({ alg: "ES256" }),
    });
    expect(gen.status).toBe(201);
    const { data } = (await gen.json()) as { data: { kid: string; status: string; published: boolean } };
    expect(data.status, "a generated key starts in standby").toBe("standby");
    expect(data.published).toBe(true);
    kid = data.kid;
    // `dbKeyMaterial` caches per db handle for KEY_CACHE_TTL_MS; the generate
    // path invalidates, but this spec reads the material directly rather than
    // through a request, so it says so explicitly.
    invalidateSigningKeys();
  });
  afterAll(() => h.cleanup());

  /**
   * Defence in depth for finding 1, and the half that survives a key an
   * operator imported in good faith.
   *
   * `standby` exists so verifiers can CACHE a key before it signs — a statement
   * about the JWKS DOCUMENT, not about what this instance ACCEPTS. The two
   * halves are asserted separately and both are load-bearing: assert only the
   * publication and the fix could be reverted with the spec still green;
   * assert only the exclusion and deleting the key from the JWKS entirely
   * would pass, which would break rotation.
   *
   * Read at the service layer because there is deliberately no way to obtain a
   * standby-signed token through the API — `material.signing` is only ever set
   * for `in_use` — so an HTTP-level assertion here could only ever be vacuous.
   */
  test("the standby kid is in the published JWKS", async () => {
    const jwks = await h.fetch("/.well-known/jwks.json");
    expect(jwks.status).toBe(200);
    const doc = (await jwks.json()) as { keys: { kid: string }[] };
    expect(doc.keys.map((k) => k.kid)).toContain(kid);
  });

  test("but this instance will not verify a token signed by it", async () => {
    const built = await buildContext(h.env);
    const material = await dbKeyMaterial({ db: built.db, dialect: built.dialect, env: h.env });
    expect(material, "the row exists, so there is material to read").not.toBeNull();
    expect(material!.jwks.map((j) => j.kid)).toContain(kid);
    expect(material!.verify.has(kid)).toBe(false);
    // Nothing signs while the only key is standby — the state's whole point.
    expect(material!.signing).toBeNull();
  });

  test("and promoting it makes it verify", async () => {
    // The other direction. Without it, never adding a key to `verify` at all
    // would pass the assertion above and break every app-plane bearer token.
    const list = await h.fetch("/api/admin/signing-keys", { headers: asOperator() });
    const rows = ((await list.json()) as { data: { id: string; kid: string }[] }).data;
    const row = rows.find((r) => r.kid === kid);
    expect(row).toBeDefined();

    const promoted = await h.fetch(`/api/admin/signing-keys/${row!.id}/promote`, {
      method: "POST",
      headers: asOperator(JSON_HEADERS),
    });
    expect(promoted.status).toBe(200);
    invalidateSigningKeys();

    const built = await buildContext(h.env);
    const material = await dbKeyMaterial({ db: built.db, dialect: built.dialect, env: h.env });
    expect(material!.verify.has(kid)).toBe(true);
    expect(material!.signing?.kid).toBe(kid);
  });

  test("each kid appears exactly once in the JWKS", async () => {
    // `mergeEnvVerifiers` used to dedupe its jwks push against `verify`. Once
    // standby stopped populating `verify`, that check went false for a key in
    // both places — the documented "move off env vars" migration, where the
    // imported PEM is also still in `AUTH_JWT_PRIVATE_KEY` — and the kid was
    // published twice.
    const jwks = await h.fetch("/.well-known/jwks.json");
    const doc = (await jwks.json()) as { keys: { kid: string }[] };
    const kids = doc.keys.map((k) => k.kid);
    expect(kids.length).toBe(new Set(kids).size);
  });
});

// ---------------------------------------------------------------------------
// 3 — control-plane SAML + LDAP
// ---------------------------------------------------------------------------

describe("control-plane SSO config requires the instance operator", () => {
  let cast: Cast;
  let h: TestHarness;

  beforeAll(async () => {
    // Enabled by default (`isPlatformSsoEnabled` is a kill-switch, not an
    // opt-in), but named explicitly so the block is not silently vacuous if
    // that default ever flips — a 404 would otherwise read as a pass.
    h = makeHarness({ PLATFORM_SSO_ENABLED: "true" });
    cast = await buildCast(h);
  });
  afterAll(() => h.cleanup());

  // These rows are trust anchors for the CONTROL plane. Registering an IdP you
  // run, with `linkByVerifiedEmail`, mints a session as any operator whose
  // address you can name.
  test("a self-created workspace admin cannot list platform SAML providers", async () => {
    const res = await h.fetch("/api/admin/platform-saml/providers", { headers: asAttacker(cast) });
    expect(res.status).toBe(403);
  });

  test("nor register one pointing at an IdP they control", async () => {
    const res = await h.fetch("/api/admin/platform-saml/providers", {
      method: "POST",
      headers: asAttacker(cast, JSON_HEADERS),
      body: JSON.stringify({
        name: "evil",
        entityId: "https://evil.test/idp",
        ssoUrl: "https://evil.test/sso",
        idpCertPem: "-----BEGIN CERTIFICATE-----\nevil\n-----END CERTIFICATE-----",
        spEntityId: "https://victim.test/sp",
        linkByVerifiedEmail: true,
      }),
    });
    expect(res.status).toBe(403);
  });

  // The authorization check runs BEFORE the feature flag, so a refusal never
  // doubles as a probe for whether this deployment has enterprise SSO.
  test("nor read the platform LDAP config", async () => {
    const res = await h.fetch("/api/admin/platform-ldap-config", { headers: asAttacker(cast) });
    expect(res.status).toBe(403);
  });

  // The write is the dangerous half and it lands on EVERY runtime — only the
  // outbound bind needs a non-edge one, so `isEdgeRuntime` is not a gate.
  test("nor re-point operator sign-in at a directory they run", async () => {
    const res = await h.fetch("/api/admin/platform-ldap-config", {
      method: "PUT",
      headers: asAttacker(cast, JSON_HEADERS),
      body: JSON.stringify({ enabled: true, url: "ldap://evil.test:389", baseDn: "dc=evil,dc=test" }),
    });
    expect(res.status).toBe(403);
  });

  test("the instance operator still can", async () => {
    await becomeOperator(cast);
    const saml = await h.fetch("/api/admin/platform-saml/providers", { headers: asOperator() });
    expect(saml.status).toBe(200);
    const ldap = await h.fetch("/api/admin/platform-ldap-config", { headers: asOperator() });
    expect(ldap.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 4 — the OAuth client registry
// ---------------------------------------------------------------------------

describe("the OAuth client registry requires the instance operator", () => {
  let cast: Cast;
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    cast = await buildCast(h);
  });
  afterAll(() => h.cleanup());

  // `oauth_applications` / `oauth_consents` / `oauth_access_tokens` are
  // better-auth tables with NO tenant column, and the service functions filter
  // on `clientId`/`userId` alone — so tenant scoping here is not merely absent,
  // it is unrepresentable. Listing is cross-tenant disclosure; delete and
  // revoke are denial of service against every other workspace's connectors.
  test("a self-created workspace admin cannot list every client on the instance", async () => {
    const res = await h.fetch("/api/admin/oauth-clients", { headers: asAttacker(cast) });
    expect(res.status).toBe(403);
  });

  test("nor delete one another workspace depends on", async () => {
    const res = await h.fetch("/api/admin/oauth-clients/some-client-id", {
      method: "DELETE",
      headers: asAttacker(cast),
    });
    expect(res.status).toBe(403);
  });

  test("nor enumerate who has consented", async () => {
    const res = await h.fetch("/api/admin/oauth-clients/grants", { headers: asAttacker(cast) });
    expect(res.status).toBe(403);
  });

  test("nor revoke another user's grant", async () => {
    const res = await h.fetch("/api/admin/oauth-clients/grants/revoke", {
      method: "POST",
      headers: asAttacker(cast, JSON_HEADERS),
      body: JSON.stringify({ clientId: "some-client-id", userId: "some-user-id" }),
    });
    expect(res.status).toBe(403);
  });

  test("the instance operator still can", async () => {
    await becomeOperator(cast);
    const clients = await h.fetch("/api/admin/oauth-clients", { headers: asOperator() });
    expect(clients.status).toBe(200);
    const grants = await h.fetch("/api/admin/oauth-clients/grants", { headers: asOperator() });
    expect(grants.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5 — `sql` panels
// ---------------------------------------------------------------------------

describe("`sql` panels require the instance operator, other panel kinds do not", () => {
  let cast: Cast;
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    cast = await buildCast(h);
  });
  afterAll(() => h.cleanup());

  // `isReadOnly` constrains the VERB and says nothing about which TABLES a
  // statement reads — the string reaches `sql.raw` with no tenant predicate
  // and no permission clamp. That is `POST /api/admin/db/sql/run` behind a
  // weaker gate, so it takes the same one.
  test("a self-created workspace admin cannot preview raw SQL", async () => {
    const res = await h.fetch("/api/admin/panels/preview", {
      method: "POST",
      headers: asAttacker(cast, JSON_HEADERS),
      body: JSON.stringify({ kind: "sql", sql: "SELECT id, email FROM users" }),
    });
    expect(res.status).toBe(403);
  });

  test("nor save an sql panel", async () => {
    const res = await h.fetch("/api/admin/panels", {
      method: "POST",
      headers: asAttacker(cast, JSON_HEADERS),
      body: JSON.stringify({
        name: "exfil",
        kind: "sql",
        viz: "table",
        sql: "SELECT id, email FROM users",
      }),
    });
    expect(res.status).toBe(403);
  });

  // `kind` is optional on a patch, so a body of `{sql}` alone must trip the
  // gate too — testing `kind` would miss exactly the rewrite that matters.
  test("nor smuggle SQL into a patch that omits `kind`", async () => {
    const created = await h.fetch("/api/admin/panels", {
      method: "POST",
      headers: asAttacker(cast, JSON_HEADERS),
      body: JSON.stringify({ name: "innocent", kind: "static", viz: "counter" }),
    });
    expect(created.status, "a static panel is fine for a workspace admin").toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const patched = await h.fetch(`/api/admin/panels/${data.id}`, {
      method: "PATCH",
      headers: asAttacker(cast, JSON_HEADERS),
      body: JSON.stringify({ sql: "SELECT id, email FROM users" }),
    });
    expect(patched.status).toBe(403);
  });

  // The point of gating per KIND rather than per ROUTE: the other four kinds
  // are tenant-clamped and must stay reachable, or the fix has taken the
  // Insights page away from every workspace admin on the instance.
  test("but the non-SQL panel kinds stay open to a workspace admin", async () => {
    const list = await h.fetch("/api/admin/panels", { headers: asAttacker(cast) });
    expect(list.status).toBe(200);

    const created = await h.fetch("/api/admin/panels", {
      method: "POST",
      headers: asAttacker(cast, JSON_HEADERS),
      body: JSON.stringify({ name: "ok", kind: "static", viz: "counter" }),
    });
    expect(created.status).toBe(201);
  });

  test("the instance operator still can run SQL", async () => {
    await becomeOperator(cast);
    const res = await h.fetch("/api/admin/panels/preview", {
      method: "POST",
      headers: asOperator(JSON_HEADERS),
      body: JSON.stringify({ kind: "sql", sql: "SELECT 1 AS one" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data).toEqual([{ one: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// 6 — a saved sql panel run through the dashboard runner
// ---------------------------------------------------------------------------

describe("the dashboard runner refuses a saved sql panel for a non-operator", () => {
  let cast: Cast;
  let h: TestHarness;
  let dashboardId: string;

  beforeAll(async () => {
    h = makeHarness();
    cast = await buildCast(h);

    // Seeded through the operator's SQL console rather than the API, because
    // the API can no longer produce this row and that is the point: it is what
    // every `sql` panel written BEFORE this change looks like. Gating authoring
    // alone would leave exactly these rows executable by the role that was
    // never entitled to write them.
    //
    // The operator cannot use the panels API here either — visiting a workspace
    // they are not a member of gives them `operator-visit` access and the
    // workspace's scoped role set, which for a non-member is empty. That is
    // correct: the operator shortcut decides WHETHER they may act somewhere,
    // never AS WHAT.
    await becomeOperator(cast);
    dashboardId = `dash-${cast.evilTenantId}`;
    const panelId = `panel-${cast.evilTenantId}`;
    const seed = await h.fetch("/api/admin/db/sql/run?writes=1", {
      method: "POST",
      headers: { ...asOperator(JSON_HEADERS), "x-backlex-confirm": "yes" },
      body: JSON.stringify({
        sql:
          `INSERT INTO dashboards (id, tenant_id, name, embed_enabled, created_at, updated_at) VALUES ('${dashboardId}', '${cast.evilTenantId}', 'shared', 0, 0, 0); ` +
          `INSERT INTO saved_panels (id, tenant_id, name, kind, sql, viz, dashboard_id, created_at, updated_at) VALUES ('${panelId}', '${cast.evilTenantId}', 'vetted', 'sql', 'SELECT 1 AS one', 'table', '${dashboardId}', 0, 0)`,
      }),
    });
    expect(seed.status, "seed the pre-existing sql panel").toBe(200);
  });
  afterAll(() => h.cleanup());

  // The workspace's OWN admin — a member, so `ADMIN_GATE` passes and the
  // request reaches the runner. This is the caller the gate is about.
  test("the workspace admin gets an explanation and no rows", async () => {
    await signOut(h);
    expect((await signIn(h, cast.attackerEmail)).ok).toBe(true);
    const res = await h.fetch(`/api/admin/dashboards/${dashboardId}/run`, {
      method: "POST",
      headers: asAttacker(cast, JSON_HEADERS),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { kind: string; data: unknown[]; error?: string }[] };
    const tile = body.data.find((p) => p.kind === "sql");
    // Per-panel `error` rather than a thrown 403: one tile the caller may not
    // run must not blank a dashboard whose other tiles they are entitled to.
    expect(tile, "the sql tile is still listed").toBeDefined();
    expect(tile?.data).toEqual([]);
    expect(tile?.error).toContain("instance operator");
  });

  // The other half of the pair. Without it, deleting the `sql` branch outright
  // would also pass — the refusal alone proves nothing about the feature.
  test("the operator gets its rows", async () => {
    await becomeOperator(cast);
    // Their own workspace, so `ADMIN_GATE` is satisfied by a real role.
    const dash = await h.fetch("/api/admin/dashboards", {
      method: "POST",
      headers: asOperator(JSON_HEADERS),
      body: JSON.stringify({ name: "operator-own" }),
    });
    expect(dash.status).toBe(201);
    const ownId = ((await dash.json()) as { data: { id: string } }).data.id;

    const panel = await h.fetch("/api/admin/panels", {
      method: "POST",
      headers: asOperator(JSON_HEADERS),
      body: JSON.stringify({
        name: "vetted",
        kind: "sql",
        viz: "table",
        sql: "SELECT 1 AS one",
        dashboardId: ownId,
      }),
    });
    expect(panel.status, "the operator may author an sql panel").toBe(201);

    const res = await h.fetch(`/api/admin/dashboards/${ownId}/run`, {
      method: "POST",
      headers: asOperator(JSON_HEADERS),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { kind: string; data: unknown[]; error?: string }[] };
    const tile = body.data.find((p) => p.kind === "sql");
    expect(tile?.error).toBeUndefined();
    expect(tile?.data).toEqual([{ one: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// 6b — the public embed inherits the same clamp
// ---------------------------------------------------------------------------

describe("a public embed does not run an sql panel", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h, `op-embed-${`${Date.now()}`.slice(-7)}@example.test`);
  });
  afterAll(() => h.cleanup());

  /**
   * Not a Faz 1 finding — the audit files this under the row-level phase — but
   * `runPanel`'s `allowRawSql` defaults to FALSE, so the embed path closed with
   * it, and that is worth pinning HERE, where the default lives. Whoever
   * reintroduces an `allowRawSql = true` default fails this test rather than
   * discovering it from the embed side much later.
   *
   * `GET /api/public/dashboards/{token}` has no `requireUser` at all — its own
   * comment says so — and the `scope` clamp the other panel kinds apply cannot
   * narrow a raw statement, since the SQL names its own tables. Possession of
   * the token used to mean every SELECT on the dashboard ran verbatim against
   * the whole database, `users` and `signing_keys` included.
   */
  test("the token gets the tile, an explanation, and no rows", async () => {
    const dash = await h.fetch("/api/admin/dashboards", {
      method: "POST",
      headers: asOperator(JSON_HEADERS),
      body: JSON.stringify({ name: "embed" }),
    });
    expect(dash.status).toBe(201);
    const id = ((await dash.json()) as { data: { id: string } }).data.id;

    const panel = await h.fetch("/api/admin/panels", {
      method: "POST",
      headers: asOperator(JSON_HEADERS),
      body: JSON.stringify({
        name: "leak",
        kind: "sql",
        viz: "table",
        sql: "SELECT 1 AS one",
        dashboardId: id,
      }),
    });
    expect(panel.status, "the operator may author it").toBe(201);

    const share = await h.fetch(`/api/admin/dashboards/${id}/share`, {
      method: "POST",
      headers: asOperator(JSON_HEADERS),
      body: "{}",
    });
    expect(share.status).toBe(200);
    // The token comes back at the top level, not under `data`.
    const { token } = (await share.json()) as { token: string };
    expect(token).toMatch(/^dsh_/);

    // No cookie, no bearer — the embed as a stranger sees it.
    const pub = await h.app.request(`/api/public/dashboards/${token}`);
    expect(pub.status).toBe(200);
    const body = (await pub.json()) as {
      panels?: { kind: string; data: unknown[]; error?: string }[];
      data?: { panels: { kind: string; data: unknown[]; error?: string }[] };
    };
    const panels = body.data?.panels ?? body.panels ?? [];
    const tile = panels.find((p) => p.kind === "sql");
    expect(tile, "the tile is still rendered, just empty").toBeDefined();
    expect(tile?.data).toEqual([]);
    expect(tile?.error).toContain("instance operator");
  });
});

// ---------------------------------------------------------------------------
// 7 — the global feature-flag default
// ---------------------------------------------------------------------------

describe("the global feature-flag default requires the instance operator", () => {
  let cast: Cast;
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    cast = await buildCast(h);
  });
  afterAll(() => h.cleanup());

  // `?scope=global` writes the `tenant_id IS NULL` row every workspace
  // inherits when it has none of its own. Not in the audit's original five —
  // found by the completeness sweep over every `SYSTEM_ROLES.admin` gate.
  test("a self-created workspace admin cannot write the global default", async () => {
    const res = await h.fetch("/api/admin/feature-flags/some-flag?scope=global", {
      method: "PUT",
      headers: asAttacker(cast, JSON_HEADERS),
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
  });

  test("nor delete it", async () => {
    const res = await h.fetch("/api/admin/feature-flags/some-flag?scope=global", {
      method: "DELETE",
      headers: asAttacker(cast),
    });
    expect(res.status).toBe(403);
  });

  // The workspace-scoped branch is untouched — this is the half that must keep
  // working, and a gate on the whole route would have taken it away.
  test("but their own workspace's flag is still theirs to set", async () => {
    const res = await h.fetch("/api/admin/feature-flags/some-flag", {
      method: "PUT",
      headers: asAttacker(cast, JSON_HEADERS),
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
  });

  test("the instance operator still can set the global default", async () => {
    await becomeOperator(cast);
    const res = await h.fetch("/api/admin/feature-flags/some-flag?scope=global", {
      method: "PUT",
      headers: asOperator(JSON_HEADERS),
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 8 — what the SPA is told
// ---------------------------------------------------------------------------

describe("/api/me reports operator standing separately from the admin role", () => {
  let cast: Cast;
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    cast = await buildCast(h);
  });
  afterAll(() => h.cleanup());

  /**
   * The field the admin SPA needs in order to draw these surfaces honestly
   * rather than render them into a 403. Both assertions matter: `isAdmin`
   * staying TRUE for the attacker is what proves the two are different
   * questions — if the fix had narrowed `isAdmin` instead, every
   * workspace-scoped admin page would have gone dark with it.
   */
  test("a self-created workspace admin is admin but not operator", async () => {
    const res = await h.fetch("/api/me", { headers: asAttacker(cast) });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { isAdmin: boolean; isOperator: boolean } };
    expect(data.isAdmin).toBe(true);
    expect(data.isOperator).toBe(false);
  });

  test("the instance operator is both", async () => {
    await becomeOperator(cast);
    const res = await h.fetch("/api/me", { headers: asOperator() });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { isAdmin: boolean; isOperator: boolean } };
    expect(data.isAdmin).toBe(true);
    expect(data.isOperator).toBe(true);
  });
});
