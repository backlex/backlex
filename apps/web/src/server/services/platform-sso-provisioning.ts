/**
 * Federated identity provisioning for the CONTROL PLANE operator pool
 * (`users` + `user_roles` + `platform_external_identities`). Fork of
 * `services/sso-provisioning.ts` targeting the platform plane.
 *
 * Used by the platform SAML ACS handler and the platform LDAP sign-in flow.
 * Given an IdP-asserted subject, return the matching `users.id`, creating it
 * if needed, and refresh the `platform_external_identities` link.
 *
 * Differences from the workspace provisioner:
 *   - writes `users` (globally-unique email) not `app_users`;
 *   - roles live in the DEFAULT tenant (same model the admin role uses today),
 *     written to `user_roles` via `assignRoleByName`;
 *   - a brand-new operator follows the first-admin posture from
 *     context.ts::onUserCreated (first user → `admin`, else `authenticated`)
 *     and is linked into the default workspace as a member;
 *   - the user is inserted directly (NOT through better-auth) so SSO is JIT:
 *     the IdP is the authorization gate, so the open-signup policy that guards
 *     email/password sign-up does not apply.
 */
import { and, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import {
  assignRoleByName,
  ensureDefaultTenant,
  ensureSystemRoles,
  ensureTenantMembership,
  userCount,
} from "./seed";
import { invalidateUserRoles } from "./permissions-cache";

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };

const tables = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        users: pg.schema.users,
        userRoles: pg.schema.userRoles,
        identities: pg.schema.platformExternalIdentities,
        roles: pg.schema.roles,
      }
    : {
        users: sqlite.schema.users,
        userRoles: sqlite.schema.userRoles,
        identities: sqlite.schema.platformExternalIdentities,
        roles: sqlite.schema.roles,
      };

export interface ProvisionPlatformUserArgs {
  ctx: DbCtx;
  /** saml | ldap. */
  providerType: "saml" | "ldap";
  /** For SAML: `platform_saml_providers.id`. For LDAP: the literal `"ldap"`. */
  providerId: string;
  /** IdP-side stable identifier — SAML NameID or LDAP DN. */
  subject: string;
  email: string;
  firstName?: string;
  lastName?: string;
  groups?: string[];
  defaultRoleId?: string | null;
  /** Tenant-aware group→role map: each IdP group grants `roleId` in `tenantId`
   *  (the operator is auto-membered into that workspace on login). */
  groupsToRoles?: Record<string, { tenantId: string; roleId: string }> | null;
  /** When true, an existing `users` row matching the IdP email is linked to
   *  this subject; off by default (account-takeover vector for a hostile IdP). */
  linkByVerifiedEmail: boolean;
  ipAddress?: string;
  authnContext?: string;
}

export interface ProvisionPlatformUserResult {
  userId: string;
  isNew: boolean;
  rolesAssigned: string[];
}

const composeName = (first?: string, last?: string): string | null => {
  const parts = [first, last].filter((s): s is string => !!s && s.trim().length > 0);
  return parts.length > 0 ? parts.join(" ").trim() : null;
};

/**
 * Resolve a tenant-aware group→role map to the role ids to grant. Each mapped
 * `{ tenantId, roleId }` is honored only when the role really exists in that
 * tenant; the operator is auto-membered into that workspace so the role is
 * meaningful. Returns the (deduped) role ids assigned.
 */
const resolveGroupRoles = async (
  ctx: DbCtx,
  userId: string,
  email: string,
  groups: string[],
  map: Record<string, { tenantId: string; roleId: string }>,
): Promise<string[]> => {
  const out = new Set<string>();
  for (const g of groups) {
    const m = map[g];
    if (!m || !m.tenantId || !m.roleId) continue;
    if (out.has(m.roleId)) continue;
    if (!(await validateRoleInTenant(ctx, m.tenantId, m.roleId))) continue;
    await ensureTenantMembership(ctx, m.tenantId, userId, email, "member");
    out.add(m.roleId);
  }
  return [...out];
};

const insertUser = async (
  ctx: DbCtx,
  email: string,
  fullName: string | null,
): Promise<string> => {
  const t = tables(ctx.dialect);
  const id = crypto.randomUUID();
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  await (ctx.db as any).insert(t.users).values({
    id,
    email,
    emailVerified: true, // SSO IdPs are trusted; the email came from the assertion.
    name: fullName,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return id;
};

const findUserByEmail = async (ctx: DbCtx, email: string): Promise<string | null> => {
  const t = tables(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.users.id })
    .from(t.users)
    .where(eq(t.users.email, email))
    .limit(1)) as { id: string }[];
  return rows[0]?.id ?? null;
};

/** Read a platform user's status (active | suspended | …) or null if missing. */
const userStatus = async (ctx: DbCtx, userId: string): Promise<string | null> => {
  const t = tables(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ status: t.users.status })
    .from(t.users)
    .where(eq(t.users.id, userId))
    .limit(1)) as { status: string }[];
  return rows[0]?.status ?? null;
};

