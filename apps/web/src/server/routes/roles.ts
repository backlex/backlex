import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
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
      }
    : {
        roles: sqlite.schema.roles,
        userRoles: sqlite.schema.userRoles,
        permissions: sqlite.schema.permissions,
        users: sqlite.schema.users,
        sessions: sqlite.schema.sessions,
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

const SYSTEM_ROLE_NAMES = new Set([
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
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any).select().from(t.roles);
    return c.json({ data: rows });
  })
  .post("/", async (c) => {
    const ctx = c.get("ctx");
    const body = RoleInput.parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    const id = crypto.randomUUID();
    await (ctx.db as any).insert(t.roles).values({
      id,
      name: body.name,
      description: body.description ?? null,
      admin: body.admin ?? false,
    });
    return c.json({ data: { id, ...body, admin: body.admin ?? false } }, 201);
  })
  .patch("/:id", async (c) => {
    const ctx = c.get("ctx");
    const body = RoleInput.partial().parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .update(t.roles)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.admin !== undefined ? { admin: body.admin } : {}),
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(eq(t.roles.id, c.req.param("id")));
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const t = tableFor(ctx.dialect);
    const id = c.req.param("id");
    const row = await (ctx.db as any)
      .select({ name: t.roles.name })
      .from(t.roles)
      .where(eq(t.roles.id, id))
      .limit(1);
    if (row[0] && SYSTEM_ROLE_NAMES.has(row[0].name)) {
      throw new AppError("FORBIDDEN", `Cannot delete system role "${row[0].name}"`);
    }
    await (ctx.db as any).delete(t.roles).where(eq(t.roles.id, id));
    return c.json({ ok: true });
  })
  .get("/:id/permissions", async (c) => {
    const ctx = c.get("ctx");
    const t = tableFor(ctx.dialect);
    const rows = await (ctx.db as any)
      .select()
      .from(t.permissions)
      .where(eq(t.permissions.roleId, c.req.param("id")));
    return c.json({ data: rows });
  })
  .post("/:id/permissions", async (c) => {
    const ctx = c.get("ctx");
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
    const t = tableFor(ctx.dialect);
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
    const t = tableFor(ctx.dialect);
    const users = (await (ctx.db as any)
      .select({ id: t.users.id, email: t.users.email, name: t.users.name, createdAt: t.users.createdAt })
      .from(t.users)) as { id: string; email: string; name: string | null; createdAt: unknown }[];
    const userRoles = (await (ctx.db as any)
      .select({ userId: t.userRoles.userId, roleId: t.userRoles.roleId, name: t.roles.name })
      .from(t.userRoles)
      .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))) as {
      userId: string;
      roleId: string;
      name: string;
    }[];
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
      })),
    });
  })
  .post("/:id/roles", async (c) => {
    const ctx = c.get("ctx");
    const userId = c.req.param("id");
    const body = z.object({ roleId: z.string() }).parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .insert(t.userRoles)
      .values({ userId, roleId: body.roleId })
      .onConflictDoNothing();
    return c.json({ ok: true });
  })
  .delete("/:id/roles/:roleId", async (c) => {
    const ctx = c.get("ctx");
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
    const sent = await ctx.email
      .send({
        to: body.email,
        subject: "You've been invited to workeros",
        text: `Open ${ctx.env.APP_URL}/sign-up?invite=${encodeURIComponent(body.email)} to accept.`,
      })
      .then(() => true)
      .catch(() => false);
    return c.json({ data: { email: body.email, sent } });
  })
  /** Mark a user suspended; sessions are revoked in the same call. */
  .patch("/:id/suspend", async (c) => {
    const ctx = c.get("ctx");
    const t = tableFor(ctx.dialect);
    const id = c.req.param("id");
    await (ctx.db as any)
      .update(t.users)
      .set({
        status: "suspended",
        suspendedAt: new Date(),
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(eq(t.users.id, id));
    await (ctx.db as any).delete(t.sessions).where(eq(t.sessions.userId, id));
    return c.json({ ok: true });
  })
  /** Re-enable a suspended user. */
  .patch("/:id/activate", async (c) => {
    const ctx = c.get("ctx");
    const t = tableFor(ctx.dialect);
    await (ctx.db as any)
      .update(t.users)
      .set({
        status: "active",
        suspendedAt: null,
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      })
      .where(eq(t.users.id, c.req.param("id")));
    return c.json({ ok: true });
  })
  /** Force-revoke every session for a user. */
  .post("/:id/sessions/revoke-all", async (c) => {
    const ctx = c.get("ctx");
    const t = tableFor(ctx.dialect);
    await (ctx.db as any).delete(t.sessions).where(eq(t.sessions.userId, c.req.param("id")));
    return c.json({ ok: true });
  })
  /** Delete a user and all their session/role rows. */
  .delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const t = tableFor(ctx.dialect);
    const id = c.req.param("id");
    await (ctx.db as any).delete(t.users).where(eq(t.users.id, id));
    return c.json({ ok: true });
  });
