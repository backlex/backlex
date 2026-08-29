import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildTwoPlaneCast, json, type TwoPlaneCast } from "./fixtures/two-plane-cast";
import { TENANT_COOKIE } from "../src/server/middleware/tenant";

/**
 * Multi-tenant isolation smoke tests.
 *
 * Discovered contract (apps/web/src/server/routes/tenants.ts,
 * middleware/tenant.ts, services/seed.ts):
 *   - GET    /api/tenants            → list workspaces the caller belongs to
 *                                       (`{ data: [...], active: <id> }`)
 *   - POST   /api/tenants            → create workspace; caller becomes owner
 *   - POST   /api/tenants/switch     → sets `backlex-tenant` cookie + persists
 *                                       user.activeTenantId
 *   - Active tenant resolution: `X-Backlex-Tenant` header → cookie →
 *     user.activeTenantId → first membership → default tenant.
 *   - Default tenant slug = "default" (from ensureDefaultTenant on first req).
 *   - Collections + items are tenant-scoped; slug is unique per tenant.
 *   - Cross-tenant collection lookup throws NOT_FOUND (404), not 403/[]
 *     (loadCollection in routes/items.ts).
 */

describe("tenants: default workspace boots on first request", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("GET /api/tenants returns the auto-seeded default workspace", async () => {
    const res = await h.fetch("/api/tenants");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; slug: string; name: string; role: string }[];
      active: string | null;
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const def = body.data.find((t) => t.slug === "default");
    expect(def).toBeDefined();
    expect(def!.role).toBe("owner");
    // Active tenant is set by tenantMiddleware before the handler runs.
    expect(body.active).toBe(def!.id);
  });
});

describe("tenants: admin can create additional workspaces", () => {
  let h: TestHarness;
  const suffix = `${Date.now()}`.slice(-6);
  const tenantBName = `Tenant ${suffix}`;
  // slugify lowercases, hyphenates, caps at 24 chars: "tenant <digits>" →
  // "tenant-<digits>".
  const tenantBSlug = `tenant-${suffix}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("POST /api/tenants creates workspace and lists it with owner role", async () => {
    const create = await h.fetch("/api/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: tenantBName }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { data: { id: string; slug: string; name: string } };
    expect(created.data.slug).toBe(tenantBSlug);
    expect(created.data.name).toBe(tenantBName);

    const list = await h.fetch("/api/tenants");
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: { id: string; slug: string; role: string }[];
    };
    const b = body.data.find((t) => t.slug === tenantBSlug);
    expect(b).toBeDefined();
    expect(b!.role).toBe("owner");
    // Default tenant is still listed alongside the new one.
    expect(body.data.some((t) => t.slug === "default")).toBe(true);
  });

  test("new workspace gets a theme-palette color (--primary or --chart-1..5)", async () => {
    const create = await h.fetch("/api/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Themed ${suffix}` }),
    });
    expect(create.status).toBe(201);

    const list = await h.fetch("/api/tenants");
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: { slug: string; color: string | null }[];
    };
    const themed = body.data.find((t) => t.slug === `themed-${suffix}`);
    expect(themed).toBeDefined();
    // Part 1: workspace colors are theme CSS-variable tokens, never literals.
    expect(themed!.color).toMatch(/^var\(--(primary|chart-[1-5])\)$/);
  });
});

