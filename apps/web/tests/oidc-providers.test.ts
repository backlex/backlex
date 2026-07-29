/**
 * Generic OIDC / OAuth2 identity providers.
 *
 * The value of this feature is that Okta / Auth0 / Keycloak / Entra / GitLab
 * are one code path, so the tests worth having are about the *edges* of that
 * path: the secret never coming back out, the discovery resolution refusing
 * anything but https, slug collisions, and a workspace never seeing another's
 * providers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  createOidcProvider,
  deleteOidcProvider,
  discoverOidcEndpoints,
  listOidcProviders,
  loadOidcProvidersForAuth,
  updateOidcProvider,
} from "../src/server/services/oidc-providers";
import { makeHarness, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;
let ctx: { db: any; dialect: "sqlite" };

const SECRET = "sso-client-secret-DO-NOT-LEAK";

/** The tenants table has a FK from oidc_providers — seed the rows we scope to. */
const seedTenant = (id: string, slug: string) =>
  client
    .query(
      "insert into tenants (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)",
    )
    .run(id, slug, slug, Date.now(), Date.now());

const base = {
  name: "Okta",
  slug: "okta",
  clientId: "0oa123",
  clientSecret: SECRET,
  discoveryUrl: "https://example.okta.test/.well-known/openid-configuration",
};

beforeEach(() => {
  h = makeHarness();
  client = new Database(h.env.SQLITE_PATH as string);
  ctx = { db: drizzle({ client }), dialect: "sqlite" };
  seedTenant("t1", "one");
  seedTenant("t2", "two");
});
afterEach(() => h.cleanup());

