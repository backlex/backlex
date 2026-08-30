/**
 * PHASE 5 — what an invite's "role" MEANS, and who is allowed to confer it.
 *
 * `tenant_members.role` is the workspace membership ladder. `assertWorkspaceAccess`
 * reads it to decide who may manage the workspace, and `WORKSPACE_RANK` reads it
 * to decide who may act on whom. It is also an unconstrained TEXT column, and
 * `POST /api/users/invite` used to accept `{ role: z.string().optional() }` and
 * write whatever arrived straight into it — while the admin SPA's dialog offered
 * the RBAC role list (`authenticated`, `admin`, custom roles) from the `roles`
 * table. Two writers, two vocabularies, one column, incompatible validation: the
 * sibling surface `POST /api/tenants/{id}/members/invite` has always enforced a
 * real enum against the same column.
 *
 * The consequence was invisible in exactly the way that costs the most. An
 * invited teammate landed with `role = "authenticated"`, which no ladder reader
 * owns, so they scored 0, could never manage members, and no error ever said so.
 * The mirror-image consequence was worse: `role: "owner"` was accepted here as
 * free text, so any holder of the RBAC `admin` role could mint a workspace owner
 * who then outranked them.
 *
 * These specs pin the fix at the level the fix was made — what the column ends
 * up holding, what the invitee ends up holding, and what the caller is told —
 * rather than at the level of the request body, which is where the bug hid.
 *
 * They also pin the second half of Phase 5's invite work: `GET /api/users` no
 * longer answers with a live invite token.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (body: unknown) => ({
  method: "POST" as const,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

const signOut = (h: TestHarness) => h.fetch("/api/auth/sign-out", { method: "POST" });

const signUp = (h: TestHarness, email: string) =>
  h.fetch(
    "/api/auth/sign-up/email",
    json({ email, password: "correct-horse-battery", name: "X" }),
  );

const signIn = (h: TestHarness, email: string) =>
  h.fetch(
    "/api/auth/sign-in/email",
    json({ email, password: "correct-horse-battery" }),
  );

interface InviteResult {
  id: string;
  email: string;
  token: string;
  url: string;
  sent: boolean;
  workspaceRole: string;
  rbacRole: string;
}

const invite = async (h: TestHarness, body: unknown): Promise<Response> =>
  h.fetch("/api/users/invite", json(body));

const inviteOk = async (h: TestHarness, body: unknown): Promise<InviteResult> => {
  const res = await invite(h, body);
  if (!res.ok) throw new Error(`invite failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { data: InviteResult }).data;
};

const errorBody = async (res: Response): Promise<{ code: string; message: string }> => {
  const body = (await res.json()) as { error?: { code?: string; message?: string } };
  return { code: body.error?.code ?? "", message: body.error?.message ?? "" };
};

/**
 * Read what actually landed in the membership column.
 *
 * The whole defect is a value written to one column and read by another
 * vocabulary, so a spec that only checked the HTTP response would pass while the
 * column stayed poisoned — the response is derived, the column is the fact. The
 * harness hands us `env.SQLITE_PATH` and the file is in WAL mode, so a
 * short-lived second connection can read it while the app holds its own. The
 * throw on a missing row is not decoration: a renamed column or a consumed token
 * would otherwise return `undefined` and satisfy every `toBe` below by accident.
 */
const storedRole = (h: TestHarness, email: string): string => {
  const db = new Database(h.env.SQLITE_PATH as string);
  try {
    const row = db
      .query("SELECT role FROM tenant_members WHERE email = ?1")
      .get(email.toLowerCase()) as { role: string } | null;
    if (!row) throw new Error(`storedRole: no tenant_members row for ${email}`);
    return row.role;
  } finally {
    db.close();
  }
};

/** The RBAC role names bound to a user, straight from the join the resolver
 *  uses. Read by email so it works for a user who has just signed up. */
const rbacRoles = (h: TestHarness, email: string): string[] => {
  const db = new Database(h.env.SQLITE_PATH as string);
  try {
    const rows = db
      .query(
        `SELECT r.name AS name
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           JOIN users u ON u.id = ur.user_id
          WHERE u.email = ?1`,
      )
      .all(email.toLowerCase()) as Array<{ name: string }>;
    return rows.map((r) => r.name).sort();
  } finally {
    db.close();
  }
};

