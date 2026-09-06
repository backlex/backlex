/**
 * Platform-user invite lifecycle via `POST /api/users/invite` (the Users page)
 * and the app-plane sign-up gate.
 *
 * The Users-page invite must create a REAL workspace invite (tenant_members
 * row + token) — not just an email — so the invitee can accept through
 * `/invite?token=…` while public sign-up stays closed, and the chosen RBAC
 * role binds on account creation. Regression guard for the launch bug where
 * the endpoint only logged a console email and nothing else happened.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { hashToken } from "../src/server/services/shared-links";

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (body: unknown) => ({
  method: "POST" as const,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

const signOut = (h: TestHarness) => h.fetch("/api/auth/sign-out", { method: "POST" });

/**
 * Sign up, optionally presenting a workspace invite token.
 *
 * The token is what BINDS the invite. It used to bind on the address alone, so
 * anyone who knew an invited email could sign up with it first and arrive
 * holding whatever standing the invite carried — the 2026-09 audit's phase 10.
 * Tests that expect a membership pass it; the ones that expect a bare account,
 * or a refusal, deliberately do not.
 */
const signUp = (h: TestHarness, email: string, inviteToken?: string) => {
  const init: RequestInit = json({ email, password: "correct-horse-battery", name: "X" });
  if (inviteToken) {
    init.headers = {
      ...(init.headers as Record<string, string>),
      "x-backlex-invite-token": inviteToken,
    };
  }
  return h.fetch("/api/auth/sign-up/email", init);
};

interface InviteResult {
  id: string;
  email: string;
  token: string;
  url: string;
  sent: boolean;
}

