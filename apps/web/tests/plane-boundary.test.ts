/**
 * What an APP-plane bearer can reach on the CONTROL plane, today.
 *
 * backlex has two auth planes — `"platform"` (dashboard operators, rows in
 * `users`/`sessions`) and `"app"` (a workspace's own end-users, rows in
 * `app_users`/`app_sessions`, credential `Authorization: Bearer <token>`) — and
 * until this file nothing in the suite ever pointed the second at the first.
 * The boundary was asserted in prose and executed by nobody.
 *
 * It matters because almost nothing actually CHECKS the plane. `requireUser`
 * only asks whether `auth.userId` is set, and an `app_users` id satisfies that
 * exactly as well as a `users` id does. What denies an app-plane caller on most
 * routes is `requireAdminMw`, and it denies for a reason that is one line from
 * evaporating: `tenantMiddleware` deliberately leaves `auth.roles` EMPTY for
 * `plane === "app"` (middleware/tenant.ts, "App-plane identities don't
 * participate in control-plane RBAC"), so the admin check fails by absence. The
 * two routes carrying `requirePlatformMw` / `isInstanceOperator` are the only
 * ones denying on the plane itself.
 *
 * PHASE 0 IS TEST-ONLY. Everything below records the CURRENT answer, including
 * the answers that are wrong. Three surfaces answer 2xx to a caller who has no
 * business on the control plane at all, and one answers 500 *after* committing
 * part of its write. Each of those is pinned with a comment naming the value it
 * takes once Phase 2 mounts the plane firewall that enforces
 * `lib/route-planes.ts`, so that fix reads as a one-line expectation change with
 * its reason already written down — not as a silent test edit.
 *
 * Nothing here asserts a bare absence. Every denial is paired with the caller
 * who is allowed through the same door (`ownerA`, workspace admin) and with the
 * caller who has no credential at all (`anon`), because a 403 an anonymous
 * request would also earn proves nothing about the bearer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildTwoPlaneCast, json, type TwoPlaneCast } from "./fixtures/two-plane-cast";

interface ErrorBody {
  error?: { code?: string; message?: string };
}

const errorOf = async (res: Response): Promise<{ code?: string; message?: string }> => {
  const body = (await res.json()) as ErrorBody;
  return body.error ?? {};
};

// One read-only cast for every block that does not write. The block that DOES
// write builds its own, because `POST /api/tenants` leaves a workspace behind
// (see the known-gap write block) and that would poison the tenant-list
// assertions above it.
let cast: TwoPlaneCast;
beforeAll(async () => {
  cast = await buildTwoPlaneCast();
});
afterAll(() => cast.cleanup());

// ---------------------------------------------------------------------------
// The mechanism: the bearer IS authenticated; it just carries no roles.
// ---------------------------------------------------------------------------

describe("the mechanism every control-plane denial currently rests on", () => {
  test("the bearer passes requireUser — anon does not", async () => {
    // The interesting failure would be a token that is simply not recognised:
    // then every 403 below would be an accident of an unauthenticated request
    // and this whole file would be vacuous. It is not. `anon` earns 401 "Sign
    // in required" from `requireUser`; the same request with endUserA's bearer
    // gets all the way to the ROLE check and earns 403 instead. `requireUser`
    // accepted an `app_users` id as a control-plane principal.
    const anon = await cast.anon("/api/users");
    expect(anon.status).toBe(401);
    expect((await errorOf(anon)).code).toBe("UNAUTHORIZED");

    const bearer = await cast.endUserA.fetch("/api/users");
    expect(bearer.status).toBe(403);
    expect(await errorOf(bearer)).toMatchObject({
      code: "FORBIDDEN",
      message: "Admin role required",
    });
  });

  test("the only difference from a workspace admin is auth.roles", async () => {
    // Same route, same method, same active workspace. ownerA is `admin` in
    // workspace A and reads the platform user list; endUserA belongs to that
    // same workspace on the other plane and is refused. Nothing about the
    // REQUEST differs — only the role array `tenantMiddleware` populated for
    // one caller and left empty for the other.
    const admin = await cast.ownerA.fetch("/api/users");
    expect(admin.status).toBe(200);
    const listed = (await admin.json()) as { data: unknown[] };
    expect(Array.isArray(listed.data)).toBe(true);
    expect(listed.data.length).toBeGreaterThan(0);

    const endUser = await cast.endUserA.fetch("/api/users");
    expect(endUser.status).toBe(403);
  });

  test("GET /api/me cannot describe an app-plane caller at all", async () => {
    // The brief expected `/api/me` to report an empty `roles` array for the app
    // plane. It cannot: the handler resolves `auth.userId` against the platform
    // `users` table, and an `app_users` id is not in it — so the answer is 404
    // NOT_FOUND, not a 200 with `roles: []`.
    //
    // That 404 is still the observable we wanted, and a sharper one. The
    // handler's own first line throws 401 "Not signed in" when `auth.userId` is
    // unset, so reaching the row lookup PROVES the bearer authenticated, and
    // failing the lookup proves the identity it authenticated as does not exist
    // on the control plane. An identity the control plane cannot even name is
    // being handed control-plane requests.
    const res = await cast.endUserA.fetch("/api/me");
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({
      code: "NOT_FOUND",
      message: "User not found",
    });

    // The positive half: the same route answers a platform identity in full,
    // with the populated `roles` array whose emptiness is the whole story.
    const admin = await cast.ownerA.fetch("/api/me");
    expect(admin.status).toBe(200);
    const me = (await admin.json()) as {
      data: { email: string; roles: string[]; isAdmin: boolean };
    };
    expect(me.data.roles).toContain("admin");
    expect(me.data.isAdmin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Surfaces that DO deny an app-plane bearer today.
// ---------------------------------------------------------------------------

describe("control-plane surfaces that deny an app-plane bearer", () => {
  describe("denied on the PLANE — a real check, and the shape Phase 2 generalises", () => {
    test("POST /api/collections is refused by requirePlatformMw", async () => {
      // "Operator access required" comes from `requirePlatformMw`
      // (services/roles/guards.ts), which tests `auth.plane !== "platform"`
      // directly. This is the only route in this file that would still deny if
      // `auth.roles` were populated tomorrow — which is exactly why the message
      // is asserted and not just the status.
      const res = await cast.endUserA.fetch(
        "/api/collections",
        json("POST", { slug: "plane_probe", name: "Plane Probe", fields: [] }),
      );
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toMatchObject({
        code: "FORBIDDEN",
        message: "Operator access required",
      });
    });

    test("GET /api/admin/db/tables is refused by isInstanceOperator", async () => {
      // Stronger than the plane gate: the SQL console demands `admin` in the
      // DEFAULT workspace. Pinned here because it is the one surface a
      // workspace admin cannot reach either — ownerA gets the identical 403,
      // which is the proof that this denial is not plane-shaped and Phase 2
      // must leave it alone.
      const res = await cast.endUserA.fetch("/api/admin/db/tables");
      expect(res.status).toBe(403);
      const err = await errorOf(res);
      expect(err.code).toBe("FORBIDDEN");
      expect(err.message ?? "").toStartWith("Instance operator access required");

      const workspaceAdmin = await cast.ownerA.fetch("/api/admin/db/tables");
      expect(workspaceAdmin.status).toBe(403);
    });
  });

  describe("denied only because auth.roles is empty — right answer, accidental reason", () => {
    /**
     * Every row here answers 403 "Admin role required", i.e. `requireAdminMw`
     * looked at an empty array. The status is right and the reasoning is not:
     * the moment anything populates `auth.roles` for the app plane — an org
     * role, a future RBAC unification, a bug in `tenantMiddleware` — all of
     * these open at once, with no second line of defence. Phase 2 keeps the
     * 403 and changes what produces it.
     *
     * The message is asserted, not just the status, so the Phase 2 diff has to
     * come through this file: swapping in a plane check changes the message to
     * "Operator access required" and every row fails loudly.
     */
    const ADMIN_GATED: [string, string, RequestInit?][] = [
      ["GET", "/api/users"],
      ["GET", "/api/roles"],
      ["GET", "/api/admin/settings"],
      ["PATCH", "/api/admin/settings", json("PATCH", { timezone: "Europe/Istanbul" })],
      ["GET", "/api/app-users"],
      ["GET", "/api/app-orgs"],
      ["GET", "/api/webhooks"],
      ["GET", "/api/flows"],
      ["GET", "/api/functions"],
      ["GET", "/api/extensions"],
      // The bare `/api/admin/usage` prefix is a mount, not a route; `/overview`
      // is the listing the admin UI actually calls.
      ["GET", "/api/admin/usage/overview"],
      // `/api/permissions` exposes only `DELETE /{id}` (routes/roles/permissions.ts),
      // so this is the sole way to ask that mount an authorization question.
      // The id is deliberately nonexistent: the gate must answer before the
      // lookup, and a 404 here would mean the app-plane caller had reached the
      // query.
      ["DELETE", "/api/permissions/does-not-exist", { method: "DELETE" }],
    ];

    for (const [method, path, init] of ADMIN_GATED) {
      test(`${method} ${path} -> 403 Admin role required`, async () => {
        const res = await cast.endUserA.fetch(path, init ?? { method });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await errorOf(res)).toMatchObject({
          code: "FORBIDDEN",
          message: "Admin role required",
        });
      });
    }

    test("a workspace admin passes every one of those doors", async () => {
      // Without this the block above could pass because the routes are broken,
      // unmounted or 403 for everyone. They are not: the same paths answer 200
      // to ownerA, so each 403 above is a decision about the caller.
      for (const path of [
        "/api/users",
        "/api/roles",
        "/api/admin/settings",
        "/api/app-users",
        "/api/app-orgs",
        "/api/webhooks",
        "/api/flows",
        "/api/functions",
        "/api/extensions",
        "/api/admin/usage/overview",
      ]) {
        const res = await cast.ownerA.fetch(path);
        expect(res.status, `ownerA GET ${path}`).toBe(200);
      }
    });

    test("GET /api/permissions is a 404 because no such route exists", async () => {
      // Recorded so nobody later reads this 404 as a plane denial and deletes
      // the DELETE probe above. It is Hono saying "no handler", not the app
      // saying "no". Phase 2 does not change it.
      const res = await cast.endUserA.fetch("/api/permissions");
      expect(res.status).toBe(404);
      const admin = await cast.ownerA.fetch("/api/permissions");
      expect(admin.status, "…and it is 404 for a platform admin too").toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// KNOWN GAP — reads. Phase 2 mounts the plane firewall that closes these.
// ---------------------------------------------------------------------------

/**
 * Control-plane surfaces an APP-plane bearer reaches TODAY, with a 2xx.
 *
 * Each of these is declared `plane: "platform"` in `lib/route-planes.ts` and
 * carries `requireUser` alone, so an `app_users` id walks straight through.
 * They are grouped apart from the block above because these expectations are
 * WRONG ON PURPOSE: they pin the hole so the fix is visible.
 *
 * PHASE 2 mounts the middleware that enforces `route-planes.ts`. When it lands,
 * every expectation in this block becomes 403 FORBIDDEN "Operator access
 * required" and the accompanying body assertions are deleted.
 */
describe("KNOWN GAP — control-plane reads an app-plane bearer reaches (Phase 2 closes)", () => {
  test("GET /api/tenants answers, and leaks the active workspace id", async () => {
    // Phase 2: 403 FORBIDDEN "Operator access required".
    //
    // The `data` array is empty only because an `app_users` id matches no
    // `tenant_members.user_id` row — the ROUTE ran to completion and would have
    // listed whatever it found. `active` is the real damage: the workspace's
    // internal UUID handed to one of its own customers, from a route the
    // registry marks "platform".
    const res = await cast.endUserA.fetch("/api/tenants");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; active: string };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.active).toBe(cast.tenantA.id);

    // The two end-users are pinned to their own workspaces, so the leak is not
    // a constant that happens to match — it tracks the caller's session.
    const other = await cast.endUserB.fetch("/api/tenants");
    expect(other.status).toBe(200);
    expect(((await other.json()) as { active: string }).active).toBe(cast.tenantB.id);
  });

  test("GET /api/api-keys answers", async () => {
    // Phase 2: 403 FORBIDDEN "Operator access required".
    //
    // `/api/api-keys` mints `pak_` keys, which `session.ts` resolves on the
    // PLATFORM plane — so a caller who can reach this mount is one working POST
    // away from laundering itself across the boundary permanently. The list is
    // empty here because the cast mints no keys; the status is the finding.
    const res = await cast.endUserA.fetch("/api/api-keys");
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { data: unknown[] }).data)).toBe(true);
  });

  test("GET /api/activity answers — the audit log", async () => {
    // Phase 2: 403 FORBIDDEN "Operator access required".
    //
    // The blast radius is smaller than it looks and still wrong: the handler
    // shows non-admins only rows whose `user_id` is theirs, and no platform row
    // carries an `app_users` id, so no operator's history leaks today. But the
    // paging envelope proves the HANDLER ran rather than a gate short-circuiting
    // — the filter is the only thing between an end-user and the workspace's
    // audit trail, and it is a WHERE clause, not an authorization decision.
    const res = await cast.endUserA.fetch("/api/activity");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; limit: number; offset: number };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.limit).toBeGreaterThan(0);
    expect(body.offset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// KNOWN GAP — writes. Own cast: this block leaves a workspace behind.
// ---------------------------------------------------------------------------

/**
 * The two control-plane WRITES an app-plane bearer reaches.
 *
 * Both answer 500, and a 500 is not a denial — it is the database refusing what
 * the authorization layer allowed. `POST /api/tenants` is the serious one: it
 * commits the `tenants` row and the `tenant_members` row and only then trips a
 * foreign key on the RBAC binding, so the request "fails" having already given
 * a workspace's own customer a workspace of their own, owned outright.
 *
 * PHASE 2: both become 403 FORBIDDEN "Operator access required", and the
 * partial-write assertions below invert into assertions that nothing was
 * written.
 */
describe("KNOWN GAP — control-plane writes an app-plane bearer reaches (Phase 2 closes)", () => {
  let wcast: TwoPlaneCast;
  beforeAll(async () => {
    wcast = await buildTwoPlaneCast();
  });
  afterAll(() => wcast.cleanup());

  test("POST /api/tenants 500s AFTER creating the workspace", async () => {
    // Phase 2: 403 FORBIDDEN "Operator access required", and every assertion
    // after the first one inverts — the workspace must not exist, the slug must
    // stay free.
    //
    // The 500 is `assignRoleByName` inserting into `user_roles`, whose
    // `user_id` really does reference `users`. That constraint is the ONLY
    // thing that stopped this request, and it stopped it two writes too late.
    const created = await wcast.endUserA.fetch(
      "/api/tenants",
      json("POST", { name: "Plane Boundary Squat" }),
    );
    expect(created.status).toBe(500);
    expect((await errorOf(created)).code).toBe("INTERNAL");

    // The write survived the failure, and it is visible over HTTP: the
    // end-user's own workspace list — the same "empty" list from the read block
    // — now contains a workspace they own.
    const listed = await wcast.endUserA.fetch("/api/tenants");
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      data: { slug: string; name: string; role: string }[];
    };
    const squatted = body.data.find((t) => t.slug === "plane-boundary-squat");
    expect(squatted, "the 500 committed a tenants row before it failed").toBeDefined();
    expect(squatted!.role).toBe("owner");

    // And it is not merely orphaned data: the slug is globally unique, so an
    // app-plane caller has permanently taken a name out of the platform's
    // namespace. A real operator asking for it is refused.
    const collision = await wcast.ownerB.fetch(
      "/api/tenants",
      json("POST", { name: "Plane Boundary Squat" }),
    );
    expect(collision.status).toBe(409);
    expect((await errorOf(collision)).code).toBe("CONFLICT");
  });

  test("POST /api/api-keys 500s, and this one writes nothing", async () => {
    // Phase 2: 403 FORBIDDEN "Operator access required".
    //
    // Same class of failure, different luck: the key row itself references
    // `users`, so the very first insert trips and there is no partial state.
    // Pinned as the CONTRAST to the tenants case — "it 500s" is not by itself
    // evidence that nothing happened, and the difference between these two
    // tests is the whole reason the assertion above exists.
    const res = await wcast.endUserA.fetch("/api/api-keys", json("POST", { name: "squat-key" }));
    expect(res.status).toBe(500);
    expect((await errorOf(res)).code).toBe("INTERNAL");

    const keys = await wcast.ownerA.fetch("/api/api-keys");
    expect(keys.status, "the admin view of the same mount still answers").toBe(200);
    expect(((await keys.json()) as { data: unknown[] }).data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Not gaps: prefixes route-planes.ts declares `either`.
// ---------------------------------------------------------------------------

describe("declared `either` — an app-plane 200 here is the intended contract", () => {
  test("notifications and device tokens answer both planes", async () => {
    // Pinned so the Phase 2 firewall cannot be written as "deny every bearer on
    // /api/*" and pass. An end-user's phone registering for push is the primary
    // case for `/api/device-tokens`, and both planes receive notifications;
    // `route-planes.ts` marks both `either` with that reasoning. These 200s must
    // survive the fix unchanged.
    for (const path of ["/api/notifications", "/api/device-tokens"]) {
      const res = await cast.endUserA.fetch(path);
      expect(res.status, `endUserA GET ${path}`).toBe(200);
      expect(Array.isArray(((await res.json()) as { data: unknown[] }).data)).toBe(true);

      const admin = await cast.ownerA.fetch(path);
      expect(admin.status, `ownerA GET ${path}`).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// The opposite direction — and it already holds.
// ---------------------------------------------------------------------------

describe("a platform cookie is not an app-plane credential", () => {
  test("GET /api/t/:slug/orgs rejects a platform session", async () => {
    // `app-orgs-public.ts::requireAppUser` tests `auth.plane !== "app"`
    // explicitly, which is the check the control plane is missing in the other
    // direction — the app plane got the gate the platform plane did not. Both a
    // workspace admin and the INSTANCE OPERATOR are refused: privilege on the
    // control plane buys nothing here, which is the property worth pinning.
    for (const who of [cast.ownerA, cast.operator] as const) {
      const res = await who.fetch(`/api/t/${cast.tenantA.slug}/orgs`);
      expect(res.status).toBe(401);
      expect(await errorOf(res)).toMatchObject({
        code: "UNAUTHORIZED",
        message: "Workspace end-user sign-in required",
      });
    }

    // Writes are refused on the same gate, so this is not a read-only accident.
    const write = await cast.ownerA.fetch(
      `/api/t/${cast.tenantA.slug}/orgs`,
      json("POST", { name: "Operator Org" }),
    );
    expect(write.status).toBe(401);

    // The door is real: the credential the route DOES want opens it.
    const endUser = await cast.endUserA.fetch(`/api/t/${cast.tenantA.slug}/orgs`);
    expect(endUser.status).toBe(200);
    const body = (await endUser.json()) as { data: unknown[]; active: unknown };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.active).toBeDefined();
  });

  test("an app-plane bearer cannot point itself at another workspace", async () => {
    // The slug in the path is not the authority — the session's own tenant is.
    // endUserA holds a valid app-plane token and is still refused at B, with a
    // FORBIDDEN rather than the 401 above, which distinguishes "wrong plane"
    // from "right plane, wrong workspace".
    const res = await cast.endUserA.fetch(`/api/t/${cast.tenantB.slug}/orgs`);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({
      code: "FORBIDDEN",
      message: "Session belongs to a different workspace",
    });
  });
});
