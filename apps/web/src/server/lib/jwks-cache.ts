/**
 * Fetch + cache a **remote** JWKS, keyed by URL.
 *
 * The twin of `packages/client/src/token.ts`, pointed the other way: that one
 * lets someone else verify *our* tokens; this one lets us verify *theirs*
 * (`lib/third-party-jwt.ts` — Clerk, Auth0, Firebase, Cognito, WorkOS).
 *
 * Two properties matter more than they look:
 *
 *  - **A miss on a cached set triggers at most one refetch per
 *    `MIN_REFETCH_MS`.** Without that floor, a stream of tokens carrying
 *    made-up `kid`s is a stream of outbound fetches — an amplification vector
 *    aimed at the IdP, paid for by us. With it, a real rotation still
 *    propagates within 30 seconds.
 *  - **A fetch in flight is shared.** A cold isolate taking its first burst of
 *    requests must not open one connection per request.
 *
 * The cache is per-isolate and holds nothing but public keys with a TTL, so
 * the usual read-your-writes hazard of per-isolate state does not apply: there
 * is no local write to be stale against, only the IdP's own rotation, which is
 * what the TTL is for.
 */

import type { Env } from "../env";
import { fetchOutbound } from "../services/storage/hosts";
import { log } from "./log";

/** The slice of env the SSRF guard reads. Both entry points take it because
 *  the URLs here are **admin-supplied** — a workspace admin types the discovery
 *  or JWKS endpoint, and on a managed instance that admin is a customer, not
 *  the operator. Every sibling feature that fetches an admin-typed URL
 *  (webhooks, sync hooks, OIDC discovery, SAML metadata) goes through
 *  `fetchOutbound`; a bare `fetch` here would be the one hole in that wall. */
export type JwksFetchEnv = Pick<Env, "BLOCK_PRIVATE_FETCH_HOSTS" | "CLOUD_PROJECT_ID">;

