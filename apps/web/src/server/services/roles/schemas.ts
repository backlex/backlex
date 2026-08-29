import { z } from "@hono/zod-openapi";
import { SYSTEM_ROLES } from "@backlex/core";

export const SYSTEM_ROLE_NAMES = new Set<string>([
  SYSTEM_ROLES.admin,
  SYSTEM_ROLES.authenticated,
  SYSTEM_ROLES.public,
]);

/** Allowlist entries are canonical (dotted) MCP tool ids, or `namespace.*` /
 *  `*` globs. Whitespace and empty strings are rejected outright — an empty
 *  entry silently matches nothing and reads like a mistake, which is exactly
 *  what it is. */
export const McpToolPattern = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^(\*|[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*(\.\*)?)$/,
    "must be a tool id (`collections.read`) or a glob (`collections.*`, `*`)",
  );

export const RoleInput = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    admin: z.boolean().optional(),
    /** Role-scoped MCP tool allowlist. `null` = this role imposes none. */
    mcpTools: z.array(McpToolPattern).nullable().optional(),
    /** Role-scoped MCP read-only lock. */
    mcpReadOnly: z.boolean().optional(),
    /** May an organization admin bind this role to their own members from the
     *  app plane? Defaults to false — a role stays the operator's unless its
     *  author says otherwise. */
    orgAssignable: z.boolean().optional(),
  })
  .openapi("RoleInput");

export const RoleRowSchema = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    admin: z.boolean(),
    mcpTools: z.array(z.string()).nullable(),
    mcpReadOnly: z.boolean(),
    orgAssignable: z.boolean(),
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

/**
 * One entry of a role's COMPLETE desired permission set.
 *
 * `id` is optional, and that is what makes the diff non-destructive. When the
 * client sends it, that stored row is the one being described — so a condition
 * can be rewritten, or a grant moved to another collection, without the row
 * losing its identity and the audit trail already keyed to it. When the client
 * omits it, the entry is matched against an existing row with the same
 * `(collection, action)`, and creates one when there is none.
 *
 * The second half is what the role editor actually needs. That screen is a
 * MATRIX: it knows which cells are ticked, not which database rows back them.
 * Requiring it to carry row ids to express "read on posts" would be asking the
 * client to reimplement this diff, which is the one thing it cannot do
 * atomically.
 */
export const PermissionSetEntry = z
  .object({
    id: z.string().min(1).optional(),
    collection: z.string().min(1),
    action: z.enum(["read", "create", "update", "delete", "publish"]),
    fields: z.array(z.string()).nullable().optional(),
    condition: z.unknown().nullable().optional(),
  })
  .openapi("PermissionSetEntry");

/**
 * Body for `PUT /api/roles/{id}/permissions` — the role's whole permission set,
 * not a delta. Anything the role holds today and this array does not name is
 * revoked.
 *
 * The cap is deliberately generous rather than absent: five actions across a
 * few hundred collections is a legitimate set for a large workspace, while an
 * unbounded array is a write amplifier aimed at the permission table and the
 * audit log by anyone holding an admin session.
 */
export const PermissionSetInput = z
  .object({
    permissions: z.array(PermissionSetEntry).max(1000),
  })
  .openapi("PermissionSetInput");

/**
 * What the set replace answers with.
 *
 * `data` is read back OUT of the table after the writes rather than echoed from
 * the request. "The server accepted my payload" and "the rows now say what I
 * asked for" are different claims, and this endpoint exists precisely because
 * the second one was being asserted by a screen that never made the first.
 */
export const PermissionSetResult = z
  .object({
    data: z.array(PermissionRowSchema),
    applied: z.object({
      created: z.number().int(),
      updated: z.number().int(),
      deleted: z.number().int(),
      unchanged: z.number().int(),
    }),
  })
  .openapi("PermissionSetResult");

/**
 * Body for `PATCH /api/permissions/{id}`.
 *
 * Only the two mutable halves of a grant. `roleId`, `collection` and `action`
 * are the row's identity as far as the resolver's lookup is concerned; moving a
 * grant between cells goes through the set replace, which can see the whole
 * picture and so will not leave a duplicate behind.
 *
 * Both keys are optional so a caller can edit one without restating the other,
 * and an explicit `null` is meaningful — it CLEARS the condition or the field
 * allow-list. That is why the handler tests for key PRESENCE rather than for a
 * truthy value: `{"condition": null}` and `{}` mean different things.
 */