describe("users invite: creates a real invite", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  test("invite → pending row in the users list → accept while sign-up closed → role binds", async () => {
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });

    const res = await h.fetch("/api/users/invite", json({ email: "teammate@example.test" }));
    expect(res.ok).toBe(true);
    const inv = ((await res.json()) as { data: InviteResult }).data;
    expect(inv.token.length).toBeGreaterThan(10);
    expect(inv.url).toContain(`/invite?token=${inv.token}`);
    // Test harness has no SMTP — the console fallback must be reported so the
    // UI leans on the copyable link.
    expect(inv.sent).toBe(false);

    // The pending invite shows up in the users list — but WITHOUT its token.
    const list = (await (await h.fetch("/api/users")).json()) as {
      data: Array<{ email: string; status?: string; inviteUrl?: string; memberId?: string }>;
    };
    const pending = list.data.find((u) => u.email === "teammate@example.test");
    expect(pending).toBeDefined();
    expect(pending!.status).toBe("invited");
    // This row used to carry `inviteUrl` — `{APP_URL}/invite?token=<plaintext>`
    // — for every pending invite, which made a routine list read hand over a
    // working credential that seats an account at the invited standing. The
    // token now appears only in the CREATE response, which is the one moment
    // the caller legitimately holds it. Asserted on the whole serialized row
    // rather than the one field, because the leak was a projection that
    // over-selected: a `...row` spread would put it back without touching the
    // named property.
    expect(pending!.inviteUrl).toBeUndefined();
    expect(JSON.stringify(pending)).not.toContain(inv.token);

    // The token resolves publicly (the /invite page metadata call).
    await signOut(h);
    const meta = await h.fetch(`/api/tenants/invite/${inv.token}`);
    expect(meta.status).toBe(200);

    // Sign-up is closed for strangers but open for the invited address.
    expect((await signUp(h, "stranger@example.test")).status).toBe(403);
    expect((await signUp(h, "teammate@example.test", inv.token)).ok).toBe(true);

    // The default role (`authenticated`) is bound on accept.
    const me = (await (await h.fetch("/api/me")).json()) as {
      data?: { roles?: string[] };
      roles?: string[];
    };
    const roles = me.data?.roles ?? me.roles ?? [];
    expect(roles).toContain("authenticated");
  });

  test("invite with the admin role binds admin on accept", async () => {
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });
    const res = await h.fetch(
      "/api/users/invite",
      json({ email: "second-admin@example.test", role: "admin" }),
    );
    expect(res.ok).toBe(true);
    const adminInv = ((await res.json()) as { data: InviteResult }).data;
    await signOut(h);
    expect((await signUp(h, "second-admin@example.test", adminInv.token)).ok).toBe(true);
    // An admin-only endpoint answers for the new user.
    const users = await h.fetch("/api/users");
    expect(users.ok).toBe(true);
  });

  test("duplicate invite conflicts; revoke deletes the pending row", async () => {
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });
    const first = await h.fetch("/api/users/invite", json({ email: "dup@example.test" }));
    expect(first.ok).toBe(true);
    const inv = ((await first.json()) as { data: InviteResult }).data;

    const second = await h.fetch("/api/users/invite", json({ email: "dup@example.test" }));
    expect(second.status).toBe(409);

    const del = await h.fetch(`/api/users/invite/${inv.id}`, { method: "DELETE" });
    expect(del.ok).toBe(true);

    // Gone from the list, token dead, sign-up blocked again.
    const list = (await (await h.fetch("/api/users")).json()) as {
      data: Array<{ email: string }>;
    };
    expect(list.data.some((u) => u.email === "dup@example.test")).toBe(false);
    await signOut(h);
    expect((await h.fetch(`/api/tenants/invite/${inv.token}`)).status).toBe(404);
    expect((await signUp(h, "dup@example.test")).status).toBe(403);
  });

  test("an EXISTING user accepts an invite into ANOTHER workspace (role binds)", async () => {
    // The live repro: an address that already has a backlex account (a member
    // of the default workspace) is invited into a SECOND workspace. Sign-up
    // 422s "user already exists", so the /invite page falls back to sign-in +
    // POST /api/tenants/accept — this exercises that server path.
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: true });
    const otherSignUp = await signUp(h, "existing@example.test");
    expect(otherSignUp.ok).toBe(true);

    // Owner mints a second workspace and invites the existing user into it.
    await signOut(h);
    await h.fetch("/api/auth/sign-in/email", json({ email: "owner@example.test", password: "correct-horse-battery" }));
    const wsRes = await h.fetch("/api/tenants", json({ name: "Team Two" }));
    expect(wsRes.status).toBe(201);
    const ws = ((await wsRes.json()) as { data: { id: string } }).data;
    const inviteRes = await h.fetch(
      `/api/tenants/${ws.id}/members/invite`,
      json({ email: "existing@example.test", role: "admin" }),
    );
    expect(inviteRes.status).toBe(201);
    const inv = ((await inviteRes.json()) as { data: InviteResult }).data;

    // The existing user signs in and accepts by token (no new account).
    await signOut(h);
    await h.fetch("/api/auth/sign-in/email", json({ email: "existing@example.test", password: "correct-horse-battery" }));
    const accept = await h.fetch("/api/tenants/accept", json({ token: inv.token }));
    expect(accept.ok).toBe(true);
    const boundTenant = ((await accept.json()) as { data: { tenantId: string } }).data.tenantId;
    expect(boundTenant).toBe(ws.id);

    // Membership + admin role in the new workspace are now bound.
    const members = (await (await h.fetch(`/api/tenants/${ws.id}/members`)).json()) as {
      data: Array<{ email: string; status: string }>;
    };
    const me = members.data.find((m) => m.email === "existing@example.test");
    expect(me?.status).toBe("active");
  });

  test("members-panel invite reports url + sent for the copy-link UI", async () => {
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });
    const tenants = (await (await h.fetch("/api/tenants")).json()) as {
      data: Array<{ id: string; slug: string }>;
    };
    const tenantId = tenants.data.find((t) => t.slug === "default")!.id;
    const res = await h.fetch(
      `/api/tenants/${tenantId}/members/invite`,
      json({ email: "panel-invitee@example.test", role: "member" }),
    );
    expect(res.status).toBe(201);
    const body = ((await res.json()) as { data: InviteResult }).data;
    expect(body.url).toContain(`/invite?token=${body.token}`);
    expect(body.sent).toBe(false);
  });
});

