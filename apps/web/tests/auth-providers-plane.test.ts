/**
 * The control-plane (admin) sign-in surface must NOT advertise consumer social
 * providers (Google / Apple / GitHub) even when the deployment has OAuth
 * credentials configured. Social login belongs to the workspace end-user plane
 * only — its discovery endpoint (`/api/t/:slug/auth/providers`) still lists them.
 *
 * Regression guard for the auth-plane split: the same env OAuth credentials feed
 * both planes, so the separation lives in code (resolveAuthSurface's
 * `excludeSocial` flag + the admin better-auth instance shipping no social
 * providers), not in configuration.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

type PublicProvider = { id: string; kind: string; enabled: boolean };

describe("auth provider planes", () => {
  let h: TestHarness;

  beforeEach(() => {
    // Simulate a deployment that has Google + Apple OAuth wired up.
    h = makeHarness({
      OAUTH_GOOGLE_CLIENT_ID: "google-client-id",
      OAUTH_GOOGLE_CLIENT_SECRET: "google-client-secret",
      OAUTH_APPLE_CLIENT_ID: "apple-client-id",
      OAUTH_APPLE_CLIENT_SECRET: "apple-client-secret",
    });
  });

  afterEach(() => h.cleanup());

  test("admin /api/auth/providers excludes social even when OAuth is configured", async () => {
    const res = await h.fetch("/api/auth/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { providers: PublicProvider[] } };
    const providers = body.data.providers;

    // No consumer social on the control plane.
    expect(providers.some((p) => p.kind === "social")).toBe(false);
    expect(providers.some((p) => ["google", "apple", "github"].includes(p.id))).toBe(false);

    // Email/password is still offered.
    expect(providers.some((p) => p.id === "email")).toBe(true);
  });

  test("workspace /api/t/:slug/auth/providers still lists social", async () => {
    // seedAdmin creates the admin + ensures the `default` workspace exists.
    await seedAdmin(h);
    const res = await h.fetch("/api/t/default/auth/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { providers: PublicProvider[] } };
    const providers = body.data.providers;

    // The end-user plane keeps Google (configured via the same env OAuth).
    expect(providers.some((p) => p.id === "google" && p.kind === "social")).toBe(true);
  });
});
