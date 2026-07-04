/**
 * Per-user list-view columns (`/api/account/list-columns`).
 *
 * The column map is personal: each user reads/writes their own
 * `userListColumns:<userId>` app-settings row, so one admin reordering their
 * table can't clobber a teammate's view. No admin role is required — any
 * signed-in user may save their own columns.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("account list-columns", () => {
  let h: TestHarness;
  let admin: { email: string; password: string };

  beforeAll(async () => {
    h = makeHarness();
    admin = await seedAdmin(h);
  });

  afterAll(() => h.cleanup());

  const signIn = (email: string, password: string) =>
    h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password }),
    });

  it("starts empty", async () => {
    const res = await h.fetch("/api/account/list-columns");
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({});
  });

  it("saves and reads back the caller's own map (insert then update)", async () => {
    const first = await h.fetch("/api/account/list-columns", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ listColumns: { posts: ["title", "status"] } }),
    });
    expect(first.status).toBe(200);

    // Second PATCH overwrites via the upsert path (row now exists).
    const second = await h.fetch("/api/account/list-columns", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ listColumns: { posts: ["status", "title", "views"] } }),
    });
    expect(second.status).toBe(200);

    const res = await h.fetch("/api/account/list-columns");
    expect((await res.json()).data).toEqual({
      posts: ["status", "title", "views"],
    });
  });

  it("keeps each user's map isolated (and lets non-admins write)", async () => {
    // Sign up a second (non-admin) user — the harness cookie jar switches to
    // their session.
    const signUp = await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: "viewer@example.test",
        password: "correct-horse-battery",
        name: "Viewer",
      }),
    });
    expect(signUp.ok).toBe(true);

    // The second user starts empty — the admin's map must not leak through.
    const before = await h.fetch("/api/account/list-columns");
    expect((await before.json()).data).toEqual({});

    // Non-admin write succeeds (unlike PATCH /api/admin/settings).
    const patch = await h.fetch("/api/account/list-columns", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ listColumns: { posts: ["title"] } }),
    });
    expect(patch.status).toBe(200);
    const mine = await h.fetch("/api/account/list-columns");
    expect((await mine.json()).data).toEqual({ posts: ["title"] });

    // Back as the admin: their original map is untouched.
    const back = await signIn(admin.email, admin.password);
    expect(back.ok).toBe(true);
    const adminMap = await h.fetch("/api/account/list-columns");
    expect((await adminMap.json()).data).toEqual({
      posts: ["status", "title", "views"],
    });
  });

  it("rejects malformed maps", async () => {
    // Unknown top-level keys are rejected (strict schema).
    const extra = await h.fetch("/api/account/list-columns", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ listColumns: {}, nope: 1 }),
    });
    expect(extra.status).toBe(400);

    // Per-collection column list is capped at 60 names.
    const tooMany = await h.fetch("/api/account/list-columns", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        listColumns: { posts: Array.from({ length: 61 }, (_, i) => `f${i}`) },
      }),
    });
    expect(tooMany.status).toBe(400);
  });

  it("requires a session", async () => {
    // Bypass the cookie-tracking fetch so no session is attached.
    const res = await h.app.fetch(
      new Request("http://localhost:5173/api/account/list-columns", {
        headers: { Origin: "http://localhost:5173" },
      }),
    );
    expect(res.status).toBe(401);
  });
});