describe("users invite: the standing and the RBAC role are two different things", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  test("`workspaceRole` is the only thing that reaches the membership column", async () => {
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });

    for (const standing of ["owner", "admin", "member"] as const) {
      const email = `ws-${standing}@example.test`;
      const inv = await inviteOk(h, { email, workspaceRole: standing });
      expect(inv.workspaceRole, `${standing}: reported standing`).toBe(standing);
      expect(storedRole(h, email), `${standing}: stored standing`).toBe(standing);
    }
  });

  test("omitting the standing lands on `member`, not on an RBAC role name", async () => {
    // The old default was the literal string "authenticated" — an RBAC role
    // name in the ladder's column, which is the exact shape of the trap. The
    // RBAC role the invitee gets is unchanged; only the column is now honest.
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    const inv = await inviteOk(h, { email: "plain@example.test" });
    expect(inv.workspaceRole).toBe("member");
    expect(inv.rbacRole).toBe("authenticated");
    expect(storedRole(h, "plain@example.test")).toBe("member");

    await signOut(h);
    expect((await signUp(h, "plain@example.test")).ok).toBe(true);
    expect(rbacRoles(h, "plain@example.test")).toEqual(["authenticated"]);
  });

  test("an `admin` standing is readable by the ladder AND binds the admin role", async () => {
    // Both halves matter. The column has to hold a value `assertWorkspaceAccess`
    // recognises (so the invitee can manage members at all), and the accept path
    // has to bind the RBAC role that bypasses permission checks. Before the
    // split those two outcomes came from the same string by coincidence — the
    // word `admin` happens to exist in both vocabularies.
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    const tenants = (await (await h.fetch("/api/tenants")).json()) as {
      data: Array<{ id: string; slug: string }>;
    };
    const tenantId = tenants.data.find((t) => t.slug === "default")!.id;

    await inviteOk(h, { email: "second@example.test", workspaceRole: "admin" });
    expect(storedRole(h, "second@example.test")).toBe("admin");

    await signOut(h);
    expect((await signUp(h, "second@example.test")).ok).toBe(true);
    expect(rbacRoles(h, "second@example.test")).toEqual(["admin", "authenticated"]);

    // The ladder-facing proof: a `manageOnly` route answers for them. A member
    // whose column said `authenticated` would be refused here, which is the
    // trap this phase closes.
    const res = await h.fetch(`/api/tenants/${tenantId}/members`);
    expect(res.status).toBe(200);
  });

  test("a `member` standing does NOT get the ladder's manage rights", async () => {
    // The negative half of the assertion above. Without it, a route that simply
    // let everyone through would satisfy the `admin` case and look correct.
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    const tenants = (await (await h.fetch("/api/tenants")).json()) as {
      data: Array<{ id: string; slug: string }>;
    };
    const tenantId = tenants.data.find((t) => t.slug === "default")!.id;

    await inviteOk(h, { email: "plainer@example.test", workspaceRole: "member" });
    await signOut(h);
    expect((await signUp(h, "plainer@example.test")).ok).toBe(true);

    // They ARE a member — the list read succeeds — but they may not invite.
    expect((await h.fetch(`/api/tenants/${tenantId}/members`)).status).toBe(200);
    const escalate = await h.fetch(
      `/api/tenants/${tenantId}/members/invite`,
      json({ email: "recruit@example.test", role: "admin" }),
    );
    expect(escalate.status).toBe(403);
  });
});

