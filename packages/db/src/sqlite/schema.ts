import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/sqlite-core";

const ts = (name: string) =>
  integer(name, { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date());

/**
 * libSQL / Turso native vector column. Emits `F32_BLOB(<dim>)` DDL — a fixed-
 * length float32 blob the libSQL engine understands (`vector32()` writes it,
 * `vector_distance_cos()` / `vector_top_k()` read it). On plain SQLite (Bun) and
 * D1 the type name carries BLOB affinity, so the column is created without error
 * and simply sits unused (those backends route vectors elsewhere). Nullable: it
 * is only populated on the libSQL transport. */
const f32blob = (dim: number) =>
  customType<{ data: Uint8Array; driverData: Uint8Array }>({
    dataType: () => `F32_BLOB(${dim})`,
  })("embedding");

export const tenants = sqliteTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    project: text("project").notNull().default("default"),
    branch: text("branch").notNull().default("main"),
    env: text("env").notNull().default("development"),
    mark: text("mark"),
    color: text("color"),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("tenants_slug_idx").on(t.slug)],
);

export const tenantMembers = sqliteTable(
  "tenant_members",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("active"),
    invitedBy: text("invited_by"),
    invitedAt: integer("invited_at", { mode: "timestamp_ms" }),
    joinedAt: integer("joined_at", { mode: "timestamp_ms" }),
    inviteToken: text("invite_token"),
    inviteExpiresAt: integer("invite_expires_at", { mode: "timestamp_ms" }),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("tenant_members_tenant_email_idx").on(t.tenantId, t.email),
    index("tenant_members_user_idx").on(t.userId),
    index("tenant_members_invite_token_idx").on(t.inviteToken),
  ],
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    name: text("name"),
    image: text("image"),
    /** Preferred UI locale (BCP-47). NULL = inherit the workspace default. */
    locale: text("locale"),
    /** Preferred IANA time zone. NULL = inherit the workspace default. */
    timezone: text("timezone"),
    activeTenantId: text("active_tenant_id"),
    status: text("status").notNull().default("active"),
    suspendedAt: integer("suspended_at", { mode: "timestamp_ms" }),
    isAnonymous: integer("is_anonymous", { mode: "boolean" }).notNull().default(false),
    /** Set once the user has verified a TOTP authenticator — see the pg schema
     *  note. Gates the OTP challenge on the next sign-in. */
    twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).notNull().default(false),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("sessions_token_idx").on(t.token),
    index("sessions_user_idx").on(t.userId),
    index("sessions_created_idx").on(t.createdAt),
  ],
);

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  accountId: text("account_id").notNull(),
  password: text("password"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const verifications = sqliteTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const passkeys = sqliteTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Property key MUST be `credentialID` (capital ID): the @better-auth/passkey
    // plugin maps its `credentialID` field to this Drizzle key. A lowercase
    // `credentialId` makes better-auth throw "field credentialID does not exist
    // in the schema for the model passkey" on verify-authentication. The DB
    // column stays `credential_id`.
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull().default(0),
    deviceType: text("device_type"),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
    transports: text("transports"),
    // Authenticator AAGUID — optional field the passkey plugin reads back on
    // every auth; without the column better-auth errors mapping the row.
    aaguid: text("aaguid"),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("passkey_credential_idx").on(t.credentialID),
    index("passkey_user_idx").on(t.userId),
  ],
);

// Backs better-auth's two-factor (TOTP) plugin — see the matching block in
// ../pg/schema.ts. The plugin also reads / writes `users.two_factor_enabled`.
export const twoFactors = sqliteTable(
  "twoFactor",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    // Lockout state, added by better-auth 1.6.29's two-factor plugin. It counts
    // consecutive bad codes and, past the plugin's threshold, stamps
    // `locked_until` so further attempts are refused until it passes. The
    // adapter looks these up by the property name, so both must stay camelCase.
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
  },
  (t) => [index("two_factor_user_idx").on(t.userId)],
);

/* ─────────────────────────────────────────────────────────────────────
 * MCP OAuth provider (better-auth `mcp` plugin) — see the matching block in
 * ../pg/schema.ts for the full rationale. Property keys MUST match the
 * plugin's camelCase field names; DB columns stay snake_case.
 * ───────────────────────────────────────────────────────────────────── */

export const oauthApplications = sqliteTable(
  "oauth_applications",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    icon: text("icon"),
    metadata: text("metadata"),
    clientId: text("client_id").notNull(),
    clientSecret: text("client_secret"),
    redirectUrls: text("redirect_urls").notNull(),
    type: text("type").notNull(),
    // Written by /mcp/register but absent from the plugin's schema map — the
    // drizzle adapter's checkMissingFields throws on unknown keys, so the
    // column (and this exact property name) must exist.
    authenticationScheme: text("authentication_scheme"),
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("oauth_app_client_idx").on(t.clientId),
    index("oauth_app_user_idx").on(t.userId),
  ],
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    id: text("id").primaryKey(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }).notNull(),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }).notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthApplications.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").notNull(),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("oauth_token_access_idx").on(t.accessToken),
    uniqueIndex("oauth_token_refresh_idx").on(t.refreshToken),
    index("oauth_token_client_idx").on(t.clientId),
    index("oauth_token_user_idx").on(t.userId),
  ],
);

export const oauthConsents = sqliteTable(
  "oauth_consents",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthApplications.clientId, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").notNull(),
    consentGiven: integer("consent_given", { mode: "boolean" }).notNull().default(false),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("oauth_consent_client_idx").on(t.clientId),
    index("oauth_consent_user_idx").on(t.userId),
  ],
);

/* ─────────────────────────────────────────────────────────────────────
 * Workspace end-user auth pool ("auth as a service"). See the matching block
 * in ../pg/schema.ts — these mirror `users`/`sessions`/`accounts`/
 * `verifications` but back a separate, per-tenant identity pool for the
 * end-users of apps built on a workspace. Not wired into request handling yet.
 * ───────────────────────────────────────────────────────────────────── */

export const appUsers = sqliteTable(
  "app_users",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    name: text("name"),
    image: text("image"),
    status: text("status").notNull().default("active"),
    suspendedAt: integer("suspended_at", { mode: "timestamp_ms" }),
    isAnonymous: integer("is_anonymous", { mode: "boolean" }).notNull().default(false),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("app_users_tenant_email_idx").on(t.tenantId, t.email),
    index("app_users_tenant_idx").on(t.tenantId),
  ],
);

export const appSessions = sqliteTable(
  "app_sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** Org this session is currently acting in (`app_orgs.id`). See the PG
     *  schema for why there's no FK. */
    activeOrgId: text("active_org_id"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("app_sessions_token_idx").on(t.token),
    index("app_sessions_user_idx").on(t.userId),
    index("app_sessions_tenant_idx").on(t.tenantId),
  ],
);

export const appAccounts = sqliteTable(
  "app_accounts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("app_accounts_user_idx").on(t.userId),
    index("app_accounts_tenant_idx").on(t.tenantId),
  ],
);

export const appVerifications = sqliteTable(
  "app_verifications",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("app_verifications_tenant_idx").on(t.tenantId),
    index("app_verifications_identifier_idx").on(t.identifier),
  ],
);

export const roles = sqliteTable(
  "roles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description"),
    admin: integer("admin", { mode: "boolean" }).notNull().default(false),
    /** Role-scoped MCP tool allowlist. See the pg/schema.ts twin for the full
     *  contract (globs, union across policy-setting roles, intersection with
     *  the key's own allowlist). `NULL` = this role has no MCP policy — which
     *  is deliberately NOT the same as "allow everything". */
    mcpTools: text("mcp_tools", { mode: "json" }).$type<string[] | null>(),
    /** Role-scoped MCP read-only lock. See the pg/schema.ts twin. */
    mcpReadOnly: integer("mcp_read_only", { mode: "boolean" })
      .notNull()
      .default(false),
    /** May an organization admin bind this role to their own members? See the
     *  pg/schema.ts twin for the full contract. Defaults to false — the app
     *  plane may only hand out roles whose author marked them org-assignable;
     *  the control plane ignores the flag. */
    orgAssignable: integer("org_assignable", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("roles_tenant_name_idx").on(t.tenantId, t.name),
    index("roles_tenant_idx").on(t.tenantId),
  ],
);

export const userRoles = sqliteTable(
  "user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("user_roles_pk").on(t.userId, t.roleId),
    index("user_roles_role_idx").on(t.roleId),
  ],
);

/** Role assignments for workspace end-users (the `app_users` pool). See the
 *  PG schema for the rationale. */
export const appUserRoles = sqliteTable(
  "app_user_roles",
  {
    appUserId: text("app_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("app_user_roles_pk").on(t.appUserId, t.roleId),
    index("app_user_roles_role_idx").on(t.roleId),
  ],
);

/* ─────────────────────────────────────────────────────────────────────
 * App-plane organizations ("teams"). See the matching block in ../pg/schema.ts
 * for the rationale and the two role layers these tables carry.
 * ───────────────────────────────────────────────────────────────────── */

export const appOrgs = sqliteTable(
  "app_orgs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    image: text("image"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown> | null>(),
    /** `app_users.id` of the creating end-user; null for admin-created orgs. */
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("app_orgs_tenant_slug_idx").on(t.tenantId, t.slug),
    index("app_orgs_tenant_idx").on(t.tenantId),
  ],
);

export const appOrgMembers = sqliteTable(
  "app_org_members",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => appOrgs.id, { onDelete: "cascade" }),
    appUserId: text("app_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    /** owner | admin | member. */
    role: text("role").notNull().default("member"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("app_org_members_pk").on(t.orgId, t.appUserId),
    index("app_org_members_user_idx").on(t.appUserId),
    index("app_org_members_tenant_idx").on(t.tenantId),
  ],
);

/** Workspace roles bound to a member within one org — the org-scoped sibling
 *  of `app_user_roles`. */
export const appOrgMemberRoles = sqliteTable(
  "app_org_member_roles",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => appOrgs.id, { onDelete: "cascade" }),
    appUserId: text("app_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("app_org_member_roles_pk").on(t.orgId, t.appUserId, t.roleId),
    index("app_org_member_roles_role_idx").on(t.roleId),
    index("app_org_member_roles_user_idx").on(t.appUserId),
  ],
);

/** Pending + accepted org invitations. Listable (unlike the workspace-level
 *  end-user invite, which hides its token in `app_verifications`). */
export const appOrgInvites = sqliteTable(
  "app_org_invites",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => appOrgs.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    roleIds: text("role_ids", { mode: "json" }).$type<string[] | null>(),
    token: text("token").notNull(),
    invitedBy: text("invited_by"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("app_org_invites_token_idx").on(t.token),
    index("app_org_invites_org_idx").on(t.orgId),
    index("app_org_invites_email_idx").on(t.email),
    index("app_org_invites_tenant_idx").on(t.tenantId),
  ],
);

export const permissions = sqliteTable(
  "permissions",
  {
    id: text("id").primaryKey(),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    collection: text("collection").notNull(),
    action: text("action").notNull(),
    fields: text("fields", { mode: "json" }).$type<string[] | null>(),
    condition: text("condition", { mode: "json" }).$type<unknown | null>(),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("permissions_role_idx").on(t.roleId),
    index("permissions_lookup_idx").on(t.collection, t.action),
  ],
);

export const functions = sqliteTable(
  "functions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    trigger: text("trigger").notNull(),
    pattern: text("pattern"),
    code: text("code").notNull(),
    timeoutMs: integer("timeout_ms").notNull().default(5000),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("functions_tenant_name_idx").on(t.tenantId, t.name),
    index("functions_trigger_idx").on(t.trigger, t.active),
  ],
);

/**
 * Installed extensions (#13). One row per installed package; the manifest
 * column holds the validated `backlex-extension.json` (panels, fieldEditors,
 * hooks, permissions). UI entry files and server hook code live in
 * `extension_assets`, keyed by their path inside the package.
 */
export const extensions = sqliteTable(
  "extensions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    version: text("version").notNull(),
    source: text("source").notNull(),
    npmPackage: text("npm_package"),
    manifest: text("manifest", { mode: "json" }).$type<unknown>().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("extensions_tenant_name_idx").on(t.tenantId, t.name)],
);

export const extensionAssets = sqliteTable(
  "extension_assets",
  {
    id: text("id").primaryKey(),
    extensionId: text("extension_id").notNull(),
    path: text("path").notNull(),
    content: text("content").notNull(),
    contentType: text("content_type").notNull(),
  },
  (t) => [uniqueIndex("extension_assets_path_idx").on(t.extensionId, t.path)],
);

export const scheduledTasks = sqliteTable(
  "scheduled_tasks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    flowId: text("flow_id"),
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
    runAt: integer("run_at").notNull(),
    claimedAt: integer("claimed_at"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("scheduled_tasks_run_idx").on(t.runAt, t.claimedAt),
    index("scheduled_tasks_flow_idx").on(t.flowId),
  ],
);

export const flows = sqliteTable(
  "flows",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    trigger: text("trigger").notNull(),
    operations: text("operations", { mode: "json" }).$type<unknown[]>().notNull(),
    layout: text("layout", { mode: "json" }).$type<unknown>(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("flows_active_idx").on(t.active),
    index("flows_tenant_idx").on(t.tenantId),
  ],
);

/** AI agents — see the pg schema for full column docs. Dual-dialect: keep both
 *  in lockstep. */
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    /** Stable `@`-mention token, unique per workspace. See the pg schema. */
    handle: text("handle"),
    description: text("description"),
    systemPrompt: text("system_prompt"),
    model: text("model"),
    /** Reasoning effort (`low` | `medium` | `high`); null = provider default.
     *  See the pg schema for the full note. */
    effort: text("effort"),
    tools: text("tools", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** Tool-name globs (same grammar as an MCP allowlist: `collections.delete`,
     *  `collections.*`, `*`) whose calls need a person's yes before the agent may
     *  run them. Empty = no gate, which is the default: an approval flow nobody
     *  configured must not silently start refusing work.
     *
     *  Approval is per (thread, tool, exact arguments) and is spent by being
     *  granted, not consumed — the same call in the same thread with the same
     *  arguments is the same operation, and the request expires on its own. */
    approvalTools: text("approval_tools", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Who is asked. Without at least one there is nobody to say yes, so a gate
     *  configured without approvers refuses the call rather than passing it. */
    approvers: text("approvers", { mode: "json" })
      .$type<Array<{ email: string; name?: string }>>()
      .notNull()
      .default([]),
    /** Names of `agent_skills` rows this agent may consult. Only the name and
     *  description of each reach the prompt; the body is fetched by the model
     *  through a tool when it decides it needs it. */
    skills: text("skills", { mode: "json" }).$type<string[]>().notNull().default([]),
    maxSteps: integer("max_steps").notNull().default(8),
    memory: integer("memory", { mode: "boolean" }).notNull().default(false),
    /** `thread` (default) | `agent` — how far distilled semantic facts reach.
     *  See the pg/schema.ts twin for the full contract and the privacy note. */
    memoryScope: text("memory_scope").notNull().default("thread"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /**
     * Reachable by the workspace's END USERS (app plane), not just operators.
     *
     * Defaults to false, and that is load-bearing: a workspace's agents were
     * built when only operators could reach them, so some carry internal
     * prompts and privileged tools. Shipping an app-plane route must not
     * retroactively hand those to every signed-in end user — exposure is a
     * decision an operator makes per agent.
     */
    appAccess: integer("app_access", { mode: "boolean" }).notNull().default(false),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("agents_tenant_name_idx").on(t.tenantId, t.name),
    uniqueIndex("agents_tenant_handle_idx").on(t.tenantId, t.handle),
    index("agents_tenant_idx").on(t.tenantId),
  ],
);

/** A conversation — a room that may host several agents. See the pg schema for
 *  the `agent_id` / `routing` / `status` semantics. */
export const agentThreads = sqliteTable(
  "agent_threads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    agentId: text("agent_id"),
    title: text("title"),
    status: text("status").notNull().default("idle"),
    routing: text("routing").notNull().default("mention"),
    defaultAgentId: text("default_agent_id"),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("agent_threads_tenant_agent_idx").on(t.tenantId, t.agentId),
    index("agent_threads_agent_idx").on(t.agentId),
    index("agent_threads_tenant_idx").on(t.tenantId),
  ],
);

/** Room membership — which agents can be mentioned in (and answer in) a room. */
export const agentThreadAgents = sqliteTable(
  "agent_thread_agents",
  {
    tenantId: text("tenant_id"),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("agent_thread_agents_pk").on(t.threadId, t.agentId),
    index("agent_thread_agents_agent_idx").on(t.agentId),
  ],
);

/** One agent's turn in a room — and, via the partial unique index, the
 *  per-agent lock that lets two agents answer in parallel while stopping the
 *  same agent from running twice. See the pg schema for the full note. */
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    jobId: text("job_id"),
    status: text("status").notNull().default("queued"),
    startedBy: text("started_by"),
    triggerMessageId: text("trigger_message_id"),
    error: text("error"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("agent_runs_thread_idx").on(t.threadId, t.createdAt),
    uniqueIndex("agent_runs_active_idx")
      .on(t.threadId, t.agentId)
      .where(sql`${t.status} in ('queued','running')`),
  ],
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    threadId: text("thread_id").notNull(),
    role: text("role").notNull(),
    /** Author of a `user` message — threads are team-visible, so a transcript
     *  has to say who asked. Null for assistant/tool rows and for turns run by
     *  an API key rather than a person. */
    userId: text("user_id"),
    /** Which agent wrote an assistant/tool row — see the pg schema. */
    agentId: text("agent_id"),
    content: text("content").notNull().default(""),
    toolName: text("tool_name"),
    toolArgs: text("tool_args", { mode: "json" }).$type<unknown>(),
    toolResult: text("tool_result", { mode: "json" }).$type<unknown>(),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("agent_messages_thread_idx").on(t.threadId, t.createdAt),
  ],
);

