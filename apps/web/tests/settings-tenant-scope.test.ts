/**
 * PHASE 1 — pins the `PATCH /api/admin/settings` scoping contract as it now
 * stands, after the instance-global branding keys were re-gated.
 *
 * `routes/settings.ts` splits every patched key into one of two destinations:
 * anything in `SIGN_IN_BRANDING_KEYS` (`signInHeadline`, `signInTagline`,
 * `termsUrl`, `privacyUrl`, `passwordLogin`) is written to the instance-global
 * `tenant_id IS NULL` row, and everything else is written to the calling
 * workspace's row. That split is deliberate and unchanged — the platform
 * sign-in screen is rendered before any workspace is chosen, so its copy cannot
 * live in one.
 *
 * What changed is the gate in front of it. Phase 0 pinned both destinations as
 * guarded by `requireAdminMw` alone, and `admin` is a role `POST /api/tenants`
 * hands out for free: any authenticated user mints a workspace and is `admin`
 * inside it a moment later. So a self-serve, low-trust principal could rewrite
 * the headline, the tagline and the terms/privacy links that every visitor to
 * the instance's sign-in page sees, and could flip the instance-wide
 * password-login mode — all while acting inside a workspace nobody else had
 * ever heard of. Phase 1 adds an `isInstanceOperator` check ahead of the write
 * loop, so those five keys now need instance-global standing.
 *
 * Every `expect(...).toBe(200)` Phase 0 pinned in the branding blocks is
 * therefore a `403` here, and the blast-radius assertions are re-pointed at the
 * operator: the operator publishing instance-wide copy is the DESIGN, not the
 * bug. The Phase 0 → Phase 1 diff on this file is meant to read as a deliberate
 * contract change rather than a silent test edit alongside a fix.
 *
 * The control block (`a NON-branding key stays inside its workspace`) is what
 * keeps the rest honest: it proves the branding keys are SPECIAL, rather than
 * `PATCH /api/admin/settings` simply having become operator-only for everything.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildTwoPlaneCast, json, type TwoPlaneCast } from "./fixtures/two-plane-cast";

let cast: TwoPlaneCast;

/** Unique per run so a leaked global row from another spec cannot satisfy an
 *  assertion here by coincidence. */
const suffix = `${Date.now()}`.slice(-7);
/** What ownerA — a self-serve workspace admin — TRIES to publish. Nothing in
 *  this file may ever observe this string on a real surface. */
const OWNER_A_HEADLINE = `Owned by workspace A ${suffix}`;
const OWNER_A_TERMS = `https://workspace-a-${suffix}.example.test/terms`;
/** What the instance operator publishes, and what every visitor is SUPPOSED to
 *  see, because the deployment has exactly one sign-in screen. */
const OPERATOR_HEADLINE = `Operated instance ${suffix}`;
const OPERATOR_TERMS = `https://operator-${suffix}.example.test/terms`;

/** Workspace-scoped values for the control block. Module-level because the
 *  mixed-body test reads workspace A's time zone back to prove the refusal
 *  wrote nothing. */
const A_TZ = "Pacific/Chatham";
const B_TZ = "Asia/Kolkata";
/** Only ever sent inside the mixed body that must be refused whole. */
const MIXED_TZ = "America/Argentina/Ushuaia";

/** Acting-as-workspace request: the settings routes read `auth.tenantId`, and
 *  `X-Backlex-Tenant` (slug or id) is what sets it.
 *
 *  EVERY call in this file names its workspace, the operator's included. The
 *  cast shares one cookie jar across platform identities, so the
 *  `backlex-tenant` cookie left behind by whoever called last would otherwise
 *  decide which workspace the next identity acts in — and for the operator that
 *  is the difference between `requireAdminMw` seeing their `default` admin role
 *  and seeing the empty role set of an operator visiting a foreign workspace. */
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

