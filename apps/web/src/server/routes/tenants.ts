import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { setCookie } from "hono/cookie";
import { and, desc, eq } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { TENANT_COOKIE } from "../middleware/tenant";
import { assignRoleByName, ensureSystemRoles } from "../services/seed";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const tablesFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? { tenants: pg.schema.tenants, members: pg.schema.tenantMembers, users: pg.schema.users }
    : { tenants: sqlite.schema.tenants, members: sqlite.schema.tenantMembers, users: sqlite.schema.users };

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

const PALETTE = [
  "var(--primary)",
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const TenantRow = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    project: z.string(),
    branch: z.string(),
    env: z.string(),
    mark: z.string().nullable(),
    color: z.string().nullable(),
    role: z.string(),
  })
  .openapi("TenantRow");

const CreateTenantInput = z
  .object({
    name: z.string().min(2).max(60),
    project: z.string().max(40).optional(),
    env: z.enum(["development", "staging", "production"]).optional(),
  })
  .openapi("CreateTenantInput");

const InviteInput = z
  .object({
    email: z.string().email(),
    role: z.enum(["owner", "admin", "editor", "member"]).default("member"),
  })
  .openapi("TenantInviteInput");

const SwitchInput = z
  .object({
    /** Either tenant id or slug. */
    tenant: z.string().min(1),
  })
  .openapi("TenantSwitchInput");

const AcceptInput = z
  .object({ token: z.string().min(8) })
  .openapi("TenantAcceptInput");

const TAG = "tenants";

