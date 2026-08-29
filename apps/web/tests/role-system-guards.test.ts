/**
 * PHASE 1 — `PATCH /api/roles/{id}` now carries the system-role guard that
 * `DELETE` has always had.
 *
 * Until this landed, `DELETE` refused to remove `admin` / `authenticated` /
 * `public` while `PATCH` would happily rewrite them — which is the more
 * dangerous of the two, because it strips a system role without removing it
 * and leaves the row in place looking intact.
 *
 * What makes the rename unrecoverable is that two independent tests both mean
 * "admin" here and neither knows about the other: `requireAdmin` matches the
 * role NAME on ~190 routes, and the permission resolver's bypass matches the
 * `roles.admin` FLAG. Renaming `admin` therefore removes the entire
 * admin-gated route surface from every user in the workspace at once —
 * including `PATCH /api/roles/{id}` itself, so there is no request left that
 * could put the name back.
 *
 * This spec pins the guard AND the boundary of what it deliberately leaves
 * alone, because a guard nobody can describe is a guard somebody removes:
 *
 *   - renaming a system role, or flipping its `admin` flag in EITHER
 *     direction, is refused (403);
 *   - `description`, `mcpTools`, `mcpReadOnly` and `orgAssignable` stay
 *     editable on a system role — none of them is load-bearing for either
 *     definition of "admin", so refusing them would be scope creep;
 *   - a CUSTOM role may still be renamed and may still be given `admin: true`;
 *   - the workspace check still runs FIRST, so a role id belonging to another
 *     workspace answers 404 rather than reaching the guard at all.
 *
 * Every refusal below is preceded by an assertion of the positive state it is
 * refusing to change. An "it was not renamed" check passes just as happily
 * against a request that never reached the route, so the positive control is
 * what makes the negative mean something.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildTwoPlaneCast,
  json,
  type Caller,
  type TwoPlaneCast,
} from "./fixtures/two-plane-cast";

let cast: TwoPlaneCast;

/** Unique per run so a stray role from another spec cannot satisfy an
 *  assertion here by coincidence. */
const suffix = `${Date.now()}`.slice(-7);

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  admin: boolean;
  mcpTools: string[] | null;
  mcpReadOnly: boolean;
  orgAssignable: boolean;
}

/** Acting-as-workspace request: the roles routes read `auth.tenantId`, and
 *  `X-Backlex-Tenant` (slug or id) is what sets it. */
const inTenant = (slug: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), "X-Backlex-Tenant": slug },
});

const listRoles = async (who: Caller, slug: string): Promise<RoleRow[]> => {
  const res = await who("/api/roles", inTenant(slug));
  expect(res.status, `list roles in ${slug}`).toBe(200);
  return ((await res.json()) as { data: RoleRow[] }).data;
};

const roleNamed = async (who: Caller, slug: string, name: string): Promise<RoleRow> => {
  const row = (await listRoles(who, slug)).find((r) => r.name === name);
  expect(row, `workspace ${slug} should have a "${name}" role`).toBeDefined();
  return row!;
};

const roleById = async (
  who: Caller,
  slug: string,
  id: string,
): Promise<RoleRow | undefined> => (await listRoles(who, slug)).find((r) => r.id === id);

const patchRole = (who: Caller, slug: string, id: string, body: unknown) =>
  who(`/api/roles/${id}`, inTenant(slug, json("PATCH", body)));

/** `{ error: { code, message } }` — the shape `middleware/error.ts` emits. */
const errorOf = async (res: Response): Promise<{ code: string; message: string }> => {
  const body = (await res.json()) as { error?: { code?: string; message?: string } };
  return { code: body.error?.code ?? "", message: body.error?.message ?? "" };
};

beforeAll(async () => {
  cast = await buildTwoPlaneCast();
});

afterAll(() => cast.cleanup());