describe("users invite: the deprecated `role` field maps to what it named", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  test("a ladder value is read as the standing", async () => {
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    const inv = await inviteOk(h, { email: "legacy-admin@example.test", role: "admin" });
    expect(inv.workspaceRole).toBe("admin");
    expect(inv.rbacRole).toBe("admin");
    expect(storedRole(h, "legacy-admin@example.test")).toBe("admin");
  });

  test("an RBAC role name is read as the role to bind, and reports `member`", async () => {
    // The admin SPA still sends this shape, so it must keep working for a
    // release. What changes is that the caller is TOLD which of the two
    // meanings their string was read as, instead of finding out when the
    // invitee signs in and cannot manage anything.
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    const inv = await inviteOk(h, { email: "legacy-auth@example.test", role: "authenticated" });
    expect(inv.workspaceRole).toBe("member");
    expect(inv.rbacRole).toBe("authenticated");

    await signOut(h);
    expect((await signUp(h, "legacy-auth@example.test")).ok).toBe(true);
    expect(rbacRoles(h, "legacy-auth@example.test")).toEqual(["authenticated"]);
  });

  test("a custom RBAC role still binds through the compat path", async () => {
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    const roleRes = await h.fetch(
      "/api/roles",
      json({ name: "reviewer", description: "reads and comments" }),
    );
    expect(roleRes.ok).toBe(true);

    const inv = await inviteOk(h, { email: "reviewer@example.test", role: "reviewer" });
    expect(inv.rbacRole).toBe("reviewer");
    expect(inv.workspaceRole).toBe("member");

    await signOut(h);
    expect((await signUp(h, "reviewer@example.test")).ok).toBe(true);
    // `authenticated` rides along — both invite dialogs promise it.
    expect(rbacRoles(h, "reviewer@example.test")).toEqual(["authenticated", "reviewer"]);
  });

  test("the ladder owns its own words, even when an RBAC role shares one", async () => {
    // `bindInvite` used to resolve the stored string by RBAC NAME first and
    // only fall back to the ladder, which made the answer depend on what the
    // `roles` table happened to contain: a workspace that owned a role called
    // `owner` would have that role bound instead of the `admin` role an owner
    // standing confers, and the membership column would have said `owner` all
    // along. Ladder-first makes the two vocabularies non-overlapping in the one
    // direction that matters.
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    const roleRes = await h.fetch(
      "/api/roles",
      json({ name: "owner", description: "a role that shares the ladder's word" }),
    );
    expect(roleRes.ok).toBe(true);

    const inv = await inviteOk(h, { email: "shadow@example.test", workspaceRole: "owner" });
    expect(inv.rbacRole).toBe("admin");
    expect(storedRole(h, "shadow@example.test")).toBe("owner");

    await signOut(h);
    expect((await signUp(h, "shadow@example.test")).ok).toBe(true);
    // The RBAC role named `owner` exists and was NOT bound — the standing's
    // `admin` was. Asserted as the whole set so an extra grant is a failure too.
    expect(rbacRoles(h, "shadow@example.test")).toEqual(["admin", "authenticated"]);
  });

  test("a value naming NEITHER vocabulary is refused instead of stored", async () => {
    // This is the free-text column's actual failure mode. `"editr"` used to be
    // accepted, written to the ladder's column, scored 0 by every reader, and
    // never mentioned again. The refusal has to arrive at the moment the
    // mistake is made, because there is no later moment where it is visible.
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    const res = await invite(h, { email: "typo@example.test", role: "editr" });
    expect(res.status).toBe(422);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("editr");

    // Total refusal: no membership row was written at all, so the address is
    // still invitable and closed sign-up still refuses it.
    const list = (await (await h.fetch("/api/users")).json()) as {
      data: Array<{ email: string }>;
    };
    expect(list.data.some((u) => u.email === "typo@example.test")).toBe(false);
    await signOut(h);
    expect((await signUp(h, "typo@example.test")).status).toBe(403);
  });
});

