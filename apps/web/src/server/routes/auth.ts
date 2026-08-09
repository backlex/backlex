import { Hono } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { disabledAuthProviderForPath, passwordLoginBlocked } from "../services/auth-config";

/**
 * better-auth ships its own router. We mount it at /api/auth/* and let it
 * own everything from /sign-in to /callback/:provider.
 *
 * Before delegating, we honour the admin's per-provider "enabled" toggle for
 * magic-link / email-OTP: the control-plane better-auth instance loads its
 * plugin set once per isolate from env and is never rebuilt, so a toggled-off
 * provider's endpoint would otherwise still work. `disabledAuthProviderForPath`
 * only touches the DB for those gated paths — every other auth call passes
 * straight through.
 */
export const authRoutes = new Hono<AppBindings>().all("/*", async (c) => {
  const ctx = c.get("ctx");
  // Read the toggle against the same scope the discovery surface uses
  // (`auth.tenantId ?? null` → the active workspace row, falling back to the
  // instance-global `_global` row), so a provider disabled in admin actually
  // blocks here too.
  const tenantId = c.get("auth")?.tenantId ?? null;
  const disabled = await disabledAuthProviderForPath(ctx, tenantId, c.req.path);
  if (disabled) {
    throw new AppError(
      "FORBIDDEN",
      `${disabled === "magic" ? "Magic-link" : "Email-code"} sign-in is disabled for this instance.`,
    );
  }
  // Same shape, for the instance-global password-login mode. This is the
  // control plane, so `app-only` blocks here and leaves the workspace plane's
  // own mount (routes/tenant-auth.ts) alone.
  const passwordBlocked = await passwordLoginBlocked(ctx, c.req.path, "platform");
  if (passwordBlocked) throw new AppError("FORBIDDEN", passwordBlocked);
  return ctx.auth.handler(c.req.raw);
});