describe("app-plane sign-up gate", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  const appSignUp = (email: string) =>
    h.fetch("/api/t/default/auth/sign-up/email", json({ email, password: "portal-pass-123", name: "P" }));

  test("no explicit flag keeps end-user sign-up open (historical default)", async () => {
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });
    // seedAdmin({openSignup:false}) skips the PATCH — the workspace has no
    // stored openSignup flag at all, so the app plane stays open.
    const res = await appSignUp("enduser@example.test");
    expect(res.status).toBe(200);
  });

  test("explicit openSignup=false closes end-user sign-up", async () => {
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });
    const patch = await h.fetch("/api/admin/auth/config", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ policy: { openSignup: false } }),
    });
    expect(patch.ok).toBe(true);
    const res = await appSignUp("blocked-enduser@example.test");
    expect(res.status).toBe(403);
  });

  test("openSignup=true keeps end-user sign-up open", async () => {
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });
    const patch = await h.fetch("/api/admin/auth/config", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ policy: { openSignup: true } }),
    });
    expect(patch.ok).toBe(true);
    const res = await appSignUp("open-enduser@example.test");
    expect(res.status).toBe(200);
  });
});

/**
 * PHASE 0 — the three accept-side guards on the PLATFORM invite path.
 *
 * `POST /api/tenants/accept` refuses on three conditions before it binds
 * anything: the token is unknown, the token is expired, or the token's email is
 * not the signed-in caller's. The app-plane twin of this (`app-orgs.test.ts`)
 * has all three covered; the platform plane had none of them, which is the
 * plane that owns `tenant_members` / `user_roles` and therefore the one where a
 * missed guard is a workspace takeover rather than a data leak.
 *
 * Everything below pins TODAY's behaviour, including the parts a later phase
 * changes. Nothing here asserts a fix.
 */

/** Move an invite's expiry into the past by writing the row directly.
 *
 *  There is no API that ages an invite — `createMemberInvite` hard-codes
 *  `Date.now() + 7d` and nothing may edit it afterwards — so the only honest
 *  way to reach the expired branch from a spec is the database itself. The
 *  harness hands us `env.SQLITE_PATH`, and the file is in WAL mode, so a second
 *  short-lived connection can write while the app holds its own. The read-back
 *  is not decoration: a silent zero-row UPDATE (a renamed column, a token that
 *  was already consumed) would leave every assertion below passing for the
 *  wrong reason. */
const expireInvite = async (h: TestHarness, token: string): Promise<void> => {
  // Matched on `invite_token_hash`, not `invite_token`. The token is stored as
  // a SHA-256 digest and the plaintext column is NULL on anything minted since
  // — a `WHERE invite_token = ?` here would update zero rows, and the read-back
  // below is what would have caught it.
  const hash = await hashToken(token);
  const db = new Database(h.env.SQLITE_PATH as string);
  try {
    const past = Date.now() - 60_000;
    db.query(
      "UPDATE tenant_members SET invite_expires_at = ?1 WHERE invite_token_hash = ?2",
    ).run(past, hash);
    const row = db
      .query(
        "SELECT invite_expires_at AS exp FROM tenant_members WHERE invite_token_hash = ?1",
      )
      .get(hash) as { exp: number } | null;
    if (!row) throw new Error(`expireInvite: no tenant_members row holds token ${token}`);
    if (row.exp !== past) throw new Error(`expireInvite: expiry not written (got ${row.exp})`);
  } finally {
    db.close();
  }
};

const errorBody = async (res: Response): Promise<{ code: string; message: string }> => {
  const body = (await res.json()) as { error?: { code?: string; message?: string } };
  return { code: body.error?.code ?? "", message: body.error?.message ?? "" };
};

