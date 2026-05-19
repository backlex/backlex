import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and, inArray } from "drizzle-orm";
import { AppError } from "@workeros/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  assertTenantMember,
  requireAdminMw,
  requireTenant,
} from "../services/roles/guards";
import { ensureRoleInTenant } from "../services/roles/role-checks";
import {
  PERMISSIONS_TAG,
  PermissionInput,
  PermissionRowSchema,
  ROLES_TAG,
  RoleInput,
  RoleRowSchema,
  SYSTEM_ROLE_NAMES,
  USERS_TAG,
  UserAttachRoleInput,
  UserInviteInput,
  UserRow,
} from "../services/roles/schemas";
import { tableFor } from "../services/roles/tables";

export const rolesRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ROLES_TAG,
      summary: "List roles",
      description: "Roles scoped to the active workspace.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(RoleRowSchema) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const rows = await (ctx.db as any)
        .select()
        .from(t.roles)
        .where(eq(t.roles.tenantId, tenantId));
      return c.json({ data: rows });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ROLES_TAG,
      summary: "Create a role",
      description: "Creates a workspace-scoped role.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: RoleInput } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": { schema: z.any() },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const t = tableFor(ctx.dialect);
      const id = crypto.randomUUID();
      await (ctx.db as any).insert(t.roles).values({
        id,
        tenantId,
        name: body.name,
        description: body.description ?? null,
        admin: body.admin ?? false,
      });
      return c.json(
        { data: { id, tenantId, ...body, admin: body.admin ?? false } },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: ROLES_TAG,
      summary: "Update a role",
      description:
        "Partial update; the role must belong to the active workspace.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: RoleInput.partial() } },
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
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      await ensureRoleInTenant({ db: ctx.db, dialect: ctx.dialect }, tenantId, id);
      const t = tableFor(ctx.dialect);
      await (ctx.db as any)
        .update(t.roles)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
          ...(body.admin !== undefined ? { admin: body.admin } : {}),
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(and(eq(t.roles.id, id), eq(t.roles.tenantId, tenantId)));
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: ROLES_TAG,
      summary: "Delete a role",
      description:
        "System roles (`admin`, `authenticated`, `public`) cannot be deleted.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const t = tableFor(ctx.dialect);
      const row = await ensureRoleInTenant(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        id,
      );
      if (SYSTEM_ROLE_NAMES.has(row.name)) {
        throw new AppError("FORBIDDEN", `Cannot delete system role "${row.name}"`);
      }
      await (ctx.db as any)
        .delete(t.roles)
        .where(and(eq(t.roles.id, id), eq(t.roles.tenantId, tenantId)));
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/permissions",
      tags: ROLES_TAG,
      summary: "List a role's permissions",
      description: "All permission rows attached to the role.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(PermissionRowSchema) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      await ensureRoleInTenant({ db: ctx.db, dialect: ctx.dialect }, tenantId, id);
      const t = tableFor(ctx.dialect);
      const rows = await (ctx.db as any)
        .select()
        .from(t.permissions)
        .where(eq(t.permissions.roleId, id));
      return c.json({ data: rows });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/permissions",
      tags: ROLES_TAG,
      summary: "Attach a permission",
      description: "Creates a (collection, action) permission row for the role.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": {
              // `roleId` comes from the path — but the original behavior also
              // accepted it in the body and overlaid the path value on top, so
              // keep the field optional in the input schema to preserve that.
              schema: PermissionInput.extend({
                roleId: z.string().min(1).optional(),
              }).openapi("RolePermissionAttachInput"),
            },
          },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": {
              schema: z.any(),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      await ensureRoleInTenant({ db: ctx.db, dialect: ctx.dialect }, tenantId, id);
      const bodyRaw = c.req.valid("json");
      const body = PermissionInput.parse({ ...bodyRaw, roleId: id });
      const t = tableFor(ctx.dialect);
      const permId = crypto.randomUUID();
      await (ctx.db as any).insert(t.permissions).values({
        id: permId,
        roleId: body.roleId,
        collection: body.collection,
        action: body.action,
        fields: body.fields ?? null,
        condition: body.condition ?? null,
      });
      return c.json({ data: { id: permId, ...body } }, 201);
    },
  );

