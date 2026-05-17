import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";

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

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  await next();
};

const AppUserRoleRef = z.object({ id: z.string(), name: z.string() });

const AppUserRow = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    emailVerified: z.boolean().nullable(),
    status: z.string(),
    createdAt: z.unknown(),
    roles: z.array(AppUserRoleRef),
  })
  .openapi("AppUserRow");

const SetRolesInput = z
  .object({ roleIds: z.array(z.string().min(1)) })
  .openapi("AppUserSetRolesInput");

const PatchInput = z
  .object({ status: z.enum(["active", "suspended"]).optional() })
  .openapi("AppUserPatchInput");

const TAG = "app-users";

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

export const appUsersRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: [TAG],
      summary: "List workspace end-users",
      description:
        "Returns the `app_users` for the active workspace with their custom role assignments.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.any() },
          },
        },
        ...errorResponses,
      },
    }),
    /** List the workspace's end-users with their assigned (custom) role names. */
    async (c) => {
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
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/{id}/roles",
      tags: [TAG],
      summary: "Replace end-user role assignments",
      description:
        "Replace the user's role bindings. Every roleId must belong to the active workspace; the admin role is rejected.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: SetRolesInput } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean(), roleIds: z.array(z.string()) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    /**
     * Replace an end-user's role assignments. `roleIds` must reference roles
     * that belong to the active workspace; the `admin` role is rejected — an
     * app-user can never hold the workspace admin bypass.
     */
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = auth.tenantId;
      if (!tenantId) throw new AppError("VALIDATION", "No active workspace");
      const { id: appUserId } = c.req.valid("param");
      const body = c.req.valid("json");
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
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: [TAG],
      summary: "Update end-user",
      description:
        "Currently only `status`. Suspending also drops the user's `app_sessions`.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: PatchInput } },
        },
      },
      responses: {
        200: {
          description: "Updated",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    /**
     * Update an end-user. Currently only `status` ("active" | "suspended").
     * Suspending also drops the user's `app_sessions` so existing tokens stop
     * working immediately, and the tenant-auth instance blocks fresh sign-ins
     * for suspended users.
     */
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = c.get("auth").tenantId;
      if (!tenantId) throw new AppError("VALIDATION", "No active workspace");
      const { id: appUserId } = c.req.valid("param");
      const body = c.req.valid("json");
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
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: [TAG],
      summary: "Delete end-user",
      description:
        "Drops the `app_users` row plus sessions, OAuth accounts, and role assignments in this workspace.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    /** Delete an end-user along with their sessions, OAuth accounts, and role
     *  assignments. Done explicitly (not via FK ON DELETE CASCADE) so it works
     *  the same on SQLite/D1, which don't enforce foreign keys by default. */
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = c.get("auth").tenantId;
      if (!tenantId) throw new AppError("VALIDATION", "No active workspace");
      const { id: appUserId } = c.req.valid("param");
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
    },
  );
