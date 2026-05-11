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

interface RoleRow {
  id: string;
  name: string;
  admin: boolean;
}

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
  const t = tablesFor(ctx.dialect);
  // Without an active tenant we can't pick the right copy of public/admin/etc.,
  // so deny everything by returning no roles. This is the safe default — the
  // request just hits the public-deny branch in resolvePermission.
  if (!tenantId) return [];
  // Role-scoped API key: the effective role set is exactly the bound role —
  // no implicit `authenticated`, no other roles the owner happens to have —
  // and only while the owner still holds it. If they lost it (or it was
  // deleted), the key resolves to no roles → denied. A scoped key therefore
  // can never grant more than its owner currently has.
  if (apiKeyRoleId) {
    if (!userId) return [];
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
    return rows;
  }
  if (!userId) {
    const rows = await (ctx.db as any)
      .select()
      .from(t.roles)
      .where(
        and(
          eq(t.roles.tenantId, tenantId),
          eq(t.roles.name, SYSTEM_ROLES.public),
        ),
      );
    return rows as RoleRow[];
  }
  // App-plane identities (workspace end-users from `app_users`) get the
  // workspace's `authenticated` role plus whatever custom roles a workspace
  // admin assigned via `app_user_roles`. They never touch the control-plane
  // `user_roles` table, and any role flagged `admin` is dropped here — a
  // customer can grant broad access only through explicit permissions, never
  // the admin bypass (and a UUID collision with a control-plane user can't
  // leak platform-admin powers either).
  if (plane === "app") {
    const assigned = (await (ctx.db as any)
      .select({ id: t.roles.id, name: t.roles.name, admin: t.roles.admin })
      .from(t.appUserRoles)
      .innerJoin(t.roles, eq(t.appUserRoles.roleId, t.roles.id))
      .where(
        and(eq(t.appUserRoles.appUserId, userId), eq(t.roles.tenantId, tenantId)),
      )) as RoleRow[];
    const builtin = (await (ctx.db as any)
      .select()
      .from(t.roles)
      .where(
        and(
          eq(t.roles.tenantId, tenantId),
          eq(t.roles.name, SYSTEM_ROLES.authenticated),
        ),
      )) as RoleRow[];
    return [...assigned.filter((r) => !r.admin), ...builtin];
  }
  // Only consider roles that belong to the active tenant. A user can have
  // role X in tenant A and role Y in tenant B; each request only sees the
  // role bundle for the workspace they're acting in.
  const userAssigned = await (ctx.db as any)
    .select({
      id: t.roles.id,
      name: t.roles.name,
      admin: t.roles.admin,
    })
    .from(t.userRoles)
    .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
    .where(
      and(eq(t.userRoles.userId, userId), eq(t.roles.tenantId, tenantId)),
    );
  const builtin = await (ctx.db as any)
    .select()
    .from(t.roles)
    .where(
      and(
        eq(t.roles.tenantId, tenantId),
        eq(t.roles.name, SYSTEM_ROLES.authenticated),
      ),
    );
  return [...(userAssigned as RoleRow[]), ...(builtin as RoleRow[])];
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

export const resolvePermission = async (
  ctx: DbCtx,
  auth: AuthSubject,
  collection: string,
  action: Action,
): Promise<ResolvedPermission> => {
  const roles = await loadRolesForUser(
    ctx,
    auth.userId,
    auth.tenantId ?? null,
    auth.apiKeyRoleId ?? null,
    auth.plane ?? "platform",
  );
  if (roles.some((r) => r.admin)) {
    return {
      allowed: true,
      isAdmin: true,
      whereSql: null,
      conditions: null,
      fields: null,
    };
  }
  if (roles.length === 0) {
    return {
      allowed: false,
      isAdmin: false,
      whereSql: null,
      conditions: null,
      fields: null,
    };
  }
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
    return {
      allowed: false,
      isAdmin: false,
      whereSql: null,
      conditions: null,
      fields: null,
    };
  }

  const rawConditions = rows.map((r) => r.condition);
  const whereSql = combineConditions(rawConditions, auth);
  const conditions: Condition[] | null = rawConditions.some((c) => c == null)
    ? null
    : (rawConditions as Condition[]);

  let fields: Set<string> | null = null;
  for (const r of rows) {
    if (!r.fields) {
      fields = null;
      break;
    }
    if (!fields) fields = new Set();
    for (const f of r.fields) fields.add(f);
  }

  return { allowed: true, isAdmin: false, whereSql, conditions, fields };
};
