/**
 * A two-workspace, two-plane cast, shared by every spec that has to reason
 * about who may reach what.
 *
 * `security-audit-2026-07.test.ts` hand-rolled a version of this (operator +
 * attacker, default + victim + evil) and it has been copied outward since. The
 * copies drift, and each one covers only the plane its author was thinking
 * about — which is how the highest-value invariant in a two-plane product ended
 * up asserted in a comment and executed by nothing: not one spec in the suite
 * drives an APP-plane bearer at a CONTROL-plane route.
 *
 * So this fixture builds both planes at once, and every identity it returns
 * carries its own `fetch`.
 *
 * ── the cast ────────────────────────────────────────────────────────────────
 *
 *   operator   first signup. `admin` in the `default` workspace, which is what
 *              `isInstanceOperator` recognises. The only genuinely privileged
 *              identity here.
 *   ownerA     a later signup. Lands in `default` as `authenticated` (every
 *              signup does — see `context.ts::onUserCreated`), then creates
 *              workspace A and is `admin` there and ONLY there. This is the
 *              self-serve, low-trust principal the whole audit turns on.
 *   adminA     invited into workspace A as `admin`. Proves a workspace can
 *              have two administrators — which is what a last-owner guard
 *              needs in order to be testable in both directions.
 *   ownerB     another later signup, owns workspace B. Nobody else is a member
 *              of B, so B is the victim in any cross-workspace assertion.
 *              `default` can never play that part: everyone belongs to it.
 *   endUserA   an APP-plane end-user of workspace A. Holds a bearer token, no
 *              cookie, and no business anywhere on the control plane.
 *   endUserB   the same for workspace B, so org/tenant isolation on the app
 *              plane has two sides to compare.
 *
 * ── cookies ─────────────────────────────────────────────────────────────────
 *
 * The harness owns ONE cookie jar, so platform identities cannot hold sessions
 * simultaneously through it. Each platform identity's `fetch` therefore signs
 * that identity in first (a no-op when they are already current) and then
 * issues the request. That costs a round-trip per identity SWITCH, not per
 * call, and it means a spec never has to remember who is currently signed in —
 * the bug this fixture exists to stop being written.
 *
 * App-plane identities need none of that: their credential is an
 * `Authorization: Bearer` header, so their `fetch` is stateless and can
 * interleave with any platform call freely.
 */
import { expect } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
export const CAST_PASSWORD = "correct-horse-battery";
const END_USER_PASSWORD = "two-plane-cast-12345";

export type Caller = (path: string, init?: RequestInit) => Promise<Response>;

/** `json("POST", body)` — the request shape every route here expects. */
export const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export interface PlatformIdentity {
  email: string;
  userId: string;
  /** Signs this identity in if they are not current, then issues the request. */
  fetch: Caller;
}

export interface AppIdentity {
  id: string;
  email: string;
  /**
   * The app-plane ACCESS token — the short-lived JWT the SDK actually puts in
   * `Authorization`.
   *
   * This used to be the sign-in response's `token` field, which is the LEGACY
   * alias for `refreshToken`: the opaque `app_sessions.token`. That credential
   * has always been resolved by `findAppSession`, a real database read that
   * has always checked the row and the owner's status — so any spec driving it
   * would have shown a green revocation test even with the JWT's liveness
   * check deleted outright. Every security assertion built on this fixture was
   * therefore aimed at the one credential that was never broken.
   */
  token: string;
  /** The opaque `app_sessions.token`, for the refresh endpoint and for a spec
   *  that specifically wants the database-backed credential. */
  refreshToken: string;
  /** Stateless bearer caller. `org` sets `X-Backlex-Org` on every request. */
  fetch: Caller;
  bearer: (org?: string) => Caller;
}

export interface Workspace {
  id: string;
  slug: string;
}

