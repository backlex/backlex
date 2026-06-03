/**
 * Per-IP rate limit on sensitive auth subpaths and side-channel write
 * endpoints (lib/auth-rate-limit.ts).
 *
 * Module-level windows persist across the bun-test process, so each test
 * uses a fresh synthetic IP to keep its window distinct from sibling tests.
 */
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const uniqueIp = (() => {
  let n = 100;
  return () => `203.0.113.${n++}`;
})();

describe("auth-rate-limit: signup is capped per IP", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    // Public sign-up defaults to closed; seed an admin (also opens sign-up) so
    // the test signups below exercise the rate limiter rather than the policy
    // gate. The admin uses the harness's default IP, not the test's uniqueIp().
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("the 6th rapid signup from the same IP returns 429", async () => {
    const ip = uniqueIp();
    const attempt = (n: number) =>
      h.fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { ...JSON_HEADERS, "X-Forwarded-For": ip },
        body: JSON.stringify({
          email: `signup-cap-${ip}-${n}@example.test`,
          password: "correct-horse-battery",
          name: `Signup ${n}`,
        }),
      });

    // First five signups land normally (200 from better-auth).
    for (let i = 0; i < 5; i++) {
      const res = await attempt(i);
      expect(res.status).toBe(200);
    }
    // Sixth attempt within the window is blocked by the rate limiter.
    const blocked = await attempt(5);
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("RATE_LIMITED");
  });

  test("a different IP gets its own bucket", async () => {
    // Same harness, fresh IP — separate window, succeeds.
    const ip = uniqueIp();
    const res = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Forwarded-For": ip },
      body: JSON.stringify({
        email: `signup-other-ip-${ip}@example.test`,
        password: "correct-horse-battery",
        name: "Different IP",
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe("auth-rate-limit: signin is capped (higher) per IP", () => {
  let h: TestHarness;
  let email: string;

  beforeAll(async () => {
    h = makeHarness();
    // Seed an admin so we have real credentials to attempt signing in with.
    const a = await seedAdmin(h);
    email = a.email;
  });
  afterAll(() => h.cleanup());

  test("the 11th rapid sign-in from the same IP returns 429", async () => {
    const ip = uniqueIp();
    const attempt = () =>
      h.fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { ...JSON_HEADERS, "X-Forwarded-For": ip },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });

    // First ten succeed (or return 200 — better-auth treats repeated sign-ins
    // as idempotent token rotations).
    for (let i = 0; i < 10; i++) {
      const res = await attempt();
      expect([200, 201]).toContain(res.status);
    }
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
  });
});

describe("api-keys: create is capped per IP", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("the 11th key-create POST from the same IP returns 429", async () => {
    const ip = uniqueIp();
    const create = (label: string) =>
      h.fetch("/api/api-keys", {
        method: "POST",
        headers: { ...JSON_HEADERS, "X-Forwarded-For": ip },
        body: JSON.stringify({ name: `cap-test-${label}` }),
      });

    for (let i = 0; i < 10; i++) {
      const res = await create(`ok-${i}`);
      expect(res.status).toBe(201);
    }
    const blocked = await create("blocked");
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("RATE_LIMITED");
  });
});

describe("auth-rate-limit: read-only GETs bypass the limiter", () => {
  let h: TestHarness;
  beforeAll(() => {
    h = makeHarness();
  });
  afterAll(() => h.cleanup());

  test("GET /api/auth/providers is never throttled", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 20; i++) {
      const res = await h.fetch("/api/auth/providers", {
        headers: { "X-Forwarded-For": ip },
      });
      // Discovery endpoint always responds 200 (or 404 if not configured) —
      // never 429 regardless of volume.
      expect(res.status).not.toBe(429);
    }
  });
});
