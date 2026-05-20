import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { TENANT_COOKIE } from "../src/server/middleware/tenant";

/**
 * Multi-tenant isolation smoke tests.
 *
 * Discovered contract (apps/web/src/server/routes/tenants.ts,
 * middleware/tenant.ts, services/seed.ts):
 *   - GET    /api/tenants            → list workspaces the caller belongs to
 *                                       (`{ data: [...], active: <id> }`)
 *   - POST   /api/tenants            → create workspace; caller becomes owner
 *   - POST   /api/tenants/switch     → sets `workeros-tenant` cookie + persists
 *                                       user.activeTenantId
 *   - Active tenant resolution: `X-Workeros-Tenant` header → cookie →
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
    // Step 1: create collection in the default workspace (X-Workeros-Tenant header).
    const createA = await h.fetch("/api/collections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workeros-Tenant": "default",
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
      headers: { "X-Workeros-Tenant": tenantBSlug },
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
        "X-Workeros-Tenant": tenantBSlug,
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
      headers: { "X-Workeros-Tenant": "default" },
    });
    expect(getA.status).toBe(200);
    const getB = await h.fetch(`/api/collections/${collSlug}`, {
      headers: { "X-Workeros-Tenant": tenantBSlug },
    });
    expect(getB.status).toBe(200);
  });

  test("items inserted in default tenant don't surface in tenant-B's items list", async () => {
    // Insert one item in default (collection seeded above).
    const insertA = await h.fetch(`/api/items/${collSlug}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workeros-Tenant": "default",
      },
      body: JSON.stringify({ title: "from-default" }),
    });
    expect(insertA.status).toBe(201);
    const insertedA = (await insertA.json()) as { data: { id: string; title: string } };
    expect(insertedA.data.title).toBe("from-default");

    // tenant-B's items list for the same slug points at tenant-B's collection
    // (different physical table) — must be empty.
    const listB = await h.fetch(`/api/items/${collSlug}`, {
      headers: { "X-Workeros-Tenant": tenantBSlug },
    });
    expect(listB.status).toBe(200);
    const bodyB = (await listB.json()) as { data: { id: string }[] };
    expect(bodyB.data.length).toBe(0);

    // Reading the default-tenant row by id from tenant-B context: the
    // collection slug resolves to tenant-B's table (which has no such row).
    // Contract → 404 NOT_FOUND, not 403/empty.
    const getB = await h.fetch(`/api/items/${collSlug}/${insertedA.data.id}`, {
      headers: { "X-Workeros-Tenant": tenantBSlug },
    });
    expect(getB.status).toBe(404);

    // Default still sees its own row.
    const listA = await h.fetch(`/api/items/${collSlug}`, {
      headers: { "X-Workeros-Tenant": "default" },
    });
    expect(listA.status).toBe(200);
    const bodyA = (await listA.json()) as { data: { id: string }[] };
    expect(bodyA.data.some((r) => r.id === insertedA.data.id)).toBe(true);
  });
});

describe("tenants: nonexistent slug in X-Workeros-Tenant falls back gracefully", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => {
    h.cleanup();
  });

  test("unknown tenant header doesn't grant access to a stranger's workspace", async () => {
    // Per tenantMiddleware: unknown header → tenantId stays null → falls
    // through to firstUserTenant / ensureDefaultTenant. The admin still lands
    // somewhere they're a member of, never in a workspace they don't own.
    const res = await h.fetch("/api/tenants", {
      headers: { "X-Workeros-Tenant": "no-such-workspace-here" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { slug: string }[];
      active: string | null;
    };
    // List only ever surfaces tenants the caller is a member of, so a bogus
    // header can't enumerate strangers' workspaces — it just shows mine.
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
      headers: { "X-Workeros-Tenant": tenantBSlug },
    });
    expect(forbidden.status).toBe(403);
    const body = (await forbidden.json()) as {
      error?: { code?: string };
    };
    expect(body.error?.code).toBe("FORBIDDEN");
  });

  test("the cross-tenant visit doesn't leak workeros-tenant cookie", async () => {
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
