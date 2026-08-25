/**
 * Coverage for `/api/app-users` (workspace end-user admin CRUD) — a sizable
 * route that had ZERO direct test references. The destructive endpoints
 * (suspend / revoke-sessions / delete) are all `requireUser + requireAdmin`,
 * so the highest-value guard is the auth surface: a non-admin member or an
 * anonymous caller must never reach them, and an admin gets a clean list.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const PASSWORD = "correct-horse-battery";

describe("/api/app-users auth surface", () => {
  let h: TestHarness;
  let adminEmail: string;
  const memberEmail = `member-${Date.now()}@example.test`;

  const signIn = (email: string) =>
    h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password: PASSWORD }),
    });
  const signOut = () => h.fetch("/api/auth/sign-out", { method: "POST" });

  beforeAll(async () => {
    h = makeHarness();
    adminEmail = (await seedAdmin(h)).email; // first user → admin, opens signup
    await signOut();
    const su = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: memberEmail, password: PASSWORD, name: "Member" }),
    });
    expect(su.status).toBe(200);
    await signOut();
  });

  afterAll(() => h.cleanup());

  test("anonymous callers are rejected", async () => {
    await signOut();
    expect((await h.fetch("/api/app-users")).status).toBe(401);
  });

  test("a non-admin member is forbidden", async () => {
    expect((await signIn(memberEmail)).status).toBe(200);
    expect((await h.fetch("/api/app-users")).status).toBe(403);
  });

  test("a non-admin member cannot delete a workspace end-user", async () => {
    expect((await signIn(memberEmail)).status).toBe(200);
    const res = await h.fetch("/api/app-users/some-id", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  test("an admin gets the (empty) workspace end-user list", async () => {
    expect((await signIn(adminEmail)).status).toBe(200);
    const res = await h.fetch("/api/app-users");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  /**
   * `roleIds` is a real key on this resource — `PUT /{id}/roles` and the invite
   * body both take it — so sending it to the update endpoint is a natural
   * mistake. It used to be swallowed and answered `{ok:true}`, leaving portal
   * access looking granted while the user held no roles and every request
   * 403'd. Unknown keys are now named, with the route that owns them.
   */
  test("an unrecognized key is refused instead of silently ignored", async () => {
    expect((await signIn(adminEmail)).status).toBe(200);
    const res = await h.fetch("/api/app-users/some-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roleIds: ["role-1"] }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("PUT /api/app-users/{id}/roles");
  });

  test("an unknown key that has no home still says what this endpoint takes", async () => {
    expect((await signIn(adminEmail)).status).toBe(200);
    const res = await h.fetch("/api/app-users/some-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statuz: "suspended" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("statuz");
    expect(body.error.message).toContain("status");
  });
});
