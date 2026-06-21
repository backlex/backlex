/**
 * Global per-identity rate limit for the `/api/*` data surface.
 *
 * The auth limiter (`auth-rate-limit.ts`) guards credential endpoints per-IP;
 * this is the complementary *global* quota that caps how fast a single tenant,
 * API key, or caller can hit the whole data API — a runaway-workload / abuse
 * guard, not an anti-brute-force one. It's deliberately generous: normal use
 * never approaches the cap; a client stuck in a retry loop (or a noisy tenant
 * on shared cloud infra) gets a 429 instead of saturating the backend.
 *
 * Backend is the same as the auth limiter — a Durable Object on Workers
 * (authoritative across isolates), an in-process Map elsewhere — via
 * `rateLimitCheck`. Every gated response carries the IETF-draft `RateLimit-*`
 * headers so well-behaved clients can back off before they're throttled.
 *
 * Enablement (see {@link apiRateLimitConfig}):
 *   - OFF by default on self-host (an operator's own API shouldn't sprout a
 *     surprise cap).
 *   - ON automatically on managed cloud (`CLOUD_PROJECT_ID` set), where a noisy
 *     tenant must not be able to starve its neighbours — mirrors how the SSRF
 *     guard auto-arms on cloud.
 *   - Force ON anywhere by setting `API_RATE_LIMIT_MAX`; force OFF with
 *     `API_RATE_LIMIT_DISABLED=true`.
 */
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import type { Env } from "../env";
import { rateLimitCheck } from "./rate-limit";

const DEFAULT_MAX = 600;
const DEFAULT_WINDOW_MS = 60_000;

const truthy = (v?: string): boolean =>
  v != null && /^(1|true|yes|on)$/i.test(v.trim());

const posIntOr = (v: string | undefined, fallback: number): number => {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export interface ApiRateLimitConfig {
  enabled: boolean;
  max: number;
  windowMs: number;
}

/** Resolve the effective config from env. Pure — easy to unit test. */
export const apiRateLimitConfig = (env: Env): ApiRateLimitConfig => {
  const explicitlySet = env.API_RATE_LIMIT_MAX != null && env.API_RATE_LIMIT_MAX !== "";
  const enabled =
    !truthy(env.API_RATE_LIMIT_DISABLED) &&
    (explicitlySet || !!env.CLOUD_PROJECT_ID);
  return {
    enabled,
    max: posIntOr(env.API_RATE_LIMIT_MAX, DEFAULT_MAX),
    windowMs: posIntOr(env.API_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS),
  };
};

const ipFromHeaders = (req: Request): string => {
  const h = req.headers;
  return (
    h.get("cf-connecting-ip") ||
    h.get("x-real-ip") ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
};

/** Limiter key: per-API-key when present (machine clients each get their own
 *  budget), else per-(tenant,user) for an admin session, else per-IP for
 *  unauthenticated traffic. Keeps one tenant/key from spending another's. */
const keyForRequest = (c: Parameters<MiddlewareHandler<AppBindings>>[0]): string => {
  let auth: AppBindings["Variables"]["auth"] | undefined;
  try {
    auth = c.get("auth");
  } catch {
    auth = undefined;
  }
  if (auth?.apiKeyId) return `api:key:${auth.apiKeyId}`;
  if (auth?.userId) return `api:user:${auth.tenantId ?? "_"}:${auth.userId}`;
  return `api:ip:${ipFromHeaders(c.req.raw)}`;
};

// The auth surface has its own dedicated, tighter limiter — don't double-count
// it under the global quota.
const isAuthPath = (path: string): boolean =>
  path.startsWith("/api/auth/") || /^\/api\/t\/[^/]+\/auth\//.test(path);

export const apiRateLimitMiddleware: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  const ctx = c.get("ctx") as { env?: Env } | undefined;
  const env = ctx?.env;
  if (!env) {
    // ctx middleware runs first in app.ts; if env is somehow missing, fail open
    // rather than 500 the whole data API.
    await next();
    return;
  }
  const cfg = apiRateLimitConfig(env);
  if (!cfg.enabled) {
    await next();
    return;
  }
  const path = new URL(c.req.url).pathname;
  if (isAuthPath(path)) {
    await next();
    return;
  }

  const r = await rateLimitCheck(env, keyForRequest(c), cfg.max, cfg.windowMs);
  const resetSec = Math.max(0, Math.ceil((r.resetAt - Date.now()) / 1000));
  // Set on every gated response so clients can self-throttle before a 429.
  c.header("RateLimit-Limit", String(r.limit));
  c.header("RateLimit-Remaining", String(r.remaining));
  c.header("RateLimit-Reset", String(resetSec));

  if (!r.allowed) {
    c.header("Retry-After", String(resetSec));
    // Returned directly (not thrown) so the RateLimit-*/Retry-After headers
    // ride the response — an AppError can't carry response headers. The body
    // mirrors the standard error envelope (+ requestId) for consistency.
    return c.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "API rate limit exceeded — slow down and retry shortly",
        },
        requestId: c.get("requestId"),
      },
      429,
    );
  }
  await next();
};
