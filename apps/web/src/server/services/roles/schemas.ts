import { z } from "@hono/zod-openapi";
import { SYSTEM_ROLES } from "@backlex/core";

export const SYSTEM_ROLE_NAMES = new Set<string>([
  SYSTEM_ROLES.admin,
  SYSTEM_ROLES.authenticated,
  SYSTEM_ROLES.public,
]);

export const RoleInput = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    admin: z.boolean().optional(),
  })
  .openapi("RoleInput");

export const RoleRowSchema = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    admin: z.boolean(),
  })
  .openapi("Role");

export const PermissionInput = z
  .object({
    roleId: z.string().min(1),
    collection: z.string().min(1),
    action: z.enum(["read", "create", "update", "delete", "publish"]),
    fields: z.array(z.string()).nullable().optional(),
    condition: z.unknown().nullable().optional(),
  })
  .openapi("PermissionInput");

export const PermissionRowSchema = z
  .object({
    id: z.string(),
    roleId: z.string(),
    collection: z.string(),
    action: z.string(),
    fields: z.array(z.string()).nullable(),
    condition: z.unknown().nullable(),
  })
  .openapi("Permission");

/** Body for the permission simulator. The subject is either an existing user
 *  (`userId` ⇒ roles read live from the DB) or an ad-hoc one (`roles` by name).
 *  Always scoped to the caller's active workspace. */
export const PermissionSimulateInput = z
  .object({
    userId: z.string().min(1).nullable().optional(),
    email: z.string().nullable().optional(),
    roles: z.array(z.string()).nullable().optional(),
    plane: z.enum(["platform", "app"]).optional(),
    collection: z.string().min(1),
    action: z.enum(["read", "create", "update", "delete", "publish"]),
    sampleRow: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("PermissionSimulateInput");

export const PermissionSimRuleSchema = z
  .object({
    permissionId: z.string(),
    roleId: z.string(),
    roleName: z.string(),
    collection: z.string(),
    condition: z.unknown().nullable(),
    fields: z.array(z.string()).nullable(),
    rowMatch: z.boolean().optional(),
  })
  .openapi("PermissionSimRule");

export const PermissionSimResultSchema = z
  .object({
    subject: z.object({
      userId: z.string().nullable(),
      email: z.string().nullable(),
      roles: z.array(z.string()),
      tenantId: z.string().nullable(),
      plane: z.enum(["platform", "app"]),
    }),
    collection: z.string(),
    action: z.string(),
    allowed: z.boolean(),
    isAdmin: z.boolean(),
    reason: z.string(),
    roles: z.array(
      z.object({ id: z.string(), name: z.string(), admin: z.boolean() }),
    ),
    matchedRules: z.array(PermissionSimRuleSchema),
    resolvedVars: z.record(z.string(), z.unknown()),
    whereSql: z
      .object({ sql: z.string(), params: z.array(z.unknown()) })
      .nullable(),
    fields: z.array(z.string()).nullable(),
    rowMatch: z.boolean().optional(),
  })
  .openapi("PermissionSimResult");

export const UserRoleRef = z.object({ id: z.string(), name: z.string() });

export const UserRow = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    createdAt: z.unknown(),
    roles: z.array(UserRoleRef),
    lastSeenAt: z.number().nullable(),
    /** Auth method: a federated identity (`saml`/`ldap`/`cloud`) wins, else the
     *  better-auth account provider (`password`/`github`/`google`/…) —
     *  `invite` for pending invite rows. */
    provider: z.string(),
    /** `active` / `suspended` (membership state) / `invited` (pending invite
     *  — no user record yet; `id` is the tenant_members row id). */
    status: z.string().optional(),
    /** tenant_members row id — present on pending-invite rows so the client
     *  can revoke the invite. */
    memberId: z.string().optional(),
    /** Shareable accept link — present on pending-invite rows so an admin can
     *  re-copy it (deployments without SMTP never emailed it). */
    inviteUrl: z.string().optional(),
  })
  .openapi("UserRow");

export const UserAttachRoleInput = z
  .object({ roleId: z.string() })
  .openapi("UserAttachRoleInput");

export const UserUpdateInput = z
  .object({ name: z.string().trim().min(1).max(200) })
  .openapi("UserUpdateInput");

export const UserInviteInput = z
  .object({ email: z.string().email(), role: z.string().optional() })
  .openapi("UserInviteInput");

export const SessionRow = z
  .object({
    id: z.string(),
    userAgent: z.string().nullable(),
    ipAddress: z.string().nullable(),
    createdAt: z.number().nullable(),
    updatedAt: z.number().nullable(),
  })
  .openapi("SessionRow");

export const ROLES_TAG = ["roles"];
export const PERMISSIONS_TAG = ["permissions"];
export const USERS_TAG = ["users"];
