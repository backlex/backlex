import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

/**
 * Manage the workspace end-user pool (`app_users`) — the customers of the
 * application built on a workspace. Admin-only and scoped to the active
 * workspace. Distinct from `/api/users`, which is the control-plane pool
 * (admin-app accounts).
 */

const tablesFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        appUsers: pg.schema.appUsers,
        appUserRoles: pg.schema.appUserRoles,
        roles: pg.schema.roles,
      }
    : {
        appUsers: sqlite.schema.appUsers,
        appUserRoles: sqlite.schema.appUserRoles,
        roles: sqlite.schema.roles,
      };

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

const SetRolesInput = z.object({ roleIds: z.array(z.string().min(1)) });

export const appUsersRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  /** List the workspace's end-users with their assigned (custom) role names. */
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = auth.tenantId;
    if (!tenantId) return c.json({ data: [] });
    const t = tablesFor(ctx.dialect);
    const users = (await (ctx.db as any)
      .select({
        id: t.appUsers.id,
        email: t.appUsers.email,
        name: t.appUsers.name,
        emailVerified: t.appUsers.emailVerified,
        status: t.appUsers.status,
        createdAt: t.appUsers.createdAt,
      })
      .from(t.appUsers)
      .where(eq(t.appUsers.tenantId, tenantId))
      .orderBy(desc(t.appUsers.createdAt))) as Array<{ id: string }>;
    const ids = users.map((u) => u.id);
    const roleRows = ids.length
      ? ((await (ctx.db as any)
          .select({
            appUserId: t.appUserRoles.appUserId,
            roleId: t.roles.id,
            roleName: t.roles.name,
          })
          .from(t.appUserRoles)
          .innerJoin(t.roles, eq(t.appUserRoles.roleId, t.roles.id))
          .where(
            and(inArray(t.appUserRoles.appUserId, ids), eq(t.roles.tenantId, tenantId)),
          )) as Array<{ appUserId: string; roleId: string; roleName: string }>)
      : [];
    const byUser = new Map<string, Array<{ id: string; name: string }>>();
    for (const r of roleRows) {
      const list = byUser.get(r.appUserId) ?? [];
      list.push({ id: r.roleId, name: r.roleName });
      byUser.set(r.appUserId, list);
    }
    return c.json({
      data: users.map((u) => ({ ...u, roles: byUser.get(u.id) ?? [] })),
    });
  })
  /**
   * Replace an end-user's role assignments. `roleIds` must reference roles
   * that belong to the active workspace; the `admin` role is rejected — an
   * app-user can never hold the workspace admin bypass.
   */
  .put("/:id/roles", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = auth.tenantId;
    if (!tenantId) throw new AppError("VALIDATION", "No active workspace");
    const appUserId = c.req.param("id");
    const body = SetRolesInput.parse(await c.req.json());
    const t = tablesFor(ctx.dialect);

    const owner = (await (ctx.db as any)
      .select({ id: t.appUsers.id })
      .from(t.appUsers)
      .where(and(eq(t.appUsers.id, appUserId), eq(t.appUsers.tenantId, tenantId)))
      .limit(1)) as Array<{ id: string }>;
    if (!owner[0]) throw new AppError("NOT_FOUND", "End-user not found in this workspace");

    const wanted = Array.from(new Set(body.roleIds));
    let valid: Array<{ id: string; name: string; admin: boolean }> = [];
    if (wanted.length) {
      valid = (await (ctx.db as any)
        .select({ id: t.roles.id, name: t.roles.name, admin: t.roles.admin })
        .from(t.roles)
        .where(and(eq(t.roles.tenantId, tenantId), inArray(t.roles.id, wanted)))) as Array<{
          id: string;
          name: string;
          admin: boolean;
        }>;
      const validIds = new Set(valid.map((r) => r.id));
      const unknown = wanted.filter((id) => !validIds.has(id));
      if (unknown.length)
        throw new AppError("VALIDATION", `Unknown role(s) for this workspace: ${unknown.join(", ")}`);
      if (valid.some((r) => r.admin || r.name === SYSTEM_ROLES.admin))
        throw new AppError("VALIDATION", "The admin role cannot be assigned to a workspace end-user");
    }

    await (ctx.db as any)
      .delete(t.appUserRoles)
      .where(eq(t.appUserRoles.appUserId, appUserId));
    for (const r of valid) {
      await (ctx.db as any)
        .insert(t.appUserRoles)
        .values({ appUserId, roleId: r.id });
    }
    return c.json({ ok: true, roleIds: valid.map((r) => r.id) });
  });
