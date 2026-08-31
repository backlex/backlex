import type { Condition } from "@backlex/core";

/**
 * Per-isolate caches in front of {@link resolvePermission} so a hot path —
 * items CRUD, GraphQL, realtime subscribe gate — doesn't run two SELECTs per
 * request once a user's role set and the matching permission rows have been
 * resolved once.
 *
 * Two layers:
 *
 * - **L2 (roles)** — `(plane, tenantId, userId, apiKeyRoleId) → RoleRow[]`.
 *   Captures both bursts of parallel calls from one user and the
 *   1-RPS-per-user pattern across the fleet.
 *
 * - **L3 (static permission rows)** — `(tenantId, roleIdsSorted, collection,
 *   action) → CachedStaticPermission`. Keyed by the role set, not the user,
 *   so every user holding the same role bundle shares one entry — the big
 *   hit-rate win.
 *
 * Both layers share `TTL_MS`. Mutating routes call the explicit `invalidate*`
 * functions for same-isolate freshness; the TTL is the fallback ceiling for
 * cross-isolate convergence.
 *
 * Conditions are cached **without** `auth` bound — they hold raw `Condition`
 * trees (with `$user.id` etc. as placeholders). The caller re-binds them via
 * `combineConditions(rawConditions, auth)` per request so the resolved SQL
 * fragment always reflects the live identity.
 *
 * Both caches are bounded LRU (10k entries). Module-level state = per
 * isolate — fine for CF Workers (one Map per isolate) and Bun (one process).
 */

// Cross-isolate stale window — read this before changing the TTL.
//
// Each isolate (CF Worker / Bun process) owns its own Map. An explicit
// `invalidate*` call only clears the *local* isolate; siblings still hold
// the prior entry until their copy expires. The TTL is therefore the
// upper bound on how long a write is allowed to lag behind across the
// fleet. Per-event impact:
//
//   - rol revoke / admin demote   → false-allow up to TTL_MS
//   - permission row DELETE       → false-allow up to TTL_MS
//   - permission row CREATE       → false-deny  up to TTL_MS
//
// false-deny is the safe direction (user just retries). false-allow is the
// trade-off we explicitly accepted: same model as auth-config / email-config
// caches in this codebase. Shortening this helps belt-and-suspenders at the
// cost of hit rate; lengthening it needs a fresh threat-model pass.
const TTL_MS = 30_000;
const MAX_ENTRIES = 10_000;

