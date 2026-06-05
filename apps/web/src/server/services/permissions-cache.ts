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
}

const rolesCache = new TtlLru<RolesKey, CachedRoleRow[]>(
  MAX_ENTRIES,
  TTL_MS,
  (k) => `${k.plane}|${k.tenantId}|${k.userId ?? ""}|${k.apiKeyRoleId ?? ""}`,
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

/** Clear both caches. Tests + emergency stop. */
export const invalidateAllPermissions = (): void => {
  rolesCache.clear();
  permsCache.clear();
  membershipCache.clear();
  tenantRoleNamesCache.clear();
};

/** Test-only — current entry counts. */
export const __cacheStats = (): {
  roles: number;
  perms: number;
  membership: number;
  tenantRoleNames: number;
} => ({
  roles: rolesCache.size,
  perms: permsCache.size,
  membership: membershipCache.size,
  tenantRoleNames: tenantRoleNamesCache.size,
});
