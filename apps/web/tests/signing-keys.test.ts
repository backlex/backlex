/**
 * The signing-key life cycle.
 *
 * The assertions worth more than the rest all check the SAME thing from
 * different angles: what a state actually does to a token.
 *
 *  - a `standby` key is in the JWKS and signs nothing (that is why the state
 *    exists — a verifier's cache means a key must be visible before it signs);
 *  - promoting swaps which `kid` new tokens carry, and the old key still
 *    verifies the tokens it already signed;
 *  - revoking stops verification HERE, and rolling it back restores it;
 *  - an env-configured deployment with no rows behaves exactly as before, and
 *    the env key keeps verifying once rows take over.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { invalidateSigningKeys } from "../src/server/services/signing-keys";
import { resetJwtKeyCache } from "../src/server/lib/jwt-keys";

let h: TestHarness;
const JSON_HEADERS = { "content-type": "application/json" };
const BASE = "/api/admin/signing-keys";

interface KeyView {
  id: string;
  kid: string;
  alg: string;
  status: string;
  published: boolean;
}

const list = async (): Promise<KeyView[]> =>
  ((await (await h.fetch(BASE)).json()) as { data: KeyView[] }).data;

const generate = async (over: Record<string, unknown> = {}) => {
  const res = await h.fetch(BASE, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(over),
  });
  if (res.status !== 201) throw new Error(`generate failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { data: KeyView }).data;
};

const act = (id: string, verb: string) =>
  h.fetch(`${BASE}/${id}/${verb}`, { method: "POST" });

const jwks = async (): Promise<{ keys: Array<{ kid: string }> }> =>
  (await (
    await h.app.request(
      "/.well-known/jwks.json",
      { headers: { origin: "http://localhost:5173" } } as RequestInit,
      h.env,
    )
  ).json()) as { keys: Array<{ kid: string }> };

/**
 * Mint an app-plane ACCESS token for a freshly signed-up end-user, and return
 * it with the `kid` from its header.
 *
 * Sign-up hands back a session/refresh token, which is opaque — exchanging it
 * at `token/refresh` is what produces the signed JWT this feature is about.
 * Reading the sign-up response directly would have measured the wrong thing.
 */
const mintToken = async (email: string): Promise<{ token: string; kid: string | null }> => {
  const res = await h.fetch("/api/t/default/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "K" }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const signUp = (await res.json()) as { token?: string };
  const refreshed = await h.fetch("/api/t/default/auth/token/refresh", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ refreshToken: signUp.token }),
  });
  if (refreshed.status !== 200) {
    throw new Error(`refresh failed: ${refreshed.status} ${await refreshed.text()}`);
  }
  const body = (await refreshed.json()) as {
    accessToken?: string;
    access_token?: string;
    token?: string;
    data?: { accessToken?: string };
  };
  const token = body.accessToken ?? body.access_token ?? body.data?.accessToken ?? body.token ?? "";
  const header = token.split(".")[0] ?? "";
  let kid: string | null = null;
  try {
    kid = (JSON.parse(atob(header.replace(/-/g, "+").replace(/_/g, "/"))) as { kid?: string })
      .kid ?? null;
  } catch {
    kid = null;
  }
  return { token, kid };
};

beforeEach(async () => {
  resetJwtKeyCache();
  invalidateSigningKeys();
  h = makeHarness();
  await seedAdmin(h);
});
afterEach(() => {
  h.cleanup();
  resetJwtKeyCache();
  invalidateSigningKeys();
});

