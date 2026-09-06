/**
 * What an APP-plane bearer can reach on the CONTROL plane, today.
 *
 * backlex has two auth planes — `"platform"` (dashboard operators, rows in
 * `users`/`sessions`) and `"app"` (a workspace's own end-users, rows in
 * `app_users`/`app_sessions`, credential `Authorization: Bearer <token>`) — and
 * until this file nothing in the suite ever pointed the second at the first.
 * The boundary was asserted in prose and executed by nobody.
 *
 * It mattered because almost nothing actually CHECKED the plane. `requireUser`
 * only asks whether `auth.userId` is set, and an `app_users` id satisfies that
 * exactly as well as a `users` id does. What denied an app-plane caller on most
 * routes was `requireAdminMw`, failing by absence on an empty `auth.roles`.
 * `middleware/plane-firewall.ts` now denies on the plane itself, before any
 * route middleware runs, on every deploy target.
 *
 * PHASE 0 WAS TEST-ONLY, and this file recorded the current answers including
 * the wrong ones — three surfaces answering 2xx to a caller with no business on
 * the control plane, and one answering 500 after committing part of its write.
 * Each was pinned with the value it would take "once Phase 2 mounts the plane
 * firewall that enforces `lib/route-planes.ts`".
 *
 * PHASE 10 IS WHEN THAT LANDED EVERYWHERE. The firewall existed from phase 2,
 * but `PLANE_GUARD` defaulted to `warn` and was set to `enforce` only in the two
 * wrangler configs — so it was real on Cloudflare and a log line on every
 * self-host, Vercel, Netlify and Node deploy, which is the inverse of where the
 * risk lives. The default is now `enforce`, and this file is the record of what
 * that changed: every denial below that used to read "Admin role required" now
 * reads "Operator access required", because the reason moved from an empty
 * `auth.roles` array to the plane itself.
 *
 * That distinction is the whole point and is worth restating: the old 403s were
 * the right answer for the wrong reason. `tenantMiddleware` leaves `auth.roles`
 * empty for `plane === "app"`, so `requireAdminMw` failed by ABSENCE — one
 * populated array away from opening every one of them at once.
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

describe("what every control-plane denial rests on", () => {
  test("the bearer passes requireUser — anon does not", async () => {
    // The interesting failure would be a token that is simply not recognised:
    // then every 403 below would be an accident of an unauthenticated request
    // and this whole file would be vacuous. It is not. `anon` earns 401 "Sign
    // in required" from `requireUser`; the same request with endUserA's bearer
    // authenticates and is then refused on the PLANE. `requireUser` accepts an
    // `app_users` id as a control-plane principal — which is why something
    // downstream has to say no.
    const anon = await cast.anon("/api/users");
    expect(anon.status).toBe(401);
    expect((await errorOf(anon)).code).toBe("UNAUTHORIZED");

    const bearer = await cast.endUserA.fetch("/api/users");
    expect(bearer.status).toBe(403);
    expect(await errorOf(bearer)).toMatchObject({
      code: "FORBIDDEN",
      // Not "Admin role required" any more. The message IS the finding: the
      // denial used to come from an empty `auth.roles`, and now comes from the
      // plane firewall, which cannot be undone by populating an array.
      message: "Operator access required",
    });
  });

  test("the difference from a workspace admin is the PLANE, not a role array", async () => {
    // Same route, same method, same active workspace. ownerA is `admin` in
    // workspace A and reads the platform user list; endUserA belongs to that
    // same workspace on the other plane and is refused before the route's own
    // middleware runs at all.
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

    test("PATCH /api/admin/settings is refused by requirePlatformMw", async () => {
      // Moved here in Phase 2. It used to sit in the table below, answering
      // "Admin role required" because `requireAdminMw` read an empty
      // `auth.roles` — the right status for the wrong reason, one populated
      // array away from opening.
      //
      // It is the handler that can write the `tenant_id IS NULL` row, so it
      // gets the plane check explicitly rather than relying on the firewall
      // alone: two layers, because the audit's lesson was that one layer being
      // right is what let four layers be wrong.
      const res = await cast.endUserA.fetch(
        "/api/admin/settings",
        json("PATCH", { timezone: "Europe/Istanbul" }),
      );
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toMatchObject({
        code: "FORBIDDEN",
        message: "Operator access required",
      });
    });

    test("GET /api/admin/db/tables refuses BOTH, for two different reasons", async () => {
      // The SQL console demands `admin` in the DEFAULT workspace — stronger
      // than the plane gate, and the one surface a workspace admin cannot reach
      // either. Both facts still hold; what changed is the ORDER.
      //
      // An app-plane caller is now stopped by the firewall first, so the
      // message it sees is the plane's. `isInstanceOperator` is what still
      // stops ownerA, and that denial is not plane-shaped — asserting both in
      // one test is what keeps the two from being confused for each other.
      const res = await cast.endUserA.fetch("/api/admin/db/tables");
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toMatchObject({
        code: "FORBIDDEN",
        message: "Operator access required",
      });

      const workspaceAdmin = await cast.ownerA.fetch("/api/admin/db/tables");
      expect(workspaceAdmin.status).toBe(403);
      expect((await errorOf(workspaceAdmin)).message ?? "").toStartWith(
        "Instance operator access required",
      );
    });
  });

  describe("denied on the plane — what used to be an accident of an empty role array", () => {
    /**
     * Every row here used to answer 403 "Admin role required", i.e.
     * `requireAdminMw` looking at an empty array. The status was right and the
     * reasoning was not: the moment anything populated `auth.roles` for the app
     * plane — an org role, a future RBAC unification, a bug in
     * `tenantMiddleware` — all of these would have opened at once, with no
     * second line of defence.
     *
     * They now answer "Operator access required" from the plane firewall. The
     * message is asserted, not just the status, precisely so that difference
     * had to come through this file rather than passing unnoticed.
     */
    const ADMIN_GATED: [string, string, RequestInit?][] = [
      ["GET", "/api/users"],
      ["GET", "/api/roles"],
      // GET stays here; PATCH moved to the block above in Phase 2 because it
      // carries `requirePlatformMw` EXPLICITLY. Both are now refused on the
      // plane; the split records which ones say so in their own route and which
      // rely on the firewall — two layers, because the audit's lesson was that
      // one layer being right is what let four layers be wrong.
      ["GET", "/api/admin/settings"],
      ["GET", "/api/app-users"],
      ["GET", "/api/app-orgs"],
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
      test(`${method} ${path} -> 403 Operator access required`, async () => {
        const res = await cast.endUserA.fetch(path, init ?? { method });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await errorOf(res)).toMatchObject({
          code: "FORBIDDEN",
          message: "Operator access required",
        });
      });
    }

    /**
     * Prefixes `route-planes.ts` still declares `either`, so the firewall
     * admits them and `requireAdminMw` is what refuses — the old message, and
     * the old accidental reason.
     *
     * Kept as a separate table rather than folded in, because the difference is
     * the finding: these three are the ones where a populated `auth.roles` for
     * the app plane WOULD still open the door. Each carries a `revisit` note in
     * the registry saying so; when one is narrowed to `platform` its row moves
     * up and its message changes with it.
     */
    const ROLE_GATED: [string, string][] = [
      ["GET", "/api/webhooks"],
      ["GET", "/api/flows"],
      ["GET", "/api/functions"],
    ];

    for (const [method, path] of ROLE_GATED) {
      test(`${method} ${path} -> 403, still only because auth.roles is empty`, async () => {
        const res = await cast.endUserA.fetch(path, { method });
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

    test("GET /api/permissions has no handler — proven on the plane that reaches it", async () => {
      // Recorded so nobody later reads a 404 here as a plane denial and deletes
      // the DELETE probe above: `/api/permissions` exposes only `DELETE /{id}`,
      // and the 404 is Hono saying "no handler", not the app saying "no".
      //
      // The app-plane caller can no longer demonstrate that — the firewall
      // refuses the prefix before routing — so the 404 is asserted on the plane
      // that DOES reach the router, and the end-user's 403 is asserted as the
      // plane denial it now is. Two callers, two different sentences, which is
      // exactly the pair that was being conflated.
      const res = await cast.endUserA.fetch("/api/permissions");
      expect(res.status).toBe(403);
      expect((await errorOf(res)).message).toBe("Operator access required");

      const admin = await cast.ownerA.fetch("/api/permissions");
      expect(admin.status, "no such route, for the caller who may reach it").toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// KNOWN GAP — reads. Phase 2 mounts the plane firewall that closes these.
// ---------------------------------------------------------------------------

/**
 * The three control-plane READS an app-plane bearer used to reach with a 2xx.
 *
 * Each is declared `plane: "platform"` in `lib/route-planes.ts` and carries
 * `requireUser` alone, so an `app_users` id walked straight through. This block
 * pinned the hole with the value each would take "once Phase 2 mounts the
 * middleware that enforces route-planes.ts" — and this is that value. The
 * firewall existed from phase 2; what phase 10 changed is that it now enforces
 * on every deploy target rather than only where a wrangler file said so.
 *
 * Each test keeps a note of what the 200 USED to hand over, because that is the
 * thing the expectation is protecting and a bare `expect(403)` would not say it.
 */
describe("control-plane reads are refused on the plane", () => {
  test("GET /api/tenants no longer leaks the active workspace id", async () => {
    // It answered 200 with `active` set to the workspace's internal UUID —
    // handed to one of its own customers, from a route the registry marks
    // "platform". The `data` array was empty only because an `app_users` id
    // matches no `tenant_members.user_id` row; the ROUTE ran to completion.
    const res = await cast.endUserA.fetch("/api/tenants");
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({
      code: "FORBIDDEN",
      message: "Operator access required",
    });

    // Both end-users, so this is a property of the plane and not of one session.
    expect((await cast.endUserB.fetch("/api/tenants")).status).toBe(403);

    // …and the door still opens for the caller it is for.
    expect((await cast.ownerA.fetch("/api/tenants")).status).toBe(200);
  });

  test("GET /api/api-keys is refused", async () => {
    // The sharpest of the three: `/api/api-keys` mints `pak_` keys, which
    // `session.ts` resolves on the PLATFORM plane — so a caller who could reach
    // this mount was one working POST away from laundering itself across the
    // boundary permanently.
    const res = await cast.endUserA.fetch("/api/api-keys");
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe("Operator access required");
    expect((await cast.ownerA.fetch("/api/api-keys")).status).toBe(200);
  });

  test("GET /api/activity is refused — the audit log", async () => {
    // The blast radius was smaller than it looked and still wrong: the handler
    // shows non-admins only rows whose `user_id` is theirs, and no platform row
    // carries an `app_users` id. But the filter was a WHERE clause, not an
    // authorization decision, and the paging envelope proved the HANDLER ran.
    const res = await cast.endUserA.fetch("/api/activity");
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe("Operator access required");
    expect((await cast.ownerA.fetch("/api/activity")).status).toBe(200);
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
 * Both are now 403 FORBIDDEN "Operator access required", and the partial-write
 * assertions have inverted into assertions that nothing was written — which is
 * the half worth keeping, because "it 500s" was never by itself evidence that
 * nothing happened.
 */
describe("control-plane writes are refused on the plane, and write nothing", () => {
  let wcast: TwoPlaneCast;
  beforeAll(async () => {
    wcast = await buildTwoPlaneCast();
  });
  afterAll(() => wcast.cleanup());

  test("POST /api/tenants is refused on the plane, and writes nothing", async () => {
    // Closed in Phase 2 by `requirePlatformMw`. It used to answer 500 — the
    // FOURTH of five non-transactional writes, `assignRoleByName` inserting
    // into `user_roles`, whose `user_id` really does reference `users`. That
    // foreign key was the ONLY thing that stopped the request, it stopped it
    // two writes too late, and where SQLite did not enforce it (its default,
    // on every boot after the first) nothing stopped it at all.
    const created = await wcast.endUserA.fetch(
      "/api/tenants",
      json("POST", { name: "Plane Boundary Squat" }),
    );
    expect(created.status).toBe(403);
    const err = await errorOf(created);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toContain("Operator access required");

    // Nothing was committed, and the CLAIM is what proves it.
    //
    // This used to read the end-user's own workspace list back — the assertion
    // that failed before the fix, because it held a workspace they owned minted
    // by a request that reported failure. That read is itself refused now (the
    // whole prefix is), so the absence is proven the stronger way instead: a
    // workspace slug is globally unique, so a real operator being able to claim
    // it means nothing holds it. An absence-from-one-list would also have been
    // satisfied by a `tenants` row that merely failed to appear in that list.
    const claimed = await wcast.ownerB.fetch(
      "/api/tenants",
      json("POST", { name: "Plane Boundary Squat" }),
    );
    expect(claimed.status, "the name an app-plane caller could not take is still free").toBe(201);
  });

  test("POST /api/api-keys is refused on the plane", async () => {
    // Closed in Phase 2 by `requirePlatformMw`. It used to answer 500 — same
    // class as the tenants case above, different luck: the key row itself
    // references `users`, so the FIRST insert tripped and there was no partial
    // state. That difference is why the tenants test asserts absence explicitly:
    // "it 500s" was never by itself evidence that nothing happened.
    //
    // A `pak_` key is what made this one matter. `sessionMiddleware` resolves
    // one on the PLATFORM plane, so an app-plane caller minting a key came back
    // holding an operator-shaped credential — laundering itself across the
    // boundary rather than crossing it.
    const res = await wcast.endUserA.fetch("/api/api-keys", json("POST", { name: "squat-key" }));
    expect(res.status).toBe(403);
    const err = await errorOf(res);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toContain("Operator access required");

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
    // explicitly — the app plane always had the gate the platform plane did
    // not. It is now reached SECOND: the firewall refuses a platform caller on
    // an `app`-declared prefix first, so the status moved from 401
    // UNAUTHORIZED to 403 FORBIDDEN. Both are refusals and the second is the
    // more honest one — the caller IS signed in, just on the wrong plane, which
    // is what 403 means and 401 does not.
    //
    // Both a workspace admin and the INSTANCE OPERATOR are refused: privilege
    // on the control plane buys nothing here, which is the property worth
    // pinning.
    for (const who of [cast.ownerA, cast.operator] as const) {
      const res = await who.fetch(`/api/t/${cast.tenantA.slug}/orgs`);
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toMatchObject({
        code: "FORBIDDEN",
        message: "Workspace end-user sign-in required",
      });
    }

    // Writes are refused on the same gate, so this is not a read-only accident.
    const write = await cast.ownerA.fetch(
      `/api/t/${cast.tenantA.slug}/orgs`,
      json("POST", { name: "Operator Org" }),
    );
    expect(write.status).toBe(403);

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

/**
 * The guard's own safety net, which did not exist.
 *
 * `plane-firewall.ts`'s docblock claimed `route-planes.test.ts` "asserts a
 * violation is observable rather than trusting that it would be". That file
 * has never existed, and until this block the string `plane-violation` appeared
 * exactly ONCE in the repository — in the middleware that emits it. Nothing
 * read it back.
 *
 * That is the failure the sentence one line above the claim warns about: a
 * guard that matches nothing reports success. The log line is the ENTIRE value
 * of `PLANE_GUARD=warn` — an operator who sets it is buying observability and
 * nothing else — so a silent regression there converts the opt-out into a
 * plain hole with no signal.
 *
 * Found by reading the docblock during phase 10's live pass and checking that
 * the test it named was real.
 */
describe("a plane violation is observable, not merely refused", () => {
  test("the refusal emits a WARN line carrying path, planes, identity and mode", async () => {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };

    let res: Response;
    try {
      // `/api/users` is declared `platform`; an app-plane bearer has no
      // business there. The 403 is asserted elsewhere in this file — what is
      // asserted here is that the refusal SAYS something.
      res = await cast.endUserA.fetch("/api/users");
    } finally {
      console.warn = original;
    }
    expect(res.status).toBe(403);

    const violation = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((o) => o?.msg === "plane-violation");

    // Every field here is one a responder needs to triage the line without
    // reproducing it, which is why they are asserted individually rather than
    // by checking the line is non-empty.
    expect(violation).toBeDefined();
    expect(violation).toMatchObject({
      msg: "plane-violation",
      path: "/api/users",
      declared: "platform",
      caller: "app",
      action: "refused",
      mode: "enforce",
    });
    // The identity has to be nameable, or the line cannot be chased to a user.
    expect(typeof violation?.userId).toBe("string");
  });
});