describe("settings — instance-global branding is the instance operator's to write", () => {
  test("ownerA is a workspace admin and NOT the instance operator", async () => {
    // This whole file turns on the gap between those two words: `admin` is a
    // workspace role anyone can mint for themselves, and the SQL console is the
    // clearest thing it does not reach.
    //
    // The counterpart assertion — that this same route answers the OPERATOR
    // with a 200, so the 403 below is about the caller and not about the route
    // being closed to everyone — is made in "the OPERATOR sets it" further
    // down, where the operator is already the signed-in identity. The cast
    // shares one cookie jar and each identity switch costs a real sign-in
    // against a 10-per-minute limiter, so the two halves are kept where they
    // are cheap rather than paired here.
    const attacker = await cast.ownerA.fetch(
      "/api/admin/db/sql/run",
      inTenant(cast.tenantA.slug, json("POST", { sql: "SELECT 1" })),
    );
    expect(attacker.status, "the self-serve `admin` role must not reach the SQL console").toBe(403);
  });

  test("ownerA may NOT PATCH sign-in branding from their own workspace", async () => {
    // Phase 0 pinned this as a 200: `requireAdminMw` was the only gate, so a
    // workspace admin rewrote the instance's login page. Assert the pre-state
    // first — without it, "the headline is still empty" could pass on a surface
    // that had never been writable at all, and the refusal would prove nothing.
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
    expect(
      patched.status,
      "instance-global keys now need `isInstanceOperator`, not `requireAdminMw`",
    ).toBe(403);
    const refusal = await patched.text();
    // The message has to name the way back in, because the only instance that
    // holds no operator at all is one whose default workspace was renamed or
    // dropped by hand — and there `OWNER_EMAIL` is the recovery.
    expect(refusal, "the refusal names the default-workspace arm").toContain(
      "admin of the default workspace",
    );
    expect(refusal, "…and the OWNER_EMAIL arm").toContain("OWNER_EMAIL");

    // A refusal that half-applied would be worse than the bug it replaced, so
    // read the least privileged surface in the product back and confirm neither
    // string landed.
    const after = await readPublicSurface();
    expect(after.branding.signInHeadline, "the refused headline was not written").toBe("");
    expect(after.branding.termsUrl, "…and neither was the refused terms link").toBe("");
  });

  test("the OPERATOR sets it, and it reaches every unauthenticated visitor — by design", async () => {
    // First, the counterpart to the opening test: the SQL console is not closed
    // to everybody, it is closed to non-operators. Without this the 403 up there
    // would be consistent with a route that simply never answers.
    const sql = await cast.operator.fetch(
      "/api/admin/db/sql/run",
      inTenant(cast.defaultTenant.slug, json("POST", { sql: "SELECT 1" })),
    );
    expect(sql.status, "the instance operator CAN reach the SQL console").toBe(200);

    // Now the same blast radius Phase 0 measured, reached by the identity that
    // is supposed to have it. The deployment has ONE sign-in screen, shown
    // before any workspace is chosen, so instance-wide reach is the feature
    // here; what was wrong was who could invoke it.
    const patched = await cast.operator.fetch(
      "/api/admin/settings",
      inTenant(
        cast.defaultTenant.slug,
        json("PATCH", { signInHeadline: OPERATOR_HEADLINE, termsUrl: OPERATOR_TERMS }),
      ),
    );
    expect(patched.status, "the instance operator writes the instance's copy").toBe(200);
    expect(await patched.json()).toEqual({ ok: true });

    const surface = await readPublicSurface();
    expect(surface.branding.signInHeadline).toBe(OPERATOR_HEADLINE);
    expect(surface.branding.termsUrl).toBe(OPERATOR_TERMS);
  });

  test("ownerB reads the operator's copy as their own workspace's setting, and ownerA cannot change it", async () => {
    // `GET /api/admin/settings` spreads the instance-global branding over the
    // workspace row, so workspace B serves the operator's copy back as if B had
    // chosen it. That is the read side of "there is only one sign-in screen",
    // and Phase 1 leaves it alone — only the write side was re-gated.
    const res = await cast.ownerB.fetch("/api/admin/settings", inTenant(cast.tenantB.slug));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as SettingsBody;
    expect(data.signInHeadline).toBe(OPERATOR_HEADLINE);
    expect(data.termsUrl).toBe(OPERATOR_TERMS);

    // Reading it is not writing it, and that gap is what Phase 1 added: a
    // workspace admin cannot take the headline over from the operator.
    const overwrite = await cast.ownerA.fetch(
      "/api/admin/settings",
      inTenant(cast.tenantA.slug, json("PATCH", { signInHeadline: OWNER_A_HEADLINE })),
    );
    expect(overwrite.status, "a workspace admin cannot overwrite the operator's copy").toBe(403);
    const surface = await readPublicSurface();
    expect(
      surface.branding.signInHeadline,
      "the operator's headline survived the attempt untouched",
    ).toBe(OPERATOR_HEADLINE);
  });

  test("CONTROL: a NON-branding key stays inside the workspace that wrote it", async () => {
    // Without this the assertions above would be consistent with
    // "`PATCH /api/admin/settings` is simply operator-only now", which is not
    // the contract. Two workspace admins write the same key to different values
    // and each reads back its own — so the branding keys are special, not the
    // endpoint, and `requireAdminMw` is still the gate for everything else.
    // Both reads happen after both writes, so neither can pass by being taken
    // before the other workspace had a chance to clobber it.
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

    const readB = (await (
      await cast.ownerB.fetch("/api/admin/settings", inTenant(cast.tenantB.slug))
    ).json()) as SettingsBody;
    const readA = (await (
      await cast.ownerA.fetch("/api/admin/settings", inTenant(cast.tenantA.slug))
    ).json()) as SettingsBody;

    expect(readA.data.timezone, "workspace A keeps its own time zone").toBe(A_TZ);
    expect(readB.data.timezone, "workspace B keeps its own").toBe(B_TZ);
    // Same route, same moment: the branding key does NOT diverge. That side by
    // side with the two time zones is the whole contrast.
    expect(readA.data.signInHeadline).toBe(OPERATOR_HEADLINE);
    expect(readB.data.signInHeadline).toBe(OPERATOR_HEADLINE);
  });

  test("a body mixing a branding key with a workspace key is refused WHOLE", async () => {
    // The operator check runs once, over the whole body, before the write loop
    // touches a row. Were it inside the loop instead, this PATCH would 403 on
    // `signInHeadline` after `timezone` had already been committed — a partial
    // write nobody asked for and nobody would see in the response.
    const mixed = await cast.ownerA.fetch(
      "/api/admin/settings",
      inTenant(
        cast.tenantA.slug,
        json("PATCH", { signInHeadline: OWNER_A_HEADLINE, timezone: MIXED_TZ }),
      ),
    );
    expect(mixed.status, "one instance-global key poisons the whole body").toBe(403);
    // Name the refusal, so this cannot pass on some unrelated 403 — the body
    // itself is valid (a malformed one would be a 422 from the zod hook before
    // the handler ran), which is also what proves the `timezone` half really
    // would have been written had the check been per key.
    expect(await mixed.text(), "…refused by the instance-operator gate").toContain(
      "only the instance operator may change it",
    );

    // The branding half: unchanged, as in every other refusal here.
    const surface = await readPublicSurface();
    expect(surface.branding.signInHeadline, "the branding key was not written").toBe(
      OPERATOR_HEADLINE,
    );

    // The workspace half is what this test exists for. ownerA is a perfectly
    // legitimate writer of `timezone` — the CONTROL block above just proved it
    // by writing `A_TZ` through this very route — so a per-key check would have
    // let this half through while refusing the other.
    const readA = (await (
      await cast.ownerA.fetch("/api/admin/settings", inTenant(cast.tenantA.slug))
    ).json()) as SettingsBody;
    expect(readA.data.timezone, "the workspace key was not written either").toBe(A_TZ);
    expect(readA.data.timezone, "…and specifically not the value the mixed body carried").not.toBe(
      MIXED_TZ,
    );
  });
});

