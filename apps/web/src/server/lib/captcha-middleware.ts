/**
 * The captcha gate, in front of better-auth's own router.
 *
 * It sits where `authLockoutMiddleware` sits, and for the same reason:
 * better-auth owns the sign-up / sign-in / password-reset endpoints, so the
 * only place to require something of a caller BEFORE those run is in front of
 * them.
 *
 * Which paths map to which target is a table rather than a regex per call
 * site, because the mapping is the part an operator reasons about: they turn on
 * "sign-up" and expect every way of signing up to be covered — including the
 * magic-link and OTP flows, which create a user just as surely as a password
 * sign-up does.
 *
 * The check runs BEFORE `next()` and refuses by throwing, so a failed captcha
 * costs nothing downstream: no rate-limit budget, no lockout counter, no row.
 */
import type { MiddlewareHandler } from "hono";
import { isAppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { findTenantBySlugOrId } from "../services/tenant-auth";
import { enforceCaptcha, type CaptchaTarget } from "../services/captcha";

/**
 * `/api/t/<slug>/auth/<rest>` → the captcha target it counts as, or null.
 *
 * `sign-up/email`, the magic link and the email OTP all end with a user
 * existing who did not before, so all three are "sign-up". `forget-password`
 * and `request-password-reset` both send mail to somebody who did not ask for
 * it, which is the cost a captcha is there to stop somebody else incurring.
 */
const TARGET_BY_SUFFIX: Array<[RegExp, CaptchaTarget]> = [
  [/^sign-up\//i, "sign-up"],
  [/^sign-in\/magic-link/i, "sign-up"],
  [/^sign-in\/email-otp/i, "sign-up"],
  [/^email-otp\/send-verification-otp/i, "sign-up"],
  [/^magic-link\//i, "sign-up"],
  [/^sign-in\/email/i, "sign-in"],
  [/^(forget-password|request-password-reset)/i, "password-reset"],
];

const TENANT_AUTH = /^\/api\/t\/([^/]+)\/auth\/(.+)$/i;

import { type ClientAddressEnv, clientAddress } from "./client-address";
const ipOf = (req: Request, env: ClientAddressEnv): string | null =>
  clientAddress(req, env);

export const captchaMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.req.method !== "POST") return next();
  const url = new URL(c.req.raw.url);
  const m = TENANT_AUTH.exec(url.pathname);
  if (!m) return next();
  const suffix = m[2]!;
  const entry = TARGET_BY_SUFFIX.find(([re]) => re.test(suffix));
  if (!entry) return next();

  const ctx = c.get("ctx");
  const tenant = await findTenantBySlugOrId(
    { db: ctx.db, dialect: ctx.dialect },
    m[1]!,
  );
  if (!tenant) return next();

  // The token rides a header so it does not have to be threaded through
  // better-auth's own body schema — which would reject an unknown property on
  // some endpoints and silently ignore it on others.
  const header = c.req.header("x-captcha-token") ?? null;
  let token = header;
  if (!token) {
    // A plain HTML form post has no other way to carry it. Reading the body
    // here means cloning the request, so it only happens when the header is
    // absent AND this path is actually gated.
    try {
      const body = (await c.req.raw.clone().json()) as Record<string, unknown> | null;
      const fromBody = body?.captchaToken;
      if (typeof fromBody === "string") token = fromBody;
    } catch {
      // Not JSON, or already consumed — treated as no token, which the gate
      // then refuses. Silently passing here would make an unparseable body a
      // way around the captcha.
    }
  }

  try {
    await enforceCaptcha(ctx, tenant.id, entry[1], token, ipOf(c.req.raw, ctx.env));
  } catch (e) {
    if (isAppError(e)) throw e;
    // A bug in the gate must not become an open door.
    throw e;
  }
  return next();
};