describe("PATCH /api/roles/{id} refuses to rewrite a system role", () => {
  test("renaming `admin` is refused, and `admin` still gates routes afterwards", async () => {
    const who = cast.operator.fetch;
    const slug = cast.defaultTenant.slug;
    const adminRole = await roleNamed(who, slug, "admin");

    // Positive control. Without this the 403 below could equally be produced
    // by a route that does not exist, a workspace the caller cannot reach, or
    // a role id that is wrong — all of which would let the rename assertion
    // pass while proving nothing about the guard.
    const editable = await patchRole(who, slug, adminRole.id, {
      description: `Reachable ${suffix}`,
    });
    expect(editable.status, "PATCH must reach this role at all").toBe(200);

    const renamed = await patchRole(who, slug, adminRole.id, {
      name: `administrator-${suffix}`,
    });
    expect(renamed.status).toBe(403);
    const err = await errorOf(renamed);
    expect(err.code).toBe("FORBIDDEN");
    // The message has to say WHY, because the operator reading it is the only
    // person who can decide whether they meant to do something else instead.
    expect(err.message).toContain("Cannot rename system role");
    expect(err.message).toContain("admin");

    const after = await roleById(who, slug, adminRole.id);
    expect(after?.name, "the admin role keeps its name").toBe("admin");
    expect(
      (await listRoles(who, slug)).some((r) => r.name === `administrator-${suffix}`),
      "no role should exist under the attempted new name",
    ).toBe(false);

    // The refusal has to have MATTERED. If the rename had half-applied — the
    // row updated and then the error thrown, say — every assertion above still
    // holds against a stale read, but the admin gate itself would be gone.
    // `GET /api/roles` is `requireAdminMw`-gated, so a 200 here is the gate
    // answering, not a cached copy of the role row.
    const stillAdmin = await who("/api/roles", inTenant(slug));
    expect(stillAdmin.status, "an admin-gated route still answers the operator").toBe(200);
  });

  test("renaming `authenticated` and `public` is refused too", async () => {
    const who = cast.operator.fetch;
    const slug = cast.defaultTenant.slug;

    for (const name of ["authenticated", "public"] as const) {
      const role = await roleNamed(who, slug, name);

      // Same positive control, per role: an edit that IS allowed proves the
      // request reaches the handler before we assert that a rename does not.
      const editable = await patchRole(who, slug, role.id, {
        description: `Reachable ${name} ${suffix}`,
      });
      expect(editable.status, `PATCH must reach the "${name}" role`).toBe(200);

      const renamed = await patchRole(who, slug, role.id, {
        name: `${name}-renamed-${suffix}`,
      });
      expect(renamed.status, `renaming "${name}"`).toBe(403);
      expect((await errorOf(renamed)).message).toContain(
        `Cannot rename system role "${name}"`,
      );

      expect((await roleById(who, slug, role.id))?.name, `"${name}" keeps its name`).toBe(
        name,
      );
    }
  });

  test("the `admin` flag on a system role cannot be flipped in either direction", async () => {
    const who = cast.operator.fetch;
    const slug = cast.defaultTenant.slug;
    const adminRole = await roleNamed(who, slug, "admin");
    const authRole = await roleNamed(who, slug, "authenticated");

    // The two flags start opposed, which is what makes "both directions" a
    // real pair rather than the same assertion written twice.
    expect(adminRole.admin, "the seeded `admin` role carries the flag").toBe(true);
    expect(authRole.admin, "the seeded `authenticated` role does not").toBe(false);

    // Clearing the flag on `admin` would leave the NAME intact — so every
    // `requireAdmin` route keeps answering while the permission resolver
    // quietly stops bypassing, which is the hardest version of this to notice.
    const cleared = await patchRole(who, slug, adminRole.id, { admin: false });
    expect(cleared.status).toBe(403);
    expect((await errorOf(cleared)).message).toContain("Cannot change the admin flag");
    expect((await roleById(who, slug, adminRole.id))?.admin).toBe(true);

    // Setting it on `authenticated` is the other half: an unconditional data
    // bypass for every signed-in user in the workspace.
    const granted = await patchRole(who, slug, authRole.id, { admin: true });
    expect(granted.status).toBe(403);
    expect((await errorOf(granted)).message).toContain("Cannot change the admin flag");
    expect((await roleById(who, slug, authRole.id))?.admin).toBe(false);

    // Boundary: the guard COMPARES, it does not blanket-refuse the key. A body
    // restating the value the role already holds is a no-op and is accepted —
    // which matters because the admin UI submits whole forms, not deltas.
    const noop = await patchRole(who, slug, adminRole.id, { admin: true });
    expect(noop.status, "restating the current flag value is not a change").toBe(200);
    expect((await roleById(who, slug, adminRole.id))?.admin).toBe(true);
  });

  test("description, mcpTools, mcpReadOnly and orgAssignable stay editable", async () => {
    const who = cast.operator.fetch;
    const slug = cast.defaultTenant.slug;
    const role = await roleNamed(who, slug, "authenticated");

    // None of these four feeds either definition of "admin" — not the name
    // `requireAdmin` matches, not the flag the permission resolver reads — so
    // the guard deliberately leaves them alone. Refusing them would be scope
    // creep, and would make a system role uneditable in the admin UI for
    // reasons no message could explain.
    const patched = await patchRole(who, slug, role.id, {
      description: `Signed-in users ${suffix}`,
      mcpTools: ["collections.read", "schema.*"],
      mcpReadOnly: true,
      orgAssignable: true,
    });
    expect(patched.status).toBe(200);

    const after = await roleById(who, slug, role.id);
    expect(after?.description).toBe(`Signed-in users ${suffix}`);
    expect(after?.mcpTools).toEqual(["collections.read", "schema.*"]);
    expect(after?.mcpReadOnly).toBe(true);
    expect(after?.orgAssignable).toBe(true);
    // …and the two guarded fields are untouched by a body that never named them.
    expect(after?.name).toBe("authenticated");
    expect(after?.admin).toBe(false);

    // Put the MCP knobs back: they gate what an MCP client may call, and this
    // spec should not leave the workspace narrower than it found it.
    const restored = await patchRole(who, slug, role.id, {
      mcpTools: null,
      mcpReadOnly: false,
      orgAssignable: false,
    });
    expect(restored.status).toBe(200);
  });
});

