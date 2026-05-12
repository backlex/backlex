import { Hono } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        roles: pg.schema.roles,
        userRoles: pg.schema.userRoles,
        permissions: pg.schema.permissions,
        users: pg.schema.users,
        sessions: pg.schema.sessions,
        tenantMembers: pg.schema.tenantMembers,
      }
    : {
        roles: sqlite.schema.roles,
        userRoles: sqlite.schema.userRoles,
        permissions: sqlite.schema.permissions,
        users: sqlite.schema.users,
        sessions: sqlite.schema.sessions,
        tenantMembers: sqlite.schema.tenantMembers,
      };

const requireTenant = (c: Context<AppBindings>): string => {
  const tenantId = c.get("auth")?.tenantId ?? null;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

/** Verify the role exists *and* belongs to the active tenant. Routes that
 *  accept a roleId path param call this before mutating to make sure admins
 *  can't reach across workspaces by guessing role ids. */
const ensureRoleInTenant = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string,
  roleId: string,
): Promise<{ id: string; name: string }> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.roles.id, name: t.roles.name })
    .from(t.roles)
    .where(and(eq(t.roles.id, roleId), eq(t.roles.tenantId, tenantId)))
    .limit(1)) as { id: string; name: string }[];
  if (!rows[0]) throw new AppError("NOT_FOUND", "Role not found in this workspace");
  return rows[0];
};

const RoleInput = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  admin: z.boolean().optional(),
});

const PermissionInput = z.object({
  roleId: z.string().min(1),
  collection: z.string().min(1),
  action: z.enum(["read", "create", "update", "delete"]),
  fields: z.array(z.string()).nullable().optional(),
  condition: z.unknown().nullable().optional(),
});

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
};

const SYSTEM_ROLE_NAMES = new Set<string>([
  SYSTEM_ROLES.admin,
  SYSTEM_ROLES.authenticated,
  SYSTEM_ROLES.public,
]);

export const rolesRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any)
      .select()
      .from(t.roles)
      .where(eq(t.roles.tenantId, tenantId));
    return c.json({ data: rows });
  })
  .post("/", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const body = RoleInput.parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    const id = crypto.randomUUID();
    await (ctx.db as any).insert(t.roles).values({
      id,
      tenantId,
      name: body.name,
      description: body.description ?? null,
      admin: body.admin ?? false,
    });
    return c.json({ data: { id, tenantId, ...body, admin: body.admin ?? false } }, 201);
  })
  .patch("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const body = RoleInput.partial().parse(await c.req.json());
    await ensureRoleInTenant({ db: ctx.db, dialect: ctx.dialect }, tenantId, c.req.param("id"));
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .update(t.roles)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.admin !== undefined ? { admin: body.admin } : {}),
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(and(eq(t.roles.id, c.req.param("id")), eq(t.roles.tenantId, tenantId)));
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    const id = c.req.param("id");
    const row = await ensureRoleInTenant({ db: ctx.db, dialect: ctx.dialect }, tenantId, id);
    if (SYSTEM_ROLE_NAMES.has(row.name)) {
      throw new AppError("FORBIDDEN", `Cannot delete system role "${row.name}"`);
    }
    await (ctx.db as any)
      .delete(t.roles)
      .where(and(eq(t.roles.id, id), eq(t.roles.tenantId, tenantId)));
    return c.json({ ok: true });
  })
  .get("/:id/permissions", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    await ensureRoleInTenant({ db: ctx.db, dialect: ctx.dialect }, tenantId, c.req.param("id"));
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any)
      .select()
      .from(t.permissions)
      .where(eq(t.permissions.roleId, c.req.param("id")));
    return c.json({ data: rows });
  })
  .post("/:id/permissions", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    await ensureRoleInTenant({ db: ctx.db, dialect: ctx.dialect }, tenantId, c.req.param("id"));
    const body = PermissionInput.parse({
      ...(await c.req.json()),
      roleId: c.req.param("id"),
    });
    const t = tableFor(ctx.dialect);
    const id = crypto.randomUUID();
    await (ctx.db as any).insert(t.permissions).values({
      id,
      roleId: body.roleId,
      collection: body.collection,
      action: body.action,
      fields: body.fields ?? null,
      condition: body.condition ?? null,
    });
    return c.json({ data: { id, ...body } }, 201);
  });

export const permissionsRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    // A permission belongs to a role which belongs to a tenant. Look it up
    // through the role to make sure the caller isn't deleting a permission
    // in another workspace by guessing the id.
    const row = (await (ctx.db as any)
      .select({ tenantId: t.roles.tenantId })
      .from(t.permissions)
      .innerJoin(t.roles, eq(t.permissions.roleId, t.roles.id))
      .where(eq(t.permissions.id, c.req.param("id")))
      .limit(1)) as { tenantId: string | null }[];
    if (!row[0] || row[0].tenantId !== tenantId) {
      throw new AppError("NOT_FOUND", "Permission not found in this workspace");
    }
    await (ctx.db as any).delete(t.permissions).where(eq(t.permissions.id, c.req.param("id")));
    return c.json({ ok: true });
  });

