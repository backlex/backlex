// Permission-row delete + the permission simulator. Split out of the former
// routes/roles.ts god-file.
import { AppError } from "@backlex/core";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq, } from "drizzle-orm";
import type { AppBindings } from "../../app";
import { errorResponses, OkSchema, SECURITY } from "../../lib/openapi";
import { requireUser } from "../../middleware/session";
import {
  invalidateTenantPermissions,
} from "../../services/permissions-cache";
import {
  requireAdminMw,
  requireTenant,
} from "../../services/roles/guards";
import { simulatePermission } from "../../services/permissions";
import {
  PERMISSIONS_TAG,
  PermissionSimResultSchema,
  PermissionSimulateInput,
} from "../../services/roles/schemas";
import { tableFor } from "../../services/roles/tables";

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
    invalidateTenantPermissions(tenantId);
    return c.json({ ok: true });
  },
).openapi(
  createRoute({
    method: "post",
    path: "/simulate",
    tags: PERMISSIONS_TAG,
    summary: "Simulate a permission decision",
    description:
      "Dry-run the permission resolver for a subject (an existing user, or " +
      "an ad-hoc set of role names) against a (collection, action). Returns " +
      "the full reasoning trace: matched roles + rules, the resolved DSL " +
      "variables, the compiled WHERE clause, the field allow-list, and the " +
      "allow/deny decision. Pass `sampleRow` to test a concrete row against " +
      "the combined condition. Read-only — never mutates state.",
    security: SECURITY,
    middleware: [requireUser, requireAdminMw],
    request: {
      body: {
        required: true,
        content: {
          "application/json": { schema: PermissionSimulateInput },
        },
      },
    },
    responses: {
      200: {
        description: "Simulation result",
        content: {
          "application/json": {
            schema: z.object({ data: PermissionSimResultSchema }),
          },
        },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const body = c.req.valid("json");
    // Always scoped to the caller's active workspace — an admin can only
    // simulate within the tenant they're signed into.
    const result = await simulatePermission(ctx, {
      userId: body.userId ?? null,
      email: body.email ?? null,
      roles: body.roles ?? null,
      plane: body.plane,
      collection: body.collection,
      action: body.action,
      sampleRow: body.sampleRow ?? null,
      tenantId,
    });
    return c.json({ data: result });
  },
);
