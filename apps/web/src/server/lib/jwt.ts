/**
 * Stateless access tokens (HS256 JWT) for workspace end-user ("app" plane)
 * sessions.
 *
 * The DB-backed `app_sessions` row stays the long-lived, revocable *refresh*
 * token; this JWT is the short-lived *access* token a native/mobile client
 * sends on every request so the hot path skips the `app_sessions` lookup.
 *
 * Hand-rolled on Web Crypto (HMAC-SHA256) — no dependency, identical on
 * Workers, Bun, Vercel and Netlify. Keyed off `AUTH_SECRET`, the same secret
 * better-auth and `lib/crypto` already use.
 */

/** Access-token lifetime. Short on purpose — revoking the refresh token
 *  (deleting the `app_sessions` row) takes full effect within this window. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AccessTokenClaims {
  /** app_user id */
  sub: string;
  /** tenant id the session is pinned to */
  tid: string;
  /** auth plane — always "app" for these tokens */
  plane: "app";
  /** id of the `app_sessions` row backing this token (its refresh token) */
  sid: string;
  /** end-user email, embedded so the middleware needs no DB lookup */
  email: string | null;
  /** token-type discriminator */
  typ: "access";
  /** issued-at (epoch seconds) */
  iat: number;
  /** expiry (epoch seconds) */
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const base64urlFromBytes = (bytes: Uint8Array): string => {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const base64urlToBytes = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const base64urlFromString = (s: string): string =>
  base64urlFromBytes(enc.encode(s));

// `crypto.subtle` parameters are typed as `BufferSource`, but the strict lib
// types distinguish `ArrayBuffer` from `ArrayBufferLike`; this cast papers
// over that without copying (same shim as `lib/crypto.ts`).
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

// Single-entry key cache — there is only ever one AUTH_SECRET, and this runs
// on every bearer-authenticated request.
let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

const importKey = (secret: string): Promise<CryptoKey> => {
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key;
  const key = crypto.subtle.importKey(
    "raw",
    buf(enc.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  cachedKey = { secret, key };
  return key;
};

const HEADER = base64urlFromString(JSON.stringify({ alg: "HS256", typ: "JWT" }));

/** Mint an access token for a workspace end-user session. */
export const signAccessToken = async (
  secret: string,
  claims: { sub: string; tid: string; sid: string; email: string | null },
  expiresInSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
): Promise<{ token: string; expiresIn: number; expiresAt: number }> => {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expiresInSeconds;
  const payload: AccessTokenClaims = {
    sub: claims.sub,
    tid: claims.tid,
    plane: "app",
    sid: claims.sid,
    email: claims.email,
    typ: "access",
    iat,
    exp,
  };
  const body = `${HEADER}.${base64urlFromString(JSON.stringify(payload))}`;
  const key = await importKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, buf(enc.encode(body))),
  );
  return {
    token: `${body}.${base64urlFromBytes(sig)}`,
    expiresIn: expiresInSeconds,
    expiresAt: exp * 1000,
  };
};

/**
 * Verify + decode an access token. Returns the claims on success, or `null`
 * for anything that isn't a valid, unexpired workeros app access token —
 * wrong signature, malformed, expired, or simply not a JWT at all (an opaque
 * `app_…` refresh token or a `pak_…` API key both land here). Never throws,
 * so callers can use it as a cheap "is this one of ours?" probe.
 */
export const verifyAccessToken = async (
  secret: string,
  token: string,
): Promise<AccessTokenClaims | null> => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];
  try {
    const key = await importKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      buf(base64urlToBytes(sigPart)),
      buf(enc.encode(`${headerPart}.${payloadPart}`)),
    );
    if (!ok) return null;
    const claims = JSON.parse(
      dec.decode(base64urlToBytes(payloadPart)),
    ) as AccessTokenClaims;
    if (claims.typ !== "access" || claims.plane !== "app") return null;
    if (!claims.sub || !claims.tid) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
};
