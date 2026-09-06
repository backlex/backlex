/**
 * Phase 10 of the 2026-09 pre-prod audit — identity, scope and the audit trail.
 *
 * Six findings that only look unrelated. Each is a control whose SUBJECT was
 * wrong: a grant bound to the wrong proof, a credential re-pointed at the wrong
 * workspace, a refusal keyed on the wrong party, a guard armed on the wrong
 * deploy target, and two privileged acts that left no record of having happened.
 *
 *  · **A workspace invite was redeemable by anyone who knew the address.**
 *    `onBeforeUserCreated` admitted an invited email even while public sign-up
 *    was closed, and `acceptInviteForUser` then matched the pending row on the
 *    address ALONE — so signing up as `cfo@victim.test` before the real CFO did
 *    made you an admin of that workspace, with a password you chose, having
 *    presented no token. The token is now required on the sign-up path, which
 *    is the same proof `POST /api/tenants/accept` has always demanded.
 *
 *  · **An API key pinned to workspace A silently re-pointed.** `findApiKey`
 *    checks `revokedAt` and `expiresAt` and never the owner's membership, so
 *    once A was archived — or the owner suspended in A — the tenant middleware
 *    nulled the pinned workspace and substituted whatever OTHER workspace the
 *    owner belonged to, loading their full role set there. A contractor's
 *    "A only" credential became a credential for B.
 *
 *  · **Account lockout was a denial-of-service primitive** — see
 *    `auth-lockout.test.ts`, which owns that one.
 *
 *  · **`PLANE_GUARD` defaulted to `warn`** and was set to `enforce` only in the
 *    two wrangler files, so the plane firewall was real on Cloudflare and a log
 *    line on every self-host, Vercel, Netlify and Node deploy.
 *
 *  · **Two privileged acts wrote no activity row.** `POST /api/admin/db/sql/run`
 *    can `DELETE FROM activity`, and its own docblock claimed it was auditable.
 *    API-key issuance — minting a durable credential — was silent too. Every
 *    comparable endpoint (`impersonation`, `roles/permissions`, `roles/users`)
 *    logs, so an auditor reads an absence as "it did not happen".
 *
 *  · **Reading a row through the changefeed or a revision wrote no
 *    `access.read`.** Measured: the by-id GET on an `auditReads` collection was
 *    audited and `/changes` — which returns whole rows, cursor-paginated —
 *    was not.
 *
 * Guards verified by breaking them — see [[verify-a-guard-by-breaking-it]].
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { acceptInviteForUser } from "../src/server/services/invites";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const J = { "content-type": "application/json" };
const PASSWORD = "correct-horse-battery";

const post = (h: TestHarness, path: string, body: unknown, headers: Record<string, string> = {}) =>
  h.fetch(path, { method: "POST", headers: { ...J, ...headers }, body: JSON.stringify(body) });

const signOut = (h: TestHarness) => h.fetch("/api/auth/sign-out", { method: "POST" });

const signUp = (h: TestHarness, email: string, inviteToken?: string) =>
  post(
    h,
    "/api/auth/sign-up/email",
    { email, password: PASSWORD, name: "X" },
    inviteToken ? { "x-backlex-invite-token": inviteToken } : {},
  );

interface Invite {
  id: string;
  email: string;
  token: string;
}

const invite = async (h: TestHarness, email: string, role?: string): Promise<Invite> => {
  const res = await post(h, "/api/users/invite", { email, ...(role ? { role } : {}) });
  if (!res.ok) throw new Error(`invite failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { data: Invite }).data;
};

/**
 * Read rows straight out of the harness database.
 *
 * The API is not a witness for "the secret is not stored": `/api/activity`
 * redacts, so asserting against its response would pass whatever the column
 * held. A first pass of this spec did exactly that, and putting the secret into
 * the audit payload stayed green.
 */
