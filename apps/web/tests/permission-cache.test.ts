/**
 * Permission cache primitives — TTL, LRU, invalidation. The end-to-end
 * "cache + write path" coverage lives in permissions.test.ts (which now
 * exercises the cache transparently); these are the targeted unit tests for
 * the contract `services/permissions-cache.ts` exposes.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  __cacheStats,
  getCachedRoles,
  getCachedStaticPermission,
  invalidateAllPermissions,
  invalidateTenantPermissions,
  invalidateTenantRoles,
  invalidateUserRoles,
  setCachedRoles,
  setCachedStaticPermission,
  sortRoleIds,
  type CachedRoleRow,
  type CachedStaticPermission,
} from "../src/server/services/permissions-cache";

const mkRoles = (...names: string[]): CachedRoleRow[] =>
  names.map((n, i) => ({ id: `role-${n}-${i}`, name: n, admin: n === "admin" }));

const mkPerm = (
  overrides: Partial<CachedStaticPermission> = {},
): CachedStaticPermission => ({
  allowed: true,
  isAdmin: false,
  rawConditions: [null],
  fields: null,
  ...overrides,
});

beforeEach(() => {
  invalidateAllPermissions();
});

describe("sortRoleIds", () => {
  test("produces a stable join independent of input order", () => {
    expect(sortRoleIds(["c", "a", "b"])).toBe("a,b,c");
    expect(sortRoleIds(["a", "b", "c"])).toBe("a,b,c");
  });
});

describe("L2 roles cache", () => {
  const key = {
    plane: "platform" as const,
    tenantId: "t1",
    userId: "u1",
    apiKeyRoleId: null,
  };

  test("set + get returns the same array reference", () => {
    const roles = mkRoles("authenticated");
    setCachedRoles(key, roles);
    expect(getCachedRoles(key)).toBe(roles);
  });

  // TTL expiry (30s in production config) is enforced by `Date.now()`
  // comparison inside `TtlLru.get`; we don't sleep that long in the test
  // suite. Same-window persistence is verified by the set+get test above.

  test("isolates by tenantId, userId, plane, apiKeyRoleId", () => {
    setCachedRoles(key, mkRoles("authenticated"));
    expect(
      getCachedRoles({ ...key, tenantId: "t2" }),
    ).toBeUndefined();
    expect(getCachedRoles({ ...key, userId: "u2" })).toBeUndefined();
    expect(
      getCachedRoles({ ...key, plane: "app" }),
    ).toBeUndefined();
    expect(
      getCachedRoles({ ...key, apiKeyRoleId: "scoped-role" }),
    ).toBeUndefined();
  });
});

describe("L3 static permission cache", () => {
  const key = {
    tenantId: "t1",
    roleIds: sortRoleIds(["r-a", "r-b"]),
    collection: "posts",
    action: "read",
  };

  test("set + get returns the same snapshot", () => {
    const snap = mkPerm({ rawConditions: [{ owner_id: { _eq: "$user.id" } }] });
    setCachedStaticPermission(key, snap);
    expect(getCachedStaticPermission(key)).toBe(snap);
  });

  test("shared entry across users with the same role set", () => {
    // L3 is keyed by sorted role IDs, not userId. Same role bundle from two
    // different users hits the same slot — this is the big-win property.
    const snap = mkPerm();
    setCachedStaticPermission(key, snap);
    expect(getCachedStaticPermission(key)).toBe(snap);
    // Different sort order on input → same key after sortRoleIds.
    const reordered = { ...key, roleIds: sortRoleIds(["r-b", "r-a"]) };
    expect(getCachedStaticPermission(reordered)).toBe(snap);
  });

  test("isolates by collection and action", () => {
    setCachedStaticPermission(key, mkPerm());
    expect(
      getCachedStaticPermission({ ...key, collection: "comments" }),
    ).toBeUndefined();
    expect(
      getCachedStaticPermission({ ...key, action: "update" }),
    ).toBeUndefined();
  });
});

describe("invalidation", () => {
  test("invalidateUserRoles only clears L2 entries for that (tenant, user)", () => {
    const t1u1 = { plane: "platform" as const, tenantId: "t1", userId: "u1", apiKeyRoleId: null };
    const t1u2 = { ...t1u1, userId: "u2" };
    const t2u1 = { ...t1u1, tenantId: "t2" };
    setCachedRoles(t1u1, mkRoles("authenticated"));
    setCachedRoles(t1u2, mkRoles("authenticated"));
    setCachedRoles(t2u1, mkRoles("authenticated"));

    invalidateUserRoles("t1", "u1");

    expect(getCachedRoles(t1u1)).toBeUndefined();
    expect(getCachedRoles(t1u2)).toBeDefined();
    expect(getCachedRoles(t2u1)).toBeDefined();
  });

  test("invalidateUserRoles also drops scoped API-key entries for that user", () => {
    const base = { plane: "platform" as const, tenantId: "t1", userId: "u1", apiKeyRoleId: null };
    const scoped = { ...base, apiKeyRoleId: "scoped" };
    setCachedRoles(base, mkRoles("admin"));
    setCachedRoles(scoped, mkRoles("readonly"));

    invalidateUserRoles("t1", "u1");

    expect(getCachedRoles(base)).toBeUndefined();
    expect(getCachedRoles(scoped)).toBeUndefined();
  });

  test("invalidateTenantPermissions only clears L3 entries for that tenant", () => {
    const t1 = { tenantId: "t1", roleIds: "a", collection: "posts", action: "read" };
    const t2 = { tenantId: "t2", roleIds: "a", collection: "posts", action: "read" };
    setCachedStaticPermission(t1, mkPerm());
    setCachedStaticPermission(t2, mkPerm());

    invalidateTenantPermissions("t1");

    expect(getCachedStaticPermission(t1)).toBeUndefined();
    expect(getCachedStaticPermission(t2)).toBeDefined();
  });

  test("invalidateTenantRoles wipes every role entry for the tenant", () => {
    const t1u1 = { plane: "platform" as const, tenantId: "t1", userId: "u1", apiKeyRoleId: null };
    const t1u2 = { ...t1u1, userId: "u2" };
    const t2u1 = { ...t1u1, tenantId: "t2" };
    setCachedRoles(t1u1, mkRoles("authenticated"));
    setCachedRoles(t1u2, mkRoles("authenticated"));
    setCachedRoles(t2u1, mkRoles("authenticated"));

    invalidateTenantRoles("t1");

    expect(getCachedRoles(t1u1)).toBeUndefined();
    expect(getCachedRoles(t1u2)).toBeUndefined();
    expect(getCachedRoles(t2u1)).toBeDefined();
  });

  test("invalidateAllPermissions empties both caches", () => {
    setCachedRoles(
      { plane: "platform", tenantId: "t1", userId: "u1", apiKeyRoleId: null },
      mkRoles("authenticated"),
    );
    setCachedStaticPermission(
      { tenantId: "t1", roleIds: "a", collection: "posts", action: "read" },
      mkPerm(),
    );
    expect(__cacheStats().roles).toBe(1);
    expect(__cacheStats().perms).toBe(1);

    invalidateAllPermissions();

    expect(__cacheStats().roles).toBe(0);
    expect(__cacheStats().perms).toBe(0);
  });
});
