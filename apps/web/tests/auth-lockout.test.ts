/**
 * Failed-login lockout + auth abuse audit logging
 * (lib/auth-lockout.ts, lib/lockout-core.ts, lib/auth-rate-limit.ts).
 *
 * TWO locks, and the difference between them is the 2026-09 audit's phase 10.
 *
 * The lockout used to be keyed on the identifier ALONE and it blocked every
 * source, including the victim's own. `maxFails` wrong passwords — well under
 * the per-IP sign-in cap, so no address rotation was needed — shut the account,
 * and because `cycles` was only ever reset by a SUCCESSFUL sign-in (which the
 * locked-out person cannot produce) the cooldown ratcheted to its 15-minute
 * ceiling and stayed there. Anyone who knew `admin@example.com` held it shut
 * indefinitely at eight requests per fifteen minutes.
 *
 * So: a NARROW lock per (account, source), which stops credential stuffing
 * without denying the owner, and the account-wide lock kept for a genuinely
 * DISTRIBUTED attack at `WIDE_FAIL_FACTOR ×` the threshold. Plus decay, so the
 * penalty no longer outlives the attack.
 *
 * Module-level state persists across the bun-test process, so each suite uses a
 * fresh harness (fresh admin email = fresh lockout key).
 */
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { applyFailure, type LockState } from "../src/server/lib/lockout-core";

const JSON_HEADERS = { "Content-Type": "application/json" };
const uniqueIp = (() => {
  let n = 10;
  return () => `198.51.100.${n++}`;
})();

/**
 * The escalation decays — the half that made the old lock PERMANENT.
 *
 * Driven against the pure state machine rather than through HTTP, because the
 * thing being asserted is what happens after an hour of quiet and a spec cannot
 * wait for one. `applyFailure` takes `now` explicitly for exactly this reason.
 */
describe("auth-lockout: the backoff relaxes after a quiet period", () => {
  const policy = {
    maxFails: 2,
    windowMs: 60_000,
    baseCooldownMs: 1_000,
    maxCooldownMs: 60_000,
  };

  /** Drive `maxFails` failures and return the resulting state. */
  const lockOnce = (prev: LockState | undefined, at: number): LockState => {
    let state = prev;
    for (let i = 0; i < policy.maxFails; i++) {
      state = applyFailure(state, at, policy).state;
    }
    return state!;
  };

  test("cycles climb while the attack continues", () => {
    let t = 1_000_000;
    let state = lockOnce(undefined, t);
    expect(state.cycles).toBe(1);
    // Past the previous cooldown, but nowhere near an hour of quiet.
    t += 5_000;
    state = lockOnce(state, t);
    expect(state.cycles).toBe(2);
    t += 10_000;
    state = lockOnce(state, t);
    expect(state.cycles).toBe(3);
  });

  test("…and reset once the account has been quiet", () => {
    // The whole finding: `cycles` was only ever cleared by a SUCCESSFUL
    // sign-in, which the locked-out person cannot produce. Four cycles pinned
    // the cooldown at its ceiling and it stayed there for good.
    let state = lockOnce(undefined, 1_000_000);
    state = lockOnce(state, 1_005_000);
    expect(state.cycles).toBe(2);

    const muchLater = 1_005_000 + 2 * 60 * 60_000;
    const after = applyFailure(state, muchLater, policy);
    // One failure after the quiet period: back to counting from scratch, so
    // this is not yet a lock.
    expect(after.result.locked).toBe(false);
    expect(after.state.cycles).toBe(0);
  });

  test("the cooldown that follows is the BASE one again", () => {
    // Decay is only meaningful if the next lock is short. Asserted on the
    // observable an attacker actually experiences.
    let state = lockOnce(undefined, 1_000_000);
    state = lockOnce(state, 1_005_000);
    state = lockOnce(state, 1_010_000);
    const escalated = lockOnce(state, 1_020_000);
    expect(escalated.lockedUntil - 1_020_000).toBeGreaterThan(policy.baseCooldownMs);

    const quiet = 1_020_000 + 2 * 60 * 60_000;
    const relaxed = lockOnce({ ...escalated }, quiet);
    expect(relaxed.lockedUntil - quiet).toBe(policy.baseCooldownMs);
  });
});

