import { Hono } from "hono";
import { z } from "zod";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import {
  assertRoleBindable,
  bindableRoles,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../services/api-keys";

const Input = z.object({
  name: z.string().min(1).max(120).optional(),
  userId: z.string().optional(),
  /** Optional: scope the key to a single role. Must be a role in the active
   *  workspace that the key's owner holds. Null/omitted = the key inherits
   *  the owner's full role set. */
  roleId: z.string().min(1).nullable().optional(),
  expiresAt: z.string().datetime().optional(),
});

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
};

const requireTenant = (c: Context<AppBindings>): string => {
  const tenantId = c.get("auth")?.tenantId ?? null;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const defaultName = () =>
  `Key — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

const sanitize = (
  row: {
    id: string;
    tenantId: string | null;
    prefix: string;
    name: string;
    userId: string;
    roleId: string | null;
    expiresAt: unknown;
    lastUsedAt: unknown;
    revokedAt: unknown;
    createdAt?: unknown;
  },
  roleNames: Map<string, string>,
) => ({
  id: row.id,
  tenantId: row.tenantId,
  prefix: row.prefix,
  name: row.name,
  userId: row.userId,
  roleId: row.roleId,
  roleName: row.roleId ? roleNames.get(row.roleId) ?? null : null,
  expiresAt: row.expiresAt,
  lastUsedAt: row.lastUsedAt,
  revokedAt: row.revokedAt,
  createdAt: row.createdAt,
});

export const apiKeysRoutes = new Hono<AppBindings>()
  .get("/", requireUser, async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
    const rows = await listApiKeys(ctx, tenantId, isAdmin ? null : auth.userId);
    const roleNames = new Map<string, string>();
    for (const r of await bindableRoles(ctx, tenantId, auth.userId!, isAdmin)) {
      roleNames.set(r.id, r.name);
    }
    return c.json({ data: rows.map((r) => sanitize(r, roleNames)) });
  })
  /** Roles the caller may bind to a new key (admins: every workspace role;
   *  others: only the roles they hold). Powers the "scope to role" picker. */
  .get("/available-roles", requireUser, async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
    const roles = await bindableRoles(ctx, tenantId, auth.userId!, isAdmin);
    return c.json({ data: roles });
  })
  .post("/", requireUser, async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const body = Input.parse(await c.req.json());
    const targetUserId = body.userId ?? auth.userId!;
    if (body.userId && body.userId !== auth.userId) requireAdmin(auth);
    if (body.roleId) {
      await assertRoleBindable(ctx, tenantId, targetUserId, body.roleId);
    }
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new AppError("VALIDATION", "expiresAt must be in the future");
    }
    const { row, secret } = await createApiKey(ctx, {
      name: body.name?.trim() || defaultName(),
      userId: targetUserId,
      tenantId,
      roleId: body.roleId ?? null,
      expiresAt,
    });
    const roleNames = new Map<string, string>();
    if (row.roleId) {
      const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
      for (const r of await bindableRoles(ctx, tenantId, auth.userId!, isAdmin)) {
        roleNames.set(r.id, r.name);
      }
    }
    return c.json(
      {
        data: { ...sanitize(row, roleNames), secret },
        warning:
          "Store this secret now. It cannot be retrieved later — only revoked.",
      },
      201,
    );
  })
  .delete("/:id", requireUser, async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const id = c.req.param("id");
    const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
    // listApiKeys is already tenant-scoped, so this both checks ownership
    // and confirms the key belongs to the active workspace in one shot.
    const visible = await listApiKeys(ctx, tenantId, isAdmin ? null : auth.userId);
    if (!visible.some((k) => k.id === id)) {
      throw new AppError("NOT_FOUND", "API key not found");
    }
    await revokeApiKey(ctx, tenantId, id);
    return c.json({ ok: true });
  });
