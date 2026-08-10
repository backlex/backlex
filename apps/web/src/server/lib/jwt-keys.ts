/**
 * Asymmetric signing keys + JWKS for app-plane access tokens.
 *
 * The default token signature is HS256 off `AUTH_SECRET` (see `lib/jwt.ts`) —
 * fine for a closed system, useless the moment something *else* has to verify a
 * backlex token: a CDN worker, a partner API, another service in the mesh. They
 * would all need the shared secret, which is the same as giving them the power
 * to mint tokens.
 *
 * Set `AUTH_JWT_PRIVATE_KEY` and access tokens are signed with the private half
 * of a key pair instead. Anyone can fetch `/.well-known/jwks.json` and verify
 * locally; nobody but this server can sign.
 *
 * Key format is PKCS#8 PEM, EC P-256 (→ `ES256`) or RSA (→ `RS256`):
 *
 *   openssl ecparam -name prime256v1 -genkey -noout \
 *     | openssl pkcs8 -topk8 -nocrypt
 *
 * `kid` is not configured — it's the RFC 7638 thumbprint of the public key, so
 * it's stable for a given key and changes exactly when the key does.
 *
 * Rotation: put the new private key in `AUTH_JWT_PRIVATE_KEY` and the *old*
 * public key (SPKI PEM) in `AUTH_JWT_PUBLIC_KEYS`. New tokens are signed with
 * the new key; tokens already in the wild still verify, here and for anyone
 * reading the JWKS, until they expire (15 min). Then drop the old public key.
 *
 * Hand-rolled on Web Crypto — no dependency, identical on Workers, Bun, Vercel
 * and Netlify.
 */

export type JwtAlg = "ES256" | "RS256";

/** The env fields this module reads. A subset of `Env` so tests (and the
 *  JWKS route) can pass a literal. */
export interface JwtKeyEnv {
  AUTH_JWT_PRIVATE_KEY?: string;
  AUTH_JWT_PUBLIC_KEYS?: string;
}

/** A public key as published in the JWKS document. */
export interface PublicJwk {
  kty: "EC" | "RSA";
  kid: string;
  alg: JwtAlg;
  use: "sig";
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

export interface SigningKey {
  alg: JwtAlg;
  kid: string;
  key: CryptoKey;
}

export interface KeyMaterial {
  /** Key new tokens are signed with; `null` when no private key is configured
   *  (HS256 fallback). */
  signing: SigningKey | null;
  /** Every public key that may verify a token, by `kid`. */
  verify: Map<string, { alg: JwtAlg; key: CryptoKey }>;
  /** The `keys` array of `/.well-known/jwks.json`. */
  jwks: PublicJwk[];
}

const enc = new TextEncoder();

// `crypto.subtle` parameters are typed as `BufferSource`, but the strict lib
// types distinguish `ArrayBuffer` from `ArrayBufferLike`; this cast papers over
// that without copying (same shim as `lib/crypto.ts`).
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

const base64urlFromBytes = (bytes: Uint8Array): string => {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const EC_PARAMS: EcKeyImportParams = { name: "ECDSA", namedCurve: "P-256" };
const RSA_PARAMS: RsaHashedImportParams = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
};

/** Every `-----BEGIN X-----…-----END X-----` block in `text`, decoded. A single
 *  env var may hold several concatenated PEMs (rotation). */
const pemBlocks = (text: string): Uint8Array[] => {
  const out: Uint8Array[] = [];
  const re = /-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/g;
  for (const m of text.matchAll(re)) {
    const body = (m[1] ?? "").replace(/\s+/g, "");
    if (!body) continue;
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    out.push(bytes);
  }
  return out;
};

/** The public half of an exported private JWK, in the exact member set RFC 7638
 *  hashes (order matters — the canonical form is lexicographic). */
const publicMembers = (
  jwk: JsonWebKey,
): { canonical: string; parts: Partial<PublicJwk> } => {
  if (jwk.kty === "EC") {
    const { crv, x, y } = jwk;
    return {
      canonical: JSON.stringify({ crv, kty: "EC", x, y }),
      parts: { kty: "EC", crv, x, y },
    };
  }
  const { n, e } = jwk;
  return {
    canonical: JSON.stringify({ e, kty: "RSA", n }),
    parts: { kty: "RSA", n, e },
  };
};

/** RFC 7638 JWK thumbprint — SHA-256 over the canonical public members. */
const thumbprint = async (canonical: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", buf(enc.encode(canonical)));
  return base64urlFromBytes(new Uint8Array(digest));
};

/** Import a PKCS#8 private key, trying EC P-256 then RSA. Extractable, because
 *  the public JWK (and therefore the `kid`) is derived by exporting it. */
const importPrivate = async (
  bytes: Uint8Array,
): Promise<{ alg: JwtAlg; key: CryptoKey }> => {
  try {
    return {
      alg: "ES256",
      key: await crypto.subtle.importKey("pkcs8", buf(bytes), EC_PARAMS, true, [
        "sign",
      ]),
    };
  } catch {
    return {
      alg: "RS256",
      key: await crypto.subtle.importKey("pkcs8", buf(bytes), RSA_PARAMS, true, [
        "sign",
      ]),
    };
  }
};

/** Import an SPKI public key, trying EC P-256 then RSA. */
const importPublic = async (
  bytes: Uint8Array,
): Promise<{ alg: JwtAlg; key: CryptoKey }> => {
  try {
    return {
      alg: "ES256",
      key: await crypto.subtle.importKey("spki", buf(bytes), EC_PARAMS, true, [
        "verify",
      ]),
    };
  } catch {
    return {
      alg: "RS256",
      key: await crypto.subtle.importKey("spki", buf(bytes), RSA_PARAMS, true, [
        "verify",
      ]),
    };
  }
};

/** The `kid` and public JWK for a key. Exported because the signing-key store
 *  derives a row's `kid` the same way, and two implementations of a thumbprint
 *  would eventually disagree about which key a token names. */
export const describePublicKey = async (
  alg: JwtAlg,
  key: CryptoKey,
): Promise<{ kid: string; jwk: PublicJwk }> => {
  const exported = await crypto.subtle.exportKey("jwk", key);
  const { canonical, parts } = publicMembers(exported);
  const kid = await thumbprint(canonical);
  return { kid, jwk: { ...(parts as PublicJwk), kid, alg, use: "sig" } };
};

/** Re-import a public JWK for verification. The signing key itself can't verify
 *  (private keys are imported with `["sign"]` only). */
export const verifierForJwk = async (jwk: PublicJwk): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "jwk",
    { ...jwk, key_ops: ["verify"], ext: true } as JsonWebKey,
    jwk.kty === "EC" ? EC_PARAMS : RSA_PARAMS,
    true,
    ["verify"],
  );