const findIdentity = async (
  ctx: DbCtx,
  providerType: string,
  providerId: string,
  subject: string,
): Promise<{ id: string; userId: string; rolesFromGroups: string[] | null } | null> => {
  const t = tables(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({
      id: t.identities.id,
      userId: t.identities.userId,
      rolesFromGroups: t.identities.rolesFromGroups,
    })
    .from(t.identities)
    .where(
      and(
        eq(t.identities.providerType, providerType),
        eq(t.identities.providerId, providerId),
        eq(t.identities.subject, subject),
      ),
    )
    .limit(1)) as { id: string; userId: string; rolesFromGroups: string[] | null }[];
  return rows[0] ?? null;
};

const insertIdentity = async (
  ctx: DbCtx,
  args: {
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
  await (ctx.db as any).insert(t.identities).values({
    id,
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

const touchIdentity = async (
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
  await (ctx.db as any).update(t.identities).set(set).where(eq(t.identities.id, id));
};

const validateRoleInTenant = async (
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

const upsertUserRole = async (ctx: DbCtx, userId: string, roleId: string): Promise<void> => {
  const t = tables(ctx.dialect);
  const existing = (await (ctx.db as any)
    .select({ roleId: t.userRoles.roleId })
    .from(t.userRoles)
    .where(and(eq(t.userRoles.userId, userId), eq(t.userRoles.roleId, roleId)))
    .limit(1)) as { roleId: string }[];
  if (existing.length > 0) return;
  await (ctx.db as any).insert(t.userRoles).values({ userId, roleId });
};

const removeUserRole = async (ctx: DbCtx, userId: string, roleId: string): Promise<void> => {
  const t = tables(ctx.dialect);
  await (ctx.db as any)
    .delete(t.userRoles)
    .where(and(eq(t.userRoles.userId, userId), eq(t.userRoles.roleId, roleId)));
};

export const provisionPlatformUser = async (
  args: ProvisionPlatformUserArgs,
): Promise<ProvisionPlatformUserResult> => {
  const {
    ctx,
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

  // Roles for platform users live in the default tenant (same as the admin role).
  const tenantId = await ensureDefaultTenant(ctx);

  let userId: string | null = null;
  let isNew = false;
  let identityId: string | null = null;
  let priorRoles: string[] | null = null;

  const existing = await findIdentity(ctx, providerType, providerId, subject);
  if (existing) {
    userId = existing.userId;
    identityId = existing.id;
    priorRoles = existing.rolesFromGroups ?? [];
  }

  if (!userId && linkByVerifiedEmail) {
    const byEmail = await findUserByEmail(ctx, email);
    if (byEmail) userId = byEmail;
  }

  // An existing operator that's been suspended must not be able to re-enter via
  // SSO. (New users are provisioned `active`, so this only gates re-logins.)
  if (userId) {
    const status = await userStatus(ctx, userId);
    if (status && status !== "active") {
      throw new AppError("FORBIDDEN", "This account is suspended");
    }
  }

  if (!userId) {
    userId = await insertUser(ctx, email, composeName(firstName, lastName));
    isNew = true;
    // Seed roles + workspace membership, mirroring context.ts::onUserCreated.
    await ensureSystemRoles(ctx, tenantId);
    const total = await userCount(ctx);
    const role = total <= 1 ? SYSTEM_ROLES.admin : SYSTEM_ROLES.authenticated;
    await assignRoleByName(ctx, tenantId, userId, role);
    await ensureTenantMembership(
      ctx,
      tenantId,
      userId,
      email,
      total <= 1 ? "owner" : "member",
    );
  }

  let newRoles: string[] = [];
  if (groups && groupsToRoles) {
    newRoles = await resolveGroupRoles(ctx, userId, email, groups, groupsToRoles);
  }

  if (!identityId) {
    identityId = await insertIdentity(ctx, {
      userId,
      providerType,
      providerId,
      subject,
      emailAtProvision: email,
      rolesFromGroups: groups && groupsToRoles ? newRoles : null,
      ipAddress,
      authnContext,
    });
  } else {
    await touchIdentity(ctx, identityId, { ipAddress, authnContext });
  }

  // Default role.
  if (defaultRoleId) {
    const ok = await validateRoleInTenant(ctx, tenantId, defaultRoleId);
    if (ok) await upsertUserRole(ctx, userId, defaultRoleId);
  }

  // Reconcile group → role assignments against the prior SSO snapshot.
  let rolesChanged = false;
  if (groups && groupsToRoles) {
    const prior = new Set(priorRoles ?? []);
    const now = new Set(newRoles);
    for (const rid of prior) {
      if (!now.has(rid)) {
        await removeUserRole(ctx, userId, rid);
        rolesChanged = true;
      }
    }
    for (const rid of now) {
      if (!prior.has(rid)) {
        await upsertUserRole(ctx, userId, rid);
        rolesChanged = true;
      }
    }
    await touchIdentity(ctx, identityId, {
      rolesFromGroups: newRoles,
      ipAddress,
      authnContext,
    });
  }

  if (isNew || rolesChanged) invalidateUserRoles(tenantId, userId);

  return { userId, isNew, rolesAssigned: newRoles };
};
