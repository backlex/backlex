/**
 * Public sign-up is admin-controlled and default-CLOSED. Enforcement lives in
 * `context.ts::onBeforeUserCreated` and reads `auth_config.policy.openSignup`
 * (single source of truth). The first user always bootstraps; a valid workspace
 * invite admits its email even while closed; an admin can open sign-up.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown) => ({
  method: "POST" as const,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const signOut = (h: TestHarness) => h.fetch("/api/auth/sign-out", { method: "POST" });

const signUp = (h: TestHarness, email: string) =>
  h.fetch("/api/auth/sign-up/email", json({ email, password: "correct-horse-battery", name: "X" }));

describe("sign-up policy: default-closed + invites", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  test("first user bootstraps even though sign-up defaults to closed", async () => {
    const res = await signUp(h, "first@example.test");
    expect(res.ok).toBe(true);
  });

  test("second (non-invited) sign-up is rejected by default", async () => {
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });
    await signOut(h);
    const res = await signUp(h, "stranger@example.test");
    expect(res.status).toBe(403);
  });

  test("admin can open public sign-up; then strangers are admitted", async () => {
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });
    const patch = await h.fetch("/api/admin/auth/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: { openSignup: true } }),
    });
    expect(patch.ok).toBe(true);
    await signOut(h);
    const res = await signUp(h, "stranger@example.test");
    expect(res.ok).toBe(true);
  });

  test("an invited email may sign up while public sign-up is closed", async () => {
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });
    // Resolve the default workspace, then invite an address into it.
    const list = (await (await h.fetch("/api/tenants")).json()) as {
      data: { id: string; slug: string }[];
    };
    const tenantId = list.data.find((t) => t.slug === "default")!.id;
    const inv = await h.fetch(`/api/tenants/${tenantId}/members/invite`, json({ email: "invitee@example.test", role: "member" }));
    expect(inv.status).toBe(201);
    const { data: invData } = (await inv.json()) as { data: { id: string; token: string } };

    // Public token resolution (no auth) returns the locked email + workspace.
    await signOut(h);
    const meta = await h.fetch(`/api/tenants/invite/${invData.token}`);
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as { data: { email: string; workspaceName: string; expired: boolean } };
    expect(metaBody.data.email).toBe("invitee@example.test");
    expect(metaBody.data.expired).toBe(false);

    // A non-invited address is still blocked…
    expect((await signUp(h, "stranger@example.test")).status).toBe(403);
    // …but the invited address is admitted and auto-bound as an active member.
    expect((await signUp(h, "invitee@example.test")).ok).toBe(true);
    const mine = (await (await h.fetch("/api/tenants")).json()) as { data: { slug: string }[] };
    expect(mine.data.some((t) => t.slug === "default")).toBe(true);
  });

  test("GET /api/tenants/invite/:token 404s on an unknown token", async () => {
    await seedAdmin(h, "admin@example.test", "correct-horse-battery", { openSignup: false });
    await signOut(h);
    const res = await h.fetch("/api/tenants/invite/this-token-does-not-exist");
    expect(res.status).toBe(404);
  });
});

describe("first-admin OWNER_EMAIL lock", () => {
  test("only the pinned owner email may claim a fresh instance", async () => {
    const h = makeHarness({ OWNER_EMAIL: "owner@example.test" });
    try {
      // A stranger cannot claim even as the first user.
      expect((await signUp(h, "stranger@example.test")).status).toBe(403);
      // The pinned owner can.
      expect((await signUp(h, "owner@example.test")).ok).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("without OWNER_EMAIL, any first user may claim (self-host parity)", async () => {
    const h = makeHarness();
    try {
      expect((await signUp(h, "anyone@example.test")).ok).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});
