/**
 * @module
 *
 * Verify a backlex app-plane access token **locally**, without calling backlex.
 *
 * When the instance is configured with a signing key pair (`AUTH_JWT_PRIVATE_KEY`
 * server-side), its access tokens are signed ES256/RS256 and the public keys are
 * published at `/.well-known/jwks.json`. Any service that can fetch that
 * document can check a token itself — an edge worker gating a route, a partner
 * API, a second service behind the same login — with no shared secret and no
 * round-trip per request.
 *
 * ```ts
 * import { createTokenVerifier } from "backlex/token";
 *
 * const verifier = createTokenVerifier({ url: "https://api.example.com" });
 * const claims = await verifier.verify(bearerToken);
 * if (!claims) return new Response("unauthorized", { status: 401 });
 * console.log(claims.sub, claims.tid);
 * ```
 *
 * HS256 tokens (the default, symmetric mode) are **always rejected** here: a
 * remote verifier holding the secret needed to check them could also mint them,
 * which defeats the point. Turn on key-pair signing to use this.
 *
 * Runs anywhere Web Crypto is available (Workers, Node 18+, Bun, Deno).
 */

/** Claims carried by a workspace end-user access token. */
export interface AccessTokenClaims {
  /** app-user id */
  sub: string;
  /** tenant (workspace) id the session is pinned to */
  tid: string;
  /** auth plane — always `"app"` */
  plane: "app";
  /** id of the server-side session backing this token */
  sid: string;
  /** end-user email, or `null` */
  email: string | null;
  typ: "access";
  /** issuing instance, when the server has `APP_URL` configured */
  iss?: string;
  iat: number;
  exp: number;
}

export interface TokenVerifierOptions {
  /** Base URL of the backlex instance (JWKS is read from
   *  `<url>/.well-known/jwks.json`). */
  url: string;
  /** Custom fetch (test doubles, a pinned agent). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Reject tokens whose `iss` doesn't match. Off by default — set it when the
   *  same verifier could be reached by tokens from more than one instance. */
  issuer?: string;
  /** How long a fetched JWKS is reused, in ms (default 5 min). */
  cacheMs?: number;
  /** Allowed clock skew when checking `exp`, in seconds (default 0). */
  clockToleranceSec?: number;
}

export interface TokenVerifier {
  /** Claims on success, `null` for anything else — bad signature, unknown key,
   *  expired, wrong token type, not a JWT at all. Network failures while
   *  fetching the JWKS throw, so a verifier outage isn't silently a 401. */
  verify(token: string): Promise<AccessTokenClaims | null>;
  /** Drop the cached JWKS; the next `verify` refetches. */
  refresh(): void;
}

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

const importParams = (alg: string): EcKeyImportParams | RsaHashedImportParams =>
  alg === "ES256"
    ? { name: "ECDSA", namedCurve: "P-256" }
    : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

const verifyParams = (alg: string): AlgorithmIdentifier | EcdsaParams =>
  alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };

/** Don't let a stream of tokens with made-up `kid`s turn into a stream of JWKS
 *  fetches — a real rotation still propagates within this window. */
const MIN_REFETCH_MS = 30_000;

export const createTokenVerifier = (
  options: TokenVerifierOptions,
): TokenVerifier => {
  const doFetch = options.fetch ?? globalThis.fetch;
  const cacheMs = options.cacheMs ?? 300_000;
  const tolerance = options.clockToleranceSec ?? 0;
  const jwksUrl = `${options.url.replace(/\/+$/, "")}/.well-known/jwks.json`;

  let keys: Map<string, { alg: string; key: CryptoKey }> | null = null;
  let fetchedAt = 0;
  let inFlight: Promise<Map<string, { alg: string; key: CryptoKey }>> | null = null;

  const load = (): Promise<Map<string, { alg: string; key: CryptoKey }>> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const res = await doFetch(jwksUrl, { headers: { accept: "application/json" } });
      if (!res.ok) {
        throw new Error(`backlex: JWKS fetch failed (${res.status}) at ${jwksUrl}`);
      }
      const body = (await res.json()) as { keys?: Jwk[] };
      const next = new Map<string, { alg: string; key: CryptoKey }>();
      for (const jwk of body.keys ?? []) {
        const { kid, alg } = jwk;
        if (!kid || (alg !== "ES256" && alg !== "RS256")) continue;
        try {
          next.set(kid, {
            alg,
            key: await crypto.subtle.importKey(
              "jwk",
              { ...jwk, key_ops: ["verify"], ext: true } as JsonWebKey,
              importParams(alg),
              true,
              ["verify"],
            ),
          });
        } catch {
          // One unusable key in the set shouldn't blind us to the others.
        }
      }
      keys = next;
      fetchedAt = Date.now();
      return next;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const keyFor = async (
    kid: string,
  ): Promise<{ alg: string; key: CryptoKey } | undefined> => {
    const fresh = keys && Date.now() - fetchedAt < cacheMs;
    const set = fresh && keys ? keys : await load();
    const hit = set.get(kid);
    // Unknown kid against a cached set: the server may have just rotated.
    if (!hit && fresh && Date.now() - fetchedAt > MIN_REFETCH_MS) {
      return (await load()).get(kid);
    }
    return hit;
  };

  return {
    refresh() {
      keys = null;
      fetchedAt = 0;
    },
    async verify(token) {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const [headerPart, payloadPart, sigPart] = parts as [string, string, string];
      let header: { alg?: unknown; kid?: unknown };
      try {
        header = JSON.parse(dec.decode(base64urlToBytes(headerPart)));
      } catch {
        return null;
      }
      if (header.alg !== "ES256" && header.alg !== "RS256") return null;
      if (typeof header.kid !== "string") return null;

      const entry = await keyFor(header.kid);
      if (!entry || entry.alg !== header.alg) return null;

      try {
        const ok = await crypto.subtle.verify(
          verifyParams(entry.alg),
          entry.key,
          buf(base64urlToBytes(sigPart)),
          buf(enc.encode(`${headerPart}.${payloadPart}`)),
        );
        if (!ok) return null;
        const claims = JSON.parse(
          dec.decode(base64urlToBytes(payloadPart)),
        ) as AccessTokenClaims;
        if (claims.typ !== "access" || claims.plane !== "app") return null;
        if (!claims.sub || !claims.tid) return null;
        if (options.issuer && claims.iss !== options.issuer) return null;
        if (
          typeof claims.exp !== "number" ||
          (claims.exp + tolerance) * 1000 <= Date.now()
        ) {
          return null;
        }
        return claims;
      } catch {
        return null;
      }
    },
  };
};
