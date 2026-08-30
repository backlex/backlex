import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildTwoPlaneCast, type TwoPlaneCast } from "./fixtures/two-plane-cast";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * App-plane organizations ("teams") — the B2B grouping level inside one
 * workspace.
 *
 * What this pins:
 *   1. admin CRUD over `/api/app-orgs`, including the slug rules;
 *   2. the membership invariants (last owner can't be demoted or removed);
 *   3. the end-user self-service surface under `/api/t/:slug/orgs` — create,
 *      invite, accept, leave — and its role gates;
 *   4. the payoff: a permission rule conditioned on `$org.id` scopes data to
 *      the org the request is acting in, and `X-Backlex-Org` / the session's
 *      pinned org / the sole-membership fallback all select it correctly;
 *   5. org-scoped role grants (`app_org_member_roles`) apply only inside their
 *      own org.
 */

const JSON_HEADERS = { "content-type": "application/json" };

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

type Bearer = (path: string, init?: RequestInit) => Promise<Response>;

/** App-plane caller. `org` sets `X-Backlex-Org` on every call. */
const bearerFor = (h: TestHarness, token: string, org?: string): Bearer =>
  (path, init = {}) =>
    h.app.request(path, {
      ...init,
      headers: {
        ...JSON_HEADERS,
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        ...(org ? { "X-Backlex-Org": org } : {}),
      },
    });

/** Admin-invite an end-user and accept it, returning their id + session token. */
const makeEndUser = async (
  h: TestHarness,
  email: string,
): Promise<{ id: string; token: string; email: string }> => {
  const invited = await h.fetch("/api/app-users/invite", json("POST", { email }));
  expect(invited.status).toBe(201);
  const { data } = (await invited.json()) as {
    data: { id: string; email: string; token: string };
  };
  const accepted = await h.app.request(
    "/api/t/default/auth/invite/accept",
    json("POST", { token: data.token, password: "org-pass-12345" }),
  );
  expect(accepted.status).toBe(200);
  const session = (await accepted.json()) as { token: string };
  return { id: data.id, token: session.token, email: data.email };
};

const roleIdByName = async (h: TestHarness, name: string): Promise<string> => {
  const res = await h.fetch("/api/roles");
  expect(res.status).toBe(200);
  const roles = ((await res.json()) as { data: { id: string; name: string }[] }).data;
  const role = roles.find((r) => r.name === name);
  expect(role, `role "${name}" should exist`).toBeDefined();
  return role!.id;
};

const ids = async (res: Response): Promise<string[]> => {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: unknown }[] };
  return body.data.map((r) => String(r.id));
};

describe("app-orgs — admin CRUD", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("create derives a slug, auto-suffixes collisions, rejects an explicit dupe", async () => {
    const first = await h.fetch("/api/app-orgs", json("POST", { name: "Acme Inc." }));
    expect(first.status).toBe(201);
    const a = ((await first.json()) as { data: { id: string; slug: string } }).data;
    expect(a.slug).toBe("acme-inc");

    // Same display name again — the derived slug is taken, so it's suffixed
    // rather than failing (the caller never chose it).
    const second = await h.fetch("/api/app-orgs", json("POST", { name: "Acme Inc." }));
    expect(second.status).toBe(201);
    const b = ((await second.json()) as { data: { slug: string } }).data;
    expect(b.slug).toBe("acme-inc-2");

    // An EXPLICIT slug that's taken is a conflict — silently renaming what the
    // caller asked for would be worse than telling them.
    const clash = await h.fetch(
      "/api/app-orgs",
      json("POST", { name: "Third", slug: "acme-inc" }),
    );
    expect(clash.status).toBe(409);
  });

  test("get resolves by id or slug; list carries member counts", async () => {
    const created = await h.fetch("/api/app-orgs", json("POST", { name: "Globex" }));
    const org = ((await created.json()) as { data: { id: string; slug: string } }).data;

    const byId = await h.fetch(`/api/app-orgs/${org.id}`);
    expect(byId.status).toBe(200);
    const bySlug = await h.fetch(`/api/app-orgs/${org.slug}`);
    expect(bySlug.status).toBe(200);
    expect(((await bySlug.json()) as { data: { id: string } }).data.id).toBe(org.id);

    const list = (await (await h.fetch("/api/app-orgs?q=globex")).json()) as {
      data: { slug: string; memberCount: number }[];
    };
    expect(list.data.map((o) => o.slug)).toEqual(["globex"]);
    expect(list.data[0]!.memberCount).toBe(0);
  });

  test("delete drops the org; a second delete is a 404", async () => {
    const created = await h.fetch("/api/app-orgs", json("POST", { name: "Temp Co" }));
    const org = ((await created.json()) as { data: { id: string } }).data;
    expect((await h.fetch(`/api/app-orgs/${org.id}`, json("DELETE"))).status).toBe(200);
    expect((await h.fetch(`/api/app-orgs/${org.id}`, json("DELETE"))).status).toBe(404);
  });

  test("non-admins are forbidden", async () => {
    await h.fetch("/api/auth/sign-out", json("POST"));
    const su = await h.fetch(
      "/api/auth/sign-up/email",
      json("POST", {
        email: `viewer-${Date.now()}@example.test`,
        password: "viewer-pass-123",
        name: "Viewer",
      }),
    );
    expect(su.status).toBe(200);
    expect((await h.fetch("/api/app-orgs")).status).toBe(403);
  });
});

