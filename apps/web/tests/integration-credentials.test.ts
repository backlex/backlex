/**
 * The one place a stored connection becomes credentials a provider can call
 * with — `services/integration-credentials.ts`.
 *
 * Every path that reaches a provider has to do the same two things: decrypt the
 * secret config fields, and renew the OAuth access token before handing it over.
 * They were hand-written at each call site instead, and the surface that
 * arrived fifth (listings) did neither — so a listing connection would have
 * worked for the length of one access token and answered 401 ever after, with
 * nothing in the logs naming a token.
 *
 * The last test is the one that stops it happening a sixth time: `ensureAccessToken`
 * may only be reached through this module.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OAUTH_ACCESS_TOKEN_KEY, OAUTH_EXPIRES_AT_KEY, OAUTH_REFRESH_TOKEN_KEY } from "@backlex/integrations";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BASE = "/api/admin/integrations";
const SERVICES = join(import.meta.dir, "../src/server/services");

let h: TestHarness;
let client: Database;

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Airtable is the fixture, and the choice matters: Notion's tokens are declared
 * `nonExpiring`, so it never reaches the refresh path this file is about.
 * Nothing below is Airtable-specific.
 */
const connectProvider = async () => {
  client.query("delete from integrations where kind = 'airtable'").run();
  const res = await h.fetch(
    BASE,
    json({ kind: "airtable", config: { clientId: "cid", clientSecret: "csecret", baseId: "app1", tableName: "Tasks" } }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as any).data.id as string;
};

/** Put a token pair on the row directly, as the callback would have. */
const storeTokens = async (id: string, opts: { expiresAt: number | null }) => {
  const { encryptSecret } = await import("../src/server/lib/crypto");
  const secret = h.env.AUTH_SECRET as string;
  const config = {
    clientId: await encryptSecret("cid", secret),
    clientSecret: await encryptSecret("csecret", secret),
    baseId: "app1",
    [OAUTH_ACCESS_TOKEN_KEY]: await encryptSecret("stale-access", secret),
    [OAUTH_REFRESH_TOKEN_KEY]: await encryptSecret("refresh-1", secret),
    [OAUTH_EXPIRES_AT_KEY]: opts.expiresAt,
  };
  client.query("update integrations set config = ? where id = ?").run(JSON.stringify(config), id);
};

const rowOf = (id: string) =>
  client.query("select id, kind, tenant_id as tenantId, config, updated_at as updatedAt from integrations where id = ?").get(id) as {
    id: string;
    kind: string;
    tenantId: string | null;
    config: string;
    updatedAt: number | null;
  };

/** The row shaped the way `connectionConfigFor` wants it. */
const connectionRow = (id: string) => {
  const r = rowOf(id);
  return { id: r.id, kind: r.kind, tenantId: r.tenantId, config: JSON.parse(r.config), updatedAt: r.updatedAt };
};

const storedConfig = (id: string) => JSON.parse(rowOf(id).config) as Record<string, unknown>;

/** Stand in for the provider's token endpoint. */
const mockToken = (body: unknown, status = 200) => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (url.includes("/oauth2/v1/token")) {
      calls += 1;
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    return real(input, init);
  }) as typeof fetch;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
};

const resolve = async (id: string) => {
  const { buildContext } = await import("../src/server/context");
  const { connectionConfigFor } = await import("../src/server/services/integration-credentials");
  const ctx = await buildContext(h.env);
  return connectionConfigFor(ctx, connectionRow(id), h.env.AUTH_SECRET as string);
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
});
afterAll(() => h.cleanup());

