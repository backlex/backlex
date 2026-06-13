/**
 * Cloud-brokered SSO — inbound handoff-token verifier (proj-worker side).
 *
 * After an operator authenticates to the backlex **cloud** control plane via
 * org-level SSO, the cloud mints a short-lived signed token and redirects the
 * browser to this project's `/api/auth/platform/sso/handoff`. This module
 * verifies that token so the route can mint a platform session — no per-project
 * IdP configuration required.
 *
 * Trust anchor: the per-project `reportSecret` the cloud generated at
 * provisioning and injected here as `CLOUD_REPORT_SECRET`. The cloud signs with
 * the same value, so a token minted for project A cannot be verified by project
 * B (different secret) — the signature is the project scoping.
 *
 * Token shape (must stay byte-identical to the cloud minter,
 * `backlex-cloud .../lib/handoff-token.ts`):
 *
 *     token = b64url(utf8(JSON.stringify(payload))) + "." + b64url(HMAC_SHA256(body, secret))
 *
 * The body is UTF-8-encoded before base64url (names/emails may carry non-Latin1
 * chars that `btoa` alone would reject); the signature is computed over the
 * base64url body STRING, so both sides agree without sharing code.
 */

export interface HandoffClaims {
  v: number;
  iss: string;
  /** Target project id — must equal this worker's CLOUD_PROJECT_ID. */
  aud: string;
  email: string;
  name?: string;
  /** Stable cloud-side identifier for the operator (used as the identity subject). */
  subject: string;
  groups?: string[];
  iat: number;
  exp: number;
  jti: string;
}

const b64urlFromBytes = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlToBytes = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const hmacB64url = async (secret: string, data: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)),
  );
  return b64urlFromBytes(sig);
};

/** Length-independent constant-time-ish string compare (avoids early-exit timing). */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Allowed clock skew (seconds) for a token minted slightly ahead of us. */
const CLOCK_SKEW_S = 60;

/**
 * Verify a cloud handoff token. Returns the claims when the signature, issuer,
 * audience, version, and expiry all check out; `null` otherwise. Pure — does no
 * DB work, so the caller owns the single-use (jti) replay check.
 */
export const verifyHandoffToken = async (
  token: string | undefined | null,
  secret: string | undefined | null,
  projectId: string | undefined | null,
): Promise<HandoffClaims | null> => {
  if (!token || !secret || !projectId) return null;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = await hmacB64url(secret, body);
  if (!timingSafeEqual(sig, expected)) return null;

  let claims: HandoffClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))) as HandoffClaims;
  } catch {
    return null;
  }

  if (claims.v !== 1) return null;
  if (claims.iss !== "backlex-cloud") return null;
  if (claims.aud !== projectId) return null;
  if (typeof claims.email !== "string" || claims.email.length === 0) return null;
  if (typeof claims.subject !== "string" || claims.subject.length === 0) return null;
  if (typeof claims.jti !== "string" || claims.jti.length === 0) return null;
  if (typeof claims.iat !== "number" || typeof claims.exp !== "number") return null;

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) return null; // expired
  if (claims.iat > now + CLOCK_SKEW_S) return null; // minted too far in the future

  return claims;
};
