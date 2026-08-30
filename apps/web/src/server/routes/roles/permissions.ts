// Permission-row delete + the permission simulator. Split out of the former
// routes/roles.ts god-file.
import { AppError } from "@backlex/core";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq, } from "drizzle-orm";
import type { AppBindings } from "../../app";
import { errorResponses, OkSchema, SECURITY } from "../../lib/openapi";
import { requireUser } from "../../middleware/session";
import { logActivity } from "../../services/activity";
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
  PermissionPatchInput,
  PermissionRowSchema,
  PermissionSimResultSchema,
  PermissionSimulateInput,
} from "../../services/roles/schemas";
import { tableFor } from "../../services/roles/tables";
import { defaultHook } from "../../lib/openapi-router";

export const permissionsRoutes = new OpenAPIHono<AppBindings>({ defaultHook }).openapi(
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
    // The scope check already reads this row, so widening the select is free —
    // and it has to happen HERE, because after the DELETE there is nothing
    // left to say which grant was revoked.
    const row = (await (ctx.db as any)
      .select({
        tenantId: t.roles.tenantId,
        roleId: t.permissions.roleId,
        collection: t.permissions.collection,
        action: t.permissions.action,
      })
      .from(t.permissions)
      .innerJoin(t.roles, eq(t.permissions.roleId, t.roles.id))
      .where(eq(t.permissions.id, id))
      .limit(1)) as {
      tenantId: string | null;
      roleId: string;
      collection: string;
      action: string;
    }[];
    const found = row[0];
    if (!found || found.tenantId !== tenantId) {
      throw new AppError("NOT_FOUND", "Permission not found in this workspace");
    }
    await (ctx.db as any).delete(t.permissions).where(eq(t.permissions.id, id));
    invalidateTenantPermissions(tenantId);
    await logActivity(c, {
      action: "delete",
      collection: "system_permissions",
      itemId: id,
      payload: {
        roleId: found.roleId,
        collection: found.collection,
        action: found.action,
      },
    });
    return c.json({ ok: true });
  },
).openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: PERMISSIONS_TAG,
    summary: "Edit a permission's condition or field allow-list",
    description:
      "Partial update of the two mutable halves of a grant. Omitting a key " +
      "leaves it alone; sending it as `null` clears it. The role, collection " +
      "and action are the row's identity and are not editable here — move a " +
      "grant with `PUT /api/roles/{id}/permissions`. Scoped to the active " +
      "workspace via the parent role.",
    security: SECURITY,
    middleware: [requireUser, requireAdminMw],
    request: {
      params: z.object({ id: z.string() }),
      body: {
        required: true,
        content: { "application/json": { schema: PermissionPatchInput } },
      },
    },
    responses: {
      200: {
        description: "The row as it stands after the edit",
        content: {
          "application/json": {
            schema: z.object({ data: PermissionRowSchema }),
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
    const body = c.req.valid("json");
    const t = tableFor(ctx.dialect);

    // Why this endpoint exists at all: before it, the only way to change a
    // stored condition was to delete the row and grant it again. That mints a
    // new id, which orphans every audit row already pointing at the old one —
    // so the record of an authorization rule's history was being destroyed by
    // the ordinary act of correcting it.
    //
    // Absent key vs. explicit null is the whole contract here, so read
    // presence rather than truthiness: `{}` must not silently blank a
    // condition, and `{"condition": null}` must.
    const setsFields = Object.hasOwn(body, "fields");
    const setsCondition = Object.hasOwn(body, "condition");
    if (!setsFields && !setsCondition) {
      throw new AppError(
        "VALIDATION",
        "Nothing to update — send `condition`, `fields`, or both (`null` clears one)",
      );
    }

    // Same scoping shape as the DELETE above: a permission belongs to a role,
    // and the role is what carries the tenant. Guessing a row id from another
    // workspace has to miss here, not at the UPDATE.
    const rows = (await (ctx.db as any)
      .select({
        tenantId: t.roles.tenantId,
        roleId: t.permissions.roleId,
        collection: t.permissions.collection,
        action: t.permissions.action,
      })
      .from(t.permissions)
      .innerJoin(t.roles, eq(t.permissions.roleId, t.roles.id))
      .where(eq(t.permissions.id, id))
      .limit(1)) as {
      tenantId: string | null;
      roleId: string;
      collection: string;
      action: string;
    }[];
    const found = rows[0];
    if (!found || found.tenantId !== tenantId) {
      throw new AppError("NOT_FOUND", "Permission not found in this workspace");
    }

    await (ctx.db as any)
      .update(t.permissions)
      .set({
        ...(setsFields ? { fields: body.fields ?? null } : {}),
        ...(setsCondition ? { condition: body.condition ?? null } : {}),
      })
      .where(eq(t.permissions.id, id));
    invalidateTenantPermissions(tenantId);

    // Shape, never content — a condition can embed literal identifiers and
    // email addresses, and `redact()` only inspects KEY names (see the note on
    // the grant handler in `roles.ts`).
    await logActivity(c, {
      action: "update",
      collection: "system_permissions",
      itemId: id,
      payload: {
        roleId: found.roleId,
        collection: found.collection,
        action: found.action,
        changed: [
          ...(setsCondition ? ["condition"] : []),
          ...(setsFields ? ["fields"] : []),
        ],
        ...(setsCondition ? { hasCondition: body.condition != null } : {}),
        ...(setsFields ? { fieldCount: body.fields?.length ?? null } : {}),
      },
    });

    // Read back rather than echo the request, for the reason the set replace
    // spells out: a 2xx that did nothing is the house bug.
    const after = (await (ctx.db as any)
      .select({
        id: t.permissions.id,
        roleId: t.permissions.roleId,
        collection: t.permissions.collection,
        action: t.permissions.action,
        fields: t.permissions.fields,
        condition: t.permissions.condition,
      })
      .from(t.permissions)
      .where(eq(t.permissions.id, id))
      .limit(1)) as {
      id: string;
      roleId: string;
      collection: string;
      action: string;
      fields: string[] | null;
      condition: unknown;
    }[];
    // The row was just scoped, read and written inside this handler, so its
    // absence here would mean it vanished between two statements — worth a
    // clear 404 rather than a `data: undefined` the client has to interpret.
    const row = after[0];
    if (!row) {
      throw new AppError("NOT_FOUND", "Permission not found in this workspace");
    }
    return c.json({ data: row });
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
