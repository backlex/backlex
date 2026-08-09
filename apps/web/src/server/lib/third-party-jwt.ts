/**
 * Accept a JWT minted by **someone else's** identity provider.
 *
 * An app already running on Clerk / Auth0 / Firebase / Cognito / WorkOS holds a
 * session token from that provider. Without this, adopting backlex means
 * migrating every one of those users into `app_users` first — which is the
 * reason such an app doesn't adopt backlex. With it, the app sends the token it
 * already has and we map its subject onto an `app_users` row.
 *
 * The verification is deliberately narrow:
 *
 *  - **Asymmetric only.** A symmetric token would need us to hold a secret that
 *    also mints tokens, so a leak on either side forges identities on both.
 *    `kid` is required for the same reason it is in the JWKS spec — key
 *    selection must not be a guess.
 *  - **The issuer names the workspace.** These requests carry no session and no
 *    workspace header, so `iss` is the only thing that can. That is why
 *    `third_party_auth_providers.issuer` is unique instance-wide.
 *  - **`iss` picks the key set, the signature binds it.** Reading the payload
 *    before verifying is safe *because* the only thing read is which public key
 *    to check against; nothing from an unverified payload survives a failed
 *    signature.
 *
 * Never throws. Anything that isn't a live, verifiable third-party token is
 * `null`, so the caller can use it as the last probe in the bearer chain.
 */

import type { PgDb } from "@backlex/db/pg";
import * as pg from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import * as sqlite from "@backlex/db/sqlite";
import { and, eq } from "drizzle-orm";
import type { JwksFetchEnv } from "./jwks-cache";
import { isVerifyAlg, jwksKey, verifyParamsFor } from "./jwks-cache";
import { log } from "./log";

/** `env` rides along because the JWKS endpoint is admin-supplied and must be
 *  fetched through the same SSRF guard every other admin-typed URL uses. */
type DbCtx = {
  db: PgDb | SqliteDb;
  dialect: "pg" | "sqlite";
  env: JwksFetchEnv;
};

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? pg.schema.thirdPartyAuthProviders
    : sqlite.schema.thirdPartyAuthProviders;

/** Tolerance on `exp` / `nbf`, in seconds. Clocks drift; a minute is the
 *  conventional allowance and is short enough not to extend a revoked token
 *  meaningfully. */
const CLOCK_SKEW_SEC = 60;

export interface ThirdPartyProvider {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  issuer: string;
  jwksUrl: string;
  audience: string | null;
  subjectClaim: string;
  emailClaim: string;
  nameClaim: string | null;
  groupsClaim: string | null;
  groupsToRoles: Record<string, string> | null;
  defaultRoleId: string | null;
  linkByVerifiedEmail: boolean;
  autoProvision: boolean;
  enabled: boolean;
}

export interface ThirdPartyIdentity {
  provider: ThirdPartyProvider;
  /** The IdP's stable id for this person — what `external_identities.subject`
   *  stores. */
  subject: string;
  email: string | null;
  name: string | null;
  /** Group / role strings from the configured claim, for `groupsToRoles`. */
  groups: string[] | null;
}

const dec = new TextDecoder();
const enc = new TextEncoder();

const base64urlToBytes = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

const decodeJson = (part: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(dec.decode(base64urlToBytes(part)));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Read a claim by name, supporting the dotted paths IdPs use for namespaced
 *  claims (`https://acme.com/roles` has no dots, but `user.email` does). */
const claim = (payload: Record<string, unknown>, path: string): unknown => {
  if (path in payload) return payload[path];
  let cur: unknown = payload;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
};

const asString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const asGroups = (v: unknown): string[] | null => {
  if (Array.isArray(v)) {
    const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    return out.length > 0 ? out : [];
  }
  // Some IdPs emit a single group as a bare string, others space-separate.
  if (typeof v === "string" && v.length > 0) return v.split(/[\s,]+/).filter(Boolean);
  return null;
};

/** `aud` is a string or an array of strings (RFC 7519 §4.1.3). */
const audienceMatches = (aud: unknown, expected: string): boolean =>
  Array.isArray(aud)
    ? aud.some((a) => typeof a === "string" && a === expected)
    : aud === expected;

const loadProviderByIssuer = async (
  ctx: DbCtx,
  issuer: string,
): Promise<ThirdPartyProvider | null> => {
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(and(eq(t.issuer, issuer), eq(t.enabled, true)))
      .limit(1)) as ThirdPartyProvider[];
    return rows[0] ?? null;
  } catch {
    // Table not migrated yet (or a transient read failure) — treat the token as
    // unknown rather than 500ing every request that carries a bearer.
    return null;
  }
};

export const verifyThirdPartyToken = async (
  ctx: DbCtx,
  token: string,
): Promise<ThirdPartyIdentity | null> => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];

  const header = decodeJson(headerPart);
  if (!header) return null;
  const alg = header.alg;
  const kid = header.kid;
  // Asymmetric + explicit key id, or nothing. `none` and the HS* family land
  // here and are refused before a single byte of the payload is trusted.
  if (!isVerifyAlg(alg) || typeof kid !== "string" || !kid) return null;

  const payload = decodeJson(payloadPart);
  if (!payload) return null;
  const issuer = asString(payload.iss);
  if (!issuer) return null;

  const provider = await loadProviderByIssuer(ctx, issuer);
  if (!provider) return null;

  let key: Awaited<ReturnType<typeof jwksKey>>;
  try {
    key = await jwksKey(ctx.env, provider.jwksUrl, kid);
  } catch (err) {
    // The IdP is unreachable or serving garbage. The request goes on
    // unauthenticated, but this is an outage rather than a forged token and
    // must not be indistinguishable from one in the logs.
    log.warn("third-party JWKS unavailable", {
      provider: provider.slug,
      tenantId: provider.tenantId,
      jwksUrl: provider.jwksUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!key || key.alg !== alg) return null;

  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      verifyParamsFor(key.alg),
      key.key,
      buf(base64urlToBytes(sigPart)),
      buf(enc.encode(`${headerPart}.${payloadPart}`)),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  // ── the payload is trustworthy from here on ──────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = payload.exp;
  // An unexpiring third-party token would be a permanent credential we have no
  // way to revoke, so `exp` is required rather than merely checked when present.
  if (typeof exp !== "number" || exp + CLOCK_SKEW_SEC <= nowSec) return null;
  const nbf = payload.nbf;
  if (typeof nbf === "number" && nbf - CLOCK_SKEW_SEC > nowSec) return null;

  if (provider.audience && !audienceMatches(payload.aud, provider.audience)) {
    return null;
  }

  const subject = asString(claim(payload, provider.subjectClaim));
  if (!subject) return null;

  return {
    provider,
    subject,
    email: asString(claim(payload, provider.emailClaim)),
    name: provider.nameClaim ? asString(claim(payload, provider.nameClaim)) : null,
    groups: provider.groupsClaim
      ? asGroups(claim(payload, provider.groupsClaim))
      : null,
  };
};
