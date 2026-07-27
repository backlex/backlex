/**
 * The SDK's `createTokenVerifier` against real server-minted tokens.
 *
 * This is the feature's actual promise end-to-end: a token minted here, a JWKS
 * served over HTTP, and a *separate* consumer that validates it with no shared
 * secret and no call back to the API. So the verifier is driven through the
 * harness's own `/.well-known/jwks.json` rather than a hand-built key set.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { createTokenVerifier } from "../../../packages/client/src/token";
import { signAccessToken } from "../src/server/lib/jwt";
import { resetJwtKeyCache } from "../src/server/lib/jwt-keys";
import { makeHarness, type TestHarness } from "./setup";

const toPem = (label: string, bytes: ArrayBuffer): string => {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return `-----BEGIN ${label}-----\n${btoa(bin).replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;
};

const APP_URL = "https://api.example.test";
const CLAIMS = { sub: "u1", tid: "t1", sid: "s1", email: "a@example.com" };

let privatePem: string;
let h: TestHarness;
/** Fetch bound to the harness app — stands in for a remote service reaching the
 *  instance's public JWKS. */
const jwksFetch = ((input: string | URL | Request) =>
  h.fetch(new URL(String(input)).pathname)) as unknown as typeof fetch;

beforeAll(async () => {
  resetJwtKeyCache();
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privatePem = toPem(
    "PRIVATE KEY",
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  h = makeHarness({ AUTH_JWT_PRIVATE_KEY: privatePem, APP_URL });
});

const env = () => ({
  AUTH_SECRET: "test-secret-not-for-prod-but-stable-across-calls",
  APP_URL,
  AUTH_JWT_PRIVATE_KEY: privatePem,
});

describe("createTokenVerifier", () => {
  test("verifies a server-minted token from the published JWKS", async () => {
    const { token } = await signAccessToken(env(), CLAIMS);
    const verifier = createTokenVerifier({ url: APP_URL, fetch: jwksFetch });
    const claims = await verifier.verify(token);
    expect(claims?.sub).toBe("u1");
    expect(claims?.tid).toBe("t1");
    expect(claims?.plane).toBe("app");
    expect(claims?.iss).toBe(APP_URL);
  });

  test("caches the JWKS instead of refetching per token", async () => {
    let calls = 0;
    const counting = ((input: string | URL | Request) => {
      calls++;
      return jwksFetch(input as string);
    }) as unknown as typeof fetch;
    const verifier = createTokenVerifier({ url: APP_URL, fetch: counting });
    const a = await signAccessToken(env(), CLAIMS);
    const b = await signAccessToken(env(), CLAIMS);
    expect(await verifier.verify(a.token)).not.toBeNull();
    expect(await verifier.verify(b.token)).not.toBeNull();
    expect(calls).toBe(1);
    verifier.refresh();
    expect(await verifier.verify(a.token)).not.toBeNull();
    expect(calls).toBe(2);
  });

  test("rejects HS256 tokens — a remote verifier must not hold the secret", async () => {
    const symmetric = await signAccessToken(
      { AUTH_SECRET: "test-secret-not-for-prod-but-stable-across-calls", APP_URL },
      CLAIMS,
    );
    const verifier = createTokenVerifier({ url: APP_URL, fetch: jwksFetch });
    expect(await verifier.verify(symmetric.token)).toBeNull();
  });

  test("rejects a tampered payload", async () => {
    const { token } = await signAccessToken(env(), CLAIMS);
    const [head, , sig] = token.split(".") as [string, string, string];
    const forged = btoa(JSON.stringify({ ...CLAIMS, plane: "app", typ: "access", exp: 9e9 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const verifier = createTokenVerifier({ url: APP_URL, fetch: jwksFetch });
    expect(await verifier.verify(`${head}.${forged}.${sig}`)).toBeNull();
  });

  test("rejects an expired token", async () => {
    const { token } = await signAccessToken(env(), CLAIMS, -10);
    const verifier = createTokenVerifier({ url: APP_URL, fetch: jwksFetch });
    expect(await verifier.verify(token)).toBeNull();
  });

  test("enforces the expected issuer when one is configured", async () => {
    const { token } = await signAccessToken(env(), CLAIMS);
    const ok = createTokenVerifier({ url: APP_URL, fetch: jwksFetch, issuer: APP_URL });
    const wrong = createTokenVerifier({
      url: APP_URL,
      fetch: jwksFetch,
      issuer: "https://someone-else.test",
    });
    expect(await ok.verify(token)).not.toBeNull();
    expect(await wrong.verify(token)).toBeNull();
  });

  test("ignores garbage without throwing", async () => {
    const verifier = createTokenVerifier({ url: APP_URL, fetch: jwksFetch });
    expect(await verifier.verify("not-a-jwt")).toBeNull();
    expect(await verifier.verify("pak_live_abc.def.ghi")).toBeNull();
  });

  test("a JWKS outage throws rather than silently 401-ing", async () => {
    const down = (() =>
      Promise.resolve(new Response("nope", { status: 503 }))) as unknown as typeof fetch;
    const verifier = createTokenVerifier({ url: APP_URL, fetch: down });
    const { token } = await signAccessToken(env(), CLAIMS);
    expect(verifier.verify(token)).rejects.toThrow(/JWKS fetch failed/);
  });
});