describe("platform invite accept: the three refusal guards", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  test("a signed-in user with a DIFFERENT address cannot accept someone else's invite", async () => {
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: true });
    const res = await h.fetch("/api/users/invite", json({ email: "invitee@example.test" }));
    expect(res.ok).toBe(true);
    const inv = ((await res.json()) as { data: InviteResult }).data;

    // The token is LIVE at this point. Without this the 403 below would also be
    // satisfied by a dead token, i.e. the test would pass for the wrong reason.
    await signOut(h);
    const meta = await h.fetch(`/api/tenants/invite/${inv.token}`);
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as {
      data: { email: string; workspaceName: string; expired: boolean };
    };
    expect(metaBody.data.email).toBe("invitee@example.test");
    expect(metaBody.data.expired).toBe(false);

    // `/accept` is behind `requireUser`, so an anonymous holder of the token
    // gets nowhere — pinned here because the token itself travels in a URL and
    // is therefore the easiest credential in the system to come by.
    const anon = await h.fetch("/api/tenants/accept", json({ token: inv.token }));
    expect(anon.status).toBe(401);

    // A different real account holding the same token is the interesting case.
    expect((await signUp(h, "someone-else@example.test")).ok).toBe(true);
    const mismatch = await h.fetch("/api/tenants/accept", json({ token: inv.token }));
    expect(mismatch.status).toBe(403);
    const err = await errorBody(mismatch);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toBe("Invite email does not match signed-in user");

    // The refusal must be total: no membership row was created for the caller,
    // and the invite is still pending for its real addressee.
    const still = await h.fetch(`/api/tenants/invite/${inv.token}`);
    expect(still.status).toBe(200);
    expect(((await still.json()) as { data: { email: string } }).data.email).toBe(
      "invitee@example.test",
    );
  });

  test("a token is single-use: signing up with the invited address consumes it", async () => {
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });
    const res = await h.fetch("/api/users/invite", json({ email: "replay@example.test" }));
    expect(res.ok).toBe(true);
    const inv = ((await res.json()) as { data: InviteResult }).data;

    await signOut(h);
    expect((await h.fetch(`/api/tenants/invite/${inv.token}`)).status).toBe(200);

    // Sign-up IS the accept path for an address with no account yet: the
    // `onUserCreated` hook binds the invite THE PRESENTED TOKEN NAMES and NULLs
    // it, so no `/accept` call is ever made. That makes the sign-up the
    // consuming event, and everything below is the replay attempt.
    //
    // The token is required — binding on the address alone let anyone who knew
    // an invited email claim the standing it carried (2026-09 audit, phase 10).
    expect((await signUp(h, "replay@example.test", inv.token)).ok).toBe(true);
    const me = (await (await h.fetch("/api/me")).json()) as {
      data?: { roles?: string[] };
      roles?: string[];
    };
    expect(me.data?.roles ?? me.roles ?? []).toContain("authenticated");

    // Both surfaces must stop answering for the spent token. The resolve route
    // matches on `invite_token`, which is now NULL, so it 404s.
    const resolved = await h.fetch(`/api/tenants/invite/${inv.token}`);
    expect(resolved.status).toBe(404);

    // …and `/accept` does the same lookup, so replaying it — even as the
    // rightful invitee, who is signed in right now — finds nothing to bind.
    const replay = await h.fetch("/api/tenants/accept", json({ token: inv.token }));
    expect(replay.status).toBe(404);
    expect((await errorBody(replay)).code).toBe("NOT_FOUND");
  });

  test("an EXPIRED invite is refused by /accept and reported by the resolve route", async () => {
    // The accept path needs an address that already has an account, because a
    // brand-new one would go through sign-up (which binds the invite itself and
    // never reaches `/accept`). So: an existing user invited into a SECOND
    // workspace, the same shape as the live repro above.
    await seedAdmin(h, "owner@example.test", "correct-horse-battery", { openSignup: true });
    expect((await signUp(h, "veteran@example.test")).ok).toBe(true);

    await signOut(h);
    await h.fetch(
      "/api/auth/sign-in/email",
      json({ email: "owner@example.test", password: "correct-horse-battery" }),
    );
    const wsRes = await h.fetch("/api/tenants", json({ name: "Team Expiry" }));
    expect(wsRes.status).toBe(201);
    const ws = ((await wsRes.json()) as { data: { id: string } }).data;
    const inviteRes = await h.fetch(
      `/api/tenants/${ws.id}/members/invite`,
      json({ email: "veteran@example.test", role: "admin" }),
    );
    expect(inviteRes.status).toBe(201);
    const inv = ((await inviteRes.json()) as { data: InviteResult }).data;

    // Loaded state first: while unexpired, the resolve route says so and the
    // accept path has nothing to object to yet.
    const fresh = await h.fetch(`/api/tenants/invite/${inv.token}`);
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as { data: { expired: boolean } }).data.expired).toBe(false);

    await expireInvite(h, inv.token);

    // The resolve route deliberately answers 200 with `expired: true` rather
    // than 404 — the `/invite` page renders an "this link has expired" state
    // and needs the workspace name to say which one.
    const stale = await h.fetch(`/api/tenants/invite/${inv.token}`);
    expect(stale.status).toBe(200);
    const staleBody = (await stale.json()) as {
      data: { email: string; workspaceName: string; expired: boolean };
    };
    expect(staleBody.data.expired).toBe(true);
    expect(staleBody.data.workspaceName).toBe("Team Expiry");

    await signOut(h);
    await h.fetch(
      "/api/auth/sign-in/email",
      json({ email: "veteran@example.test", password: "correct-horse-battery" }),
    );
    const accept = await h.fetch("/api/tenants/accept", json({ token: inv.token }));
    expect(accept.status).toBe(422);
    const err = await errorBody(accept);
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toBe("Invite has expired");

    // And nothing bound: the veteran is still not a member of the workspace.
    const members = await h.fetch(`/api/tenants/${ws.id}/members`);
    // The veteran has no access to that workspace at all, which is itself the
    // proof — `assertWorkspaceAccess` refuses a non-member who is not the
    // instance operator.
    expect(members.status).toBe(403);
  });

  test("an expired invite no longer opens closed sign-up", async () => {
    // `findActiveInviteByEmail` filters expired rows out, so the sign-up bypass
    // (`hasValidInvite`) must go with it. Two invites are minted and only one
    // is aged, so the pass/fail split inside a single run proves the gate is
    // reading expiry rather than refusing everyone.
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });
    const staleRes = await h.fetch("/api/users/invite", json({ email: "stale@example.test" }));
    expect(staleRes.ok).toBe(true);
    const stale = ((await staleRes.json()) as { data: InviteResult }).data;
    const liveRes = await h.fetch("/api/users/invite", json({ email: "live@example.test" }));
    expect(liveRes.ok).toBe(true);

    await expireInvite(h, stale.token);

    await signOut(h);
    expect((await signUp(h, "stale@example.test")).status).toBe(403);
    const live = ((await liveRes.json()) as { data: InviteResult }).data;
    expect((await signUp(h, "live@example.test", live.token)).ok).toBe(true);
  });

  test("the public resolve route is not an existence oracle for unknown tokens", async () => {
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });
    const res = await h.fetch("/api/users/invite", json({ email: "real@example.test" }));
    expect(res.ok).toBe(true);
    const inv = ((await res.json()) as { data: InviteResult }).data;

    // Loaded state: a token that DOES exist answers 200. Without this the 404s
    // below would be satisfied by a route that is simply broken.
    await signOut(h);
    expect((await h.fetch(`/api/tenants/invite/${inv.token}`)).status).toBe(200);

    // Two well-formed tokens that resolve to nothing. Their answers must be
    // indistinguishable from each other apart from the per-request correlation
    // id — a body that varied (an echoed token, an email, a "no invite for
    // that workspace" hint) would let an unauthenticated caller probe the
    // invite table one guess at a time.
    const unknownA = crypto.randomUUID().replace(/-/g, "");
    const unknownB = crypto.randomUUID().replace(/-/g, "");
    const resA = await h.fetch(`/api/tenants/invite/${unknownA}`);
    const resB = await h.fetch(`/api/tenants/invite/${unknownB}`);
    expect(resA.status).toBe(404);
    expect(resB.status).toBe(404);
    const stripRequestId = (b: Record<string, unknown>) => {
      const { requestId: _ignored, ...rest } = b;
      return rest;
    };
    const bodyA = stripRequestId((await resA.json()) as Record<string, unknown>);
    const bodyB = stripRequestId((await resB.json()) as Record<string, unknown>);
    expect(bodyA).toEqual(bodyB);
    expect(bodyA).toEqual({ error: { code: "NOT_FOUND", message: "Invite not found" } });
    // The token the caller guessed must not come back to them; an echo is what
    // turns a log or an error-reporting sink into a token store.
    expect(JSON.stringify(bodyA)).not.toContain(unknownA);

    // A structurally invalid token is answered by zod (`token: z.string().min(8)`)
    // BEFORE the lookup runs, so it is 422 VALIDATION rather than 404. That is a
    // visible difference, but not an oracle: it separates "malformed" from
    // "well-formed", never "exists" from "does not exist". Pinned so a later
    // change to the param schema is a deliberate one.
    const malformed = await h.fetch("/api/tenants/invite/short");
    expect(malformed.status).toBe(422);
    expect((await errorBody(malformed)).code).toBe("VALIDATION");
  });
});
