/**
 * Admin provider toggle must actually gate the control-plane endpoint, not
 * just hide the sign-in button.
 *
 * The control-plane better-auth instance loads its plugin set once per isolate
 * from `env.AUTH_PLUGINS` and is never rebuilt, so before the HTTP-edge gate in
 * routes/auth.ts a magic-link / email-OTP provider toggled off in admin would
 * still mint sessions. These tests lock that gate in.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const setMagicEnabled = (h: TestHarness, enabled: boolean) =>
  h.fetch("/api/admin/auth/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providers: { magic: { enabled } } }),
  });

const requestMagicLink = (h: TestHarness, email: string) =>
  h.fetch("/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

describe("admin provider toggle gates the endpoint", () => {
  let h: TestHarness;

  beforeEach(async () => {
    // The plugin must be loaded for the endpoint to exist at all; the gate is
    // what makes the admin toggle override it.
    h = makeHarness({ AUTH_PLUGINS: "magic-link" });
    await seedAdmin(h);
  });

  afterEach(() => h.cleanup());

  test("magic-link sign-in works while the provider is enabled", async () => {
    const res = await requestMagicLink(h, "user@example.test");
    expect(res.status).toBe(200);
  });

  test("disabling magic-link in admin blocks the sign-in endpoint", async () => {
    expect((await setMagicEnabled(h, false)).status).toBe(200);
    const res = await requestMagicLink(h, "user@example.test");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("FORBIDDEN");
  });

  test("the magic-link verify endpoint is gated too", async () => {
    await setMagicEnabled(h, false);
    // A would-be verify (token irrelevant — the gate fires before better-auth
    // looks at it).
    const res = await h.fetch(
      "/api/auth/magic-link/verify?token=whatever&callbackURL=%2F",
    );
    expect(res.status).toBe(403);
  });

  test("re-enabling restores the endpoint", async () => {
    await setMagicEnabled(h, false);
    expect((await requestMagicLink(h, "user@example.test")).status).toBe(403);
    await setMagicEnabled(h, true);
    expect((await requestMagicLink(h, "user@example.test")).status).toBe(200);
  });

  test("password sign-in is unaffected by the magic-link toggle", async () => {
    await setMagicEnabled(h, false);
    // The admin seeded above can still sign in with email/password.
    const res = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: (await sessionEmail(h)) ?? "",
        password: "correct-horse-battery",
      }),
    });
    expect(res.status).toBeLessThan(400);
  });
});

const sessionEmail = async (h: TestHarness): Promise<string | null> => {
  const res = await h.fetch("/api/auth/get-session");
  if (!res.ok) return null;
  const body = (await res.json()) as
    | { user?: { email?: string } }
    | { data?: { user?: { email?: string } } };
  const user =
    (body as { user?: { email?: string } }).user ??
    (body as { data?: { user?: { email?: string } } }).data?.user ??
    null;
  return user?.email ?? null;
};