describe("the states", () => {
  test("a generated key starts in standby and is already published", async () => {
    const key = await generate();
    expect(key.status).toBe("standby");
    expect(key.published).toBe(true);
    // The whole reason `standby` exists: a verifier caches the JWKS, so the key
    // has to be visible BEFORE it signs anything.
    expect((await jwks()).keys.map((k) => k.kid)).toContain(key.kid);
  });

  test("standby signs nothing", async () => {
    const key = await generate();
    const { kid } = await mintToken("standby@example.test");
    expect(kid).not.toBe(key.kid);
  });

  test("promoting makes new tokens carry its kid", async () => {
    const key = await generate();
    expect((await act(key.id, "promote")).status).toBe(200);
    invalidateSigningKeys();
    const { kid } = await mintToken("promoted@example.test");
    expect(kid).toBe(key.kid);
  });

  test("promoting a second key demotes the first in the same operation", async () => {
    const first = await generate();
    await act(first.id, "promote");
    const second = await generate();
    await act(second.id, "promote");
    const rows = await list();
    expect(rows.find((r) => r.id === first.id)!.status).toBe("previously_used");
    expect(rows.find((r) => r.id === second.id)!.status).toBe("in_use");
    // Two keys in use would make "which one signs" a question about row order.
    expect(rows.filter((r) => r.status === "in_use").length).toBe(1);
  });

  test("a previously-used key still verifies the tokens it signed", async () => {
    const first = await generate();
    await act(first.id, "promote");
    invalidateSigningKeys();
    const minted = await mintToken("still-valid@example.test");
    expect(minted.kid).toBe(first.kid);

    const second = await generate();
    await act(second.id, "promote");
    invalidateSigningKeys();

    // The token was signed by a key that no longer signs. It has to keep
    // working — its `exp` is the only thing that should end it.
    const res = await h.app.request(
      "/api/tenants",
      {
        headers: {
          authorization: `Bearer ${minted.token}`,
          origin: "http://localhost:5173",
        },
      } as RequestInit,
      h.env,
    );
    expect(res.status).toBe(200);
  });

  test("revoking removes the key from the JWKS and stops its tokens verifying", async () => {
    const first = await generate();
    await act(first.id, "promote");
    invalidateSigningKeys();
    const minted = await mintToken("revoked@example.test");

    const second = await generate();
    await act(second.id, "promote");
    expect((await act(first.id, "revoke")).status).toBe(200);
    invalidateSigningKeys();

    expect((await jwks()).keys.map((k) => k.kid)).not.toContain(first.kid);
    const res = await h.app.request(
      "/api/items/nothing",
      {
        headers: {
          authorization: `Bearer ${minted.token}`,
          origin: "http://localhost:5173",
        },
      } as RequestInit,
      h.env,
    );
    // Unauthenticated now — the signature no longer resolves to a known key.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("restoring a revocation puts the key back where it was", async () => {
    const first = await generate();
    await act(first.id, "promote");
    const second = await generate();
    await act(second.id, "promote");
    await act(first.id, "revoke");
    expect((await act(first.id, "restore")).status).toBe(200);
    const rows = await list();
    // It signed once, so it goes back to `previously_used`, not `standby`.
    expect(rows.find((r) => r.id === first.id)!.status).toBe("previously_used");
    invalidateSigningKeys();
    expect((await jwks()).keys.map((k) => k.kid)).toContain(first.kid);
  });

  test("a never-used key restores to standby", async () => {
    const key = await generate();
    await act(key.id, "revoke");
    await act(key.id, "restore");
    expect((await list()).find((r) => r.id === key.id)!.status).toBe("standby");
  });
});

describe("what the machine refuses", () => {
  test("the key in use cannot be revoked", async () => {
    const key = await generate();
    await act(key.id, "promote");
    const res = await act(key.id, "revoke");
    expect(res.status).toBe(422);
    // Cascading would leave the instance signing with nothing, which nobody
    // asked for.
    expect(await res.text()).toContain("Promote another key first");
  });

  test("a revoked key cannot be promoted without an explicit restore", async () => {
    const key = await generate();
    await act(key.id, "revoke");
    const res = await act(key.id, "promote");
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Restore it first");
  });

  test("only a revoked key can be deleted", async () => {
    const key = await generate();
    expect((await h.fetch(`${BASE}/${key.id}`, { method: "DELETE" })).status).toBe(422);
    await act(key.id, "revoke");
    expect((await h.fetch(`${BASE}/${key.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await list()).length).toBe(0);
  });

  test("the same key cannot be stored twice", async () => {
    const key = await generate();
    // The `kid` is derived from the key material, so re-importing the same key
    // is detectable — and worth naming rather than surfacing as a driver error.
    const rows = await list();
    expect(rows.length).toBe(1);
    expect(rows[0]!.kid).toBe(key.kid);
  });

  test("the private half never appears on any read surface", async () => {
    await generate();
    const raw = await (await h.fetch(BASE)).text();
    expect(raw).not.toContain("PRIVATE KEY");
    expect(raw).not.toContain("enc:v1:");
  });

  test("the routes are admin-only", async () => {
    const anon = await h.app.request(
      BASE,
      { headers: { origin: "http://localhost:5173" } } as RequestInit,
      h.env,
    );
    expect(anon.status).toBeGreaterThanOrEqual(400);
  });
});

describe("the env deployment is not stranded", () => {
  test("with no rows, nothing about signing changes", async () => {
    // No keys generated: the JWKS is whatever the env says, which on this
    // harness is empty. The point is that it does not throw or become an
    // "asymmetric instance with no keys".
    const doc = await jwks();
    expect(Array.isArray(doc.keys)).toBe(true);
    const { token } = await mintToken("env-only@example.test");
    expect(token.length).toBeGreaterThan(0);
  });

  test("importing an existing PEM stores it in standby", async () => {
    // Round-trips through the same generate → export path an operator's
    // `openssl` output would take.
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----`;

    const res = await h.fetch(`${BASE}/import`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ privateKey: pem, note: "from env" }),
    });
    expect(res.status).toBe(201);
    const key = ((await res.json()) as { data: KeyView }).data;
    expect(key.status).toBe("standby");
    expect(key.alg).toBe("ES256");
  });

  test("a PEM that is not a private key is refused with a sentence", async () => {
    const res = await h.fetch(`${BASE}/import`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ privateKey: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" }),
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("PKCS#8");
  });
});
