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
        appSessions: pg.schema.appSessions,
        roles: pg.schema.roles,
      }
    : {
        appUsers: sqlite.schema.appUsers,
        appUserRoles: sqlite.schema.appUserRoles,
        appSessions: sqlite.schema.appSessions,
        roles: sqlite.schema.roles,
      };

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

const SetRolesInput = z.object({ roleIds: z.array(z.string().min(1)) });
const PatchInput = z.object({ status: z.enum(["active", "suspended"]).optional() });

/** Confirm an `app_users` row exists in the active workspace. */
const requireAppUser = async (
  db: unknown,
  dialect: "pg" | "sqlite",
  tenantId: string,
  appUserId: string,
): Promise<void> => {
  const t = tablesFor(dialect);
  const rows = (await (db as any)
    .select({ id: t.appUsers.id })
    .from(t.appUsers)
    .where(and(eq(t.appUsers.id, appUserId), eq(t.appUsers.tenantId, tenantId)))
    .limit(1)) as Array<{ id: string }>;
  if (!rows[0]) throw new AppError("NOT_FOUND", "End-user not found in this workspace");
};

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
    await requireAppUser(ctx.db, ctx.dialect, tenantId, appUserId);

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
  })
  /**
   * Update an end-user. Currently only `status` ("active" | "suspended").
   * Suspending also drops the user's `app_sessions` so existing tokens stop
   * working immediately, and the tenant-auth instance blocks fresh sign-ins
   * for suspended users.
   */
  .patch("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = c.get("auth").tenantId;
    if (!tenantId) throw new AppError("VALIDATION", "No active workspace");
    const appUserId = c.req.param("id");
    const body = PatchInput.parse(await c.req.json());
    const t = tablesFor(ctx.dialect);
    await requireAppUser(ctx.db, ctx.dialect, tenantId, appUserId);
    if (body.status !== undefined) {
      await (ctx.db as any)
        .update(t.appUsers)
        .set({
          status: body.status,
          suspendedAt:
            body.status === "suspended"
              ? ctx.dialect === "pg"
                ? new Date()
                : Date.now()
              : null,
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(and(eq(t.appUsers.id, appUserId), eq(t.appUsers.tenantId, tenantId)));
      if (body.status === "suspended") {
        await (ctx.db as any)
          .delete(t.appSessions)
          .where(eq(t.appSessions.userId, appUserId));
      }
    }
    return c.json({ ok: true });
  })
  /** Delete an end-user along with their sessions, OAuth accounts, and role
   *  assignments. Done explicitly (not via FK ON DELETE CASCADE) so it works
   *  the same on SQLite/D1, which don't enforce foreign keys by default. */
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = c.get("auth").tenantId;
    if (!tenantId) throw new AppError("VALIDATION", "No active workspace");
    const appUserId = c.req.param("id");
    const t = tablesFor(ctx.dialect);
    await requireAppUser(ctx.db, ctx.dialect, tenantId, appUserId);
    const accounts =
      ctx.dialect === "pg" ? pg.schema.appAccounts : sqlite.schema.appAccounts;
    await (ctx.db as any).delete(t.appUserRoles).where(eq(t.appUserRoles.appUserId, appUserId));
    await (ctx.db as any).delete(t.appSessions).where(eq(t.appSessions.userId, appUserId));
    await (ctx.db as any).delete(accounts).where(eq(accounts.userId, appUserId));
    // `app_verifications` keys on the identifier (email/token), not a user id —
    // those short-lived rows just expire on their own.
    await (ctx.db as any)
      .delete(t.appUsers)
      .where(and(eq(t.appUsers.id, appUserId), eq(t.appUsers.tenantId, tenantId)));
    return c.json({ ok: true });
  });
