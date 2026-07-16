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
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (body: unknown) => ({
  method: "POST" as const,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

const signOut = (h: TestHarness) => h.fetch("/api/auth/sign-out", { method: "POST" });

const signUp = (h: TestHarness, email: string) =>
  h.fetch("/api/auth/sign-up/email", json({ email, password: "correct-horse-battery", name: "X" }));

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

    // The pending invite shows up in the users list with its shareable link.
    const list = (await (await h.fetch("/api/users")).json()) as {
      data: Array<{ email: string; status?: string; inviteUrl?: string; memberId?: string }>;
    };
    const pending = list.data.find((u) => u.email === "teammate@example.test");
    expect(pending).toBeDefined();
    expect(pending!.status).toBe("invited");
    expect(pending!.inviteUrl).toBe(inv.url);

    // The token resolves publicly (the /invite page metadata call).
    await signOut(h);
    const meta = await h.fetch(`/api/tenants/invite/${inv.token}`);
    expect(meta.status).toBe(200);

    // Sign-up is closed for strangers but open for the invited address.
    expect((await signUp(h, "stranger@example.test")).status).toBe(403);
    expect((await signUp(h, "teammate@example.test")).ok).toBe(true);

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
    await signOut(h);
    expect((await signUp(h, "second-admin@example.test")).ok).toBe(true);
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