/** Import a PKCS#8 PEM. Exported for the signing-key store, which holds PEMs
 *  in rows rather than in env. */
export const importPrivatePem = async (
  pem: string,
): Promise<{ alg: JwtAlg; key: CryptoKey }> => {
  const [bytes] = pemBlocks(pem);
  if (!bytes) throw new Error("No PEM block found — expected a PKCS#8 private key");
  return importPrivate(bytes);
};

/** Import an SPKI PEM. */
export const importPublicPem = async (
  pem: string,
): Promise<{ alg: JwtAlg; key: CryptoKey }> => {
  const [bytes] = pemBlocks(pem);
  if (!bytes) throw new Error("No PEM block found — expected an SPKI public key");
  return importPublic(bytes);
};

/** Export a CryptoKey back to PEM. The inverse of the parsing above, needed
 *  because a generated key has to be STORED as text. */
export const pemFromKey = async (
  key: CryptoKey,
  format: "pkcs8" | "spki",
): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.exportKey(format, key));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const body = btoa(bin).replace(/(.{64})/g, "$1\n").trim();
  const label = format === "pkcs8" ? "PRIVATE KEY" : "PUBLIC KEY";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
};

const load = async (env: JwtKeyEnv): Promise<KeyMaterial> => {
  const material: KeyMaterial = { signing: null, verify: new Map(), jwks: [] };

  const privatePem = env.AUTH_JWT_PRIVATE_KEY?.trim();
  if (privatePem) {
    const [bytes] = pemBlocks(privatePem);
    if (!bytes) {
      throw new Error(
        "AUTH_JWT_PRIVATE_KEY is set but holds no PEM block — expected a PKCS#8 private key",
      );
    }
    const { alg, key } = await importPrivate(bytes);
    const { kid, jwk } = await describePublicKey(alg, key);
    material.signing = { alg, kid, key };
    material.jwks.push(jwk);
    material.verify.set(kid, { alg, key: await verifierForJwk(jwk) });
  }

  const publicPem = env.AUTH_JWT_PUBLIC_KEYS?.trim();
  if (publicPem) {
    for (const bytes of pemBlocks(publicPem)) {
      const { alg, key } = await importPublic(bytes);
      const { kid, jwk } = await describePublicKey(alg, key);
      // The current signing key may legitimately also be listed here.
      if (material.verify.has(kid)) continue;
      material.jwks.push(jwk);
      material.verify.set(kid, { alg, key });
    }
  }

  return material;
};

