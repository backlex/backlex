/**
 * Federated identity provisioning for the workspace end-user pool
 * (`app_users` + `external_identities`). Used by the SAML ACS handler and
 * the future LDAP login flow.
 *
 * The contract: given an IdP-asserted subject + a workspace, return the
 * matching `app_users.id`, creating it if needed, and update the
 * `external_identities` link with the latest login metadata.
 *
 * Lookup strategy (in order):
 *
 *   1. `(tenantId, providerType, providerId, subject)` on `external_identities`
 *      — the primary key. Always tried first.
 *   2. When `linkByVerifiedEmail` is true and step 1 finds nothing, try
 *      matching by `(tenantId, email)` on `app_users`. This is the "Just-In-
 *      Time link an existing local account" flow. Default off because it
 *      makes a hostile IdP an account-takeover vector for any local account
 *      sharing an email.
 *   3. Otherwise, create a fresh `app_users` row.
 *
 * Roles:
 *   - Always ensure system roles, then attach the implicit `authenticated`
 *     role to a new app-user (matches the platform `databaseHooks` behaviour).
 *   - If the provider has a `defaultRoleId`, attach that role too (provided
 *     it belongs to the same tenant — a stale id pointing at another
 *     tenant's role is ignored).
 *   - When `groupsToRoles` + `groups` are both supplied, reconcile against
 *     the previous SSO snapshot (`external_identities.rolesFromGroups`):
 *     remove roles that were previously SSO-assigned but aren't in this
 *     login's group set, and add roles that just appeared. Manual role
 *     assignments aren't touched.
 */
import { and, eq } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { PgDb } from "@workeros/db/pg";
import type { SqliteDb } from "@workeros/db/sqlite";
import { assignAppUserRoleByName, ensureSystemRoles } from "./seed";
import { SYSTEM_ROLES } from "@workeros/core";

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };

const tables = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        appUsers: pg.schema.appUsers,
        appUserRoles: pg.schema.appUserRoles,
        externalIdentities: pg.schema.externalIdentities,
        roles: pg.schema.roles,
      }
    : {
        appUsers: sqlite.schema.appUsers,
        appUserRoles: sqlite.schema.appUserRoles,
        externalIdentities: sqlite.schema.externalIdentities,
        roles: sqlite.schema.roles,
      };

export interface ProvisionAppUserArgs {
  ctx: DbCtx;
  tenantId: string;
  /** saml | ldap. */
  providerType: "saml" | "ldap";
  /** For SAML: `saml_providers.id`. For LDAP: a stable identifier such as
   *  `"ldap"` or `"ldap:<server-id>"`. */
  providerId: string;
  /** IdP-side stable identifier — SAML NameID or LDAP DN. */
  subject: string;
  email: string;
  firstName?: string;
  lastName?: string;
  groups?: string[];
  defaultRoleId?: string | null;
  groupsToRoles?: Record<string, string> | null;
  /** When true, an existing app_user matching the IdP-asserted email is
   *  linked to this subject; off by default for security. */
  linkByVerifiedEmail: boolean;
  ipAddress?: string;
  authnContext?: string;
}

export interface ProvisionAppUserResult {
  appUserId: string;
  isNew: boolean;
  /** Role ids assigned via this SSO sync (the snapshot now in
   *  `external_identities.rolesFromGroups`). */
  rolesAssigned: string[];
}

const composeName = (first: string | undefined, last: string | undefined): string | null => {
  const parts = [first, last].filter((s): s is string => !!s && s.trim().length > 0);
  return parts.length > 0 ? parts.join(" ").trim() : null;
};

/**
 * Resolve a group set against `groupsToRoles`, filtering to roles that
 * actually exist *within the active tenant*. Roles in other tenants are
 * silently dropped — same posture as `defaultRoleId` to make
 * cross-tenant misconfiguration safe.
 */
const resolveGroupRoles = async (
  ctx: DbCtx,
  tenantId: string,
  groups: string[],
  map: Record<string, string>,
): Promise<string[]> => {
  const t = tables(ctx.dialect);
  const wanted = new Set<string>();
  for (const g of groups) {
    const rid = map[g];
    if (rid) wanted.add(rid);
  }
  if (wanted.size === 0) return [];
  // Filter to roles that live in this tenant.
  const ids = [...wanted];
  const rows = (await (ctx.db as any)
    .select({ id: t.roles.id })
    .from(t.roles)
    .where(eq(t.roles.tenantId, tenantId))) as { id: string }[];
  const inTenant = new Set(rows.map((r) => r.id));
  return ids.filter((id) => inTenant.has(id));
};