/** Distilled semantic memory for an agent — see the pg/schema.ts twin for the
 *  full contract (why facts get rows while episodic memory stays vector-only,
 *  and why retrieval filters on the agent's *current* scope). */
/**
 * A reusable block of procedural knowledge an agent can consult.
 *
 * The distinction from `system_prompt` is reuse and cost. A prompt belongs to
 * one agent and is paid for on every turn; a skill belongs to the workspace,
 * can be attached to several agents, and — because only its `name` and
 * `description` go into the prompt — costs almost nothing until the model
 * decides it needs the body and asks for it.
 *
 * The shape is deliberately the open Agent Skills format (a `SKILL.md`: name +
 * description + markdown body), so a tenant can paste a skill written for any
 * other agent tool and have it work here. That interoperability is the point;
 * inventing our own shape would have thrown it away.
 */
export const agentSkills = sqliteTable(
  "agent_skills",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    /** The handle an agent attaches and the model asks for. Unique per
     *  workspace, because the model addresses a skill by name. */
    name: text("name").notNull(),
    /** What it is and when to use it. This is the ONLY part that goes into the
     *  system prompt, so it is what the model decides on — a vague description
     *  makes a good skill invisible. */
    description: text("description").notNull(),
    /** The markdown the model reads once it asks. Unbounded on purpose: it is
     *  not in the prompt until it is wanted. */
    body: text("body").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("agent_skills_tenant_idx").on(t.tenantId),
    uniqueIndex("agent_skills_tenant_name_idx").on(t.tenantId, t.name),
  ],
);

export const agentMemories = sqliteTable(
  "agent_memories",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    agentId: text("agent_id").notNull(),
    threadId: text("thread_id"),
    scope: text("scope").notNull().default("thread"),
    content: text("content").notNull(),
    embedded: integer("embedded", { mode: "boolean" }).notNull().default(false),
    hits: integer("hits").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("agent_memories_agent_idx").on(t.agentId, t.scope),
    index("agent_memories_thread_idx").on(t.threadId, t.createdAt),
    index("agent_memories_tenant_idx").on(t.tenantId),
  ],
);

export const webhooks = sqliteTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    url: text("url").notNull(),
    events: text("events", { mode: "json" }).$type<string[]>().notNull(),
    headers: text("headers", { mode: "json" }).$type<Record<string, string> | null>(),
    /** Allow-list of top-level `data` keys this hook may carry. NULL/empty =
     *  the whole row (the default). An allow-list rather than a deny-list so a
     *  column added later never starts flowing to an endpoint configured before
     *  it existed. */
    payloadFields: text("payload_fields", { mode: "json" }).$type<string[] | null>(),
    secret: text("secret"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /** Consecutive failed deliveries since the last 2xx — drives the
     *  auto-disable circuit breaker. Reset to 0 on any success. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Timestamp of the most recent failed delivery (null once healthy). */
    lastFailureAt: integer("last_failure_at", { mode: "timestamp_ms" }),
    /** Human-readable reason set when the breaker auto-disables this hook;
     *  null while the hook is healthy or was paused manually. */
    disabledReason: text("disabled_reason"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("webhooks_active_idx").on(t.active),
    index("webhooks_tenant_idx").on(t.tenantId),
  ],
);

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id").notNull(),
    event: text("event").notNull(),
    /** HTTP status (0 when fetch failed before response). */
    status: integer("status").notNull(),
    /** Round-trip duration in milliseconds. */
    ms: integer("ms").notNull(),
    /** Truncated response body (first 1KB) for debugging. */
    responseBody: text("response_body"),
    /** Network error message when status=0. */
    error: text("error"),
    /** Number of delivery attempts so far (1 = first try). */
    attempts: integer("attempts").notNull().default(1),
    deliveredAt: ts("delivered_at"),
  },
  (t) => [
    index("webhook_deliveries_hook_idx").on(t.webhookId),
    index("webhook_deliveries_at_idx").on(t.deliveredAt),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    collection: text("collection").notNull(),
    itemId: text("item_id").notNull(),
    userId: text("user_id"),
    body: text("body").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("comments_item_idx").on(t.collection, t.itemId),
    index("comments_user_idx").on(t.userId),
    index("comments_tenant_idx").on(t.tenantId),
  ],
);

/**
 * Public, unauthenticated, read-only share links to a single record. The
 * plaintext token is shown once on creation; only its SHA-256 hash is stored.
 * Links never expire but are revocable (`revoked_at`).
 */
export const sharedLinks = sqliteTable(
  "shared_links",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    collection: text("collection").notNull(),
    itemId: text("item_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: text("created_by"),
    /** Nullable — set when the link is revoked. Null = active. */
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("shared_links_token_idx").on(t.tokenHash),
    index("shared_links_item_idx").on(t.collection, t.itemId),
  ],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    userId: text("user_id"),
    title: text("title").notNull(),
    body: text("body"),
    url: text("url"),
    flowId: text("flow_id"),
    readAt: integer("read_at"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId),
    index("notifications_unread_idx").on(t.userId, t.readAt),
    index("notifications_tenant_idx").on(t.tenantId),
  ],
);

/* Push messaging tables (mirrors of pg schema). */

export const deviceTokens = sqliteTable(
  "device_tokens",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    userId: text("user_id").notNull(),
    /** fcm | apns | web-push */
    platform: text("platform").notNull(),
    token: text("token").notNull(),
    keys: text("keys", { mode: "json" }).$type<{ p256dh: string; auth: string }>(),
    deviceName: text("device_name"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    lastSeenAt: integer("last_seen_at"),
  },
  (t) => [
    uniqueIndex("device_tokens_unique_idx").on(t.userId, t.platform, t.token),
    index("device_tokens_user_idx").on(t.userId),
    index("device_tokens_tenant_idx").on(t.tenantId),
  ],
);

export const pushConfig = sqliteTable(
  "push_config",
  {
    tenantId: text("tenant_id").primaryKey(),
    /** inherit | console | fcm | apns | web-push | cloud */
    provider: text("provider").notNull().default("inherit"),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    secrets: text("secrets", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    updatedAt: ts("updated_at"),
  },
);

export const pushTemplates = sqliteTable(
  "push_templates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    key: text("key").notNull(),
    name: text("name").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    url: text("url"),
    variables: text("variables", { mode: "json" }).$type<string[]>(),
    updatedBy: text("updated_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("push_templates_tenant_key_idx").on(t.tenantId, t.key)],
);

/* SMS messaging tables (mirrors of pg schema). */

export const phoneNumbers = sqliteTable(
  "phone_numbers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    userId: text("user_id").notNull(),
    /** E.164, e.g. +14155552671. */
    phoneNumber: text("phone_number").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    lastSeenAt: integer("last_seen_at"),
  },
  (t) => [
    uniqueIndex("phone_numbers_unique_idx").on(t.userId, t.phoneNumber),
    index("phone_numbers_user_idx").on(t.userId),
    index("phone_numbers_tenant_idx").on(t.tenantId),
  ],
);

export const smsConfig = sqliteTable(
  "sms_config",
  {
    tenantId: text("tenant_id").primaryKey(),
    /** inherit | console | twilio | sns | netgsm | iletimerkezi */
    provider: text("provider").notNull().default("inherit"),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    secrets: text("secrets", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    updatedAt: ts("updated_at"),
  },
);

/**
 * Durable job queue. Rows are drained by the cross-runtime cron tick
 * (`processJobs` inside `cronTick`), claimed with a `status='active' + claimedAt`
 * lease, retried with exponential backoff, and promoted to `dead_letter` once
 * `attempts >= maxAttempts`. `runAt` supports delayed/scheduled execution.
 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    queue: text("queue").notNull().default("default"),
    /** Handler discriminator: function | webhook.deliver */
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    /** pending | active | succeeded | failed | dead_letter | cancelled */
    status: text("status").notNull().default("pending"),
    /** Lower runs sooner within a due batch. */
    priority: integer("priority").notNull().default(0),
    runAt: integer("run_at", { mode: "timestamp_ms" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    /** Lease marker — set when a tick claims the row; cleared on requeue. */
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    result: text("result", { mode: "json" }).$type<unknown>(),
    /** How far a long-running job has got: `{done, total, phase, note}`. NULL
     *  until the handler reports once — a job that never reports is not
     *  "0% done", it simply does not answer the question. Written once per
     *  BATCH, never per row: a per-row write would cost more than the work. */
    progress: text("progress", { mode: "json" }).$type<unknown>(),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("jobs_status_run_idx").on(t.status, t.runAt),
    index("jobs_tenant_idx").on(t.tenantId),
    index("jobs_queue_status_idx").on(t.queue, t.status),
  ],
);

/**
 * Resumable upload sessions (TUS 1.0.0). One row per in-flight upload, backed
 * by a native object-store multipart upload (`storage_upload_id`) — or an
 * offset-append temp file on the fs backend. `offset` tracks committed bytes
 * for resume; `parts` records the multipart part list. Finalized rows flip to
 * `completed` and a `files` row is written; abandoned `pending` rows past
 * `expires_at` are swept inside `cronTick`.
 */
export const uploads = sqliteTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    /** Logical key (tenant-relative); the final `files.key` is the physical one. */
    key: text("key").notNull(),
    physicalKey: text("physical_key").notNull(),
    /** Native multipart upload id (null for the fs offset-append backend). */
    storageUploadId: text("storage_upload_id"),
    /** Total expected bytes (TUS `Upload-Length`). */
    size: integer("size").notNull(),
    /** Committed bytes so far (TUS `Upload-Offset`). */
    offset: integer("offset").notNull().default(0),
    parts: text("parts", { mode: "json" }).$type<{ partNumber: number; etag: string; size: number }[]>().notNull().default([]),
    contentType: text("content_type"),
    folderId: text("folder_id"),
    ownerId: text("owner_id"),
    /** Decoded TUS `Upload-Metadata` bag. */
    metadata: text("metadata", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    /** pending | completed | aborted */
    status: text("status").notNull().default("pending"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("uploads_tenant_idx").on(t.tenantId),
    index("uploads_expires_idx").on(t.expiresAt),
    index("uploads_status_idx").on(t.status),
  ],
);

export const revisions = sqliteTable(
  "revisions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    collection: text("collection").notNull(),
    itemId: text("item_id").notNull(),
    parentRevisionId: text("parent_revision_id"),
    snapshot: text("snapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("revisions_item_idx").on(t.collection, t.itemId),
    index("revisions_tenant_idx").on(t.tenantId),
    /** The retention sweep's cutoff column. See the pg twin. */
    index("revisions_created_idx").on(t.createdAt),
    /** `recordRevision` reads the newest revision for one item on EVERY write;
     *  without `created_at` on the key that is an unindexed sort over a set that
     *  only grows. See the pg twin. */
    index("revisions_item_created_idx").on(
      t.tenantId,
      t.collection,
      t.itemId,
      t.createdAt,
    ),
  ],
);

/** Immutable schema snapshot — the full schema-relevant subset of a workspace's
 *  `collections` rows (`SchemaCollection[]`), captured for migration diffing /
 *  branching (#9). `hash` is the sha256 of the canonical snapshot for identity;
 *  `parent_snapshot_id` links lineage; `branch_id` ties a snapshot to the branch
 *  it was taken on (null = taken off the live schema). See the pg/schema.ts twin. */
export const schemaSnapshots = sqliteTable(
  "schema_snapshots",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    note: text("note"),
    snapshot: text("snapshot", { mode: "json" }).$type<unknown[]>().notNull(),
    hash: text("hash").notNull(),
    /** `manual` (admin-captured) | `branch` (a branch head) | `auto` (pre-apply
     *  safety capture taken automatically before a destructive apply). */
    kind: text("kind").notNull().default("manual"),
    branchId: text("branch_id"),
    parentSnapshotId: text("parent_snapshot_id"),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("schema_snapshots_tenant_idx").on(t.tenantId, t.createdAt),
    index("schema_snapshots_branch_idx").on(t.branchId),
  ],
);

/** Named, mutable pointer into the snapshot history — a "schema branch". `head_
 *  snapshot_id` is the working schema; `base_snapshot_id` is the fork point
 *  (the merge base used when diffing the branch against live). See the twin. */
export const schemaBranches = sqliteTable(
  "schema_branches",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    note: text("note"),
    headSnapshotId: text("head_snapshot_id"),
    baseSnapshotId: text("base_snapshot_id"),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("schema_branches_tenant_name_idx").on(t.tenantId, t.name)],
);

/** Saved external-database connections for server-side migration (the admin
 *  "Database import" wizard). `url` is encrypted at rest with AUTH_SECRET
 *  (same envelope as integration configs) and always masked on the API.
 *  See the pg/schema.ts twin + docs/migrating-in.md. */
export const externalSources = sqliteTable(
  "external_sources",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("postgres"),
    /** Encrypted connection string (lib/crypto envelope). */
    url: text("url").notNull(),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("external_sources_tenant_name_idx").on(t.tenantId, t.name)],
);

/** One server-side migration execution. The scheduler tick claims runs and
 *  copies in bounded slices; `state` carries per-table keyset cursors +
 *  counters so a run survives isolate death and resumes where it left off
 *  (the ingest path is idempotent). See the pg/schema.ts twin. */
export const migrationRuns = sqliteTable(
  "migration_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => externalSources.id, { onDelete: "cascade" }),
    /** The validated MigrationPlan document (packages/migrate parsePlan). */
    plan: text("plan", { mode: "json" }).$type<unknown>().notNull(),
    /** Per-table progress: `{ [slug]: { cursor, copied, failed, done, … } }`. */
    state: text("state", { mode: "json" }).$type<unknown>().notNull(),
    /** pending | running | done | failed | cancelled */
    status: text("status").notNull().default("pending"),
    error: text("error"),
    /** Lease heartbeat — a `running` run whose lease expired is reclaimable
     *  by any isolate's tick (same stale-lease model as the job queue). */
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("migration_runs_tenant_idx").on(t.tenantId, t.createdAt)],
);

