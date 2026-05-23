import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import {
  type Action,
  type AuthSubject,
  type Condition,
  SYSTEM_ROLES,
} from "@workeros/core";
import { combineConditions } from "@workeros/db";
import type { DbCtx } from "./seed";
import {
  type CachedRoleRow,
  type CachedStaticPermission,
  getCachedRoles,
  getCachedStaticPermission,
  setCachedRoles,
  setCachedStaticPermission,
  sortRoleIds,
} from "./permissions-cache";

type RoleRow = CachedRoleRow;

interface PermissionRow {
  id: string;
  collection: string;
  action: string;
  fields: string[] | null;
  condition: Condition | null;
}

const tablesFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        roles: pg.schema.roles,
        userRoles: pg.schema.userRoles,
        appUserRoles: pg.schema.appUserRoles,
        permissions: pg.schema.permissions,
      }
    : {
        roles: sqlite.schema.roles,
        userRoles: sqlite.schema.userRoles,
        appUserRoles: sqlite.schema.appUserRoles,
        permissions: sqlite.schema.permissions,
      };

export const loadRolesForUser = async (
  ctx: DbCtx,
  userId: string | null,
  tenantId: string | null,
  apiKeyRoleId: string | null = null,
  plane: "platform" | "app" = "platform",
): Promise<RoleRow[]> => {
  // Without an active tenant we can't pick the right copy of public/admin/etc.,
  // so deny everything by returning no roles. This is the safe default — the
  // request just hits the public-deny branch in resolvePermission.
  if (!tenantId) return [];
  // L2 cache hit short-circuits both the role join and the underlying DB
  // round-trip. TTL is short (1s) so role demotion is felt almost immediately
  // even across isolates; explicit writes also invalidate.
  const cacheKey = { plane, tenantId, userId, apiKeyRoleId };
  const cached = getCachedRoles(cacheKey);
  if (cached) return cached;
  const t = tablesFor(ctx.dialect);
  // Role-scoped API key: the effective role set is exactly the bound role —
  // no implicit `authenticated`, no other roles the owner happens to have —
  // and only while the owner still holds it. If they lost it (or it was
  // deleted), the key resolves to no roles → denied. A scoped key therefore
  // can never grant more than its owner currently has.
  if (apiKeyRoleId) {
    if (!userId) {
      setCachedRoles(cacheKey, []);
      return [];
    }
    const rows = (await (ctx.db as any)
      .select({ id: t.roles.id, name: t.roles.name, admin: t.roles.admin })
      .from(t.userRoles)
      .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
      .where(
        and(
          eq(t.userRoles.userId, userId),
          eq(t.roles.tenantId, tenantId),
          eq(t.roles.id, apiKeyRoleId),
        ),
      )) as RoleRow[];
    setCachedRoles(cacheKey, rows);
    return rows;
  }
  if (!userId) {
    const rows = (await (ctx.db as any)
      .select()
      .from(t.roles)
      .where(
        and(
          eq(t.roles.tenantId, tenantId),
          eq(t.roles.name, SYSTEM_ROLES.public),
        ),
      )) as RoleRow[];
    setCachedRoles(cacheKey, rows);
    return rows;
  }
  // App-plane identities (workspace end-users from `app_users`) get the
  // workspace's `authenticated` role plus whatever custom roles a workspace
  // admin assigned via `app_user_roles`. They never touch the control-plane
  // `user_roles` table, and any role flagged `admin` is dropped here — a
  // customer can grant broad access only through explicit permissions, never
  // the admin bypass (and a UUID collision with a control-plane user can't
  // leak platform-admin powers either).
  //
  // One LEFT JOIN'd SELECT pulls both the explicitly-assigned roles and the
  // builtin `authenticated` row in a single round-trip — `app_user_roles`
  // matches on the user; the OR brings in the builtin row even when the user
  // has no explicit assignment. `roles.admin` is excluded on the join side
  // so an accidentally-admin custom role can't sneak through.
  if (plane === "app") {
    const rows = (await (ctx.db as any)
      .select({ id: t.roles.id, name: t.roles.name, admin: t.roles.admin })
      .from(t.roles)
      .leftJoin(
        t.appUserRoles,
        and(
          eq(t.appUserRoles.roleId, t.roles.id),
          eq(t.appUserRoles.appUserId, userId),
        ),
      )
      .where(
        and(
          eq(t.roles.tenantId, tenantId),
          or(
            eq(t.roles.name, SYSTEM_ROLES.authenticated),
            and(
              eq(t.appUserRoles.appUserId, userId),
              eq(t.roles.admin, false),
            ),
          ),
        ),
      )) as RoleRow[];
    setCachedRoles(cacheKey, rows);
    return rows;
  }
  // Only consider roles that belong to the active tenant. A user can have
  // role X in tenant A and role Y in tenant B; each request only sees the
  // role bundle for the workspace they're acting in.
  //
  // Same single-SELECT pattern as app-plane: LEFT JOIN user_roles so the
  // builtin `authenticated` row comes back even when the user has no rows
  // in `user_roles` yet.
  const rows = (await (ctx.db as any)
    .select({ id: t.roles.id, name: t.roles.name, admin: t.roles.admin })
    .from(t.roles)
    .leftJoin(
      t.userRoles,
      and(
        eq(t.userRoles.roleId, t.roles.id),
        eq(t.userRoles.userId, userId),
      ),
    )
    .where(
      and(
        eq(t.roles.tenantId, tenantId),
        or(
          eq(t.roles.name, SYSTEM_ROLES.authenticated),
          eq(t.userRoles.userId, userId),
        ),
      ),
    )) as RoleRow[];
  setCachedRoles(cacheKey, rows);
  return rows;
};