describe("provider CRUD", () => {
  test("the client secret is encrypted at rest and never returned", async () => {
    const created = await createOidcProvider(ctx, "t1", base, h.env.AUTH_SECRET);
    expect(JSON.stringify(created)).not.toContain(SECRET);
    expect(created.hasClientSecret).toBe(true);

    const raw = client
      .query("select client_secret_enc as s from oidc_providers where id = ?")
      .get(created.id) as { s: string };
    expect(raw.s).not.toContain(SECRET);

    const listed = await listOidcProviders(ctx, "t1");
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });

  test("only the decrypted load path sees the secret", async () => {
    await createOidcProvider(ctx, "t1", base, h.env.AUTH_SECRET);
    const loaded = await loadOidcProvidersForAuth(ctx, h.env, "t1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.clientSecret).toBe(SECRET);
    expect(loaded[0]!.providerId).toBe("okta");
    expect(loaded[0]!.pkce).toBe(true);
  });

  test("a blank secret on update keeps the stored credential", async () => {
    const created = await createOidcProvider(ctx, "t1", base, h.env.AUTH_SECRET);
    await updateOidcProvider(ctx, "t1", created.id, { name: "Okta Prod" }, h.env.AUTH_SECRET);
    const loaded = await loadOidcProvidersForAuth(ctx, h.env, "t1");
    // The UI cannot read the secret back, so an omitted field must not blank it.
    expect(loaded[0]!.clientSecret).toBe(SECRET);
    expect((await listOidcProviders(ctx, "t1"))[0]!.name).toBe("Okta Prod");
  });

  test("a duplicate slug in the same workspace is a conflict", async () => {
    await createOidcProvider(ctx, "t1", base, h.env.AUTH_SECRET);
    await expect(createOidcProvider(ctx, "t1", base, h.env.AUTH_SECRET)).rejects.toThrow(
      /already exists/,
    );
  });

  test("the same slug in a different workspace is fine", async () => {
    await createOidcProvider(ctx, "t1", base, h.env.AUTH_SECRET);
    const other = await createOidcProvider(ctx, "t2", base, h.env.AUTH_SECRET);
    expect(other.slug).toBe("okta");
  });

  test("a provider needs a discovery URL or an explicit authorize+token pair", async () => {
    await expect(
      createOidcProvider(ctx, "t1", { ...base, discoveryUrl: null }, h.env.AUTH_SECRET),
    ).rejects.toThrow(/discoveryUrl, or both/);

    const explicit = await createOidcProvider(
      ctx,
      "t1",
      {
        ...base,
        slug: "keycloak",
        discoveryUrl: null,
        authorizationUrl: "https://kc.test/auth",
        tokenUrl: "https://kc.test/token",
      },
      h.env.AUTH_SECRET,
    );
    expect(explicit.slug).toBe("keycloak");
  });

  test("reserved and malformed slugs are rejected", async () => {
    for (const slug of ["google", "github", "apple", "mcp"]) {
      await expect(createOidcProvider(ctx, "t1", { ...base, slug }, h.env.AUTH_SECRET)).rejects.toThrow(
        /reserved/,
      );
    }
    for (const slug of ["-lead", "trail-", "a", "has space", "under_score"]) {
      await expect(createOidcProvider(ctx, "t1", { ...base, slug }, h.env.AUTH_SECRET)).rejects.toThrow(
        /slug must be/,
      );
    }
  });

  test("a slug is case-normalized rather than rejected", async () => {
    const created = await createOidcProvider(ctx, "t1", { ...base, slug: "Okta-EU" }, h.env.AUTH_SECRET);
    expect(created.slug).toBe("okta-eu");
    // …and the normalized form is what collides, so casing can't smuggle in a
    // second row that better-auth would see as the same providerId.
    await expect(
      createOidcProvider(ctx, "t1", { ...base, slug: "OKTA-eu" }, h.env.AUTH_SECRET),
    ).rejects.toThrow(/already exists/);
  });
});

describe("workspace isolation", () => {
  test("a workspace never lists or loads another's providers", async () => {
    await createOidcProvider(ctx, "t1", base, h.env.AUTH_SECRET);
    expect(await listOidcProviders(ctx, "t2")).toEqual([]);
    expect(await loadOidcProvidersForAuth(ctx, h.env, "t2")).toEqual([]);
  });

  test("update and delete are scoped to the owning workspace", async () => {
    const created = await createOidcProvider(ctx, "t1", base, h.env.AUTH_SECRET);
    await expect(
      updateOidcProvider(ctx, "t2", created.id, { name: "hijacked" }, h.env.AUTH_SECRET),
    ).rejects.toThrow(/not found/i);

    await deleteOidcProvider(ctx, "t2", created.id);
    expect(await listOidcProviders(ctx, "t1")).toHaveLength(1);
  });
});

describe("auth wiring", () => {
  test("a disabled provider is not handed to the auth instance", async () => {
    const created = await createOidcProvider(ctx, "t1", base, h.env.AUTH_SECRET);
    await updateOidcProvider(ctx, "t1", created.id, { enabled: false }, h.env.AUTH_SECRET);
    expect(await loadOidcProvidersForAuth(ctx, h.env, "t1")).toEqual([]);
  });

  test("a provider whose secret cannot be decrypted is dropped, not passed through blank", async () => {
    const created = await createOidcProvider(ctx, "t1", base, h.env.AUTH_SECRET);
    // Simulate a rotated AUTH_SECRET / corrupt ciphertext.
    client
      .query("update oidc_providers set client_secret_enc = ? where id = ?")
      .run("enc:not-really-ciphertext", created.id);
    // A blank secret would fail the token exchange and look like an IdP outage.
    expect(await loadOidcProvidersForAuth(ctx, h.env, "t1")).toEqual([]);
  });
});

describe("discovery", () => {
  const doc = {
    issuer: "https://idp.test",
    authorization_endpoint: "https://idp.test/authorize",
    token_endpoint: "https://idp.test/token",
    userinfo_endpoint: "https://idp.test/userinfo",
    scopes_supported: ["openid", "profile", "email", "groups"],
  };
  const ok = (async () =>
    new Response(JSON.stringify(doc), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  test("resolves the endpoints from a discovery document", async () => {
    const out = await discoverOidcEndpoints(h.env, "https://idp.test/.well-known/openid-configuration", ok);
    expect(out.authorizationUrl).toBe("https://idp.test/authorize");
    expect(out.tokenUrl).toBe("https://idp.test/token");
    expect(out.scopesSupported).toContain("groups");
  });

  test("a bare issuer origin gets the well-known path appended", async () => {
    let requested = "";
    const spy = (async (url: string) => {
      requested = String(url);
      return new Response(JSON.stringify(doc), { status: 200 });
    }) as unknown as typeof fetch;
    await discoverOidcEndpoints(h.env, "https://idp.test", spy);
    expect(requested).toBe("https://idp.test/.well-known/openid-configuration");
  });

  test("http is refused — a downgraded discovery could redirect sign-in", async () => {
    await expect(discoverOidcEndpoints(h.env, "http://idp.test", ok)).rejects.toThrow(/must use https/);
  });

  test("a document missing the required endpoints is a validation error", async () => {
    const partial = (async () =>
      new Response(JSON.stringify({ issuer: "https://idp.test" }), { status: 200 })) as unknown as typeof fetch;
    await expect(discoverOidcEndpoints(h.env, "https://idp.test", partial)).rejects.toThrow(
      /missing authorization_endpoint/,
    );
  });

  test("a non-200 response is reported rather than silently ignored", async () => {
    const dead = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(discoverOidcEndpoints(h.env, "https://idp.test", dead)).rejects.toThrow(/responded 404/);
  });
});