export const activity = sqliteTable(
  "activity",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    userId: text("user_id"),
    action: text("action").notNull(),
    collection: text("collection").notNull(),
    itemId: text("item_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    payload: text("payload", { mode: "json" }).$type<unknown | null>(),
    response: text("response", { mode: "json" }).$type<unknown | null>(),
    durationMs: integer("duration_ms"),
    /** The operator behind an impersonated request — see the pg twin for why
     *  this is a column and not a payload key. */
    impersonatedBy: text("impersonated_by"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("activity_impersonated_idx").on(t.impersonatedBy),
    index("activity_collection_item_idx").on(t.collection, t.itemId),
    index("activity_user_idx").on(t.userId),
    index("activity_created_idx").on(t.createdAt),
    // Tenant filtering + time-range listings both ride this composite; a
    // single-column (tenant_id) index would be a redundant leftmost prefix.
    index("activity_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

/** Distributed-tracing span rows — one per sampled HTTP request, written
 *  fire-and-forget by the access-log middleware. Rows that share a `trace_id`
 *  form one logical operation (SDK call → API → function callback). Pruned by
 *  retention; safe to truncate. Powers the admin Traces panel. */
export const spans = sqliteTable(
  "spans",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("server"),
    method: text("method"),
    path: text("path"),
    status: integer("status"),
    userId: text("user_id"),
    durationMs: integer("duration_ms"),
    attributes: text("attributes", { mode: "json" }).$type<Record<
      string,
      unknown
    > | null>(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("spans_trace_idx").on(t.traceId),
    index("spans_tenant_idx").on(t.tenantId),
    index("spans_created_idx").on(t.createdAt),
  ],
);

/**
 * Per-day usage ledger — one row per (workspace, API key, UTC day). Request
 * counts are incremented by the usage middleware via buffered upserts
 * (`services/usage.ts`); `api_key_id = ''` is the bucket for session /
 * unauthenticated traffic so the composite key never needs a nullable column.
 * `storage_bytes` / `db_rows` are point-in-time gauges refreshed by the cron
 * sweep and only ever written on the `''` row of the current day. No FKs on
 * purpose: usage history must survive key revocation and stay cheap to write.
 */
export const usageCounters = sqliteTable(
  "usage_counters",
  {
    tenantId: text("tenant_id").notNull(),
    /** `''` = traffic not attributed to an API key (admin sessions, app users). */
    apiKeyId: text("api_key_id").notNull().default(""),
    /** UTC calendar day, `YYYY-MM-DD`. */
    day: text("day").notNull(),
    requests: integer("requests").notNull().default(0),
    /** 5xx responses — a server-fault subset of `requests`, not additional. */
    errors: integer("errors").notNull().default(0),
    /**
     * Model generations — a subset of `requests` only when the generation was
     * itself the request; a flow step or an agent turn bumps this without a
     * request of its own, which is exactly why AI cannot be inferred from the
     * request count.
     */
    aiCalls: integer("ai_calls").notNull().default(0),
    /**
     * Tokens, on the DIRECT-provider path. Zero on managed cloud, which meters
     * in neurons and does not return token counts — the two paths measure
     * genuinely different things, so they get different columns rather than one
     * column whose meaning depends on the deployment.
     */
    aiTokensIn: integer("ai_tokens_in").notNull().default(0),
    aiTokensOut: integer("ai_tokens_out").notNull().default(0),
    /** Workers AI neurons, on the managed-cloud path. Zero elsewhere. */
    aiNeurons: integer("ai_neurons").notNull().default(0),
    /** Gauge: total stored file bytes for the workspace at last sweep. */
    storageBytes: integer("storage_bytes"),
    /** Gauge: total rows across the workspace's collections at last sweep. */
    dbRows: integer("db_rows"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("usage_counters_pk").on(t.tenantId, t.apiKeyId, t.day)],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    prefix: text("prefix").notNull(),
    hashedKey: text("hashed_key").notNull(),
    name: text("name").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Optional role this key is scoped to. When set, requests made with the
     *  key resolve permissions against *only* this role (no implicit
     *  `authenticated`) — and only while the owner still holds it. Null = the
     *  key inherits the owner's full role set (legacy behaviour). */
    roleId: text("role_id").references(() => roles.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    /** MCP per-key tool allowlist. `NULL` = every tool the MCP server exposes
     *  is available to this key (default for keys created before MCP existed
     *  and for any key that omits the field on create). When set to an array
     *  of tool names (e.g. `["collections.list","collections.read"]`), the
     *  dispatcher filters `tools/list` to the intersection and 403s any
     *  `tools/call` outside it. Defense-in-depth on top of the permissions
     *  DSL: a key that has `delete` on a collection can still be denied the
     *  `collections.delete` MCP tool. */
    mcpTools: text("mcp_tools", { mode: "json" }).$type<string[] | null>(),
    /** When true, MCP refuses every write tool — insert/update/delete/grant/
     *  revoke/invoke/assign — for this key, regardless of the permissions
     *  DSL or the allowlist. Designed for read-only AI agents pointed at a
     *  production workspace. The underlying REST endpoints stay open to the
     *  same identity; the lock is enforced only on the MCP surface. */
    mcpReadOnly: integer("mcp_read_only", { mode: "boolean" })
      .notNull()
      .default(false),
    /** Per-key requests-per-minute cap. NULL = the shared global budget
     *  (`lib/api-rate-limit.ts`). A set value is enforced even on deploys
     *  where the global limiter is disabled — explicit config always wins. */
    rateLimitPerMinute: integer("rate_limit_per_minute"),
    /** Per-key requests-per-UTC-month quota, checked against the usage
     *  ledger (`usage_counters`). NULL = unmetered. Over-quota requests get
     *  429 QUOTA_EXCEEDED until the month rolls over. */
    monthlyQuota: integer("monthly_quota"),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("api_keys_hashed_idx").on(t.hashedKey),
    index("api_keys_prefix_idx").on(t.prefix),
    index("api_keys_user_idx").on(t.userId),
    index("api_keys_role_idx").on(t.roleId),
    index("api_keys_tenant_idx").on(t.tenantId),
  ],
);

export const collections = sqliteTable(
  "collections",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    physicalTable: text("physical_table").notNull(),
    singular: text("singular"),
    plural: text("plural"),
    note: text("note"),
    displayTemplate: text("display_template"),
    /** Admin icon key. See the pg/schema.ts twin. */
    icon: text("icon"),
    /** Admin accent color (preset token or `#rrggbb`). See the pg/schema.ts twin. */
    color: text("color"),
    /** Hidden from the admin sidebar/index (presentational only). See the
     *  pg/schema.ts twin. */
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    /** Preview-URL template with `{{field}}` placeholders. See the
     *  pg/schema.ts twin. */
    previewUrl: text("preview_url"),
    fields: text("fields", { mode: "json" }).$type<unknown[]>().notNull(),
    ownerScoped: integer("owner_scoped", { mode: "boolean" }).notNull().default(false),
    tenantScoped: integer("tenant_scoped", { mode: "boolean" }).notNull().default(true),
    /** When true, the physical table gains a `_status` ('draft'|'published')
     *  + `_published_at` column. PATCH writes update the draft; explicit
     *  `POST /:id/publish` flips status. */
    versioned: integer("versioned", { mode: "boolean" }).notNull().default(false),
    /** Staged edits for published rows. See the pg/schema.ts twin. */
    stagedEdits: integer("staged_edits", { mode: "boolean" }).notNull().default(false),
    /** When true, the physical table gains a nullable `deleted_at` column and
     *  DELETE soft-deletes instead of removing the row; reads filter
     *  `deleted_at IS NULL`. Forced false for adopted collections. See the
     *  pg/schema.ts twin. */
    softDelete: integer("soft_delete", { mode: "boolean" }).notNull().default(false),
    /** When true, the collection is locked to a single live row. */
    singleton: integer("singleton", { mode: "boolean" }).notNull().default(false),
    /** Opt-in sensitive-read auditing. When true, REST read operations on this
     *  collection (list + by-id) record an `access.read` activity row so admins
     *  get a "who viewed this" trail for regulated data. Off by default — reads
     *  are otherwise never logged. See the pg/schema.ts twin. */
    auditReads: integer("audit_reads", { mode: "boolean" }).notNull().default(false),
    /** When true, item writes auto-generate embeddings from fields flagged
     *  `vectorize: true` on the field definition. */
    vectorize: integer("vectorize", { mode: "boolean" }).notNull().default(false),
    /** Embedding model key (e.g. `bge-m3`). Null → env default → skip. */
    vectorizeModel: text("vectorize_model"),
    /** When true, item writes maintain a keyword full-text-search index
     *  (SQLite FTS5 shadow table) built from the fields flagged
     *  `searchable: true`. See the pg/schema.ts twin for the full contract. */
    fts: integer("fts", { mode: "boolean" }).notNull().default(false),
    /** Default sort applied by `parseQuery` when the request omits `?sort=`.
     *  Comma-separated field list, `-` prefix = DESC (`-` prefix = DESC).
     *  e.g. `"-published_at,name"`. */
    defaultSort: text("default_sort"),
    /** Field name the admin Kanban view groups cards by. Stores a user
     *  field's name (a `dropdown`/`select` field) or the special `_status`
     *  lifecycle column on versioned collections. Null = auto-detect (a field
     *  literally named `status`, else the first dropdown). See the
     *  pg/schema.ts twin. */
    kanbanGroupBy: text("kanban_group_by"),
    /** Maps a Kanban group-by dropdown *value* to a draft/publish lifecycle
     *  action (`publish` | `unpublish` | `archive`) — e.g. a `done` column that
     *  also publishes. Only meaningful on a `versioned` collection whose
     *  `kanbanGroupBy` is a user dropdown. Null/empty = no triggers. See the
     *  pg/schema.ts twin. */
    kanbanActionMap: text("kanban_action_map", { mode: "json" }).$type<Record<string, string>>(),
    /** Admin grouping section header. Column is `group_name` (`GROUP` is
     *  reserved); JSON key stays `group`. See the pg/schema.ts twin. */
    group: text("group_name"),
    /** Manual position within its group. See the pg/schema.ts twin. */
    sortOrder: integer("sort_order"),
    /** Adopted (existing table) vs managed (we created the table). See the
     *  pg/schema.ts twin for the full contract. */
    adopted: integer("adopted", { mode: "boolean" }).notNull().default(false),
    pkColumn: text("pk_column").notNull().default("id"),
    /** Storage type of the PK column (`uuid` | `text` | `integer`). See the
     *  pg/schema.ts twin for the full contract. */
    pkType: text("pk_type").notNull().default("uuid"),
    hasCreatedAt: integer("has_created_at", { mode: "boolean" }).notNull().default(true),
    hasUpdatedAt: integer("has_updated_at", { mode: "boolean" }).notNull().default(true),
    /** Source-table column names backing the system fields. Null = use the
     *  conventional names. See pg/schema.ts twin for the full rationale. */
    createdAtColumn: text("created_at_column"),
    updatedAtColumn: text("updated_at_column"),
    ownerIdColumn: text("owner_id_column"),
    /** Lifecycle status (`active` | `archived`). See pg/schema.ts twin
     *  for the full rationale. Adopted collections only use `archived`;
     *  managed are hard-deleted instead. */
    status: text("status").notNull().default("active"),
    /** When `status` flipped to `'archived'`. Null while active. */
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("collections_tenant_slug_idx").on(t.tenantId, t.slug),
    uniqueIndex("collections_physical_table_idx").on(t.physicalTable),
  ],
);

/** Side-table for row ownership. See the pg/schema.ts twin for the
 *  rationale (adopt-friendly + toggle-friendly ownership). */
export const itemOwnership = sqliteTable(
  "item_ownership",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    ownerId: text("owner_id").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("item_ownership_pk_idx").on(t.collectionId, t.itemId),
    index("item_ownership_owner_idx").on(t.ownerId, t.collectionId),
  ],
);

/** Staged (unpublished) edits for published rows. See the pg/schema.ts twin
 *  for the full contract. */
export const itemStaged = sqliteTable(
  "item_staged",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    tenantId: text("tenant_id"),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    updatedAt: ts("updated_at"),
    updatedBy: text("updated_by"),
  },
  (t) => [uniqueIndex("item_staged_pk_idx").on(t.collectionId, t.itemId)],
);

/**
 * SQLite (D1) has no native vector indexes — on the edge the actual vectors
 * live in Cloudflare Vectorize (bound separately, one binding per model).
 * These tables mirror only the metadata so we can list/delete transactionally
 * alongside the rest of the workspace state.
 *
 * One table per embedding model — see the PG schema for rationale.
 */

export const embeddingsOpenai1536 = sqliteTable(
  "embeddings_openai_1536",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull().default("default"),
    refId: text("ref_id"),
    content: text("content"),
    embedding: f32blob(1536),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("embeddings_openai_1536_namespace_idx").on(t.namespace),
    index("embeddings_openai_1536_ref_idx").on(t.refId),
  ],
);

export const embeddingsOpenai3072 = sqliteTable(
  "embeddings_openai_3072",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull().default("default"),
    refId: text("ref_id"),
    content: text("content"),
    embedding: f32blob(3072),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("embeddings_openai_3072_namespace_idx").on(t.namespace),
    index("embeddings_openai_3072_ref_idx").on(t.refId),
  ],
);

export const embeddingsSelfHostBgeM3 = sqliteTable(
  "embeddings_self_host_bge_m3",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull().default("default"),
    refId: text("ref_id"),
    content: text("content"),
    embedding: f32blob(1024),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("embeddings_self_host_bge_m3_namespace_idx").on(t.namespace),
    index("embeddings_self_host_bge_m3_ref_idx").on(t.refId),
  ],
);

export const embeddingsBgeM3 = sqliteTable(
  "embeddings_bge_m3",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull().default("default"),
    refId: text("ref_id"),
    content: text("content"),
    embedding: f32blob(1024),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("embeddings_bge_m3_namespace_idx").on(t.namespace),
    index("embeddings_bge_m3_ref_idx").on(t.refId),
  ],
);

export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    parentId: text("parent_id"),
    ownerId: text("owner_id"),
    tenantId: text("tenant_id"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("folders_parent_idx").on(t.parentId),
    index("folders_tenant_idx").on(t.tenantId),
  ],
);

export const files = sqliteTable(
  "files",
  {
    key: text("key").primaryKey(),
    folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
    ownerId: text("owner_id"),
    tenantId: text("tenant_id"),
    size: integer("size").notNull(),
    contentType: text("content_type"),
    acl: text("acl").notNull().default("private"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, string>>(),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("files_folder_idx").on(t.folderId),
    index("files_tenant_idx").on(t.tenantId),
  ],
);

/* Admin-page backing tables (mirrors of pg schema). */

export const emailTemplates = sqliteTable(
  "email_templates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    key: text("key").notNull(),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    fromAddress: text("from_address"),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text"),
    variables: text("variables", { mode: "json" }).$type<string[]>(),
    updatedBy: text("updated_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("email_templates_tenant_key_idx").on(t.tenantId, t.key)],
);

export const documentTemplates = sqliteTable(
  "document_templates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** A COMPLETE html document, not a fragment — a contract sets its own
     *  fonts, page size and print styles, and wrapping it would fight that. */
    bodyHtml: text("body_html").notNull(),
    /** Running header / footer, rendered by the browser on every page. */
    headerHtml: text("header_html"),
    footerHtml: text("footer_html"),
    /** {@link PdfPageOptions} minus the two html fields above. */
    pageOptions: text("page_options", { mode: "json" }).$type<Record<string, unknown>>(),
    /** Suggested output name; templated like the body (`invoice-{{ data.no }}.pdf`). */
    filename: text("filename"),
    variables: text("variables", { mode: "json" }).$type<string[]>(),
    updatedBy: text("updated_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("document_templates_tenant_key_idx").on(t.tenantId, t.key)],
);

export const signatureRequests = sqliteTable(
  "signature_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    /** What the signer is told they are signing. */
    title: text("title").notNull(),
    /** Optional note carried into the invitation email. */
    message: text("message"),
    /** Which document template it came from — provenance only. The bytes are
     *  never re-derived from it, because the template may have changed. */
    templateKey: text("template_key"),
    /** THE SNAPSHOT: the interpolated HTML, frozen at send time. This is what
     *  was signed, so it — not the row it came from — is what renders later. */
    bodyHtml: text("body_html").notNull(),
    pageOptions: text("page_options", { mode: "json" }).$type<Record<string, unknown>>(),
    filename: text("filename"),
    /** SHA-256 of `body_html`. Hashing the SOURCE rather than the PDF: two
     *  renders of one document are not byte-identical across renderer
     *  versions, so a PDF hash would fail a re-verification that is fine. */
    documentHash: text("document_hash").notNull(),
    /** Stored unsigned PDF — what the signer downloads before signing. */
    documentKey: text("document_key"),
    signedDocumentKey: text("signed_document_key"),
    /** SHA-256 of the signed PDF bytes, so a downloaded copy can be checked. */
    signedDocumentHash: text("signed_document_hash"),
    /** pending | completed | declined | voided. Expiry is DERIVED from
     *  `expires_at` rather than stored, so nothing has to run to make a
     *  request stop being signable. */
    status: text("status").notNull().default("pending"),
    /** Sequential signing — each signer's link only works once the one before
     *  has signed. Off means everyone may sign at any time. */
    ordered: integer("ordered", { mode: "boolean" }).notNull().default(false),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    voidedAt: integer("voided_at", { mode: "timestamp_ms" }),
    voidReason: text("void_reason"),
    /** `{ collection, id, field }` — where the signed document's key lands. */
    writeBack: text("write_back", { mode: "json" }).$type<Record<string, unknown> | null>(),
    /** Extra addresses that receive the completed copy. */
    notifyEmails: text("notify_emails", { mode: "json" }).$type<string[]>(),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("signature_requests_tenant_idx").on(t.tenantId),
    index("signature_requests_status_idx").on(t.tenantId, t.status),
  ],
);

export const signatureSigners = sqliteTable(
  "signature_signers",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    /** "Tenant", "Landlord" — shown on the certificate beside the signature. */
    role: text("role"),
    /** Position in the signing order. Meaningless unless the request is
     *  `ordered`, but always written so the certificate lists people in the
     *  order the operator entered them. */
    orderIndex: integer("order_index").notNull().default(0),
    /** SHA-256 of the plaintext link token — the token itself is shown once,
     *  in the email. A readable token in this table would let anyone with
     *  database access sign as the customer. */
    tokenHash: text("token_hash").notNull(),
    /** pending | viewed | signed | declined */
    status: text("status").notNull().default("pending"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    viewedAt: integer("viewed_at", { mode: "timestamp_ms" }),
    signedAt: integer("signed_at", { mode: "timestamp_ms" }),
    declinedAt: integer("declined_at", { mode: "timestamp_ms" }),
    declineReason: text("decline_reason"),
    /** drawn | typed */
    signatureKind: text("signature_kind"),
    /** A `data:image/png;base64,…` of the drawn signature. Validated and
     *  re-encoded on the way in — it is interpolated into the HTML the
     *  renderer is handed. */
    signatureImage: text("signature_image"),
    /** The typed name, for the keyboard path. */
    signatureText: text("signature_text"),
    /** The exact consent wording that was on screen, kept verbatim: a
     *  certificate that cites today's wording for a signature given last year
     *  is evidence of nothing. */
    consentText: text("consent_text"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("signature_signers_token_idx").on(t.tokenHash),
    index("signature_signers_request_idx").on(t.requestId, t.orderIndex),
  ],
);

/**
 * A record waiting on a human decision.
 *
 * Fourteen of the twenty-six schema templates carry a collection whose status
 * goes `pending → approved | rejected` — leave requests, expense claims, offer
 * approvals, vendor applications, engineering change orders. Every one of them
 * was hand-rolled the same way: a status column, a notification, an admin who
 * edits the row, and no record of who decided or why.
 */
export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    /** What the approver is told they are deciding. */
    title: text("title").notNull(),
    /** Optional note carried into the invitation email. */
    message: text("message"),
    /** The row the decision is ABOUT. Nullable: an approval can gate a flow
     *  that has no single subject row (a nightly payout batch, say). */
    subjectCollection: text("subject_collection"),
    subjectId: text("subject_id"),
    /** A frozen, display-only rendering of the subject at request time —
     *  `[{ label, value }]`. Same reason the signature snapshot exists: an
     *  approver who is later asked "what did you see?" must be answerable
     *  without re-deriving it from a row that has since moved on. */
    summary: text("summary", { mode: "json" }).$type<unknown[]>(),
    /** all | any | quorum — how many approvals settle it. */
    policy: text("policy").notNull().default("all"),
    /** Only read when `policy = 'quorum'`. */
    quorum: integer("quorum").notNull().default(1),
    /** Sequential approval — each approver's link only works once the one
     *  before has approved. Off means anyone may decide at any time. */
    ordered: integer("ordered", { mode: "boolean" }).notNull().default(false),
    /** pending | approved | rejected | expired | cancelled. Unlike a signature
     *  request, expiry IS written here, because expiring has a CONSEQUENCE —
     *  the waiting flow has to be resumed down its rejected branch. A derived
     *  status would leave that continuation parked forever. */
    status: text("status").notNull().default("pending"),
    /** The checkpointed flow continuation, when an `approval.request` op is
     *  waiting on this. Shape matches `ResumePayload`. */
    continuation: text("continuation", { mode: "json" }).$type<unknown>(),
    /** The `scheduled_tasks` row that will expire this request. Kept so
     *  settling early can delete it instead of leaving a tick that wakes to
     *  find nothing to do. */
    timeoutTaskId: text("timeout_task_id"),
    /** `{ collection, id, field, approvedValue, rejectedValue }` — what is
     *  patched onto the subject row once the outcome is known. */
    writeBack: text("write_back", { mode: "json" }).$type<Record<string, unknown> | null>(),
    /** Extra addresses that receive the outcome. */
    notifyEmails: text("notify_emails", { mode: "json" }).$type<string[]>(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }),
    /** Why it ended the way it did — the deciding approver's reason, or the
     *  operator's note on a cancellation. */
    outcomeReason: text("outcome_reason"),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("approval_requests_tenant_idx").on(t.tenantId),
    index("approval_requests_status_idx").on(t.tenantId, t.status),
    index("approval_requests_subject_idx").on(t.subjectCollection, t.subjectId),
  ],
);

