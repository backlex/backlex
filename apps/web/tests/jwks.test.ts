/**
 * Asymmetric app-plane access tokens + the public JWKS document.
 *
 * The point of the feature is that something *other than this server* can check
 * a backlex token, so the assertions track that boundary: the published JWKS
 * carries no private material, the `kid` in the header resolves inside it, a key
 * rotated out still verifies until its tokens expire, and none of the classic
 * "verify with the wrong key type" forgeries get through.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
  jwksDocument,
  type PublicJwk,
  resetJwtKeyCache,
} from "../src/server/lib/jwt-keys";
import { type JwtEnv, signAccessToken, verifyAccessToken } from "../src/server/lib/jwt";
import { makeHarness } from "./setup";

const enc = new TextEncoder();

const toPem = (label: string, bytes: ArrayBuffer): string => {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
};

const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlJson = (v: unknown): string => b64url(enc.encode(JSON.stringify(v)));

interface KeyPair {
  privatePem: string;
  publicPem: string;
}

const generate = async (kind: "EC" | "RSA"): Promise<KeyPair> => {
  const algorithm =
    kind === "EC"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        };
  const pair = (await crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    privatePem: toPem(
      "PRIVATE KEY",
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ),
    publicPem: toPem(
      "PUBLIC KEY",
      await crypto.subtle.exportKey("spki", pair.publicKey),
    ),
  };
};

const SECRET = "test-secret-not-for-prod-but-stable-across-calls";
const CLAIMS = { sub: "u1", tid: "t1", sid: "s1", email: "a@example.com" };

const envWith = (over: Partial<JwtEnv> = {}): JwtEnv => ({
  AUTH_SECRET: SECRET,
  APP_URL: "https://api.example.test",
  ...over,
});

let ec: KeyPair;
let rsa: KeyPair;

beforeAll(async () => {
  resetJwtKeyCache();
  [ec, rsa] = await Promise.all([generate("EC"), generate("RSA")]);
});

const header = (token: string): { alg?: string; kid?: string } =>
  JSON.parse(atob(token.split(".")[0] as string));

describe("asymmetric access tokens", () => {
  test("signs ES256 and round-trips", async () => {
    const env = envWith({ AUTH_JWT_PRIVATE_KEY: ec.privatePem });
    const { token } = await signAccessToken(env, CLAIMS);
    expect(header(token).alg).toBe("ES256");
    const claims = await verifyAccessToken(env, token);
    expect(claims?.sub).toBe("u1");
    expect(claims?.tid).toBe("t1");
    expect(claims?.iss).toBe("https://api.example.test");
  });

  test("signs RS256 when the key is RSA", async () => {
    const env = envWith({ AUTH_JWT_PRIVATE_KEY: rsa.privatePem });
    const { token } = await signAccessToken(env, CLAIMS);
    expect(header(token).alg).toBe("RS256");
    expect((await verifyAccessToken(env, token))?.sub).toBe("u1");
  });

  test("falls back to HS256 when no key pair is configured", async () => {
    const env = envWith();
    const { token } = await signAccessToken(env, CLAIMS);
    expect(header(token).alg).toBe("HS256");
    expect(header(token).kid).toBeUndefined();
    expect((await verifyAccessToken(env, token))?.sub).toBe("u1");
    expect((await jwksDocument(env)).keys).toEqual([]);
  });

  test("HS256 tokens still verify after key-pair signing is turned on", async () => {
    // Rollout safety: sessions minted before the switch stay valid.
    const legacy = await signAccessToken(envWith(), CLAIMS);
    const env = envWith({ AUTH_JWT_PRIVATE_KEY: ec.privatePem });
    expect((await verifyAccessToken(env, legacy.token))?.sub).toBe("u1");
  });

  test("the header kid is the published key's kid", async () => {
    const env = envWith({ AUTH_JWT_PRIVATE_KEY: ec.privatePem });
    const { token } = await signAccessToken(env, CLAIMS);
    const { keys } = await jwksDocument(env);
    expect(keys).toHaveLength(1);
    expect(header(token).kid).toBe(keys[0]?.kid);
  });

  test("rejects an expired token", async () => {
    const env = envWith({ AUTH_JWT_PRIVATE_KEY: ec.privatePem });
    const { token } = await signAccessToken(env, CLAIMS, -10);
    expect(await verifyAccessToken(env, token)).toBeNull();
  });

  test("a misconfigured private key fails loudly at mint time", async () => {
    const env = envWith({ AUTH_JWT_PRIVATE_KEY: "not-a-pem" });
    expect(signAccessToken(env, CLAIMS)).rejects.toThrow(/AUTH_JWT_PRIVATE_KEY/);
  });
});

describe("JWKS document", () => {
  test("publishes only public material", async () => {
    const { keys } = await jwksDocument(
      envWith({ AUTH_JWT_PRIVATE_KEY: ec.privatePem }),
    );
    const jwk = keys[0] as PublicJwk & { d?: string };
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    expect(jwk.alg).toBe("ES256");
    expect(jwk.use).toBe("sig");
    expect(jwk.kid).toBeTruthy();
    // The private scalar (EC) must never leave the server.
    expect(jwk.d).toBeUndefined();
    expect(JSON.stringify(jwk)).not.toContain('"d"');
  });

  test("kid is stable for a key and distinct between keys", async () => {
    const a = await jwksDocument(envWith({ AUTH_JWT_PRIVATE_KEY: ec.privatePem }));
    const again = await jwksDocument(
      envWith({ AUTH_JWT_PRIVATE_KEY: ec.privatePem }),
    );
    const b = await jwksDocument(envWith({ AUTH_JWT_PRIVATE_KEY: rsa.privatePem }));
    expect(a.keys[0]?.kid).toBe(again.keys[0]?.kid as string);
    expect(a.keys[0]?.kid).not.toBe(b.keys[0]?.kid as string);
  });

  test("served publicly, CORS-open and cacheable", async () => {
    const h = makeHarness({ AUTH_JWT_PRIVATE_KEY: ec.privatePem });
    try {
      const res = await h.fetch("/.well-known/jwks.json");
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("cache-control")).toContain("max-age");
      const body = (await res.json()) as { keys: PublicJwk[] };
      expect(body.keys[0]?.alg).toBe("ES256");
    } finally {
      h.cleanup();
    }
  });

  test("empty key set (not a 404) on a symmetric instance", async () => {
    const h = makeHarness();
    try {
      const res = await h.fetch("/.well-known/jwks.json");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ keys: [] });
    } finally {
      h.cleanup();
    }
  });
});

describe("rotation", () => {
  test("a rotated-out key still verifies while listed as a public key", async () => {
    const old = envWith({ AUTH_JWT_PRIVATE_KEY: ec.privatePem });
    const issued = await signAccessToken(old, CLAIMS);

    const rotated = envWith({
      AUTH_JWT_PRIVATE_KEY: rsa.privatePem,
      AUTH_JWT_PUBLIC_KEYS: ec.publicPem,
    });
    expect((await verifyAccessToken(rotated, issued.token))?.sub).toBe("u1");
    // New tokens use the new key…
    const fresh = await signAccessToken(rotated, CLAIMS);
    expect(header(fresh.token).alg).toBe("RS256");
    // …and both keys are published so external verifiers see the same picture.
    const { keys } = await jwksDocument(rotated);
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.alg).sort()).toEqual(["ES256", "RS256"]);
  });

  test("dropping the old public key invalidates its tokens", async () => {
    const old = envWith({ AUTH_JWT_PRIVATE_KEY: ec.privatePem });
    const issued = await signAccessToken(old, CLAIMS);
    const rotated = envWith({ AUTH_JWT_PRIVATE_KEY: rsa.privatePem });
    expect(await verifyAccessToken(rotated, issued.token)).toBeNull();
  });

  test("listing the signing key again doesn't duplicate it", async () => {
    const env = envWith({
      AUTH_JWT_PRIVATE_KEY: ec.privatePem,
      AUTH_JWT_PUBLIC_KEYS: ec.publicPem,
    });
    expect((await jwksDocument(env)).keys).toHaveLength(1);
  });
});

describe("forgery attempts", () => {
  const payload = {
    sub: "attacker",
    tid: "t1",
    plane: "app",
    sid: "s1",
    email: null,
    typ: "access",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
  };

  test("rejects alg:none", async () => {
    const env = envWith({ AUTH_JWT_PRIVATE_KEY: ec.privatePem });
    const token = `${b64urlJson({ alg: "none", typ: "JWT" })}.${b64urlJson(payload)}.`;
    expect(await verifyAccessToken(env, token)).toBeNull();
  });

  test("rejects a token HMAC'd with the public key (algorithm confusion)", async () => {
    const env = envWith({ AUTH_JWT_PRIVATE_KEY: ec.privatePem });
    const body = `${b64urlJson({ alg: "HS256", typ: "JWT" })}.${b64urlJson(payload)}`;
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(ec.publicPem) as unknown as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, enc.encode(body) as unknown as BufferSource),
    );
    expect(await verifyAccessToken(env, `${body}.${b64url(sig)}`)).toBeNull();
  });

  test("rejects a valid signature relabelled with another kid", async () => {
    const env = envWith({
      AUTH_JWT_PRIVATE_KEY: ec.privatePem,
      AUTH_JWT_PUBLIC_KEYS: rsa.publicPem,
    });
    const { token } = await signAccessToken(env, CLAIMS);
    const { keys } = await jwksDocument(env);
    const other = keys.find((k) => k.alg === "RS256");
    const [, body, sig] = token.split(".") as [string, string, string];
    const swapped = `${b64urlJson({ alg: "ES256", typ: "JWT", kid: other?.kid })}.${body}.${sig}`;
    expect(await verifyAccessToken(env, swapped)).toBeNull();
  });

  test("rejects an unknown kid", async () => {
    const env = envWith({ AUTH_JWT_PRIVATE_KEY: ec.privatePem });
    const { token } = await signAccessToken(env, CLAIMS);
    const [, body, sig] = token.split(".") as [string, string, string];
    const forged = `${b64urlJson({ alg: "ES256", typ: "JWT", kid: "nope" })}.${body}.${sig}`;
    expect(await verifyAccessToken(env, forged)).toBeNull();
  });
});
