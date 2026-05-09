import { and, eq } from "drizzle-orm";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import { SYSTEM_ROLES, type Action, type Condition } from "@workeros/core";

export interface DbCtx {
  db: PgDb | SqliteDb;
  dialect: "pg" | "sqlite";
}

const tablesFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        roles: pg.schema.roles,
        userRoles: pg.schema.userRoles,
        permissions: pg.schema.permissions,
        users: pg.schema.users,
        tenants: pg.schema.tenants,
        tenantMembers: pg.schema.tenantMembers,
      }
    : {
        roles: sqlite.schema.roles,
        userRoles: sqlite.schema.userRoles,
        permissions: sqlite.schema.permissions,
        users: sqlite.schema.users,
        tenants: sqlite.schema.tenants,
        tenantMembers: sqlite.schema.tenantMembers,
      };

/**
 * Default tenant slug used to back-fill rows created before multi-tenant
 * support was introduced and to land newly signed-up users.
 */
export const DEFAULT_TENANT_SLUG = "default";

const PALETTE = [
  "oklch(0.78 0.16 95)",
  "oklch(0.72 0.18 145)",
  "oklch(0.72 0.16 240)",
  "oklch(0.7 0.16 28)",
  "oklch(0.7 0.18 320)",
  "oklch(0.74 0.14 200)",
];
const colorFor = (slug: string) =>
  PALETTE[Math.abs([...slug].reduce((a, c) => a + c.charCodeAt(0), 0)) % PALETTE.length];

export const ensureDefaultTenant = async (ctx: DbCtx): Promise<string> => {
  const t = tablesFor(ctx.dialect);
  const existing = await (ctx.db as any)
    .select({ id: t.tenants.id })
    .from(t.tenants)
    .where(eq(t.tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);
  if (existing[0]) return existing[0].id as string;
  const id = crypto.randomUUID();
  await (ctx.db as any).insert(t.tenants).values({
    id,
    slug: DEFAULT_TENANT_SLUG,
    name: "Default workspace",
    project: "default",
    branch: "main",
    env: "development",
    mark: "W",
    color: colorFor(DEFAULT_TENANT_SLUG),
    createdBy: null,
  });
  return id;
};

export const ensureTenantMembership = async (
  ctx: DbCtx,
  tenantId: string,
  userId: string,
  email: string,
  role: "owner" | "admin" | "editor" | "member" = "member",
): Promise<void> => {
  const t = tablesFor(ctx.dialect);
  const existing = await (ctx.db as any)
    .select({ id: t.tenantMembers.id, status: t.tenantMembers.status })
    .from(t.tenantMembers)
    .where(
      and(eq(t.tenantMembers.tenantId, tenantId), eq(t.tenantMembers.email, email)),
    )
    .limit(1);
  if (existing[0]) {
    // Promote: link userId, mark active.
    await (ctx.db as any)
      .update(t.tenantMembers)
      .set({ userId, status: "active", joinedAt: new Date() })
      .where(eq(t.tenantMembers.id, existing[0].id));
    return;
  }
  await (ctx.db as any).insert(t.tenantMembers).values({
    id: crypto.randomUUID(),
    tenantId,
    userId,
    email,
    role,
    status: "active",
    joinedAt: new Date(),
  });
};

export const ensureSystemRoles = async (ctx: DbCtx): Promise<void> => {
  const t = tablesFor(ctx.dialect);
  const want: { name: string; description: string; admin: boolean }[] = [
    {
      name: SYSTEM_ROLES.admin,
      description: "Full access; bypasses all permission checks.",
      admin: true,
    },
    {
      name: SYSTEM_ROLES.authenticated,
      description: "Implicit role for any signed-in user.",
      admin: false,
    },
    {
      name: SYSTEM_ROLES.public,
      description: "Anonymous (no session) requests.",
      admin: false,
    },
  ];
  for (const r of want) {
    const exists = await (ctx.db as any)
      .select({ id: t.roles.id })
      .from(t.roles)
      .where(eq(t.roles.name, r.name))
      .limit(1);
    if (exists[0]) continue;
    await (ctx.db as any).insert(t.roles).values({
      id: crypto.randomUUID(),
      name: r.name,
      description: r.description,
      admin: r.admin,
    });
  }
};

export const getRoleByName = async (
  ctx: DbCtx,
  name: string,
): Promise<{ id: string; admin: boolean } | null> => {
  const t = tablesFor(ctx.dialect);
  const rows = await (ctx.db as any)
    .select({ id: t.roles.id, admin: t.roles.admin })
    .from(t.roles)
    .where(eq(t.roles.name, name))
    .limit(1);
  return rows[0] ?? null;
};

export const assignRoleByName = async (
  ctx: DbCtx,
  userId: string,
  roleName: string,
): Promise<void> => {
  const role = await getRoleByName(ctx, roleName);
  if (!role) return;
  const t = tablesFor(ctx.dialect);
  const existing = await (ctx.db as any)
    .select()
    .from(t.userRoles)
    .where(eq(t.userRoles.userId, userId))
    .limit(1);
  if (existing.some((r: { roleId: string }) => r.roleId === role.id)) return;
  await (ctx.db as any).insert(t.userRoles).values({
    userId,
    roleId: role.id,
  });
};

export const userCount = async (ctx: DbCtx): Promise<number> => {
  const t = tablesFor(ctx.dialect);
  const rows = await (ctx.db as any).select({ id: t.users.id }).from(t.users);
  return rows.length;
};

const OWNER_CONDITION: Condition = {
  owner_id: { _eq: "$user.id" },
};

export const seedOwnerScopedPermissions = async (
  ctx: DbCtx,
  collectionSlug: string,
): Promise<void> => {
  const role = await getRoleByName(ctx, SYSTEM_ROLES.authenticated);
  if (!role) return;
  const t = tablesFor(ctx.dialect);

  const existing = await (ctx.db as any)
    .select({ action: t.permissions.action })
    .from(t.permissions)
    .where(
      and(
        eq(t.permissions.roleId, role.id),
        eq(t.permissions.collection, collectionSlug),
      ),
    );
  const haveActions = new Set(
    existing
      .filter((r: { action: string }) =>
        ["read", "create", "update", "delete"].includes(r.action),
      )
      .map((r: { action: string }) => r.action),
  );

  const rows: {
    id: string;
    roleId: string;
    collection: string;
    action: Action;
    condition: Condition | null;
  }[] = [];
  const ensure = (action: Action, condition: Condition | null) => {
    rows.push({
      id: crypto.randomUUID(),
      roleId: role.id,
      collection: collectionSlug,
      action,
      condition,
    });
  };

  if (!haveActions.has("read")) ensure("read", OWNER_CONDITION);
  if (!haveActions.has("create")) ensure("create", null);
  if (!haveActions.has("update")) ensure("update", OWNER_CONDITION);
  if (!haveActions.has("delete")) ensure("delete", OWNER_CONDITION);

  for (const r of rows) {
    await (ctx.db as any).insert(t.permissions).values({
      id: r.id,
      roleId: r.roleId,
      collection: r.collection,
      action: r.action,
      fields: null,
      condition: r.condition,
    });
  }
};
