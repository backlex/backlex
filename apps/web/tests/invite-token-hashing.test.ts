/**
 * Invite tokens are not readable at rest — all three invitation lifecycles.
 *
 * An invite token is a bearer credential: whoever holds it is seated at the
 * standing the invitation names, `admin` included. Until this change all three
 * lifecycles stored theirs in the clear, so a database dump, a nightly backup
 * or a support `SELECT *` handed over a working invitation:
 *
 *   - `tenant_members.invite_token`  — the platform workspace invite;
 *   - `app_org_invites.token`        — the app-plane organization invitation;
 *   - `app_verifications.identifier` — the workspace end-user invite, whose
 *     token IS the row key (`app-invite:<token>`), so the table itself was the
 *     credential store.
 *
 * Each now stores only a SHA-256 digest, matching what `shared_links` and
 * `form_invites` already did. This spec pins the four things that have to be
 * true of every one of them at once:
 *
 *   1. a NEW invitation leaves no plaintext anywhere in its table;
 *   2. the token handed back to the caller still accepts;
 *   3. a row minted BEFORE hashing still accepts, and LOGS that it did — an
 *      unlogged compatibility path is never removed, because nobody can prove
 *      it is unused;
 *   4. a wrong token is refused.
 *
 * Two of the assertions here are deliberately paired with a negative control,
 * because the failure mode of a test like this is passing for the wrong reason:
 *
 *   - the "no plaintext at rest" scan is re-run against a row that was hand-
 *     written back into the plaintext shape, and must FIND it. A scanner that
 *     matched nothing would otherwise report success forever.
 *   - the replay guard (`token_hash IS NULL` on the plaintext lookup) is tested
 *     by removing it from the DATA: with the digest in `token` and `token_hash`
 *     nulled, the very same request that was refused starts succeeding. That is
 *     what proves the query reaches the row at all, and that the guard — not
 *     some unrelated 404 — is what turned it away.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS as SQLITE_MIGRATIONS } from "@backlex/db/sqlite/migrations-bundle";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { hashToken } from "../src/server/services/shared-links";

const JSON_HEADERS = { "content-type": "application/json" };

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

type Bearer = (path: string, init?: RequestInit) => Promise<Response>;

const bearerFor =
  (h: TestHarness, token: string): Bearer =>
  (path, init = {}) =>
    h.app.request(path, {
      ...init,
      headers: {
        ...JSON_HEADERS,
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });

/**
 * Open a second connection to the harness's SQLite file.
 *
 * The harness leaves the database in WAL mode, so a short-lived reader/writer
 * can work alongside the app's own handle. This is the only honest way to ask
 * "what is actually stored" — every API surface deliberately refuses to answer
 * it, which is the point of the feature.
 */
const withDb = <T>(h: TestHarness, fn: (db: Database) => T): T => {
  const db = new Database(h.env.SQLITE_PATH as string);
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

/** Every row of `table`, serialized. The detector behind "no plaintext at
 *  rest": it looks at whole rows rather than named columns, so a token that
 *  moved to a different column is still caught. */
const dumpTable = (h: TestHarness, table: string): string =>
  withDb(h, (db) => JSON.stringify(db.query(`SELECT * FROM ${table}`).all()));

/** One row, or `null`. Throws on a query error rather than reading as empty. */
const rowWhere = (
  h: TestHarness,
  sql: string,
  ...params: unknown[]
): Record<string, unknown> | null =>
  withDb(
    h,
    (db) =>
      (db.query(sql).get(...(params as never[])) as Record<string, unknown> | null) ??
      null,
  );

/**
 * Run an UPDATE and prove it changed something.
 *
 * A zero-row UPDATE is this codebase's signature bug in miniature: the write
 * "succeeds", the test carries on, and every assertion after it passes against
 * the state the test believed it had replaced. `changes` is read back and a
 * miss throws.
 */
const mustUpdate = (h: TestHarness, sql: string, ...params: unknown[]): void => {
  const changed = withDb(h, (db) => db.query(sql).run(...(params as never[])).changes);
  if (changed !== 1)
    throw new Error(`expected exactly 1 row updated, got ${changed} — for: ${sql}`);
};

/**
 * Capture `console.warn` while `fn` runs.
 *
 * `lib/log.ts` emits warn lines through `console.warn`, and the harness is
 * built with `LOG_LEVEL: "warn"` so the threshold lets them through. If that
 * ever stops being true the legacy-fallback assertions below fail loudly rather
 * than silently finding nothing — which is why each of them asserts a line was
 * captured instead of only asserting the request succeeded.
 */
const captureWarnings = async (fn: () => Promise<void>): Promise<string[]> => {
  const real = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = real;
  }
  return lines;
};