export const approvalApprovers = sqliteTable(
  "approval_approvers",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    /** "Line manager", "Finance" — shown beside the decision in the audit
     *  trail, so a reader knows in what capacity someone approved. */
    role: text("role"),
    orderIndex: integer("order_index").notNull().default(0),
    /** SHA-256 of the plaintext link token — the token itself is shown once,
     *  in the email, exactly like a signature link. */
    tokenHash: text("token_hash").notNull(),
    /** pending | viewed | approved | rejected */
    status: text("status").notNull().default("pending"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    viewedAt: integer("viewed_at", { mode: "timestamp_ms" }),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    /** Free text the approver typed. Required on a rejection by default —
     *  a refusal with no reason is the thing operators complain about. */
    reason: text("reason"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("approval_approvers_token_idx").on(t.tokenHash),
    index("approval_approvers_request_idx").on(t.requestId, t.orderIndex),
  ],
);

/**
 * A bookable thing — a dentist, a court, a viewing agent, a table by the window.
 *
 * Ten of the schema templates carry a slot-shaped collection and none of them
 * could express when the thing behind it is free, so this is the piece that was
 * missing rather than the booking itself. Everything on the row is POLICY:
 * how long a booking lasts, how many fit at once, how much notice is required,
 * how far ahead the calendar is open. The opening pattern lives next door in
 * `booking_rules`, and the slots are computed from both — never stored, because
 * a stored slot table has to be regenerated every time a rule moves and is
 * wrong in the meantime.
 */
export const bookingResources = sqliteTable(
  "booking_resources",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    /** Stable handle used by the API and the CLI. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** IANA zone the RULES are written in. Load-bearing: "Mondays 09:00" does
     *  not move when the clocks do, but the instant it names does, and the
     *  operator's zone is the only one that can settle which. */
    timeZone: text("time_zone").notNull().default("UTC"),
    slotMinutes: integer("slot_minutes").notNull().default(30),
    /** Distance between consecutive slot STARTS. Null = back-to-back. */
    stepMinutes: integer("step_minutes"),
    /** How many bookings one instant holds — 1 for a dentist, 12 for a class. */
    capacity: integer("capacity").notNull().default(1),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    /** Minimum notice, in minutes. */
    leadMinutes: integer("lead_minutes").notNull().default(0),
    horizonDays: integer("horizon_days").notNull().default(60),
    /** How long an unconfirmed hold survives. A hold that never lapsed would
     *  let one abandoned checkout close a slot forever. */
    holdMinutes: integer("hold_minutes").notNull().default(10),
    /** `[{ name, label, type, required, options }]` — what the booker is asked
     *  beyond name and address. Same shape as `forms.fields`. */
    questions: text("questions", { mode: "json" }).$type<Array<Record<string, unknown>>>(),
    /** Public page appearance: `{ theme, accent, font }`. Same vocabulary as
     *  `forms.settings`, and read through the same client module, so the two
     *  public pages cannot drift into different ideas of what a theme is. */
    settings: text("settings", { mode: "json" }).$type<Record<string, unknown> | null>(),
    /** Whether bookings are recorded in a collection at all. On by default:
     *  every resource records, and the workspace-wide `booking_records`
     *  collection is provisioned for it. Off is an escape hatch, not a
     *  starting point — a resource that records nowhere leaves the ledger as
     *  the only place its customers exist. */
    mirrorEnabled: integer("mirror_enabled", { mode: "boolean" }).notNull().default(true),
    /** Which collection to record into. NULL means the provisioned default
     *  (`booking_records`), whose field map is DERIVED rather than stored so it
     *  cannot drift from the shape we create. A value here points at a
     *  collection the workspace owns instead, and only then does
     *  `mirrorFieldMap` mean anything. The ledger stays the source of truth for
     *  the slot either way — see the migration for why. */
    mirrorCollection: text("mirror_collection"),
    /** `{ start, end, name, email, phone, status, resource }` — booking field →
     *  collection column. Absent keys are simply not written. Only read for a
     *  CUSTOM `mirrorCollection`; the default target derives its own. */
    mirrorFieldMap: text("mirror_field_map", { mode: "json" }).$type<Record<string, string> | null>(),
    /** SHA-256 of the public page token (`bkg_<hex>`), which is shown once.
     *  Mirrors `forms` / `dashboards` embed / `shared_links`. */
    tokenHash: text("token_hash").notNull(),
    /** Paused resources answer 410 on the public endpoints without losing their
     *  bookings or their rules. */
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /** Shown after a successful booking. */
    confirmationMessage: text("confirmation_message"),
    /** Addresses copied on every booking and cancellation. */
    notifyEmails: text("notify_emails", { mode: "json" }).$type<string[]>(),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("booking_resources_tenant_key_idx").on(t.tenantId, t.key),
    uniqueIndex("booking_resources_token_idx").on(t.tokenHash),
    index("booking_resources_tenant_idx").on(t.tenantId),
  ],
);

/**
 * One line of an opening pattern, or one exception to it.
 *
 * `open` adds bookable time and `block` takes it away; blocks are applied after
 * every open rule has been merged, so a holiday declared once does not have to
 * be subtracted from each pattern separately. A rule with no `weekday` applies
 * to every day inside its date range, which is how a one-off closure is said:
 * a block covering 0–1440 for the dates concerned.
 *
 * Times are minutes from LOCAL midnight, never instants. A shift that crosses
 * midnight is two rules, so that no interval anywhere has to be read as
 * "wraps around".
 */
export const bookingRules = sqliteTable(
  "booking_rules",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id").notNull(),
    /** open | block */
    kind: text("kind").notNull().default("open"),
    /** 0=Sunday … 6=Saturday, or null for "every day in the date range". */
    weekday: integer("weekday"),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    /** `YYYY-MM-DD` in the resource's zone, inclusive. Stored as TEXT because
     *  ISO dates compare correctly as strings and a rule bound is a calendar
     *  date, not an instant — it must not shift with the offset. */
    startsOn: text("starts_on"),
    endsOn: text("ends_on"),
    /** "Public holiday", "Annual leave" — shown in the admin, never publicly. */
    reason: text("reason"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("booking_rules_resource_idx").on(t.resourceId, t.kind)],
);

/**
 * A taken slot.
 *
 * `held` is the pre-confirmation state a public booker passes through while a
 * deposit is paid or a form is completed; it occupies the slot exactly like a
 * confirmation does, but only until `hold_expires_at`. Expiry is DERIVED at
 * read time rather than swept by a job, for the same reason a signature request
 * expires that way: a wedged cron must not be able to keep a slot closed.
 *
 * `completed` is derived too — a confirmed booking whose end time has passed —
 * so nothing has to run for yesterday's appointments to stop looking upcoming.
 */
export const bookings = sqliteTable(
  "bookings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    resourceId: text("resource_id").notNull(),
    startAt: integer("start_at", { mode: "timestamp_ms" }).notNull(),
    endAt: integer("end_at", { mode: "timestamp_ms" }).notNull(),
    /** held | confirmed | cancelled | no_show | expired. `completed` is always
     *  derived from the clock. `expired` is derived too, for every read — it is
     *  only ever WRITTEN lazily, by a writer that needs the seat back. */
    status: text("status").notNull().default("confirmed"),
    /**
     * Which of the resource's `capacity` places this booking holds, `0`-based.
     *
     * The reason it exists is the partial unique index below: `(resource, start,
     * seat)` over the occupying statuses is what makes "no more than capacity
     * bookings at one instant" a property the DATABASE enforces, atomically, on
     * a store with no row locks. Without it the guard is a read-after-write
     * race that a late arrival can win twice.
     */
    seat: integer("seat").notNull().default(0),
    holdExpiresAt: integer("hold_expires_at", { mode: "timestamp_ms" }),
    customerName: text("customer_name"),
    customerEmail: text("customer_email"),
    customerPhone: text("customer_phone"),
    /** Answers to the resource's `questions`, keyed by question name. */
    answers: text("answers", { mode: "json" }).$type<Record<string, unknown> | null>(),
    notes: text("notes"),
    /** SHA-256 of the manage link token. The token itself reaches the booker in
     *  one email and is stored nowhere: it is the entire grant to cancel or
     *  reschedule, so a readable copy here would let anyone with database
     *  access cancel a stranger's appointment. */
    tokenHash: text("token_hash").notNull(),
    /** Where the recorded row landed. */
    mirrorCollection: text("mirror_collection"),
    mirrorItemId: text("mirror_item_id"),
    /** Why the last recording attempt failed, when it did. Recording is
     *  best-effort — the slot is already held and a mis-shaped collection must
     *  not turn a confirmed appointment into a 500 for the customer — so the
     *  failure has to be legible SOMEWHERE, or a workspace discovers months
     *  later that nothing was ever written. Cleared by the next success. */
    mirrorError: text("mirror_error"),
    /** public | admin | api — who created it, for the admin list and for
     *  telling a self-service no-show from an operator's data entry. */
    source: text("source").notNull().default("public"),
    cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
    cancelReason: text("cancel_reason"),
    /** Set when an operator cancelled; null when the booker did it themselves. */
    cancelledBy: text("cancelled_by"),
    /** Set on the row a reschedule REPLACED, so the trail survives. */
    rescheduledToId: text("rescheduled_to_id"),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("bookings_token_idx").on(t.tokenHash),
    // The hard capacity guarantee. Partial, so a cancelled or expired booking
    // gives its seat back without anything having to move rows around.
    uniqueIndex("bookings_seat_idx")
      .on(t.resourceId, t.startAt, t.seat)
      .where(sql`status IN ('held','confirmed')`),
    // The overlap query is always "this resource, around this instant", so the
    // resource leads and the start time follows it.
    index("bookings_resource_start_idx").on(t.resourceId, t.startAt),
    index("bookings_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

export const i18nStrings = sqliteTable(
  "i18n_strings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    key: text("key").notNull(),
    locale: text("locale").notNull(),
    value: text("value").notNull(),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("i18n_strings_unique_idx").on(t.tenantId, t.key, t.locale),
    index("i18n_strings_locale_idx").on(t.locale),
  ],
);

export const appSettings = sqliteTable(
  "app_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).$type<unknown>(),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("app_settings_unique_idx").on(t.tenantId, t.key)],
);

/**
 * Feature flags / remote config. A `tenantId IS NULL` row is the global
 * default; a per-tenant row with the same `key` overrides it. `rules` carries
 * optional targeting — a permission-DSL `condition` (resolved against the
 * caller's `$user`/`$tenant`) and/or a `rollout` percentage (0–100, stable per
 * user+key). Evaluated by `evaluateFlags`; served to client apps at `/api/flags`.
 */
export const featureFlags = sqliteTable(
  "feature_flags",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    key: text("key").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    /** Remote-config payload returned when the flag is on (any JSON). */
    value: text("value", { mode: "json" }).$type<unknown>(),
    /** Targeting: `{ condition?: Condition, rollout?: number }`. Null = everyone. */
    rules: text("rules", { mode: "json" }).$type<{ condition?: unknown; rollout?: number } | null>(),
    description: text("description"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("feature_flags_unique_idx").on(t.tenantId, t.key),
    index("feature_flags_tenant_idx").on(t.tenantId),
  ],
);

export const savedPanels = sqliteTable(
  "saved_panels",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").notNull().default("sql"),
    sql: text("sql"),
    viz: text("viz").notNull().default("sparkline"),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>(),
    layout: text("layout", { mode: "json" }).$type<{ x: number; y: number; w: number; h: number } | null>(),
    /** Optional parent dashboard. NULL = legacy "loose" panel. */
    dashboardId: text("dashboard_id"),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("saved_panels_tenant_idx").on(t.tenantId),
    index("saved_panels_dashboard_idx").on(t.dashboardId),
  ],
);

/**
 * Embedded BI dashboards — named groupings of `saved_panels` publishable to a
 * public, unauthenticated embed URL. The plaintext embed token (`dsh_<hex>`)
 * is returned once on share; only its SHA-256 hash is stored. `embedRoleId`
 * scopes the permissions the public embed resolves data against. Mirrors
 * `shared_links` (token hash) + `api_keys.roleId` (scope).
 */