interface Jwk {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

export type VerifyAlg =
  | "RS256"
  | "RS384"
  | "RS512"
  | "PS256"
  | "PS384"
  | "PS512"
  | "ES256"
  | "ES384"
  | "ES512";

const HASH: Record<VerifyAlg, string> = {
  RS256: "SHA-256",
  RS384: "SHA-384",
  RS512: "SHA-512",
  PS256: "SHA-256",
  PS384: "SHA-384",
  PS512: "SHA-512",
  ES256: "SHA-256",
  ES384: "SHA-384",
  ES512: "SHA-512",
};

const CURVE: Partial<Record<VerifyAlg, string>> = {
  ES256: "P-256",
  ES384: "P-384",
  ES512: "P-521",
};

export const isVerifyAlg = (v: unknown): v is VerifyAlg =>
  typeof v === "string" && v in HASH;

/** Import parameters for a public key of this algorithm. */
export const importParamsFor = (
  alg: VerifyAlg,
): EcKeyImportParams | RsaHashedImportParams => {
  const curve = CURVE[alg];
  if (curve) return { name: "ECDSA", namedCurve: curve };
  if (alg.startsWith("PS")) return { name: "RSA-PSS", hash: HASH[alg] };
  return { name: "RSASSA-PKCS1-v1_5", hash: HASH[alg] };
};

/** Verify parameters for a signature made with this algorithm. */
export const verifyParamsFor = (
  alg: VerifyAlg,
): AlgorithmIdentifier | EcdsaParams | RsaPssParams => {
  if (CURVE[alg]) return { name: "ECDSA", hash: HASH[alg] };
  if (alg.startsWith("PS")) {
    // Salt length equals the digest length for the PS* family (RFC 7518 §3.5).
    return { name: "RSA-PSS", saltLength: Number(alg.slice(2)) / 8 };
  }
  return { name: "RSASSA-PKCS1-v1_5" };
};

export interface JwksKey {
  alg: VerifyAlg;
  key: CryptoKey;
}

interface Entry {
  keys: Map<string, JwksKey>;
  fetchedAt: number;
  inFlight: Promise<Map<string, JwksKey>> | null;
}

/** How long a fetched key set is reused. Matches the 10-minute window the
 *  major IdPs document for their own key-rotation propagation. */
const CACHE_MS = 600_000;
/** Floor between two fetches of the same URL — see the module comment. */
const MIN_REFETCH_MS = 30_000;
/** An IdP that hangs must not hang our request path with it. */
const FETCH_TIMEOUT_MS = 5_000;

const cache = new Map<string, Entry>();

const fetchKeys = async (
  env: JwksFetchEnv,
  url: string,
): Promise<Map<string, JwksKey>> => {
  const res = await fetchOutbound(env, url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const next = new Map<string, JwksKey>();
  for (const jwk of body.keys ?? []) {
    const kid = jwk.kid;
    if (!kid) continue;
    // `alg` is optional in a JWK set. Fall back to the key type's usual
    // algorithm rather than skipping the key — Firebase publishes bare RSA
    // keys with no `alg`, and dropping those would break it entirely.
    const alg: unknown = jwk.alg ?? (jwk.kty === "EC" ? "ES256" : "RS256");
    if (!isVerifyAlg(alg)) continue;
    try {
      next.set(kid, {
        alg,
        key: await crypto.subtle.importKey(
          "jwk",
          { ...jwk, alg, key_ops: ["verify"], ext: true } as JsonWebKey,
          importParamsFor(alg),
          true,
          ["verify"],
        ),
      });
    } catch {
      // One unusable key in the set must not blind us to the others.
    }
  }
  return next;
};

const load = (
  env: JwksFetchEnv,
  url: string,
  entry: Entry,
): Promise<Map<string, JwksKey>> => {
  if (entry.inFlight) return entry.inFlight;
  entry.inFlight = fetchKeys(env, url)
    .then((keys) => {
      entry.keys = keys;
      entry.fetchedAt = Date.now();
      return keys;
    })
    .finally(() => {
      entry.inFlight = null;
    });
  return entry.inFlight;
};

/**
 * The signing key `kid` from `url`, or `null` when the issuer does not publish
 * it. Throws only when the JWKS itself could not be read — the caller decides
 * whether an unreachable IdP is a 401 or something louder, which is a
 * different question from "this token is forged".
 */
export const jwksKey = async (
  env: JwksFetchEnv,
  url: string,
  kid: string,
): Promise<JwksKey | null> => {
  let entry = cache.get(url);
  if (!entry) {
    entry = { keys: new Map(), fetchedAt: 0, inFlight: null };
    cache.set(url, entry);
  }
  const fresh = entry.fetchedAt > 0 && Date.now() - entry.fetchedAt < CACHE_MS;
  const keys = fresh ? entry.keys : await load(env, url, entry);
  const hit = keys.get(kid);
  if (hit) return hit;
  // Unknown kid against a set we already had: the IdP may have just rotated.
  if (fresh && Date.now() - entry.fetchedAt > MIN_REFETCH_MS) {
    return (await load(env, url, entry)).get(kid) ?? null;
  }
  return null;
};

/** Resolve `jwks_uri` from an OIDC discovery document. Used at save time so a
 *  provider row stores a concrete URL rather than re-resolving per request. */
export const resolveJwksUrl = async (
  env: JwksFetchEnv,
  discoveryUrl: string,
): Promise<string | null> => {
  try {
    const res = await fetchOutbound(env, discoveryUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { jwks_uri?: unknown };
    return typeof body.jwks_uri === "string" && body.jwks_uri ? body.jwks_uri : null;
  } catch (err) {
    log.warn("oidc discovery fetch failed", {
      url: discoveryUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
};

/** Drop every cached key set. Called when a provider row changes so a
 *  corrected `jwks_url` takes effect without waiting out the TTL. */
export const clearJwksCache = (): void => {
  cache.clear();
};