const insertAppUser = async (
  ctx: DbCtx,
  tenantId: string,
  email: string,
  fullName: string | null,
): Promise<string> => {
  const t = tables(ctx.dialect);
  const id = crypto.randomUUID();
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  await (ctx.db as any).insert(t.appUsers).values({
    id,
    tenantId,
    email,
    emailVerified: true, // SSO IdPs are trusted; the email came from the assertion.
    name: fullName,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return id;
};

const findAppUserByEmail = async (
  ctx: DbCtx,
  tenantId: string,
  email: string,
): Promise<string | null> => {
  const t = tables(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.appUsers.id })
    .from(t.appUsers)
    .where(and(eq(t.appUsers.tenantId, tenantId), eq(t.appUsers.email, email)))
    .limit(1)) as { id: string }[];
  return rows[0]?.id ?? null;
};

const findExternalIdentity = async (
  ctx: DbCtx,
  tenantId: string,
  providerType: string,
  providerId: string,
  subject: string,
): Promise<{ id: string; userId: string; rolesFromGroups: string[] | null } | null> => {
  const t = tables(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({
      id: t.externalIdentities.id,
      userId: t.externalIdentities.userId,
      rolesFromGroups: t.externalIdentities.rolesFromGroups,
    })
    .from(t.externalIdentities)
    .where(
      and(
        eq(t.externalIdentities.tenantId, tenantId),
        eq(t.externalIdentities.providerType, providerType),
        eq(t.externalIdentities.providerId, providerId),
        eq(t.externalIdentities.subject, subject),
      ),
    )
    .limit(1)) as { id: string; userId: string; rolesFromGroups: string[] | null }[];
  return rows[0] ?? null;
};

const insertExternalIdentity = async (
  ctx: DbCtx,
  args: {
    tenantId: string;
    plane: "platform" | "app";
    userId: string;
    providerType: string;
    providerId: string;
    subject: string;
    emailAtProvision: string;
    rolesFromGroups: string[] | null;
    ipAddress?: string;
    authnContext?: string;
  },
): Promise<string> => {
  const t = tables(ctx.dialect);
  const id = crypto.randomUUID();
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  await (ctx.db as any).insert(t.externalIdentities).values({
    id,
    tenantId: args.tenantId,
    plane: args.plane,
    userId: args.userId,
    providerType: args.providerType,
    providerId: args.providerId,
    subject: args.subject,
    emailAtProvision: args.emailAtProvision,
    rolesFromGroups: args.rolesFromGroups,
    lastLoginAt: now,
    lastLoginIp: args.ipAddress ?? null,
    lastAuthnContext: args.authnContext ?? null,
    createdAt: now,
  });
  return id;
};

const touchExternalIdentity = async (
  ctx: DbCtx,
  id: string,
  patch: { rolesFromGroups?: string[] | null; ipAddress?: string; authnContext?: string },
): Promise<void> => {
  const t = tables(ctx.dialect);
  const set: Record<string, unknown> = {
    lastLoginAt: ctx.dialect === "pg" ? new Date() : Date.now(),
  };
  if (patch.rolesFromGroups !== undefined) set.rolesFromGroups = patch.rolesFromGroups;
  if (patch.ipAddress !== undefined) set.lastLoginIp = patch.ipAddress ?? null;
  if (patch.authnContext !== undefined) set.lastAuthnContext = patch.authnContext ?? null;
  await (ctx.db as any).update(t.externalIdentities).set(set).where(eq(t.externalIdentities.id, id));
};

const validateDefaultRole = async (
  ctx: DbCtx,
  tenantId: string,
  roleId: string,
): Promise<boolean> => {
  const t = tables(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.roles.id })
    .from(t.roles)
    .where(and(eq(t.roles.id, roleId), eq(t.roles.tenantId, tenantId)))
    .limit(1)) as { id: string }[];
  return rows.length > 0;
};

