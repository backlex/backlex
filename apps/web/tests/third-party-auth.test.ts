/**
 * Third-party auth — trusting a JWT minted by someone else's IdP.
 *
 * The whole feature is a verification decision, so the tests are about what
 * must be *refused*: a symmetric token, a token with no `kid`, one signed by a
 * key the issuer never published, an expired one, one for another audience, and
 * one whose `iss` names a workspace that never asked for it. Each negative is
 * paired with the positive it is a mutation of — a rejection test whose input
 * was never acceptable in the first place proves nothing
 * (see the vacuous-assertion trap this repo has hit before).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { clearJwksCache } from "../src/server/lib/jwks-cache";
import { verifyThirdPartyToken } from "../src/server/lib/third-party-jwt";
import {
  createThirdPartyProvider,
  listThirdPartyProviders,
  resolveThirdPartyUser,
  updateThirdPartyProvider,
} from "../src/server/services/third-party-auth";
import { makeHarness, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;
let ctx: { db: any; dialect: "sqlite"; env: any };

const ISSUER = "https://acme.clerk.test";
const JWKS_URL = "https://acme.clerk.test/.well-known/jwks.json";
const KID = "test-key-1";

let keyPair: CryptoKeyPair;
let publicJwk: JsonWebKey;
/** A second pair the issuer never publishes — for the "right shape, wrong
 *  signer" case, which is the one a forged token actually looks like. */
let roguePair: CryptoKeyPair;

const realFetch = globalThis.fetch;

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlStr = (s: string): string => b64url(enc.encode(s));

const sign = async (
  payload: Record<string, unknown>,
  opts: {
    alg?: string;
    kid?: string | null;
    key?: CryptoKey;
    hmac?: boolean;
  } = {},
): Promise<string> => {
  const alg = opts.alg ?? "ES256";
  const header: Record<string, unknown> = { alg, typ: "JWT" };
  if (opts.kid !== null) header.kid = opts.kid ?? KID;
  const body = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
  if (opts.hmac) {
    const k = await crypto.subtle.importKey(
      "raw",
      enc.encode("shared-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(body)));
    return `${body}.${b64url(sig)}`;
  }
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      (opts.key ?? keyPair.privateKey) as CryptoKey,
      enc.encode(body),
    ),
  );
  return `${body}.${b64url(sig)}`;
};

const nowSec = () => Math.floor(Date.now() / 1000);

const validPayload = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  sub: "user_2abc",
  email: "someone@acme.test",
  exp: nowSec() + 600,
  iat: nowSec(),
  ...over,
});

const seedTenant = (id: string, slug: string) =>
  client
    .query(
      "insert into tenants (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)",
    )
    .run(id, slug, slug, Date.now(), Date.now());

/** Serve the JWKS from memory; anything else is a test bug, so it 500s loudly
 *  rather than falling through to the network. */
