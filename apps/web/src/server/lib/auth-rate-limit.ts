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
import { AppError } from "@backlex/core";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { Env } from "../env";
import { rateLimitOk } from "./rate-limit";
import {
  checkLocked,
  clearFailures,
  lockoutEnabled,
  lockoutPolicy,
  recordFailure,
} from "./auth-lockout";
import type { LockPolicy } from "./lockout-core";
import { recordActivity } from "../services/activity";

import { type ClientAddressEnv, clientAddressKey } from "./client-address";
const WINDOW_MS = 60_000;

const ipFromHeaders = (req: Request, env: ClientAddressEnv): string =>
  clientAddressKey(req, env);

const userAgentOf = (req: Request): string | null => req.headers.get("user-agent");

type AuditCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };

/** Best-effort security-audit row. Swallows its own errors (recordActivity
 *  already does) so an abuse event is never able to fail the request path. */
const auditAuth = async (
  ctx: AuditCtx,
  action: string,
  meta: { ip: string; userAgent: string | null; tenantId?: string | null; payload?: unknown },
): Promise<void> => {
  try {
    await recordActivity(ctx, {
      userId: null,
      tenantId: meta.tenantId ?? null,
      action, // already dotted (e.g. "auth.rate_limited") → kept verbatim
      collection: "auth",
      ip: meta.ip,
      userAgent: meta.userAgent,
      payload: meta.payload ?? null,
    });
  } catch {
    /* never let auditing break auth */
  }
};

/**
 * How much wider the account-wide lock is than the per-source one.
 *
 * Sized so a single source under its own narrow lock can never reach it — see
 * the arithmetic in the middleware below. Raising `maxFails` raises both, which
 * keeps the relationship intact.
 */
const WIDE_FAIL_FACTOR = 5;
const WIDE_WINDOW_FACTOR = 2;

/** Workspace slug for `/api/t/<slug>/auth/...`, else `_` for the admin plane.
 *  Keeps the same email in different workspaces in separate lockout buckets. */
const planeScope = (path: string): string => path.match(/^\/api\/t\/([^/]+)\//)?.[1] ?? "_";

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
  // Token refresh + SAML ACS were previously unthrottled. The opaque refresh
  // token is high-entropy (guessing is infeasible), so the cap is a
  // replay-pump / resource-abuse guard rather than anti-brute-force — kept
  // generous so shared-NAT app clients refreshing every ~15 min aren't hit.
  { match: /\/token\/refresh(\/|$)/i, max: 60, label: "token-refresh" },
  { match: /\/saml\/[^/]+\/acs(\/|$)/i, max: 20, label: "saml-acs" },
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
  const ip = ipFromHeaders(c.req.raw, c.get("ctx").env);
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
    // Surface the trip in the audit log so admins can see brute-force probing
    // (the Activity feed's `auth.*` rows). Best-effort, never blocks the 429.
    const dbc = ctx as unknown as AuditCtx | undefined;
    if (dbc?.db) {
      await auditAuth(dbc, "auth.rate_limited", {
        ip,
        userAgent: userAgentOf(c.req.raw),
        payload: { rule: rule.label, path },
      });
    }
    throw new AppError(
      "RATE_LIMITED",
      "Too many auth requests — try again in a minute",
    );
  }
  await next();
};

/**
 * Failed-login account lockout — the per-account complement to the per-IP
 * limiter above. Tracks failed password attempts for one identifier *across all
 * IPs* and temporarily locks it after too many (so a distributed brute force
 * that rotates IPs against one account is still throttled). A successful sign-in
 * clears the counter; thresholds are env-tunable (`AUTH_LOCKOUT_*`).
 *
 * Only `/sign-in/email` (password auth) is gated — OAuth / magic-link / OTP have
 * no password to brute-force. The identifier is the request's `email`; absent it
 * we no-op and leave the IP limiter as the only guard.
 */
const SIGNIN_EMAIL = /\/sign-in\/email(\/|$)/i;