describe("users invite: nobody confers a standing above their own", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  /** Seed an `admin`-standing member of the default workspace and sign them in.
   *  Returns their email. The seeded first user is `owner` there, so this is the
   *  one rung below the top — the interesting side of `assertMayGrant`. */
  const seedWorkspaceAdmin = async (email: string): Promise<string> => {
    await inviteOk(h, { email, workspaceRole: "admin" });
    await signOut(h);
    expect((await signUp(h, email)).ok).toBe(true);
    return email;
  };

  test("a workspace `admin` may invite an admin but NOT an owner", async () => {
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    await seedWorkspaceAdmin("deputy@example.test");

    // Loaded state first: the deputy CAN invite, so the refusal below is about
    // the standing being granted and not about the deputy being powerless.
    const peer = await invite(h, { email: "peer@example.test", workspaceRole: "admin" });
    expect(peer.status).toBe(200);

    const escalation = await invite(h, {
      email: "puppet@example.test",
      workspaceRole: "owner",
    });
    expect(escalation.status).toBe(403);
    const err = await errorBody(escalation);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toContain("owner");

    // Nothing was written — a refused escalation that still leaves a pending
    // invite is an escalation on a delay.
    const list = (await (await h.fetch("/api/users")).json()) as {
      data: Array<{ email: string }>;
    };
    expect(list.data.some((u) => u.email === "puppet@example.test")).toBe(false);
  });

  test("the workspace owner may still confer `owner`", async () => {
    // The counterweight. Without it the test above would also pass against a
    // route that refused `owner` to everyone, which would make ownership
    // transfer impossible rather than guarded.
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    const inv = await inviteOk(h, { email: "co-owner@example.test", workspaceRole: "owner" });
    expect(inv.workspaceRole).toBe("owner");
    expect(storedRole(h, "co-owner@example.test")).toBe("owner");
  });

  test("the deprecated `role: \"owner\"` is guarded on the same rung", async () => {
    // The compat path must not be the way around the guard. `owner` was the
    // most dangerous string the old free-text field accepted, and it is the one
    // an existing client is most likely to still be sending.
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    await seedWorkspaceAdmin("deputy2@example.test");
    const res = await invite(h, { email: "puppet2@example.test", role: "owner" });
    expect(res.status).toBe(403);
  });
});

describe("users list: a pending invite is not a credential", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  test("no response field carries the token, and the token still works", async () => {
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    const inv = await inviteOk(h, { email: "quiet@example.test", workspaceRole: "member" });

    // Scanned across the WHOLE serialized list rather than one named property.
    // The leak was `inviteUrl`, but the shape that produced it was a projection
    // that selected `invite_token` — any future field spread from that row
    // would reintroduce it under a different name.
    const listRes = await h.fetch("/api/users");
    expect(listRes.status).toBe(200);
    const raw = await listRes.text();
    expect(raw).toContain("quiet@example.test");
    expect(raw).not.toContain(inv.token);
    expect(raw).not.toContain("inviteUrl");

    // And the closure is at the API only — the invitee's own link is untouched,
    // which is what separates "stopped leaking it" from "broke the feature".
    await signOut(h);
    expect((await h.fetch(`/api/tenants/invite/${inv.token}`)).status).toBe(200);
    expect((await signUp(h, "quiet@example.test")).ok).toBe(true);
  });

  test("the CREATE response is still allowed to carry it", async () => {
    // The one moment the caller legitimately holds the credential. Pinned so a
    // later tightening does not take the copy-link flow with it — a deployment
    // without SMTP has no other way to deliver the invite.
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    const inv = await inviteOk(h, { email: "copylink@example.test" });
    expect(inv.token.length).toBeGreaterThan(10);
    expect(inv.url).toContain(`/invite?token=${inv.token}`);
  });

  test("a second admin cannot read the first admin's outstanding invite token", async () => {
    // The threat the field closed is not "an attacker reads the list" — it is
    // that EVERY admin of the workspace holds a live seat-an-account credential
    // for every pending invite, forever, without minting anything. Driven by a
    // real second identity so the assertion is about the response and not about
    // whoever happened to be signed in.
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: false });
    const inv = await inviteOk(h, { email: "target@example.test", workspaceRole: "member" });
    await inviteOk(h, { email: "nosy@example.test", workspaceRole: "admin" });

    await signOut(h);
    expect((await signUp(h, "nosy@example.test")).ok).toBe(true);
    const asNosy = await h.fetch("/api/users");
    expect(asNosy.status).toBe(200);
    const raw = await asNosy.text();
    // Loaded state: they really can see the pending invite exists. The absence
    // below is therefore about the token and not about an empty list.
    expect(raw).toContain("target@example.test");
    expect(raw).not.toContain(inv.token);

    await signOut(h);
    await signIn(h, "owner@example.test");
  });
});