export const permissionsRoutes = new OpenAPIHono<AppBindings>().openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: PERMISSIONS_TAG,
    summary: "Delete a permission",
    description: "Idempotent. Scoped to the active workspace via the parent role.",
    security: SECURITY,
    middleware: [requireUser, requireAdminMw],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: "Deleted",
        content: { "application/json": { schema: OkSchema } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const { id } = c.req.valid("param");
    const t = tableFor(ctx.dialect);
    // A permission belongs to a role which belongs to a tenant. Look it up
    // through the role to make sure the caller isn't deleting a permission
    // in another workspace by guessing the id.
    const row = (await (ctx.db as any)
      .select({ tenantId: t.roles.tenantId })
      .from(t.permissions)
      .innerJoin(t.roles, eq(t.permissions.roleId, t.roles.id))
      .where(eq(t.permissions.id, id))
      .limit(1)) as { tenantId: string | null }[];
    if (!row[0] || row[0].tenantId !== tenantId) {
      throw new AppError("NOT_FOUND", "Permission not found in this workspace");
    }
    await (ctx.db as any).delete(t.permissions).where(eq(t.permissions.id, id));
    return c.json({ ok: true });
  },
);

export const usersRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: USERS_TAG,
      summary: "List workspace users",
      description:
        "Admin-app users who are members of the active workspace, with their role bindings and last session timestamp.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(UserRow) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      // Only list users who are members of the active tenant. The users
      // table itself is global (better-auth owns it) — workspace isolation
      // happens via the tenant_members join.
      const users = (await (ctx.db as any)
        .select({
          id: t.users.id,
          email: t.users.email,
          name: t.users.name,
          createdAt: t.users.createdAt,
        })
        .from(t.tenantMembers)
        .innerJoin(t.users, eq(t.tenantMembers.userId, t.users.id))
        .where(eq(t.tenantMembers.tenantId, tenantId))) as {
        id: string;
        email: string;
        name: string | null;
        createdAt: unknown;
      }[];
      const userIds = users.map((u) => u.id);
      const userRoles = userIds.length
        ? ((await (ctx.db as any)
            .select({
              userId: t.userRoles.userId,
              roleId: t.userRoles.roleId,
              name: t.roles.name,
            })
            .from(t.userRoles)
            .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
            .where(
              and(
                eq(t.roles.tenantId, tenantId),
                inArray(t.userRoles.userId, userIds),
              ),
            )) as { userId: string; roleId: string; name: string }[])
        : [];
      // Last-seen comes from the most recent session row per user. Cheap on
      // small DBs; on larger deployments this should move to a materialized
      // `users.last_seen_at` updated by the session middleware.
      const sessionRows = userIds.length
        ? ((await (ctx.db as any)
            .select({ userId: t.sessions.userId, createdAt: t.sessions.createdAt })
            .from(t.sessions)
            .where(inArray(t.sessions.userId, userIds))) as {
            userId: string;
            createdAt: unknown;
          }[])
        : [];
      const lastByUser = new Map<string, number>();
      for (const s of sessionRows) {
        const ts =
          typeof s.createdAt === "number"
            ? s.createdAt
            : new Date(s.createdAt as string).getTime();
        const prev = lastByUser.get(s.userId) ?? 0;
        if (ts > prev) lastByUser.set(s.userId, ts);
      }

      const byUser = new Map<string, { id: string; name: string }[]>();
      for (const r of userRoles) {
        let bucket = byUser.get(r.userId);
        if (!bucket) {
          bucket = [];
          byUser.set(r.userId, bucket);
        }
        bucket.push({ id: r.roleId, name: r.name });
      }
      return c.json({
        data: users.map((u) => ({
          ...u,
          roles: byUser.get(u.id) ?? [],
          lastSeenAt: lastByUser.get(u.id) ?? null,
        })),
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/roles",
      tags: USERS_TAG,
      summary: "Attach a role",
      description: "Bind a workspace-scoped role to the user. Idempotent.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: UserAttachRoleInput } },
        },
      },
      responses: {
        200: {
          description: "Bound",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id: userId } = c.req.valid("param");
      const body = c.req.valid("json");
      // Role must belong to active tenant.
      await ensureRoleInTenant(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        body.roleId,
      );
      const t = tableFor(ctx.dialect);
      // User must be a member of active tenant.
      const memberRows = (await (ctx.db as any)
        .select({ id: t.tenantMembers.id })
        .from(t.tenantMembers)
        .where(
          and(
            eq(t.tenantMembers.tenantId, tenantId),
            eq(t.tenantMembers.userId, userId),
          ),
        )
        .limit(1)) as { id: string }[];
      if (!memberRows[0])
        throw new AppError("NOT_FOUND", "User not in this workspace");
      await (ctx.db as any)
        .insert(t.userRoles)
        .values({ userId, roleId: body.roleId })
        .onConflictDoNothing();
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}/roles/{roleId}",
      tags: USERS_TAG,
      summary: "Detach a role",
      description: "Removes the (user, role) binding. Idempotent.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string(), roleId: z.string() }) },
      responses: {
        200: {
          description: "Removed",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id, roleId } = c.req.valid("param");
      await ensureRoleInTenant(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        roleId,
      );
      const t = tableFor(ctx.dialect);
      await (ctx.db as any)
        .delete(t.userRoles)
        .where(and(eq(t.userRoles.userId, id), eq(t.userRoles.roleId, roleId)));
      return c.json({ ok: true });
    },
  )
  /**
   * Email-based invite. Creates a one-time `verification` row consumed by
   * better-auth on the magic-link endpoint. The actual user record is
   * created when the invitee clicks through and verifies.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/invite",
      tags: USERS_TAG,
      summary: "Email-invite a user",
      description:
        "Sends an invite email; the actual user record is created when the invitee verifies.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: UserInviteInput } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({ email: z.string(), sent: z.boolean() }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const body = c.req.valid("json");
      const transport = await ctx.emailFor(c.get("auth")?.tenantId ?? null);
      const sent = await transport
        .send({
          to: body.email,
          subject: "You've been invited to workeros",
          text: `Open ${ctx.env.APP_URL}/sign-up?invite=${encodeURIComponent(body.email)} to accept.`,
        })
        .then(() => true)
        .catch(() => false);
      return c.json({ data: { email: body.email, sent } });
    },
  )
  /** Suspend the user's membership in the active tenant. The global user
   *  record is left untouched — they may still belong to other workspaces.
   *  Global sessions are revoked because better-auth's session table isn't
   *  tenant-aware; the user can sign back in but won't see this workspace. */
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}/suspend",
      tags: USERS_TAG,
      summary: "Suspend a user",
      description:
        "Marks the workspace membership suspended and revokes the user's global sessions.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Suspended",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      await assertTenantMember(ctx, tenantId, id);
      await (ctx.db as any)
        .update(t.tenantMembers)
        .set({
          status: "suspended",
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(
          and(
            eq(t.tenantMembers.tenantId, tenantId),
            eq(t.tenantMembers.userId, id),
          ),
        );
      await (ctx.db as any).delete(t.sessions).where(eq(t.sessions.userId, id));
      return c.json({ ok: true });
    },
  )
  /** Re-enable a suspended membership in the active tenant. */
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}/activate",
      tags: USERS_TAG,
      summary: "Reactivate a user",
      description: "Re-enables a suspended workspace membership.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Activated",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      await assertTenantMember(ctx, tenantId, id);
      await (ctx.db as any)
        .update(t.tenantMembers)
        .set({
          status: "active",
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(
          and(
            eq(t.tenantMembers.tenantId, tenantId),
            eq(t.tenantMembers.userId, id),
          ),
        );
      return c.json({ ok: true });
    },
  )
  /** Force-revoke every session for a user. Sessions are global so this
   *  signs the user out of every workspace they belong to — gated on the
   *  user being a member of the active tenant so a tenant admin can't
   *  reach into unrelated users. */
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/sessions/revoke-all",
      tags: USERS_TAG,
      summary: "Revoke all user sessions",
      description:
        "Drops every better-auth session for the user. Gated on workspace membership.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Revoked",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      await assertTenantMember(ctx, tenantId, id);
      await (ctx.db as any).delete(t.sessions).where(eq(t.sessions.userId, id));
      return c.json({ ok: true });
    },
  )
  /** Remove the user from the active tenant. The global user record is
   *  preserved — they keep access to any other workspaces they belong to.
   *  Role assignments in this tenant are dropped along the way. */
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: USERS_TAG,
      summary: "Remove from workspace",
      description:
        "Removes the user from the active workspace; the global user record is preserved.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Removed",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = tableFor(ctx.dialect);
      const { id } = c.req.valid("param");
      await assertTenantMember(ctx, tenantId, id);
      // Drop role assignments that point at tenant-scoped roles (other
      // tenants' assignments must survive).
      const roleIds = (await (ctx.db as any)
        .select({ id: t.roles.id })
        .from(t.roles)
        .where(eq(t.roles.tenantId, tenantId))) as { id: string }[];
      if (roleIds.length) {
        await (ctx.db as any)
          .delete(t.userRoles)
          .where(
            and(
              eq(t.userRoles.userId, id),
              inArray(
                t.userRoles.roleId,
                roleIds.map((r) => r.id),
              ),
            ),
          );
      }
      await (ctx.db as any)
        .delete(t.tenantMembers)
        .where(
          and(
            eq(t.tenantMembers.tenantId, tenantId),
            eq(t.tenantMembers.userId, id),
          ),
        );
      return c.json({ ok: true });
    },
  );