const rawRows = <T>(h: TestHarness, sql: string, ...params: unknown[]): T[] => {
  const db = new Database(h.env.SQLITE_PATH as string, { readonly: true });
  try {
    return db.query(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
};

/**
 * A `DbCtx` over the harness database, for driving a service directly.
 *
 * Worth the four lines: `hasValidInvite` and `acceptInviteForUser` are TWO
 * layers, and a request-level test passes as soon as either refuses — so it
 * cannot see one of them regress. This is how the second one is asserted on its
 * own.
 */
const dbCtx = (h: TestHarness) => ({
  db: drizzle({ client: new Database(h.env.SQLITE_PATH as string) }) as never,
  dialect: "sqlite" as const,
});

/** Push a pending invite past its expiry, in the column the resolver reads. */
const expireInvite = (h: TestHarness, inviteId: string): void => {
  const db = new Database(h.env.SQLITE_PATH as string);
  try {
    db.query("UPDATE tenant_members SET invite_expires_at = ?1 WHERE id = ?2").run(
      Date.now() - 60_000,
      inviteId,
    );
  } finally {
    db.close();
  }
};

// ---------------------------------------------------------------------------
// An invite is bound by its TOKEN, not by knowing the address
// ---------------------------------------------------------------------------

describe("faz10: a workspace invite needs the token, not just the email", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  test("a stranger who knows the invited address gets NOTHING", async () => {
    // The reported escalation, verbatim: an `admin` invite to a known address,
    // claimed by whoever signs up first.
    await seedAdmin(h, "owner@example.test", PASSWORD, { openSignup: false });
    await invite(h, "cfo@victim.test", "admin");
    await signOut(h);

    // Sign-up itself is refused: the address is not the authorisation.
    const mallory = await signUp(h, "cfo@victim.test");
    expect(mallory.status).toBe(403);
  });

  test("…and the real invitee, holding the token, is bound as before", async () => {
    // A guard that refuses everyone passes the test above. This is the half
    // that has to keep working.
    await seedAdmin(h, "owner@example.test", PASSWORD, { openSignup: false });
    const inv = await invite(h, "cfo@victim.test", "admin");
    await signOut(h);

    expect((await signUp(h, "cfo@victim.test", inv.token)).ok).toBe(true);
    const me = (await (await h.fetch("/api/me")).json()) as {
      data?: { roles?: string[] };
      roles?: string[];
    };
    expect(me.data?.roles ?? me.roles ?? []).toContain("admin");
  });

  test("a token for SOMEONE ELSE's invite does not admit this address", async () => {
    // The token has to name THIS invite. Otherwise one leaked link becomes a
    // skeleton key for every closed sign-up on the instance.
    await seedAdmin(h, "owner@example.test", PASSWORD, { openSignup: false });
    const theirs = await invite(h, "real@example.test", "admin");
    await signOut(h);

    const res = await signUp(h, "someone-else@example.test", theirs.token);
    expect(res.status).toBe(403);
  });

  test("a garbage token is a refusal, not a fallback to the email", async () => {
    await seedAdmin(h, "owner@example.test", PASSWORD, { openSignup: false });
    await invite(h, "cfo@victim.test", "admin");
    await signOut(h);
    expect((await signUp(h, "cfo@victim.test", "not-a-real-token")).status).toBe(403);
  });

  test("an EXPIRED token is refused, even for the right address", async () => {
    // The token is proof of possession, not proof forever. An invite link sits
    // in a mailbox: a 7-day bound is what keeps a forwarded or archived one
    // from being a standing credential.
    await seedAdmin(h, "owner@example.test", PASSWORD, { openSignup: false });
    const inv = await invite(h, "late@example.test", "admin");
    expireInvite(h, inv.id);
    await signOut(h);
    expect((await signUp(h, "late@example.test", inv.token)).status).toBe(403);
  });

  test("the BIND refuses too, not only the admission gate", async () => {
    // Two layers, checked separately. `hasValidInvite` decides whether the
    // sign-up is allowed at all; `acceptInviteForUser` decides what it is
    // granted. Driving the service directly is what distinguishes them — a
    // request-level test passes as soon as EITHER refuses, so it cannot see one
    // of the two regress.
    await seedAdmin(h, "owner@example.test", PASSWORD, { openSignup: false });
    const inv = await invite(h, "bindme@example.test", "admin");
    const ctx = dbCtx(h);

    // No token: nothing is granted, even though a live invite for this exact
    // address exists and the old code would have found it by email.
    expect(
      await acceptInviteForUser(ctx, "some-user-id", "bindme@example.test", undefined),
    ).toBeNull();

    // A real token, but for a different address: still nothing.
    expect(
      await acceptInviteForUser(ctx, "some-user-id", "not-the-invitee@example.test", inv.token),
    ).toBeNull();

    // The positive control, driven through the same door: with the right token
    // it DOES bind, so the two refusals above are decisions and not a broken
    // call.
    const bound = await acceptInviteForUser(
      ctx,
      "some-user-id",
      "bindme@example.test",
      inv.token,
    );
    expect(typeof bound).toBe("string");
  });

  test("the invite is still SINGLE-USE once spent", async () => {
    await seedAdmin(h, "owner@example.test", PASSWORD, { openSignup: false });
    const inv = await invite(h, "once@example.test");
    await signOut(h);
    expect((await signUp(h, "once@example.test", inv.token)).ok).toBe(true);
    // The token is nulled by the bind, so the public resolve stops answering.
    expect((await h.fetch(`/api/tenants/invite/${inv.token}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Privileged acts leave a record
// ---------------------------------------------------------------------------

const activityActions = async (h: TestHarness): Promise<string[]> => {
  const res = await h.fetch("/api/activity?limit=200");
  if (!res.ok) throw new Error(`activity ${res.status}`);
  return ((await res.json()) as { data: { action: string }[] }).data.map((r) => r.action);
};

describe("faz10: running arbitrary SQL is audited", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  test("a read query writes a `db.sql` row", async () => {
    const res = await post(h, "/api/admin/db/sql/run", { sql: "SELECT 1 AS n" });
    expect(res.status).toBe(200);
    expect(await activityActions(h)).toContain("db.sql");
  });

  test("the row records the statement, truncated, and the write count", async () => {
    // "A write ran" without the statement is not enough for anyone to decide
    // whether to be alarmed.
    await post(h, "/api/admin/db/sql/run", { sql: "SELECT 42 AS answer" });
    const rows = (await (await h.fetch("/api/activity?limit=200")).json()) as {
      data: Array<{ action: string; payload?: Record<string, unknown> }>;
    };
    const row = rows.data.find((r) => r.action === "db.sql");
    expect(row).toBeDefined();
    expect(String(row!.payload?.sql)).toContain("42");
    expect(row!.payload?.statements).toBe(1);
    expect(row!.payload?.writes).toBe(0);
  });

  test("a FAILED statement is recorded too", async () => {
    // It still ran against the database, and a failed `DELETE FROM activity` is
    // the attempt an auditor most wants to see.
    const res = await post(h, "/api/admin/db/sql/run", { sql: "SELECT * FROM no_such_table" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = (await (await h.fetch("/api/activity?limit=200")).json()) as {
      data: Array<{ action: string; payload?: Record<string, unknown> }>;
    };
    const row = rows.data.find(
      (r) => r.action === "db.sql" && typeof r.payload?.error === "string",
    );
    expect(row).toBeDefined();
  });
});

describe("faz10: minting and revoking an API key is audited", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  test("create writes a row, and the SECRET is not in it", async () => {
    const res = await post(h, "/api/api-keys", { name: "ci" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; secret: string } };
    const rows = (await (await h.fetch("/api/activity?limit=200")).json()) as {
      data: Array<{ action: string; itemId?: string | null }>;
    };
    const row = rows.data.find((r) => r.action === "apikey.create");
    expect(row).toBeDefined();
    expect(row!.itemId).toBe(body.data.id);

    // Read the COLUMN, not the response. `/api/activity` redacts, so asserting
    // against its body would pass whatever was actually stored — and the point
    // is that the secret is not in a table more people can read than can hold
    // the key.
    const stored = rawRows<{ payload: string | null }>(
      h,
      "SELECT payload FROM activity WHERE action = 'apikey.create'",
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain(body.data.secret);
    // …and it does carry what an auditor needs.
    expect(JSON.stringify(stored)).toContain("ci");
  });

  test("revoke writes its own row", async () => {
    const created = await post(h, "/api/api-keys", { name: "ci2" });
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    const del = await h.fetch(`/api/api-keys/${id}`, { method: "DELETE" });
    expect(del.ok).toBe(true);
    expect(await activityActions(h)).toContain("apikey.revoke");
  });
});
