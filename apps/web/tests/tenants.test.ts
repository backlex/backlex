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
 * Who may reach a workspace they are not a member of.
 *
 * This block used to pin the OPPOSITE contract, and the shape of that flip is
 * the whole point of the Phase 0 → Phase 1 pair. The gate was
 * `middleware/session.ts::loadUnfilteredRoleNames` — an unfiltered union of
 * role NAMES across every workspace the caller held a role in, with no tenant
 * predicate — and `POST /api/tenants` hands the RBAC `admin` role to whoever
 * creates a workspace. So any signed-in user could mint themselves a name that
 * appeared in that union: the shortcut was self-serve rather than privileged,
 * and clicking "New workspace" unlocked read-through access to every OTHER
 * workspace on the instance. That function no longer exists.
 *
 * What replaced it is `services/roles/guards.ts::isInstanceOperator` — `admin`
 * in the DEFAULT workspace (where the first signup is seeded), or
 * `OWNER_EMAIL` — the principal `routes/tenants.ts::assertWorkspaceAccess` was
 * already using for `POST /api/tenants/switch`. A workspace minted later
 * confers neither.
 *
 * The contract therefore has two halves, and both are asserted here because
 * either one alone describes a different change:
 *
 *   - `ownerA` is a SELF-SERVE workspace admin — `admin` only in the workspace
 *     they created for themselves — and now gets nothing at all in workspace B.
 *     Not baseline access, not read-through: the request is refused at tenant
 *     resolution, before any handler runs.
 *   - The `operator` still REACHES workspace B, which is what keeps the admin
 *     workspace-switcher working, and still resolves to TENANT-SCOPED roles
 *     there, so admin-only endpoints keep answering 403. The shortcut decides
 *     *whether* they may act here, never *as what*.
 *
 * Without the second half this file would read as "we broke the switcher".
 */
