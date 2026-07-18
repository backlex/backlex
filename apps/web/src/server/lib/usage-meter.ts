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

  if (!tenantId) return;
  const status = c.res.status;
  if (status === 429) return; // throttled/over-quota responses aren't billed
  bumpUsage(
    ctx,
    { tenantId, apiKeyId: auth.apiKeyId ?? "", error: status >= 500 },
    (work) => {
      try {
        c.executionCtx?.waitUntil?.(work);
      } catch {
        void work; // no ExecutionContext (Bun/Vercel/Netlify) — fire and forget
      }
    },
  );
};
