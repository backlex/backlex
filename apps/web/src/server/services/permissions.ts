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
        permissions: pg.schema.permissions,
      }
    : {
        roles: sqlite.schema.roles,
        userRoles: sqlite.schema.userRoles,
        permissions: sqlite.schema.permissions,
      };

export const loadRolesForUser = async (
  ctx: DbCtx,
  userId: string | null,
): Promise<RoleRow[]> => {
  const t = tablesFor(ctx.dialect);
  if (!userId) {
    const rows = await (ctx.db as any)
      .select()
      .from(t.roles)
      .where(eq(t.roles.name, SYSTEM_ROLES.public));
    return rows as RoleRow[];
  }
  const userAssigned = await (ctx.db as any)
    .select({
      id: t.roles.id,
      name: t.roles.name,
      admin: t.roles.admin,
    })
    .from(t.userRoles)
    .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
    .where(eq(t.userRoles.userId, userId));
  const builtin = await (ctx.db as any)
    .select()
    .from(t.roles)
    .where(eq(t.roles.name, SYSTEM_ROLES.authenticated));
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
  const roles = await loadRolesForUser(ctx, auth.userId);
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