describe("app-orgs — membership invariants", () => {
  let h: TestHarness;
  let orgId: string;
  let alice: { id: string; token: string; email: string };
  let bob: { id: string; token: string; email: string };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    alice = await makeEndUser(h, "alice@orgs.test");
    bob = await makeEndUser(h, "bob@orgs.test");
    const created = await h.fetch(
      "/api/app-orgs",
      json("POST", { name: "Initech", ownerAppUserId: alice.id }),
    );
    expect(created.status).toBe(201);
    orgId = ((await created.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("the creator's owner seat is recorded", async () => {
    const members = (await (await h.fetch(`/api/app-orgs/${orgId}/members`)).json()) as {
      data: { appUserId: string; role: string }[];
    };
    expect(members.data).toHaveLength(1);
    expect(members.data[0]).toMatchObject({ appUserId: alice.id, role: "owner" });
  });

  test("the last owner can be neither demoted nor removed", async () => {
    const demote = await h.fetch(
      `/api/app-orgs/${orgId}/members/${alice.id}`,
      json("PATCH", { role: "member" }),
    );
    expect(demote.status).toBe(422);

    const remove = await h.fetch(
      `/api/app-orgs/${orgId}/members/${alice.id}`,
      json("DELETE"),
    );
    expect(remove.status).toBe(422);
  });

  test("promoting a second owner unblocks the first one's exit", async () => {
    const added = await h.fetch(
      `/api/app-orgs/${orgId}/members`,
      json("POST", { appUserId: bob.id, role: "owner" }),
    );
    expect(added.status).toBe(201);

    const demote = await h.fetch(
      `/api/app-orgs/${orgId}/members/${alice.id}`,
      json("PATCH", { role: "member" }),
    );
    expect(demote.status).toBe(200);
    expect(((await demote.json()) as { data: { role: string } }).data.role).toBe("member");

    const remove = await h.fetch(
      `/api/app-orgs/${orgId}/members/${alice.id}`,
      json("DELETE"),
    );
    expect(remove.status).toBe(200);
  });

  test("adding the same person twice is a conflict", async () => {
    const dupe = await h.fetch(
      `/api/app-orgs/${orgId}/members`,
      json("POST", { appUserId: bob.id }),
    );
    expect(dupe.status).toBe(409);
  });

  test("the workspace admin role can never be bound as an in-org role", async () => {
    const adminRoleId = await roleIdByName(h, "admin");
    const res = await h.fetch(
      `/api/app-orgs/${orgId}/members/${bob.id}`,
      json("PATCH", { roleIds: [adminRoleId] }),
    );
    expect(res.status).toBe(422);
  });
});

describe("app-orgs — end-user self-service", () => {
  let h: TestHarness;
  let alice: { id: string; token: string; email: string };
  let bob: { id: string; token: string; email: string };
  let aliceFetch: Bearer;
  let bobFetch: Bearer;
  let orgId: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    alice = await makeEndUser(h, "alice@self.test");
    bob = await makeEndUser(h, "bob@self.test");
    aliceFetch = bearerFor(h, alice.token);
    bobFetch = bearerFor(h, bob.token);
  });
  afterAll(() => h.cleanup());

  test("creating an org makes the creator its owner", async () => {
    const res = await aliceFetch("/api/t/default/orgs", json("POST", { name: "Alice Co" }));
    expect(res.status).toBe(201);
    const org = ((await res.json()) as { data: { id: string; role: string } }).data;
    expect(org.role).toBe("owner");
    orgId = org.id;

    const mine = (await (await aliceFetch("/api/t/default/orgs")).json()) as {
      data: { id: string; role: string }[];
      active: { orgId: string | null };
    };
    expect(mine.data.map((o) => o.id)).toEqual([orgId]);
    // Sole membership resolves without any explicit selection.
    expect(mine.active.orgId).toBe(orgId);
  });

  test("a non-member sees nothing and can't read the org", async () => {
    const theirs = (await (await bobFetch("/api/t/default/orgs")).json()) as {
      data: unknown[];
    };
    expect(theirs.data).toHaveLength(0);
    expect((await bobFetch(`/api/t/default/orgs/${orgId}`)).status).toBe(403);
  });

  test("an anonymous caller is unauthorized", async () => {
    const res = await h.app.request("/api/t/default/orgs", { headers: JSON_HEADERS });
    expect(res.status).toBe(401);
  });

  test("invite → accept, and the invite is addressed to one person", async () => {
    const invited = await aliceFetch(
      `/api/t/default/orgs/${orgId}/invites`,
      json("POST", { email: bob.email }),
    );
    expect(invited.status).toBe(201);
    const invite = ((await invited.json()) as { data: { token: string } }).data;

    // Inviting the same address again while it's pending is a conflict.
    const again = await aliceFetch(
      `/api/t/default/orgs/${orgId}/invites`,
      json("POST", { email: bob.email }),
    );
    expect(again.status).toBe(409);

    // A different account holding the token can't redeem it — the invitation
    // names a person, it isn't bearer authority.
    const wrongPerson = await aliceFetch(
      "/api/t/default/orgs/invites/accept",
      json("POST", { token: invite.token }),
    );
    expect(wrongPerson.status).toBe(403);

    const accepted = await bobFetch(
      "/api/t/default/orgs/invites/accept",
      json("POST", { token: invite.token }),
    );
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { data: { role: string } }).data.role).toBe("member");

    // One-shot: the same token can't be replayed.
    const replay = await bobFetch(
      "/api/t/default/orgs/invites/accept",
      json("POST", { token: invite.token }),
    );
    expect(replay.status).toBe(422);
  });

  test("a plain member can't invite, rename, or delete", async () => {
    expect(
      (
        await bobFetch(
          `/api/t/default/orgs/${orgId}/invites`,
          json("POST", { email: "someone@self.test" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await bobFetch(`/api/t/default/orgs/${orgId}`, json("PATCH", { name: "Bob Co" }))).status,
    ).toBe(403);
    expect((await bobFetch(`/api/t/default/orgs/${orgId}`, json("DELETE"))).status).toBe(403);
  });

  test("an org admin can't mint an owner — only an owner can", async () => {
    const promote = await aliceFetch(
      `/api/t/default/orgs/${orgId}/members/${bob.id}`,
      json("PATCH", { role: "admin" }),
    );
    expect(promote.status).toBe(200);

    // Bob is now an org admin; he may manage members but not create an owner.
    const escalate = await bobFetch(
      `/api/t/default/orgs/${orgId}/members/${bob.id}`,
      json("PATCH", { role: "owner" }),
    );
    expect(escalate.status).toBe(403);
  });

  test("leaving works for a non-owner and is blocked for the last owner", async () => {
    expect(
      (await bobFetch(`/api/t/default/orgs/${orgId}/leave`, json("POST"))).status,
    ).toBe(200);
    // Alice is the only owner left.
    expect(
      (await aliceFetch(`/api/t/default/orgs/${orgId}/leave`, json("POST"))).status,
    ).toBe(422);
  });
});

describe("app-orgs — deleting an end-user takes their seat with them", () => {
  let h: TestHarness;
  let orgId: string;
  let alice: { id: string; token: string; email: string };
  let bob: { id: string; token: string; email: string };

  /** Count rows in a system table with the admin SQL runner — the only way to
   *  see a membership row that every API listing has already inner-joined away. */
  const countRows = async (sql: string): Promise<number> => {
    const res = await h.fetch("/api/admin/db/sql/run", json("POST", { sql }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { rows?: Record<string, unknown>[] }[] };
    const row = body.data[0]?.rows?.[0] ?? {};
    return Number(Object.values(row)[0] ?? 0);
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    alice = await makeEndUser(h, "alice@ghost.test");
    bob = await makeEndUser(h, "bob@ghost.test");
    const created = await h.fetch(
      "/api/app-orgs",
      json("POST", { name: "Ghost Co", ownerAppUserId: alice.id }),
    );
    orgId = ((await created.json()) as { data: { id: string } }).data.id;
    // Two owners, so the last-owner guard is not what's under test here.
    expect(
      (
        await h.fetch(
          `/api/app-orgs/${orgId}/members`,
          json("POST", { appUserId: bob.id, role: "owner" }),
        )
      ).status,
    ).toBe(201);
    // …and an org-scoped grant on the doomed account, to prove the binding goes too.
    const grantedRoleId = await roleIdByName(h, "authenticated");
    expect(
      (
        await h.fetch(
          `/api/app-orgs/${orgId}/members/${alice.id}`,
          json("PATCH", { roleIds: [grantedRoleId] }),
        )
      ).status,
    ).toBe(200);
  });
  afterAll(() => h.cleanup());

  /**
   * An `app_org_members` row orphaned by an account deletion is invisible AND
   * counted: every listing inner-joins `app_users` so it vanishes from the UI,
   * while `ownerCount` still sees it. That ghost owner satisfies the
   * last-owner guard, so the org's only REAL owner could then be removed and
   * the org left with nobody able to administer it.
   */
  test("the deleted owner leaves no ghost behind", async () => {
    expect((await h.fetch(`/api/app-users/${alice.id}`, json("DELETE"))).status).toBe(200);

    expect(await countRows(`SELECT COUNT(*) FROM app_org_members WHERE org_id = '${orgId}'`)).toBe(1);
    expect(
      await countRows(`SELECT COUNT(*) FROM app_org_member_roles WHERE org_id = '${orgId}'`),
    ).toBe(0);

    const list = (await (await h.fetch("/api/app-orgs?q=ghost")).json()) as {
      data: { memberCount: number }[];
    };
    expect(list.data[0]!.memberCount).toBe(1);
  });

  test("the surviving owner is protected again, because nothing fakes a second one", async () => {
    const remove = await h.fetch(`/api/app-orgs/${orgId}/members/${bob.id}`, json("DELETE"));
    expect(remove.status).toBe(422);

    const members = (await (await h.fetch(`/api/app-orgs/${orgId}/members`)).json()) as {
      data: { appUserId: string; role: string }[];
    };
    expect(members.data).toEqual([
      expect.objectContaining({ appUserId: bob.id, role: "owner" }),
    ]);
  });
});

describe("app-orgs — which roles may leave the workspace", () => {
  let h: TestHarness;
  let orgId: string;
  let owner: { id: string; token: string; email: string };
  let member: { id: string; token: string; email: string };
  let ownerFetch: Bearer;
  /** Marked org-assignable by the operator. */
  let openRoleId: string;
  /** A role written for the operator's own staff — never opened up. */
  let staffRoleId: string;

  const createRole = async (name: string, orgAssignable: boolean): Promise<string> => {
    const res = await h.fetch(
      "/api/roles",
      json("POST", { name, description: name, orgAssignable }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    owner = await makeEndUser(h, "owner@grant.test");
    member = await makeEndUser(h, "member@grant.test");
    ownerFetch = bearerFor(h, owner.token);
    openRoleId = await createRole("org_editor", true);
    staffRoleId = await createRole("support_staff", false);

    const created = await h.fetch(
      "/api/app-orgs",
      json("POST", { name: "Grant Co", ownerAppUserId: owner.id }),
    );
    orgId = ((await created.json()) as { data: { id: string } }).data.id;
    expect(
      (
        await h.fetch(
          `/api/app-orgs/${orgId}/members`,
          json("POST", { appUserId: member.id }),
        )
      ).status,
    ).toBe(201);
  });
  afterAll(() => h.cleanup());

  /**
   * The org owner is a customer's end-user, not the operator. Before the flag,
   * the only role they couldn't bind was `admin` — so a role written for
   * internal staff was theirs to hand out, to their members and to themselves.
   */
  test("an org owner can't bind a role the operator kept for themselves", async () => {
    const res = await ownerFetch(
      `/api/t/default/orgs/${orgId}/members/${member.id}`,
      json("PATCH", { roleIds: [staffRoleId] }),
    );
    expect(res.status).toBe(422);
    // Named, not counted — otherwise the only way forward is guessing.
    expect(await res.text()).toContain("support_staff");
  });

  test("…and can bind one the operator opened up", async () => {
    const res = await ownerFetch(
      `/api/t/default/orgs/${orgId}/members/${member.id}`,
      json("PATCH", { roleIds: [openRoleId] }),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { roles: { id: string }[] } };
    expect(data.roles.map((r) => r.id)).toEqual([openRoleId]);
  });

  test("a mixed set is refused whole — no partial grant", async () => {
    const res = await ownerFetch(
      `/api/t/default/orgs/${orgId}/members/${member.id}`,
      json("PATCH", { roleIds: [openRoleId, staffRoleId] }),
    );
    expect(res.status).toBe(422);
    // The earlier grant is untouched: validation runs before the delete.
    const members = (await (await h.fetch(`/api/app-orgs/${orgId}/members`)).json()) as {
      data: { appUserId: string; roles: { id: string }[] }[];
    };
    const row = members.data.find((m) => m.appUserId === member.id);
    expect(row!.roles.map((r) => r.id)).toEqual([openRoleId]);
  });

  test("the same bar applies to an org admin's invitation", async () => {
    const res = await ownerFetch(
      `/api/t/default/orgs/${orgId}/invites`,
      json("POST", { email: "newcomer@grant.test", roleIds: [staffRoleId] }),
    );
    expect(res.status).toBe(422);
  });

  test("the control plane is not held to it — the operator IS the author", async () => {
    const bind = await h.fetch(
      `/api/app-orgs/${orgId}/members/${member.id}`,
      json("PATCH", { roleIds: [staffRoleId] }),
    );
    expect(bind.status).toBe(200);

    // And may stage one on an invitation the org couldn't have minted itself.
    const invite = await h.fetch(
      `/api/app-orgs/${orgId}/invites`,
      json("POST", { email: "staffer@grant.test", roleIds: [staffRoleId] }),
    );
    expect(invite.status).toBe(201);
  });

  test("an operator-staged role survives being accepted", async () => {
    const staffer = await makeEndUser(h, "staffer@grant.test");
    const pending = (await (
      await h.fetch(`/api/app-orgs/${orgId}/invites?pending=true`)
    ).json()) as { data: { email: string }[] };
    expect(pending.data.map((i) => i.email)).toContain("staffer@grant.test");

    // The token is write-only, so mint a fresh invitation to redeem: authority
    // came from whoever minted it, and accepting must not re-judge it against
    // the accepting user's plane.
    const minted = await h.fetch(
      `/api/app-orgs/${orgId}/invites`,
      json("POST", { email: "staffer2@grant.test", roleIds: [staffRoleId] }),
    );
    expect(minted.status).toBe(201);
    const token = ((await minted.json()) as { data: { token: string } }).data.token;
    const staffer2 = await makeEndUser(h, "staffer2@grant.test");
    const accepted = await bearerFor(h, staffer2.token)(
      "/api/t/default/orgs/invites/accept",
      json("POST", { token }),
    );
    expect(accepted.status).toBe(200);

    const members = (await (await h.fetch(`/api/app-orgs/${orgId}/members`)).json()) as {
      data: { appUserId: string; roles: { id: string }[] }[];
    };
    const row = members.data.find((m) => m.appUserId === staffer2.id);
    expect(row!.roles.map((r) => r.id)).toEqual([staffRoleId]);
    expect(staffer.id).toBeDefined();
  });

  /**
   * The reason the migration can ship every role closed without a backfill: the
   * flag gates MAKING a grant, never honouring one. A binding an operator made
   * before the flag existed keeps resolving, so nobody loses access on deploy —
   * only the org admin's ability to re-grant it changes.
   */
  test("a binding to a closed role keeps resolving — the flag gates granting, not holding", async () => {
    // Operator binds the closed role (the pre-upgrade state, reproduced).
    expect(
      (
        await h.fetch(
          `/api/app-orgs/${orgId}/members/${member.id}`,
          json("PATCH", { roleIds: [staffRoleId] }),
        )
      ).status,
    ).toBe(200);

    // It shows up in the member's effective roles for this org…
    const sim = await h.fetch(
      "/api/permissions/simulate",
      json("POST", {
        plane: "app",
        userId: member.id,
        orgId,
        collection: "posts",
        action: "read",
      }),
    );
    expect(sim.status).toBe(200);
    const { data } = (await sim.json()) as { data: { roles?: { name: string }[] } };
    expect((data.roles ?? []).map((r) => r.name)).toContain("support_staff");

    // …while the org owner still can't hand that same role out themselves.
    const regrant = await ownerFetch(
      `/api/t/default/orgs/${orgId}/members/${member.id}`,
      json("PATCH", { roleIds: [staffRoleId] }),
    );
    expect(regrant.status).toBe(422);
  });

  test("workspace-wide role assignment is unaffected by the flag", async () => {
    // `PUT /api/app-users/{id}/roles` is the operator's own path — a role that
    // is closed to organizations is still perfectly assignable there.
    const res = await h.fetch(
      `/api/app-users/${member.id}/roles`,
      json("PUT", { roleIds: [staffRoleId] }),
    );
    expect(res.status).toBe(200);
  });
});

describe("app-orgs — the rank order inside an org", () => {
  let h: TestHarness;
  let orgId: string;
  let owner: { id: string; token: string; email: string };
  let coOwner: { id: string; token: string; email: string };
  let orgAdmin: { id: string; token: string; email: string };
  let plain: { id: string; token: string; email: string };
  let adminFetch: Bearer;
  let ownerFetch: Bearer;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    owner = await makeEndUser(h, "owner@rank.test");
    coOwner = await makeEndUser(h, "co-owner@rank.test");
    orgAdmin = await makeEndUser(h, "admin@rank.test");
    plain = await makeEndUser(h, "plain@rank.test");
    ownerFetch = bearerFor(h, owner.token);
    adminFetch = bearerFor(h, orgAdmin.token);

    const created = await h.fetch(
      "/api/app-orgs",
      json("POST", { name: "Rank Co", ownerAppUserId: owner.id }),
    );
    orgId = ((await created.json()) as { data: { id: string } }).data.id;
    for (const [user, role] of [
      [coOwner, "owner"],
      [orgAdmin, "admin"],
      [plain, "member"],
    ] as const) {
      const res = await h.fetch(
        `/api/app-orgs/${orgId}/members`,
        json("POST", { appUserId: user.id, role }),
      );
      expect(res.status).toBe(201);
    }
  });
  afterAll(() => h.cleanup());

  /**
   * "Only an owner can grant ownership" bounded what an org admin could hand
   * out. It said nothing about what they could take away — so with a second
   * owner present (the last-owner guard satisfied) an admin could demote and
   * then remove the founder.
   */
  test("an org admin can neither demote nor remove an owner", async () => {
    const demote = await adminFetch(
      `/api/t/default/orgs/${orgId}/members/${owner.id}`,
      json("PATCH", { role: "member" }),
    );
    expect(demote.status).toBe(403);

    const remove = await adminFetch(
      `/api/t/default/orgs/${orgId}/members/${owner.id}`,
      json("DELETE"),
    );
    expect(remove.status).toBe(403);

    // Nor may they re-badge an owner's org-scoped workspace roles.
    const regrant = await adminFetch(
      `/api/t/default/orgs/${orgId}/members/${owner.id}`,
      json("PATCH", { roleIds: [] }),
    );
    expect(regrant.status).toBe(403);
  });

  test("an org admin still manages everyone at or below their own rank", async () => {
    // A peer admin is not above them, so this stays allowed.
    const promotePlain = await adminFetch(
      `/api/t/default/orgs/${orgId}/members/${plain.id}`,
      json("PATCH", { role: "admin" }),
    );
    expect(promotePlain.status).toBe(200);

    const removePeer = await adminFetch(
      `/api/t/default/orgs/${orgId}/members/${plain.id}`,
      json("DELETE"),
    );
    expect(removePeer.status).toBe(200);

    // And they can always step down themselves.
    const stepDown = await adminFetch(
      `/api/t/default/orgs/${orgId}/members/${orgAdmin.id}`,
      json("PATCH", { role: "member" }),
    );
    expect(stepDown.status).toBe(200);
  });

  test("an owner may act on a fellow owner", async () => {
    const demote = await ownerFetch(
      `/api/t/default/orgs/${orgId}/members/${coOwner.id}`,
      json("PATCH", { role: "member" }),
    );
    expect(demote.status).toBe(200);
  });

  test("the control plane is outside the rank order entirely", async () => {
    // A workspace admin administers their customer's org from /api/app-orgs and
    // holds no membership row, so neither guard applies to them: minting an
    // owner from a plain member is exactly what an app-plane admin cannot do.
    const res = await h.fetch(
      `/api/app-orgs/${orgId}/members/${orgAdmin.id}`,
      json("PATCH", { role: "owner" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { role: string } }).data.role).toBe("owner");
  });
});