export interface ResolvedPermission {
  allowed: boolean;
  isAdmin: boolean;
  /** OR-combined condition across matching permissions; null = unrestricted. */
  whereSql: SQL | null;
  /**
   * Raw conditions across matching permission rows. `null` means at least one
   * matching row had no condition (= unrestricted access). An array means
   * access is granted only when at least one of these conditions matches.
   * Used by the realtime layer to evaluate per-event filters in JS via
   * `matchesCondition`.
   */
  conditions: Condition[] | null;
  /** Union of allowed fields across matching rows; null = all fields. */
  fields: Set<string> | null;
}

/** Per-request L1 cache. Keyed by `"<collection>:<action>"` because `auth`
 *  is fixed for the lifetime of one request. Optional — when omitted the
 *  resolver falls back to L2+L3 only. */
export type PermResolveCache = Map<string, ResolvedPermission>;

export const resolvePermission = async (
  ctx: DbCtx,
  auth: AuthSubject,
  collection: string,
  action: Action,
  requestCache?: PermResolveCache,
): Promise<ResolvedPermission> => {
  // L1 — same request, same (collection, action) → return the prior result
  // verbatim. `whereSql` already carries this request's auth bindings.
  const memoKey = `${collection}:${action}`;
  if (requestCache) {
    const hit = requestCache.get(memoKey);
    if (hit) return hit;
  }

  const roles = await loadRolesForUser(
    ctx,
    auth.userId,
    auth.tenantId ?? null,
    auth.apiKeyRoleId ?? null,
    auth.plane ?? "platform",
  );

  const remember = (r: ResolvedPermission): ResolvedPermission => {
    requestCache?.set(memoKey, r);
    return r;
  };

  if (roles.some((r) => r.admin)) {
    return remember({
      allowed: true,
      isAdmin: true,
      whereSql: null,
      conditions: null,
      fields: null,
    });
  }
  if (roles.length === 0) {
    return remember({
      allowed: false,
      isAdmin: false,
      whereSql: null,
      conditions: null,
      fields: null,
    });
  }

  // L3 — static permission rows for this (tenant, roleSet, collection,
  // action). Keyed by the role set so two users with the same bundle share
  // one entry. Conditions are cached raw; we rebind `whereSql` with the
  // current `auth` after every hit so `$user.id` etc. always reflect the
  // live identity.
  const tenantId = auth.tenantId!;
  const permCacheKey = {
    tenantId,
    roleIds: sortRoleIds(roles.map((r) => r.id)),
    collection,
    action,
  };
  let staticPerm: CachedStaticPermission | undefined =
    getCachedStaticPermission(permCacheKey);
  if (!staticPerm) {
    const t = tablesFor(ctx.dialect);
    const rows = (await (ctx.db as any)
      .select()
      .from(t.permissions)
      .where(
        and(
          inArray(
            t.permissions.roleId,
            roles.map((r) => r.id),
          ),
          eq(t.permissions.action, action),
          or(
            eq(t.permissions.collection, collection),
            eq(t.permissions.collection, "*"),
          ),
        ),
      )) as PermissionRow[];

    if (rows.length === 0) {
      staticPerm = {
        allowed: false,
        isAdmin: false,
        rawConditions: [],
        fields: null,
      };
    } else {
      const rawConditions = rows.map((r) => r.condition);
      let fields: string[] | null = null;
      for (const r of rows) {
        if (!r.fields) {
          fields = null;
          break;
        }
        if (!fields) fields = [];
        for (const f of r.fields) if (!fields.includes(f)) fields.push(f);
      }
      staticPerm = {
        allowed: true,
        isAdmin: false,
        rawConditions,
        fields,
      };
    }
    setCachedStaticPermission(permCacheKey, staticPerm);
  }

  if (!staticPerm.allowed) {
    return remember({
      allowed: false,
      isAdmin: false,
      whereSql: null,
      conditions: null,
      fields: null,
    });
  }

  const whereSql = combineConditions(staticPerm.rawConditions, auth);
  const conditions: Condition[] | null = staticPerm.rawConditions.some(
    (c) => c == null,
  )
    ? null
    : (staticPerm.rawConditions as Condition[]);
  const fields = staticPerm.fields ? new Set(staticPerm.fields) : null;

  return remember({ allowed: true, isAdmin: false, whereSql, conditions, fields });
};