export const tenantsRoutes = new OpenAPIHono<AppBindings>()
  /** List workspaces the caller belongs to. */
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: [TAG],
      summary: "List my workspaces",
      description:
        "Workspaces the caller belongs to. `active` reflects the currently-selected workspace.",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(TenantRow),
                active: z.string().nullable(),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const t = tablesFor(ctx.dialect);
      const rows = (await (ctx.db as any)
        .select({
          id: t.tenants.id,
          slug: t.tenants.slug,
          name: t.tenants.name,
          project: t.tenants.project,
          branch: t.tenants.branch,
          env: t.tenants.env,
          mark: t.tenants.mark,
          color: t.tenants.color,
          role: t.members.role,
        })
        .from(t.members)
        .innerJoin(t.tenants, eq(t.members.tenantId, t.tenants.id))
        .where(eq(t.members.userId, auth.userId!))) as Array<{
          id: string;
          slug: string;
          name: string;
          project: string;
          branch: string;
          env: string;
          mark: string | null;
          color: string | null;
          role: string;
        }>;
      return c.json({ data: rows, active: auth.tenantId ?? null });
    },
  )
  /** Create a new workspace (the caller becomes owner). */
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: [TAG],
      summary: "Create a workspace",
      description:
        "The caller becomes owner. System roles are seeded and the creator is granted `admin`.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: CreateTenantInput } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const t = tablesFor(ctx.dialect);
      const slug = slugify(body.name);
      if (slug.length < 2)
        throw new AppError("VALIDATION", "Workspace name must be 2+ chars (a-z, 0-9, -)");
      const taken = await (ctx.db as any)
        .select({ id: t.tenants.id })
        .from(t.tenants)
        .where(eq(t.tenants.slug, slug))
        .limit(1);
      if (taken[0])
        throw new AppError("CONFLICT", `Workspace "${slug}" already exists`);
      const id = crypto.randomUUID();
      await (ctx.db as any).insert(t.tenants).values({
        id,
        slug,
        name: body.name,
        project: body.project ?? "default",
        branch: "main",
        env: body.env ?? "development",
        mark: body.name.charAt(0).toUpperCase(),
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
        createdBy: auth.userId,
      });
      await (ctx.db as any).insert(t.members).values({
        id: crypto.randomUUID(),
        tenantId: id,
        userId: auth.userId,
        email: auth.email!,
        role: "owner",
        status: "active",
        joinedAt: new Date(),
      });
      // Seed system roles for the new workspace so admin/authenticated/public
      // exist on day one, then make the creator an admin in the RBAC sense
      // (the membership-level "owner" role is orthogonal to the role system).
      const dbCtx = { db: ctx.db, dialect: ctx.dialect };
      await ensureSystemRoles(dbCtx, id);
      await assignRoleByName(dbCtx, id, auth.userId!, SYSTEM_ROLES.admin);
      return c.json({ data: { id, slug, name: body.name } }, 201);
    },
  )
  /** Switch the active tenant cookie for the next requests. */
  .openapi(
    createRoute({
      method: "post",
      path: "/switch",
      tags: [TAG],
      summary: "Switch active workspace",
      description:
        "Sets the workspace cookie. Body `tenant` is matched against id then slug.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: SwitchInput } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({ id: z.string(), slug: z.string() }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const t = tablesFor(ctx.dialect);
      // Resolve by id first, then slug.
      const r = (await (ctx.db as any)
        .select({ id: t.tenants.id, slug: t.tenants.slug })
        .from(t.tenants)
        .where(eq(t.tenants.id, body.tenant))
        .limit(1)) as Array<{ id: string; slug: string }>;
      let target = r[0];
      if (!target) {
        const r2 = (await (ctx.db as any)
          .select({ id: t.tenants.id, slug: t.tenants.slug })
          .from(t.tenants)
          .where(eq(t.tenants.slug, body.tenant))
          .limit(1)) as Array<{ id: string; slug: string }>;
        target = r2[0];
      }
      if (!target) throw new AppError("NOT_FOUND", "Workspace not found");
      // Membership check (admins bypass).
      if (!auth.roles.includes("admin")) {
        const m = await (ctx.db as any)
          .select({ id: t.members.id })
          .from(t.members)
          .where(and(eq(t.members.tenantId, target.id), eq(t.members.userId, auth.userId!)))
          .limit(1);
        if (!m[0])
          throw new AppError("FORBIDDEN", "You are not a member of this workspace");
      }
      setCookie(c, TENANT_COOKIE, target.id, {
        httpOnly: false,
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
      await (ctx.db as any)
        .update(t.users)
        .set({ activeTenantId: target.id, updatedAt: new Date() })
        .where(eq(t.users.id, auth.userId!));
      // Tell tenantMiddleware to keep this value when it re-stamps the cookie
      // post-next (otherwise its closed-over old tenantId overwrites ours).
      c.set("auth", { ...auth, tenantId: target.id });
      return c.json({ data: { id: target.id, slug: target.slug } });
    },
  )
  /** Members of a workspace. Caller must be a member (admins bypass). */
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/members",
      tags: [TAG],
      summary: "List workspace members",
      description: "Caller must be a member (admins bypass).",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(z.record(z.string(), z.unknown())) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      if (!auth.roles.includes("admin")) {
        const ok = await (ctx.db as any)
          .select({ id: t.members.id })
          .from(t.members)
          .where(and(eq(t.members.tenantId, id), eq(t.members.userId, auth.userId!)))
          .limit(1);
        if (!ok[0]) throw new AppError("FORBIDDEN", "Not a member");
      }
      const rows = await (ctx.db as any)
        .select()
        .from(t.members)
        .where(eq(t.members.tenantId, id))
        .orderBy(desc(t.members.createdAt));
      return c.json({ data: rows });
    },
  )
  /** Invite an email into the workspace. */
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/members/invite",
      tags: [TAG],
      summary: "Invite a member",
      description: "Sends an invite email with a 7-day token. Owners/admins only.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        params: z.object({ id: z.string() }),
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
                data: z.object({ id: z.string(), token: z.string() }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      // Caller must have admin/owner role on this tenant (or be a global admin).
      if (!auth.roles.includes("admin")) {
        const m = await (ctx.db as any)
          .select({ role: t.members.role })
          .from(t.members)
          .where(and(eq(t.members.tenantId, id), eq(t.members.userId, auth.userId!)))
          .limit(1);
        if (!m[0] || !["owner", "admin"].includes(m[0].role))
          throw new AppError("FORBIDDEN", "Only owners/admins may invite");
      }
      const existing = await (ctx.db as any)
        .select({ id: t.members.id })
        .from(t.members)
        .where(and(eq(t.members.tenantId, id), eq(t.members.email, body.email)))
        .limit(1);
      if (existing[0])
        throw new AppError("CONFLICT", `${body.email} is already a member or invited`);
      const memberId = crypto.randomUUID();
      const token = crypto.randomUUID().replace(/-/g, "");
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await (ctx.db as any).insert(t.members).values({
        id: memberId,
        tenantId: id,
        userId: null,
        email: body.email,
        role: body.role,
        status: "invited",
        invitedBy: auth.userId,
        invitedAt: new Date(),
        inviteToken: token,
        inviteExpiresAt: expires,
      });
      // Best-effort send through the target workspace's transport. Email adapter
      // handles dev console.
      void ctx
        .emailFor(id)
        .then((transport) =>
          transport.send({
            to: body.email,
            subject: `You've been invited to a workeros workspace`,
            text: `Open ${ctx.env.APP_URL}/invite?token=${token} to accept.`,
          }),
        )
        .catch(() => {});
      return c.json({ data: { id: memberId, token } }, 201);
    },
  )
  /** Remove a member (owner cannot be removed by non-owners). */
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}/members/{memberId}",
      tags: [TAG],
      summary: "Remove a member",
      description: "Owners/admins only.",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ id: z.string(), memberId: z.string() }) },
      responses: {
        200: { description: "Removed", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { id: tenantId, memberId } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      if (!auth.roles.includes("admin")) {
        const m = await (ctx.db as any)
          .select({ role: t.members.role })
          .from(t.members)
          .where(and(eq(t.members.tenantId, tenantId), eq(t.members.userId, auth.userId!)))
          .limit(1);
        if (!m[0] || !["owner", "admin"].includes(m[0].role))
          throw new AppError("FORBIDDEN", "Only owners/admins may remove members");
      }
      await (ctx.db as any)
        .delete(t.members)
        .where(and(eq(t.members.tenantId, tenantId), eq(t.members.id, memberId)));
      return c.json({ ok: true });
    },
  )
  /** Accept an invite token and bind to the current user. */
  .openapi(
    createRoute({
      method: "post",
      path: "/accept",
      tags: [TAG],
      summary: "Accept an invite",
      description: "Consumes the invite token and binds the caller to the workspace.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: AcceptInput } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.object({ tenantId: z.string() }) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const t = tablesFor(ctx.dialect);
      const rows = await (ctx.db as any)
        .select()
        .from(t.members)
        .where(eq(t.members.inviteToken, body.token))
        .limit(1);
      const inv = rows[0];
      if (!inv) throw new AppError("NOT_FOUND", "Invite not found");
      if (inv.inviteExpiresAt && new Date(inv.inviteExpiresAt) < new Date())
        throw new AppError("VALIDATION", "Invite has expired");
      if (inv.email.toLowerCase() !== (auth.email ?? "").toLowerCase())
        throw new AppError("FORBIDDEN", "Invite email does not match signed-in user");
      await (ctx.db as any)
        .update(t.members)
        .set({
          userId: auth.userId,
          status: "active",
          joinedAt: new Date(),
          inviteToken: null,
          inviteExpiresAt: null,
        })
        .where(eq(t.members.id, inv.id));
      // Make sure system roles exist for the workspace (in case it was
      // created before per-tenant seeding shipped), then bind the invitee
      // to an RBAC role mirroring their membership level.
      const dbCtx = { db: ctx.db, dialect: ctx.dialect };
      await ensureSystemRoles(dbCtx, inv.tenantId);
      const rbacRole =
        inv.role === "owner" || inv.role === "admin"
          ? SYSTEM_ROLES.admin
          : SYSTEM_ROLES.authenticated;
      await assignRoleByName(dbCtx, inv.tenantId, auth.userId!, rbacRole);
      return c.json({ data: { tenantId: inv.tenantId } });
    },
  );