describe("app-orgs — permission scoping via $org.id", () => {
  let h: TestHarness;
  let alice: { id: string; token: string; email: string };
  let acme: string;
  let globex: string;
  let acmeRowId: string;
  let globexRowId: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    // A collection whose rows belong to an org.
    const created = await h.fetch(
      "/api/collections",
      json("POST", {
        slug: "tickets",
        fields: [
          { name: "title", type: "text" },
          { name: "org_id", type: "text" },
        ],
      }),
    );
    expect(created.status).toBe(201);

    // Every authenticated end-user may read tickets — but only their active
    // org's. This is the rule the whole feature exists to make expressible.
    const authRoleId = await roleIdByName(h, "authenticated");
    const granted = await h.fetch(
      `/api/roles/${authRoleId}/permissions`,
      json("POST", {
        collection: "tickets",
        action: "read",
        condition: { org_id: { _eq: "$org.id" } },
      }),
    );
    expect(granted.status).toBeLessThan(300);

    alice = await makeEndUser(h, "alice@scope.test");
    for (const name of ["Acme", "Globex"]) {
      const res = await h.fetch(
        "/api/app-orgs",
        json("POST", { name, ownerAppUserId: alice.id }),
      );
      expect(res.status).toBe(201);
      const org = ((await res.json()) as { data: { id: string; slug: string } }).data;
      if (name === "Acme") acme = org.id;
      else globex = org.id;
    }

    for (const [orgId, title] of [
      [acme, "acme ticket"],
      [globex, "globex ticket"],
    ] as const) {
      const res = await h.fetch("/api/items/tickets", json("POST", { title, org_id: orgId }));
      expect(res.status).toBe(201);
      const row = ((await res.json()) as { data: { id: unknown } }).data;
      if (orgId === acme) acmeRowId = String(row.id);
      else globexRowId = String(row.id);
    }
  });
  afterAll(() => h.cleanup());

  test("X-Backlex-Org picks the org, and rows are scoped to it", async () => {
    expect(await ids(await bearerFor(h, alice.token, acme)("/api/items/tickets"))).toEqual([
      acmeRowId,
    ]);
    expect(await ids(await bearerFor(h, alice.token, globex)("/api/items/tickets"))).toEqual([
      globexRowId,
    ]);
  });

  test("a slug works in the header too", async () => {
    expect(await ids(await bearerFor(h, alice.token, "acme")("/api/items/tickets"))).toEqual([
      acmeRowId,
    ]);
  });

  test("naming an org you don't belong to is rejected, not silently ignored", async () => {
    const outsider = await makeEndUser(h, "outsider@scope.test");
    const res = await bearerFor(h, outsider.token, acme)("/api/items/tickets");
    expect(res.status).toBe(403);
  });

  test("with several orgs and no selection, an $org.id rule matches nothing", async () => {
    // Failing closed matters here: resolving to "some org" would leak whichever
    // one happened to sort first.
    const res = await bearerFor(h, alice.token)("/api/items/tickets");
    expect(await ids(res)).toEqual([]);
  });

  test("set-active pins the session, and clearing it goes back to nothing", async () => {
    const call = bearerFor(h, alice.token);
    const pinned = await call("/api/t/default/orgs/set-active", json("POST", { orgId: globex }));
    expect(pinned.status).toBe(200);
    expect(await ids(await call("/api/items/tickets"))).toEqual([globexRowId]);

    // An explicit header still overrides the pinned org.
    expect(await ids(await bearerFor(h, alice.token, acme)("/api/items/tickets"))).toEqual([
      acmeRowId,
    ]);

    const cleared = await call("/api/t/default/orgs/set-active", json("POST", { orgId: null }));
    expect(cleared.status).toBe(200);
    expect(await ids(await call("/api/items/tickets"))).toEqual([]);
  });

  test("$user.orgs spans every membership without an active selection", async () => {
    const authRoleId = await roleIdByName(h, "authenticated");
    const perms = ((await (
      await h.fetch(`/api/roles/${authRoleId}/permissions`)
    ).json()) as { data: { id: string; collection: string }[] }).data;
    for (const p of perms.filter((x) => x.collection === "tickets")) {
      expect((await h.fetch(`/api/permissions/${p.id}`, json("DELETE"))).status).toBeLessThan(300);
    }
    const granted = await h.fetch(
      `/api/roles/${authRoleId}/permissions`,
      json("POST", {
        collection: "tickets",
        action: "read",
        condition: { org_id: { _in: "$user.orgs" } },
      }),
    );
    expect(granted.status).toBeLessThan(300);

    const seen = await ids(await bearerFor(h, alice.token)("/api/items/tickets"));
    expect(seen.sort()).toEqual([acmeRowId, globexRowId].sort());
  });
});

