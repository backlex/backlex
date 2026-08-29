import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildTwoPlaneCast,
  type Caller,
  json,
  type TwoPlaneCast,
} from "./fixtures/two-plane-cast";

/**
 * The membership routes that decide who belongs to a workspace, and on whose
 * authority.
 *
 * Most of what is asserted here was missing rather than broken. There was no
 * route to change a member's role on ANY surface — the admin UI's role Select
 * shipped permanently `disabled` with a comment naming the PATCH that did not
 * exist — no ownership transfer, and `DELETE /{id}/members/{memberId}` issued
 * one statement against `tenant_members` with no last-owner guard at all. So a
 * workspace could be left with zero owners and no way back except
 * `OWNER_EMAIL` or SQL, and an invite that expired blocked its own address
 * forever, because `createMemberInvite` CONFLICTs on any existing row for that
 * address whether or not its token still works.
 *
 * Every refusal below is written next to the acceptance that proves the
 * refusal is about the RULE rather than about the request being malformed, the
 * caller being wrong, or the route being absent. A 403 on its own says nothing:
 * a route that answered 403 to everybody would pass half of this file.
 *
 * ── why so many casts ───────────────────────────────────────────────────────
 *
 * `buildTwoPlaneCast` owns ONE cookie jar, so switching platform identities
 * costs a `/sign-in` — and `auth-rate-limit.ts` allows ten of those per minute
 * per client IP, which each harness has its own of. The describes below are
 * therefore split by identity budget as much as by subject: a single describe
 * covering all of this would exhaust the window and fail on a 429 that has
 * nothing to do with membership.
 */

/**
 * Role bindings this person holds against roles owned by this workspace, read
 * straight from the database.
 *
 * Both defects these probes exist for were invisible through the API: a
 * removal that reported success while `user_roles` survived, and a demotion
 * that moved the membership row and left the `admin` binding behind. Asserting
 * either one through `GET /members` would have passed in both worlds.
 */
