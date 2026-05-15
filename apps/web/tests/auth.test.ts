import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("auth: sign-up → /me → sign-out", () => {
  let h: TestHarness;
  let email: string;

  beforeAll(async () => {
    h = makeHarness();
    const creds = await seedAdmin(h);
    email = creds.email;
  });

  afterAll(() => {
    h.cleanup();
  });

  test("session cookie + /api/me returns the signed-in user with admin role", async () => {
    const res = await h.fetch("/api/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { email: string; isAdmin: boolean; roles: string[] };
    };
    expect(body.data.email).toBe(email);
    // First user of a fresh DB is auto-promoted to admin via onUserCreated.
    expect(body.data.isAdmin).toBe(true);
    expect(body.data.roles).toContain("admin");
  });

  test("sign-out drops the session", async () => {
    const signOut = await h.fetch("/api/auth/sign-out", { method: "POST" });
    expect(signOut.status).toBeLessThan(400);
    const me = await h.fetch("/api/me");
    expect(me.status).toBe(401);
  });
});