describe("auth-lockout: a targeted account locks after repeated failures", () => {
  let h: TestHarness;
  let email: string;

  beforeAll(async () => {
    // Low threshold so the test trips the lock well under the per-IP signin cap.
    h = makeHarness({ AUTH_LOCKOUT_MAX_FAILS: "3", AUTH_LOCKOUT_COOLDOWN_MS: "60000" });
    const a = await seedAdmin(h);
    email = a.email;
  });
  afterAll(() => h.cleanup());

  test("MAX_FAILS bad passwords from ONE source locks that source", async () => {
    const attacker = uniqueIp();
    const wrong = (ip: string) =>
      h.fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { ...JSON_HEADERS, "X-Forwarded-For": ip },
        body: JSON.stringify({ email, password: "wrong-password-xyz" }),
      });

    for (let i = 0; i < 3; i++) {
      expect((await wrong(attacker)).status).toBe(401);
    }
    const blocked = await wrong(attacker);
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("RATE_LIMITED");
  });

  test("…and the OWNER can still reach the sign-in form from elsewhere", async () => {
    // The whole finding, stated as the thing that must not come back. The
    // victim's own request is a DIFFERENT source, so it is answered on its
    // merits — 401 for a wrong password here, not 429 for somebody else's
    // guessing. A 429 on this line is a denial-of-service primitive.
    const victim = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Forwarded-For": uniqueIp() },
      body: JSON.stringify({ email, password: "also-wrong" }),
    });
    expect(victim.status).toBe(401);
  });

  test("a DISTRIBUTED attack still trips the account-wide lock", async () => {
    // The wide lock is what the account-wide one is for, kept at
    // `WIDE_FAIL_FACTOR × maxFails` = 15 here. Each of these is a fresh source,
    // so none of them is narrowly locked and every attempt reaches the wide
    // counter — which is exactly the shape a single source cannot produce.
    let sawWide = false;
    for (let i = 0; i < 20 && !sawWide; i++) {
      const res = await h.fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { ...JSON_HEADERS, "X-Forwarded-For": uniqueIp() },
        body: JSON.stringify({ email, password: "wrong-password-xyz" }),
      });
      if (res.status === 429) sawWide = true;
    }
    expect(sawWide).toBe(true);
  });

  test("the lockout is recorded in the audit log as auth.login_locked", async () => {
    // The seeded admin's own session is still valid (a lock blocks new sign-ins,
    // not existing sessions), so we can read the activity feed.
    const res = await h.fetch("/api/activity?limit=200");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { action: string }[] };
    expect(body.data.some((r) => r.action === "auth.login_locked")).toBe(true);
  });
});

describe("auth-lockout: a successful sign-in clears the failure counter", () => {
  let h: TestHarness;
  let email: string;
  let password: string;

  beforeAll(async () => {
    h = makeHarness({ AUTH_LOCKOUT_MAX_FAILS: "3" });
    const a = await seedAdmin(h);
    email = a.email;
    password = a.password;
  });
  afterAll(() => h.cleanup());

  test("two failures then a success — the account is not locked", async () => {
    const ip = uniqueIp();
    const attempt = (pw: string) =>
      h.fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { ...JSON_HEADERS, "X-Forwarded-For": ip },
        body: JSON.stringify({ email, password: pw }),
      });

    expect((await attempt("nope-1")).status).toBe(401);
    expect((await attempt("nope-2")).status).toBe(401);
    // Correct password — succeeds AND clears the counter.
    expect([200, 201]).toContain((await attempt(password)).status);
    // Two more failures would only re-lock if the counter had NOT been cleared;
    // since it was, these stay under threshold and remain 401 (not 429).
    expect((await attempt("nope-3")).status).toBe(401);
    expect((await attempt("nope-4")).status).toBe(401);
  });
});

describe("auth-lockout: disabled via env", () => {
  let h: TestHarness;
  let email: string;

  beforeAll(async () => {
    h = makeHarness({ AUTH_LOCKOUT_DISABLED: "true", AUTH_LOCKOUT_MAX_FAILS: "2" });
    const a = await seedAdmin(h);
    email = a.email;
  });
  afterAll(() => h.cleanup());

  test("no lock is applied no matter how many failures (per-IP limiter aside)", async () => {
    const ip = uniqueIp();
    const wrong = () =>
      h.fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { ...JSON_HEADERS, "X-Forwarded-For": ip },
        body: JSON.stringify({ email, password: "still-wrong" }),
      });
    // 5 failures < per-IP signin cap (10) and lockout is off → all 401, never 429.
    for (let i = 0; i < 5; i++) {
      expect((await wrong()).status).toBe(401);
    }
  });
});

describe("auth abuse audit: per-IP rate-limit trips are logged", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("a tripped password-reset limiter writes an auth.rate_limited row", async () => {
    // Use forget-password (cap 5/min): it never rotates the session cookie, so
    // the admin session that reads the audit feed below stays intact. (Sign-up,
    // by contrast, signs the new user in and would clobber the admin cookie.)
    const ip = uniqueIp();
    const forget = () =>
      h.fetch("/api/auth/forget-password", {
        method: "POST",
        headers: { ...JSON_HEADERS, "X-Forwarded-For": ip },
        body: JSON.stringify({ email: "nobody@example.test" }),
      });
    let blocked = false;
    for (let i = 0; i < 8; i++) {
      if ((await forget()).status === 429) {
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);

    const res = await h.fetch("/api/activity?limit=200");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { action: string }[] };
    expect(body.data.some((r) => r.action === "auth.rate_limited")).toBe(true);
  });
});