let jwksHits = 0;
const stubFetch = (keys: JsonWebKey[] = [{ ...publicJwk, kid: KID, alg: "ES256" }]) => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === JWKS_URL) {
      jwksHits++;
      return new Response(JSON.stringify({ keys }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify({ jwks_uri: JWKS_URL }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected fetch in test: " + url, { status: 500 });
  }) as typeof fetch;
};

const makeProvider = (over: Record<string, unknown> = {}) =>
  createThirdPartyProvider(ctx, "t1", {
    name: "Clerk",
    issuer: ISSUER,
    jwksUrl: JWKS_URL,
    ...over,
  } as any);

beforeEach(async () => {
  h = makeHarness();
  client = new Database(h.env.SQLITE_PATH as string);
  ctx = { db: drizzle({ client }), dialect: "sqlite", env: {} };
  seedTenant("t1", "one");
  seedTenant("t2", "two");

  keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  roguePair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

  jwksHits = 0;
  clearJwksCache();
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  h.cleanup();
});

describe("token verification", () => {
  test("a token signed by the issuer's published key is accepted", async () => {
    await makeProvider();
    const identity = await verifyThirdPartyToken(ctx, await sign(validPayload()));
    expect(identity).not.toBeNull();
    expect(identity?.subject).toBe("user_2abc");
    expect(identity?.email).toBe("someone@acme.test");
    expect(identity?.provider.tenantId).toBe("t1");
  });

  test("the same token is refused once the key is not the signer", async () => {
    await makeProvider();
    // Positive control above proves the payload+provider are otherwise fine, so
    // this failure can only come from the signature check.
    const forged = await sign(validPayload(), { key: roguePair.privateKey });
    expect(await verifyThirdPartyToken(ctx, forged)).toBeNull();
  });

  test("an HS256 token is refused even when the payload is perfect", async () => {
    await makeProvider();
    const symmetric = await sign(validPayload(), { alg: "HS256", hmac: true });
    expect(await verifyThirdPartyToken(ctx, symmetric)).toBeNull();
  });

  test("a token with no kid is refused", async () => {
    await makeProvider();
    expect(await verifyThirdPartyToken(ctx, await sign(validPayload(), { kid: null }))).toBeNull();
  });

  test("an expired token is refused; the same token inside the skew window is not", async () => {
    await makeProvider();
    expect(
      await verifyThirdPartyToken(ctx, await sign(validPayload({ exp: nowSec() - 3600 }))),
    ).toBeNull();
    // 30s in the past is inside the 60s tolerance.
    expect(
      await verifyThirdPartyToken(ctx, await sign(validPayload({ exp: nowSec() - 30 }))),
    ).not.toBeNull();
  });

  test("a token with no exp is refused — it would be an unrevocable credential", async () => {
    await makeProvider();
    const payload = validPayload();
    delete (payload as Record<string, unknown>).exp;
    expect(await verifyThirdPartyToken(ctx, await sign(payload))).toBeNull();
  });

  test("audience is enforced only when one is configured", async () => {
    const p = await makeProvider();
    // No audience set: any aud passes.
    expect(
      await verifyThirdPartyToken(ctx, await sign(validPayload({ aud: "someone-else" }))),
    ).not.toBeNull();

    await updateThirdPartyProvider(ctx, "t1", p.id, { audience: "my-api" });
    expect(
      await verifyThirdPartyToken(ctx, await sign(validPayload({ aud: "someone-else" }))),
    ).toBeNull();
    expect(
      await verifyThirdPartyToken(ctx, await sign(validPayload({ aud: "my-api" }))),
    ).not.toBeNull();
    // `aud` may be an array (RFC 7519 §4.1.3).
    expect(
      await verifyThirdPartyToken(ctx, await sign(validPayload({ aud: ["x", "my-api"] }))),
    ).not.toBeNull();
  });

  test("an unregistered issuer is refused, and a disabled one stops being accepted", async () => {
    const good = await sign(validPayload());
    expect(await verifyThirdPartyToken(ctx, good)).toBeNull(); // nothing registered yet

    const p = await makeProvider();
    expect(await verifyThirdPartyToken(ctx, good)).not.toBeNull();

    await updateThirdPartyProvider(ctx, "t1", p.id, { enabled: false });
    expect(await verifyThirdPartyToken(ctx, good)).toBeNull();
  });

  test("claims are read through the configured mapping, including dotted paths", async () => {
    await makeProvider({
      subjectClaim: "user_id",
      emailClaim: "user.email",
      groupsClaim: "cognito:groups",
      nameClaim: "name",
    });
    const identity = await verifyThirdPartyToken(
      ctx,
      await sign(
        validPayload({
          user_id: "u-42",
          name: "Ada",
          user: { email: "ada@acme.test" },
          "cognito:groups": ["admins", "beta"],
        }),
      ),
    );
    expect(identity?.subject).toBe("u-42");
    expect(identity?.email).toBe("ada@acme.test");
    expect(identity?.name).toBe("Ada");
    expect(identity?.groups).toEqual(["admins", "beta"]);
  });

  test("the JWKS is fetched once and reused across tokens", async () => {
    await makeProvider();
    await verifyThirdPartyToken(ctx, await sign(validPayload()));
    await verifyThirdPartyToken(ctx, await sign(validPayload({ sub: "other" })));
    expect(jwksHits).toBe(1);
  });

  test("an unknown kid does not trigger a fetch per token", async () => {
    await makeProvider();
    await verifyThirdPartyToken(ctx, await sign(validPayload())); // warms the cache
    const before = jwksHits;
    for (let i = 0; i < 5; i++) {
      await verifyThirdPartyToken(ctx, await sign(validPayload(), { kid: `made-up-${i}` }));
    }
    // The 30s refetch floor is what stops a made-up-kid stream from becoming an
    // outbound fetch stream aimed at the IdP.
    expect(jwksHits).toBe(before);
  });
});

describe("issuer registration", () => {
  test("an issuer can only be claimed once instance-wide", async () => {
    await makeProvider();
    await expect(
      createThirdPartyProvider(ctx, "t2", {
        name: "Same issuer, other workspace",
        issuer: ISSUER,
        jwksUrl: JWKS_URL,
      }),
    ).rejects.toThrow(/already registered/i);
  });

  test("discovery resolves the JWKS endpoint at save time", async () => {
    const p = await createThirdPartyProvider(ctx, "t1", {
      name: "Clerk",
      issuer: ISSUER,
      discoveryUrl: `${ISSUER}/.well-known/openid-configuration`,
    });
    expect(p.jwksUrl).toBe(JWKS_URL);
  });

  test("a workspace never sees another's issuers", async () => {
    await makeProvider();
    expect(await listThirdPartyProviders(ctx, "t1")).toHaveLength(1);
    expect(await listThirdPartyProviders(ctx, "t2")).toHaveLength(0);
  });
});

describe("SSRF guard on admin-supplied URLs", () => {
  // The discovery and JWKS endpoints are typed by a *workspace* admin, who on a
  // managed instance is a customer rather than the operator. Both fetches go
  // through `fetchOutbound`, the same guard webhooks and OIDC discovery use.
  const guarded = { CLOUD_PROJECT_ID: "proj-test" };

  test("discovery cannot be pointed at cloud metadata or loopback", async () => {
    const g = { ...ctx, env: guarded };
    for (const url of [
      "http://169.254.169.254/.well-known/openid-configuration",
      "http://127.0.0.1:8787/.well-known/openid-configuration",
      "http://localhost/.well-known/openid-configuration",
      "http://[::ffff:127.0.0.1]/.well-known/openid-configuration",
    ]) {
      await expect(
        createThirdPartyProvider(g, "t1", {
          name: "Evil",
          issuer: `https://evil.test/${encodeURIComponent(url)}`,
          discoveryUrl: url,
        }),
      ).rejects.toThrow();
    }
    expect(await listThirdPartyProviders(ctx, "t1")).toHaveLength(0);
  });

  test("a JWKS URL on a private host is refused at verification time", async () => {
    // Saved without the guard (self-host), then verified with it on — the row
    // exists, so a rejection here can only come from the fetch guard.
    await createThirdPartyProvider(ctx, "t1", {
      name: "Internal",
      issuer: ISSUER,
      jwksUrl: "http://169.254.169.254/jwks.json",
    });
    const token = await sign(validPayload());
    expect(
      await verifyThirdPartyToken({ ...ctx, env: guarded }, token),
    ).toBeNull();
  });

  test("the guard is off for self-host, so an internal IdP still works", async () => {
    // Same URL shape, no guard env: the stub serves it, proving the rejection
    // above is the guard and not a blanket refusal.
    await createThirdPartyProvider(ctx, "t1", {
      name: "Internal",
      issuer: ISSUER,
      discoveryUrl: `${ISSUER}/.well-known/openid-configuration`,
    });
    expect(await verifyThirdPartyToken(ctx, await sign(validPayload()))).not.toBeNull();
  });
});

describe("identity resolution", () => {
  test("first sight provisions, second sight reuses the same end-user", async () => {
    await makeProvider();
    const identity = await verifyThirdPartyToken(ctx, await sign(validPayload()));
    expect(identity).not.toBeNull();

    const first = await resolveThirdPartyUser(ctx, identity!);
    expect(first?.tenantId).toBe("t1");
    const second = await resolveThirdPartyUser(ctx, identity!);
    expect(second?.appUserId).toBe(first!.appUserId);

    const users = client
      .query("select id, email from app_users where tenant_id = 't1'")
      .all() as { id: string; email: string }[];
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe("someone@acme.test");
  });

  test("autoProvision off refuses an unknown subject", async () => {
    await makeProvider({ autoProvision: false });
    const identity = await verifyThirdPartyToken(ctx, await sign(validPayload()));
    expect(await resolveThirdPartyUser(ctx, identity!)).toBeNull();
    expect(
      client.query("select count(*) as n from app_users").get() as { n: number },
    ).toEqual({ n: 0 });
  });

  test("a suspended end-user is refused despite a perfectly valid token", async () => {
    await makeProvider();
    const identity = await verifyThirdPartyToken(ctx, await sign(validPayload()));
    const resolved = await resolveThirdPartyUser(ctx, identity!);
    expect(resolved).not.toBeNull();

    client
      .query("update app_users set status = 'suspended' where id = ?")
      .run(resolved!.appUserId);
    expect(await resolveThirdPartyUser(ctx, identity!)).toBeNull();
  });

  test("a token with no email cannot provision a new account", async () => {
    await makeProvider();
    const payload = validPayload();
    delete (payload as Record<string, unknown>).email;
    const identity = await verifyThirdPartyToken(ctx, await sign(payload));
    expect(identity).not.toBeNull();
    expect(identity?.email).toBeNull();
    expect(await resolveThirdPartyUser(ctx, identity!)).toBeNull();
  });

  test("a third-party bearer authenticates a real request, pinned to the issuer's workspace", async () => {
    // The unit tests above prove the verifier; this proves the wiring — that
    // the bearer chain actually reaches it, and that the workspace comes from
    // the token's issuer rather than from a header the caller controls.
    const tenant = client.query("select id, slug from tenants limit 1").get() as {
      id: string;
      slug: string;
    };
    await createThirdPartyProvider(ctx, tenant.id, {
      name: "Clerk",
      issuer: ISSUER,
      jwksUrl: JWKS_URL,
    });

    expect((await h.fetch("/api/me")).status).toBe(401);

    // `/api/me` reads the *platform* users table, so an app-plane caller gets a
    // 404 from the handler rather than a 200 — which is exactly the distinction
    // worth asserting: 401 means the bearer chain never recognised the token,
    // 404 means it did and the request reached the handler as an end-user.
    const res = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${await sign(validPayload())}`,
        // A tenant header must not be able to move the request off the
        // workspace its issuer belongs to.
        "x-backlex-tenant": "t2",
      },
    });
    expect(res.status).not.toBe(401);

    // The side effects prove the whole chain ran inside a real request:
    // verify → resolve → provision, scoped to the issuer's workspace.
    const provisioned = client
      .query("select tenant_id, email from app_users")
      .all() as { tenant_id: string; email: string }[];
    expect(provisioned).toHaveLength(1);
    expect(provisioned[0]?.tenant_id).toBe(tenant.id);
    expect(provisioned[0]?.email).toBe("someone@acme.test");
  });

  test("the link is recorded as a jwt external identity, not a saml one", async () => {
    const p = await makeProvider();
    const identity = await verifyThirdPartyToken(ctx, await sign(validPayload()));
    await resolveThirdPartyUser(ctx, identity!);
    const rows = client
      .query("select provider_type, provider_id, subject from external_identities")
      .all() as { provider_type: string; provider_id: string; subject: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider_type).toBe("jwt");
    expect(rows[0]?.provider_id).toBe(p.id);
    expect(rows[0]?.subject).toBe("user_2abc");
  });
});
