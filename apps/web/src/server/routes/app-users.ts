import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, ilike, inArray, like, or, type SQL } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { invalidateUserRoles } from "../services/permissions-cache";
import { inviteAppUser, resolveAssignableRoles } from "../services/app-user-invites";
import { removeAppUserFromAllOrgs } from "../services/app-orgs";
import { defaultHook } from "../lib/openapi-router";

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

const _AppUserRow = z
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

const InviteInput = z
  .object({
    email: z.string().email(),
    name: z.string().trim().min(1).max(200).optional(),
    /** Roles bound at invite time — same rules as PUT /{id}/roles (must belong
     *  to the workspace; the admin role is rejected). */
    roleIds: z.array(z.string().min(1)).max(50).optional(),
    /** Person row to link: sets `<collection>.<itemId>.app_user_id` to the
     *  invited user so `$user.id` permission conditions match after accept. */
    link: z
      .object({ collection: z.string().min(1).max(60), itemId: z.string().min(1) })
      .optional(),
  })
  .openapi("AppUserInviteInput");

const PatchInput = z
  .object({
    status: z.enum(["active", "suspended"]).optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .openapi("AppUserPatchInput");

const AppSessionRow = z
  .object({
    id: z.string(),
    userAgent: z.string().nullable(),
    ipAddress: z.string().nullable(),
    createdAt: z.number().nullable(),
    updatedAt: z.number().nullable(),
  })
  .openapi("AppSessionRow");

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

export const appUsersRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: [TAG],
      summary: "List workspace end-users",
      description:
        "Returns the `app_users` for the active workspace with their custom role assignments. `q` filters by email/name substring (case-insensitive); `ids` narrows to a comma-separated id list (used to batch-resolve user-link field labels).",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        query: z.object({
          q: z.string().trim().max(200).optional(),
          ids: z.string().max(4000).optional(),
        }),
      },
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
    /** List the workspace's end-users with their assigned (custom) role names.
     *  `q` narrows by email/name substring; `ids` by an explicit id list. */
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = auth.tenantId;
      if (!tenantId) return c.json({ data: [] });
      const { q, ids: idsParam } = c.req.valid("query");
      const t = tablesFor(ctx.dialect);
      const conds: SQL[] = [eq(t.appUsers.tenantId, tenantId)];
      if (q) {
        // ILIKE on PG for case-insensitive matching; SQLite's LIKE is already
        // case-insensitive for ASCII. Wildcards in `q` are left as-is — this
        // is an admin-only search box, a `%` just broadens the match.
        const matches = ctx.dialect === "pg" ? ilike : like;
        const pat = `%${q}%`;
        conds.push(or(matches(t.appUsers.email, pat), matches(t.appUsers.name, pat))!);
      }
      if (idsParam !== undefined) {
        const wanted = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
        if (wanted.length === 0) return c.json({ data: [] });
        conds.push(inArray(t.appUsers.id, wanted));
      }
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
        .where(and(...conds))
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

      const valid = await resolveAssignableRoles(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        body.roleIds,
      );

      await (ctx.db as any)
        .delete(t.appUserRoles)
        .where(eq(t.appUserRoles.appUserId, appUserId));
      for (const r of valid) {
        await (ctx.db as any)
          .insert(t.appUserRoles)
          .values({ appUserId, roleId: r.id });
      }
      invalidateUserRoles(tenantId, appUserId);
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
        "Update `status` and/or `name`. Suspending also drops the user's `app_sessions`.",
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
      if (body.name !== undefined) {
        await (ctx.db as any)
          .update(t.appUsers)
          .set({
            name: body.name,
            updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
          })
          .where(and(eq(t.appUsers.id, appUserId), eq(t.appUsers.tenantId, tenantId)));
      }
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/sessions",
      tags: [TAG],
      summary: "List an end-user's sessions",
      description:
        "Active `app_sessions` for the end-user, newest first. Scoped to the active workspace.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(AppSessionRow) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    /** List the end-user's `app_sessions`, newest first. */
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = c.get("auth").tenantId;
      if (!tenantId) throw new AppError("VALIDATION", "No active workspace");
      const { id: appUserId } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      await requireAppUser(ctx.db, ctx.dialect, tenantId, appUserId);
      const rows = (await (ctx.db as any)
        .select({
          id: t.appSessions.id,
          userAgent: t.appSessions.userAgent,
          ipAddress: t.appSessions.ipAddress,
          createdAt: t.appSessions.createdAt,
          updatedAt: t.appSessions.updatedAt,
        })
        .from(t.appSessions)
        .where(
          and(
            eq(t.appSessions.userId, appUserId),
            eq(t.appSessions.tenantId, tenantId),
          ),
        )
        .orderBy(desc(t.appSessions.createdAt))) as Array<Record<string, unknown>>;
      const ms = (v: unknown): number | null =>
        v == null ? null : typeof v === "number" ? v : new Date(v as string).getTime();
      return c.json({
        data: rows.map((s) => {
          const created = ms(s.createdAt);
          return {
            id: String(s.id),
            userAgent: (s.userAgent as string | null) ?? null,
            ipAddress: (s.ipAddress as string | null) ?? null,
            createdAt: created,
            updatedAt: ms(s.updatedAt) ?? created,
          };
        }),
      });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}/sessions/{sessionId}",
      tags: [TAG],
      summary: "Revoke one end-user session",
      description:
        "Deletes a single `app_sessions` row. Scoped to the active workspace.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: { params: z.object({ id: z.string(), sessionId: z.string() }) },
      responses: {
        200: {
          description: "Revoked",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    /** Revoke a single `app_sessions` row for the end-user. */
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = c.get("auth").tenantId;
      if (!tenantId) throw new AppError("VALIDATION", "No active workspace");
      const { id: appUserId, sessionId } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      await requireAppUser(ctx.db, ctx.dialect, tenantId, appUserId);
      await (ctx.db as any)
        .delete(t.appSessions)
        .where(
          and(
            eq(t.appSessions.id, sessionId),
            eq(t.appSessions.userId, appUserId),
            eq(t.appSessions.tenantId, tenantId),
          ),
        );
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
        "Drops the `app_users` row plus sessions, OAuth accounts, role assignments, and every organization membership in this workspace.",
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
    /** Delete an end-user along with their sessions, OAuth accounts, role
     *  assignments and organization memberships. Done explicitly (not via FK
     *  ON DELETE CASCADE) so it works the same on SQLite/D1, which don't
     *  enforce foreign keys by default. */
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = c.get("auth").tenantId;
      if (!tenantId) throw new AppError("VALIDATION", "No active workspace");
      const { id: appUserId } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      await requireAppUser(ctx.db, ctx.dialect, tenantId, appUserId);
      const accounts =
        ctx.dialect === "pg" ? pg.schema.appAccounts : sqlite.schema.appAccounts;
      // Org rows first. An `app_org_members` row left behind is invisible
      // (every listing inner-joins `app_users`) but still counted, so a ghost
      // owner would satisfy the last-owner guard and let the org be emptied.
      await removeAppUserFromAllOrgs(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        appUserId,
      );
      await (ctx.db as any).delete(t.appUserRoles).where(eq(t.appUserRoles.appUserId, appUserId));
      invalidateUserRoles(tenantId, appUserId);
      await (ctx.db as any).delete(t.appSessions).where(eq(t.appSessions.userId, appUserId));
      await (ctx.db as any).delete(accounts).where(eq(accounts.userId, appUserId));
      // `app_verifications` keys on the identifier (email/token), not a user id —
      // those short-lived rows just expire on their own.
      await (ctx.db as any)
        .delete(t.appUsers)
        .where(and(eq(t.appUsers.id, appUserId), eq(t.appUsers.tenantId, tenantId)));
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/invite",
      tags: [TAG],
      summary: "Invite an end-user",
      description:
        "Creates a pending `app_users` row (status `invited`, no credential), mints a 7-day invite token, and best-effort mails it. Optionally binds roles (admin role rejected) and links a person row's `app_user_id`. The invitee accepts on the app plane via `POST /api/t/{slug}/auth/invite/accept` with `{ token, password }`.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: InviteInput } },
        },
      },
      responses: {
        201: {
          description: "Invite created",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  id: z.string(),
                  email: z.string(),
                  token: z.string(),
                  expiresAt: z.number(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    /**
     * Admin-driven end-user provisioning — the counterpart to app-plane
     * self-signup. Mirrors the platform member invite (`POST
     * /api/tenants/{id}/members/invite`): pending row + 7-day token +
     * best-effort email (a mail-transport failure never fails the request).
     * The row stays `status: "invited"` — no credential, no session access —
     * until the invitee sets a password via the accept endpoint. Core lives in
     * `services/app-user-invites.ts::inviteAppUser`, shared with the GraphQL
     * `inviteAppUser` mutation and MCP `app_users.invite`.
     */
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = auth.tenantId;
      if (!tenantId) throw new AppError("VALIDATION", "No active workspace");
      const body = c.req.valid("json");
      const { id, email, token, expiresAt } = await inviteAppUser(ctx, tenantId, body);
      return c.json({ data: { id, email, token, expiresAt: expiresAt.getTime() } }, 201);
    },
  );
