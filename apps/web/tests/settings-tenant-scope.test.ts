/**
 * PHASE 0 — pins TODAY's `PATCH /api/admin/settings` scoping contract,
 * INCLUDING the part of it that is wrong.
 *
 * `routes/settings.ts` splits every patched key into one of two destinations:
 * anything in `SIGN_IN_BRANDING_KEYS` (`signInHeadline`, `signInTagline`,
 * `termsUrl`, `privacyUrl`, `passwordLogin`) is written to the instance-global
 * `tenant_id IS NULL` row, and everything else is written to the calling
 * workspace's row. That split is deliberate — the platform sign-in screen is
 * rendered before any workspace is chosen, so its copy cannot live in one.
 *
 * The bug is the gate in front of it, not the split. Both destinations are
 * guarded by `requireAdminMw` alone, and `admin` is a role `POST /api/tenants`
 * hands out for free: any authenticated user mints a workspace and is `admin`
 * inside it a moment later. So a self-serve, low-trust principal can rewrite
 * the headline, the tagline and the terms/privacy links that every visitor to
 * the instance's sign-in page sees, and can flip the instance-wide
 * password-login mode — all while acting inside a workspace nobody else has
 * ever heard of.
 *
 * EVERY EXPECTATION BELOW IS PINNED AS-IS, INCLUDING THE 200s THAT SHOULD BE
 * 403s. Nothing here is an endorsement. Phase 1 changes this contract by
 * requiring `isInstanceOperator` for the branding keys, at which point the
 * `expect(...).toBe(200)` calls in the branding blocks become `403` and the
 * blast-radius assertions invert. Pinning them now is what makes that a
 * legible, deliberate diff rather than a silent test edit alongside a fix.
 *
 * The control block (`a NON-branding key stays inside its workspace`) is what
 * keeps the rest honest: it proves the branding keys are SPECIAL, rather than
 * `PATCH /api/admin/settings` simply being global for everything.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildTwoPlaneCast, json, type TwoPlaneCast } from "./fixtures/two-plane-cast";

let cast: TwoPlaneCast;

/** Unique per run so a leaked global row from another spec cannot satisfy an
 *  assertion here by coincidence. */
const suffix = `${Date.now()}`.slice(-7);
const OWNER_A_HEADLINE = `Owned by workspace A ${suffix}`;
const OWNER_A_TERMS = `https://workspace-a-${suffix}.example.test/terms`;

/** Acting-as-workspace request: the settings routes read `auth.tenantId`, and
 *  `X-Backlex-Tenant` (slug or id) is what sets it. */
const inTenant = (slug: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), "X-Backlex-Tenant": slug },
});

interface SettingsBody {
  data: {
    timezone?: string;
    signInHeadline?: string;
    termsUrl?: string;
    passwordLogin?: string;
  };
}

interface SurfaceBody {
  data: {
    providers: { id: string; kind: string; enabled: boolean }[];
    branding: {
      signInHeadline: string;
      signInTagline: string;
      termsUrl: string;
      privacyUrl: string;
    };
  };
}

/** The unauthenticated platform sign-in surface — what a browser sitting on the
 *  admin login screen actually fetches (`routes/auth-public.ts`, which calls
 *  `resolvePlatformAuthSurface`). No cookie, no bearer, no tenant header. */
const readPublicSurface = async (): Promise<SurfaceBody["data"]> => {
  const res = await cast.anon("/api/auth/providers");
  expect(res.status, "the public auth surface must answer an anonymous caller").toBe(200);
  return ((await res.json()) as SurfaceBody).data;
};

beforeAll(async () => {
  cast = await buildTwoPlaneCast();
});

afterAll(() => cast?.cleanup());