describe("PATCH /api/roles/{id} still allows what it always allowed", () => {
  test("a CUSTOM role can be renamed, and can be given `admin: true`", async () => {
    const who = cast.operator.fetch;
    const slug = cast.defaultTenant.slug;

    const created = await who(
      "/api/roles",
      inTenant(
        slug,
        json("POST", {
          name: `auditor-${suffix}`,
          description: "A custom, non-system role.",
        }),
      ),
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const renamed = await patchRole(who, slug, id, { name: `reviewer-${suffix}` });
    expect(renamed.status, "a custom role's name is not load-bearing anywhere").toBe(200);
    expect((await roleById(who, slug, id))?.name).toBe(`reviewer-${suffix}`);

    // This is a DECISION, not an oversight. `POST /api/roles` already accepts
    // `admin: true`, so refusing it on PATCH would only mean an admin deletes
    // the role and recreates it — a guard that changes the number of requests
    // and not the outcome. The escalation worth refusing is the one with no
    // way back, and that is the system-role rename above: it is reachable
    // through an endpoint that is itself gated on the name being renamed.
    const escalated = await patchRole(who, slug, id, { admin: true });
    expect(escalated.status, "granting `admin` to a custom role stays allowed").toBe(200);
    expect((await roleById(who, slug, id))?.admin).toBe(true);

    // Tidy up: this role now bypasses every permission check, and the harness
    // outlives the test. DELETE has always been allowed for a custom role.
    const deleted = await who(`/api/roles/${id}`, inTenant(slug, { method: "DELETE" }));
    expect(deleted.status).toBe(200);
  });
});

describe("the guard is scoped to the active workspace", () => {
  test("ownerA cannot PATCH a role belonging to workspace B", async () => {
    const b = cast.ownerB.fetch;
    const a = cast.ownerA.fetch;

    const created = await b(
      "/api/roles",
      inTenant(cast.tenantB.slug, json("POST", { name: `b-only-${suffix}` })),
    );
    expect(created.status).toBe(201);
    const bRoleId = ((await created.json()) as { data: { id: string } }).data.id;

    // Positive control on the ID itself: its own workspace's admin can patch
    // it. Without this, the 404 below is equally consistent with a role id
    // that never existed, and the test would pass against a route that has no
    // workspace predicate at all.
    const byOwner = await patchRole(b, cast.tenantB.slug, bRoleId, {
      name: `b-only-renamed-${suffix}`,
    });
    expect(byOwner.status, "workspace B's own admin can rename its custom role").toBe(200);

    // ownerA is `admin` — but only inside workspace A. `ensureRoleInTenant`
    // pairs the id with the ACTIVE tenant, so a foreign id is not a 403 with a
    // hint that it exists; it is simply not there.
    const crossed = await patchRole(a, cast.tenantA.slug, bRoleId, {
      name: `stolen-${suffix}`,
    });
    expect(crossed.status).toBe(404);
    expect((await errorOf(crossed)).code).toBe("NOT_FOUND");

    expect(
      (await roleById(b, cast.tenantB.slug, bRoleId))?.name,
      "workspace B's role is untouched by the cross-workspace attempt",
    ).toBe(`b-only-renamed-${suffix}`);

    // And the ordering matters: the workspace check runs BEFORE the
    // system-role guard, so B's `admin` role answers 404 to ownerA rather than
    // the 403 it would give its own workspace's admin. A 403 here would leak
    // that the id names a system role in some workspace.
    const bAdmin = await roleNamed(b, cast.tenantB.slug, "admin");
    const crossedSystem = await patchRole(a, cast.tenantA.slug, bAdmin.id, {
      name: `stolen-admin-${suffix}`,
    });
    expect(crossedSystem.status).toBe(404);
    expect((await errorOf(crossedSystem)).code).toBe("NOT_FOUND");

    // …while workspace A's OWN `admin` role gives ownerA the 403, proving the
    // 404s above are about the workspace and not about ownerA lacking the
    // rights to be refused in the first place.
    const aAdmin = await roleNamed(a, cast.tenantA.slug, "admin");
    const ownWorkspace = await patchRole(a, cast.tenantA.slug, aAdmin.id, {
      name: `renamed-${suffix}`,
    });
    expect(ownWorkspace.status).toBe(403);
    expect((await errorOf(ownWorkspace)).message).toContain("Cannot rename system role");
  });
});