describe("app-orgs — org-scoped role grants", () => {
  let h: TestHarness;
  let alice: { id: string; token: string; email: string };
  let acme: string;
  let globex: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const created = await h.fetch(
      "/api/collections",
      json("POST", { slug: "reports", fields: [{ name: "title", type: "text" }] }),
    );
    expect(created.status).toBe(201);
    await h.fetch("/api/items/reports", json("POST", { title: "Q3" }));

    // A custom role that can read reports — granted to Alice in Acme ONLY.
    const roleRes = await h.fetch("/api/roles", json("POST", { name: "Analyst" }));
    expect(roleRes.status).toBeLessThan(300);
    const analystId = ((await roleRes.json()) as { data: { id: string } }).data.id;
    const granted = await h.fetch(
      `/api/roles/${analystId}/permissions`,
      json("POST", { collection: "reports", action: "read", condition: null }),
    );
    expect(granted.status).toBeLessThan(300);

    alice = await makeEndUser(h, "alice@roles.test");
    for (const name of ["Acme", "Globex"]) {
      const res = await h.fetch(
        "/api/app-orgs",
        json("POST", { name, ownerAppUserId: alice.id }),
      );
      const org = ((await res.json()) as { data: { id: string } }).data;
      if (name === "Acme") acme = org.id;
      else globex = org.id;
    }
    const bound = await h.fetch(
      `/api/app-orgs/${acme}/members/${alice.id}`,
      json("PATCH", { roleIds: [analystId] }),
    );
    expect(bound.status).toBe(200);
  });
  afterAll(() => h.cleanup());

  test("the grant applies in its own org and nowhere else", async () => {
    const inAcme = await bearerFor(h, alice.token, acme)("/api/items/reports");
    expect(inAcme.status).toBe(200);
    expect((await ids(inAcme)).length).toBe(1);

    // Same person, same token — a different org means a different role bundle.
    const inGlobex = await bearerFor(h, alice.token, globex)("/api/items/reports");
    expect(inGlobex.status).toBe(403);
  });

  test("removing the member drops the org-scoped grant with them", async () => {
    const removed = await h.fetch(
      `/api/app-orgs/${acme}/members/${alice.id}`,
      json("DELETE"),
    );
    // Alice is Acme's only owner, so removal is blocked — add a second owner
    // first, exactly as a real operator would have to.
    expect(removed.status).toBe(422);

    const bob = await makeEndUser(h, "bob@roles.test");
    expect(
      (
        await h.fetch(
          `/api/app-orgs/${acme}/members`,
          json("POST", { appUserId: bob.id, role: "owner" }),
        )
      ).status,
    ).toBe(201);
    expect(
      (await h.fetch(`/api/app-orgs/${acme}/members/${alice.id}`, json("DELETE"))).status,
    ).toBe(200);

    const after = await bearerFor(h, alice.token, acme)("/api/items/reports");
    // She's no longer a member, so the header names an org she can't act in.
    expect(after.status).toBe(403);
  });
});

