import { type Action, type Condition, SYSTEM_ROLES } from "@backlex/core";
import type { PgDb } from "@backlex/db/pg";
import * as pg from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import * as sqlite from "@backlex/db/sqlite";
import { and, eq, isNull } from "drizzle-orm";
import { invalidateTenantMembership } from "./permissions-cache";

export interface DbCtx {
  db: PgDb | SqliteDb;
  dialect: "pg" | "sqlite";
}

const tablesFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        roles: pg.schema.roles,
        userRoles: pg.schema.userRoles,
        appUserRoles: pg.schema.appUserRoles,
        permissions: pg.schema.permissions,
        users: pg.schema.users,
        tenants: pg.schema.tenants,
        tenantMembers: pg.schema.tenantMembers,
      }
    : {
        roles: sqlite.schema.roles,
        userRoles: sqlite.schema.userRoles,
        appUserRoles: sqlite.schema.appUserRoles,
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
    invalidateTenantMembership(tenantId);
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
  invalidateTenantMembership(tenantId);
};

export const ensureSystemRoles = async (
  ctx: DbCtx,
  tenantId: string,
): Promise<void> => {
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
      .where(and(eq(t.roles.tenantId, tenantId), eq(t.roles.name, r.name)))
      .limit(1);
    if (exists[0]) continue;
    await (ctx.db as any).insert(t.roles).values({
      id: crypto.randomUUID(),
      tenantId,
      name: r.name,
      description: r.description,
      admin: r.admin,
    });
  }
};

export const getRoleByName = async (
  ctx: DbCtx,
  tenantId: string,
  name: string,
): Promise<{ id: string; admin: boolean } | null> => {
  const t = tablesFor(ctx.dialect);
  const rows = await (ctx.db as any)
    .select({ id: t.roles.id, admin: t.roles.admin })
    .from(t.roles)
    .where(and(eq(t.roles.tenantId, tenantId), eq(t.roles.name, name)))
    .limit(1);
  return rows[0] ?? null;
};