const LEGACY_TENANT_MEMBERS = "[invites] legacy plaintext invite token accepted";
const LEGACY_APP_ORGS = "[app-orgs] legacy plaintext invite token accepted";
const LEGACY_APP_USERS = "[app-user-invites] legacy plaintext invite token accepted";

/** A token-shaped string that was never issued. */
const bogusToken = () => `${crypto.randomUUID().replace(/-/g, "")}deadbeef`;

// ---------------------------------------------------------------------------
// 0. The migration that adds the columns has to survive being re-run
// ---------------------------------------------------------------------------

describe("20260830090000_invite_token_hash", () => {
  /** The five error shapes `packages/db/src/auto-migrate.ts` treats as "the
   *  state is already there". Anything else stops the boot-time runner and
   *  leaves the ledger stuck on this migration for every later cold start. */
  const TOLERATED =
    /already exists|duplicate column|duplicate object|duplicate type|multiple primary keys/i;

  const stmts = (sqlText: string) =>
    sqlText
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .filter(Boolean);

  test("replays on SQLite raising only errors auto-migrate tolerates", () => {
    // SQLite has no `ADD COLUMN IF NOT EXISTS`, so this migration is
    // deliberately NOT self-guarding on that statement — it leans on the
    // runner's `duplicate column` tolerance the same way every other bare
    // `ADD COLUMN` in the directory does. That is only safe if it is true, and
    // this is where it is checked rather than asserted in a comment.
    //
    // The pg twin is not replayed here (it would want a pglite boot for one
    // assertion); it uses `IF NOT EXISTS` on all four statements, and
    // `migration-parity.test.ts` already applies both chains to real databases
    // and fails on any table/column/index the two dialects do not share.
    const db = new Database(":memory:");
    try {
      for (const m of SQLITE_MIGRATIONS) {
        for (const s of stmts(m.sql)) {
          try {
            db.exec(s);
          } catch (e) {
            const msg = (e as Error).message;
            if (!TOLERATED.test(msg)) throw new Error(`${m.name}: ${msg}`);
          }
        }
      }
      const mine = SQLITE_MIGRATIONS.find(
        (m) => m.name === "20260830090000_invite_token_hash",
      );
      // Not `?.` — a renamed folder must fail here, not skip silently.
      expect(mine).toBeDefined();
      const unexpected: string[] = [];
      for (const s of stmts(mine!.sql)) {
        try {
          db.exec(s);
        } catch (e) {
          const msg = (e as Error).message;
          if (!TOLERATED.test(msg)) unexpected.push(msg);
        }
      }
      expect(unexpected).toEqual([]);

      // Shape, not just survival.
      const members = db
        .query("PRAGMA table_info(tenant_members)")
        .all() as Array<{ name: string }>;
      expect(members.map((c) => c.name)).toContain("invite_token_hash");
      const invites = db
        .query("PRAGMA table_info(app_org_invites)")
        .all() as Array<{ name: string; notnull: number }>;
      // `token` stays NOT NULL — relaxing it is a table rebuild, and this
      // schema migrates on the boot path of every serverless cold start.
      expect(invites.find((c) => c.name === "token")!.notnull).toBe(1);
      expect(invites.find((c) => c.name === "token_hash")!.notnull).toBe(0);

      // The unique index on `token_hash` lands on an all-NULL column. Two
      // legacy rows have to coexist under it — SQLite, like Postgres, treats
      // NULLs in a unique index as distinct. If that were wrong, the migration
      // would apply cleanly and then break the second legacy row's INSERT.
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(
        "INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('t1','T','t',0,0)",
      );
      db.exec(
        "INSERT INTO app_orgs (id, tenant_id, slug, name, created_at, updated_at) VALUES ('o1','t1','o','O',0,0)",
      );
      db.exec(
        "INSERT INTO app_org_invites (id, tenant_id, org_id, email, role, token, expires_at, created_at) " +
          "VALUES ('i1','t1','o1','a@x','member','tok1',0,0), ('i2','t1','o1','b@x','member','tok2',0,0)",
      );
      const n = db
        .query("SELECT count(*) AS n FROM app_org_invites WHERE token_hash IS NULL")
        .get() as { n: number };
      expect(n.n).toBe(2);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 1. Platform workspace invite — `tenant_members`
// ---------------------------------------------------------------------------

describe("workspace invite tokens (tenant_members)", () => {
  let h: TestHarness;

  const mint = async (email: string): Promise<{ id: string; token: string }> => {
    const res = await h.fetch("/api/users/invite", json("POST", { email }));
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { id: string; token: string } }).data;
  };

  const signIn = (email: string, password = "correct-horse-battery") =>
    h.fetch("/api/auth/sign-in/email", json("POST", { email, password }));

  beforeAll(async () => {
    h = makeHarness({ LOG_LEVEL: "warn" });
    await seedAdmin(h, "admin@hashing.test", "correct-horse-battery", {
      openSignup: false,
    });
  });
  afterAll(() => h.cleanup());

  test("a new invite writes only the digest — and the scan that says so can see plaintext when there is any", async () => {
    const inv = await mint("fresh@hashing.test");

    const row = rowWhere(h, "SELECT * FROM tenant_members WHERE id = ?1", inv.id);
    expect(row).not.toBeNull();
    expect(row!.invite_token).toBeNull();
    expect(row!.invite_token_hash).toBe(await hashToken(inv.token));

    // The whole table, not the one column: a token that leaked into a
    // neighbouring column would still be a token.
    expect(dumpTable(h, "tenant_members")).not.toContain(inv.token);

    // NEGATIVE CONTROL. The assertion above is a `not.toContain`, which is
    // exactly the shape that passes when the detector is broken — a mistyped
    // table name, a token the mint never returned. Put the plaintext back the
    // old way and the SAME scan must find it.
    mustUpdate(
      h,
      "UPDATE tenant_members SET invite_token = ?1, invite_token_hash = NULL WHERE id = ?2",
      inv.token,
      inv.id,
    );
    expect(dumpTable(h, "tenant_members")).toContain(inv.token);

    // …and back to the shape the service actually writes, so the next test
    // reads a real hashed row.
    mustUpdate(
      h,
      "UPDATE tenant_members SET invite_token = NULL, invite_token_hash = ?1 WHERE id = ?2",
      await hashToken(inv.token),
      inv.id,
    );
    expect(rowWhere(h, "SELECT * FROM tenant_members WHERE id = ?1", inv.id)!.invite_token).toBeNull();
  });

  test("the token handed to the caller still resolves and still accepts", async () => {
    const inv = await mint("accepts@hashing.test");

    // The public resolve the /invite page calls, with no session at all.
    const meta = await h.app.request(`/api/tenants/invite/${inv.token}`);
    expect(meta.status).toBe(200);
    expect(
      ((await meta.json()) as { data: { email: string } }).data.email,
    ).toBe("accepts@hashing.test");

    // Sign-up is closed; the invite is what admits this address, which only
    // works if `findActiveInviteByEmail` can see a hashed row.
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const stranger = await h.fetch(
      "/api/auth/sign-up/email",
      json("POST", {
        email: "nobody@hashing.test",
        password: "correct-horse-battery",
        name: "X",
      }),
    );
    expect(stranger.status).toBe(403);

    const signedUp = await h.fetch(
      "/api/auth/sign-up/email",
      json("POST", {
        email: "accepts@hashing.test",
        password: "correct-horse-battery",
        name: "X",
      }),
    );
    expect(signedUp.ok).toBe(true);

    const me = (await (await h.fetch("/api/me")).json()) as {
      data?: { roles?: string[] };
      roles?: string[];
    };
    expect(me.data?.roles ?? me.roles ?? []).toContain("authenticated");

    // Spent: both columns cleared, so neither lookup answers for it again.
    const after = rowWhere(h, "SELECT * FROM tenant_members WHERE id = ?1", inv.id);
    expect(after!.invite_token).toBeNull();
    expect(after!.invite_token_hash).toBeNull();
    expect((await h.app.request(`/api/tenants/invite/${inv.token}`)).status).toBe(404);
  });

  test("an invite minted before hashing still accepts, and says so in the log", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await signIn("admin@hashing.test");
    const inv = await mint("legacy@hashing.test");

    // The shape a row written before this change has: plaintext, no digest.
    mustUpdate(
      h,
      "UPDATE tenant_members SET invite_token = ?1, invite_token_hash = NULL WHERE id = ?2",
      inv.token,
      inv.id,
    );

    let status = 0;
    const warnings = await captureWarnings(async () => {
      status = (await h.app.request(`/api/tenants/invite/${inv.token}`)).status;
    });
    expect(status).toBe(200);
    // The signal an operator watches to know the fallback is dead. Without it
    // the column is never dropped, because nobody can prove it is unused.
    const hit = warnings.find((l) => l.includes(LEGACY_TENANT_MEMBERS));
    expect(hit).toBeDefined();
    expect(hit).toContain(inv.id);
    // Whatever else it logs, it must not log the credential.
    expect(hit).not.toContain(inv.token);

    // And it is a real accept, not just a resolve.
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const signedUp = await h.fetch(
      "/api/auth/sign-up/email",
      json("POST", {
        email: "legacy@hashing.test",
        password: "correct-horse-battery",
        name: "X",
      }),
    );
    expect(signedUp.ok).toBe(true);
    const row = rowWhere(h, "SELECT * FROM tenant_members WHERE id = ?1", inv.id);
    expect(row!.status).toBe("active");
    expect(row!.invite_token).toBeNull();
  });

  test("a token nobody issued is refused on both surfaces", async () => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await signIn("admin@hashing.test");
    const wrong = bogusToken();
    expect((await h.app.request(`/api/tenants/invite/${wrong}`)).status).toBe(404);
    const accept = await h.fetch("/api/tenants/accept", json("POST", { token: wrong }));
    expect(accept.status).toBe(404);
  });

  test("the stored digest is not itself a token, and the IS NULL guard is what refuses it", async () => {
    const inv = await mint("replay@hashing.test");
    const digest = await hashToken(inv.token);

    // The attack this closes: read the row, replay what you read. Put the
    // digest into the PLAINTEXT column as well, i.e. the worst case — the value
    // an attacker can see is sitting in the column the fallback matches on.
    mustUpdate(
      h,
      "UPDATE tenant_members SET invite_token = ?1, invite_token_hash = ?1 WHERE id = ?2",
      digest,
      inv.id,
    );
    expect((await h.app.request(`/api/tenants/invite/${digest}`)).status).toBe(404);

    // NEGATIVE CONTROL for the guard itself. Drop the digest — the row now
    // looks like a legacy one whose plaintext token happens to be `digest` —
    // and the identical request succeeds. So the query DOES reach this row, and
    // `invite_token_hash IS NULL` is the only thing that turned it away.
    mustUpdate(
      h,
      "UPDATE tenant_members SET invite_token_hash = NULL WHERE id = ?1",
      inv.id,
    );
    expect((await h.app.request(`/api/tenants/invite/${digest}`)).status).toBe(200);

    // The real token still resolves nothing now (its digest is gone), which is
    // the cost of having rewritten the row — assert it so the state is honest.
    expect((await h.app.request(`/api/tenants/invite/${inv.token}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 2. Workspace end-user invite — `app_verifications`
// 3. Organization invitation      — `app_org_invites`
// ---------------------------------------------------------------------------

describe("app-plane invitation tokens", () => {
  let h: TestHarness;
  let owner: { id: string; token: string; email: string };
  let orgId: string;

  /** Admin-invite an end-user and accept it — which is itself a full pass
   *  through the hashed `app_verifications` lifecycle. */
  const makeEndUser = async (
    email: string,
  ): Promise<{ id: string; token: string; email: string }> => {
    const invited = await h.fetch("/api/app-users/invite", json("POST", { email }));
    expect(invited.status).toBe(201);
    const { data } = (await invited.json()) as {
      data: { id: string; email: string; token: string };
    };
    const accepted = await h.app.request(
      "/api/t/default/auth/invite/accept",
      json("POST", { token: data.token, password: "hashing-pass-12345" }),
    );
    expect(accepted.status).toBe(200);
    const session = (await accepted.json()) as { token: string };
    return { id: data.id, token: session.token, email: data.email };
  };

  const mintAppUserInvite = async (
    email: string,
  ): Promise<{ id: string; token: string }> => {
    const res = await h.fetch("/api/app-users/invite", json("POST", { email }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string; token: string } }).data;
  };

  const mintOrgInvite = async (email: string): Promise<{ id: string; token: string }> => {
    const res = await bearerFor(h, owner.token)(
      `/api/t/default/orgs/${orgId}/invites`,
      json("POST", { email }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string; token: string } }).data;
  };

  const previewOrgInvite = (token: string) =>
    h.app.request(`/api/t/default/orgs/invites/${encodeURIComponent(token)}`);

  beforeAll(async () => {
    h = makeHarness({ LOG_LEVEL: "warn" });
    await seedAdmin(h, "admin@hashing2.test", "correct-horse-battery");
    owner = await makeEndUser("owner@hashing2.test");
    const created = await h.fetch(
      "/api/app-orgs",
      json("POST", { name: "Hashing Co", ownerAppUserId: owner.id }),
    );
    expect(created.status).toBe(201);
    orgId = ((await created.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  // --- app_verifications ---------------------------------------------------

  test("an end-user invite is keyed by a digest, not by the token", async () => {
    const inv = await mintAppUserInvite("enduser@hashing2.test");

    // The row key used to BE the token (`app-invite:<token>`), so this table
    // was a list of live credentials.
    expect(dumpTable(h, "app_verifications")).not.toContain(inv.token);
    const row = rowWhere(
      h,
      "SELECT * FROM app_verifications WHERE identifier = ?1",
      `app-invite-h:${await hashToken(inv.token)}`,
    );
    expect(row).not.toBeNull();

    // NEGATIVE CONTROL for the scan, same reasoning as the workspace one.
    mustUpdate(
      h,
      "UPDATE app_verifications SET identifier = ?1 WHERE id = ?2",
      `app-invite:${inv.token}`,
      row!.id,
    );
    expect(dumpTable(h, "app_verifications")).toContain(inv.token);

    // Leave it in the LEGACY shape — the next test redeems it from there.
  });

  test("a legacy end-user invite still accepts, and says so in the log", async () => {
    // Minted fresh, then hand-written into the pre-hashing shape.
    const inv = await mintAppUserInvite("legacy-enduser@hashing2.test");
    const row = rowWhere(
      h,
      "SELECT * FROM app_verifications WHERE identifier = ?1",
      `app-invite-h:${await hashToken(inv.token)}`,
    );
    expect(row).not.toBeNull();
    mustUpdate(
      h,
      "UPDATE app_verifications SET identifier = ?1 WHERE id = ?2",
      `app-invite:${inv.token}`,
      row!.id,
    );

    let status = 0;
    const warnings = await captureWarnings(async () => {
      status = (
        await h.app.request(
          "/api/t/default/auth/invite/accept",
          json("POST", { token: inv.token, password: "hashing-pass-12345" }),
        )
      ).status;
    });
    expect(status).toBe(200);
    const hit = warnings.find((l) => l.includes(LEGACY_APP_USERS));
    expect(hit).toBeDefined();
    expect(hit).not.toContain(inv.token);

    // One-shot: the row is gone, so a replay finds nothing on either path.
    expect(
      rowWhere(h, "SELECT * FROM app_verifications WHERE id = ?1", row!.id),
    ).toBeNull();
  });

  test("an end-user invite refuses a token nobody issued, and refuses the stored digest", async () => {
    const inv = await mintAppUserInvite("guard-enduser@hashing2.test");
    const digest = await hashToken(inv.token);

    const wrong = await h.app.request(
      "/api/t/default/auth/invite/accept",
      json("POST", { token: bogusToken(), password: "hashing-pass-12345" }),
    );
    expect(wrong.status).toBe(404);

    // The digest is visible in `identifier`. Submitting it must not work — and
    // it cannot, because the hashed rows use a DIFFERENT prefix from the legacy
    // ones, so `app-invite:<digest>` names no row. This is the whole reason the
    // prefix changed with the scheme instead of staying `app-invite:`.
    const replay = await h.app.request(
      "/api/t/default/auth/invite/accept",
      json("POST", { token: digest, password: "hashing-pass-12345" }),
    );
    expect(replay.status).toBe(404);

    // NEGATIVE CONTROL: were the hashed row stored under the legacy prefix —
    // which is what a "just hash it, keep the key format" change would do —
    // the very same replay succeeds.
    const row = rowWhere(
      h,
      "SELECT * FROM app_verifications WHERE identifier = ?1",
      `app-invite-h:${digest}`,
    );
    expect(row).not.toBeNull();
    mustUpdate(
      h,
      "UPDATE app_verifications SET identifier = ?1 WHERE id = ?2",
      `app-invite:${digest}`,
      row!.id,
    );
    const wouldHave = await h.app.request(
      "/api/t/default/auth/invite/accept",
      json("POST", { token: digest, password: "hashing-pass-12345" }),
    );
    expect(wouldHave.status).toBe(200);
  });

  // --- app_org_invites -----------------------------------------------------

  test("a new org invitation stores a digest in both columns and the raw token in neither", async () => {
    const inv = await mintOrgInvite("orgmate@hashing2.test");
    const digest = await hashToken(inv.token);

    expect(dumpTable(h, "app_org_invites")).not.toContain(inv.token);
    const row = rowWhere(h, "SELECT * FROM app_org_invites WHERE id = ?1", inv.id);
    expect(row).not.toBeNull();
    expect(row!.token_hash).toBe(digest);
    // `token` is NOT NULL and uniquely indexed and cannot cheaply be relaxed on
    // SQLite, so it carries the digest too — a value that is not a credential.
    expect(row!.token).toBe(digest);

    // NEGATIVE CONTROL for the scan.
    mustUpdate(
      h,
      "UPDATE app_org_invites SET token = ?1 WHERE id = ?2",
      inv.token,
      inv.id,
    );
    expect(dumpTable(h, "app_org_invites")).toContain(inv.token);
    mustUpdate(
      h,
      "UPDATE app_org_invites SET token = ?1 WHERE id = ?2",
      digest,
      inv.id,
    );

    // …and the link still resolves for a caller with no session.
    const preview = await previewOrgInvite(inv.token);
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { data: { orgName: string } }).data.orgName).toBe(
      "Hashing Co",
    );
  });

  test("the value stored in `app_org_invites.token` cannot be replayed as a token", async () => {
    const inv = await mintOrgInvite("replay-org@hashing2.test");
    const digest = await hashToken(inv.token);
    expect(rowWhere(h, "SELECT * FROM app_org_invites WHERE id = ?1", inv.id)!.token).toBe(
      digest,
    );

    // Read the row, replay what you read. This is the exact attack the digest-
    // in-a-readable-column arrangement would otherwise open.
    expect((await previewOrgInvite(digest)).status).toBe(404);

    // NEGATIVE CONTROL for the guard. Null the digest — the row now reads as a
    // legacy one whose plaintext token happens to equal `digest` — and the
    // identical request succeeds. So the plaintext query genuinely reaches this
    // row, and `token_hash IS NULL` is the only thing that refused it.
    mustUpdate(h, "UPDATE app_org_invites SET token_hash = NULL WHERE id = ?1", inv.id);
    expect((await previewOrgInvite(digest)).status).toBe(200);

    // Restore, and confirm the real token is the only thing that works again.
    mustUpdate(
      h,
      "UPDATE app_org_invites SET token_hash = ?1 WHERE id = ?2",
      digest,
      inv.id,
    );
    expect((await previewOrgInvite(digest)).status).toBe(404);
    expect((await previewOrgInvite(inv.token)).status).toBe(200);
  });

  test("an org invitation minted before hashing still resolves and accepts, and says so in the log", async () => {
    const invitee = await makeEndUser("legacy-org@hashing2.test");
    const inv = await mintOrgInvite(invitee.email);

    mustUpdate(
      h,
      "UPDATE app_org_invites SET token = ?1, token_hash = NULL WHERE id = ?2",
      inv.token,
      inv.id,
    );

    let status = 0;
    const warnings = await captureWarnings(async () => {
      status = (await previewOrgInvite(inv.token)).status;
    });
    expect(status).toBe(200);
    const hit = warnings.find((l) => l.includes(LEGACY_APP_ORGS));
    expect(hit).toBeDefined();
    expect(hit).toContain(inv.id);
    expect(hit).not.toContain(inv.token);

    // …and it accepts, which is the half that actually seats somebody.
    const accepted = await bearerFor(h, invitee.token)(
      "/api/t/default/orgs/invites/accept",
      json("POST", { token: inv.token }),
    );
    expect(accepted.status).toBe(200);
    expect(
      rowWhere(h, "SELECT * FROM app_org_invites WHERE id = ?1", inv.id)!.accepted_at,
    ).not.toBeNull();
  });

  test("an org invitation refuses a token nobody issued", async () => {
    expect((await previewOrgInvite(bogusToken())).status).toBe(404);
    const accepted = await bearerFor(h, owner.token)(
      "/api/t/default/orgs/invites/accept",
      json("POST", { token: bogusToken() }),
    );
    expect(accepted.status).toBe(404);
  });
});