describe("settings — instance-global branding written by a workspace admin", () => {
  test("ownerA is a workspace admin and NOT the instance operator", async () => {
    // The whole point of this file is that a principal who cannot run one line
    // of SQL can still rewrite the instance's login page. Prove both halves,
    // and prove the probe is answerable at all — a route that 403s everyone
    // would make the ownerA assertion vacuous.
    const attacker = await cast.ownerA.fetch(
      "/api/admin/db/sql/run",
      inTenant(cast.tenantA.slug, json("POST", { sql: "SELECT 1" })),
    );
    expect(attacker.status, "the self-serve `admin` role must not reach the SQL console").toBe(403);

    const operator = await cast.operator.fetch(
      "/api/admin/db/sql/run",
      json("POST", { sql: "SELECT 1" }),
    );
    expect(operator.status, "the instance operator CAN reach it").toBe(200);
  });

  test("PINNED (wrong): ownerA may PATCH sign-in branding from their own workspace", async () => {
    // Assert the pre-state first. Without it, "the headline is ownerA's string"
    // could pass on a surface that had always carried that string, and the
    // whole block would prove nothing.
    const before = await readPublicSurface();
    expect(
      before.branding.signInHeadline,
      "a fresh instance ships no custom headline",
    ).toBe("");
    expect(before.branding.termsUrl, "…nor a terms link").toBe("");

    const patched = await cast.ownerA.fetch(
      "/api/admin/settings",
      inTenant(
        cast.tenantA.slug,
        json("PATCH", { signInHeadline: OWNER_A_HEADLINE, termsUrl: OWNER_A_TERMS }),
      ),
    );
    // Phase 1 makes this a 403: `isInstanceOperator`, not `requireAdminMw`.
    expect(
      patched.status,
      "today `requireAdminMw` is the only gate, so a workspace admin is accepted",
    ).toBe(200);
    expect(await patched.json()).toEqual({ ok: true });
  });

  test("PINNED (wrong): that string reaches every unauthenticated visitor to the instance", async () => {
    // This is the blast radius, and it is deliberately measured from the least
    // privileged surface in the product: no cookie, no bearer, no workspace.
    // The value was written by an identity whose only claim is `admin` in a
    // workspace they minted themselves.
    const surface = await readPublicSurface();
    expect(surface.branding.signInHeadline).toBe(OWNER_A_HEADLINE);
    expect(surface.branding.termsUrl).toBe(OWNER_A_TERMS);
  });

  test("PINNED (wrong): and ownerB reads it as their own workspace's setting", async () => {
    // `GET /api/admin/settings` spreads the instance-global branding over the
    // workspace row, so workspace B — which ownerA is not a member of — serves
    // ownerA's copy back as if B had chosen it.
    const res = await cast.ownerB.fetch("/api/admin/settings", inTenant(cast.tenantB.slug));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as SettingsBody;
    expect(data.signInHeadline).toBe(OWNER_A_HEADLINE);
    expect(data.termsUrl).toBe(OWNER_A_TERMS);
  });

  test("CONTROL: a NON-branding key stays inside the workspace that wrote it", async () => {
    // Without this the branding assertions above would be consistent with
    // "`PATCH /api/admin/settings` is simply global", which is not the finding.
    // Two workspaces write the same key to different values and each reads back
    // its own — so the branding keys are special, not the endpoint.
    const A_TZ = "Pacific/Chatham";
    const B_TZ = "Asia/Kolkata";

    const wroteA = await cast.ownerA.fetch(
      "/api/admin/settings",
      inTenant(cast.tenantA.slug, json("PATCH", { timezone: A_TZ })),
    );
    expect(wroteA.status).toBe(200);

    const wroteB = await cast.ownerB.fetch(
      "/api/admin/settings",
      inTenant(cast.tenantB.slug, json("PATCH", { timezone: B_TZ })),
    );
    expect(wroteB.status).toBe(200);

    const readA = (await (
      await cast.ownerA.fetch("/api/admin/settings", inTenant(cast.tenantA.slug))
    ).json()) as SettingsBody;
    const readB = (await (
      await cast.ownerB.fetch("/api/admin/settings", inTenant(cast.tenantB.slug))
    ).json()) as SettingsBody;

    expect(readA.data.timezone, "workspace A keeps its own time zone").toBe(A_TZ);
    expect(readB.data.timezone, "workspace B keeps its own").toBe(B_TZ);
    // Same call, same moment: the branding key does NOT diverge. That side by
    // side with the two time zones is the whole contrast.
    expect(readA.data.signInHeadline).toBe(OWNER_A_HEADLINE);
    expect(readB.data.signInHeadline).toBe(OWNER_A_HEADLINE);
  });
});