// Single-entry cache — key material is derived from two env strings that never
// change within a process, and this runs on every bearer-authenticated request.
// A failed load is NOT cached, so a fixed key takes effect on the next attempt.
let cached: { fingerprint: string; material: Promise<KeyMaterial> } | null = null;

/**
 * Resolve (and memoize) the configured key material.
 *
 * Throws when `AUTH_JWT_PRIVATE_KEY` is set but unusable. That's deliberate:
 * silently falling back to HS256 would leave an operator believing tokens are
 * asymmetric when they aren't, and the failure is immediate and obvious at
 * deploy time instead.
 */
export const jwtKeyMaterial = async (env: JwtKeyEnv): Promise<KeyMaterial> => {
  // Stored keys win, when there are any. An instance that has never used them
  // gets exactly the behaviour it had before this existed — which is the point
  // of returning `null` rather than an empty material from the source.
  const stored = await keySource?.();
  if (stored) return mergeEnvVerifiers(stored, await envKeyMaterial(env));

  return envKeyMaterial(env);
};

/**
 * Keep the env key VERIFYING once stored keys take over signing.
 *
 * The moment a row is promoted, every token minted from `AUTH_JWT_PRIVATE_KEY`
 * is still in somebody's hands and its `exp` is the only thing that ends it.
 * Dropping the env key from the verify set the instant the first row appears
 * would sign every one of them out — during the very migration the feature
 * exists to make safe.
 *
 * Signing is NOT merged: a stored `in_use` key is the answer, and falling back
 * to env when no row is promoted would mean a workspace with only standby keys
 * silently kept signing with the old one.
 */
const mergeEnvVerifiers = (stored: KeyMaterial, env: KeyMaterial): KeyMaterial => {
  const verify = new Map(stored.verify);
  const jwks = [...stored.jwks];
  for (const [kid, entry] of env.verify) {
    if (verify.has(kid)) continue;
    verify.set(kid, entry);
    const jwk = env.jwks.find((j) => j.kid === kid);
    if (jwk) jwks.push(jwk);
  }
  return { signing: stored.signing, verify, jwks };
};

const envKeyMaterial = (env: JwtKeyEnv): Promise<KeyMaterial> => {
  const fingerprint = `${env.AUTH_JWT_PRIVATE_KEY ?? ""}\0${env.AUTH_JWT_PUBLIC_KEYS ?? ""}`;
  if (cached && cached.fingerprint === fingerprint) return cached.material;
  const material = load(env).catch((e) => {
    if (cached?.fingerprint === fingerprint) cached = null;
    throw e;
  });
  cached = { fingerprint, material };
  return material;
};

/**
 * Where stored (database-backed) keys come from.
 *
 * A module-level registration rather than a parameter, because
 * `signAccessToken` takes only an `Env` and threading a database handle through
 * every caller of a function that signs a token would touch a great deal of
 * code to say one thing. `services/signing-keys.ts` registers it from
 * `buildContext`; unregistered (tests, the JWKS route on a fresh isolate) means
 * env keys, which is the pre-feature behaviour.
 */
let keySource: (() => Promise<KeyMaterial | null>) | null = null;

export const registerSigningKeySource = (
  source: (() => Promise<KeyMaterial | null>) | null,
): void => {
  keySource = source;
};

/** Test seam — drops the memoized key material AND any registered stored-key
 *  source, so a spec starts from the env-only behaviour. */
export const resetJwtKeyCache = (): void => {
  cached = null;
  keySource = null;
};

/** The `/.well-known/jwks.json` body. `{ keys: [] }` (not a 404) when no
 *  asymmetric key is configured — that's the standard-friendly way for a client
 *  to learn this instance signs symmetrically. */
export const jwksDocument = async (
  env: JwtKeyEnv,
): Promise<{ keys: PublicJwk[] }> => ({ keys: (await jwtKeyMaterial(env)).jwks });

/** WebCrypto sign/verify parameters for a JWS algorithm. */
export const algParams = (alg: JwtAlg): AlgorithmIdentifier | EcdsaParams =>
  alg === "ES256"
    ? ({ name: "ECDSA", hash: "SHA-256" } satisfies EcdsaParams)
    : { name: "RSASSA-PKCS1-v1_5" };
