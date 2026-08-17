/**
 * `/auth/providers` is the one endpoint whose entire job is telling a frontend
 * which sign-in buttons to draw. Three declarations describe its `kind`, and
 * they had all drifted apart:
 *
 *   - the server's own `PublicProvider` (`services/auth-config.ts`) — 7 kinds
 *   - the published SDK's (`packages/client/src/core.ts`) — 5, and no `loginUrl`
 *   - the OpenAPI schema (`routes/auth-public.ts`) — neither field at all,
 *     `.passthrough()` keeping the RESPONSE right while the CONTRACT stayed
 *     three fields wide, and the ten polyglot SDKs are generated from that.
 *
 * The failure this causes is silent in the worst way: the values are present in
 * the JSON, so nothing errors — an application narrowing on `kind` just drops
 * every SSO provider its types have never heard of, and the operator who
 * configured the IdP sees no button and no error.
 *
 * The second half is the bug that made the drift visible. A workspace OIDC
 * provider was fully live at sign-in time — `tenant-auth.ts` hands every
 * enabled row to better-auth's `genericOAuth` plugin — and appeared in NO
 * provider list, so it could be configured, would work, and could not be
 * offered.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createOidcProvider, updateOidcProvider } from "../src/server/services/oidc-providers";
import { resolveAuthSurface } from "../src/server/services/auth-config";
import { makeHarness, type TestHarness } from "./setup";

const REPO = join(import.meta.dir, "..", "..", "..");
const read = (p: string) => readFileSync(p, "utf8");

/** Every string literal in the `kind:` member of one interface, in order. */
const kindUnion = (src: string, iface: string): string[] => {
  const start = src.search(new RegExp(`^export interface ${iface}\\b[^{]*\\{`, "m"));
  if (start === -1) throw new Error(`no \`export interface ${iface}\``);
  const body = src.slice(start, src.indexOf("\n}", start));
  const at = body.search(/^ {2}kind:/m);
  if (at === -1) throw new Error(`${iface} has no \`kind\` member`);
  const member = body.slice(at, body.indexOf(";", at));
  return [...member.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
};

describe("the provider list means the same thing on both sides of the wire", () => {
  const serverSrc = read(join(REPO, "apps", "web", "src", "server", "services", "auth-config.ts"));
  const sdkSrc = read(join(REPO, "packages", "client", "src", "core.ts"));
  const routeSrc = read(join(REPO, "apps", "web", "src", "server", "routes", "auth-public.ts"));

  test("every hand-written copy of the union types what the server can emit", () => {
    // Order too: these are read top-to-bottom by a human deciding what to
    // render, and a set-equal assertion would let them diverge into two
    // differently-ordered lists that are annoying to compare by eye.
    //
    // The admin SPA keeps a FOURTH copy. It never renders an `oidc` provider —
    // those rows only reach the tenant better-auth instance — but a narrower
    // type is how the last drift started, so it is held to the same list.
    const adminSrc = read(join(REPO, "apps", "web", "src", "client", "lib", "auth.ts"));
    for (const [what, src] of [
      ["sdk", sdkSrc],
      ["admin-spa", adminSrc],
    ] as const) {
      expect({ [what]: kindUnion(src, "PublicProvider") }).toEqual({
        [what]: kindUnion(serverSrc, "PublicProvider"),
      });
    }
  });

  test("the OpenAPI schema declares the same kinds", () => {
    // The generated spec is what the ten polyglot SDKs are built from, so a
    // kind missing here is a kind those languages cannot name.
    const at = routeSrc.indexOf("kind: z.enum([");
    expect(at).toBeGreaterThan(-1);
    const literal = routeSrc.slice(at, routeSrc.indexOf("])", at));
    expect([...literal.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)).toEqual(
      kindUnion(serverSrc, "PublicProvider"),
    );
  });

  test("`loginUrl` is declared in all three, not just returned by one", () => {
    // It is what makes a SAML button clickable. The SDK had it in the JSON and
    // not in the type, which is exactly as useful as not having it.
    for (const [what, src] of [
      ["server", serverSrc],
      ["sdk", sdkSrc],
      ["openapi", routeSrc],
    ] as const) {
      expect(`${what}: ${/\bloginUrl[?:]/.test(src)}`).toBe(`${what}: true`);
    }
  });

  test("`signInOAuth2` is on the SDK, because `oidc` is a kind the list can now return", () => {
    // `signInSocial` posts to `/sign-in/social`, which does not know a
    // genericOAuth provider — advertising an `oidc` provider with no way to
    // enter it would be the same silent dead end in a new place.
    const authSrc = read(join(REPO, "packages", "client", "src", "clients", "auth.ts"));
    expect(authSrc).toContain("signInOAuth2");
    expect(authSrc).toContain("/sign-in/oauth2");
  });
});

const OKTA = {
  name: "Okta",
  slug: "okta",
  clientId: "0oa123",
  clientSecret: "s",
  discoveryUrl: "https://example.okta.test/.well-known/openid-configuration",
};

describe("a workspace OIDC provider reaches the list it is rendered from", () => {
  let h: TestHarness;
  let client: Database;
  let ctx: { db: any; dialect: "sqlite" };

  beforeEach(() => {
    h = makeHarness();
    client = new Database(h.env.SQLITE_PATH as string);
    ctx = { db: drizzle({ client }), dialect: "sqlite" };
    client
      .query("insert into tenants (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)")
      .run("t1", "one", "one", Date.now(), Date.now());
  });
  afterEach(() => h.cleanup());

  const kinds = async () =>
    (await resolveAuthSurface(ctx, h.env, "t1", "one")).providers.filter((p) => p.kind === "oidc");

  test("an enabled provider is listed, by slug, with no loginUrl", async () => {
    expect(await kinds()).toEqual([]);
    await createOidcProvider(ctx, "t1", OKTA, h.env.AUTH_SECRET);
    // The id is the slug because that is the string better-auth is configured
    // with — `signInOAuth2("okta")` has to reach the same provider.
    expect(await kinds()).toEqual([
      { id: "okta", kind: "oidc", label: "Okta", enabled: true },
    ]);
  });

  test("a disabled provider is not offered", async () => {
    const p = await createOidcProvider(
      ctx,
      "t1",
      OKTA,
      h.env.AUTH_SECRET,
    );
    await updateOidcProvider(ctx, "t1", p.id, { enabled: false }, h.env.AUTH_SECRET);
    expect(await kinds()).toEqual([]);
  });

  test("one workspace never sees another's providers", async () => {
    client
      .query("insert into tenants (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)")
      .run("t2", "two", "two", Date.now(), Date.now());
    await createOidcProvider(
      ctx,
      "t2",
      { ...OKTA, name: "Keycloak", slug: "kc" },
      h.env.AUTH_SECRET,
    );
    expect(await kinds()).toEqual([]);
  });

  test("the platform plane does not list them — it has no workspace slug", async () => {
    // OIDC rows are loaded into the TENANT better-auth instance only, so
    // listing them on the admin sign-in screen would advertise a dead route.
    await createOidcProvider(
      ctx,
      "t1",
      OKTA,
      h.env.AUTH_SECRET,
    );
    const surface = await resolveAuthSurface(ctx, h.env, "t1");
    expect(surface.providers.filter((p) => p.kind === "oidc")).toEqual([]);
  });
});
