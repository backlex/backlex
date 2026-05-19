/**
 * Per-IP, per-minute rate limit for the sensitive better-auth subpaths.
 *
 * better-auth ships its own router (the catch-all at `/api/auth/*` and
 * `/api/t/<slug>/auth/*`); this middleware sits in front of it and gates
 * the high-blast-radius routes — sign-in, sign-up, password reset, magic
 * link, OTP — before the request ever reaches the auth handler.
 *
 * Counter backend depends on the runtime — see `rate-limit.ts`. On Workers
 * the count goes through a Durable Object so it's authoritative across
 * isolates; on Bun / Vercel / Netlify it falls back to an in-process Map.
 * Tune by adjusting the `max` field per pattern.
 */
import type { MiddlewareHandler } from "hono";
import { AppError } from "@workeros/core";
import type { Env } from "../env";
import { rateLimitOk } from "./rate-limit";

const WINDOW_MS = 60_000;

const ipFromHeaders = (req: Request): string => {
  const h = req.headers;
  return (
    h.get("cf-connecting-ip") ||
    h.get("x-real-ip") ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
};

interface Rule {
  /** Path test — runs against the full request pathname, including the
   *  /api/auth/... or /api/t/<slug>/auth/... prefix. */
  match: RegExp;
  /** Allowed POST/GET requests per WINDOW_MS, keyed by IP. */
  max: number;
  /** Identifier baked into the rate-limit key — keep distinct buckets for
   *  distinct attack shapes (so a flood of sign-up attempts doesn't
   *  inadvertently exhaust the sign-in window). */
  label: string;
}

/**
 * Patterns are checked in declaration order — first match wins. Be specific
 * (passkey/2fa challenges) before broad (`/sign-in`). When a request doesn't
 * match any rule the middleware no-ops and lets better-auth handle it as
 * before.
 */
const RULES: Rule[] = [
  // High-fan-out attacks: low cap.
  { match: /\/(sign-up|register)(\/|$)/i, max: 5, label: "signup" },
  { match: /\/(forget|forgot|reset)-password/i, max: 5, label: "pwreset" },
  { match: /\/magic-link/i, max: 5, label: "magic" },
  { match: /\/(verify-email|send-verification-email)/i, max: 5, label: "verify" },
  // Sign-in (any flavor) + OTP/2FA — slightly higher to cope with legit
  // back-and-forth on multi-step flows.
  { match: /\/two-factor|\/otp/i, max: 10, label: "twofa" },
  { match: /\/sign-in(\/|$)/i, max: 10, label: "signin" },
];

/**
 * Skip the limiter on plain GETs that better-auth uses for OAuth callback
 * redirects and discovery endpoints — those are user-initiated, not credential
 * material, and the OAuth-state cookie / CSRF token already protects them.
 * POST + DELETE flow through.
 */
const METHODS_TO_GATE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const authRateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  if (!METHODS_TO_GATE.has(c.req.method.toUpperCase())) {
    await next();
    return;
  }
  const path = new URL(c.req.url).pathname;
  const rule = RULES.find((r) => r.match.test(path));
  if (!rule) {
    await next();
    return;
  }
  const ip = ipFromHeaders(c.req.raw);
  const key = `auth:${rule.label}:${ip}`;
  // The runtime Env hangs off the per-request Ctx (built by app.ts before
  // any middleware runs). Reading it via `c.get("ctx")` keeps the limiter
  // backend selection (DO vs in-memory) decoupled from Hono's adapter quirks
  // (e.g. `c.env` is not always populated under Bun's fetch wrapper).
  const ctx = c.get("ctx") as { env: Env } | undefined;
  const env = ctx?.env;
  if (!env) {
    // Should never happen — the ctx middleware runs first in app.ts. Fail
    // open rather than crash auth flows for a misconfigured runtime.
    await next();
    return;
  }
  if (!(await rateLimitOk(env, key, rule.max, WINDOW_MS))) {
    throw new AppError(
      "RATE_LIMITED",
      "Too many auth requests — try again in a minute",
    );
  }
  await next();
};

/**
 * Per-IP guard for endpoints not part of better-auth (api-key creation,
 * email config test, etc.). Throws AppError directly so route handlers
 * don't have to repeat the boilerplate. Async because on Workers the
 * counter check hops to a Durable Object.
 *
 * Reads the runtime `Env` off `c.get("ctx").env` (set by app.ts before any
 * route runs). The argument is intentionally loosely typed so route handlers
 * can pass their Hono `Context` directly without a cast.
 */
export const enforceIpRateLimit = async (
  c: {
    req: { raw: Request };
    get: (key: "ctx") => unknown;
  },
  label: string,
  max: number,
  windowMs: number = WINDOW_MS,
): Promise<void> => {
  const ip = ipFromHeaders(c.req.raw);
  const key = `${label}:${ip}`;
  const ctx = c.get("ctx") as { env?: Env } | undefined;
  const env = ctx?.env;
  if (!env) {
    // Should be unreachable — the ctx middleware runs first in app.ts. Fail
    // open rather than crash route handlers for a misconfigured runtime.
    return;
  }
  if (!(await rateLimitOk(env, key, max, windowMs))) {
    throw new AppError(
      "RATE_LIMITED",
      "Too many requests — try again in a minute",
    );
  }
};
