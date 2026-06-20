/**
 * Failed-login account lockout + auth abuse audit logging
 * (lib/auth-lockout.ts, lib/lockout-core.ts, lib/auth-rate-limit.ts).
 *
 * The per-account lockout is the complement to the per-IP limiter: it tracks
 * failed password attempts for one identifier across IPs and temporarily locks
 * it. Module-level state persists across the bun-test process, so each suite
 * uses a fresh harness (fresh admin email = fresh lockout key).
 */
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const uniqueIp = (() => {
  let n = 10;
  return () => `198.51.100.${n++}`;
})();

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

  test("the attempt after MAX_FAILS bad passwords is locked (429), across IPs", async () => {
    const wrong = (ip: string) =>
      h.fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { ...JSON_HEADERS, "X-Forwarded-For": ip },
        body: JSON.stringify({ email, password: "wrong-password-xyz" }),
      });

    // Three failures — each from a DIFFERENT IP, proving the lock is keyed by
    // account, not IP (the per-IP limiter would never trip with 1 hit per IP).
    for (let i = 0; i < 3; i++) {
      const res = await wrong(uniqueIp());
      expect(res.status).toBe(401);
    }
    // Fourth attempt (yet another fresh IP) is blocked by the account lock.
    const blocked = await wrong(uniqueIp());
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("RATE_LIMITED");
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
