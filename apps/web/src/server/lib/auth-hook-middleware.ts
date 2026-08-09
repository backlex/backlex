/**
 * `password-verification` — the workspace's say on a password sign-in it has
 * just seen the result of.
 *
 * This sits where `authLockoutMiddleware` sits, for the same reason: better-auth
 * owns the sign-in endpoint, so the only place to observe "did this password
 * check out" is in front of its router, reading the status it produced. 200 is
 * a pass, 401 a fail; both are reported, because an app that wants to run its
 * own impossible-travel or breach-list logic needs to hear about the failures
 * it would otherwise never see.
 *
 * ## Why a rejection has to revoke
 *
 * By the time the outcome is knowable, better-auth has already written an
 * `app_sessions` row and put its token in the response. Replacing the response
 * with a 401 while that row lives would hand out a working credential with a
 * refusal printed on it. So a `deny` verdict deletes the session row FIRST and
 * only then rewrites the response — and the token in the discarded body is
 * dead by the time the caller could copy it. The workspace end-user instance
 * has no cookie cache (unlike the platform plane), so deleting the row is the
 * whole revocation.
 *
 * Only `/api/t/<slug>/auth/sign-in/email` is gated. There is no password in an
 * OAuth, magic-link or OTP sign-in, so there is nothing for this hook to have
 * an opinion about — and the platform plane is out of scope for auth hooks
 * entirely (see `services/auth-hooks.ts`).
 */
import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { AppError, isAppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { Env } from "../env";
import { findTenantBySlugOrId } from "../services/tenant-auth";
import { loadAuthHook, runPasswordVerificationHook } from "../services/auth-hooks";

const TENANT_SIGNIN_EMAIL = /^\/api\/t\/([^/]+)\/auth\/sign-in\/email(\/|$)/i;

const ipOf = (req: Request): string | null =>
  req.headers.get("cf-connecting-ip") ||
  req.headers.get("x-real-ip") ||
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
  null;

/** Delete the `app_sessions` row a refused sign-in just created. Best-effort by
 *  necessity — but a failure here must not turn into a 200, so the caller
 *  rewrites the response regardless and this only logs. */
const revokeIssuedSession = async (
  db: PgDb | SqliteDb,
  dialect: "pg" | "sqlite",
  tenantId: string,
  token: string,
): Promise<void> => {
  const t = dialect === "pg" ? pg.schema.appSessions : sqlite.schema.appSessions;
  try {
    await (db as any).delete(t).where(and(eq(t.token, token), eq(t.tenantId, tenantId)));
  } catch (e) {
    console.error("[auth-hook] could not revoke a refused sign-in's session", e);
  }
};

/**
 * The `app_sessions.token` better-auth just issued.
 *
 * The JSON body is read FIRST because it carries the raw token — the value the
 * row is keyed on. The bearer plugin's `set-auth-token` header carries the
 * SIGNED cookie form (`<token>.<base64 signature>`), so it has to have the
 * signature stripped before it will match anything; taking it at face value is
 * a delete that quietly hits zero rows and leaves the refused credential live.
 */
const issuedTokenOf = async (res: Response): Promise<string | null> => {
  try {
    const body = (await res.clone().json()) as { token?: unknown };
    if (typeof body.token === "string" && body.token) return body.token;
  } catch {
    /* not JSON — fall through to the header */
  }
  const header = res.headers.get("set-auth-token")?.trim();
  if (!header) return null;
  // The token alphabet is alphanumeric and base64's is not `.`, so the first
  // dot is unambiguously the signature separator.
  const raw = header.split(".")[0];
  return raw || null;
};

export const passwordVerificationHookMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.method.toUpperCase() !== "POST") return next();
  const path = new URL(c.req.url).pathname;
  const slug = TENANT_SIGNIN_EMAIL.exec(path)?.[1];
  if (!slug) return next();

  const ctx = c.get("ctx") as
    | { env: Env; db?: PgDb | SqliteDb; dialect?: "pg" | "sqlite" }
    | undefined;
  if (!ctx?.db || !ctx.dialect || !ctx.env) return next();
  // The whole request `Ctx`, not a `{db, dialect, env}` slice: `AuthHookCtx` is
  // the minimum, and a function-target hook run from here gets real storage /
  // email / vector bindings because this is one of the call sites that has
  // them.
  const hookCtx = ctx as unknown as Parameters<typeof loadAuthHook>[0];

  const tenant = await findTenantBySlugOrId({ db: ctx.db, dialect: ctx.dialect }, slug);
  if (!tenant) return next();

  // Resolve the hook BEFORE running the sign-in. Not for speed — so the
  // request body can be read from a clone while it is still readable, and so
  // an instance with no hook (nearly all of them) pays one indexed lookup and
  // nothing else.
  const hook = await loadAuthHook(hookCtx, tenant.id, "password-verification");
  if (!hook) return next();

  let email: string | null = null;
  try {
    const body = (await c.req.raw.clone().json()) as { email?: unknown };
    if (typeof body.email === "string" && body.email.trim()) email = body.email.trim();
  } catch {
    /* unparsable body — better-auth will reject it; nothing to report */
  }

  await next();

  // Only a decided credential check is reported. A 422 for a malformed body or
  // a 403 for an unverified email says nothing about whether the password was
  // right, and reporting those as `valid: false` would poison an app's own
  // failure counter with events that are not failed attempts.
  const status = c.res.status;
  if (!email || (status !== 200 && status !== 401)) return;

  let verdict: { allow: boolean; reason?: string };
  try {
    verdict = await runPasswordVerificationHook(hookCtx, tenant.id, {
      email,
      valid: status === 200,
      ip: ipOf(c.req.raw),
      userAgent: c.req.raw.headers.get("user-agent"),
    });
  } catch (e) {
    // `onError: "deny"` on an unreachable hook. The password may well have
    // been correct, so any session it produced has to go before we answer.
    if (status === 200) {
      const token = await issuedTokenOf(c.res);
      if (token) await revokeIssuedSession(ctx.db, ctx.dialect, tenant.id, token);
    }
    if (isAppError(e)) throw e;
    throw new AppError("UNAVAILABLE", "Password verification hook failed");
  }

  if (verdict.allow) return;

  if (status === 200) {
    const token = await issuedTokenOf(c.res);
    if (token) await revokeIssuedSession(ctx.db, ctx.dialect, tenant.id, token);
  }
  // A fresh response, not a patched one: the original carries `set-auth-token`
  // and a session cookie for the credential we have just revoked.
  throw new AppError("UNAUTHORIZED", verdict.reason || "Sign-in refused");
};