export const assignRoleByName = async (
  ctx: DbCtx,
  tenantId: string,
  userId: string,
  roleName: string,
): Promise<void> => {
  const role = await getRoleByName(ctx, tenantId, roleName);
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

/**
 * `assignRoleByName` for the workspace end-user pool. Looks up the role by
 * `(tenant_id, name)` and writes to `app_user_roles` rather than
 * `user_roles`. Used by the SAML/LDAP provisioner to attach the implicit
 * `authenticated` role on first login.
 */
export const assignAppUserRoleByName = async (
  ctx: DbCtx,
  tenantId: string,
  appUserId: string,
  roleName: string,
): Promise<void> => {
  const role = await getRoleByName(ctx, tenantId, roleName);
  if (!role) return;
  const t = tablesFor(ctx.dialect);
  const existing = await (ctx.db as any)
    .select({ roleId: t.appUserRoles.roleId })
    .from(t.appUserRoles)
    .where(eq(t.appUserRoles.appUserId, appUserId));
  if (existing.some((r: { roleId: string }) => r.roleId === role.id)) return;
  await (ctx.db as any).insert(t.appUserRoles).values({
    appUserId,
    roleId: role.id,
  });
};

export const userCount = async (ctx: DbCtx): Promise<number> => {
  const t = tablesFor(ctx.dialect);
  const rows = await (ctx.db as any).select({ id: t.users.id }).from(t.users);
  return rows.length;
};

/**
 * Platform-default email templates. Seeded with `tenant_id = NULL` so they act
 * as the cross-tenant fallback the Email Templates admin page and
 * `sendTemplatedEmail` resolve against. Seeding is additive only — once a row
 * exists it's never overwritten, so admin edits survive a redeploy.
 */
export const DEFAULT_EMAIL_TEMPLATES: {
  key: string;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  variables: string[];
}[] = [
  {
    key: "verify",
    name: "Verify email",
    subject: "Confirm your {{ site.name }} email",
    bodyHtml:
      `<p>Welcome to {{ site.name }}!</p>\n` +
      `<p>Confirm your email address to finish setting up your account.</p>\n` +
      `<p><a href="{{ confirm_url }}">Confirm email</a></p>\n` +
      `<p>If you didn't create an account you can safely ignore this message.</p>`,
    bodyText:
      `Welcome to {{ site.name }}!\n\n` +
      `Confirm your email address: {{ confirm_url }}\n\n` +
      `If you didn't create an account you can safely ignore this message.`,
    variables: ["user.email", "confirm_url", "site.name"],
  },
  {
    key: "reset",
    name: "Reset password",
    subject: "Reset your {{ site.name }} password",
    bodyHtml:
      `<p>We received a request to reset the password for {{ user.email }}.</p>\n` +
      `<p><a href="{{ reset_url }}">Choose a new password</a></p>\n` +
      `<p>This link expires soon. If you didn't ask for this, no action is needed.</p>`,
    bodyText:
      `We received a request to reset the password for {{ user.email }}.\n\n` +
      `Choose a new password: {{ reset_url }}\n\n` +
      `This link expires soon. If you didn't ask for this, no action is needed.`,
    variables: ["user.email", "reset_url", "site.name"],
  },
  {
    key: "magic",
    name: "Magic sign-in link",
    subject: "Your {{ site.name }} sign-in link",
    bodyHtml:
      `<p>Click below to sign in to {{ site.name }}.</p>\n` +
      `<p><a href="{{ magic_url }}">Sign in</a></p>\n` +
      `<p>This link works once and expires soon.</p>`,
    bodyText:
      `Click to sign in to {{ site.name }}: {{ magic_url }}\n\n` +
      `This link works once and expires soon.`,
    variables: ["user.email", "magic_url", "site.name"],
  },
  {
    key: "invite",
    name: "Workspace invite",
    subject: "You've been invited to {{ site.name }}",
    bodyHtml:
      `<p>{{ inviter.email }} invited you to join their workspace on {{ site.name }}.</p>\n` +
      `<p><a href="{{ invite_url }}">Accept invite</a></p>`,
    bodyText:
      `{{ inviter.email }} invited you to join their workspace on {{ site.name }}.\n\n` +
      `Accept invite: {{ invite_url }}`,
    variables: ["user.email", "inviter.email", "invite_url", "site.name"],
  },
  {
    key: "change_email",
    name: "Confirm email change",
    subject: "Confirm your new {{ site.name }} email",
    bodyHtml:
      `<p>Confirm that you want to use this address for your {{ site.name }} account.</p>\n` +
      `<p><a href="{{ confirm_url }}">Confirm new email</a></p>\n` +
      `<p>If this wasn't you, contact support right away.</p>`,
    bodyText:
      `Confirm that you want to use this address for your {{ site.name }} account.\n\n` +
      `Confirm new email: {{ confirm_url }}\n\n` +
      `If this wasn't you, contact support right away.`,
    variables: ["user.email", "confirm_url", "site.name"],
  },
];

export const seedEmailTemplates = async (ctx: DbCtx): Promise<void> => {
  const t =
    ctx.dialect === "pg" ? pg.schema.emailTemplates : sqlite.schema.emailTemplates;
  for (const tpl of DEFAULT_EMAIL_TEMPLATES) {
    try {
      const exists = await (ctx.db as any)
        .select({ id: t.id })
        .from(t)
        .where(and(isNull(t.tenantId), eq(t.key, tpl.key)))
        .limit(1);
      if (exists[0]) continue;
      await (ctx.db as any).insert(t).values({
        id: crypto.randomUUID(),
        tenantId: null,
        key: tpl.key,
        name: tpl.name,
        subject: tpl.subject,
        fromAddress: null,
        bodyHtml: tpl.bodyHtml,
        bodyText: tpl.bodyText,
        variables: tpl.variables,
        updatedBy: null,
      });
    } catch {
      // The email_templates table may not exist yet (a Postgres deploy that
      // predates the admin-tables migration, or a fresh D1/SQLite db that
      // hasn't run its migrations). Bail quietly — the next migration run
      // makes this work; the route handles the missing table on its own.
      return;
    }
  }
};

const OWNER_CONDITION: Condition = {
  owner_id: { _eq: "$user.id" },
};

export const seedOwnerScopedPermissions = async (
  ctx: DbCtx,
  tenantId: string,
  collectionSlug: string,
): Promise<void> => {
  const role = await getRoleByName(ctx, tenantId, SYSTEM_ROLES.authenticated);
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