/**
 * ── PHASE 0: the PLANE boundary around organizations ────────────────────────
 *
 * Everything above this line runs inside ONE plane. The admin CRUD suite drives
 * a control-plane cookie at `/api/app-orgs`; the self-service suite drives an
 * app-plane bearer at `/api/t/:slug/orgs`; the scoping suites vary the org, not
 * the credential. So the suite has 38 tests about organizations and not one of
 * them ever pointed a credential at the surface built for the OTHER plane —
 * which is exactly the invariant a two-plane product cannot afford to leave
 * unexecuted.
 *
 * This block pins TODAY's answers, including the ones that are only accidentally
 * right. It changes no runtime behaviour, and it is deliberately written so that
 * Phase 1's fix reads as a contract change in the diff rather than as a quiet
 * test edit.
 */
describe("app-orgs — the plane boundary", () => {
  let cast: TwoPlaneCast;
  /** endUserA's own org in workspace A. Their membership makes it selectable. */
  let alphaId = "";
  /** An org in workspace A that endUserA is NOT a member of, minted through the
   *  operator surface with no `ownerAppUserId` so it has no members at all. */
  let foreignId = "";
  /** endUserB's own org, in workspace B. Its presence is what makes the
   *  cross-workspace assertions below non-vacuous: the two lists differ. */
  let betaId = "";

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();

    const alpha = await cast.endUserA.fetch(
      `/api/t/${cast.tenantA.slug}/orgs`,
      json("POST", { name: "Alpha" }),
    );
    expect(alpha.status, "endUserA starts their own org in workspace A").toBe(201);
    alphaId = ((await alpha.json()) as { data: { id: string } }).data.id;

    const beta = await cast.endUserB.fetch(
      `/api/t/${cast.tenantB.slug}/orgs`,
      json("POST", { name: "Beta" }),
    );
    expect(beta.status, "endUserB starts their own org in workspace B").toBe(201);
    betaId = ((await beta.json()) as { data: { id: string } }).data.id;

    // ownerA is `admin` in workspace A but only `authenticated` in `default`,
    // and `default` is where a freshly signed-in session lands. The operator
    // surface reads the ACTIVE workspace, so the header is not decoration here:
    // without it this call is a 403 from A's own administrator.
    const foreign = await cast.ownerA.fetch("/api/app-orgs", {
      ...json("POST", { name: "Foreign" }),
      headers: { "content-type": "application/json", "X-Backlex-Tenant": cast.tenantA.slug },
    });
    expect(foreign.status, "the operator surface mints an org with no members").toBe(201);
    foreignId = ((await foreign.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => cast.cleanup());

  test("a platform cookie is not a credential at the end-user org surface", async () => {
    // The positive control first, or the 401 below proves nothing: this identity
    // is a real, signed-in, genuinely privileged operator on its own surface.
    //
    // The workspace header is load-bearing and NOT boilerplate. The harness has
    // one cookie jar, so `backlex-tenant` survives an identity switch — and RBAC
    // roles are loaded per workspace, so an instance operator whose jar happens
    // to point at someone else's workspace holds NO roles there and is refused
    // by the very gate this test needs to see pass. Naming the workspace makes
    // the control independent of whoever called last.
    const onItsOwnSurface = await cast.operator.fetch("/api/app-orgs", {
      headers: { "X-Backlex-Tenant": cast.defaultTenant.slug },
    });
    expect(onItsOwnSurface.status, "the operator reaches the operator surface").toBe(200);

    for (const slug of [cast.defaultTenant.slug, cast.tenantA.slug]) {
      const res = await cast.operator.fetch(`/api/t/${slug}/orgs`);
      expect(res.status, `platform cookie at /api/t/${slug}/orgs`).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNAUTHORIZED");
    }

    // This one is a REAL check rather than an accident: `requireAppUser` in
    // routes/app-orgs-public.ts tests `auth.plane !== "app"` explicitly. It is
    // the shape the rest of the app is missing, not an example of the gap.
  });

  test("an app-plane bearer is refused at the operator org surface", async () => {
    // Positive control: the same token, same instant, reaching the surface it IS
    // entitled to. Without this the 403s below would also be satisfied by a
    // token that had simply expired.
    const onItsOwnSurface = await cast.endUserA.fetch(`/api/t/${cast.tenantA.slug}/orgs`);
    expect(onItsOwnSurface.status, "endUserA reaches the end-user surface").toBe(200);

    for (const [label, init] of [
      ["list", undefined],
      ["create", json("POST", { name: "Smuggled" })],
    ] as const) {
      const res = await cast.endUserA.fetch("/api/app-orgs", init);
      expect(res.status, `app-plane bearer ${label} at /api/app-orgs`).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("FORBIDDEN");
      // KNOWN GAP — the message is the tell. `/api/app-orgs` carries
      // `requireUser` + a local `requireAdmin` that reads `auth.roles`, and an
      // app-plane identity is refused only because `tenantMiddleware` leaves
      // that array EMPTY for `plane === "app"`. Nothing on this route ever asks
      // which plane the caller is on. Populate `auth.roles` for app-plane
      // identities for any reason — an org-scoped role bundle is one line away
      // from doing exactly that — and this 403 becomes a 200. PHASE 1 replaces
      // the accident with `requirePlatformMw`, at which point this expectation
      // should be re-read: the status stays 403, but the message will name the
      // plane rather than the role.
      expect(body.error.message).toBe("Admin role required");
    }
  });

  test("an app-plane bearer cannot reach another workspace's orgs", async () => {
    // Positive control: B's own surface answers, and answers with B's data —
    // so a 403 on A below is about the workspace, not about a dead session.
    const own = await cast.endUserB.fetch(`/api/t/${cast.tenantB.slug}/orgs`);
    expect(own.status).toBe(200);
    expect(await ids(own.clone()), "endUserB sees Beta and only Beta").toEqual([betaId]);

    const acrossPlainly = await cast.endUserB.fetch(`/api/t/${cast.tenantA.slug}/orgs`);
    expect(acrossPlainly.status, "endUserB at workspace A's org surface").toBe(403);
    expect(
      ((await acrossPlainly.json()) as { error: { message: string } }).error.message,
    ).toBe("Session belongs to a different workspace");

    // Naming A in the header as well changes nothing, which is the point: the
    // session's own workspace is what `requireAppUser` compares the path slug
    // against, and the header never entered the comparison.
    const acrossWithHeader = await cast.endUserB.fetch(`/api/t/${cast.tenantA.slug}/orgs`, {
      headers: { "X-Backlex-Tenant": cast.tenantA.slug },
    });
    expect(acrossWithHeader.status, "X-Backlex-Tenant does not unlock workspace A").toBe(403);
  });

  test("X-Backlex-Tenant is IGNORED for an app-plane session, not merely absent", async () => {
    // The assertions above are consistent with the header being honoured and
    // then failing some later check. These two are not.
    //
    // (a) Point the header at workspace A while asking B's own surface. If the
    //     header were honoured, `tenantMiddleware` would set the active tenant
    //     to A, `requireAppUser` would find A !== B and answer 403. It answers
    //     200 with B's rows, so the header was discarded before that point.
    const pointedAway = await cast.endUserB.fetch(`/api/t/${cast.tenantB.slug}/orgs`, {
      headers: { "X-Backlex-Tenant": cast.tenantA.slug },
    });
    expect(pointedAway.status).toBe(200);
    expect(await ids(pointedAway.clone()), "still workspace B's orgs").toEqual([betaId]);

    // (b) A value that names no workspace at all. `tenantMiddleware` refuses an
    //     unresolvable header with NOT_FOUND rather than falling back — for the
    //     PLATFORM plane. The app plane never reaches that refusal because its
    //     tenant is already pinned, so the same nonsense is simply dropped.
    const garbage = "no-such-workspace-" + Date.now();
    const appPlane = await cast.endUserB.fetch(`/api/t/${cast.tenantB.slug}/orgs`, {
      headers: { "X-Backlex-Tenant": garbage },
    });
    expect(appPlane.status, "an app-plane session ignores an unresolvable header").toBe(200);

    const platformPlane = await cast.ownerA.fetch("/api/tenants", {
      headers: { "X-Backlex-Tenant": garbage },
    });
    expect(platformPlane.status, "the SAME header is fatal on the platform plane").toBe(404);
    // The contrast is the proof. One header value, two planes, two outcomes:
    // the plane decides whether it is read at all.
  });

  test("X-Backlex-Org naming an org you do not belong to is refused, not downgraded", async () => {
    // docs/app-organizations.md promises the header "must name an org the caller
    // is a member of". Silently resolving to some other org instead would be the
    // house's worst failure shape — a 200 that answered for the wrong subject.
    //
    // Positive control: the header DOES select, so the refusal below is a
    // refusal and not the header being ignored.
    const selected = await cast.endUserA.bearer(alphaId)(`/api/t/${cast.tenantA.slug}/orgs`);
    expect(selected.status).toBe(200);
    const echo = (await selected.json()) as { active: { orgId: string | null; role: string | null } };
    expect(echo.active.orgId, "the header set the acting org").toBe(alphaId);
    expect(echo.active.role).toBe("owner");

    // `foreignId` is a real org, in the caller's OWN workspace, that they are
    // simply not a member of — the case a "does this exist?" check would wave
    // through and a membership check catches.
    const foreign = await cast.endUserA.bearer(foreignId)(`/api/t/${cast.tenantA.slug}/orgs`);
    expect(foreign.status, "a real org the caller is not a member of").toBe(403);
    expect(((await foreign.json()) as { error: { message: string } }).error.message).toBe(
      "Not a member of the organization named by X-Backlex-Org",
    );

    // And an org in ANOTHER workspace, which must not even be findable: the slug
    // lookup behind the header is tenant-scoped, so this is the same 403 rather
    // than a distinguishable "no such org".
    const crossTenant = await cast.endUserA.bearer(betaId)(`/api/t/${cast.tenantA.slug}/orgs`);
    expect(crossTenant.status, "workspace B's org, named from workspace A").toBe(403);

    // A value naming nothing at all answers identically, so the header is not an
    // existence oracle for org ids.
    const nothing = await cast.endUserA.bearer("no-such-org")(`/api/t/${cast.tenantA.slug}/orgs`);
    expect(nothing.status).toBe(403);
  });

  test("KNOWN GAP (Phase 2): X-Backlex-Org is not in the CORS allowHeaders list", async () => {
    // A spec cannot run a browser's preflight, but it can run the request a
    // browser would send and read what the app answers — which is the same CORS
    // config object, exercised rather than re-read. Hono's `cors()` echoes the
    // configured `allowHeaders` verbatim into `Access-Control-Allow-Headers`
    // (it only mirrors the request's own list when `allowHeaders` is unset), so
    // this response header IS `app.ts`'s array.
    const preflight = await cast.h.app.request(`/api/t/${cast.tenantA.slug}/orgs`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "X-Backlex-Org",
      },
    });
    expect(preflight.status, "the CORS middleware short-circuits the preflight").toBe(204);
    const allowed = (preflight.headers.get("access-control-allow-headers") ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);

    // Positive control on the ASSERTION itself: the list is non-empty and the
    // sibling header is in it. Without this, a missing or malformed response
    // header would satisfy the absence check below vacuously.
    expect(allowed.length, "the app declares an explicit allowHeaders list").toBeGreaterThan(0);
    expect(allowed, "the workspace header IS allowed").toContain("x-backlex-tenant");
    expect(allowed).toContain("authorization");

    // Closed in Phase 2. It used to be absent, so a cross-origin browser SDK
    // sending `X-Backlex-Org` — exactly what `app.orgs.use(...)` tells it to do
    // — failed its preflight, and the documented stateless org-switching path
    // was unreachable from the only caller it exists for. Same-origin and
    // server-side callers worked, which is why it survived; and
    // `sdk-header-parity.test.ts` asserted the SDK SENDS it while nothing
    // asserted the server would accept it.
    expect(allowed, "the org header a browser SDK sends is accepted").toContain(
      "x-backlex-org",
    );
  });
});