describe("settings — the password-login lock-out guard is scoped to the CALLING workspace", () => {
  /**
   * `passwordLogin` is itself one of the `SIGN_IN_BRANDING_KEYS`, so it is
   * stored instance-globally and enforced instance-globally
   * (`passwordLoginBlocked` reads the `tenant_id IS NULL` row). But the guard
   * that decides whether turning it off would lock everyone out calls
   * `resolvePlatformAuthSurface` with `auth.tenantId ?? null` — the CALLING
   * workspace — so it asks "does THIS workspace have another way in?" before
   * making a change that binds the whole instance.
   *
   * PHASE 1 DOES NOT FIX THAT, and this block keeps pinning it. What Phase 1
   * changed is who can reach the write at all: the mis-scoped guard is now only
   * reachable by the instance operator, which shrinks it from a self-serve
   * escalation into an operator foot-gun. It remains OPEN — the guard should
   * resolve the surface the sign-in screen actually serves (the default
   * workspace), not whichever workspace the caller happens to be acting inside.
   *
   * Note the ORDER inside the handler: the lock-out guard runs BEFORE the new
   * `isInstanceOperator` check, so a non-operator asking to disable the password
   * still meets the guard's 422 rather than the gate's 403. The first test pins
   * that, and it is also what proves the operator's 422 there is the guard
   * refusing rather than the new gate.
   */
  test("with no alternative in the calling workspace the guard refuses — the operator included", async () => {
    // Establish that the instance really has nothing but the password, or the
    // refusals below would be pinning an accident.
    const surface = await readPublicSurface();
    expect(
      surface.providers.some((p) => p.kind !== "credential" && p.enabled),
      "the instance sign-in screen offers no alternative to the password",
    ).toBe(false);
    expect(
      surface.providers.some((p) => p.kind === "credential" && p.enabled),
      "…and the password itself is on, so disabling it would be a real change",
    ).toBe(true);

    // ownerA gets the same 403 as every other branding key. `passwordLogin` IS
    // one of the instance-global keys, so the operator gate has to answer
    // first — refuse before you reveal.
    //
    // This assertion was briefly the other way round. With the lock-out guard
    // evaluated ahead of the gate, a non-operator reached it and its 422
    // ("enable another way in first") versus a 200 answered a question they
    // were not entitled to ask: whether this deployment has a second way in.
    // Distinguishing the two refusals is the whole content of the leak, so the
    // test asserts the CODE and not merely that something was refused.
    const nonOperator = await cast.ownerA.fetch(
      "/api/admin/settings",
      inTenant(cast.tenantA.slug, json("PATCH", { passwordLogin: "disabled" })),
    );
    expect(
      nonOperator.status,
      "the operator gate answers before the lock-out guard can leak the provider surface",
    ).toBe(403);
    expect(await nonOperator.text()).toContain("instance operator");

    // The operator, acting in the default workspace — the one the anonymous
    // sign-in screen resolves — meets the same refusal, and here it is the
    // right answer for the right reason.
    const res = await cast.operator.fetch(
      "/api/admin/settings",
      inTenant(cast.defaultTenant.slug, json("PATCH", { passwordLogin: "disabled" })),
    );
    expect(res.status, "422 VALIDATION — the guard's refusal, not a permission error").toBe(422);
    expect(await res.text()).toContain("lock every admin out");
  });

  test("STILL OPEN: an alternative in the operator's OTHER workspace satisfies it", async () => {
    // Acting in `default` the guard happens to ask the right question, because
    // `default` is also what the anonymous sign-in screen resolves. It asks the
    // wrong one from anywhere else, and an operator with a second workspace is
    // all that takes: `POST /api/tenants` is gated by `requireUser` alone, so
    // minting one costs a single call.
    const created = await cast.operator.fetch(
      "/api/tenants",
      json("POST", { name: `Operator Side Workspace ${suffix}` }),
    );
    expect(created.status, "any authenticated user may mint a workspace").toBe(201);
    const ops = ((await created.json()) as { data: { id: string; slug: string } }).data;

    // `auth_config` is per workspace, and `resolveAuthSurface` treats a stored
    // `magic.enabled === true` as configured even when the worker's
    // `AUTH_PLUGINS` never mentioned magic-link. So this row exists only inside
    // the side workspace.
    const optIn = await cast.operator.fetch(
      "/api/admin/auth/config",
      inTenant(ops.slug, json("PATCH", { providers: { magic: { enabled: true } } })),
    );
    expect(optIn.status, "a workspace admin owns their own workspace's auth config").toBe(200);

    // The default workspace is untouched by that, and this is the assertion
    // that makes the next one mean something.
    const beforeSurface = await readPublicSurface();
    expect(
      beforeSurface.providers.some((p) => p.kind !== "credential" && p.enabled),
      "the instance sign-in screen still offers no alternative to the password",
    ).toBe(false);
    expect(
      beforeSurface.providers.some((p) => p.kind === "credential" && p.enabled),
      "…and the password itself is still on, so the next step is a real change",
    ).toBe(true);

    const disabled = await cast.operator.fetch(
      "/api/admin/settings",
      inTenant(ops.slug, json("PATCH", { passwordLogin: "disabled" })),
    );
    expect(
      disabled.status,
      "the side workspace's own magic-link row is accepted as the instance's way back in",
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
    // refuses password sign-in — the cookie jar already holds the operator's
    // session and does not need to re-authenticate.
    const res = await cast.operator.fetch(
      "/api/admin/settings",
      inTenant(cast.defaultTenant.slug, json("PATCH", { passwordLogin: "enabled" })),
    );
    expect(res.status).toBe(200);
    const surface = await readPublicSurface();
    expect(
      surface.providers.some((p) => p.kind === "credential" && p.enabled),
      "password sign-in is back",
    ).toBe(true);
  });
});