export const authLockoutMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.method.toUpperCase() !== "POST") {
    await next();
    return;
  }
  const path = new URL(c.req.url).pathname;
  if (!SIGNIN_EMAIL.test(path)) {
    await next();
    return;
  }
  const ctx = c.get("ctx") as { env: Env; db?: PgDb | SqliteDb; dialect?: "pg" | "sqlite" } | undefined;
  const env = ctx?.env;
  if (!env || !lockoutEnabled(env)) {
    await next();
    return;
  }

  // Read the identifier from a *clone* so better-auth still gets the body.
  let email: string | undefined;
  try {
    const body = (await c.req.raw.clone().json()) as { email?: unknown };
    if (typeof body.email === "string" && body.email.trim()) {
      email = body.email.trim().toLowerCase();
    }
  } catch {
    /* unparsable body — let better-auth reject it; nothing to key on */
  }
  if (!email) {
    await next();
    return;
  }

  const audit = ctx?.db && ctx?.dialect ? ({ db: ctx.db, dialect: ctx.dialect } as AuditCtx) : null;
  const ip = ipFromHeaders(c.req.raw, c.get("ctx").env);

  // TWO locks, because one of them was a denial-of-service primitive.
  //
  // The lock used to be keyed on the victim's EMAIL alone and it blocked every
  // source, including the victim's own. Eight wrong passwords — under the
  // per-IP sign-in cap, so no address rotation was even needed — shut the
  // account, and because `cycles` never decayed the cooldown pinned at its
  // 15-minute ceiling. An attacker who knew `admin@example.com` held it shut
  // forever at eight requests every fifteen minutes.
  //
  //  · The NARROW lock is per (account, source). It is the one that stops
  //    credential stuffing, and it cannot deny the real owner, who is not the
  //    source doing the guessing.
  //  · The WIDE lock is the old account-wide one, kept for a genuinely
  //    DISTRIBUTED attack — but at a far higher threshold and a longer window.
  //    The arithmetic is what makes the fix hold: a source under its own narrow
  //    lock is refused BEFORE `next()`, so it produces no further 401s and adds
  //    nothing to the wide count while locked. Once its cooldown pins at 15
  //    minutes it can contribute at most `maxFails` per wide window, so one
  //    source can never reach `WIDE_FAIL_FACTOR × maxFails`. Many sources can,
  //    which is exactly the case the wide lock is for.
  const scope = planeScope(path);
  const key = `signin:${scope}:${email}`;
  // A deployment that names no trusted proxy derives no address, and every
  // caller then shares the `unknown` bucket — which is the OLD behaviour, one
  // account-wide lock, and no worse than it: the wide lock is now five times
  // wider, so the account is HARDER to shut than before even in that case.
  // Where an address is derivable this is per-source, which is the fix.
  const sourceKey = `signin:${scope}:${email}:${ip ?? "unknown"}`;
  const policy = lockoutPolicy(env);
  const widePolicy: LockPolicy = {
    ...policy,
    maxFails: policy.maxFails * WIDE_FAIL_FACTOR,
    windowMs: policy.windowMs * WIDE_WINDOW_FACTOR,
  };

  const [sourceLocked, locked] = await Promise.all([
    checkLocked(env, sourceKey),
    checkLocked(env, key),
  ]);
  const active = sourceLocked.locked ? sourceLocked : locked;
  if (active.locked) {
    throw new AppError(
      "RATE_LIMITED",
      `Too many failed sign-in attempts — try again in ${Math.ceil(active.retryAfterMs / 1000)}s`,
    );
  }

  await next();

  // Inspect the outcome. 200 = success → clear. 401 = invalid credentials →
  // count. We deliberately ignore 403 (e.g. EMAIL_NOT_VERIFIED) and 4xx
  // validation so a known-good account isn't locked for a non-credential error.
  const status = c.res.status;
  if (status === 200) {
    // A success clears BOTH — the source proved it holds the credential, and
    // the account is demonstrably not under a successful attack.
    await Promise.all([clearFailures(env, sourceKey), clearFailures(env, key)]);
  } else if (status === 401) {
    const [source, account] = await Promise.all([
      recordFailure(env, sourceKey, policy),
      recordFailure(env, key, widePolicy),
    ]);
    // Audited on either edge, and the payload says WHICH — an operator reading
    // `auth.login_locked` needs to know whether one source was shut out or the
    // account was, because only the second is a reason to call the owner.
    for (const [r, kind] of [
      [source, "source"],
      [account, "account"],
    ] as const) {
      if (r.justLocked && audit) {
        await auditAuth(audit, "auth.login_locked", {
          ip,
          userAgent: userAgentOf(c.req.raw),
          payload: { identifier: email, retryAfterMs: r.retryAfterMs, lock: kind },
        });
      }
    }
  }
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
  const ctx = c.get("ctx") as { env?: Env } | undefined;
  const env = ctx?.env;
  // Derived from the same env the limiter backend is chosen with, so a route
  // that reaches this helper cannot end up keyed differently from the
  // middleware above.
  const ip = ipFromHeaders(c.req.raw, env ?? {});
  const key = `${label}:${ip}`;
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
