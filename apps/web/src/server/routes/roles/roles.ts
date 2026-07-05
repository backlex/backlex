// Role CRUD + per-role permission rows. Split out of the former
// routes/roles.ts god-file; shared guards/schemas/tables live in
// services/roles/*.
import { AppError } from "@backlex/core";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, } from "drizzle-orm";
import type { AppBindings } from "../../app";
import { errorResponses, OkSchema, SECURITY } from "../../lib/openapi";
import { requireUser } from "../../middleware/session";
import {
  invalidateTenantPermissions,
  invalidateTenantRoles,
} from "../../services/permissions-cache";
import {
  requireAdminMw,
  requireTenant,
} from "../../services/roles/guards";
import { ensureRoleInTenant } from "../../services/roles/role-checks";
import {
  PermissionInput,
  PermissionRowSchema,
  ROLES_TAG,
  RoleInput,
  RoleRowSchema,
  SYSTEM_ROLE_NAMES,
} from "../../services/roles/schemas";
import { tableFor } from "../../services/roles/tables";

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
      // Admin flag could've flipped → any cached role row for this tenant is
      // suspect; permission rows are still tied to role IDs but flushing both
      // is cheap and removes the foot-gun.
      invalidateTenantRoles(tenantId);
      invalidateTenantPermissions(tenantId);
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
      // Users in this tenant may have lost a role; permissions keyed on the
      // dropped role ID are now ghosts. Flush both slices.
      invalidateTenantRoles(tenantId);
      invalidateTenantPermissions(tenantId);
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
      invalidateTenantPermissions(tenantId);
      return c.json({ data: { id: permId, ...body } }, 201);
    },
  );