describe("tenants: collections and items are isolated per workspace", () => {
  let h: TestHarness;
  const suffix = `${Date.now()}`.slice(-6);
  const tenantBSlug = `tenant-${suffix}`;
  // Both tenants will use the SAME collection slug to prove uniqueness is
  // per-tenant. Use letters+digits only — collection slugs can't contain "-".
  const collSlug = `notes${suffix}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // Create tenant-B as the admin (who is automatically a member of default).
    const create = await h.fetch("/api/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Tenant ${suffix}` }),
    });
    if (!create.ok) {
      throw new Error(`tenant create failed: ${create.status} ${await create.text()}`);
    }
  });

  afterAll(() => {
    h.cleanup();
  });

  test("collection created in default tenant is not visible from tenant-B", async () => {
    // Step 1: create collection in the default workspace (X-Backlex-Tenant header).
    const createA = await h.fetch("/api/collections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Backlex-Tenant": "default",
      },
      body: JSON.stringify({
        slug: collSlug,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });
    expect(createA.status).toBe(201);
    const createdA = (await createA.json()) as { data: { slug: string; physicalTable: string } };
    expect(createdA.data.slug).toBe(collSlug);

    // Step 2: list collections in tenant-B — the slug must NOT show up.
    const listB = await h.fetch("/api/collections", {
      headers: { "X-Backlex-Tenant": tenantBSlug },
    });
    expect(listB.status).toBe(200);
    const bodyB = (await listB.json()) as { data: { slug: string }[] };
    expect(bodyB.data.some((c) => c.slug === collSlug)).toBe(false);

    // Step 3: tenant-B may create its OWN collection with the same slug — no
    // cross-tenant conflict.
    const createB = await h.fetch("/api/collections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Backlex-Tenant": tenantBSlug,
      },
      body: JSON.stringify({
        slug: collSlug,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    });
    expect(createB.status).toBe(201);
    const createdB = (await createB.json()) as { data: { slug: string; physicalTable: string } };
    expect(createdB.data.slug).toBe(collSlug);
    // Physical tables differ because derivePhysicalTable folds in tenantId.
    expect(createdB.data.physicalTable).not.toBe(createdA.data.physicalTable);

    // Step 4: each workspace's GET /api/collections/:slug resolves to its own
    // collection (no leak across the membrane).
    const getA = await h.fetch(`/api/collections/${collSlug}`, {
      headers: { "X-Backlex-Tenant": "default" },
    });
    expect(getA.status).toBe(200);
    const getB = await h.fetch(`/api/collections/${collSlug}`, {
      headers: { "X-Backlex-Tenant": tenantBSlug },
    });
    expect(getB.status).toBe(200);
  });

  test("items inserted in default tenant don't surface in tenant-B's items list", async () => {
    // Insert one item in default (collection seeded above).
    const insertA = await h.fetch(`/api/items/${collSlug}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Backlex-Tenant": "default",
      },
      body: JSON.stringify({ title: "from-default" }),
    });
    expect(insertA.status).toBe(201);
    const insertedA = (await insertA.json()) as { data: { id: string; title: string } };
    expect(insertedA.data.title).toBe("from-default");

    // tenant-B's items list for the same slug points at tenant-B's collection
    // (different physical table) — must be empty.
    const listB = await h.fetch(`/api/items/${collSlug}`, {
      headers: { "X-Backlex-Tenant": tenantBSlug },
    });
    expect(listB.status).toBe(200);
    const bodyB = (await listB.json()) as { data: { id: string }[] };
    expect(bodyB.data.length).toBe(0);

    // Reading the default-tenant row by id from tenant-B context: the
    // collection slug resolves to tenant-B's table (which has no such row).
    // Contract → 404 NOT_FOUND, not 403/empty.
    const getB = await h.fetch(`/api/items/${collSlug}/${insertedA.data.id}`, {
      headers: { "X-Backlex-Tenant": tenantBSlug },
    });
    expect(getB.status).toBe(404);

    // Default still sees its own row.
    const listA = await h.fetch(`/api/items/${collSlug}`, {
      headers: { "X-Backlex-Tenant": "default" },
    });
    expect(listA.status).toBe(200);
    const bodyA = (await listA.json()) as { data: { id: string }[] };
    expect(bodyA.data.some((r) => r.id === insertedA.data.id)).toBe(true);
  });
});

describe("tenants: a nonexistent slug in X-Backlex-Tenant is refused", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("unknown tenant header doesn't grant access to a stranger's workspace", async () => {
    // This used to fall through to firstUserTenant / ensureDefaultTenant and
    // answer 200 for a workspace the caller never named — safe in the sense
    // this test checked (never a STRANGER's workspace) and wrong in the sense
    // that matters: an explicit choice of workspace was silently replaced by a
    // different one, for reads and for writes. It is refused now, which makes
    // the original property hold more strongly — nothing is reached at all.
    const res = await h.fetch("/api/tenants", {
      headers: { "X-Backlex-Tenant": "no-such-workspace-here" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("no-such-workspace-here");
  });

  test("with no header at all the caller still lands in their own workspace", async () => {
    const res = await h.fetch("/api/tenants");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { slug: string }[]; active: string | null };
    expect(body.data.every((t) => ["default"].includes(t.slug))).toBe(true);
    expect(body.active).not.toBeNull();
  });
});

/**
 * Locks in the design contract of middleware/session.ts `loadUnfilteredRoleNames`
 * and tenant.ts:244-256 — a control-plane admin in tenant T1 may *reach* URLs
 * for an unrelated tenant T2 (so workspace-switcher UX still works), but the
 * role bundle assigned for T2 stays tenant-scoped (empty for non-members) and
 * the request gets only the baseline `authenticated` permissions in T2.
 *
 * The cross-tenant union returned by loadUnfilteredRoleNames is consulted ONLY
 * as a super-admin gate inside tenantMiddleware; it never widens auth.roles.
 * Permission middleware (`requireAdmin`) reads auth.roles which loadTenantRoleNames
 * tenant-scoped — so an admin-only endpoint must return 403 in the foreign tenant.
 *
 * ── PINNED KNOWN GAP — Phase 1 changes this deliberately ────────────────────
 *
 * What this block asserts is today's contract, not a desired one. The gate it
 * pins is `loadUnfilteredRoleNames`: an UNFILTERED union of role NAMES across
 * every workspace the caller holds a role in. `POST /api/tenants` hands the
 * RBAC `admin` role to whoever creates a workspace, so any signed-in user can
 * mint themselves a name that appears in that union — which makes the shortcut
 * self-serve rather than privileged, and lets a non-member reach every
 * workspace on the instance in read-through mode.
 *
 * Phase 1 re-keys the shortcut onto `isInstanceOperator` (`admin` in the
 * DEFAULT workspace, or `OWNER_EMAIL`) — a role a self-created workspace
 * cannot confer, and the same principal `assertWorkspaceAccess` in
 * routes/tenants.ts already uses. When that lands, these assertions change on
 * purpose and the diff should say so; that is why they are written down first
 * rather than edited quietly alongside the fix.
 */
describe("tenants: cross-tenant admin gets baseline access in foreign workspaces, not admin powers", () => {
  let h: TestHarness;
  let tenantBSlug: string;
  let adminEmail: string;

  const JSON_HEADERS = { "Content-Type": "application/json" };
  const signIn = (h: TestHarness, email: string) =>
    h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
  const signOut = (h: TestHarness) =>
    h.fetch("/api/auth/sign-out", { method: "POST" });

  beforeAll(async () => {
    h = makeHarness();

    // User A — first signup, auto-promoted to admin in `default`.
    const a = await seedAdmin(h);
    adminEmail = a.email;

    // Switch identity: sign out A, sign up user B (lands as `authenticated`).
    await signOut(h);
    const memberEmail = `member-${Date.now()}@example.test`;
    const suB = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: memberEmail,
        password: "correct-horse-battery",
        name: "Member B",
      }),
    });
    expect(suB.ok).toBe(true);

    // B creates a new workspace; B becomes owner of tenant-B. A is NOT a member.
    const suffix = `${Date.now()}`.slice(-6);
    const createT = await h.fetch("/api/tenants", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: `Cross ${suffix}` }),
    });
    expect(createT.status).toBe(201);
    const created = (await createT.json()) as { data: { id: string; slug: string } };
    tenantBSlug = created.data.slug;

    // Sign out B and sign A back in for the actual assertions.
    await signOut(h);
    const back = await signIn(h, adminEmail);
    expect(back.ok).toBe(true);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("admin reaches tenant-B URLs but auth.roles never includes 'admin' there", async () => {
    // GET /api/tenants reflects what tenantMiddleware put on `auth` for the
    // CURRENT request — list shows only workspaces A is a member of. A is
    // admin in `default`, not a member of tenant-B → tenant-B never appears
    // in A's own list (regardless of any header override).
    const own = await h.fetch("/api/tenants");
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as { data: { slug: string }[] };
    expect(ownBody.data.some((t) => t.slug === tenantBSlug)).toBe(false);
    expect(ownBody.data.some((t) => t.slug === "default")).toBe(true);
  });

  test("admin in default cannot exercise admin-only routes against tenant-B", async () => {
    // /api/roles is gated by requireAdminMw which checks
    // `auth.roles.includes("admin")`. auth.roles is set by tenantMiddleware
    // via loadTenantRoleNames(tenantId) — strictly scoped to the active
    // workspace. A has zero user_roles rows in tenant-B, so the bundle
    // resolves to empty and the gate returns 403.
    const forbidden = await h.fetch("/api/roles", {
      headers: { "X-Backlex-Tenant": tenantBSlug },
    });
    expect(forbidden.status).toBe(403);
    const body = (await forbidden.json()) as {
      error?: { code?: string };
    };
    expect(body.error?.code).toBe("FORBIDDEN");
  });

  test("the cross-tenant visit doesn't leak backlex-tenant cookie", async () => {
    // The previous test routed A through tenantB via header. tenantMiddleware
    // must NOT have written a tenantB cookie back — otherwise every following
    // request without a header would silently keep landing in the foreign
    // workspace. Clearing/refusing the cookie on the pass-through path is the
    // fix locked in here.
    const jar = h.cookies();
    expect(jar[TENANT_COOKIE]).not.toBe(tenantBSlug);
    expect(jar[TENANT_COOKIE]).not.toBeDefined();
  });

  test("the same admin endpoint succeeds in A's own workspace without an override", async () => {
    // With the cookie cleared, a header-less request falls back through
    // user.activeTenantId / firstUserTenant — which is `default`, A's home
    // workspace. requireAdmin now sees A's admin role and returns 200.
    const ok = await h.fetch("/api/roles");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: { name: string }[] };
    // Admin/authenticated/public are auto-seeded per workspace.
    expect(body.data.some((r) => r.name === "admin")).toBe(true);
  });
});

/**
 * What a non-member cross-tenant visitor can actually DO once the shortcut has
 * let them in.
 *
 * The block above pins that such a visitor is not an ADMIN in the foreign
 * workspace. That is only half the question, and the quiet half is the other
 * one: `tenantMiddleware` leaves `auth.roles` empty for them, but the
 * permission resolver does not need `auth.roles` to grant anything — it
 * LEFT JOINs `user_roles` and unconditionally includes the active workspace's
 * builtin `authenticated` role for any signed-in control-plane identity
 * (services/permissions.ts). So the visitor arrives holding the foreign
 * workspace's `authenticated` bundle.
 *
 * And `services/seed.ts::seedOwnerScopedPermissions` grants that role an
 * UNCONDITIONAL `create` on every owner-scoped collection — read/update/delete
 * are fenced by `owner_id == $user.id`, create is not, because the row does not
 * exist yet to own. The two facts compose into WRITE access for a stranger.
 *
 * `ownerA` is the principal that matters here rather than the operator: they
 * are `admin` only in the workspace they created for themselves, which is a
 * role any signed-in user can mint via `POST /api/tenants`. Phase 1 re-keys the
 * shortcut onto `isInstanceOperator`, and this test is what will show the
 * change: today it pins that the write LANDS.
 */
describe("tenants: a non-member cross-tenant visitor's write powers in a foreign workspace", () => {
  let cast: TwoPlaneCast;
  const suffix = `${Date.now()}`.slice(-6);
  // Collection slugs take letters and digits only — no hyphen.
  const collSlug = `notes${suffix}`;

  /** A call into workspace B, chosen explicitly by header rather than by
   *  whatever the shared cookie jar happens to hold. */
  const inB = (caller: TwoPlaneCast["ownerA"]["fetch"], path: string, init: RequestInit = {}) =>
    caller(path, {
      ...init,
      headers: { ...(init.headers ?? {}), "X-Backlex-Tenant": cast.tenantB.slug },
    });

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
    const created = await inB(
      cast.ownerB.fetch,
      "/api/collections",
      json("POST", {
        slug: collSlug,
        ownerScoped: true,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    );
    if (created.status !== 201) {
      throw new Error(`owner-scoped collection create failed: ${created.status} ${await created.text()}`);
    }
  });

  afterAll(() => {
    cast.cleanup();
  });

  test("the workspace's own owner can write to their owner-scoped collection", async () => {
    // The positive control. Without it every assertion below could pass because
    // the collection is broken rather than because access is what it is.
    const res = await inB(cast.ownerB.fetch, `/api/items/${collSlug}`, json("POST", { title: "by-owner-b" }));
    expect(res.status).toBe(201);
  });

  test("the visitor holds no admin powers in the foreign workspace", async () => {
    // Restates the boundary the block above pins, here so the write below is
    // unambiguous: whatever lets it through is NOT an admin bypass.
    const roles = await inB(cast.ownerA.fetch, "/api/roles");
    expect(roles.status).toBe(403);
  });

  test("KNOWN GAP: the visitor CAN create a row in the foreign workspace", async () => {
    // Pinned, not fixed — Phase 0 changes no runtime behaviour. `ownerA` is not
    // a member of B, was never invited, and holds `admin` only in a workspace
    // they created for themselves; the row still lands in B's physical table.
    // Phase 1 (shortcut re-keyed to `isInstanceOperator`) is what turns this
    // into a refusal, and this assertion is what will record that it did.
    const res = await inB(cast.ownerA.fetch, `/api/items/${collSlug}`, json("POST", { title: "by-stranger" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; title: string } };
    expect(body.data.title).toBe("by-stranger");

    // And it is really in B, not in a same-slug collection of the visitor's own
    // — B's owner reads it back from B.
    const asOwnerB = await inB(cast.ownerB.fetch, `/api/items/${collSlug}/${body.data.id}`);
    expect(asOwnerB.status).toBe(200);
  });

  test("the owner condition still fences READS, so the leak is write-shaped", async () => {
    // `read` carries `owner_id == $user.id` while `create` carries nothing, so
    // the visitor sees only what they themselves wrote — which is precisely why
    // this has been invisible: nothing in the foreign workspace's data comes
    // back to them, so no read test would ever have caught it.
    const listed = await inB(cast.ownerA.fetch, `/api/items/${collSlug}`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { data: { title: string }[] };
    // Non-vacuous: the visitor's own row IS present, so an empty result would
    // mean the query failed rather than that the fence held.
    expect(body.data.some((r) => r.title === "by-stranger")).toBe(true);
    expect(body.data.some((r) => r.title === "by-owner-b")).toBe(false);
  });
});

/**
 * `POST /api/tenants/switch` — the route that moves a caller's active workspace.
 *
 * It had ZERO tests before this block: the file's header docstring described it
 * and nothing executed it, which is the exact shape a contract change slips
 * through. What is pinned here is TODAY's behaviour, including the parts that
 * are wrong; each of those carries a comment naming the phase that fixes it.
 *
 * The cast comes from `fixtures/two-plane-cast.ts` so the principals are the
 * ones the identity audit turns on: `ownerA` is `admin` only in the workspace
 * they created themselves, and workspace B has exactly one member, so "not a
 * member" is a state that can actually be reached (it cannot in `default`,
 * which every signup joins).
 */
describe("tenants: POST /api/tenants/switch", () => {
  let cast: TwoPlaneCast;

  /** Read `users.active_tenant_id` straight out of the harness DB.
   *
   *  Going through the API would tell us nothing here: the whole question this
   *  block answers is whether the column the route writes is ever consulted
   *  again, and no endpoint exposes it. Opening the same SQLite file the app
   *  holds open is safe — WAL, and this is a read. */
  const activeTenantIdOf = (userId: string): string | null => {
    const db = new Database(cast.h.env.SQLITE_PATH!, { readonly: true });
    try {
      const row = db
        .query("SELECT active_tenant_id AS t FROM users WHERE id = ?")
        .get(userId) as { t: string | null } | null;
      return row?.t ?? null;
    } finally {
      db.close();
    }
  };

  /** Re-issue a request with the session cookie but WITHOUT `backlex-tenant`.
   *
   *  The harness jar is all-or-nothing, and the interesting question is what the
   *  server falls back to once the cookie is gone — which is the only situation
   *  in which a persisted `active_tenant_id` could possibly matter. */
  const fetchWithoutTenantCookie = (path: string): Promise<Response> => {
    const jar = cast.h.cookies();
    const cookie = Object.entries(jar)
      .filter(([name]) => name !== TENANT_COOKIE)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    expect(cookie, "the session cookie must survive — otherwise this is an anonymous call").not.toBe("");
    return cast.h.app.request(path, {
      headers: { Cookie: cookie, Origin: cast.h.env.APP_URL! },
    });
  };

  const activeWorkspace = async (caller: (p: string) => Promise<Response>): Promise<string | null> => {
    const res = await caller("/api/tenants");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: string | null };
    return body.active;
  };

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
  });

  afterAll(() => {
    cast.cleanup();
  });

  test("a member switches by id: 200, the cookie moves, and the next request lands there", async () => {
    // Start from the OTHER workspace on purpose. Asserting "after switching to
    // A the caller is in A" proves nothing unless they were demonstrably
    // somewhere else first.
    const toDefault = await cast.ownerA.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: cast.defaultTenant.id }),
    );
    expect(toDefault.status).toBe(200);
    expect(await activeWorkspace(cast.ownerA.fetch)).toBe(cast.defaultTenant.id);

    const res = await cast.ownerA.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: cast.tenantA.id }),
    );
    expect(res.status).toBe(200);

    // The response body is the resolved workspace, id + slug and nothing else —
    // no role, no membership, no name.
    const body = (await res.json()) as { data: { id: string; slug: string } };
    expect(body.data).toEqual({ id: cast.tenantA.id, slug: cast.tenantA.slug });

    // The cookie carries the workspace ID, never the slug, even when the caller
    // named the workspace by slug (see the next test).
    expect(cast.h.cookies()[TENANT_COOKIE]).toBe(cast.tenantA.id);

    // And a header-less follow-up resolves through that cookie.
    expect(await activeWorkspace(cast.ownerA.fetch)).toBe(cast.tenantA.id);
  });

  test("switching by slug resolves the same workspace as switching by id", async () => {
    // The handler tries `id` first and falls back to `slug`, so a slug that is
    // not also somebody's id takes the second branch.
    const res = await cast.ownerA.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: cast.defaultTenant.slug }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; slug: string } };
    expect(body.data.id).toBe(cast.defaultTenant.id);
    expect(cast.h.cookies()[TENANT_COOKIE]).toBe(cast.defaultTenant.id);
  });

  test("switching to a workspace the caller is not a member of is refused, and nothing moves", async () => {
    // ownerA holds `admin` in workspace A — a role they granted themselves by
    // creating it — and is not a member of B. `assertWorkspaceAccess` does NOT
    // consult that unfiltered role union: its escape hatch is
    // `isInstanceOperator`, so a self-created admin role buys nothing here.
    // This route is therefore already keyed the way Phase 1 re-keys the rest.
    const before = await activeWorkspace(cast.ownerA.fetch);
    expect(before).toBe(cast.defaultTenant.id);

    const res = await cast.ownerA.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: cast.tenantB.id }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("You are not a member of this workspace");

    // A refused switch must not have moved the caller, nor written the cookie.
    expect(cast.h.cookies()[TENANT_COOKIE]).toBe(cast.defaultTenant.id);
    expect(await activeWorkspace(cast.ownerA.fetch)).toBe(cast.defaultTenant.id);
  });

  test("the instance operator CAN switch into a workspace they are not a member of", async () => {
    // `isInstanceOperator` — `admin` in the DEFAULT workspace — is the one
    // identity `assertWorkspaceAccess` lets past a missing membership row. The
    // operator has no `tenant_members` row in B; the switch still succeeds and
    // the cookie moves, which is what a support visit needs.
    const res = await cast.operator.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: cast.tenantB.id }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; slug: string } };
    expect(body.data.slug).toBe(cast.tenantB.slug);
    expect(cast.h.cookies()[TENANT_COOKIE]).toBe(cast.tenantB.id);

    // Reaching B does not make the operator a MEMBER of it: their own workspace
    // list still omits B, so the switch moved the pointer, not the membership.
    const list = await cast.operator.fetch("/api/tenants");
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { data: { id: string }[] };
    expect(listed.data.some((t) => t.id === cast.tenantB.id)).toBe(false);
  });

  test("switching to a nonexistent workspace answers 404 — a different code than a real one you may not have", async () => {
    const res = await cast.ownerA.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: "00000000-0000-4000-8000-000000000000" }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Workspace not found");

    // KNOWN GAP, pinned deliberately. A workspace that does not exist answers
    // 404 while one that exists and is not yours answers 403 (the test above),
    // so this route is an existence oracle: any signed-in user can enumerate
    // workspace ids and slugs by status code alone. `tenantMiddleware`'s
    // `X-Backlex-Tenant` path deliberately collapses both causes into ONE
    // message for exactly this reason — see `refuseHeaderWorkspace` — and this
    // route never got the same treatment. Phase 1 owns closing it; until then
    // the divergence is the contract and is asserted, not assumed.
    const foreign = await cast.ownerA.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: cast.tenantB.slug }),
    );
    expect(foreign.status).toBe(403);
  });

  test("a malformed body is rejected before any lookup", async () => {
    const res = await cast.ownerA.fetch("/api/tenants/switch", json("POST", {}));
    expect(res.status).toBe(422);
  });

  test("an anonymous caller cannot switch anything", async () => {
    // `requireUser` is the only middleware on this route, so this is the whole
    // gate — and it is the reason the route is reachable by any signed-in
    // platform identity regardless of what they administer.
    const res = await cast.anon("/api/tenants/switch", json("POST", { tenant: cast.tenantA.id }));
    expect(res.status).toBe(401);
  });

  test("the switch writes users.active_tenant_id", async () => {
    const res = await cast.ownerA.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: cast.tenantA.id }),
    );
    expect(res.status).toBe(200);
    expect(activeTenantIdOf(cast.ownerA.userId)).toBe(cast.tenantA.id);
  });

  test("...and NOTHING ever reads users.active_tenant_id back", async () => {
    // The file's own header docstring, and `tenantMiddleware`'s, both list
    // `user.activeTenantId` as step 3 of the resolution order. It is not there.
    // The real chain is: `X-Backlex-Tenant` header → `backlex-tenant` cookie →
    // `firstUserTenant` (an unordered LIMIT 1 over tenant_members) → the default
    // workspace. `active_tenant_id` is written by this route and by
    // `persistActive`, and read by no one — grep the server: the only hits are
    // the two writes, one comment, and the demo seeder.
    //
    // Pinned rather than fixed because Phase 0 changes no runtime behaviour.
    // The consequence is user-visible: drop the cookie (a new browser, a
    // cleared jar, a cross-tenant visit that clears it) and the caller lands
    // wherever `firstUserTenant` happens to answer, not where they last
    // deliberately switched to.
    const switched = await cast.ownerA.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: cast.tenantA.id }),
    );
    expect(switched.status).toBe(200);

    // The positive half first: the column really does hold A, so the negative
    // assertion below cannot pass just because the write never happened.
    expect(activeTenantIdOf(cast.ownerA.userId)).toBe(cast.tenantA.id);
    expect(await activeWorkspace(cast.ownerA.fetch)).toBe(cast.tenantA.id);

    const res = await fetchWithoutTenantCookie("/api/tenants");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: string | null; data: { id: string }[] };
    // ownerA belongs to `default` (every signup does) and to A. With the cookie
    // gone the persisted choice is ignored and `firstUserTenant` answers with
    // the membership row that was inserted first — `default`.
    expect(body.active).not.toBe(cast.tenantA.id);
    expect(body.active).toBe(cast.defaultTenant.id);
  });
});