export const usersRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  .get("/", async (c) => {
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
      const ts = typeof s.createdAt === "number" ? s.createdAt : new Date(s.createdAt as string).getTime();
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
  })
  .post("/:id/roles", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const userId = c.req.param("id");
    const body = z.object({ roleId: z.string() }).parse(await c.req.json());
    // Role must belong to active tenant.
    await ensureRoleInTenant({ db: ctx.db, dialect: ctx.dialect }, tenantId, body.roleId);
    const t = tableFor(ctx.dialect);
    // User must be a member of active tenant.
    const memberRows = (await (ctx.db as any)
      .select({ id: t.tenantMembers.id })
      .from(t.tenantMembers)
      .where(and(eq(t.tenantMembers.tenantId, tenantId), eq(t.tenantMembers.userId, userId)))
      .limit(1)) as { id: string }[];
    if (!memberRows[0]) throw new AppError("NOT_FOUND", "User not in this workspace");
    await (ctx.db as any)
      .insert(t.userRoles)
      .values({ userId, roleId: body.roleId })
      .onConflictDoNothing();
    return c.json({ ok: true });
  })
  .delete("/:id/roles/:roleId", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    await ensureRoleInTenant({ db: ctx.db, dialect: ctx.dialect }, tenantId, c.req.param("roleId"));
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .delete(t.userRoles)
      .where(
        and(
          eq(t.userRoles.userId, c.req.param("id")),
          eq(t.userRoles.roleId, c.req.param("roleId")),
        ),
      );
    return c.json({ ok: true });
  })
  /**
   * Email-based invite. Creates a one-time `verification` row consumed by
   * better-auth on the magic-link endpoint. The actual user record is
   * created when the invitee clicks through and verifies.
   */
  .post("/invite", async (c) => {
    const ctx = c.get("ctx");
    const body = z
      .object({
        email: z.string().email(),
        role: z.string().optional(),
      })
      .parse(await c.req.json());
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
  })
  /** Suspend the user's membership in the active tenant. The global user
   *  record is left untouched — they may still belong to other workspaces.
   *  Global sessions are revoked because better-auth's session table isn't
   *  tenant-aware; the user can sign back in but won't see this workspace. */
  .patch("/:id/suspend", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    const id = c.req.param("id");
    await assertTenantMember(ctx, tenantId, id);
    await (ctx.db as any)
      .update(t.tenantMembers)
      .set({
        status: "suspended",
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(and(eq(t.tenantMembers.tenantId, tenantId), eq(t.tenantMembers.userId, id)));
    await (ctx.db as any).delete(t.sessions).where(eq(t.sessions.userId, id));
    return c.json({ ok: true });
  })
  /** Re-enable a suspended membership in the active tenant. */
  .patch("/:id/activate", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    const id = c.req.param("id");
    await assertTenantMember(ctx, tenantId, id);
    await (ctx.db as any)
      .update(t.tenantMembers)
      .set({
        status: "active",
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(and(eq(t.tenantMembers.tenantId, tenantId), eq(t.tenantMembers.userId, id)));
    return c.json({ ok: true });
  })
  /** Force-revoke every session for a user. Sessions are global so this
   *  signs the user out of every workspace they belong to — gated on the
   *  user being a member of the active tenant so a tenant admin can't
   *  reach into unrelated users. */
  .post("/:id/sessions/revoke-all", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    const id = c.req.param("id");
    await assertTenantMember(ctx, tenantId, id);
    await (ctx.db as any).delete(t.sessions).where(eq(t.sessions.userId, id));
    return c.json({ ok: true });
  })
  /** Remove the user from the active tenant. The global user record is
   *  preserved — they keep access to any other workspaces they belong to.
   *  Role assignments in this tenant are dropped along the way. */
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const t = tableFor(ctx.dialect);
    const id = c.req.param("id");
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
      .where(and(eq(t.tenantMembers.tenantId, tenantId), eq(t.tenantMembers.userId, id)));
    return c.json({ ok: true });
  });

const assertTenantMember = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string,
  userId: string,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.tenantMembers.id })
    .from(t.tenantMembers)
    .where(and(eq(t.tenantMembers.tenantId, tenantId), eq(t.tenantMembers.userId, userId)))
    .limit(1)) as { id: string }[];
  if (!rows[0]) throw new AppError("NOT_FOUND", "User not in this workspace");
};