export interface TwoPlaneCast {
  h: TestHarness;
  operator: PlatformIdentity;
  ownerA: PlatformIdentity;
  adminA: PlatformIdentity;
  ownerB: PlatformIdentity;
  endUserA: AppIdentity;
  endUserB: AppIdentity;
  /** The bootstrap workspace every platform signup lands in as a member. */
  defaultTenant: Workspace;
  tenantA: Workspace;
  tenantB: Workspace;
  /** An anonymous caller — no cookie, no bearer. */
  anon: Caller;
  cleanup: () => void;
}

export const buildTwoPlaneCast = async (): Promise<TwoPlaneCast> => {
  const h = makeHarness();
  const suffix = `${Date.now()}`.slice(-7);

  // `h.fetch` is the cookie jar. `current` tracks who holds it so a platform
  // caller only pays for a sign-in when the identity actually changes.
  let current: string | null = null;

  const rawSignIn = (email: string) =>
    h.fetch("/api/auth/sign-in/email", json("POST", { email, password: CAST_PASSWORD }));

  const signInAs = async (email: string): Promise<void> => {
    if (current === email) return;
    const res = await rawSignIn(email);
    if (!res.ok) throw new Error(`sign-in as ${email} failed: ${res.status} ${await res.text()}`);
    current = email;
  };

  const signOut = async (): Promise<void> => {
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    current = null;
  };

  const signUp = async (email: string): Promise<void> => {
    const res = await h.fetch(
      "/api/auth/sign-up/email",
      json("POST", { email, password: CAST_PASSWORD, name: email }),
    );
    if (!res.ok) throw new Error(`sign-up ${email} failed: ${res.status} ${await res.text()}`);
    // better-auth signs the new account in, so the jar now holds them.
    current = email;
  };

  const platform = (email: string, userId: string): PlatformIdentity => ({
    email,
    userId,
    fetch: async (path, init) => {
      await signInAs(email);
      return h.fetch(path, init);
    },
  });

  const bearerFor =
    (token: string, org?: string): Caller =>
    (path, init = {}) =>
      Promise.resolve(h.app.request(path, {
        ...init,
        headers: {
          ...JSON_HEADERS,
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token}`,
          ...(org ? { "X-Backlex-Org": org } : {}),
        },
      }));

  /** The signed-in caller's own user id, straight from the route that answers it. */
  const whoami = async (): Promise<string> => {
    const res = await h.fetch("/api/me");
    if (!res.ok) throw new Error(`/api/me failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as
      | { data?: { userId?: string; id?: string } }
      | { userId?: string; id?: string };
    const inner = (body as { data?: Record<string, unknown> }).data ?? body;
    const id = (inner as { userId?: string; id?: string }).userId
      ?? (inner as { userId?: string; id?: string }).id;
    if (!id) throw new Error(`/api/me returned no user id: ${JSON.stringify(body)}`);
    return id;
  };

  const createWorkspace = async (name: string): Promise<Workspace> => {
    const res = await h.fetch("/api/tenants", json("POST", { name }));
    expect(res.status, `create workspace "${name}"`).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; slug: string } };
    return { id: data.id, slug: data.slug };
  };

  /**
   * Invite an app-plane end-user into whichever workspace is ACTIVE for the
   * current caller, then accept, returning the bearer token the SDK would hold.
   */
  const makeEndUser = async (slug: string, email: string): Promise<AppIdentity> => {
    const invited = await h.fetch(
      "/api/app-users/invite",
      { ...json("POST", { email }), headers: { ...JSON_HEADERS, "X-Backlex-Tenant": slug } },
    );
    expect(invited.status, `invite end-user ${email} into ${slug}`).toBe(201);
    const { data } = (await invited.json()) as { data: { id: string; email: string; token: string } };

    const accepted = await h.app.request(
      `/api/t/${slug}/auth/invite/accept`,
      json("POST", { token: data.token, password: END_USER_PASSWORD }),
    );
    expect(accepted.status, `accept end-user invite for ${email}`).toBe(200);
    const session = (await accepted.json()) as {
      token: string;
      accessToken?: string;
    };
    // Prefer the JWT. `token` is the legacy alias for `refreshToken` and is
    // kept only as a fallback for a surface that has not started returning
    // `accessToken` — falling back silently is what made this fixture test the
    // wrong credential, so the fallback is named rather than implicit.
    const access = session.accessToken ?? session.token;
    expect(
      session.accessToken,
      "the app-plane accept response should carry an accessToken; without it this fixture drives the opaque refresh token and every revocation assertion built on it is vacuous",
    ).toBeDefined();

    return {
      id: data.id,
      email: data.email,
      token: access,
      refreshToken: session.token,
      fetch: bearerFor(access),
      bearer: (org?: string) => bearerFor(access, org),
    };
  };

  // ── operator: first signup, admin of `default` ────────────────────────────
  const operatorEmail = `operator-${suffix}@example.test`;
  await seedAdmin(h, operatorEmail, CAST_PASSWORD);
  current = operatorEmail;
  const operatorId = await whoami();

  const tenantList = await h.fetch("/api/tenants");
  expect(tenantList.status).toBe(200);
  const listed = (await tenantList.json()) as { data: { id: string; slug: string }[] };
  const defaultRow = listed.data.find((t) => t.slug === "default");
  expect(defaultRow, "the default workspace should exist after the first signup").toBeDefined();
  const defaultTenant: Workspace = { id: defaultRow!.id, slug: defaultRow!.slug };

  // ── ownerA + workspace A ──────────────────────────────────────────────────
  await signOut();
  const ownerAEmail = `owner-a-${suffix}@example.test`;
  await signUp(ownerAEmail);
  const ownerAId = await whoami();
  const tenantA = await createWorkspace(`Workspace A ${suffix}`);

  // ── adminA: a SECOND admin inside workspace A ─────────────────────────────
  // Invited by ownerA (who is `owner` there), accepted by signing up — the
  // invite admits the address even when public sign-up is closed.
  const adminAEmail = `admin-a-${suffix}@example.test`;
  const inviteA = await h.fetch(
    `/api/tenants/${tenantA.id}/members/invite`,
    json("POST", { email: adminAEmail, role: "admin" }),
  );
  expect(inviteA.status, "invite a second admin into workspace A").toBe(201);

  await signOut();
  // Signing up with the invited address IS the accept — `onUserCreated` binds
  // any pending invite for that email and nulls its token. Calling
  // `POST /api/tenants/accept` afterwards would 404 on a token that no longer
  // exists, which is the correct single-use behaviour and not a failure.
  await signUp(adminAEmail);
  const adminAId = await whoami();
  const memberships = (await (await h.fetch("/api/tenants")).json()) as {
    data: { id: string }[];
  };
  expect(
    memberships.data.some((t) => t.id === tenantA.id),
    "signing up with the invited address should bind the workspace-A membership",
  ).toBe(true);

  // ── ownerB + workspace B ──────────────────────────────────────────────────
  await signOut();
  const ownerBEmail = `owner-b-${suffix}@example.test`;
  await signUp(ownerBEmail);
  const ownerBId = await whoami();
  const tenantB = await createWorkspace(`Workspace B ${suffix}`);

  // ── app-plane end-users ───────────────────────────────────────────────────
  // ownerB is signed in and owns B, so B's end-user is minted first.
  const endUserB = await makeEndUser(tenantB.slug, `end-user-b-${suffix}@example.test`);

  await signOut();
  await signInAs(ownerAEmail);
  const endUserA = await makeEndUser(tenantA.slug, `end-user-a-${suffix}@example.test`);

  return {
    h,
    operator: platform(operatorEmail, operatorId),
    ownerA: platform(ownerAEmail, ownerAId),
    adminA: platform(adminAEmail, adminAId),
    ownerB: platform(ownerBEmail, ownerBId),
    endUserA,
    endUserB,
    defaultTenant,
    tenantA,
    tenantB,
    anon: (path, init = {}) =>
      Promise.resolve(h.app.request(path, { ...init, headers: { ...JSON_HEADERS, ...(init.headers ?? {}) } })),
    cleanup: () => h.cleanup(),
  };
};