describe("settings — the password-login lock-out guard is scoped to the CALLING workspace", () => {
  /**
   * `passwordLogin` is itself one of the `SIGN_IN_BRANDING_KEYS`, so it is
   * stored instance-globally and enforced instance-globally
   * (`passwordLoginBlocked` reads the `tenant_id IS NULL` row). But the guard
   * that decides whether turning it off would lock everyone out calls
   * `resolvePlatformAuthSurface` with `auth.tenantId ?? null` — the CALLING
   * workspace — so it asks "does workspace A have another way in?" before
   * making a change that binds the whole instance.
   *
   * Phase 0 pins that as found. The block below shows the mismatch end to end:
   * a workspace admin opts their own workspace into magic-link, which satisfies
   * a guard about an instance that still has no magic-link anywhere its sign-in
   * screen can see, and then switches the password off for everyone.
   */
  test("PINNED: with no alternative in the calling workspace the guard refuses", async () => {
    const res = await cast.ownerA.fetch(
      "/api/admin/settings",
      inTenant(cast.tenantA.slug, json("PATCH", { passwordLogin: "disabled" })),
    );
    expect(res.status, "422 VALIDATION — the guard's refusal, not a permission error").toBe(422);
    expect(await res.text()).toContain("lock every admin out");
  });

  test("PINNED (wrong): an alternative in workspace A alone satisfies it", async () => {
    // `auth_config` is per workspace, and `resolveAuthSurface` treats a stored
    // `magic.enabled === true` as configured even when the worker's
    // `AUTH_PLUGINS` never mentioned magic-link. So this row exists only inside
    // workspace A.
    const optIn = await cast.ownerA.fetch(
      "/api/admin/auth/config",
      inTenant(cast.tenantA.slug, json("PATCH", { providers: { magic: { enabled: true } } })),
    );
    expect(optIn.status, "a workspace admin owns their own workspace's auth config").toBe(200);

    // The default workspace — the one the platform sign-in screen resolves for
    // an anonymous visitor — is untouched by that, and this is the assertion
    // that makes the next one mean something.
    const beforeSurface = await readPublicSurface();
    expect(
      beforeSurface.providers.some((p) => p.kind !== "credential"),
      "the instance sign-in screen still offers no alternative to the password",
    ).toBe(false);
    expect(
      beforeSurface.providers.some((p) => p.kind === "credential" && p.enabled),
      "…and the password itself is still on, so the next step is a real change",
    ).toBe(true);

    // Phase 1 makes this a 403 (branding keys become operator-only); whatever
    // else changes, the guard must stop consulting the caller's workspace.
    const disabled = await cast.ownerA.fetch(
      "/api/admin/settings",
      inTenant(cast.tenantA.slug, json("PATCH", { passwordLogin: "disabled" })),
    );
    expect(
      disabled.status,
      "workspace A's own magic-link row is accepted as the instance's way back in",
    ).toBe(200);

    const afterSurface = await readPublicSurface();
    expect(
      afterSurface.providers.some((p) => p.kind === "credential" && p.enabled),
      "the password is now off for the whole instance",
    ).toBe(false);
    expect(
      afterSurface.providers.some((p) => p.enabled),
      "and nothing is left enabled on the screen an admin actually signs in through",
    ).toBe(false);
  });

  test("restores password sign-in so the guard's effect is not left latched", async () => {
    // Re-enabling never runs the lock-out guard (it only fires on a value other
    // than "enabled"), so this is safe from inside an instance that currently
    // refuses password sign-in — the cookie jar already holds ownerA's session
    // and does not need to re-authenticate.
    const res = await cast.ownerA.fetch(
      "/api/admin/settings",
      inTenant(cast.tenantA.slug, json("PATCH", { passwordLogin: "enabled" })),
    );
    expect(res.status).toBe(200);
    const surface = await readPublicSurface();
    expect(
      surface.providers.some((p) => p.kind === "credential" && p.enabled),
      "password sign-in is back",
    ).toBe(true);
  });
});