const upsertAppUserRole = async (
  ctx: DbCtx,
  appUserId: string,
  roleId: string,
): Promise<void> => {
  const t = tables(ctx.dialect);
  const existing = (await (ctx.db as any)
    .select({ roleId: t.appUserRoles.roleId })
    .from(t.appUserRoles)
    .where(
      and(eq(t.appUserRoles.appUserId, appUserId), eq(t.appUserRoles.roleId, roleId)),
    )
    .limit(1)) as { roleId: string }[];
  if (existing.length > 0) return;
  await (ctx.db as any).insert(t.appUserRoles).values({ appUserId, roleId });
};

const removeAppUserRole = async (
  ctx: DbCtx,
  appUserId: string,
  roleId: string,
): Promise<void> => {
  const t = tables(ctx.dialect);
  await (ctx.db as any)
    .delete(t.appUserRoles)
    .where(
      and(eq(t.appUserRoles.appUserId, appUserId), eq(t.appUserRoles.roleId, roleId)),
    );
};

export const provisionAppUser = async (
  args: ProvisionAppUserArgs,
): Promise<ProvisionAppUserResult> => {
  const {
    ctx,
    tenantId,
    providerType,
    providerId,
    subject,
    email,
    firstName,
    lastName,
    groups,
    defaultRoleId,
    groupsToRoles,
    linkByVerifiedEmail,
    ipAddress,
    authnContext,
  } = args;

  // 1. Find the existing external identity.
  let appUserId: string | null = null;
  let isNew = false;
  let externalIdentityId: string | null = null;
  let priorRoles: string[] | null = null;

  const existing = await findExternalIdentity(ctx, tenantId, providerType, providerId, subject);
  if (existing) {
    appUserId = existing.userId;
    externalIdentityId = existing.id;
    priorRoles = existing.rolesFromGroups ?? [];
  }

  // 2. Optional: link by verified email.
  if (!appUserId && linkByVerifiedEmail) {
    const byEmail = await findAppUserByEmail(ctx, tenantId, email);
    if (byEmail) appUserId = byEmail;
  }

  // 3. Provision a new app_user.
  if (!appUserId) {
    const fullName = composeName(firstName, lastName);
    appUserId = await insertAppUser(ctx, tenantId, email, fullName);
    isNew = true;
  }

  // Compute the new SSO-driven role set.
  let newRoles: string[] = [];
  if (groups && groupsToRoles) {
    newRoles = await resolveGroupRoles(ctx, tenantId, groups, groupsToRoles);
  }

  // 4. Link the external identity if it wasn't there yet.
  if (!externalIdentityId) {
    externalIdentityId = await insertExternalIdentity(ctx, {
      tenantId,
      plane: "app",
      userId: appUserId,
      providerType,
      providerId,
      subject,
      emailAtProvision: email,
      rolesFromGroups: groups && groupsToRoles ? newRoles : null,
      ipAddress,
      authnContext,
    });
  } else {
    // Refresh last-login meta on existing rows. The role-snapshot update
    // happens after we apply the reconciliation below.
    await touchExternalIdentity(ctx, externalIdentityId, {
      ipAddress,
      authnContext,
    });
  }

  // 5. Ensure system roles + implicit `authenticated`.
  await ensureSystemRoles(ctx, tenantId);
  await assignAppUserRoleByName(ctx, tenantId, appUserId, SYSTEM_ROLES.authenticated);

  // 6. Default role.
  if (defaultRoleId) {
    const ok = await validateDefaultRole(ctx, tenantId, defaultRoleId);
    if (ok) await upsertAppUserRole(ctx, appUserId, defaultRoleId);
  }

  // 7. Reconcile group → role assignments.
  if (groups && groupsToRoles) {
    const prior = new Set(priorRoles ?? []);
    const now = new Set(newRoles);
    // Remove roles previously assigned via SSO but no longer in the group set.
    for (const rid of prior) {
      if (!now.has(rid)) await removeAppUserRole(ctx, appUserId, rid);
    }
    // Add roles that just appeared.
    for (const rid of now) {
      if (!prior.has(rid)) await upsertAppUserRole(ctx, appUserId, rid);
    }
    if (externalIdentityId) {
      await touchExternalIdentity(ctx, externalIdentityId, {
        rolesFromGroups: newRoles,
        ipAddress,
        authnContext,
      });
    }
  }

  return { appUserId, isNew, rolesAssigned: newRoles };
};
