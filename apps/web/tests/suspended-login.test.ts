/**
 * Control-plane suspended-operator guard. The `session.create.before` hook in
 * `createAuth` blocks session creation for any platform user whose
 * `users.status` isn't active — so a suspended operator can't sign back in via
 * ANY path (email/password here; the SSO paths are covered in platform-saml).
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

describe("control-plane: suspended user can't sign in", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h); // admin = first user; opens public sign-up
    // Second user via email sign-up.
    const res = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "op@example.test", password: "correct-horse-battery", name: "Op" }),
    });
    if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  });

  afterAll(() => h.cleanup());

  test("password sign-in succeeds while active, fails after suspension", async () => {
    const ok = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "op@example.test", password: "correct-horse-battery" }),
    });
    expect(ok.status).toBe(200);

    const db = new Database(h.env.SQLITE_PATH!);
    db.run("UPDATE users SET status = 'suspended' WHERE email = ?", ["op@example.test"]);
    db.close();

    const blocked = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "op@example.test", password: "correct-horse-battery" }),
    });
    expect(blocked.status).not.toBe(200);
  });
});