describe("resolving a connection's credentials", () => {
  test("an expired access token is renewed before the provider is called", async () => {
    const id = await connectProvider();
    await storeTokens(id, { expiresAt: Date.now() - 60_000 });
    const mock = mockToken({ access_token: "fresh-access", refresh_token: "refresh-2", expires_in: 3600 });
    try {
      const config = await resolve(id);
      expect(mock.calls()).toBe(1);
      expect(config[OAUTH_ACCESS_TOKEN_KEY]).toBe("fresh-access");
    } finally {
      mock.restore();
    }
  });

  test("the renewed pair is written back ENCRYPTED, never as plaintext", async () => {
    const id = await connectProvider();
    await storeTokens(id, { expiresAt: Date.now() - 60_000 });
    const mock = mockToken({ access_token: "fresh-access", refresh_token: "refresh-2", expires_in: 3600 });
    try {
      await resolve(id);
    } finally {
      mock.restore();
    }
    // The refresh merges the new tokens into the config it was handed and
    // writes that row back. Handing it the DECRYPTED config would therefore
    // store every secret on the row in the clear — including the client secret,
    // which no part of this flow ever needs to rewrite.
    const stored = storedConfig(id);
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain("fresh-access");
    expect(raw).not.toContain("refresh-2");
    expect(raw).not.toContain("csecret");
    const { decryptSecret } = await import("../src/server/lib/crypto");
    const secret = h.env.AUTH_SECRET as string;
    expect(await decryptSecret(stored[OAUTH_ACCESS_TOKEN_KEY] as string, secret)).toBe("fresh-access");
    expect(await decryptSecret(stored[OAUTH_REFRESH_TOKEN_KEY] as string, secret)).toBe("refresh-2");
    expect(await decryptSecret(stored.clientSecret as string, secret)).toBe("csecret");
  });

  test("a token with life left in it is used as-is — no round trip", async () => {
    const id = await connectProvider();
    await storeTokens(id, { expiresAt: Date.now() + 3_600_000 });
    const mock = mockToken({ access_token: "should-not-be-fetched" });
    try {
      const config = await resolve(id);
      expect(mock.calls()).toBe(0);
      expect(config[OAUTH_ACCESS_TOKEN_KEY]).toBe("stale-access");
    } finally {
      mock.restore();
    }
  });

  test("the config comes back decrypted, so a provider gets values it can use", async () => {
    const id = await connectProvider();
    await storeTokens(id, { expiresAt: Date.now() + 3_600_000 });
    const config = await resolve(id);
    expect(config.clientSecret).toBe("csecret");
    expect(config.baseId).toBe("app1");
  });

  test("a revoked grant is UNAUTHORIZED, not a retryable failure", async () => {
    const id = await connectProvider();
    await storeTokens(id, { expiresAt: Date.now() - 60_000 });
    const mock = mockToken({ error: "invalid_grant" }, 400);
    try {
      await expect(resolve(id)).rejects.toThrow(/re-authorizing/i);
    } finally {
      mock.restore();
    }
  });

  test("losing the compare-and-set race leaves the winner's tokens in place", async () => {
    const id = await connectProvider();
    await storeTokens(id, { expiresAt: Date.now() - 60_000 });
    // Read the row as a caller would…
    const stale = connectionRow(id);
    // …then let a concurrent refresh land first. `updated_at` moves, and with
    // it the version this write is allowed to overwrite.
    const { encryptSecret } = await import("../src/server/lib/crypto");
    const secret = h.env.AUTH_SECRET as string;
    const winner = {
      ...JSON.parse(rowOf(id).config),
      [OAUTH_ACCESS_TOKEN_KEY]: await encryptSecret("winner-access", secret),
      [OAUTH_REFRESH_TOKEN_KEY]: await encryptSecret("winner-refresh", secret),
    };
    client
      .query("update integrations set config = ?, updated_at = ? where id = ?")
      .run(JSON.stringify(winner), Date.now() + 1000, id);

    const mock = mockToken({ access_token: "loser-access", refresh_token: "loser-refresh", expires_in: 3600 });
    try {
      const { buildContext } = await import("../src/server/context");
      const { connectionConfigFor } = await import("../src/server/services/integration-credentials");
      const ctx = await buildContext(h.env);
      // The caller still gets a usable token — the one it just obtained is
      // valid for this call. What it must NOT do is put its refresh token back
      // over the winner's, which the provider has already retired.
      const config = await connectionConfigFor(ctx, stale, secret);
      expect(config[OAUTH_ACCESS_TOKEN_KEY]).toBe("loser-access");
    } finally {
      mock.restore();
    }
    const { decryptSecret } = await import("../src/server/lib/crypto");
    expect(await decryptSecret(storedConfig(id)[OAUTH_REFRESH_TOKEN_KEY] as string, secret)).toBe("winner-refresh");
  });
});

describe("the chokepoint is the only way in", () => {
  test("no service renews a token on its own", () => {
    // Four surfaces hand-wrote decrypt-then-refresh; the fifth wrote neither,
    // and nothing could have told anyone. A sixth is coming (eBay, Etsy and
    // Allegro all connect over OAuth), so the rule is enforced rather than
    // remembered: `ensureAccessToken` is reached through
    // `integration-credentials.ts` or not at all.
    // Liveness first. The scan below reports SUCCESS when it matches nothing,
    // so a rename of `ensureAccessToken` would retire this rule silently and
    // look identical to a repo that obeys it. Verified 2026-08-30 by renaming
    // the searched symbol: the whole file stayed green. Pin the two halves the
    // scan depends on — that the chokepoint still owns the function, and that
    // the census reaches the service directory at all.
    const scanned = readdirSync(SERVICES).filter((f) => f.endsWith(".ts"));
    expect(`services scanned: ${scanned.length > 100}`).toBe("services scanned: true");
    expect(
      `integration-credentials.ts still defines ensureAccessToken: ${readFileSync(
        join(SERVICES, "integration-credentials.ts"),
        "utf8",
      ).includes("ensureAccessToken")}`,
    ).toBe("integration-credentials.ts still defines ensureAccessToken: true");

    const offenders = scanned
      .filter((f) => f !== "integrations-oauth.ts" && f !== "integration-credentials.ts")
      .filter((f) => readFileSync(join(SERVICES, f), "utf8").includes("ensureAccessToken"));
    expect(offenders).toEqual([]);
  });

  test("every runner that calls a provider resolves its config through it", () => {
    // The five surfaces that exist today. Named individually rather than
    // scanned for, because the assertion worth making is "this file, which
    // reaches a provider, goes through the chokepoint" — and a scan would go
    // quiet the moment a new runner arrived under a name the pattern missed.
    for (const file of [
      "integrations.ts",
      "integration-syncs.ts",
      "integration-tasks.ts",
      "integration-webhooks.ts",
      "integration-listings.ts",
    ]) {
      const src = readFileSync(join(SERVICES, file), "utf8");
      expect(src).toContain("connectionConfigFor");
    }
  });
});
