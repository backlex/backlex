// Role CRUD + per-role permission rows. Split out of the former
// routes/roles.ts god-file; shared guards/schemas/tables live in
// services/roles/*.
import { AppError } from "@backlex/core";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, } from "drizzle-orm";
import type { AppBindings } from "../../app";
import { errorResponses, OkSchema, SECURITY } from "../../lib/openapi";
import { requireUser } from "../../middleware/session";
import { logActivity } from "../../services/activity";
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
  PermissionSetInput,
  PermissionSetResult,
  ROLES_TAG,
  RoleInput,
  RoleRowSchema,
  SYSTEM_ROLE_NAMES,
} from "../../services/roles/schemas";
import { tableFor } from "../../services/roles/tables";
import { defaultHook } from "../../lib/openapi-router";

export const rolesRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
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
        mcpTools: body.mcpTools ?? null,
        mcpReadOnly: body.mcpReadOnly ?? false,
        orgAssignable: body.orgAssignable ?? false,
      });
      // `mcpTools` is an unbounded allow-list — record its SIZE, not its
      // contents, so one role with 300 tools can't dominate the audit table.
      await logActivity(c, {
        action: "create",
        collection: "system_roles",
        itemId: id,
        payload: {
          name: body.name,
          admin: body.admin ?? false,
          orgAssignable: body.orgAssignable ?? false,
          mcpReadOnly: body.mcpReadOnly ?? false,
          mcpToolCount: body.mcpTools?.length ?? null,
        },
      });
      return c.json(
        {
          data: {
            id,
            tenantId,
            ...body,
            admin: body.admin ?? false,
            mcpTools: body.mcpTools ?? null,
            mcpReadOnly: body.mcpReadOnly ?? false,
            orgAssignable: body.orgAssignable ?? false,
          },
        },
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
      const before = await ensureRoleInTenant(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        id,
      );
      // The guard DELETE has carried since it shipped, which PATCH never did —
      // and PATCH is the more dangerous of the two, because it can strip a
      // system role without removing it.
      //
      // Two independent tests both mean "admin" in this codebase and neither
      // knows about the other: `requireAdmin` matches the role NAME on ~190
      // routes, and the permission resolver's bypass matches the `roles.admin`
      // FLAG. So one PATCH could rename `admin` — taking the whole admin route
      // surface away from every user in the workspace at once, through an
      // endpoint that is itself admin-gated, leaving no way back in — or clear
      // the flag while the name stayed, or set the flag on a role called
      // something harmless and hand out an unconditional data bypass under it.
      //
      // Renaming is refused outright. `description` and the MCP/org flags stay
      // editable on a system role, because none of them is load-bearing for
      // either test.
      if (SYSTEM_ROLE_NAMES.has(before.name)) {
        if (body.name !== undefined && body.name !== before.name) {
          throw new AppError(
            "FORBIDDEN",
            `Cannot rename system role "${before.name}" — the permission layer matches it by name, and for "admin" every admin-gated route does too, including this one`,
          );
        }
        if (body.admin !== undefined && body.admin !== before.admin) {
          throw new AppError(
            "FORBIDDEN",
            `Cannot change the admin flag on system role "${before.name}"`,
          );
        }
      }
      // Deliberately NOT guarded: setting `admin: true` on a CUSTOM role.
      // `POST /` already accepts `admin: body.admin ?? false`, so refusing it
      // here would only mean an admin deletes the role and recreates it — a
      // guard that changes the number of requests and not the outcome. The
      // escalation worth refusing is the one with no way back, and that is the
      // rename above: it is reachable through an endpoint that is itself gated
      // on the name being renamed.
      const t = tableFor(ctx.dialect);
      await (ctx.db as any)
        .update(t.roles)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
          ...(body.admin !== undefined ? { admin: body.admin } : {}),
          ...(body.mcpTools !== undefined ? { mcpTools: body.mcpTools } : {}),
          ...(body.mcpReadOnly !== undefined
            ? { mcpReadOnly: body.mcpReadOnly }
            : {}),
          ...(body.orgAssignable !== undefined
            ? { orgAssignable: body.orgAssignable }
            : {}),
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        })
        .where(and(eq(t.roles.id, id), eq(t.roles.tenantId, tenantId)));
      // Admin flag could've flipped → any cached role row for this tenant is
      // suspect; permission rows are still tied to role IDs but flushing both
      // is cheap and removes the foot-gun.
      invalidateTenantRoles(tenantId);
      invalidateTenantPermissions(tenantId);
      // Which keys were touched, plus the admin flag BEFORE and AFTER — a role
      // gaining `admin` is the privilege-escalation event this log exists for,
      // and "changed" alone does not say which direction it went.
      await logActivity(c, {
        action: "update",
        collection: "system_roles",
        itemId: id,
        payload: {
          name: before.name,
          changed: Object.keys(body),
          ...(body.admin !== undefined && body.admin !== before.admin
            ? { adminFrom: before.admin, adminTo: body.admin }
            : {}),
          ...(body.mcpTools !== undefined
            ? { mcpToolCount: body.mcpTools?.length ?? null }
            : {}),
        },
      });
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
      await logActivity(c, {
        action: "delete",
        collection: "system_roles",
        itemId: id,
        payload: { name: row.name, admin: row.admin },
      });
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
      // The `condition` DSL and the `fields` allow-list are recorded by SHAPE,
      // never verbatim. A condition can embed literal identifiers and email
      // addresses, and `redact()` only inspects KEY names — a value smuggled
      // inside a condition string would sail straight into the audit table.
      await logActivity(c, {
        action: "create",
        collection: "system_permissions",
        itemId: permId,
        payload: {
          roleId: body.roleId,
          collection: body.collection,
          action: body.action,
          hasCondition: body.condition != null,
          fieldCount: body.fields?.length ?? null,
        },
      });
      return c.json({ data: { id: permId, ...body } }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/{id}/permissions",
      tags: ROLES_TAG,
      summary: "Replace a role's permission set",
      description:
        "Takes the role's COMPLETE desired permission set and diffs it against " +
        "what is stored: entries with no matching row are created, matching " +
        "rows whose `condition` / `fields` differ are updated, and every stored " +
        "row the body does not name is deleted. Answers with the rows as they " +
        "stand AFTER the write, plus a per-operation count. Scoped to the " +
        "active workspace through the parent role.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: PermissionSetInput } },
        },
      },
      responses: {
        200: {
          description: "The role's permission set after the replace",
          content: { "application/json": { schema: PermissionSetResult } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const role = await ensureRoleInTenant(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        id,
      );
      const body = c.req.valid("json");
      const t = tableFor(ctx.dialect);

      // Why the diff lives here rather than in the client.
      //
      // The role editor is set-shaped: an operator ticks cells and presses
      // Save. Expressing that as N separate grant/revoke calls means the
      // browser deciding which rows to delete from a list it fetched some time
      // ago, and a half-applied save if any one of those calls fails — a role
      // left holding create but not read, which reads as "the editor is
      // broken" and is indistinguishable from the bug this endpoint was
      // written to close. The current state is HERE, so the comparison is too.
      //
      // This is one request against one snapshot, not a serializable
      // transaction: D1 has no interactive transactions and this surface has
      // never used one. Two admins saving the same role concurrently still
      // resolve last-write-wins. That is a real limitation and a much smaller
      // one than a client-side diff, which loses to itself even without a
      // second editor.
      const existing = (await (ctx.db as any)
        .select({
          id: t.permissions.id,
          collection: t.permissions.collection,
          action: t.permissions.action,
          fields: t.permissions.fields,
          condition: t.permissions.condition,
        })
        .from(t.permissions)
        .where(eq(t.permissions.roleId, id))) as {
        id: string;
        collection: string;
        action: string;
        fields: string[] | null;
        condition: unknown;
      }[];

      const byId = new Map(existing.map((r) => [r.id, r]));
      // Rows still available to be claimed positionally, bucketed by the cell
      // they occupy. A role CAN hold two rows for one (collection, action) —
      // the resolver ORs their conditions together — so this is a queue per
      // cell rather than a single slot, and a body naming that cell twice
      // keeps both rows instead of collapsing an OR-set nobody asked it to
      // touch.
      const pool = new Map<string, string[]>();
      const cellKey = (collection: string, action: string) =>
        `${collection} ${action}`;
      for (const row of existing) {
        const key = cellKey(row.collection, row.action);
        const bucket = pool.get(key);
        if (bucket) bucket.push(row.id);
        else pool.set(key, [row.id]);
      }
      const takeFromPool = (collection: string, action: string): string | null => {
        const bucket = pool.get(cellKey(collection, action));
        if (!bucket) return null;
        const next = bucket.shift();
        return next ?? null;
      };
      const dropFromPool = (collection: string, action: string, rowId: string) => {
        const bucket = pool.get(cellKey(collection, action));
        if (!bucket) return;
        const at = bucket.indexOf(rowId);
        if (at >= 0) bucket.splice(at, 1);
      };

      interface Planned {
        rowId: string;
        collection: string;
        action: string;
        fields: string[] | null;
        condition: unknown;
      }
      const toInsert: Planned[] = [];
      const toUpdate: Planned[] = [];
      let unchanged = 0;

      // Entries that name a row come first, so a positional entry can never
      // steal the row an explicit one was about. Without the two passes, the
      // outcome would depend on array order, which the client has no reason to
      // think is significant.
      const withId = body.permissions.filter((p) => p.id !== undefined);
      const withoutId = body.permissions.filter((p) => p.id === undefined);
      const claimed = new Set<string>();

      // `undefined` and `null` collapse to the same stored value here: the
      // body is a COMPLETE set, so an omitted `fields` means "this grant has
      // no field allow-list", not "leave whatever was there". PATCH is the
      // endpoint that distinguishes the two.
      const normalize = (
        entry: { fields?: string[] | null; condition?: unknown },
      ): { fields: string[] | null; condition: unknown } => ({
        fields: entry.fields ?? null,
        condition: entry.condition ?? null,
      });

      // Structural comparison, deliberately shallow: a spurious UPDATE (same
      // meaning, different key order in a condition object) costs one write
      // and nothing else, while a missed one would leave the operator staring
      // at a stale rule — the exact failure this phase exists to end.
      const same = (a: unknown, b: unknown): boolean =>
        JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

      for (const entry of withId) {
        const rowId = entry.id as string;
        const row = byId.get(rowId);
        // The lookup is over THIS role's rows only, so a permission id
        // belonging to another role — in this workspace or another one —
        // lands here rather than being silently adopted.
        if (!row || claimed.has(rowId)) {
          throw new AppError(
            "NOT_FOUND",
            `Permission "${rowId}" does not belong to this role`,
          );
        }
        claimed.add(rowId);
        dropFromPool(row.collection, row.action, rowId);
        const next = normalize(entry);
        if (
          row.collection === entry.collection &&
          row.action === entry.action &&
          same(row.fields, next.fields) &&
          same(row.condition, next.condition)
        ) {
          unchanged += 1;
          continue;
        }
        toUpdate.push({
          rowId,
          collection: entry.collection,
          action: entry.action,
          ...next,
        });
      }

      for (const entry of withoutId) {
        const next = normalize(entry);
        const rowId = takeFromPool(entry.collection, entry.action);
        if (rowId === null) {
          toInsert.push({
            rowId: crypto.randomUUID(),
            collection: entry.collection,
            action: entry.action,
            ...next,
          });
          continue;
        }
        claimed.add(rowId);
        const row = byId.get(rowId)!;
        if (same(row.fields, next.fields) && same(row.condition, next.condition)) {
          unchanged += 1;
          continue;
        }
        toUpdate.push({
          rowId,
          collection: entry.collection,
          action: entry.action,
          ...next,
        });
      }

      const toDelete = existing.filter((r) => !claimed.has(r.id));

      for (const row of toDelete) {
        await (ctx.db as any)
          .delete(t.permissions)
          .where(eq(t.permissions.id, row.id));
      }
      for (const row of toUpdate) {
        await (ctx.db as any)
          .update(t.permissions)
          .set({
            collection: row.collection,
            action: row.action,
            fields: row.fields,
            condition: row.condition,
          })
          .where(eq(t.permissions.id, row.rowId));
      }
      for (const row of toInsert) {
        await (ctx.db as any).insert(t.permissions).values({
          id: row.rowId,
          roleId: id,
          collection: row.collection,
          action: row.action,
          fields: row.fields,
          condition: row.condition,
        });
      }

      // The same slice the grant and revoke paths flush. A save whose effect
      // only appears 30 seconds later is indistinguishable from a save that
      // did not happen, which is the complaint this whole phase answers — so
      // the isolate that served the write must not be the one still answering
      // from the old set.
      invalidateTenantPermissions(tenantId);

      // One row per operator action, not one per changed grant: a matrix save
      // is a single decision, and fanning it out across a few hundred audit
      // rows would bury it under itself. The affected row ids ride along in
      // the payload so an auditor chasing a specific grant can still find the
      // save that touched it — ids are opaque, unlike the condition DSL and
      // the field list, which are recorded by SHAPE only for the reason the
      // POST handler above spells out.
      const touchedIds = [
        ...toInsert.map((r) => r.rowId),
        ...toUpdate.map((r) => r.rowId),
        ...toDelete.map((r) => r.id),
      ];
      const ID_CAP = 50;
      await logActivity(c, {
        action: "update",
        collection: "system_permissions",
        itemId: id,
        payload: {
          roleId: id,
          roleName: role.name,
          created: toInsert.length,
          updated: toUpdate.length,
          deleted: toDelete.length,
          unchanged,
          permissionIds: touchedIds.slice(0, ID_CAP),
          ...(touchedIds.length > ID_CAP
            ? { permissionIdsTruncated: touchedIds.length - ID_CAP }
            : {}),
        },
      });

      // Read back rather than echo — see `PermissionSetResult`.
      const after = await (ctx.db as any)
        .select()
        .from(t.permissions)
        .where(eq(t.permissions.roleId, id));
      return c.json({
        data: after,
        applied: {
          created: toInsert.length,
          updated: toUpdate.length,
          deleted: toDelete.length,
          unchanged,
        },
      });
    },
  );
