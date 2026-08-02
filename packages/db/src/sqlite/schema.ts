import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
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
    maxSteps: integer("max_steps").notNull().default(8),
    memory: integer("memory", { mode: "boolean" }).notNull().default(false),
    /** `thread` (default) | `agent` — how far distilled semantic facts reach.
     *  See the pg/schema.ts twin for the full contract and the privacy note. */
    memoryScope: text("memory_scope").notNull().default("thread"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
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
    createdAt: ts("created_at"),
  },
  (t) => [
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
    /** Optional collection each booking is MIRRORED into, so the workspace owns
     *  the row in its own shape and every collection surface (permissions,
     *  flows, realtime, exports) applies to it. The ledger here stays the
     *  source of truth for the slot — see the migration for why. */
    mirrorCollection: text("mirror_collection"),
    /** `{ start, end, name, email, phone, status, resource }` — booking field →
     *  collection column. Absent keys are simply not written. */
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
    /** Where the mirrored row landed, when the resource asked for one. */
    mirrorCollection: text("mirror_collection"),
    mirrorItemId: text("mirror_item_id"),
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

export const authConfig = sqliteTable(
  "auth_config",
  {
    tenantId: text("tenant_id").primaryKey(),
    providers: text("providers", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    policy: text("policy", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    sessionLifetime: text("session_lifetime").notNull().default("30d"),
    redirectUrls: text("redirect_urls", { mode: "json" }).$type<string[]>().notNull().default([]),
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
    referrer: text("referrer"),
    /** `web` / `ios` / `android` / `server`, or any free-form client label. */
    source: text("source"),
    /** App or build version, so a metric shift can be tied to a release. */
    release: text("release"),
    country: text("country"),
    /** Event time. Client-supplied (offline queues replay late) but clamped
     *  server-side so a skewed clock can't park rows in the far future. */
    ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
    /** UTC calendar day of `ts`, `YYYY-MM-DD`. Denormalized so funnel and
     *  retention cohorts group without dialect-specific date math — the same
     *  trick `usage_counters.day` uses. */
    day: text("day").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("analytics_events_tenant_ts_idx").on(t.tenantId, t.ts),
    index("analytics_events_tenant_name_ts_idx").on(t.tenantId, t.name, t.ts),
    index("analytics_events_tenant_distinct_idx").on(t.tenantId, t.distinctId, t.ts),
    index("analytics_events_tenant_day_idx").on(t.tenantId, t.day),
  ],
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
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("integration_syncs_tenant_idx").on(t.tenantId),
    index("integration_syncs_integration_idx").on(t.integrationId),
    // The scheduler sweeps "enabled and due", so it reads both together.
    index("integration_syncs_due_idx").on(t.enabled, t.lastRunAt),
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
