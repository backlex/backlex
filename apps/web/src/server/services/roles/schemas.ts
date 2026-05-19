import { z } from "@hono/zod-openapi";
import { SYSTEM_ROLES } from "@workeros/core";

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
    action: z.enum(["read", "create", "update", "delete"]),
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

export const UserRoleRef = z.object({ id: z.string(), name: z.string() });

export const UserRow = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    createdAt: z.unknown(),
    roles: z.array(UserRoleRef),
    lastSeenAt: z.number().nullable(),
  })
  .openapi("UserRow");

export const UserAttachRoleInput = z
  .object({ roleId: z.string() })
  .openapi("UserAttachRoleInput");

export const UserInviteInput = z
  .object({ email: z.string().email(), role: z.string().optional() })
  .openapi("UserInviteInput");

export const ROLES_TAG = ["roles"];
export const PERMISSIONS_TAG = ["permissions"];
export const USERS_TAG = ["users"];