export const PermissionPatchInput = z
  .object({
    fields: z.array(z.string()).nullable().optional(),
    condition: z.unknown().nullable().optional(),
  })
  .openapi("PermissionPatchInput");

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
  })
  .openapi("UserRow");
// There is deliberately no `inviteUrl` here any more. It used to carry
// `{APP_URL}/invite?token=<plaintext token>` for every pending invite, which
// made a plain list read — or a logged response body, or a screenshot — a
// working credential that seats an account at the invited standing, `admin`
// included. The token is still reachable the two ways an invitee legitimately
// gets it: the emailed link, and the CREATE response, which is the one moment
// the caller actually holds it. Re-copying an old link is a resend, not a read.

export const UserAttachRoleInput = z
  .object({ roleId: z.string() })
  .openapi("UserAttachRoleInput");

export const UserUpdateInput = z
  .object({ name: z.string().trim().min(1).max(200) })
  .openapi("UserUpdateInput");

/**
 * The membership standings `POST /api/users/invite` will mint.
 *
 * Deliberately narrower than what `WORKSPACE_RANK` can READ: `editor` is still
 * ranked, because rows written before it was deprecated still carry it and a
 * guard that scored it 0 would let anyone act on those people — but it is no
 * longer offered to a new invite. Reading a value the API no longer accepts is
 * a different thing from accepting it.
 */
export const WORKSPACE_INVITE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceInviteRole = (typeof WORKSPACE_INVITE_ROLES)[number];

/**
 * Body for the Users-page invite.
 *
 * `role` used to be the whole story: one free-text string, no enum, written
 * verbatim into `tenant_members.role`. That column is the workspace MEMBERSHIP
 * LADDER — `assertWorkspaceAccess` reads it to decide who may manage the
 * workspace — while the Users page was offering the RBAC role list
 * (`authenticated`, `admin`, customs) from the `roles` table. Two vocabularies,
 * one unconstrained TEXT column, and the sibling surface
 * (`POST /api/tenants/{id}/members/invite`) validating a real enum against the
 * same column. A teammate invited as `authenticated` therefore landed with a
 * standing no ladder reader recognises, could never manage members, and got no
 * error explaining why.
 *
 * So the two meanings get two fields. `workspaceRole` is the standing and is
 * the only thing that reaches that column; the RBAC role the invitee lands with
 * follows from the standing (see `standingToRbacRole` in `services/invites.ts`).
 */
export const UserInviteInput = z
  .object({
    email: z.string().email(),
    workspaceRole: z
      .enum(WORKSPACE_INVITE_ROLES)
      .optional()
      .openapi({
        description:
          "Membership standing in the workspace — what the invitee may DO to the workspace itself. Defaults to `member`. Granting a standing above your own is refused.",
        example: "member",
      }),
    role: z
      .string()
      .optional()
      .openapi({
        deprecated: true,
        description:
          "DEPRECATED — use `workspaceRole`. Accepted for one release and mapped to whichever meaning it actually named: a ladder value (`owner`/`admin`/`editor`/`member`) is read as the membership standing, anything else must name an RBAC role that exists in this workspace and is read as the role to bind on accept. A value that names neither is now refused instead of being written to the membership column.",
      }),
  })
  .openapi("UserInviteInput");

/** What `POST /api/users/invite` answers. The token and its link appear HERE
 *  and nowhere else — this is the one response whose caller legitimately holds
 *  the credential (see the note on `UserRow`). `workspaceRole` / `rbacRole`
 *  echo how the request was interpreted, so a caller sending the deprecated
 *  `role` can see which of the two meanings it was read as rather than guess. */
export const UserInviteResult = z
  .object({
    id: z.string(),
    email: z.string(),
    token: z.string(),
    /** Ready-to-share accept link (`{APP_URL}/invite?token=…`). */
    url: z.string(),
    /** False when the mail only hit the console fallback — the UI should
     *  surface `url` for manual sharing instead. */
    sent: z.boolean(),
    /** The membership standing this invite will confer. */
    workspaceRole: z.string(),
    /** The RBAC role name that binds on accept. */
    rbacRole: z.string(),
  })
  .openapi("UserInviteResult");

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