describe("tenants: only the instance operator reaches a workspace they don't belong to", () => {
  let cast: TwoPlaneCast;

  /** A call into a named workspace, chosen explicitly by header rather than by
   *  whatever the shared cookie jar happens to hold. */
  const inWorkspace = (
    caller: TwoPlaneCast["ownerA"]["fetch"],
    slug: string,
    path: string,
    init: RequestInit = {},
  ) =>
    caller(path, {
      ...init,
      headers: { ...(init.headers ?? {}), "X-Backlex-Tenant": slug },
    });

  /** The workspace a header-less request resolves to — the same thing the admin
   *  SPA reads to decide which workspace it is showing. */
  const activeWorkspace = async (
    caller: TwoPlaneCast["ownerA"]["fetch"],
  ): Promise<string | null> => {
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

  test("a self-serve workspace admin gets nothing in a foreign workspace", async () => {
    // The positive half first, so the refusal below cannot pass because ownerA
    // is broken or unauthenticated: they really are an `admin`, and /api/roles
    // really does answer them — in the workspace they created for themselves.
    const own = await inWorkspace(cast.ownerA.fetch, cast.tenantA.slug, "/api/roles");
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as { data: { name: string }[] };
    expect(ownBody.data.some((r) => r.name === "admin")).toBe(true);

    // Same identity, same endpoint, a workspace they are not a member of. This
    // used to be a 403 — reached, then denied by `requireAdmin` — which meant
    // the request had already been handed `auth.tenantId` for workspace B. It
    // is refused at tenant resolution now, so no handler runs at all.
    const foreign = await inWorkspace(cast.ownerA.fetch, cast.tenantB.slug, "/api/roles");
    expect(foreign.status).toBe(404);
    const foreignBody = (await foreign.json()) as { error: { code: string; message: string } };
    expect(foreignBody.error.code).toBe("NOT_FOUND");
    expect(foreignBody.error.message).toContain(cast.tenantB.slug);

    // And it is the SAME refusal a slug matching nothing gets, deliberately —
    // otherwise the header would be an existence oracle and any signed-in user
    // could read off which workspaces exist from the status code alone.
    const bogus = await inWorkspace(cast.ownerA.fetch, "no-such-workspace-here", "/api/roles");
    expect(bogus.status).toBe(foreign.status);
    const bogusBody = (await bogus.json()) as { error: { code: string } };
    expect(bogusBody.error.code).toBe(foreignBody.error.code);
  });

  test("the refused visit doesn't strand the visitor or move their own workspace", async () => {
    // Establish where ownerA is inside this test rather than inheriting
    // whatever the previous one left in the shared jar.
    const home = await inWorkspace(cast.ownerA.fetch, cast.tenantA.slug, "/api/tenants");
    expect(home.status).toBe(200);
    expect(cast.h.cookies()[TENANT_COOKIE]).toBe(cast.tenantA.id);

    const refused = await inWorkspace(cast.ownerA.fetch, cast.tenantB.slug, "/api/tenants");
    expect(refused.status).toBe(404);

    // The refusal throws before `next()`, so nothing writes a cookie: a rejected
    // visit must not repoint the visitor at some other workspace, and must not
    // knock them out of the one they were already in either.
    expect(cast.h.cookies()[TENANT_COOKIE]).toBe(cast.tenantA.id);
    expect(await activeWorkspace(cast.ownerA.fetch)).toBe(cast.tenantA.id);
  });

  test("the instance operator still reaches a foreign workspace, as a non-admin", async () => {
    // 403, not 404 — the operator's request DID resolve workspace B and then
    // ran into `requireAdmin`. That difference from ownerA's 404 above is the
    // entire contract: reach is keyed on being the instance operator, not on
    // holding the name `admin` somewhere on the instance.
    const foreign = await inWorkspace(cast.operator.fetch, cast.tenantB.slug, "/api/roles");
    expect(foreign.status).toBe(403);
    const body = (await foreign.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");

    // `auth.roles` comes from `loadTenantRoleNames`, which is strictly scoped to
    // the active workspace, and the operator holds no `user_roles` row in B — so
    // the bundle is empty there. The same endpoint in the operator's OWN
    // workspace answers 200, which is what makes the 403 a statement about
    // WHERE they are rather than about who they are.
    const atHome = await inWorkspace(cast.operator.fetch, cast.defaultTenant.slug, "/api/roles");
    expect(atHome.status).toBe(200);
    const atHomeBody = (await atHome.json()) as { data: { name: string }[] };
    expect(atHomeBody.data.some((r) => r.name === "admin")).toBe(true);
  });

  test("the operator's visit is one-shot — it does not repoint their active workspace", async () => {
    // `tenantMiddleware` stamps `auth.access = "operator-visit"` on this path
    // and, on the same branch, refuses to pin the `backlex-tenant` cookie. This
    // is where that second half is observable: a support visit must not leave
    // the operator's own SPA silently pointing at somebody else's workspace for
    // the next thirty days.
    const home = await inWorkspace(cast.operator.fetch, cast.defaultTenant.slug, "/api/tenants");
    expect(home.status).toBe(200);
    // Non-vacuous: a MEMBER's request does pin the cookie, so the absence
    // asserted below is a decision and not a jar that never gets cookies.
    expect(cast.h.cookies()[TENANT_COOKIE]).toBe(cast.defaultTenant.id);
    expect(await activeWorkspace(cast.operator.fetch)).toBe(cast.defaultTenant.id);

    const visit = await inWorkspace(cast.operator.fetch, cast.tenantB.slug, "/api/tenants");
    expect(visit.status).toBe(200);
    // Reaching B does not make the operator a MEMBER of it — the list is
    // membership-driven and still omits B even on the request B is active for.
    const listed = (await visit.json()) as { data: { id: string }[] };
    expect(listed.data.some((t) => t.id === cast.tenantB.id)).toBe(false);
    expect(listed.data.some((t) => t.id === cast.defaultTenant.id)).toBe(true);

    // The visit actively CLEARS the cookie rather than moving it to B, so the
    // next header-less request drops back to the operator's own workspace.
    const jar = cast.h.cookies();
    expect(jar[TENANT_COOKIE]).not.toBe(cast.tenantB.id);
    expect(jar[TENANT_COOKIE]).toBeUndefined();
    expect(await activeWorkspace(cast.operator.fetch)).toBe(cast.defaultTenant.id);
  });
});

/**
 * What a non-member cross-tenant visitor can DO in a foreign workspace: nothing.
 *
 * Phase 0 pinned the answer "create a row", and that was not a theoretical
 * leak. `tenantMiddleware` left `auth.roles` empty for such a visitor — which
 * is what the block above tests — but the permission resolver never consulted
 * `auth.roles`: `loadRolesForUser`'s control-plane branch filtered on
 * `roles.tenant_id` and `user_roles.user_id` and carried NO membership term, so
 * it unconditionally included the foreign workspace's builtin `authenticated`
 * role for any signed-in control-plane identity. And
 * `services/seed.ts::seedOwnerScopedPermissions` grants that role an
 * UNCONDITIONAL `create` on every owner-scoped collection — read/update/delete
 * are fenced by `owner_id == $user.id`, create is not, because the row does not
 * exist yet to own. The two facts composed into WRITE access for a stranger,
 * and because the reads WERE fenced nothing ever came back to make it visible.
 *
 * Phase 1 closes it in two independent places, and that is deliberate: either
 * one alone would leave the write a single bypass away.
 *   - `tenantMiddleware` refuses the visitor at tenant resolution (404), so no
 *     handler runs and `auth.tenantId` never points at the foreign workspace.
 *   - `loadRolesForUser` now requires a non-suspended `tenant_members` row
 *     before it hands out that workspace's `authenticated` bundle, so a caller
 *     who reached `auth.tenantId` some other way still resolves to zero roles.
 *     "Authenticated" now means authenticated *in this workspace*, not merely
 *     signed in somewhere on the deployment.
 *
 * The operator half is asserted here too, on the very same collection, because
 * "a stranger can no longer write" and "nobody but the owner can reach it" are
 * the same sentence unless the switcher is shown still working.
 */
describe("tenants: a non-member cross-tenant visitor has no write powers in a foreign workspace", () => {
  let cast: TwoPlaneCast;
  const suffix = `${Date.now()}`.slice(-6);
  // Collection slugs take letters and digits only — no hyphen. The SAME slug is
  // created in BOTH workspaces on purpose: it removes "that slug just doesn't
  // exist for this caller" as a reading of the 404s below.
  const collSlug = `notes${suffix}`;

  /** A call into a named workspace, chosen explicitly by header rather than by
   *  whatever the shared cookie jar happens to hold. */
  const inWorkspace = (
    caller: TwoPlaneCast["ownerA"]["fetch"],
    slug: string,
    path: string,
    init: RequestInit = {},
  ) =>
    caller(path, {
      ...init,
      headers: { ...(init.headers ?? {}), "X-Backlex-Tenant": slug },
    });

  const createOwnerScoped = async (
    caller: TwoPlaneCast["ownerA"]["fetch"],
    slug: string,
  ): Promise<void> => {
    const created = await inWorkspace(
      caller,
      slug,
      "/api/collections",
      json("POST", {
        slug: collSlug,
        ownerScoped: true,
        fields: [{ name: "title", type: "text", required: true }],
      }),
    );
    if (created.status !== 201) {
      throw new Error(
        `owner-scoped collection create in ${slug} failed: ${created.status} ${await created.text()}`,
      );
    }
  };

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
    await createOwnerScoped(cast.ownerB.fetch, cast.tenantB.slug);
    await createOwnerScoped(cast.ownerA.fetch, cast.tenantA.slug);
  });

  afterAll(() => {
    cast.cleanup();
  });

  test("the workspace's own owner can write to their owner-scoped collection", async () => {
    // The positive control. Without it every refusal below could pass because
    // the collection is broken rather than because access is what it is.
    const res = await inWorkspace(
      cast.ownerB.fetch,
      cast.tenantB.slug,
      `/api/items/${collSlug}`,
      json("POST", { title: "by-owner-b" }),
    );
    expect(res.status).toBe(201);
  });

  test("the visitor can write the SAME collection slug in their own workspace", async () => {
    // The other half of the control, and the half that makes the 404s specific:
    // ownerA is a working, signed-in, admin-holding identity, and `notes<n>` is
    // a collection they can create rows in. Everything that fails below fails
    // because of WHICH workspace was named — not because of who is asking, and
    // not because of what they asked for.
    const res = await inWorkspace(
      cast.ownerA.fetch,
      cast.tenantA.slug,
      `/api/items/${collSlug}`,
      json("POST", { title: "by-owner-a-at-home" }),
    );
    expect(res.status).toBe(201);
  });

  test("the visitor can no longer create a row in the foreign workspace", async () => {
    // Phase 0 pinned this as a 201, and the row really did land in workspace
    // B's physical table, written by someone who was never a member and was
    // never invited. It is a 404 now, and the 404 comes from tenant resolution
    // rather than from the collection lookup: the message names the header.
    const res = await inWorkspace(
      cast.ownerA.fetch,
      cast.tenantB.slug,
      `/api/items/${collSlug}`,
      json("POST", { title: "by-stranger" }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("X-Backlex-Tenant");

    // "Refused" is not the same claim as "wrote nothing", so ask the one
    // identity that can see B's rows. Non-vacuous: their own row from the
    // control above IS there, so an empty answer would mean the read failed
    // rather than that the write did.
    const listed = await inWorkspace(cast.ownerB.fetch, cast.tenantB.slug, `/api/items/${collSlug}`);
    expect(listed.status).toBe(200);
    const rows = (await listed.json()) as { data: { title: string }[] };
    expect(rows.data.some((r) => r.title === "by-owner-b")).toBe(true);
    expect(rows.data.some((r) => r.title === "by-stranger")).toBe(false);
  });

  test("the visitor cannot read the foreign workspace's collection either", async () => {
    // Phase 0 answered 200 here — with an owner-fenced, and therefore empty,
    // result — which is exactly how the write leak stayed invisible for so
    // long: no read test could have caught it. Both verbs are refused at the
    // same place now, before either permission is consulted.
    const listed = await inWorkspace(cast.ownerA.fetch, cast.tenantB.slug, `/api/items/${collSlug}`);
    expect(listed.status).toBe(404);
    const body = (await listed.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("the instance operator still reaches the same collection, still owner-fenced", async () => {
    // The counterweight. `tenantMiddleware` stamps `auth.access = "operator-visit"`
    // for this caller, and that stamp is what lets `loadRolesForUser` hand back
    // workspace B's `authenticated` bundle to someone with no `tenant_members`
    // row — under `"member"` (the value everything defaults to when it does not
    // say otherwise) the operator would resolve to zero roles and be denied
    // here. So a 200 is the observable proof the stamp was applied.
    const listed = await inWorkspace(
      cast.operator.fetch,
      cast.tenantB.slug,
      `/api/items/${collSlug}`,
    );
    expect(listed.status).toBe(200);

    // Reaching it is not reading it: `read` carries `owner_id == $user.id` and
    // the operator owns nothing here, so B's rows stay fenced off. The visit
    // buys a working workspace switcher, not a view of the data.
    const rows = (await listed.json()) as { data: { title: string }[] };
    expect(rows.data.some((r) => r.title === "by-owner-b")).toBe(false);
    expect(rows.data).toHaveLength(0);

    // And the write the block above closed for a stranger is still open for the
    // operator, because it is the same mechanism narrowed to one principal:
    // `operator-visit` hands them B's `authenticated` bundle, and that bundle's
    // `create` carries no condition. Asserted rather than left implicit — this
    // is the residue of the leak, it is deliberate (the operator already holds
    // the SQL console), and it should have to be edited by anyone who decides a
    // support visit ought to be read-only.
    const written = await inWorkspace(
      cast.operator.fetch,
      cast.tenantB.slug,
      `/api/items/${collSlug}`,
      json("POST", { title: "by-operator" }),
    );
    expect(written.status).toBe(201);
  });
});

/**
 * `POST /api/tenants/switch` — the route that moves a caller's active workspace.
 *
 * It had ZERO tests before this block: the file's header docstring described it
 * and nothing executed it, which is the exact shape a contract change slips
 * through. What is pinned here is TODAY's behaviour, including the parts that
 * are wrong. Phase 1 left this route alone — it was already gated on
 * `isInstanceOperator` and is in fact the shape the rest of the surface was
 * moved onto — so the two gaps called out below (the existence oracle, and the
 * dead `active_tenant_id` column) survived it and say so.
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
    return Promise.resolve(cast.h.app.request(path, {
      headers: { Cookie: cookie, Origin: cast.h.env.APP_URL! },
    }));
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
    // consult the unfiltered role union that `middleware/session.ts` used to
    // export: its escape hatch is `isInstanceOperator`, so a self-created admin
    // role buys nothing here. This route was always keyed that way, which is
    // why Phase 1 changed nothing about it — it is the shape the rest of the
    // surface was moved onto, not the other way round.
    const before = await activeWorkspace(cast.ownerA.fetch);
    expect(before).toBe(cast.defaultTenant.id);

    const res = await cast.ownerA.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: cast.tenantB.id }),
    );
    // NOT_FOUND, not FORBIDDEN — and the message names no workspace that the
    // caller did not already name themselves. See the existence-oracle test
    // below: "no such workspace" and "not yours" now answer identically.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("is available to you");

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

  test("/switch is not an existence oracle: no-such-workspace and not-yours are indistinguishable", async () => {
    // The route used to answer 404 "Workspace not found" for one and 403 "You
    // are not a member of this workspace" for the other, which let any signed-in
    // user enumerate every workspace id and slug on the deployment by status
    // code alone — without ever being admitted to one.
    //
    // `middleware/tenant.ts::refuseHeaderWorkspace` already collapsed the two
    // for the `X-Backlex-Tenant` header for exactly this reason; this route was
    // the same door left open beside it.
    const missing = await cast.ownerA.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: "00000000-0000-4000-8000-000000000000" }),
    );
    const foreign = await cast.ownerA.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: cast.tenantB.slug }),
    );

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    const a = (await missing.json()) as { error: { code: string; message: string } };
    const b = (await foreign.json()) as { error: { code: string; message: string } };
    expect(a.error.code).toBe(b.error.code);

    // The messages differ only by the string the CALLER supplied, so a typo is
    // still diagnosable while the response carries nothing they did not send.
    // Neither may leak the real workspace's id, and the one naming a slug must
    // not confirm it resolved to anything.
    expect(a.error.message.replace("00000000-0000-4000-8000-000000000000", "X"))
      .toBe(b.error.message.replace(cast.tenantB.slug, "X"));
    expect(a.error.message).not.toContain(cast.tenantB.id);
    expect(b.error.message).not.toContain(cast.tenantB.id);
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
    // Still pinned rather than fixed: Phase 1 re-keyed who may reach a foreign
    // workspace and left the resolution order alone, so this dead column is
    // unchanged. The consequence is user-visible: drop the cookie (a new browser, a
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
