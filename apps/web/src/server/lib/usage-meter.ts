/**
 * Usage meter for the `/api/*` data surface — the enforcement + counting
 * companion to the ledger in `services/usage.ts`.
 *
 * Runs after session + tenant resolution (so the workspace and API key are
 * known) and after the global rate limiter (so 429-throttled requests never
 * reach it and are never billed). Two jobs, in order:
 *
 *   1. **Enforce** (pre-handler): a key's `monthly_quota` and — for machine /
 *      end-user traffic under `mode: "hard"` — the workspace's
 *      `maxRequestsPerMonth` are checked against the ledger's cached monthly
 *      sum. Over budget → 429 QUOTA_EXCEEDED. Platform admin sessions are
 *      deliberately EXEMPT from the workspace request cap so an over-quota
 *      workspace can never lock its own admin out of the panel that raises
 *      the limit (the per-key quota still applies to admin-owned keys —
 *      that's explicit per-key config).
 *
 *   2. **Count** (post-handler): every metered response bumps the buffered
 *      ledger — requests always, `errors` when the status is 5xx. 429s are
 *      excluded: a client being throttled must not burn its own quota.
 *
 * Auth endpoints are skipped entirely (mirrors the global limiter): they run
 *  before a tenant exists and have their own dedicated limiter.
 */
import type { MiddlewareHandler } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import {
  bumpUsage,
  effectiveUsageLimits,
  monthUsage,
} from "../services/usage";

const isAuthPath = (path: string): boolean =>
  path.startsWith("/api/auth/") || /^\/api\/t\/[^/]+\/auth\//.test(path);

/**
 * Attribute the current request to a workspace that only the handler could
 * resolve — the owner of a webhook-triggered flow, a dashboard embed token, a
 * public form. Call it as soon as the owning row is loaded; the middleware
 * reads it after `next()` and bills the response.
 *
 * Unauthenticated requests reach `tenantMiddleware` with nothing to resolve, so
 * they fall back to the DEFAULT workspace. On a single-workspace instance that
 * is accidentally correct; on a multi-workspace one every public hit was billed
 * to the wrong tenant, and the owning workspace's monthly request cap was never
 * consulted — so its public surfaces sat outside its own quota.
 */
export const setMeterTenant = (
  c: Parameters<MiddlewareHandler<AppBindings>>[0],
  tenantId: string | null | undefined,
): void => {
  if (tenantId) c.set("meterTenantId", tenantId);
};

/**
 * Enforce the workspace's hard monthly request cap for traffic the middleware
 * couldn't gate up front (public surfaces, where the tenant is only known once
 * the handler has resolved it). Call before doing the expensive work.
 *
 * Mirrors the `machineTraffic` arm of the middleware: unauthenticated callers
 * are never platform admins, so there's no admin exemption to honour here.
 */
export const assertWorkspaceRequestQuota = async (
  ctx: Parameters<typeof effectiveUsageLimits>[0] & { env: Parameters<typeof effectiveUsageLimits>[1] },
  tenantId: string,
): Promise<void> => {
  const limits = await effectiveUsageLimits(ctx, ctx.env, tenantId);
  if (limits.mode !== "hard" || limits.maxRequestsPerMonth == null) return;
  const used = await monthUsage(ctx, tenantId, null);
  if (used >= limits.maxRequestsPerMonth) {
    throw new AppError("QUOTA_EXCEEDED", "Workspace monthly request limit reached", {
      scope: "workspace",
      limit: limits.maxRequestsPerMonth,
      used,
    });
  }
};

export const usageMeterMiddleware: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  const ctx = c.get("ctx");
  const path = new URL(c.req.url).pathname;
  if (!ctx || isAuthPath(path)) {
    await next();
    return;
  }
  const auth = c.get("auth");
  const tenantId = auth?.tenantId ?? auth?.apiKeyTenantId ?? null;

  if (tenantId) {
    // Per-key monthly quota — explicit config on the key row, so it applies
    // to every caller of that key, admin-owned or not.
    if (
      auth.apiKeyId &&
      auth.apiKeyMonthlyQuota != null &&
      auth.apiKeyMonthlyQuota > 0
    ) {
      const used = await monthUsage(ctx, tenantId, auth.apiKeyId);
      if (used >= auth.apiKeyMonthlyQuota) {
        throw new AppError(
          "QUOTA_EXCEEDED",
          "API key monthly quota exhausted — resets next month, or raise the key's quota",
          { scope: "apiKey", quota: auth.apiKeyMonthlyQuota, used },
        );
      }
    }
    // Workspace request cap — hard mode only, and only for machine (API key)
    // and end-user (app plane) traffic; see module doc for the admin exemption.
    const machineTraffic = Boolean(auth.apiKeyId) || auth.plane === "app";
    if (machineTraffic) {
      const limits = await effectiveUsageLimits(ctx, ctx.env, tenantId);
      if (limits.mode === "hard" && limits.maxRequestsPerMonth != null) {
        const used = await monthUsage(ctx, tenantId, null);
        if (used >= limits.maxRequestsPerMonth) {
          throw new AppError(
            "QUOTA_EXCEEDED",
            "Workspace monthly request limit reached",
            { scope: "workspace", limit: limits.maxRequestsPerMonth, used },
          );
        }
      }
    }
  }

  await next();

  // Public (unauthenticated) routes carry no identity, so `tenantMiddleware`
  // hands them the DEFAULT workspace — not the one that owns the flow / embed
  // token / form the request actually targets. On a multi-workspace instance
  // that billed the wrong tenant and left the owner's monthly cap unenforced.
  // The handler resolves the true owner and publishes it via `setMeterTenant`;
  // it wins here precisely when there is no authenticated identity to trust.
  const anonymous = !auth?.userId && !auth?.apiKeyId;
  const ownerTenantId = c.get("meterTenantId") ?? null;
  const billedTenantId = (anonymous ? (ownerTenantId ?? tenantId) : tenantId) ?? null;
  if (!billedTenantId) return;
  const status = c.res.status;
  if (status === 429) return; // throttled/over-quota responses aren't billed
  bumpUsage(
    ctx,
    { tenantId: billedTenantId, apiKeyId: auth?.apiKeyId ?? "", error: status >= 500 },
    (work) => {
      try {
        c.executionCtx?.waitUntil?.(work);
      } catch {
        void work; // no ExecutionContext (Bun/Vercel/Netlify) — fire and forget
      }
    },
  );
};