export const dashboards = sqliteTable(
  "dashboards",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    description: text("description"),
    layout: text("layout", { mode: "json" }).$type<Record<string, unknown> | null>(),
    embedEnabled: integer("embed_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    embedTokenHash: text("embed_token_hash"),
    embedRoleId: text("embed_role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("dashboards_tenant_idx").on(t.tenantId),
    uniqueIndex("dashboards_embed_token_idx").on(t.embedTokenHash),
  ],
);

/**
 * Named KPI definitions — the one place a KPI's formula is written down.
 *
 * Before this table every surface carried its own arithmetic: a panel held raw
 * `sql`, the Ask AI planner improvised `collections.aggregate` args per
 * question, and a report re-derived the same figure a third way. Nothing forced
 * them to agree, so "revenue" could mean three different numbers in one
 * workspace and no screen admitted it. A KPI row is the definition; panels,
 * Ask AI, reports and the public embed all resolve through `runKpi()`, so
 * they are wrong together or right together but never quietly different.
 *
 * The shape deliberately mirrors `ItemsAggregateConfig` (collection / agg /
 * field / filter / groupBy) because the runner delegates to
 * `runItemsAggregate` rather than reimplementing aggregation — money scaling,
 * per-row-currency refusal, soft-delete and draft visibility are already
 * settled there and must not fork.
 */
export const kpis = sqliteTable(
  "kpis",
  {
    id: text("id").primaryKey(),
    /** NOT NULL with '' for "no tenant", unlike the neighbouring tables: the
     *  unique index below treats NULLs as DISTINCT, and a slug that two rows
     *  can share is not a lookup key. See the migration for the full argument. */
    tenantId: text("tenant_id").notNull().default(""),
    /** Stable handle a panel or an AI tool call references. Renaming the
     *  display `name` must not break a dashboard, so the slug is the key. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Collection slug the metric aggregates over. */
    collection: text("collection").notNull(),
    /** count | sum | avg | min | max — mirrors ITEMS_AGG_FUNCS. */
    agg: text("agg").notNull().default("count"),
    /** Aggregate target. Null only for `count`. */
    field: text("field"),
    /** Permission-DSL condition narrowing the rows, e.g. only paid orders.
     *  Same grammar the list endpoint takes, so a metric and a filtered list
     *  view count the same rows. */
    filter: text("filter", { mode: "json" }).$type<Record<string, unknown> | null>(),
    /** Timestamp column the period window applies to. Null = the metric has no
     *  time dimension, so it reports a running total with no comparison rather
     *  than pretending the previous period was zero. */
    dateField: text("date_field"),
    /** Optional ranking dimension — this is what makes "top products" and
     *  "revenue by country" definitions rather than one-off queries. */
    groupBy: text("group_by"),
    /** Row cap for a grouped metric. Named `top_n` because `limit` is SQL. */
    topN: integer("top_n"),
    /** number | money | percent | duration — how a reader should print it. */
    format: text("format").notNull().default("number"),
    /** Free-text suffix for `number` metrics ("orders", "kg"). */
    unit: text("unit"),
    decimals: integer("decimals"),
    /** Which way is good news. A rising cancellation rate is red and a rising
     *  order count is green; without this the delta colour is a coin flip. */
    direction: text("direction").notNull().default("neutral"),
    /** Which way the threshold is breached: `above` | `below` |
     *  `change_above` | `change_below` (the last two compare `deltaPct`).
     *  Null = this KPI is not watched. */
    alertOperator: text("alert_operator"),
    /** The threshold. For a `change_*` operator this is a FRACTION (0.2 = 20%),
     *  the same units `deltaPct` reports in. */
    alertValue: real("alert_value"),
    /** Whether the KPI is currently breaching — what makes the alert fire on
     *  the transition rather than on every scheduler tick. */
    alertFiring: integer("alert_firing", { mode: "boolean" }).notNull().default(false),
    /** The collection whose ITEM PAGE this tile belongs on — not the one the
     *  KPI aggregates. "Revenue per product" sums order lines and belongs on a
     *  product. */
    pinTo: text("pin_to"),
    /** The relation column on the KPI's own collection pointing back at that
     *  row, so the server never guesses which relation the pin meant. */
    pinField: text("pin_field"),
    alertLastFiredAt: integer("alert_last_fired_at"),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("kpis_tenant_idx").on(t.tenantId),
    index("kpis_pin_idx").on(t.tenantId, t.pinTo),
    uniqueIndex("kpis_tenant_slug_idx").on(t.tenantId, t.slug),
  ],
);

/**
 * Public form definitions — embeddable, unauthenticated forms whose
 * submissions are written into a collection through the items write core.
 * The plaintext token (`frm_<hex>`) is shown once on creation; only its
 * SHA-256 hash is stored (mirrors `shared_links` / `dashboards` embed).
 */
export const forms = sqliteTable(
  "forms",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    collection: text("collection").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** Ordered exposed fields: [{ name, label?, help? }]. */
    fields: text("fields", { mode: "json" }).$type<Array<Record<string, unknown>>>().notNull(),
    /** Behaviour knobs: submit label, success message/redirect, turnstile. */
    settings: text("settings", { mode: "json" }).$type<Record<string, unknown> | null>(),
    /** Paused forms answer 410 on the public endpoints without being deleted. */
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /** All-time accepted submissions (incremented per successful submit). */
    submissionCount: integer("submission_count").notNull().default(0),
    /** Submissions rejected by honeypot / Turnstile / rate limit. */
    blockedCount: integer("blocked_count").notNull().default(0),
    lastSubmissionAt: integer("last_submission_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("forms_token_idx").on(t.tokenHash),
    index("forms_tenant_idx").on(t.tenantId),
    index("forms_collection_idx").on(t.collection),
  ],
);

/**
 * One invitation to answer a form — the shape that makes "one response per
 * person" mean a person. SQLite twin of the pg table.
 *
 * The form's own token is a door anyone with the link walks through, which is
 * why the cookie guard beside it is a courtesy and not a count. An invite is
 * per-recipient and single-use: `used_at` is written by the submit that spends
 * it, in an UPDATE conditional on the column still being null, so two tabs
 * racing the same link produce one answer.
 */
export const formInvites = sqliteTable(
  "form_invites",
  {
    id: text("id").primaryKey(),
    formId: text("form_id").notNull(),
    tenantId: text("tenant_id"),
    /** Who it was minted for. Null for a batch of unaddressed links. */
    email: text("email"),
    name: text("name"),
    /** The link it was minted with. Reminders mint more, and those live in
     *  `form_invite_tokens` — all of them open this one turn. */
    tokenHash: text("token_hash").notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    /** When a reminder last went out, and how many have. */
    remindedAt: integer("reminded_at", { mode: "timestamp_ms" }),
    reminderCount: integer("reminder_count").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("form_invites_token_idx").on(t.tokenHash),
    index("form_invites_form_idx").on(t.formId),
    index("form_invites_tenant_idx").on(t.tenantId),
  ],
);

/**
 * A LATER link into an invite — the ones a reminder mints. SQLite twin of the
 * pg table.
 *
 * An invite is a turn, not a link. It gets more than one because the plaintext
 * token is never stored, only its SHA-256, so a reminder cannot re-send the
 * link that was mailed and has to mint another. Rotating the invite's own token
 * instead would kill the link in the first mail, in front of exactly the person
 * the reminder is trying to reach.
 *
 * The first link stays on the invite and every one after it lands here; all of
 * them open the same turn, and spending any one spends it.
 */
export const formInviteTokens = sqliteTable(
  "form_invite_tokens",
  {
    id: text("id").primaryKey(),
    inviteId: text("invite_id").notNull(),
    /** Denormalised from the invite so the lookup stays scoped to one form
     *  without a join. */
    formId: text("form_id").notNull(),
    tenantId: text("tenant_id"),
    tokenHash: text("token_hash").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("form_invite_tokens_hash_idx").on(t.tokenHash),
    index("form_invite_tokens_invite_idx").on(t.inviteId),
    index("form_invite_tokens_form_idx").on(t.formId),
  ],
);

/**
 * A half-filled form, kept so the person can come back to it. SQLite twin of
 * the pg table.
 *
 * Opt-in per form (`settings.saveProgress`). The row is found by `key_hash` —
 * the SHA-256 of whatever the visitor holds: an opaque cookie value for an open
 * link, or the invite token for an invited one. Only the hash is stored, so the
 * table is a set of answers nobody can look up without the secret that wrote
 * them. Deleted by the submit that completes it, and swept once stale.
 */
export const formDrafts = sqliteTable(
  "form_drafts",
  {
    id: text("id").primaryKey(),
    formId: text("form_id").notNull(),
    tenantId: text("tenant_id"),
    /** SHA-256 of the resume secret — never the secret itself. */
    keyHash: text("key_hash").notNull(),
    /** Answers so far, clamped to the form's currently-exposed fields. */
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Step page the visitor had reached, so they return to it and not to the
     *  first question of a form they are two-thirds through. */
    step: integer("step").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    // One draft per (form, holder): the upsert targets this, so two tabs of the
    // same visitor race into one row instead of forking the answers.
    uniqueIndex("form_drafts_key_idx").on(t.formId, t.keyHash),
    index("form_drafts_form_idx").on(t.formId),
    index("form_drafts_updated_idx").on(t.updatedAt),
  ],
);

export const authConfig = sqliteTable(
  "auth_config",
  {
    tenantId: text("tenant_id").primaryKey(),
    providers: text("providers", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    policy: text("policy", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    sessionLifetime: text("session_lifetime").notNull().default("30d"),
    redirectUrls: text("redirect_urls", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** Captcha configuration — see the pg twin. Plain TEXT (not `mode: "json"`)
     *  so an unreadable value degrades to "no captcha" in one function rather
     *  than throwing inside the row mapper, where no default can be applied. */
    captcha: text("captcha"),
    updatedAt: ts("updated_at"),
  },
);

/**
 * Per-workspace SAML 2.0 IdP configuration. Mirror of the pg `saml_providers`
 * table — see packages/db/src/pg/schema.ts for the column-level docs.
 *
 * Booleans are stored as integer (0/1) per SQLite convention; `attribute_map`
 * and `groups_to_roles` use JSON text columns rather than `jsonb`.
 */
export const samlProviders = sqliteTable(
  "saml_providers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    idpTemplate: text("idp_template"),
    entityId: text("entity_id").notNull(),
    ssoUrl: text("sso_url").notNull(),
    sloUrl: text("slo_url"),
    /** AES-256-GCM ciphertext of the IdP signing cert PEM. */
    idpCertPem: text("idp_cert_pem").notNull(),
    spEntityId: text("sp_entity_id").notNull(),
    attributeMap: text("attribute_map", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    defaultRoleId: text("default_role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    groupsToRoles: text("groups_to_roles", { mode: "json" }).$type<
      Record<string, string>
    >(),
    signatureAlgorithm: text("signature_algorithm").notNull().default("sha256"),
    wantSignedAssertions: integer("want_signed_assertions", { mode: "boolean" })
      .notNull()
      .default(true),
    linkByVerifiedEmail: integer("link_by_verified_email", { mode: "boolean" })
      .notNull()
      .default(false),
    nameIdFormat: text("name_id_format").notNull().default("emailAddress"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("saml_providers_tenant_slug_idx").on(t.tenantId, t.slug),
    index("saml_providers_tenant_idx").on(t.tenantId),
  ],
);

/**
 * A workspace-defined OIDC / OAuth2 identity provider — the generic twin of
 * `saml_providers`. One row per IdP, so Okta, Auth0, Keycloak, Entra,
 * Authentik, GitLab and friends are all the *same* code path rather than a
 * hand-written provider each. Mirror of the PG table.
 *
 * `discoveryUrl` is the preferred wiring: the endpoints below are resolved
 * from `.well-known/openid-configuration` at save time. The explicit URLs are
 * kept for plain OAuth2 providers that publish no discovery document.
 */
export const oidcProviders = sqliteTable(
  "oidc_providers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Display name shown on the sign-in button. */
    name: text("name").notNull(),
    /** URL-safe id; also the better-auth `providerId`. */
    slug: text("slug").notNull(),
    clientId: text("client_id").notNull(),
    /** AES-256-GCM ciphertext of the client secret. */
    clientSecretEnc: text("client_secret_enc").notNull(),
    discoveryUrl: text("discovery_url"),
    authorizationUrl: text("authorization_url"),
    tokenUrl: text("token_url"),
    userInfoUrl: text("user_info_url"),
    scopes: text("scopes", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(["openid", "profile", "email"]),
    /** PKCE on by default — required by Entra and most modern IdPs. */
    pkce: integer("pkce", { mode: "boolean" }).notNull().default(true),
    /** Claim to read the user's email from, when the IdP is non-standard. */
    emailClaim: text("email_claim"),
    /** Claim carrying group membership, for `groups_to_roles`. */
    groupsClaim: text("groups_claim"),
    defaultRoleId: text("default_role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    groupsToRoles: text("groups_to_roles", { mode: "json" }).$type<
      Record<string, string>
    >(),
    /** Attach to an existing local account when the IdP asserts a verified
     *  email. Off by default: an IdP that does not verify emails would let a
     *  new sign-in take over an existing account. */
    linkByVerifiedEmail: integer("link_by_verified_email", { mode: "boolean" })
      .notNull()
      .default(false),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("oidc_providers_tenant_slug_idx").on(t.tenantId, t.slug),
    index("oidc_providers_tenant_idx").on(t.tenantId),
  ],
);

/**
 * An external issuer whose JWTs this workspace accepts as they are — Clerk,
 * Auth0, Firebase Auth, AWS Cognito, WorkOS. Mirror of the PG table; the
 * doc comment there carries the full rationale, including why `issuer` is
 * unique instance-wide rather than per tenant.
 */
export const thirdPartyAuthProviders = sqliteTable(
  "third_party_auth_providers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Exact `iss` claim value to match. */
    issuer: text("issuer").notNull(),
    jwksUrl: text("jwks_url").notNull(),
    discoveryUrl: text("discovery_url"),
    /** Expected `aud`; null accepts any audience. */
    audience: text("audience"),
    subjectClaim: text("subject_claim").notNull().default("sub"),
    emailClaim: text("email_claim").notNull().default("email"),
    nameClaim: text("name_claim"),
    groupsClaim: text("groups_claim"),
    groupsToRoles: text("groups_to_roles", { mode: "json" }).$type<
      Record<string, string>
    >(),
    defaultRoleId: text("default_role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    linkByVerifiedEmail: integer("link_by_verified_email", { mode: "boolean" })
      .notNull()
      .default(false),
    /** When false, an unlinked subject is rejected instead of provisioned. */
    autoProvision: integer("auto_provision", { mode: "boolean" })
      .notNull()
      .default(true),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("third_party_auth_tenant_slug_idx").on(t.tenantId, t.slug),
    uniqueIndex("third_party_auth_issuer_idx").on(t.issuer),
    index("third_party_auth_tenant_idx").on(t.tenantId),
  ],
);

/**
 * SCIM 2.0 provisioning endpoint config — one row per workspace.
 *
 * An IdP (Okta, Entra, OneLogin) calls `/api/scim/v2/*` with a bearer token to
 * create, update and deactivate app-plane users without anyone signing in
 * first. That is the half SSO alone cannot do: SAML/OIDC provision on first
 * login, SCIM provisions and — crucially — DEPROVISIONS on the IdP's schedule.
 *
 * The token is stored as a SHA-256 hash (same treatment as `api_keys`) and
 * shown exactly once, at create/rotate. `token_prefix` is a short display
 * fragment so an admin can tell two tokens apart without revealing either.
 */
export const scimConfig = sqliteTable(
  "scim_config",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** SHA-256 of the bearer token. Never the token itself. */
    tokenHash: text("token_hash").notNull(),
    /** First few chars of the token, for display only. */
    tokenPrefix: text("token_prefix").notNull(),
    /** Role granted to every SCIM-provisioned user, on top of group mapping. */
    defaultRoleId: text("default_role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    /** Last time the IdP called any SCIM endpoint — the "is it wired up" signal. */
    lastRequestAt: integer("last_request_at", { mode: "timestamp_ms" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("scim_config_tenant_idx").on(t.tenantId),
    index("scim_config_token_idx").on(t.tokenHash),
  ],
);

/**
 * A SYNCHRONOUS hook — an external service that participates in a write.
 *
 * Outbound webhooks tell someone what already happened. A sync hook runs BEFORE
 * the row is written and its answer decides the outcome: it can reject the
 * write, or (when `can_mutate`) patch the payload. That is what lets a third
 * party own validation, enrichment, pricing or tax without backlex shipping an
 * integration for each — the thing Saleor's sync webhooks and Shopify Functions
 * exist to provide.
 *
 * It sits on the request path, so every field here is about bounding the blast
 * radius of a slow or broken app.
 */
export const syncHooks = sqliteTable(
  "sync_hooks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    url: text("url").notNull(),
    /** HMAC signing secret, so the app can prove the call came from us. */
    secret: text("secret"),
    /** `<collection>.beforeCreate|beforeUpdate|beforeDelete`, `*` wildcards. */
    events: text("events", { mode: "json" }).$type<string[]>().notNull(),
    headers: text("headers", { mode: "json" }).$type<Record<string, string> | null>(),
    /** Hard ceiling on how long a write may block on this hook. */
    timeoutMs: integer("timeout_ms").notNull().default(2000),
    /**
     * What happens when the hook cannot answer (timeout, non-2xx, malformed).
     * Deliberately has NO default at the API layer: `allow` silently drops the
     * guarantee the hook exists to provide, `deny` turns the app's outage into
     * yours. Only the operator can say which is correct for a given hook.
     */
    onError: text("on_error").notNull(),
    /** Whether this hook's `data` patch is applied. A hook that only validates
     *  must not be able to rewrite rows, so this is off unless asked for. */
    canMutate: integer("can_mutate", { mode: "boolean" }).notNull().default(false),
    /** Execution order; ties broken by `created_at`. Hooks run SEQUENTIALLY and
     *  each sees the previous one's patch. */
    priority: integer("priority").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastFailureAt: integer("last_failure_at", { mode: "timestamp_ms" }),
    disabledReason: text("disabled_reason"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("sync_hooks_tenant_idx").on(t.tenantId),
    index("sync_hooks_enabled_idx").on(t.enabled),
  ],
);

/**
 * An auth hook — see packages/db/src/pg/schema.ts for the full rationale
 * (workspace plane only, at most one hook per event, why `on_error` has no
 * default). SQLite twin: booleans are 0/1, timestamps epoch-ms, JSON is text.
 */
export const authHooks = sqliteTable(
  "auth_hooks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    targetType: text("target_type").notNull(),
    url: text("url"),
    functionName: text("function_name"),
    secret: text("secret"),
    headers: text("headers", { mode: "json" }).$type<Record<string, string> | null>(),
    timeoutMs: integer("timeout_ms").notNull().default(2000),
    onError: text("on_error").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastFailureAt: integer("last_failure_at", { mode: "timestamp_ms" }),
    disabledReason: text("disabled_reason"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("auth_hooks_tenant_event_idx").on(t.tenantId, t.event),
    index("auth_hooks_tenant_idx").on(t.tenantId),
  ],
);

/**
 * Federated identity link — see packages/db/src/pg/schema.ts for full docs.
 * `plane` is `'platform' | 'app'`; `user_id` references the matching pool.
 */
export const externalIdentities = sqliteTable(
  "external_identities",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    plane: text("plane").notNull(),
    userId: text("user_id").notNull(),
    providerType: text("provider_type").notNull(),
    providerId: text("provider_id").notNull(),
    subject: text("subject").notNull(),
    emailAtProvision: text("email_at_provision"),
    rolesFromGroups: text("roles_from_groups", { mode: "json" }).$type<string[]>(),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    lastLoginIp: text("last_login_ip"),
    lastAuthnContext: text("last_authn_context"),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("external_identities_lookup_idx").on(
      t.tenantId,
      t.providerType,
      t.providerId,
      t.subject,
    ),
    index("external_identities_user_idx").on(t.plane, t.userId),
  ],
);

/**
 * Per-workspace LDAP / Active Directory configuration — see
 * packages/db/src/pg/schema.ts for full docs.
 */
export const ldapConfigs = sqliteTable(
  "ldap_configs",
  {
    tenantId: text("tenant_id").primaryKey(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    url: text("url").notNull(),
    bindDn: text("bind_dn").notNull(),
    baseDn: text("base_dn").notNull(),
    userFilter: text("user_filter")
      .notNull()
      .default("(&(objectClass=person)(uid={{username}}))"),
    groupFilter: text("group_filter"),
    attributeMap: text("attribute_map", { mode: "json" })
      .$type<{ email: string; firstName: string; lastName: string; groups: string }>()
      .notNull()
      .default({ email: "mail", firstName: "givenName", lastName: "sn", groups: "memberOf" }),
    defaultRoleId: text("default_role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    groupsToRoles: text("groups_to_roles", { mode: "json" }).$type<
      Record<string, string>
    >(),
    tlsOptions: text("tls_options", { mode: "json" }).$type<{
      rejectUnauthorized?: boolean;
    }>(),
    secrets: text("secrets", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    domainMatch: text("domain_match", { mode: "json" }).$type<string[]>(),
    rateLimitPerMinute: integer("rate_limit_per_minute").notNull().default(10),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("ldap_configs_tenant_idx").on(t.tenantId)],
);

/**
 * Instance-global control-plane (admin) SAML provider — mirror of
 * `platform_saml_providers` in packages/db/src/pg/schema.ts. No tenant scoping;
 * identities land in `users`. Booleans are integer 0/1; JSON columns use text.
 */
export const platformSamlProviders = sqliteTable(
  "platform_saml_providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    idpTemplate: text("idp_template"),
    entityId: text("entity_id").notNull(),
    ssoUrl: text("sso_url").notNull(),
    sloUrl: text("slo_url"),
    /** AES-256-GCM ciphertext of the IdP signing cert PEM. */
    idpCertPem: text("idp_cert_pem").notNull(),
    spEntityId: text("sp_entity_id").notNull(),
    attributeMap: text("attribute_map", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    defaultRoleId: text("default_role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    groupsToRoles: text("groups_to_roles", { mode: "json" }).$type<
      Record<string, { tenantId: string; roleId: string }>
    >(),
    signatureAlgorithm: text("signature_algorithm").notNull().default("sha256"),
    wantSignedAssertions: integer("want_signed_assertions", { mode: "boolean" })
      .notNull()
      .default(true),
    linkByVerifiedEmail: integer("link_by_verified_email", { mode: "boolean" })
      .notNull()
      .default(false),
    nameIdFormat: text("name_id_format").notNull().default("emailAddress"),
    /** JIT allow-list of email domains (json array); null/empty = any. */
    domainMatch: text("domain_match", { mode: "json" }).$type<string[]>(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("platform_saml_providers_slug_idx").on(t.slug)],
);

/**
 * Instance-global control-plane LDAP config (singleton, PK `'singleton'`) —
 * mirror of `platform_ldap_config` in pg. Self-host only (LDAP can't run on
 * Workers — see lib/auth-select.ts).
 */
export const platformLdapConfig = sqliteTable("platform_ldap_config", {
  id: text("id").primaryKey().default("singleton"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  url: text("url").notNull(),
  bindDn: text("bind_dn").notNull(),
  baseDn: text("base_dn").notNull(),
  userFilter: text("user_filter")
    .notNull()
    .default("(&(objectClass=person)(uid={{username}}))"),
  groupFilter: text("group_filter"),
  attributeMap: text("attribute_map", { mode: "json" })
    .$type<{ email: string; firstName: string; lastName: string; groups: string }>()
    .notNull()
    .default({ email: "mail", firstName: "givenName", lastName: "sn", groups: "memberOf" }),
  defaultRoleId: text("default_role_id").references(() => roles.id, {
    onDelete: "set null",
  }),
  groupsToRoles: text("groups_to_roles", { mode: "json" }).$type<
    Record<string, { tenantId: string; roleId: string }>
  >(),
  tlsOptions: text("tls_options", { mode: "json" }).$type<{
    rejectUnauthorized?: boolean;
  }>(),
  secrets: text("secrets", { mode: "json" })
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  domainMatch: text("domain_match", { mode: "json" }).$type<string[]>(),
  rateLimitPerMinute: integer("rate_limit_per_minute").notNull().default(10),
  updatedAt: ts("updated_at"),
});

/**
 * Platform-plane federated identity link — mirror of
 * `platform_external_identities` in pg. Maps an IdP subject to a `users` row.
 */
export const platformExternalIdentities = sqliteTable(
  "platform_external_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerType: text("provider_type").notNull(),
    providerId: text("provider_id").notNull(),
    subject: text("subject").notNull(),
    emailAtProvision: text("email_at_provision"),
    rolesFromGroups: text("roles_from_groups", { mode: "json" }).$type<string[]>(),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    lastLoginIp: text("last_login_ip"),
    lastAuthnContext: text("last_authn_context"),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("platform_external_identities_lookup_idx").on(
      t.providerType,
      t.providerId,
      t.subject,
    ),
    index("platform_external_identities_user_idx").on(t.userId),
  ],
);

/**
 * Per-workspace email transport. `tenant_id` is the workspace id, or the
 * `_global` sentinel for the instance-wide override row. `provider = "inherit"`
 * (or no usable config) falls through to the next level and ultimately to the
 * deployment's env-derived adapter. `config` holds non-secret provider params;
 * `secrets` holds the same keys but AES-256-GCM ciphertext (see lib/crypto).
 */
export const emailConfig = sqliteTable(
  "email_config",
  {
    tenantId: text("tenant_id").primaryKey(),
    /** inherit | console | resend | sendgrid | mailgun | ses | smtp */
    provider: text("provider").notNull().default("inherit"),
    fromAddress: text("from_address"),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    secrets: text("secrets", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    updatedAt: ts("updated_at"),
  },
);

/**
 * Per-workspace bring-your-own AI provider key — SQLite mirror of the pg
 * `ai_config` table. See the pg schema for the full contract. `provider` and
 * the `secrets` key names are driven by the server's provider registry
 * (`apps/web/src/server/services/ai-providers.ts`), so adding a provider needs
 * no migration here — `secrets` is an opaque encrypted JSON blob.
 */
export const aiConfig = sqliteTable(
  "ai_config",
  {
    tenantId: text("tenant_id").primaryKey(),
    provider: text("provider").notNull().default("inherit"),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    secrets: text("secrets", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    updatedAt: ts("updated_at"),
  },
);

/**
 * Per-workspace branding & appearance. `tenant_id` is the workspace id, or the
 * `_global` sentinel for the instance-wide override row used as a fallback
 * (same pattern as `email_config` / `auth_config`). `logo_file_key` and
 * `favicon_file_key` reference `files.key`. `primary_color` stores a raw OKLCH
 * string (e.g. `oklch(0.84 0.23 128.85)`); when set it overrides the UI's
 * default `--primary` token at boot. `default_theme` is the workspace's
 * suggested theme — each user can still override locally.
 */
export const workspaceConfig = sqliteTable(
  "workspace_config",
  {
    tenantId: text("tenant_id").primaryKey(),
    workspaceName: text("workspace_name"),
    description: text("description"),
    logoFileKey: text("logo_file_key"),
    faviconFileKey: text("favicon_file_key"),
    /** Raw OKLCH string applied to `:root { --primary }` at boot. */
    primaryColor: text("primary_color"),
    /** light | dark | system | null (= leave to user). */
    defaultTheme: text("default_theme"),
    updatedAt: ts("updated_at"),
  },
);

export const backups = sqliteTable(
  "backups",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    kind: text("kind").notNull().default("manual"),
    label: text("label"),
    storageKey: text("storage_key").notNull(),
    size: integer("size").notNull().default(0),
    tableCount: integer("table_count").notNull().default(0),
    status: text("status").notNull().default("queued"),
    error: text("error"),
    /** Comma-separated tables named in the dump that don't exist here. See the
     *  pg twin for why absence is recorded and a read failure is not. */
    missingTables: text("missing_tables"),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("backups_tenant_idx").on(t.tenantId),
    index("backups_created_idx").on(t.createdAt),
  ],
);

/**
 * Third-party integrations (Slack/Discord/Datadog/GitHub) connected at the
 * workspace level. Mirror of the PG table; `config` secret fields are
 * encrypted at rest, `events` null = all events.
 */
export const integrations = sqliteTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    kind: text("kind").notNull(),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    events: text("events", { mode: "json" }).$type<string[] | null>(),
    /** `connected` while delivering; `disabled` once the breaker trips (or an
     *  admin pauses it). `dispatchIntegrations` only fans out to `connected`. */
    status: text("status").notNull().default("connected"),
    lastEventAt: integer("last_event_at", { mode: "timestamp_ms" }),
    /** Consecutive failed deliveries since the last success — drives the
     *  auto-disable circuit breaker. Reset to 0 on any success. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Timestamp of the most recent failed delivery (null once healthy). */
    lastFailureAt: integer("last_failure_at", { mode: "timestamp_ms" }),
    /** Human-readable reason set when the breaker auto-disables this
     *  integration; null while healthy or when paused manually. */
    disabledReason: text("disabled_reason"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("integrations_tenant_idx").on(t.tenantId)],
);

/**
 * One row per attempt to deliver an event to a connected integration — the
 * audit trail behind the admin's delivery log and the `integration.deliver`
 * job's retries. Mirror of the PG table; carries `tenant_id` so a workspace's
 * log can be scoped without joining back to `integrations`.
 */
export const integrationDeliveries = sqliteTable(
  "integration_deliveries",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id").notNull(),
    tenantId: text("tenant_id"),
    /** The event name that triggered this delivery, e.g. `posts.created`. */
    event: text("event").notNull(),
    /** HTTP status; 0 when the provider was misconfigured or the fetch threw. */
    status: integer("status").notNull(),
    /** Round-trip duration in milliseconds. */
    ms: integer("ms").notNull(),
    error: text("error"),
    /** Attempts so far, from the queue's counter (1 = first try). */
    attempts: integer("attempts").notNull().default(1),
    deliveredAt: ts("delivered_at"),
  },
  (t) => [
    index("integration_deliveries_integration_idx").on(t.integrationId),
    index("integration_deliveries_tenant_idx").on(t.tenantId),
    index("integration_deliveries_at_idx").on(t.deliveredAt),
  ],
);

/**
 * A connected payment provider (Stripe / Polar / Lemon Squeezy). Mirror of the
 * PG table. Distinct from `integrations` because the direction of travel is the
 * opposite: the provider pushes signed webhooks at us and we pull its objects
 * back to reconcile. `config` holds the API key + webhook secret encrypted at
 * rest; `webhook_token` is the public path segment of the receive URL and is
 * rotatable without touching the provider credentials.
 */
export const paymentProviders = sqliteTable(
  "payment_providers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    provider: text("provider").notNull(),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("connected"),
    webhookToken: text("webhook_token").notNull(),
    /** Cursor per record kind, so an interrupted reconcile resumes. */
    syncCursor: text("sync_cursor", { mode: "json" }).$type<Record<string, string | null> | null>(),
    lastEventAt: integer("last_event_at", { mode: "timestamp_ms" }),
    lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
    lastSyncError: text("last_sync_error"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("payment_providers_tenant_provider_idx").on(t.tenantId, t.provider),
    uniqueIndex("payment_providers_token_idx").on(t.webhookToken),
  ],
);

/**
 * Every webhook delivery a provider made, verified or not. The unique
 * (provider_id, external_id) index is the replay guard: a retried delivery
 * hits the conflict and is answered 200 without re-applying its rows.
 */
export const paymentEvents = sqliteTable(
  "payment_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    providerId: text("provider_id").notNull(),
    /** The provider's own event id — the dedupe key. */
    externalId: text("external_id").notNull(),
    type: text("type").notNull().default(""),
    /** received | processed | skipped | failed */
    status: text("status").notNull().default("received"),
    recordCount: integer("record_count").notNull().default(0),
    error: text("error"),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown> | null>(),
    createdAt: ts("created_at"),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("payment_events_dedupe_idx").on(t.providerId, t.externalId),
    index("payment_events_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

/**
 * Product-analytics event stream (#22) — one row per tracked product event
 * (`page_view`, `signup`, `checkout_completed`, …), written in batches by the
 * public ingest endpoint. High-volume and disposable: no FKs, pruned by
 * retention, safe to truncate. Every "unique user" count, funnel cohort and
 * retention cohort is keyed by `distinct_id`, not `user_id`, so anonymous
 * pre-signup traffic is measurable and a visitor who later logs in still
 * counts once.
 */
export const analyticsEvents = sqliteTable(
  "analytics_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    /** Client-generated stable id for an anonymous visitor/device. */
    distinctId: text("distinct_id").notNull(),
    /** App-plane user id, when the caller was authenticated. */
    userId: text("user_id"),
    sessionId: text("session_id"),
    props: text("props", { mode: "json" }).$type<Record<string, unknown> | null>(),
    path: text("path"),
    /** `path` with its query string removed — the key page reports GROUP BY.
     *
     *  `path` keeps the query because that is where campaign tags live and
     *  because `?q=` / `?page=2` are real information. But grouping on it
     *  splits one page into a row per campaign variant, so the grouping key is
     *  materialized here at write time. Same reasoning as `day` and `hour`:
     *  there is no substring-before-a-character expression with a common
     *  spelling across Postgres, SQLite and D1. */
    pathBase: text("path_base"),
    referrer: text("referrer"),
    /** `web` / `ios` / `android` / `server`, or any free-form client label. */
    source: text("source"),
    /** App or build version, so a metric shift can be tied to a release. */
    release: text("release"),
    country: text("country"),
    /** Registered site this row came from (`analytics_sites.id`). NULL for
     *  SDK / server-side traffic — `site_id IS NOT NULL` is what isolates the
     *  web stream, so session reports don't count a cron job as a visit. */
    siteId: text("site_id"),
    /** Does `distinct_id` outlive today? `durable` = the SDK's localStorage id,
     *  `daily` = a server-derived cookieless hash that rotates at UTC midnight.
     *  Cohort and multi-day funnel reports MUST exclude `daily` — a rotating id
     *  makes every returning visitor look new, which is wrong rather than
     *  merely missing. Defaulted so rows written before this column read
     *  `durable`, which is factually what they were. */
    idScope: text("id_scope").default("durable"),
    /** `desktop` / `mobile` / `tablet` / `bot`, derived from the user-agent at
     *  ingest. The user-agent itself is never stored. */
    deviceType: text("device_type"),
    browser: text("browser"),
    os: text("os"),
    /** Campaign tagging, read off the landing URL's query string. `utm_term`
     *  and `utm_content` stay in `props`: these three are columns because
     *  reports GROUP BY them, and every added column costs D1 write throughput
     *  (see `PARAM_BUDGET` in services/analytics.ts). */
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    /** Purchase amount in the currency's MINOR units (cents, kuruş). */
    revenue: integer("revenue"),
    /** ISO-4217 code for `revenue`. Reports group by it and never sum across
     *  it — this repo has no FX rate source, and a silently mixed total is
     *  worse than no total. */
    currency: text("currency"),
    /** Event time. Client-supplied (offline queues replay late) but clamped
     *  server-side so a skewed clock can't park rows in the far future. */
    ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
    /** UTC calendar day of `ts`, `YYYY-MM-DD`. Denormalized so funnel and
     *  retention cohorts group without dialect-specific date math — the same
     *  trick `usage_counters.day` uses. */
    day: text("day").notNull(),
    /** UTC hour of `ts`, `YYYY-MM-DDTHH`. Denormalized for the same reason as
     *  `day` — there is no portable hour-bucketing expression across Postgres,
     *  SQLite and D1. NULL on rows written before this column existed.
     *  Realtime does NOT use this: "last 30 minutes" wants minute buckets and
     *  is a bounded `ts >=` scan instead. */
    hour: text("hour"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("analytics_events_tenant_ts_idx").on(t.tenantId, t.ts),
    index("analytics_events_tenant_name_ts_idx").on(t.tenantId, t.name, t.ts),
    index("analytics_events_tenant_distinct_idx").on(t.tenantId, t.distinctId, t.ts),
    index("analytics_events_tenant_day_idx").on(t.tenantId, t.day),
    index("analytics_events_tenant_hour_idx").on(t.tenantId, t.hour),
    index("analytics_events_tenant_path_base_idx").on(t.tenantId, t.pathBase),
    /** Sessionization: `PARTITION BY distinct_id ORDER BY ts` with the range
     *  filter on `day`. The older `(tenant, distinct_id, ts)` index cannot
     *  serve it — a `WHERE day BETWEEN` is not a prefix of that ordering, so
     *  the planner would scan the tenant's whole history. */
    index("analytics_events_tenant_day_distinct_ts_idx").on(
      t.tenantId,
      t.day,
      t.distinctId,
      t.ts,
    ),
  ],
);


/**
 * A website registered for tag-based measurement.
 *
 * GA makes you declare a property and a data stream before it will accept a
 * pageview, and that is not bureaucracy — it is where the per-site settings
 * live and it is the only thing standing between a public snippet and an open
 * write endpoint. The `id` ships in the snippet, so it is public by design;
 * treat it as naming a destination, never as authenticating one. What actually
 * bounds abuse is the per-(site, ip) rate limit on the collect route.
 *
 * `domain` is checked against the reported origin when `require_known_origin`
 * is set. Be honest about the strength of that: `Origin` is forgeable by any
 * non-browser client, so the check stops accidental cross-posting (a snippet
 * copied to a staging host) and casual abuse, not a determined attacker.
 */
export const analyticsSites = sqliteTable(
  "analytics_sites",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    /** Bare host, no scheme or port — `example.com`. */
    domain: text("domain").notNull(),
    /** Reporting timezone. **Unused in v1: every report buckets in UTC.** It
     *  exists now because `analytics_events.day` is UTC and re-bucketing later
     *  would be a rewrite of overview, retention and funnels — cheaper to
     *  carry an unused column than to migrate one in. */
    tz: text("tz").notNull().default("UTC"),
    /** Path globs never recorded (`/admin/*`, `/health`). */
    excludedPaths: text("excluded_paths", { mode: "json" }).$type<string[] | null>(),
    /** Source IPs never recorded — the office, a monitoring probe. Matched
     *  against the request IP, which is used and discarded either way. */
    ignoredIps: text("ignored_ips", { mode: "json" }).$type<string[] | null>(),
    /** Drop declared crawlers instead of labelling them `bot`. */
    filterBots: integer("filter_bots", { mode: "boolean" }).notNull().default(true),
    requireKnownOrigin: integer("require_known_origin", { mode: "boolean" })
      .notNull()
      .default(true),
    /** ── Tag manager ──────────────────────────────────────────────────
     *  May this site run operator-authored code (a custom HTML/JS tag, or a
     *  `js_expression` variable)? Default false, and deliberately per-site:
     *  a custom tag is arbitrary JavaScript on a public website, so it stays
     *  off until somebody turns it on for a site they mean to turn it on for. */
    allowCustomCode: integer("allow_custom_code", { mode: "boolean" })
      .notNull()
      .default(false),
    /** The container version currently served, and the row it was compiled
     *  into. Null until the first publish — a site that has never published
     *  serves the tracker alone, which is exactly what it does today. */
    publishedVersion: integer("published_version"),
    publishedVersionId: text("published_version_id"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("analytics_sites_tenant_domain_idx").on(t.tenantId, t.domain)],
);


/**
 * A saved analytics filter.
 *
 * `definition` is an operator-authored predicate tree, and it is the highest-
 * severity input in the analytics feature: it ends up inside a WHERE clause on
 * every report it is applied to. It is validated and compiled by
 * `services/analytics-segments.ts`, which binds every value and looks field
 * names up in a closed allowlist — the blob stored here is never trusted on
 * read, only re-parsed.
 */
export const analyticsSegments = sqliteTable(
  "analytics_segments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    /** Optional: scope the segment to one registered site. */
    siteId: text("site_id"),
    name: text("name").notNull(),
    definition: text("definition", { mode: "json" }).$type<unknown>(),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("analytics_segments_tenant_idx").on(t.tenantId, t.siteId)],
);


/**
 * The cookie-consent policy a site publishes — SQLite/D1 twin.
 *
 * See the pg definition for why `site_id` is the primary key, why
 * `undecided_behaviour` and `tracker_category` carry no default, and why the
 * wording is server-owned. Dialect differences only: `jsonb` becomes `text` in
 * json mode, `boolean` becomes an integer, timestamps are epoch-ms.
 */
export const consentPolicies = sqliteTable(
  "consent_policies",
  {
    /** The site this policy governs. PK — one policy per site, structurally. */
    siteId: text("site_id").primaryKey(),
    tenantId: text("tenant_id"),
    /** Which optional categories the banner offers. A LIST, not a switch.
     *  `none` never appears here — strictly-necessary is not a choice. */
    categoriesOffered: text("categories_offered", { mode: "json" }).$type<string[] | null>(),
    /** `"block" | "allow"`. No default — the operator must choose. */
    undecidedBehaviour: text("undecided_behaviour").notNull(),
    /** `"none" | "analytics"`. No default — the operator must choose. */
    trackerCategory: text("tracker_category").notNull(),
    /** Per-locale banner copy. Server-owned; the page never supplies it. */
    wording: text("wording", { mode: "json" }).$type<
      Record<string, Record<string, string>> | null
    >(),
    defaultLocale: text("default_locale").notNull().default("en"),
    /** The operator's own privacy/cookie policy, linked from the banner. */
    policyUrl: text("policy_url"),
    /** `"bottom" | "top" | "corner"`. */
    position: text("position").notNull().default("bottom"),
    /** Colours and radius, as a flat token map the banner inlines. */
    theme: text("theme", { mode: "json" }).$type<Record<string, string> | null>(),
    /** How long a visitor's decision stands before they are asked again. */
    cookieMaxAgeDays: integer("cookie_max_age_days").notNull().default(180),
    /** `"tracker" | "all" | "off"` — what GPC and Do Not Track govern.
     *  `tracker` (the default, and what every site does today) lets them stop
     *  backlex's own tag and nothing else; `all` widens them to deny every
     *  optional category, so the tag manager refuses third-party tags too;
     *  `off` reads neither. Defaulted, unlike `undecided_behaviour` and
     *  `tracker_category`, because here one answer IS safe: it is the
     *  behaviour already live, and the other switches off working pixels.
     *
     *  Deliberately NOT in the consent artifact — that is recompiled and
     *  re-hashed on every read, so adding a field to it would archive every
     *  recorded decision and re-ask every visitor on deploy. It rides the
     *  per-site container instead. */
    signalHandling: text("signal_handling").notNull().default("tracker"),
    /** Whether the banner is served at all. */
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    /** Content hash of the artifact this policy currently compiles to.
     *  DERIVED, not a pointer — see the pg twin for why there is no
     *  `published_version_id`. Nullable: the migration cannot hash existing
     *  rows, and nothing on the read path depends on it. */
    artifactHash: text("artifact_hash"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("consent_policies_tenant_idx").on(t.tenantId)],
);

/**
 * Every distinct artifact a site's consent policy has ever compiled to, so
 * "which version did they agree to" has an answer that cannot be edited
 * afterwards. Content-addressed rather than counter-versioned — consent has no
 * draft to publish, so there is no version number to roll back to, and
 * `(site_id, hash)` makes a repeated or reverted save a free no-op insert.
 * The full argument is on the pg twin.
 */
export const consentVersions = sqliteTable(
  "consent_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    siteId: text("site_id").notNull(),
    /** SHA-256 of the canonical artifact JSON. This is the ETag. */
    hash: text("hash").notNull(),
    /** The compiled artifact, exactly as the config route serves it. */
    snapshot: text("snapshot", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: ts("created_at"),
  },
  (t) => [uniqueIndex("consent_versions_site_hash_idx").on(t.siteId, t.hash)],
);

/**
 * A visitor's decision, and what it was a decision about. Append-only: no
 * `updated_at`, no update path in the service, and a change of mind is a new
 * row. `subject_id` is caller-supplied and is a correlator, not an identity;
 * the IP is stored as a SALTED hash or not at all; `hash_grade` records whether
 * the artifact the visitor named still resolves. The full argument is on the pg
 * twin.
 */
export const consentRecords = sqliteTable(
  "consent_records",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    siteId: text("site_id").notNull(),
    subjectId: text("subject_id").notNull(),
    policyHash: text("policy_hash"),
    versionId: text("version_id"),
    /** `current` | `archived` | `unresolved`. */
    hashGrade: text("hash_grade").notNull(),
    /** `granted` | `denied` | `partial`, derived server-side from `grants`. */
    decision: text("decision").notNull(),
    grants: text("grants", { mode: "json" }).$type<Record<string, boolean>>().notNull(),
    /** `banner` | `preferences` | `api` | `signal`. */
    source: text("source").notNull(),
    locale: text("locale"),
    country: text("country"),
    /** Salted SHA-256 of the request IP — never the address. */
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("consent_records_site_subject_idx").on(t.siteId, t.subjectId, t.createdAt),
    index("consent_records_tenant_subject_idx").on(t.tenantId, t.subjectId),
    index("consent_records_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("consent_records_created_idx").on(t.createdAt),
  ],
);

/**
 * ── Tag manager ───────────────────────────────────────────────────────────
 *
 * A GTM-style container, hung off the site that already carries the tag. The
 * site IS the container: it already names one domain, the snippet is already
 * installed against it, and a second id on the same page would only be a
 * second thing to get wrong.
 *
 * The three `tag_*` tables below are DRAFT state — what an operator is
 * editing. None of it is served to a visitor. `tag_versions` holds the
 * immutable compiled artifact that IS served, and
 * `analytics_sites.published_version_id` points at the one currently live.
 * That is the same shape as `schema_snapshots` + `schema_branches`: an
 * append-only history plus a mutable pointer, so a rollback is a pointer move
 * rather than a reconstruction of what used to be true.
 *
 * Everything an operator authors here is re-validated on READ and never
 * trusted from storage — the same rule as `analytics_segments.definition`,
 * for a sharper reason: this blob ends up as input to JavaScript running on
 * somebody else's website.
 */
export const tagVariables = sqliteTable(
  "tag_variables",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    siteId: text("site_id").notNull(),
    /** Referenced from a tag parameter as `{{key}}`. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** `constant` | `query_param` | `cookie` | `data_layer` | `js_expression`.
     *  The last one is operator-authored code and rides the same
     *  `allow_custom_code` gate as a custom-HTML tag, not a looser one. */
    kind: text("kind").notNull().default("constant"),
    config: text("config", { mode: "json" }).$type<unknown>(),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("tag_variables_site_idx").on(t.siteId),
    uniqueIndex("tag_variables_site_key_idx").on(t.siteId, t.key),
  ],
);

export const tagTriggers = sqliteTable(
  "tag_triggers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    siteId: text("site_id").notNull(),
    name: text("name").notNull(),
    /** Closed vocabulary — `services/tag-conditions.ts::TRIGGER_TYPES`. */
    type: text("type").notNull(),
    /** Type-specific settings: a CSS selector, a scroll threshold, a timer
     *  interval, a custom event name. Checked against the type on write and
     *  again on read. */
    config: text("config", { mode: "json" }).$type<unknown>(),
    /** Optional predicate tree narrowing when the trigger fires. Same node
     *  grammar as an analytics segment; evaluated in the browser rather than
     *  compiled to SQL. */
    condition: text("condition", { mode: "json" }).$type<unknown>(),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("tag_triggers_site_idx").on(t.siteId)],
);

export const tagDefinitions = sqliteTable(
  "tag_definitions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    siteId: text("site_id").notNull(),
    name: text("name").notNull(),
    /** `template` | `custom_html` | `custom_js` | `image_pixel` |
     *  `backlex_event`. */
    kind: text("kind").notNull().default("template"),
    /** Registry id when `kind = 'template'` — `services/tag-templates.ts`. */
    templateId: text("template_id"),
    /** Operator-supplied parameters, validated against the template's own
     *  schema. For a custom tag this is where the code lives. */
    params: text("params", { mode: "json" }).$type<unknown>(),
    /** Trigger ids that fire this tag, and ids that suppress it. Arrays
     *  rather than a join table because nothing ever groups or filters by
     *  them, and the published artifact is one JSON document either way. */
    triggerIds: text("trigger_ids", { mode: "json" }).$type<string[] | null>(),
    blockingTriggerIds: text("blocking_trigger_ids", { mode: "json" }).$type<
      string[] | null
    >(),
    /** `none` | `functional` | `analytics` | `marketing`, gated against the
     *  signals the tracker already reads. Defaults to the strictest useful
     *  answer: most tags an operator adds here are advertising tags. */
    consentCategory: text("consent_category").notNull().default("marketing"),
    /** `always` | `once_per_page` | `once_per_visitor_day`. */
    fireRule: text("fire_rule").notNull().default("always"),
    /** Higher fires first within one trigger. */
    priority: integer("priority").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("tag_definitions_site_idx").on(t.siteId)],
);

export const tagVersions = sqliteTable(
  "tag_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    siteId: text("site_id").notNull(),
    /** Monotonic per site — the number the admin shows and rolls back to. */
    version: integer("version").notNull(),
    note: text("note"),
    /** The COMPILED artifact, exactly as served. Storing the compiled form
     *  instead of recompiling on read is what keeps serving to one query, and
     *  what makes a rollback reproduce byte-for-byte what was live. */
    snapshot: text("snapshot", { mode: "json" }).$type<unknown>().notNull(),
    /** Content hash of `snapshot` — this is the ETag. */
    hash: text("hash").notNull(),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
  },
  (t) => [uniqueIndex("tag_versions_site_version_idx").on(t.siteId, t.version)],
);


/**
 * Crash-reporting group — the deduplicated identity of one bug. Occurrences
 * fold into a group by `fingerprint` (a hash of the error type, its normalized
 * message and the top stack frames) so a crash that fires 10k times is one row
 * to triage, not 10k.
 *
 * `id` is derived deterministically from `(tenantId, fingerprint)` rather than
 * random, which lets ingest upsert with a single atomic
 * `onConflictDoUpdate(id)` — no check-then-insert race, and no reliance on a
 * unique index over the nullable `tenant_id` (SQLite treats NULLs as distinct,
 * so such an index would not dedupe the default workspace).
 */
export const errorGroups = sqliteTable(
  "error_groups",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    fingerprint: text("fingerprint").notNull(),
    type: text("type").notNull().default("Error"),
    message: text("message").notNull(),
    /** Top in-app stack frame (`file:line`) — the location the list shows. */
    culprit: text("culprit"),
    /** `error` / `warning` / `fatal`. */
    level: text("level").notNull().default("error"),
    /** `browser` / `node` / `ios` / `android`, or any free-form client label. */
    platform: text("platform"),
    /** Release the group was LAST seen on (regressions move it forward). */
    release: text("release"),
    /** `open` / `resolved` / `ignored`. */
    status: text("status").notNull().default("open"),
    /** Denormalized occurrence counter — incremented by ingest so the list
     *  never has to COUNT over `error_events`, which retention prunes. */
    events: integer("events").notNull().default(0),
    firstSeen: integer("first_seen", { mode: "timestamp_ms" }).notNull(),
    lastSeen: integer("last_seen", { mode: "timestamp_ms" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    resolvedBy: text("resolved_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("error_groups_tenant_last_seen_idx").on(t.tenantId, t.lastSeen),
    index("error_groups_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

/**
 * One captured occurrence of an error. Kept for the stack trace + context of
 * recent samples; pruned on its own retention clock while `error_groups` (and
 * its `events` counter) survive, so an old bug keeps its history even after
 * its individual payloads age out.
 */
export const errorEvents = sqliteTable(
  "error_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    groupId: text("group_id").notNull(),
    type: text("type").notNull().default("Error"),
    message: text("message").notNull(),
    stack: text("stack"),
    level: text("level").notNull().default("error"),
    platform: text("platform"),
    release: text("release"),
    url: text("url"),
    userId: text("user_id"),
    distinctId: text("distinct_id"),
    sessionId: text("session_id"),
    /** Breadcrumbs, tags, extra and user-agent — whatever the SDK attached. */
    context: text("context", { mode: "json" }).$type<Record<string, unknown> | null>(),
    ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("error_events_group_ts_idx").on(t.groupId, t.ts),
    index("error_events_tenant_ts_idx").on(t.tenantId, t.ts),
  ],
);

/**
 * In-flight OAuth authorization-code flows for workspace integrations.
 *
 * One short-lived row per "connect" click. It exists so the callback can prove
 * the code it was handed belongs to a flow this instance started: the `state`
 * value is never stored, only its SHA-256, so a database read cannot be used to
 * finish someone else's pending authorization. Rows are deleted on use — a
 * replayed callback finds nothing and is refused, which is also why "already
 * used" and "never existed" are deliberately indistinguishable.
 *
 * Mirror of the PG table.
 */
export const integrationOauthStates = sqliteTable(
  "integration_oauth_states",
  {
    /** SHA-256 (hex) of the state parameter. The raw value lives only in the URL. */
    id: text("id").primaryKey(),
    integrationId: text("integration_id").notNull(),
    /** Never null: an instance-wide OAuth connection is not a thing we offer. */
    tenantId: text("tenant_id").notNull(),
    /** The admin who started the flow; the same one has to finish it. */
    userId: text("user_id").notNull(),
    /** PKCE code_verifier, null for providers we do not send PKCE to. */
    codeVerifier: text("code_verifier"),
    /** Pinned at authorize time and replayed at exchange, as the RFC requires. */
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("integration_oauth_states_integration_idx").on(t.integrationId),
    index("integration_oauth_states_expires_idx").on(t.expiresAt),
  ],
);

/**
 * One scheduled pull from a source integration into a collection.
 *
 * Separate from `integrations` because one connection legitimately feeds
 * several collections — an Airtable base has many tables, a spreadsheet many
 * sheets. Pinning it to the connection row would cap a workspace at one sync
 * per provider, which is a limit we would have to undo immediately.
 *
 * `cursor` is the provider's own resume token. It is written back into the next
 * request, so it is treated as untrusted on the way out, not just on the way
 * in. Mirror of the PG table.
 */
/**
 * One run of one task against one row — the engine's once-only guard.
 *
 * A task books a shipment: it has a real effect at the far end that a retry
 * must not repeat. The queue retries on backoff and an operator can click twice,
 * so "did this already happen" cannot live in the provider's answer. It lives
 * here, in a row the unique index makes it impossible to write twice.
 *
 * The outputs are kept alongside, so a re-invocation of an already-succeeded
 * task hands back what the first one produced rather than either failing or
 * booking a second shipment. That is also what makes this an operational record
 * in its own right: which orders have a label, and which are still waiting.
 */
export const integrationTaskRuns = sqliteTable(
  "integration_task_runs",
  {
    id: text("id").primaryKey(),
    /** Never null: a task writes into a workspace's collection. */
    tenantId: text("tenant_id").notNull(),
    integrationId: text("integration_id").notNull(),
    /** Provider-declared task id, e.g. `create_shipment`. */
    task: text("task").notNull(),
    /** Collection slug and primary key of the row acted on. */
    collection: text("collection").notNull(),
    itemId: text("item_id").notNull(),
    /** `succeeded` rows are the ones that make a re-run a no-op. */
    status: text("status").notNull(),
    /** Declared output key → value, as the provider returned them. */
    outputs: text("outputs", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    /** Storage key of the artifact this run produced, when it produced one. */
    artifactKey: text("artifact_key"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(1),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    // The guard itself. A second run for the same row cannot be inserted, so
    // two concurrent callers cannot both book a shipment.
    uniqueIndex("integration_task_runs_once_idx").on(
      t.tenantId,
      t.integrationId,
      t.task,
      t.collection,
      t.itemId,
    ),
    index("integration_task_runs_tenant_idx").on(t.tenantId),
    index("integration_task_runs_item_idx").on(t.collection, t.itemId),
  ],
);

export const integrationSyncs = sqliteTable(
  "integration_syncs",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id").notNull(),
    /** Never null: an instance-wide sync would write another tenant's rows. */
    tenantId: text("tenant_id").notNull(),
    /** Collection slug the rows land in (pull) or come from (push). */
    collection: text("collection").notNull(),
    /** `pull` draws rows in from a source; `push` mirrors them out to a
     *  destination. One table, because the schedule, the breaker, the cursor
     *  and the field mapping are identical — only the direction of travel
     *  differs, and splitting them would duplicate all four. */
    direction: text("direction").notNull().default("pull"),
    /** Which spreadsheet / base / database — per-sync, never secret. */
    settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    /** Field mapping. Read in the direction of travel: `external → field` on a
     *  pull, `field → external column` on a push. Unmapped keys are dropped. */
    mapping: text("mapping", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    /**
     * Where a source record's CHILD rows land. Pull only.
     *
     * A marketplace order is a header plus its lines, and a flat mapping can
     * only describe the header — the lines would have to be flattened into
     * numbered columns or dropped. Keyed by the group name the provider hands
     * back on `SourceRecord.children`, so one order can fan out to more than
     * one child collection.
     */
    childMappings: text("child_mappings", { mode: "json" })
      .$type<Record<string, { collection: string; parentField: string; mapping: Record<string, string> }>>()
      .notNull()
      .default({}),
    /** How often the scheduler runs it. 0 = manual only. */
    intervalMinutes: integer("interval_minutes").notNull().default(60),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Provider resume token; null starts from the beginning. */
    cursor: text("cursor"),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
    /** Rows written by the most recent completed run. */
    lastRowCount: integer("last_row_count").notNull().default(0),
    lastError: text("last_error"),
    /** Drives the same auto-disable breaker the delivery path uses. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    disabledReason: text("disabled_reason"),
    /**
     * The routing key in the URL a provider posts deliveries to.
     *
     * Null until an operator turns the endpoint on. It lives on the SYNC rather
     * than in a table of its own because a delivery has to land exactly where a
     * pull would: same collection, same mapping, and above all the same id
     * namespace, which is derived from this row's id. A webhook with its own row
     * would mint `trendyol_<hookid>_<pkg>` beside the poll's
     * `trendyol_<syncid>_<pkg>` and every order would exist twice.
     */
    webhookToken: text("webhook_token"),
    /**
     * The shared secret this endpoint expects, encrypted at rest.
     *
     * Per subscription, not per connection: it is handed to a third party, so
     * rotating it must be able to invalidate one endpoint without touching the
     * credentials the same connection pulls orders with.
     */
    webhookSecret: text("webhook_secret"),
    /** Event keys this endpoint accepts. Empty means every event the provider
     *  declares — the same reading the outbound delivery filter uses. */
    webhookEvents: text("webhook_events", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** The provider's own id for the registration we created, so it can be
     *  removed again. Null when the operator registered the URL by hand. */
    webhookExternalId: text("webhook_external_id"),
    /**
     * The collection field a `patch` delivery is matched on.
     *
     * A carrier's tracking update is ABOUT a row that already exists — one a
     * person and a booking task built — so the delivery names a shipment id and
     * this says which column holds it. Unused by an `upsert` landing, whose
     * records are addressed by the namespaced id instead.
     */
    matchField: text("match_field"),
    /**
     * The product column naming the local category a listing is mapped from.
     *
     * `listing` direction only. The mapping itself lives one row per local
     * value in `integration_listing_maps`; this says which column those values
     * are read from, because a workspace's idea of a category is a column of
     * its own choosing — `category`, `product_type`, a relation's label.
     */
    categoryField: text("category_field"),
    /**
     * Where a verdict lands: provider output key → collection field.
     *
     * `listing` direction only, and it is a SECOND map because it travels the
     * other way. `mapping` says which column feeds a listing field; this says
     * which column receives what the marketplace answered. Conflating them
     * would mean a rejection reason could only be written to a column that also
     * fed the request.
     */
    outputsMapping: text("outputs_mapping", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("integration_syncs_tenant_idx").on(t.tenantId),
    index("integration_syncs_integration_idx").on(t.integrationId),
    // The scheduler sweeps "enabled and due", so it reads both together.
    index("integration_syncs_due_idx").on(t.enabled, t.lastRunAt),
    // The delivery path resolves a token on every inbound request, and the
    // uniqueness is what makes one token mean one subscription. Partial, so the
    // many syncs with no endpoint do not collide on null.
    uniqueIndex("integration_syncs_webhook_token_idx")
      .on(t.webhookToken)
      .where(sql`${t.webhookToken} IS NOT NULL`),
  ],
);

/**
 * One inbound webhook delivery, and what became of it.
 *
 * The log an operator reads when a marketplace insists it sent something. It is
 * also the replay guard: `delivery_id` under a unique index means a provider's
 * retry is recognised as the delivery it already applied rather than applied a
 * second time. Both providers that ship with this retry — EasyPost six times,
 * Trendyol every five minutes until it succeeds — so a retry is the normal case,
 * not an edge one.
 *
 * Rows here are what the sync's webhook health is derived from, which is why the
 * sync row grew no `webhook_last_*` columns: two places recording the same fact
 * is how they come to disagree.
 */
export const integrationWebhookDeliveries = sqliteTable(
  "integration_webhook_deliveries",
  {
    id: text("id").primaryKey(),
    /** Never null: a delivery writes into a workspace's collection. */
    tenantId: text("tenant_id").notNull(),
    /** The subscription that received it — a row in `integration_syncs`. */
    syncId: text("sync_id").notNull(),
    integrationId: text("integration_id").notNull(),
    /** The provider's event key, as parsed. */
    event: text("event").notNull(),
    /**
     * The provider's own id for this delivery, or a digest of the body when it
     * sends none. Never null, because a guard that is sometimes absent is not a
     * guard — see the service for what the digest costs.
     */
    deliveryId: text("delivery_id").notNull(),
    /** `applied` | `ignored` | `filtered` | `duplicate` | `rejected` | `failed`. */
    status: text("status").notNull(),
    /** Rows written, so "it arrived and changed nothing" is visible. */
    rowsWritten: integer("rows_written").notNull().default(0),
    error: text("error"),
    createdAt: ts("created_at"),
  },
  (t) => [
    // The guard. Scoped to the subscription rather than global: two workspaces
    // watching two sellers may legitimately be sent the same provider event id.
    uniqueIndex("integration_webhook_deliveries_once_idx").on(t.syncId, t.deliveryId),
    index("integration_webhook_deliveries_tenant_idx").on(t.tenantId),
    // What the admin panel reads: this subscription's deliveries, newest first.
    index("integration_webhook_deliveries_sync_idx").on(t.syncId, t.createdAt),
  ],
);

/**
 * How one of a workspace's own categories maps onto a marketplace's.
 *
 * A table rather than a blob on the sync row, and the reason is concurrency
 * rather than size: an operator edits ONE category at a time, and a JSON map of
 * five hundred would make every such edit a read-modify-write of the whole
 * thing — two people mapping two categories would each silently discard the
 * other's. A row per local value makes the edit addressable.
 *
 * `attributes` holds the operator's answers to what the chosen category demands:
 * attribute id → a fixed value id, free text, or the product column to read it
 * from. Its shape is the provider's, not ours, which is why it is JSON and not
 * columns — the questions differ per category and there are ~24 of them.
 *
 * Mirror of the PG table.
 */
export const integrationListingMaps = sqliteTable(
  "integration_listing_maps",
  {
    id: text("id").primaryKey(),
    /** Never null: a mapping belongs to one workspace's collection. */
    tenantId: text("tenant_id").notNull(),
    /** The listing sync this mapping configures — a row in `integration_syncs`. */
    syncId: text("sync_id").notNull(),
    /** The value found in the sync's `category_field`, verbatim. */
    localValue: text("local_value").notNull(),
    /** The marketplace's own leaf category id. */
    categoryId: text("category_id").notNull(),
    /** Attribute id → `{valueId}` | `{custom}` | `{field}`. */
    attributes: text("attributes", { mode: "json" })
      .$type<Record<string, { valueId?: string; custom?: string; field?: string }>>()
      .notNull()
      .default({}),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    // One answer per local category. A second row for the same value would make
    // "which category does this product go in" depend on row order.
    uniqueIndex("integration_listing_maps_value_idx").on(t.syncId, t.localValue),
    index("integration_listing_maps_tenant_idx").on(t.tenantId),
  ],
);

/**
 * One batch of products handed to a marketplace, and what became of it.
 *
 * Every marketplace here answers a create with a queue ticket rather than a
 * result, so this row is the only thing that knows a publish is outstanding. It
 * is also the operator's record of what was sent and why it was refused — the
 * same argument `integration_webhook_deliveries` makes, and the reason neither
 * grew a `last_*` column on the sync.
 *
 * `sent` is what makes a verdict addressable: the marketplace echoes one of our
 * own columns back (a barcode, a stock code) and never our request id, so this
 * maps that echo to the row that asked. Without it a verdict has nowhere to go.
 *
 * Mirror of the PG table.
 */
export const integrationListingBatches = sqliteTable(
  "integration_listing_batches",
  {
    id: text("id").primaryKey(),
    /** Never null: a verdict writes into a workspace's collection. */
    tenantId: text("tenant_id").notNull(),
    syncId: text("sync_id").notNull(),
    integrationId: text("integration_id").notNull(),
    /** The provider's own ticket. Empty when nothing was queued. */
    batchId: text("batch_id").notNull(),
    /** `open` while anything is pending; then `settled` or `failed`. */
    status: text("status").notNull().default("open"),
    /**
     * Provider's echoed reference → the row it belongs to, and where that row
     * lives.
     *
     * The collection travels WITH the batch rather than being re-derived from
     * the sync when the verdict arrives. A verdict lands hours later, and an
     * operator who repointed the sync's variant collection in between would
     * otherwise have the answers written into whichever collection the sync
     * names NOW — silently, into rows that happen to share an id.
     */
    sent: text("sent", { mode: "json" })
      .$type<Record<string, { rowId: string; collection: string }>>()
      .notNull()
      .default({}),
    /** How many units this batch is still waiting on. */
    pendingCount: integer("pending_count").notNull().default(0),
    error: text("error"),
    createdAt: ts("created_at"),
    /** Set when nothing is pending. The sweep reads `status`, not this. */
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    // A provider's ticket is unique within the sync that asked for it, which is
    // what stops a retried publish opening a second batch for the same work.
    uniqueIndex("integration_listing_batches_ticket_idx").on(t.syncId, t.batchId),
    // The sweep's whole query: batches still owed a verdict, oldest first. It
    // runs independently of any sync's schedule, because a manually published
    // batch is owed an answer exactly as much as a scheduled one.
    index("integration_listing_batches_open_idx").on(t.status, t.createdAt),
    index("integration_listing_batches_tenant_idx").on(t.tenantId),
  ],
);

/**
 * One data-subject erasure request (GDPR Art. 17 and friends).
 *
 * Two-step by design: a request is PREVIEWED first, producing a plan of what
 * would be touched, and only then executed. Erasure is irreversible and spans
 * surfaces an operator cannot see from one screen, so "run it and find out" is
 * not an acceptable interface.
 *
 * The row deliberately does NOT store the subject's email or id. An audit trail
 * that records "we erased alice@example.com" re-creates the very data the
 * request existed to remove, and it outlives every row it deleted. What is kept
 * is a salted hash — enough to prove two requests concerned the same person and
 * to find this record again from a fresh lookup, and useless as a source of the
 * address itself. `reference` is the operator's own ticket id, which is theirs
 * to keep clean.
 *
 * Mirror of the PG table.
 */
export const erasureRequests = sqliteTable(
  "erasure_requests",
  {
    id: text("id").primaryKey(),
    /** Never null: erasure is scoped to one workspace's data. */
    tenantId: text("tenant_id").notNull(),
    /** `app_user` (resolved from the workspace's end-user table) or `email`. */
    subjectType: text("subject_type").notNull(),
    /** SHA-256 of `tenantId + "\0" + normalized subject`. Never the subject. */
    subjectHash: text("subject_hash").notNull(),
    /** `anonymize` keeps rows with identifying fields scrubbed — often the only
     *  lawful option, since an invoice usually cannot be deleted. `delete`
     *  removes them. */
    mode: text("mode").notNull(),
    /** `pending` → `previewed` → `running` → `completed` / `failed`. */
    status: text("status").notNull().default("pending"),
    /** What the preview found: per-surface counts. Counts only, never values. */
    plan: text("plan", { mode: "json" }).$type<Record<string, unknown> | null>(),
    /** What the run actually did, in the same shape as `plan`. */
    report: text("report", { mode: "json" }).$type<Record<string, unknown> | null>(),
    error: text("error"),
    /** The operator's own ticket / case id. Free text, and theirs to manage. */
    reference: text("reference"),
    /** Admin who filed it — an erasure needs an accountable requester. */
    requestedBy: text("requested_by"),
    previewedAt: integer("previewed_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("erasure_requests_tenant_idx").on(t.tenantId),
    // "Has this person asked before?" is a lookup by hash within a workspace.
    index("erasure_requests_subject_idx").on(t.tenantId, t.subjectHash),
  ],
);

/**
 * One row per (schedule flow, subject row, fire instant) that has been
 * dispatched. The ledger IS the exactly-once guarantee — see the pg twin for
 * the reasoning in full.
 */
export const flowScheduleFires = sqliteTable(
  "flow_schedule_fires",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    flowId: text("flow_id").notNull(),
    /** Primary key of the row the run was about, as text — a collection's PK
     *  may be uuid, text or integer, and the ledger only ever compares it. */
    rowId: text("row_id").notNull(),
    /** The computed instant, not the instant we noticed it. Putting the
     *  COMPUTED time in the key is what lets an edited due date fire again
     *  while an untouched one never does. */
    fireAt: integer("fire_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("flow_schedule_fires_once_idx").on(t.flowId, t.rowId, t.fireAt),
    index("flow_schedule_fires_prune_idx").on(t.fireAt),
  ],
);

/**
 * Sequence counters — one row per (tenant, collection, field, period), holding
 * the last number that field's series issued.
 *
 * SQLite/D1 twin of the pg table, where the reasoning is written out in full.
 * Two things differ from the tables around this one and both are deliberate:
 * `tenant_id` and `scope` are NOT NULL with `''` standing in for "none",
 * because SQL treats NULLs in a unique index as distinct — a nullable column
 * here would let a second counter row exist alongside the first, and the upsert
 * that allocates would stop matching and hand every row the same number.
 */
export const sequences = sqliteTable(
  "sequences",
  {
    id: text("id").primaryKey(),
    /** `''` when the install is not tenant-scoped — never NULL. */
    tenantId: text("tenant_id").notNull().default(""),
    collection: text("collection").notNull(),
    field: text("field").notNull(),
    /** `''` for `reset: never`, else the calendar period (`2026`, `2026-08`). */
    scope: text("scope").notNull().default(""),
    /** The last counter handed out. The next allocation returns this + n. */
    lastValue: integer("last_value").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("sequences_key_idx").on(t.tenantId, t.collection, t.field, t.scope),
  ],
);

/**
 * A broadcast channel rule — see packages/db/src/pg/schema.ts for the full
 * rationale (why free-form channels needed a gate at all, why the pattern
 * grammar is closed, and why `subscribe`/`publish` are whole JSON objects
 * rather than a roles column beside a condition column). SQLite twin: booleans
 * are 0/1, timestamps epoch-ms, JSON is text.
 */
export const broadcastChannels = sqliteTable(
  "broadcast_channels",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    pattern: text("pattern").notNull(),
    subscribe: text("subscribe").notNull(),
    publish: text("publish").notNull(),
    presence: integer("presence", { mode: "boolean" }).notNull().default(false),
    replay: integer("replay", { mode: "boolean" }).notNull().default(false),
    retentionHours: integer("retention_hours").notNull().default(24),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("broadcast_channels_pattern_idx").on(t.tenantId, t.pattern),
    index("broadcast_channels_tenant_idx").on(t.tenantId),
  ],
);

/**
 * A retained broadcast message — SQLite twin. `day` is a `YYYYMMDD` integer so
 * the prune is one ranged DELETE on both dialects; the read cursor is the
 * keyset `(created_at, id)`, because two messages can share a millisecond.
 */
export const broadcastMessages = sqliteTable(
  "broadcast_messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    day: integer("day").notNull(),
    event: text("event").notNull(),
    payload: text("payload"),
    senderId: text("sender_id"),
    senderName: text("sender_name"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("broadcast_messages_read_idx").on(t.tenantId, t.channel, t.createdAt, t.id),
    index("broadcast_messages_day_idx").on(t.day),
  ],
);

/**
 * A credential for the S3-compatible endpoint — see packages/db/src/pg/schema.ts
 * for why the secret is stored (encrypted) rather than hashed: SigV4 needs the
 * server to derive the same signing key the client did, which a digest cannot
 * do. SQLite twin: booleans are 0/1, timestamps epoch-ms.
 */
export const s3Credentials = sqliteTable(
  "s3_credentials",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    accessKeyId: text("access_key_id").notNull(),
    secretKey: text("secret_key").notNull(),
    prefix: text("prefix"),
    readOnly: integer("read_only", { mode: "boolean" }).notNull().default(false),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("s3_credentials_akid_idx").on(t.accessKeyId),
    index("s3_credentials_tenant_idx").on(t.tenantId),
  ],
);

/**
 * An impersonation — see packages/db/src/pg/schema.ts for why this is a row
 * that every impersonated request re-reads rather than a self-contained token:
 * instant revocation, and a record that exists whether or not the operator
 * cooperates. SQLite twin: booleans are 0/1, timestamps epoch-ms.
 */
export const impersonations = sqliteTable(
  "impersonations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull(),
    actorEmail: text("actor_email"),
    subjectUserId: text("subject_user_id").notNull(),
    subjectEmail: text("subject_email"),
    reason: text("reason").notNull(),
    readOnly: integer("read_only", { mode: "boolean" }).notNull().default(true),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    endedBy: text("ended_by"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("impersonations_tenant_idx").on(t.tenantId, t.createdAt),
    index("impersonations_subject_idx").on(t.subjectUserId),
  ],
);

/**
 * A JWT signing key and its state — see packages/db/src/pg/schema.ts for the
 * four states, why `standby` exists (a verifier's JWKS cache means a key has to
 * be visible before it signs), and why the private half is encrypted rather
 * than hashed. SQLite twin: timestamps epoch-ms.
 */
export const signingKeys = sqliteTable(
  "signing_keys",
  {
    id: text("id").primaryKey(),
    kid: text("kid").notNull(),
    alg: text("alg").notNull(),
    privateKey: text("private_key").notNull(),
    publicKey: text("public_key").notNull(),
    status: text("status").notNull().default("standby"),
    note: text("note"),
    createdAt: ts("created_at"),
    activatedAt: integer("activated_at", { mode: "timestamp_ms" }),
    retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("signing_keys_kid_idx").on(t.kid),
    index("signing_keys_status_idx").on(t.status),
  ],
);

/**
 * A CDC sink — see packages/db/src/pg/schema.ts for why `cursor` advances only
 * after a delivery is acknowledged (at-least-once, never at-most-once).
 * SQLite twin: booleans are 0/1, timestamps epoch-ms, JSON is text.
 */
export const cdcSinks = sqliteTable(
  "cdc_sinks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    collection: text("collection").notNull(),
    destination: text("destination").notNull(),
    config: text("config").notNull(),
    shape: text("shape"),
    fields: text("fields"),
    batchSize: integer("batch_size").notNull().default(100),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    cursor: text("cursor"),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    disabledReason: text("disabled_reason"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("cdc_sinks_tenant_idx").on(t.tenantId),
    index("cdc_sinks_enabled_idx").on(t.enabled),
  ],
);