const roleBindings = (
  cast: TwoPlaneCast,
  userId: string,
  tenantId: string,
  roleName?: string,
): number => {
  const db = new Database(cast.h.env.SQLITE_PATH as string, { readonly: true });
  try {
    const sql =
      "SELECT COUNT(*) AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id" +
      " WHERE ur.user_id = ? AND r.tenant_id = ?" +
      (roleName ? " AND r.name = ?" : "");
    const args = roleName ? [userId, tenantId, roleName] : [userId, tenantId];
    const row = db.query(sql).get(...args) as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
};

interface MemberRow {
  id: string;
  userId: string | null;
  email: string;
  role: string;
  status: string;
}

const listMembers = async (
  caller: Caller,
  tenantId: string,
): Promise<MemberRow[]> => {
  const res = await caller(`/api/tenants/${tenantId}/members`);
  expect(res.status, "list members").toBe(200);
  const body = (await res.json()) as { data: MemberRow[] };
  return body.data;
};

const memberFor = async (
  caller: Caller,
  tenantId: string,
  email: string,
): Promise<MemberRow> => {
  const row = (await listMembers(caller, tenantId)).find(
    (m) => m.email.toLowerCase() === email.toLowerCase(),
  );
  expect(row, `a membership row for ${email}`).toBeDefined();
  return row as MemberRow;
};

const roleOf = async (
  caller: Caller,
  tenantId: string,
  email: string,
): Promise<string> => (await memberFor(caller, tenantId, email)).role;

/** Invite an address that nobody will ever accept. Enough of a target for the
 *  guards that act on a ROW, and the only way to get one whose `user_id` is
 *  null. */
const invite = async (
  caller: Caller,
  tenantId: string,
  email: string,
  role?: string,
): Promise<{ id: string; token: string }> => {
  const res = await caller(
    `/api/tenants/${tenantId}/members/invite`,
    json("POST", role === undefined ? { email } : { email, role }),
  );
  expect(res.status, `invite ${email} as ${role ?? "member"}`).toBe(201);
  const body = (await res.json()) as { data: { id: string; token: string } };
  return body.data;
};

// ───────────────────────────────────────────────────────────────────────────
describe("tenant members: the rank ladder decides who may act on whom", () => {
  let cast: TwoPlaneCast;
  let ownerRow: MemberRow;
  let adminRow: MemberRow;
  let pending: { id: string; token: string };

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
    ownerRow = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.ownerA.email);
    adminRow = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.adminA.email);
    pending = await invite(cast.ownerA.fetch, cast.tenantA.id, "ladder-pending@example.test");
    // The fixture's premise, asserted rather than assumed: without two
    // different ranks in one workspace every test below would be comparing a
    // role against itself.
    expect(ownerRow.role, "ownerA holds `owner` in workspace A").toBe("owner");
    expect(adminRow.role, "adminA holds `admin` in workspace A").toBe("admin");
  });

  afterAll(() => cast.cleanup());

  test("an admin cannot act on an owner, while the owner can act on them", async () => {
    const refused = await cast.adminA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${ownerRow.id}`,
      json("PATCH", { role: "member" }),
    );
    expect(refused.status, "admin demoting the owner").toBe(403);

    // The same shape of request, one rung down the ladder, must succeed — or
    // the 403 above would be evidence of nothing but a broken route.
    const allowed = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      json("PATCH", { status: "suspended" }),
    );
    expect(allowed.status, "owner suspending the admin").toBe(200);

    const rows = await listMembers(cast.ownerA.fetch, cast.tenantA.id);
    expect(rows.find((m) => m.email === cast.ownerA.email)?.role).toBe("owner");
    expect(rows.find((m) => m.email === cast.adminA.email)?.status).toBe("suspended");

    const restored = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      json("PATCH", { status: "active" }),
    );
    expect(restored.status, "owner reinstating the admin").toBe(200);
  });

  test("an admin cannot grant `owner`, while an owner can", async () => {
    const refused = await cast.adminA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${pending.id}`,
      json("PATCH", { role: "owner" }),
    );
    expect(refused.status, "admin promoting a member to owner").toBe(403);
    // The admin DOES outrank this target — the refusal is about the standing
    // being handed out, not about who it is handed to. Proven by moving the
    // very same row to a role the admin does hold.
    const sideways = await cast.adminA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${pending.id}`,
      json("PATCH", { role: "admin" }),
    );
    expect(sideways.status, "admin promoting a member to admin").toBe(200);

    const allowed = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${pending.id}`,
      json("PATCH", { role: "owner" }),
    );
    expect(allowed.status, "owner promoting a member to owner").toBe(200);
    expect(
      await roleOf(cast.ownerA.fetch, cast.tenantA.id, "ladder-pending@example.test"),
    ).toBe("owner");
  });

  test("a member may always act on themselves, and only on themselves", async () => {
    // Step down to a rank `manageOnly` refuses, through the self branch.
    const down = await cast.adminA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      json("PATCH", { role: "member" }),
    );
    expect(down.status, "an admin demoting themselves").toBe(200);

    // A plain `member` still cannot touch anybody else — the self branch is a
    // hole in `manageOnly`, not in the ladder.
    const others = await cast.adminA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${ownerRow.id}`,
      json("PATCH", { role: "member" }),
    );
    expect(others.status, "a member acting on the owner").toBe(403);

    // …and cannot promote themselves back, which is the escalation that same
    // self branch would otherwise open.
    const up = await cast.adminA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      json("PATCH", { role: "owner" }),
    );
    expect(up.status, "a member promoting themselves to owner").toBe(403);

    expect(await roleOf(cast.ownerA.fetch, cast.tenantA.id, cast.adminA.email)).toBe(
      "member",
    );
  });

  test("`editor` is folded to `member`, and an unknown role is refused", async () => {
    const folded = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/invite`,
      json("POST", { email: "legacy-editor@example.test", role: "editor" }),
    );
    expect(folded.status, "the deprecated `editor` is still accepted").toBe(201);

    const junk = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/invite`,
      json("POST", { email: "captain@example.test", role: "captain" }),
    );
    expect(junk.status, "an arbitrary RBAC name is not a membership role").toBe(422);

    const rows = await listMembers(cast.ownerA.fetch, cast.tenantA.id);
    expect(
      rows.find((m) => m.email === "legacy-editor@example.test")?.role,
      "`editor` is stored as `member`",
    ).toBe("member");
    expect(
      rows.some((m) => m.email === "captain@example.test"),
      "the refused invite wrote nothing",
    ).toBe(false);
  });

  test("a PATCH that changes nothing is refused rather than answered 200", async () => {
    const empty = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      json("PATCH", {}),
    );
    expect(empty.status, "no role and no status").toBe(422);

    const unknown = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      json("PATCH", { email: "somebody-else@example.test" }),
    );
    expect(unknown.status, "a field this route cannot change").toBe(422);

    const real = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      json("PATCH", { role: "admin" }),
    );
    expect(real.status, "the same route with something it can act on").toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("tenant members: the instance operator stands outside the ladder", () => {
  let cast: TwoPlaneCast;
  let ownerRow: MemberRow;
  let adminRow: MemberRow;

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
    ownerRow = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.ownerA.email);
    adminRow = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.adminA.email);
  });

  afterAll(() => cast.cleanup());

  test("the operator makes the call an admin was refused", async () => {
    const refused = await cast.adminA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${ownerRow.id}`,
      json("PATCH", { role: "admin" }),
    );
    expect(refused.status, "an admin demoting the owner").toBe(403);

    // A second owner first, so the operator's attempt is refused (or not) by
    // the LADDER rather than by the last-owner invariant — otherwise this
    // would read as a 422 and prove nothing about rank.
    const second = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      json("PATCH", { role: "owner" }),
    );
    expect(second.status, "the owner promoting a second owner").toBe(200);

    const allowed = await cast.operator.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${ownerRow.id}`,
      json("PATCH", { role: "admin" }),
    );
    expect(allowed.status, "the operator making the identical call").toBe(200);

    // Not because the operator outranks anybody here — they hold no
    // membership row in workspace A at all, which is the null actor
    // `membership-guards.ts` puts outside the ladder on purpose.
    const rows = await listMembers(cast.operator.fetch, cast.tenantA.id);
    expect(
      rows.some((m) => m.email.toLowerCase() === cast.operator.email.toLowerCase()),
      "the operator is NOT a member of workspace A",
    ).toBe(false);
    expect(rows.find((m) => m.email === cast.ownerA.email)?.role).toBe("admin");
    expect(rows.find((m) => m.email === cast.adminA.email)?.role).toBe("owner");
  });

  test("a stranger and an app-plane bearer reach nothing", async () => {
    const stranger = await cast.ownerB.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      json("PATCH", { role: "member" }),
    );
    expect(stranger.status, "workspace B's owner reaching into workspace A").toBe(403);

    // Stateless bearer — no cookie, so this costs no sign-in and cannot
    // disturb the jar.
    const endUser = await cast.endUserA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      json("PATCH", { role: "member" }),
    );
    expect(
      endUser.ok,
      "an app-plane end-user of workspace A on a control-plane route",
    ).toBe(false);

    // Neither attempt moved anything — a 4xx that had already written would be
    // the worst of both answers. Read back through the operator, who is
    // already the jar's current identity.
    const rows = await listMembers(cast.operator.fetch, cast.tenantA.id);
    expect(rows.find((m) => m.email === cast.adminA.email)?.role).toBe("owner");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("tenant members: the last owner cannot be removed from power", () => {
  let cast: TwoPlaneCast;
  let ownerRow: MemberRow;
  let adminRow: MemberRow;

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
    ownerRow = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.ownerA.email);
    adminRow = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.adminA.email);
  });

  afterAll(() => cast.cleanup());

  test("the sole owner cannot demote, suspend or remove themselves", async () => {
    const demote = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${ownerRow.id}`,
      json("PATCH", { role: "admin" }),
    );
    expect(demote.status, "demoting the last owner").toBe(422);

    const suspend = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${ownerRow.id}`,
      json("PATCH", { status: "suspended" }),
    );
    expect(suspend.status, "suspending the last owner").toBe(422);

    const remove = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${ownerRow.id}`,
      { method: "DELETE" },
    );
    expect(remove.status, "removing the last owner").toBe(422);

    // Still owner, still active, still there — a refusal that had already
    // written half of the change would be worse than either answer.
    const row = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.ownerA.email);
    expect(row.role).toBe("owner");
    expect(row.status).toBe("active");
  });

  test("an invited owner is not an owner, so it protects nobody", async () => {
    await invite(cast.ownerA.fetch, cast.tenantA.id, "ghost-owner@example.test", "owner");
    const ghost = await memberFor(
      cast.ownerA.fetch,
      cast.tenantA.id,
      "ghost-owner@example.test",
    );
    expect(ghost.role, "the invite carries `owner`").toBe("owner");
    expect(ghost.userId, "…and nobody has accepted it").toBeNull();

    // If the count included that row the workspace would look like it had two
    // owners, and the real one could step down into an unadministrable
    // workspace on the strength of an invitation nothing obliges anyone to
    // accept.
    const demote = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${ownerRow.id}`,
      json("PATCH", { role: "admin" }),
    );
    expect(demote.status, "demoting the last REAL owner").toBe(422);

    // The row is not protected as an owner either — it was never counted as
    // one — and it IS within a peer's reach: `assertMayActOn` allows equal
    // rank, so the owner who sent the invitation can cancel it. That matters
    // beyond tidiness: `createMemberInvite` CONFLICTs on any existing row for
    // an address, so an invitation an owner could not revoke would hold that
    // email hostage until an operator intervened.
    const peer = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${ghost.id}/invite`,
      { method: "DELETE" },
    );
    expect(peer.status, "an owner revoking an `owner` invitation").toBe(200);

    // And the address is free again, which is the consequence worth asserting
    // rather than the status code on its own — `createMemberInvite` CONFLICTs
    // on any existing row for an email, so this call is only possible because
    // the revoke above actually removed one. (`invite` asserts the 201 itself
    // and hands back the row.)
    const reInvited = await invite(
      cast.ownerA.fetch,
      cast.tenantA.id,
      "ghost-owner@example.test",
      "member",
    );
    expect(reInvited.id, "a fresh invite row for the freed address").toBeTruthy();
    expect(reInvited.id).not.toBe(ghost.id);
  });

  test("once a second owner exists, the first may step down", async () => {
    const promote = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      json("PATCH", { role: "owner" }),
    );
    expect(promote.status, "promoting the admin to owner").toBe(200);

    const demote = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${ownerRow.id}`,
      json("PATCH", { role: "admin" }),
    );
    expect(demote.status, "the founder stepping down beside a second owner").toBe(200);

    const rows = await listMembers(cast.ownerA.fetch, cast.tenantA.id);
    const owners = rows.filter((m) => m.role === "owner" && m.userId !== null);
    expect(owners.map((o) => o.email)).toEqual([cast.adminA.email]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("tenant members: ownership transfers as one intent", () => {
  let cast: TwoPlaneCast;
  let ownerRow: MemberRow;
  let adminRow: MemberRow;

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
    ownerRow = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.ownerA.email);
    adminRow = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.adminA.email);
  });

  afterAll(() => cast.cleanup());

  test("an admin cannot transfer ownership; the owner can", async () => {
    const refused = await cast.adminA.fetch(
      `/api/tenants/${cast.tenantA.id}/transfer-ownership`,
      json("POST", { memberId: adminRow.id }),
    );
    expect(refused.status, "an admin handing the workspace to themselves").toBe(403);

    // Same body, same target, one rung up — the refusal is about who asked.
    const pending = await invite(
      cast.ownerA.fetch,
      cast.tenantA.id,
      "unaccepted@example.test",
    );
    const unaccepted = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/transfer-ownership`,
      json("POST", { memberId: pending.id }),
    );
    expect(unaccepted.status, "transferring to a pending invite").toBe(422);

    const res = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/transfer-ownership`,
      json("POST", { memberId: adminRow.id }),
    );
    expect(res.status, "the owner transferring to the admin").toBe(200);
    const body = (await res.json()) as {
      data: { memberId: string; userId: string; previousOwnerUserId: string | null };
    };
    expect(body.data.memberId).toBe(adminRow.id);
    expect(body.data.previousOwnerUserId).toBe(cast.ownerA.userId);

    // ONE owner afterwards, and it is the new one. Two would mean the demote
    // half never ran; zero would mean the order was wrong. That pair is the
    // whole reason this is a single route rather than two PATCHes.
    const rows = await listMembers(cast.ownerA.fetch, cast.tenantA.id);
    expect(rows.filter((m) => m.role === "owner").map((o) => o.email)).toEqual([
      cast.adminA.email,
    ]);
    expect(
      rows.find((m) => m.email === cast.ownerA.email)?.role,
      "the previous owner keeps administrative standing",
    ).toBe("admin");
  });

  test("the former owner can no longer transfer it back, but the new one can", async () => {
    const refused = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/transfer-ownership`,
      json("POST", { memberId: ownerRow.id }),
    );
    expect(refused.status, "the demoted founder taking it back").toBe(403);

    const allowed = await cast.adminA.fetch(
      `/api/tenants/${cast.tenantA.id}/transfer-ownership`,
      json("POST", { memberId: ownerRow.id }),
    );
    expect(allowed.status, "the new owner handing it back").toBe(200);

    const rows = await listMembers(cast.adminA.fetch, cast.tenantA.id);
    expect(rows.filter((m) => m.role === "owner").map((o) => o.email)).toEqual([
      cast.ownerA.email,
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("tenant members: an invite can be re-sent or withdrawn", () => {
  let cast: TwoPlaneCast;
  const invitee = "stale-invite@example.test";
  let pending: { id: string; token: string };

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
    pending = await invite(cast.ownerA.fetch, cast.tenantA.id, invitee);
  });

  afterAll(() => cast.cleanup());

  /** Push an invite's expiry into the past, the way seven days would. */
  const expire = (memberId: string): void => {
    const db = new Database(cast.h.env.SQLITE_PATH as string);
    try {
      db.query("UPDATE tenant_members SET invite_expires_at = ? WHERE id = ?").run(
        Date.now() - 60_000,
        memberId,
      );
    } finally {
      db.close();
    }
  };

  test("an expired invite blocks its own address until something clears it", async () => {
    expire(pending.id);
    const resolved = await cast.anon(`/api/tenants/invite/${pending.token}`);
    expect(resolved.status).toBe(200);
    expect(
      ((await resolved.json()) as { data: { expired: boolean } }).data.expired,
      "the token no longer works",
    ).toBe(true);

    // This is the trap the two routes below exist for: `createMemberInvite`
    // CONFLICTs on ANY existing row for the address, so the dead invite holds
    // the address hostage.
    const again = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/invite`,
      json("POST", { email: invitee }),
    );
    expect(again.status, "re-inviting an address with a dead invite").toBe(409);
  });

  test("resending rotates the token and revives the address", async () => {
    const res = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${pending.id}/resend-invite`,
      { method: "POST" },
    );
    expect(res.status, "resending the invite").toBe(200);
    const body = (await res.json()) as { data: { token: string; url: string } };
    expect(body.data.token, "a NEW token, not the dead one").not.toBe(pending.token);
    expect(body.data.url).toContain(body.data.token);

    const old = await cast.anon(`/api/tenants/invite/${pending.token}`);
    expect(old.status, "the rotated-away token resolves to nothing").toBe(404);

    const fresh = await cast.anon(`/api/tenants/invite/${body.data.token}`);
    expect(fresh.status).toBe(200);
    const freshBody = (await fresh.json()) as {
      data: { email: string; expired: boolean };
    };
    expect(freshBody.data.email).toBe(invitee);
    expect(freshBody.data.expired, "and its window is open again").toBe(false);
  });

  test("revoking an invite frees the address for a fresh one", async () => {
    const row = await memberFor(cast.ownerA.fetch, cast.tenantA.id, invitee);
    const revoked = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${row.id}/invite`,
      { method: "DELETE" },
    );
    expect(revoked.status, "revoking the pending invite").toBe(200);
    expect(
      (await listMembers(cast.ownerA.fetch, cast.tenantA.id)).some(
        (m) => m.email.toLowerCase() === invitee,
      ),
      "the row is gone",
    ).toBe(false);

    // The same POST that answered 409 above.
    const again = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/invite`,
      json("POST", { email: invitee }),
    );
    expect(again.status, "inviting the same address again").toBe(201);
  });

  test("neither route touches a member who has already accepted", async () => {
    const admin = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.adminA.email);
    const resend = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${admin.id}/resend-invite`,
      { method: "POST" },
    );
    expect(resend.status, "resending to an accepted member").toBe(422);

    const revoke = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${admin.id}/invite`,
      { method: "DELETE" },
    );
    expect(revoke.status, "revoking an accepted member's invite").toBe(422);

    // The refusals above are about the row's STATE. The same calls against a
    // genuinely pending row succeed, which is the pair that makes them mean
    // something.
    const fresh = await invite(cast.ownerA.fetch, cast.tenantA.id, "pairing@example.test");
    const ok = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${fresh.id}/resend-invite`,
      { method: "POST" },
    );
    expect(ok.status, "resending a genuinely pending invite").toBe(200);

    expect(
      (await listMembers(cast.ownerA.fetch, cast.tenantA.id)).some(
        (m) => m.email === cast.adminA.email,
      ),
      "the accepted member is untouched",
    ).toBe(true);
  });

  test("a stranger can neither resend nor revoke", async () => {
    const fresh = await invite(cast.ownerA.fetch, cast.tenantA.id, "outsider@example.test");
    const resend = await cast.ownerB.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${fresh.id}/resend-invite`,
      { method: "POST" },
    );
    expect(resend.status, "workspace B's owner resending workspace A's invite").toBe(403);

    const revoke = await cast.ownerB.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${fresh.id}/invite`,
      { method: "DELETE" },
    );
    expect(revoke.status).toBe(403);
    expect(
      (await listMembers(cast.ownerA.fetch, cast.tenantA.id)).some(
        (m) => m.email.toLowerCase() === "outsider@example.test",
      ),
      "the invite is still there",
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("tenant members: a role change carries the RBAC binding with it", () => {
  let cast: TwoPlaneCast;
  let adminRow: MemberRow;

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
    adminRow = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.adminA.email);
  });

  afterAll(() => cast.cleanup());

  test("a demotion takes the `admin` role away, and a promotion gives it back", async () => {
    const userId = cast.adminA.userId;
    expect(
      roleBindings(cast, userId, cast.tenantA.id, "admin"),
      "accepting an `admin` invite granted the admin role",
    ).toBe(1);

    const down = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      json("PATCH", { role: "member" }),
    );
    expect(down.status).toBe(200);
    expect(
      roleBindings(cast, userId, cast.tenantA.id, "admin"),
      "a demotion that left this behind would cost them the Members panel and nothing else",
    ).toBe(0);
    expect(
      roleBindings(cast, userId, cast.tenantA.id, "authenticated"),
      "…while the baseline every member is promised survives",
    ).toBe(1);

    const up = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      json("PATCH", { role: "admin" }),
    );
    expect(up.status).toBe(200);
    expect(roleBindings(cast, userId, cast.tenantA.id, "admin")).toBe(1);

    // The bindings in OTHER workspaces are untouched: everybody who signs up
    // lands in `default`, and stripping the admin role by user id alone would
    // have reached in there too.
    expect(
      roleBindings(cast, userId, cast.defaultTenant.id),
      "their `default` workspace bindings are none of this route's business",
    ).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("tenant members: removal removes", () => {
  let cast: TwoPlaneCast;
  let ownerRow: MemberRow;
  let adminRow: MemberRow;

  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
    ownerRow = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.ownerA.email);
    adminRow = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.adminA.email);
  });

  afterAll(() => cast.cleanup());

  test("removing a member drops the workspace's role bindings with it", async () => {
    const userId = adminRow.userId as string;
    expect(userId, "adminA has accepted, so they have a user id").toBeTruthy();
    expect(
      roleBindings(cast, userId, cast.tenantA.id),
      "the member holds workspace-A roles before the removal",
    ).toBeGreaterThan(0);

    const res = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${adminRow.id}`,
      { method: "DELETE" },
    );
    expect(res.status, "the owner removing the admin").toBe(200);
    const body = (await res.json()) as {
      data: { rolesRevoked: string[]; userId: string | null };
    };
    expect(
      body.data.rolesRevoked.length,
      "the route reports what it actually revoked",
    ).toBeGreaterThan(0);
    expect(
      roleBindings(cast, userId, cast.tenantA.id),
      "and the bindings are really gone",
    ).toBe(0);
    expect(
      (await listMembers(cast.ownerA.fetch, cast.tenantA.id)).some(
        (m) => m.email === cast.adminA.email,
      ),
    ).toBe(false);
  });

  test("a member can leave under their own power", async () => {
    // Re-admit adminA, then take their management rights away: leaving has to
    // work for somebody `manageOnly` would refuse.
    const readmitted = await cast.ownerA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/invite`,
      json("POST", { email: cast.adminA.email, role: "member" }),
    );
    expect(readmitted.status).toBe(201);
    const token = ((await readmitted.json()) as { data: { token: string } }).data.token;
    const accepted = await cast.adminA.fetch(
      "/api/tenants/accept",
      json("POST", { token }),
    );
    expect(accepted.status, "adminA accepting the new invite").toBe(200);

    // A plain member cannot evict anybody else…
    const others = await cast.adminA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${ownerRow.id}`,
      { method: "DELETE" },
    );
    expect(others.status, "a member removing the owner").toBe(403);

    const mineBefore = (await (await cast.adminA.fetch("/api/tenants")).json()) as {
      data: { id: string; role: string }[];
    };
    const membership = mineBefore.data.find((t) => t.id === cast.tenantA.id);
    expect(membership?.role, "back in as a plain member").toBe("member");

    // …and can still remove themselves.
    const row = await memberFor(cast.ownerA.fetch, cast.tenantA.id, cast.adminA.email);
    const leave = await cast.adminA.fetch(
      `/api/tenants/${cast.tenantA.id}/members/${row.id}`,
      { method: "DELETE" },
    );
    expect(leave.status, "a member leaving").toBe(200);

    const mine = (await (await cast.adminA.fetch("/api/tenants")).json()) as {
      data: { id: string }[];
    };
    expect(
      mine.data.some((t) => t.id === cast.tenantA.id),
      "workspace A is gone from their list",
    ).toBe(false);
  });
});
