/**
 * Mint a control-plane (admin / "platform" plane) better-auth session for a
 * given `users` row and emit the signed session cookie — the bridge that lets a
 * custom SSO route (SAML ACS / LDAP sign-in) log an operator into the dashboard
 * without going through better-auth's own email/password endpoint.
 *
 * Why hand-built: better-auth exposes no "sign in this userId" server API. The
 * supported pieces are:
 *   - `auth.$context.internalAdapter.createSession(userId, …)` inserts the
 *     `sessions` row exactly as better-auth would (token = `generateId(32)`,
 *     expiry from the session config), so sign-out / expiry / cookie-cache all
 *     keep working.
 *   - the session cookie is a SIGNED cookie: value = `encodeURIComponent(
 *     `${token}.${base64(HMAC_SHA256(token, AUTH_SECRET))}`)`, read back by
 *     better-auth's `getSignedCookie` (which `parseCookies`→decodeURIComponent's
 *     then splits on the last `.`). We reproduce that exact format here so
 *     `ctx.auth.api.getSession()` (used by sessionMiddleware) accepts it.
 *
 * Verified against better-auth 1.6.9 / better-call 1.3.5 — see better-call's
 * dist crypto.mjs (makeSignature/signCookieValue) and cookies.mjs (parse).
 */
import type { Context } from "hono";
import type { AppBindings } from "../app";

/** First client IP from the usual proxy headers (mirrors tenant-auth). */
export const extractIp = (req: Request): string | null => {
  const h = req.headers;
  return (
    h.get("cf-connecting-ip") ||
    h.get("x-real-ip") ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
};

/** base64(HMAC-SHA256(value, secret)) — better-call's `makeSignature`. */
const makeSignature = async (value: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
};

type CookieAttributes = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none" | string;
  path?: string;
  domain?: string;
  maxAge?: number;
  partitioned?: boolean;
};

/** Mirror of better-call's `_serialize` for the attributes we emit. The value
 *  is already `encodeURIComponent`-encoded by the caller (signed-cookie path),
 *  so this never re-encodes it. */
const serialize = (name: string, value: string, opt: CookieAttributes): string => {
  let cookie = `${name}=${value}`;
  let secure = opt.secure ?? false;
  if (name.startsWith("__Secure-") || name.startsWith("__Host-")) secure = true;
  if (typeof opt.maxAge === "number" && opt.maxAge >= 0) {
    cookie += `; Max-Age=${Math.floor(opt.maxAge)}`;
  }
  if (opt.domain) cookie += `; Domain=${opt.domain}`;
  if (opt.path) cookie += `; Path=${opt.path}`;
  if (opt.httpOnly) cookie += "; HttpOnly";
  if (secure) cookie += "; Secure";
  if (opt.sameSite) {
    cookie += `; SameSite=${opt.sameSite.charAt(0).toUpperCase()}${opt.sameSite.slice(1)}`;
  }
  if (opt.partitioned) cookie += "; Partitioned";
  return cookie;
};

export interface MintedPlatformSession {
  token: string;
  expiresAt: Date;
}

/**
 * Create a platform session for `userId` and append its signed Set-Cookie to
 * the response on `c`. Caller then redirects (SAML) or returns JSON (LDAP);
 * the cookie is what authenticates subsequent dashboard requests.
 */
export const mintPlatformSession = async (
  c: Context<AppBindings>,
  userId: string,
): Promise<MintedPlatformSession> => {
  const { auth } = c.get("ctx");
  // `$context` / internalAdapter aren't on the narrow public Auth type but are
  // part of the better-auth runtime surface (verified in node_modules).
  const authCtx = (await (auth as unknown as { $context: Promise<unknown> })
    .$context) as {
    secret: string;
    authCookies: {
      sessionToken: { name: string; attributes: CookieAttributes };
      sessionData: { name: string; attributes: CookieAttributes };
    };
    internalAdapter: {
      createSession: (
        userId: string,
        dontRememberMe?: boolean,
        override?: Record<string, unknown>,
      ) => Promise<{ token: string; expiresAt: Date }>;
    };
  };

  const ip = extractIp(c.req.raw);
  const ua = c.req.raw.headers.get("user-agent");
  const session = await authCtx.internalAdapter.createSession(userId, false, {
    ipAddress: ip ?? "",
    userAgent: ua ?? "",
  });

  const { name, attributes } = authCtx.authCookies.sessionToken;
  const signed = encodeURIComponent(
    `${session.token}.${await makeSignature(session.token, authCtx.secret)}`,
  );
  c.header("set-cookie", serialize(name, signed, attributes), { append: true });

  // Expire any stale `session_data` cache cookie (better-auth's cookieCache).
  // Without this, a request that already carried someone else's cached session
  // (e.g. switching accounts) would be resolved from the cache instead of the
  // freshly-minted session_token. Clearing it forces the DB lookup that picks
  // up the new session.
  const sd = authCtx.authCookies.sessionData;
  c.header("set-cookie", serialize(sd.name, "", { ...sd.attributes, maxAge: 0 }), {
    append: true,
  });

  return { token: session.token, expiresAt: session.expiresAt };
};