class TtlLru<K, V> {
  private readonly map = new Map<string, { value: V; expiresAt: number; raw: K }>();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
    private readonly serialize: (key: K) => string,
  ) {}

  get(key: K): V | undefined {
    const k = this.serialize(key);
    const entry = this.map.get(k);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(k);
      return undefined;
    }
    // Bump to most-recent so eviction is true LRU.
    this.map.delete(k);
    this.map.set(k, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    const k = this.serialize(key);
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, { value, expiresAt: Date.now() + this.ttlMs, raw: key });
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /** Drop entries whose raw key satisfies `pred`. O(n) — invalidation is rare
   *  compared to lookup, and the LRU map is bounded, so this is acceptable. */
  deleteBy(pred: (key: K) => boolean): void {
    for (const [serialized, entry] of this.map) {
      if (pred(entry.raw)) this.map.delete(serialized);
    }
  }

  /** Drop entries by their VALUE. Needed where one subject sits behind several
   *  keys that cannot be derived from it — the tenant-resolve cache holds a
   *  workspace under both its slug and its id, and a status change knows only
   *  the id. Same O(n) reasoning as `deleteBy`. */
  deleteByValue(pred: (value: V) => boolean): void {
    for (const [serialized, entry] of this.map) {
      if (pred(entry.value)) this.map.delete(serialized);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export interface CachedRoleRow {
  id: string;
  name: string;
  admin: boolean;
}

interface RolesKey {
  plane: "platform" | "app";
  tenantId: string;
  userId: string | null;
  apiKeyRoleId: string | null;
  /** Active app-plane org, when one is selected. Part of the key because
   *  org-scoped role grants (`app_org_member_roles`) change the bundle: the
   *  same person resolves differently in org A and org B. */
  orgId?: string | null;
  /** Whether the caller reached this workspace as a MEMBER or as the instance
   *  operator visiting a workspace they do not belong to. Part of the key for
   *  the same reason `orgId` is: the two resolve to different bundles for the
   *  same person, and collapsing them would serve an operator-visit answer to
   *  a membership request (or the reverse) for a full TTL window. That is not
   *  a hypothetical — the operator visits their own workspaces too, so both
   *  keys are live for one user id within seconds of each other. */
  access?: "member" | "operator-visit";
}

const rolesCache = new TtlLru<RolesKey, CachedRoleRow[]>(
  MAX_ENTRIES,
  TTL_MS,
  (k) =>
    `${k.plane}|${k.tenantId}|${k.userId ?? ""}|${k.apiKeyRoleId ?? ""}|${k.orgId ?? ""}|${k.access ?? "member"}`,
);

export const getCachedRoles = (k: RolesKey): CachedRoleRow[] | undefined =>
  rolesCache.get(k);

export const setCachedRoles = (k: RolesKey, v: CachedRoleRow[]): void =>
  rolesCache.set(k, v);

/**
 * Auth-agnostic snapshot of the permission rows that match a
 * `(tenant, roleSet, collection, action)` lookup.
 *
 * `rawConditions` is the OR-set of conditions across matching rows; `null`
 * in the array means "at least one matching row had no condition" — which
 * collapses to unrestricted access (the caller can short-circuit). Never
 * holds `auth` bindings; those are applied per-request.
 */
export interface CachedStaticPermission {
  allowed: boolean;
  isAdmin: boolean;
  rawConditions: (Condition | null)[];
  /** Cached as immutable array; the resolver reconstructs a Set per-call so
   *  consumers can't poison the cache by mutating the returned reference. */
  fields: readonly string[] | null;
}

interface PermsKey {
  tenantId: string;
  /** Comma-joined sorted role IDs. */
  roleIds: string;
  collection: string;
  action: string;
}

const permsCache = new TtlLru<PermsKey, CachedStaticPermission>(
  MAX_ENTRIES,
  TTL_MS,
  (k) => `${k.tenantId}|${k.roleIds}|${k.collection}|${k.action}`,
);

export const sortRoleIds = (ids: string[]): string => [...ids].sort().join(",");

export const getCachedStaticPermission = (
  k: PermsKey,
): CachedStaticPermission | undefined => permsCache.get(k);

export const setCachedStaticPermission = (
  k: PermsKey,
  v: CachedStaticPermission,
): void => permsCache.set(k, v);

/**
 * `tenantMiddleware` runs on every authenticated request and resolves two
 * things against D1 before any route handler runs: is this user a member of
 * the active tenant, and which role *names* do they hold there. Both are stable
 * between role/membership changes, so caching them per isolate removes that
 * round-trip from the hot path of every authed endpoint (not just one route).
 *
 * Same TTL + invalidation model as the role/permission caches above. The
 * membership cache stores existence only (matching `isMember`'s `row exists`
 * semantics — status changes like suspend don't flip it).
 */
interface MembershipKey {
  tenantId: string;
  userId: string;
}

const membershipCache = new TtlLru<MembershipKey, boolean>(
  MAX_ENTRIES,
  TTL_MS,
  (k) => `${k.tenantId}|${k.userId}`,
);

/**
 * Is the `app_sessions` row an access token names still live?
 *
 * The app-plane access JWT verifies with zero database reads, so before this
 * cache existed there was nothing to invalidate: suspending an end-user
 * deleted their session rows and the token kept working for its full TTL.
 * `middleware/session.ts::appSessionLive` now asks the row, and this keeps that
 * question off the hot path.
 *
 * Keyed by session id alone — the id is already the credential's identity, and
 * a deleted row and a suspended owner are the same answer here.
 */
const appSessionLiveCache = new TtlLru<string, boolean>(
  MAX_ENTRIES,
  TTL_MS,
  (k) => k,
);

export const getCachedAppSessionLive = (sessionId: string): boolean | undefined =>
  appSessionLiveCache.get(sessionId);

export const setCachedAppSessionLive = (sessionId: string, live: boolean): void =>
  appSessionLiveCache.set(sessionId, live);

/**
 * Cut an app-plane session's access tokens NOW on this isolate.
 *
 * Called by suspend and delete. Other isolates catch up when the 30s TTL
 * lapses, which is the same ceiling every other identity fact on this path
 * carries — but the isolate that served the revocation must not be the one
 * still honouring it.
 */
export const invalidateAppSessions = (sessionIds: readonly string[]): void => {
  if (sessionIds.length === 0) return;
  const gone = new Set(sessionIds);
  appSessionLiveCache.deleteBy((k) => gone.has(k));
};

export const getCachedMembership = (k: MembershipKey): boolean | undefined =>
  membershipCache.get(k);

export const setCachedMembership = (k: MembershipKey, v: boolean): void =>
  membershipCache.set(k, v);

interface TenantRoleNamesKey {
  tenantId: string;
  userId: string;
  /** Non-null only for role-scoped API keys, which narrow the result. */
  restrictRoleId: string | null;
}

const tenantRoleNamesCache = new TtlLru<TenantRoleNamesKey, readonly string[]>(
  MAX_ENTRIES,
  TTL_MS,
  (k) => `${k.tenantId}|${k.userId}|${k.restrictRoleId ?? ""}`,
);

/** Returns the cached role-name list, or `undefined` on miss. The array is
 *  shared — callers must treat it as read-only. */
export const getCachedTenantRoleNames = (
  k: TenantRoleNamesKey,
): readonly string[] | undefined => tenantRoleNamesCache.get(k);

export const setCachedTenantRoleNames = (
  k: TenantRoleNamesKey,
  v: readonly string[],
): void => tenantRoleNamesCache.set(k, v);

/**
 * Per-isolate cache of an app-plane subject's organization memberships.
 *
 * `tenantMiddleware` resolves this for every `plane: "app"` request so the
 * permission DSL can bind `$org.id` / `$org.role` / `$user.orgs`, and so
 * `loadRolesForUser` can fold in org-scoped role grants. That's one extra
 * SELECT on the app-plane hot path, which is exactly the shape the role and
 * membership caches above already exist to remove.
 *
 * Keyed by (tenant, app user) — NOT by the requested org, because the entry
 * holds every membership and the active-org pick is derived from it in JS.
 * A workspace that never creates an org caches an empty array and pays one
 * lookup per TTL window.
 */
export interface CachedOrgMembership {
  orgId: string;
  /** owner | admin | member — validated on write, typed loosely here so this
   *  module stays free of a `@backlex/core` import. */
  role: string;
}

interface OrgMembershipsKey {
  tenantId: string;
  appUserId: string;
}

const orgMembershipsCache = new TtlLru<OrgMembershipsKey, readonly CachedOrgMembership[]>(
  MAX_ENTRIES,
  TTL_MS,
  (k) => `${k.tenantId}|${k.appUserId}`,
);

/** Cached membership list, or `undefined` on miss. Shared array — read-only. */
export const getCachedOrgMemberships = (
  k: OrgMembershipsKey,
): readonly CachedOrgMembership[] | undefined => orgMembershipsCache.get(k);

export const setCachedOrgMemberships = (
  k: OrgMembershipsKey,
  v: readonly CachedOrgMembership[],
): void => orgMembershipsCache.set(k, v);

/**
 * Per-isolate cache of the resolved cookie session, keyed by the signed
 * `*.session_token` cookie value. `sessionMiddleware` runs `getSession` (a
 * better-auth call costing ~2 D1 round-trips) on EVERY authed request, so
 * without this every request paid the DB hit.
 *
 * Safe because the key is the signed session cookie: only its holder presents
 * it, and without it you cannot read another's entry. false-allow <= TTL_MS.
 *
 * **This TTL does NOT bound the revocation lag, and the two earlier claims here
 * were both wrong.** They said better-auth's `cookieCache` "only short-circuits
 * on its own `/api/auth/*` routes", and that being shorter than its 60s made
 * this cache "no worse than the model already in place". Measured on
 * `/api/me` — revoke, clear this cache, ask again with the same token:
 *
 *   - without the `session_data` cookie -> 401
 *   - with it -> 200
 *
 * So `cookieCache` answers our routes too, and worse, a request it answers is
 * then WRITTEN here under the bare-token key. The windows therefore COMPOUND
 * rather than nest: a browser holding a live `session_data` blob keeps
 * refreshing this 30s entry for as long as the blob lasts, so the last warm
 * request at t=59s leaves a revoked token accepted until roughly t=89s. The
 * honest figure for "signed out on another device" is ~90s, not 60s.
 *
 * Lowering it here does not fix that — `cookieCache.maxAge` in `packages/auth`
 * is the outer lever, and it costs a real session read on every route.
 * `tests/auth-admin-sessions.test.ts` pins both halves.
 */
export interface CachedSession {
  userId: string;
  email: string | null;
  sessionId: string | null;
}

const sessionCache = new TtlLru<string, CachedSession>(
  MAX_ENTRIES,
  TTL_MS,
  (k) => k,
);

export const getCachedSession = (token: string): CachedSession | undefined =>
  sessionCache.get(token);

export const setCachedSession = (token: string, v: CachedSession): void =>
  sessionCache.set(token, v);

/**
 * Drop a cached session, by the session's stored `token`.
 *
 * The cache is keyed on the SIGNED cookie better-auth sends
 * (`<token>.<signature>`), while the `sessions` row holds the bare token — so
 * an exact match never fired and this function, whose only caller deletes
 * sessions by id, did nothing for anyone who found it. Prefix-matching the
 * signature is what makes it usable from a revocation path.
 *
 * **This is not sufficient on its own.** better-auth's own `cookieCache`
 * (`packages/auth`, `maxAge: 60`) answers `getSession` from a signed copy in
 * the `session_data` cookie without reading the database at all, and it sits
 * ABOVE this one. Clearing this cache closes the inner 30-second window and
 * leaves the outer one exactly where it was; the lever for that is
 * `cookieCache.maxAge`, and lowering it costs a real session read on every
 * route (measured — see the `CachedSession` note above, which used to claim
 * otherwise).
 *
 * And clearing it does not stay cleared: the next request that `cookieCache`
 * answers re-populates this cache under the same bare-token key, so the two
 * windows compound to ~90s rather than nesting inside 60. See
 * `tests/auth-admin-sessions.test.ts`, which pins both halves rather than
 * pretending either is gone.
 *
 * **Do not reach for a shared revocation signal to fix this — measure first.**
 * The obvious next move is to put a revocation epoch in KV or a Durable Object
 * so isolates OTHER than the one serving `revoke-others` hear about it. It was
 * measured, by clearing this cache outright (which is exactly what a perfect
 * shared signal would achieve everywhere) and asking again:
 *
 *   device holding `session_data`   200 -> 200   (no change at all)
 *   device with the token alone     200 -> 401   (closes ~30s)
 *
 * The warm case does not move, because `cookieCache` answers above this layer
 * and a shared signal cannot reach a signed blob sitting in someone's browser.
 * So the signal would buy the TAIL of the window — roughly the last 30 of ~90
 * seconds, after the 60s blob has lapsed — at the price of a shared-store read
 * on a path that today makes ZERO (`tenantResolveCache` was the last D1 call
 * removed from it, see below).
 *
 * That makes it strictly downstream of `cookieCache`, not an independent
 * option: turn that off and the arithmetic inverts — this cache becomes the
 * whole window and a shared signal takes 30s to 0 for the same price. Build it
 * then, not before.
 *
 * One more measured fact that bounds all of this: `session_data` is NOT
 * refreshed by ordinary requests, nor by `/api/auth/get-session`. It expires 60s
 * after issue no matter how busy the caller is, which is why the window has a
 * ceiling at all.
 */
export const invalidateSession = (token: string): void => {
  sessionCache.deleteBy((k) => k === token || k.startsWith(`${token}.`));
};

/**
 * Per-isolate cache of tenant (workspace) resolution: the `slug | id` key passed
 * on a request → the resolved tenant id. `tenantMiddleware` resolves this on
 * EVERY request via `tenantBySlugOrId` (one D1 SELECT). Because it's typically
 * the first D1 call in the request, it also eats the D1 Sessions API setup cost
 * — traces show ~25ms for this call vs <1ms of actual SQL. `slug→id` and `id→id`
 * are stable, so caching them per isolate removes the last uncached D1 round-trip
 * from the hot path: with the session / membership / role-name / collection-list
 * caches already in place, a warm authed request then makes ZERO D1 calls.
 *
 * Only positive resolutions are cached (a miss returns `undefined`, so the caller
 * runs the SELECT) — a newly-created workspace resolves immediately rather than
 * being negatively cached. The TTL bounds staleness after a slug rename / tenant
 * delete, the same model as the caches above (false-resolve ≤ TTL_MS, and a stale
 * id just makes downstream queries miss and 404 — never a cross-tenant leak,
 * since the id still belongs to this isolate's single instance DB).
 */
const tenantResolveCache = new TtlLru<string, string>(MAX_ENTRIES, TTL_MS, (k) => k);

export const getCachedTenantResolve = (key: string): string | undefined =>
  tenantResolveCache.get(key);

export const setCachedTenantResolve = (key: string, tenantId: string): void =>
  tenantResolveCache.set(key, tenantId);

/**
 * Drop every cached resolution that answers with this workspace id.
 *
 * The cache is keyed by whatever the caller NAMED — a slug or an id — so one
 * workspace can sit behind two keys and neither is derivable from the tenant id
 * alone. Hence the value scan rather than a targeted delete.
 *
 * Needed because the lookup now filters on `tenants.status`: without this, an
 * isolate that had already resolved a workspace keeps admitting requests into
 * it for the rest of the TTL after it is archived or suspended. Every other
 * cache on this path has an invalidator and this one did not, which is exactly
 * the asymmetry that makes a status change feel unreliable — instant on the
 * isolate that served it, up to 30s elsewhere, and previously never on the
 * isolate that served it either.
 *
 * Restoring needs no invalidation: a refusal is never cached, so an un-archived
 * workspace resolves on its very next request.
 */
export const invalidateTenantResolve = (tenantId: string): void => {
  tenantResolveCache.deleteByValue((v) => v === tenantId);
};

// --- Invalidation ----------------------------------------------------------

/** Drop the cached role set for a single user in a tenant. Call when their
 *  `user_roles` / `app_user_roles` bindings change. */
export const invalidateUserRoles = (tenantId: string, userId: string): void => {
  rolesCache.deleteBy((k) => k.tenantId === tenantId && k.userId === userId);
  tenantRoleNamesCache.deleteBy(
    (k) => k.tenantId === tenantId && k.userId === userId,
  );
};

/** Drop every cached role row for a tenant. Call when a role itself is
 *  renamed/deleted/admin-flag-toggled — every user in that tenant might be
 *  affected, so we scrub the whole tenant slice. */
export const invalidateTenantRoles = (tenantId: string): void => {
  rolesCache.deleteBy((k) => k.tenantId === tenantId);
  tenantRoleNamesCache.deleteBy((k) => k.tenantId === tenantId);
};

/** Drop cached membership *and* tenant-scoped role names for a tenant. Call
 *  when a `tenant_members` row is added or removed (create workspace, accept
 *  invite, remove member) — both the existence flag and the user's effective
 *  role set in that tenant may have changed. Tenant-wide (not per-user) because
 *  the remove path often has only the membership row id, not the user id, and
 *  membership churn is rare enough that scrubbing the tenant slice is cheap. */
export const invalidateTenantMembership = (tenantId: string): void => {
  membershipCache.deleteBy((k) => k.tenantId === tenantId);
  tenantRoleNamesCache.deleteBy((k) => k.tenantId === tenantId);
};

/** Drop every cached static permission row for a tenant. Call when a
 *  permission row (or ownerScoped seed) changes — the role set keys
 *  reference role IDs from this tenant, so the whole slice is suspect. */
export const invalidateTenantPermissions = (tenantId: string): void => {
  permsCache.deleteBy((k) => k.tenantId === tenantId);
};

/** Drop one app-plane user's cached org memberships. Call whenever their
 *  `app_org_members` row is added, removed, or has its role changed — and
 *  alongside `invalidateUserRoles`, since an org-scoped role grant changes
 *  their effective role set too. */
export const invalidateOrgMemberships = (
  tenantId: string,
  appUserId: string,
): void => {
  orgMembershipsCache.deleteBy(
    (k) => k.tenantId === tenantId && k.appUserId === appUserId,
  );
};

/** Drop every cached org membership in a tenant. Call when an org itself is
 *  deleted — its members are unknown to the caller without a query, and org
 *  deletion is rare enough that scrubbing the tenant slice is cheap. */
export const invalidateTenantOrgs = (tenantId: string): void => {
  orgMembershipsCache.deleteBy((k) => k.tenantId === tenantId);
  rolesCache.deleteBy((k) => k.tenantId === tenantId);
};

/** Clear all caches. Tests + emergency stop. */
export const invalidateAllPermissions = (): void => {
  rolesCache.clear();
  permsCache.clear();
  membershipCache.clear();
  tenantRoleNamesCache.clear();
  sessionCache.clear();
  tenantResolveCache.clear();
  orgMembershipsCache.clear();
};

/** Test-only — current entry counts. */
export const __cacheStats = (): {
  roles: number;
  perms: number;
  membership: number;
  tenantRoleNames: number;
  session: number;
  tenantResolve: number;
  orgMemberships: number;
} => ({
  roles: rolesCache.size,
  perms: permsCache.size,
  membership: membershipCache.size,
  tenantRoleNames: tenantRoleNamesCache.size,
  session: sessionCache.size,
  tenantResolve: tenantResolveCache.size,
  orgMemberships: orgMembershipsCache.size,
});
