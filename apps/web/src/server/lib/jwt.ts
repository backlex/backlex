/**
 * Stateless access tokens for workspace end-user ("app" plane) sessions.
 *
 * The DB-backed `app_sessions` row stays the long-lived, revocable *refresh*
 * token; this JWT is the short-lived *access* token a native/mobile client
 * sends on every request so the hot path skips the `app_sessions` lookup.
 *
 * Two signature modes, chosen by config:
 *  - **HS256** (default) — keyed off `AUTH_SECRET`, the same secret better-auth
 *    and `lib/crypto` already use. Only this server can verify.
 *  - **ES256 / RS256** — when `AUTH_JWT_PRIVATE_KEY` is set (see `jwt-keys.ts`).
 *    The public half is published at `/.well-known/jwks.json`, so any other
 *    service can verify a backlex token locally without holding a secret that
 *    would also let it mint one.
 *
 * Verification accepts both, always dispatching on the token's own `alg` header
 * against the matching key type — a public key is never fed to HMAC (the classic
 * algorithm-confusion forgery). HS256 stays live regardless because the internal
 * agent-run token below is symmetric by design.
 *
 * Hand-rolled on Web Crypto — no dependency, identical on Workers, Bun, Vercel
 * and Netlify.
 */

import { algParams, type JwtKeyEnv, jwtKeyMaterial } from "./jwt-keys";

/** Access-token lifetime. Short on purpose — revoking the refresh token
 *  (deleting the `app_sessions` row) takes full effect within this window. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** The env an access token is minted from / verified against. */
export type JwtEnv = { AUTH_SECRET: string; APP_URL?: string } & JwtKeyEnv;

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
  /** issuing instance (`APP_URL`), so an external verifier can pin the issuer.
   *  Omitted when `APP_URL` isn't configured. */
  iss?: string;
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

/** Mint an access token for a workspace end-user session. Signed with the
 *  configured key pair when there is one, otherwise HS256 off `AUTH_SECRET`. */
export const signAccessToken = async (
  env: JwtEnv,
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
    ...(env.APP_URL ? { iss: env.APP_URL } : {}),
    iat,
    exp,
  };
  const { signing } = await jwtKeyMaterial(env);
  const header = signing
    ? base64urlFromString(
        JSON.stringify({ alg: signing.alg, typ: "JWT", kid: signing.kid }),
      )
    : HEADER;
  const body = `${header}.${base64urlFromString(JSON.stringify(payload))}`;
  const signed = buf(enc.encode(body));
  const sig = new Uint8Array(
    signing
      ? await crypto.subtle.sign(algParams(signing.alg), signing.key, signed)
      : await crypto.subtle.sign("HMAC", await importKey(env.AUTH_SECRET), signed),
  );
  return {
    token: `${body}.${base64urlFromBytes(sig)}`,
    expiresIn: expiresInSeconds,
    expiresAt: exp * 1000,
  };
};

// ── detached agent runs ───────────────────────────────────────────────────

/**
 * Identity for an agent turn that runs **outside** the request that asked for
 * it (the async room path — see `services/agents/runner`).
 *
 * A detached turn still has to call tools as the person who triggered it: the
 * whole promise of the agent framework is that "an agent can only ever do what
 * the caller could do". `makeInternalFetch` forwards the live request's cookie,
 * which a background run doesn't have, and running as a system identity would
 * quietly ESCALATE the agent past its caller.
 *
 * So the job carries the enqueuer's user id and the worker mints one of these
 * to re-enter the API with. Deliberately narrow:
 *  - short-lived, and never returned to a client — it exists only in memory
 *    between the worker and the in-process sub-fetch;
 *  - it carries **no roles**. Roles are re-resolved from the DB by the tenant
 *    middleware on every sub-request, so a user suspended (or demoted) while
 *    their turn is still running loses access mid-flight.
 */
export const AGENT_RUN_TOKEN_TTL_SECONDS = 15 * 60;

export interface AgentRunTokenClaims {
  /** platform-plane user the turn runs as */
  sub: string;
  /** tenant the run is pinned to */
  tid: string;
  /** the `agent_runs` row this token was minted for */
  rid: string;
  typ: "agent_run";
  iat: number;
  exp: number;
}

export const signAgentRunToken = async (
  secret: string,
  claims: { sub: string; tid: string; rid: string },
  expiresInSeconds: number = AGENT_RUN_TOKEN_TTL_SECONDS,
): Promise<string> => {
  const iat = Math.floor(Date.now() / 1000);
  const payload: AgentRunTokenClaims = {
    sub: claims.sub,
    tid: claims.tid,
    rid: claims.rid,
    typ: "agent_run",
    iat,
    exp: iat + expiresInSeconds,
  };
  const body = `${HEADER}.${base64urlFromString(JSON.stringify(payload))}`;
  const key = await importKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, buf(enc.encode(body))),
  );
  return `${body}.${base64urlFromBytes(sig)}`;
};

/** Verify a detached-run token. Same never-throws contract as
 *  `verifyAccessToken`: anything that isn't a live agent-run token is `null`. */
export const verifyAgentRunToken = async (
  secret: string,
  token: string,
): Promise<AgentRunTokenClaims | null> => {
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
    ) as AgentRunTokenClaims;
    if (claims.typ !== "agent_run") return null;
    if (!claims.sub || !claims.tid || !claims.rid) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
};

/**
 * Verify + decode an access token. Returns the claims on success, or `null`
 * for anything that isn't a valid, unexpired backlex app access token —
 * wrong signature, malformed, expired, or simply not a JWT at all (an opaque
 * `app_…` refresh token or a `pak_…` API key both land here). Never throws,
 * so callers can use it as a cheap "is this one of ours?" probe.
 */
export const verifyAccessToken = async (
  env: JwtEnv,
  token: string,
): Promise<AccessTokenClaims | null> => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];
  try {
    const header = JSON.parse(dec.decode(base64urlToBytes(headerPart))) as {
      alg?: unknown;
      kid?: unknown;
    };
    const signed = buf(enc.encode(`${headerPart}.${payloadPart}`));
    const sig = buf(base64urlToBytes(sigPart));
    // Dispatch on the token's own `alg`, but only ever into the key type that
    // algorithm belongs to. `none`, or an asymmetric alg pointed at the HMAC
    // path, is rejected rather than "verified".
    let ok: boolean;
    if (header.alg === "HS256") {
      ok = await crypto.subtle.verify(
        "HMAC",
        await importKey(env.AUTH_SECRET),
        sig,
        signed,
      );
    } else if (header.alg === "ES256" || header.alg === "RS256") {
      if (typeof header.kid !== "string") return null;
      const entry = (await jwtKeyMaterial(env)).verify.get(header.kid);
      if (!entry || entry.alg !== header.alg) return null;
      ok = await crypto.subtle.verify(algParams(entry.alg), entry.key, sig, signed);
    } else {
      return null;
    }
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
