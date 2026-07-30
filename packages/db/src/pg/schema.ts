import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  bigint,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";

/**
 * pgvector custom type. The Postgres extension `vector` must be enabled:
 *   CREATE EXTENSION IF NOT EXISTS vector;
 */
export const vector = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${dimensions})`,
    toDriver: (value: number[]) => `[${value.join(",")}]`,
    fromDriver: (value: string) =>
      value.replace(/^\[|\]$/g, "").split(",").map(Number),
  })(name);

export const tenants = pgTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    /** url-safe handle, unique. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    project: text("project").notNull().default("default"),
    branch: text("branch").notNull().default("main"),
    env: text("env").notNull().default("development"),
    /** Optional UI mark/color for sidebar tile. */
    mark: text("mark"),
    color: text("color"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tenants_slug_idx").on(t.slug)],
);

/** Per-user membership in a tenant with a role at the workspace level. */
export const tenantMembers = pgTable(
  "tenant_members",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    /** Email — populated for invited (un-accepted) members. */
    email: text("email").notNull(),
    /** Workspace role: owner | admin | editor | member. */
    role: text("role").notNull().default("member"),
    /** active | invited | suspended. */
    status: text("status").notNull().default("active"),
    invitedBy: text("invited_by"),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    /** One-time invite token; null after accept. */
    inviteToken: text("invite_token"),
    inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
    /** Touched by tenantMiddleware on every authenticated request — drives
     *  Members panel "last active" without needing a separate sessions join. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tenant_members_tenant_email_idx").on(t.tenantId, t.email),
    index("tenant_members_user_idx").on(t.userId),
    index("tenant_members_invite_token_idx").on(t.inviteToken),
  ],
);

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    name: text("name"),
    image: text("image"),
    /** Preferred UI locale (BCP-47, e.g. `tr`, `en-US`). NULL = inherit the
     *  workspace default (`app_settings.i18nDefaultLocale`). */
    locale: text("locale"),
    /** Preferred IANA time zone (e.g. `Europe/Istanbul`). NULL = inherit the
     *  workspace default (`app_settings.timezone`). */
    timezone: text("timezone"),
    /** Tenant the user landed on at login. UI may switch via cookie. */
    activeTenantId: text("active_tenant_id"),
    /** active | suspended. */
    status: text("status").notNull().default("active"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    /** Required by better-auth's `anonymous` plugin (AUTH_PLUGINS list).
     *  False for normal sign-ups; flips on anonymous-session promotion. */
    isAnonymous: boolean("is_anonymous").notNull().default(false),
    /** Set once the user has verified a TOTP authenticator (better-auth's
     *  two-factor plugin flips this on `verifyTotp`). Gates the OTP challenge
     *  on the next sign-in. */
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("sessions_token_idx").on(t.token),
    index("sessions_user_idx").on(t.userId),
    index("sessions_created_idx").on(t.createdAt),
  ],
);

export const accounts = pgTable("accounts", {
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
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const passkeys = pgTable(
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
    backedUp: boolean("backed_up").notNull().default(false),
    transports: text("transports"),
    // Authenticator AAGUID — optional field the passkey plugin reads back on
    // every auth; without the column better-auth errors mapping the row.
    aaguid: text("aaguid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("passkey_credential_idx").on(t.credentialID),
    index("passkey_user_idx").on(t.userId),
  ],
);

// Backs better-auth's two-factor (TOTP) plugin. One row per user that has
// enrolled an authenticator app: `secret` is the shared TOTP seed and
// `backupCodes` is the encrypted recovery-code bundle. The plugin also reads /
// writes `users.two_factor_enabled`.
export const twoFactors = pgTable(
  "twoFactor",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    // better-auth flips this to true once the user verifies a TOTP code; rows
    // created during enrolment start unverified.
    verified: boolean("verified").notNull().default(false),
  },
  (t) => [index("two_factor_user_idx").on(t.userId)],
);

/* ─────────────────────────────────────────────────────────────────────
 * MCP OAuth provider (better-auth `mcp` plugin, backed by its oidc-provider).
 *
 * These three tables let hosted MCP clients (claude.ai custom connectors and
 * other OAuth-only agents) connect to `/mcp` without a pasted `pak_` key:
 * dynamic client registration writes `oauth_applications`, the PKCE code flow
 * mints rows in `oauth_access_tokens`, and accepted consent screens land in
 * `oauth_consents`. Authorization codes live in the existing `verifications`
 * table (better-auth stores them as verification values — no extra table).
 *
 * Property keys MUST match the plugin's camelCase field names (same rule as
 * passkey `credentialID`); only the DB column names are snake_case.
 * ───────────────────────────────────────────────────────────────────── */

export const oauthApplications = pgTable(
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
    disabled: boolean("disabled").notNull().default(false),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("oauth_app_client_idx").on(t.clientId),
    index("oauth_app_user_idx").on(t.userId),
  ],
);

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: text("id").primaryKey(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }).notNull(),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }).notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthApplications.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("oauth_token_access_idx").on(t.accessToken),
    uniqueIndex("oauth_token_refresh_idx").on(t.refreshToken),
    index("oauth_token_client_idx").on(t.clientId),
    index("oauth_token_user_idx").on(t.userId),
  ],
);

export const oauthConsents = pgTable(
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
    consentGiven: boolean("consent_given").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("oauth_consent_client_idx").on(t.clientId),
    index("oauth_consent_user_idx").on(t.userId),
  ],
);

/* ─────────────────────────────────────────────────────────────────────
 * Workspace end-user auth pool ("auth as a service").
 *
 * These mirror the control-plane `users`/`sessions`/`accounts`/`verifications`
 * tables but back a *separate* identity pool: the end-users of an application
 * built on a workspace, who authenticate against that workspace's own auth
 * surface (`/api/t/<slug>/auth/*`) rather than the admin app. Every row is
 * scoped to one tenant; `(tenant_id, email)` is unique on `app_users`, so the
 * same email can exist in different workspaces as distinct accounts.
 *
 * Not wired into request handling yet — the per-tenant better-auth router that
 * uses them lands in a follow-up. That router must wrap better-auth's adapter
 * so its lookups stay inside one workspace (and so creates fill `tenant_id`).
 * ───────────────────────────────────────────────────────────────────── */

export const appUsers = pgTable(
  "app_users",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    name: text("name"),
    image: text("image"),
    /** active | suspended. */
    status: text("status").notNull().default("active"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    isAnonymous: boolean("is_anonymous").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("app_users_tenant_email_idx").on(t.tenantId, t.email),
    index("app_users_tenant_idx").on(t.tenantId),
  ],
);

export const appSessions = pgTable(
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
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** Org this session is currently acting in (`app_orgs.id`). Set by
     *  `POST /api/t/{slug}/orgs/{id}/set-active` and read back when the request
     *  carries no `X-Backlex-Org` header. No FK — `app_orgs` is declared below
     *  and a dropped org must degrade to "no active org", not cascade-delete
     *  the session. */
    activeOrgId: text("active_org_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("app_sessions_token_idx").on(t.token),
    index("app_sessions_user_idx").on(t.userId),
    index("app_sessions_tenant_idx").on(t.tenantId),
  ],
);

export const appAccounts = pgTable(
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
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("app_accounts_user_idx").on(t.userId),
    index("app_accounts_tenant_idx").on(t.tenantId),
  ],
);

export const appVerifications = pgTable(
  "app_verifications",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("app_verifications_tenant_idx").on(t.tenantId),
    index("app_verifications_identifier_idx").on(t.identifier),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description"),
    admin: boolean("admin").notNull().default(false),
    /** Role-scoped MCP tool allowlist — the same shape and matching rules as
     *  `api_keys.mcp_tools`, but attached to a role so the restriction follows
     *  the *person* rather than one key they happened to mint. `NULL` means
     *  this role has **no MCP policy**, which is not the same as "allow
     *  everything": policy-free roles are ignored when the effective allowlist
     *  is computed. (Every user holds the policy-free `authenticated` role, so
     *  the other reading would cancel every restriction ever configured.)
     *  Entries are exact tool ids (`collections.read`) or namespace globs
     *  (`collections.*`, `*`).
     *
     *  The effective list is the union across the roles that set one; the key's
     *  own allowlist then INTERSECTS it, so a key can only narrow what its
     *  owner's roles already allow. See `mcp/guards.ts::mergeGuards`. */
    mcpTools: jsonb("mcp_tools").$type<string[] | null>(),
    /** When true, members of this role cannot call any MCP write/destruct tool.
     *  Sticky: holding a second role does not lift it, and a read-only key
     *  applies on top. Mirrors `api_keys.mcp_read_only`. */
    mcpReadOnly: boolean("mcp_read_only").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("roles_tenant_name_idx").on(t.tenantId, t.name),
    index("roles_tenant_idx").on(t.tenantId),
  ],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_roles_pk").on(t.userId, t.roleId),
    index("user_roles_role_idx").on(t.roleId),
  ],
);

/** Role assignments for workspace end-users (the `app_users` pool). Parallel
 *  to `user_roles` but keyed by `app_users.id`. A role assigned here only
 *  matters within its own tenant; the permission resolver also drops any role
 *  flagged `admin` — app-users never get the workspace's admin bypass. */
export const appUserRoles = pgTable(
  "app_user_roles",
  {
    appUserId: text("app_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("app_user_roles_pk").on(t.appUserId, t.roleId),
    index("app_user_roles_role_idx").on(t.roleId),
  ],
);

/* ─────────────────────────────────────────────────────────────────────
 * App-plane organizations ("teams").
 *
 * A second grouping level *inside* one workspace: the tenant is the backlex
 * customer, an `app_orgs` row is one of THEIR customers — the company account
 * a set of end-users belong to. This is what every B2B SaaS built on backlex
 * used to hand-roll.
 *
 * Two independent role layers meet here:
 *   - `app_org_members.role` — the org-membership role (owner/admin/member).
 *     Governs who may rename the org, invite, or remove people. Fixed
 *     vocabulary, enforced in `services/app-orgs.ts`.
 *   - `app_org_member_roles` — workspace `roles` rows bound to a member
 *     *within one org*. The data-plane RBAC layer: a person can hold
 *     "Editor" in org A and nothing in org B. Merged into the effective role
 *     set by `loadRolesForUser` once an org is active.
 *
 * The permission DSL sees the result as `$org.id`, `$org.role` and
 * `$user.orgs` — see docs/app-organizations.md.
 * ───────────────────────────────────────────────────────────────────── */

export const appOrgs = pgTable(
  "app_orgs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** URL-safe handle, unique per workspace. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    image: text("image"),
    /** Free-form app-owned attributes (plan, billing ref, …). */
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    /** `app_users.id` of the end-user who created it; null for admin-created
     *  orgs. Deliberately no FK — deleting the creator must not delete the org. */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("app_orgs_tenant_slug_idx").on(t.tenantId, t.slug),
    index("app_orgs_tenant_idx").on(t.tenantId),
  ],
);

export const appOrgMembers = pgTable(
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
    /** owner | admin | member — see the block comment above. */
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("app_org_members_pk").on(t.orgId, t.appUserId),
    index("app_org_members_user_idx").on(t.appUserId),
    index("app_org_members_tenant_idx").on(t.tenantId),
  ],
);

/** Workspace roles bound to a member *within one org*. Parallel to
 *  `app_user_roles` (which is workspace-wide) but org-scoped, so the same
 *  person can carry different data-plane grants per org. */
export const appOrgMemberRoles = pgTable(
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("app_org_member_roles_pk").on(t.orgId, t.appUserId, t.roleId),
    index("app_org_member_roles_role_idx").on(t.roleId),
    index("app_org_member_roles_user_idx").on(t.appUserId),
  ],
);

/**
 * Pending org invitations. Unlike the workspace-level end-user invite (which
 * hides its token in `app_verifications`), these need to be *listed* — "who
 * have we invited and not heard back from?" is a screen in every B2B app — so
 * they get a real table. Accepted rows are kept with `accepted_at` set so the
 * org has an audit trail of how each member got in.
 */
export const appOrgInvites = pgTable(
  "app_org_invites",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => appOrgs.id, { onDelete: "cascade" }),
    /** Lowercased at write time — matched case-insensitively on accept. */
    email: text("email").notNull(),
    /** Org role the invitee lands with (owner | admin | member). */
    role: text("role").notNull().default("member"),
    /** Org-scoped workspace role ids bound on accept. */
    roleIds: jsonb("role_ids").$type<string[] | null>(),
    token: text("token").notNull(),
    /** `app_users.id` of the inviter; null when an admin invited from the
     *  control plane. No FK for the same reason as `app_orgs.created_by`. */
    invitedBy: text("invited_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("app_org_invites_token_idx").on(t.token),
    index("app_org_invites_org_idx").on(t.orgId),
    index("app_org_invites_email_idx").on(t.email),
    index("app_org_invites_tenant_idx").on(t.tenantId),
  ],
);

export const permissions = pgTable(
  "permissions",
  {
    id: text("id").primaryKey(),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    collection: text("collection").notNull(),
    action: text("action").notNull(),
    fields: jsonb("fields").$type<string[] | null>(),
    condition: jsonb("condition").$type<unknown | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("permissions_role_idx").on(t.roleId),
    index("permissions_lookup_idx").on(t.collection, t.action),
  ],
);

export const functions = pgTable(
  "functions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    trigger: text("trigger").notNull(),
    pattern: text("pattern"),
    code: text("code").notNull(),
    timeoutMs: integer("timeout_ms").notNull().default(5000),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
export const extensions = pgTable(
  "extensions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    version: text("version").notNull(),
    source: text("source").notNull(),
    npmPackage: text("npm_package"),
    manifest: jsonb("manifest").$type<unknown>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("extensions_tenant_name_idx").on(t.tenantId, t.name)],
);

export const extensionAssets = pgTable(
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

/**
 * Persistent task queue for delayed flow continuations. The flow runtime
 * pauses on `delay` ops longer than ~30s by enqueuing the remaining ops
 * and resuming on the next scheduler tick whose clock has caught up.
 *
 * `claimed_at` is the idempotency hook — the scheduler does an atomic
 * `UPDATE ... WHERE claimed_at IS NULL ... RETURNING *` to win each row
 * exactly once. After successful resumption the row is deleted.
 */
export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    flowId: text("flow_id"),
    payload: jsonb("payload").$type<unknown>().notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scheduled_tasks_run_idx").on(t.runAt, t.claimedAt),
    index("scheduled_tasks_flow_idx").on(t.flowId),
  ],
);

export const flows = pgTable(
  "flows",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    trigger: text("trigger").notNull(),
    operations: jsonb("operations").$type<unknown[]>().notNull(),
    /** Builder graph metadata: nodes (positions, types, configs) + edges.
     *  The compiler reduces this to `operations` for runtime; layout is kept
     *  so admins reopen the flow without losing their canvas. */
    layout: jsonb("layout").$type<unknown>(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("flows_active_idx").on(t.active),
    index("flows_tenant_idx").on(t.tenantId),
  ],
);

/**
 * AI agents — a named, reusable agent definition. `system_prompt` shapes the
 * persona; `model` pins a default LLM (gateway-prefixed id or bare Anthropic
 * id, resolved by callClaude); `tools` is the allow-list of MCP tool names the
 * agent may call (a subset of `allTools`); `max_steps` caps the reason→act loop
 * so a runaway agent can't spin forever. Scoped to a workspace like flows.
 */
export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    /** Stable `@`-mention token, unique per workspace. `name` is free text (it
     *  can contain spaces), so it can't be the thing a room member types after
     *  an `@`. Derived from the name on create, editable, and what the room
     *  composer's mention picker inserts. */
    handle: text("handle"),
    description: text("description"),
    systemPrompt: text("system_prompt"),
    model: text("model"),
    /** Reasoning effort (`low` | `medium` | `high`), null = the provider
     *  default. The cheapest quality/cost dial: lower effort means fewer
     *  thinking tokens and fewer, more consolidated tool calls. Only sent to
     *  models that accept it. */
    effort: text("effort"),
    /** Allow-list of MCP tool names this agent may invoke. */
    tools: jsonb("tools").$type<string[]>().notNull().default([]),
    /** Hard cap on reason→act iterations per turn (runaway-loop backstop). */
    maxSteps: integer("max_steps").notNull().default(8),
    /** Master switch for the agent's memory. When true the runner keeps an
     *  **episodic** trace (each turn's user + final messages, embedded and
     *  retrieved by relevance blended with recency) and distils durable
     *  **semantic** facts out of it into `agent_memories`. Best-effort: a no-op
     *  when no embedding provider / default model is configured. */
    memory: boolean("memory").notNull().default(false),
    /** How far the distilled semantic facts reach.
     *
     *  - `thread` (default) — facts are scoped to the conversation they came
     *    from. Safe by construction: nothing a user said in one room can
     *    resurface in another.
     *  - `agent` — facts are shared across every thread this agent takes part
     *    in, so it accumulates lasting knowledge about the workspace. That is
     *    the point of semantic memory, and also its risk: threads have
     *    different human participants, so a fact learned from one person
     *    becomes visible to the next. Opt-in for exactly that reason.
     *
     *  Episodic memory is always thread-scoped regardless of this setting —
     *  raw transcript snippets are the part most likely to carry something
     *  personal, and they earn their keep inside a single conversation. */
    memoryScope: text("memory_scope").notNull().default("thread"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agents_tenant_name_idx").on(t.tenantId, t.name),
    uniqueIndex("agents_tenant_handle_idx").on(t.tenantId, t.handle),
    index("agents_tenant_idx").on(t.tenantId),
  ],
);

/**
 * A conversation — a **room**, which may host several agents at once.
 *
 * `agent_id` is the legacy single-agent pin: set on every thread created before
 * rooms existed (and on one opened against a specific agent), null on a room.
 * Room membership lives in `agent_thread_agents`; a pinned thread behaves like
 * a one-participant room.
 *
 * `routing` decides who answers a message that mentions nobody:
 *   - `mention` — nobody does (the room is usable human-to-human)
 *   - `default` — `default_agent_id` does (what a pinned thread does today)
 *   - `auto`    — a cheap router picks a participant by its description
 *
 * `status` is kept for backwards compatibility (it mirrors "any run active");
 * the real per-agent lock is `agent_runs`.
 */
export const agentThreads = pgTable(
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_threads_tenant_agent_idx").on(t.tenantId, t.agentId),
    index("agent_threads_agent_idx").on(t.agentId),
    index("agent_threads_tenant_idx").on(t.tenantId),
  ],
);

/** Room membership: which agents can be mentioned in (and answer in) a room. */
export const agentThreadAgents = pgTable(
  "agent_thread_agents",
  {
    tenantId: text("tenant_id"),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_thread_agents_pk").on(t.threadId, t.agentId),
    index("agent_thread_agents_agent_idx").on(t.agentId),
  ],
);

/**
 * One agent's turn in a room — the unit of work and, via the partial unique
 * index below, the **per-agent lock**.
 *
 * The lock used to live on the thread (`agent_threads.status = 'running'`),
 * which meant a room where two agents were mentioned at once had one of them
 * rejected. Keying it on (thread, agent) lets different agents answer in
 * parallel while still stopping the same agent from running twice.
 *
 * A turn is NOT idempotent (its tool calls can have side effects), so the
 * backing job is enqueued with `maxAttempts: 1` — a run whose isolate dies
 * lands in `error`, it is never replayed.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    /** Backing `jobs` row, when the turn runs async. Null for a sync turn. */
    jobId: text("job_id"),
    /** `queued` | `running` | `done` | `error` */
    status: text("status").notNull().default("queued"),
    /** Team member whose message triggered this turn (null for an API key). */
    startedBy: text("started_by"),
    /** The `agent_messages` row that triggered it. */
    triggerMessageId: text("trigger_message_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_runs_thread_idx").on(t.threadId, t.createdAt),
    // The lock itself — see the table comment. Partial, so finished runs don't
    // collide with the next turn.
    uniqueIndex("agent_runs_active_idx")
      .on(t.threadId, t.agentId)
      .where(sql`${t.status} in ('queued','running')`),
  ],
);

/**
 * One message in a thread. `role` is user | assistant | tool. Tool steps carry
 * `tool_name` / `tool_args` (the call the model emitted) and `tool_result`
 * (the observation fed back). Token counts are recorded for usage display.
 */
export const agentMessages = pgTable(
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
    /** Which agent wrote an assistant/tool row. A room's transcript mixes
     *  several agents, so without this a byline is impossible. Null on user
     *  rows, and on pre-rooms rows that couldn't be attributed. */
    agentId: text("agent_id"),
    content: text("content").notNull().default(""),
    toolName: text("tool_name"),
    toolArgs: jsonb("tool_args").$type<unknown>(),
    toolResult: jsonb("tool_result").$type<unknown>(),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_messages_thread_idx").on(t.threadId, t.createdAt),
  ],
);

/**
 * Distilled **semantic** memory for an agent — durable facts, not transcript.
 *
 * Episodic memory (the raw turns) stays vector-only: it's high-volume, cheap to
 * regenerate, and only useful as similarity fodder. Semantic facts are the
 * opposite — few, long-lived, and the thing an operator will want to read and
 * correct — so they get real rows. That also buys listing and forgetting, which
 * the vector adapter contract can't provide (no enumerate-by-namespace).
 *
 * `thread_id` records where a fact came from. `scope` records the reach it was
 * distilled under, and retrieval only ever reads rows matching the agent's
 * *current* `memory_scope`: flipping an agent from `thread` to `agent` starts a
 * fresh shared pool rather than retroactively broadcasting facts that were
 * learned while the agent was promised to stay inside one conversation.
 *
 * The vector record for a row uses the row id, so forgetting a fact removes
 * both halves.
 */
export const agentMemories = pgTable(
  "agent_memories",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    agentId: text("agent_id").notNull(),
    /** The conversation this fact was distilled from. Kept even for
     *  agent-scoped rows so an operator can trace a fact back to its source. */
    threadId: text("thread_id"),
    /** `thread` | `agent` — the reach this row was written under. */
    scope: text("scope").notNull().default("thread"),
    /** One self-contained fact, as a short sentence. */
    content: text("content").notNull(),
    /** True once an embedding was successfully stored for this row. False rows
     *  are still listable and still forgettable — they just can't be retrieved
     *  by similarity, which is what happens when no embedding provider is
     *  configured at distillation time. */
    embedded: boolean("embedded").notNull().default(false),
    /** How many turns have retrieved this fact. Cheap signal for pruning and
     *  for showing an operator which memories actually matter. */
    hits: integer("hits").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_memories_agent_idx").on(t.agentId, t.scope),
    index("agent_memories_thread_idx").on(t.threadId, t.createdAt),
    index("agent_memories_tenant_idx").on(t.tenantId),
  ],
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    url: text("url").notNull(),
    events: jsonb("events").$type<string[]>().notNull(),
    headers: jsonb("headers").$type<Record<string, string> | null>(),
    secret: text("secret"),
    active: boolean("active").notNull().default(true),
    /** Consecutive failed deliveries since the last 2xx — drives the
     *  auto-disable circuit breaker. Reset to 0 on any success. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Timestamp of the most recent failed delivery (null once healthy). */
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    /** Human-readable reason set when the breaker auto-disables this hook;
     *  null while the hook is healthy or was paused manually. */
    disabledReason: text("disabled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("webhooks_active_idx").on(t.active),
    index("webhooks_tenant_idx").on(t.tenantId),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id").notNull(),
    event: text("event").notNull(),
    status: integer("status").notNull(),
    ms: integer("ms").notNull(),
    responseBody: text("response_body"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(1),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("webhook_deliveries_hook_idx").on(t.webhookId),
    index("webhook_deliveries_at_idx").on(t.deliveredAt),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    collection: text("collection").notNull(),
    itemId: text("item_id").notNull(),
    userId: text("user_id"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
export const sharedLinks = pgTable(
  "shared_links",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    collection: text("collection").notNull(),
    itemId: text("item_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: text("created_by"),
    /** Nullable — set when the link is revoked. Null = active. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shared_links_token_idx").on(t.tokenHash),
    index("shared_links_item_idx").on(t.collection, t.itemId),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    userId: text("user_id"),
    title: text("title").notNull(),
    body: text("body"),
    url: text("url"),
    flowId: text("flow_id"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId),
    index("notifications_unread_idx").on(t.userId, t.readAt),
    index("notifications_tenant_idx").on(t.tenantId),
  ],
);

/* ─────────────────────────────────────────────────────────────────────
 * Push messaging: registered device targets + per-workspace provider config
 * + reusable templates. Mirrors the email_config / email_templates pattern;
 * `notifications` (above) stays the in-app feed, these power native push.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * A user's registered push target. `token` is the FCM registration token, the
 * APNs device token, or the web-push endpoint URL; `keys` holds the web-push
 * VAPID subscription keys ({ p256dh, auth }) and is null for fcm/apns. Tokens
 * the provider reports as permanently invalid are deactivated (`is_active`)
 * rather than deleted, so a re-register can revive the row.
 */
export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    userId: text("user_id").notNull(),
    /** fcm | apns | web-push */
    platform: text("platform").notNull(),
    token: text("token").notNull(),
    keys: jsonb("keys").$type<{ p256dh: string; auth: string }>(),
    deviceName: text("device_name"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("device_tokens_unique_idx").on(t.userId, t.platform, t.token),
    index("device_tokens_user_idx").on(t.userId),
    index("device_tokens_tenant_idx").on(t.tenantId),
  ],
);

/**
 * Per-workspace push provider config. Same `_global` / `inherit` fallback model
 * as `email_config`: `provider = "inherit"` (or no usable config) falls through
 * to the deployment's env-derived adapter. `config` holds non-secret params
 * (e.g. fcm projectId, apns keyId/teamId/bundleId, web-push vapidPublicKey);
 * `secrets` holds the same keys but AES-256-GCM ciphertext (see lib/crypto).
 */
export const pushConfig = pgTable(
  "push_config",
  {
    tenantId: text("tenant_id").primaryKey(),
    /** inherit | console | fcm | apns | web-push | cloud */
    provider: text("provider").notNull().default("inherit"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    secrets: jsonb("secrets").$type<Record<string, string>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const pushTemplates = pgTable(
  "push_templates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    key: text("key").notNull(),
    name: text("name").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    url: text("url"),
    variables: jsonb("variables").$type<string[]>(),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("push_templates_tenant_key_idx").on(t.tenantId, t.key)],
);

/**
 * Registered phone numbers for SMS messaging. Keyed by (userId, phoneNumber);
 * re-registering revives the row (`is_active`) and refreshes `last_seen_at`.
 * Numbers the provider reports as permanently undeliverable are deactivated
 * rather than deleted, so a re-register can revive the row.
 */
export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    userId: text("user_id").notNull(),
    /** E.164, e.g. +14155552671. */
    phoneNumber: text("phone_number").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("phone_numbers_unique_idx").on(t.userId, t.phoneNumber),
    index("phone_numbers_user_idx").on(t.userId),
    index("phone_numbers_tenant_idx").on(t.tenantId),
  ],
);

/**
 * Per-workspace SMS provider config. Same `_global` / `inherit` fallback model
 * as `push_config`. `config` holds non-secret params (twilio: accountSid /
 * from / messagingServiceSid; sns: region / accessKeyId / senderId); `secrets`
 * holds the AES-256-GCM ciphertext of authToken / secretAccessKey.
 */
export const smsConfig = pgTable(
  "sms_config",
  {
    tenantId: text("tenant_id").primaryKey(),
    /** inherit | console | twilio | sns | netgsm | iletimerkezi */
    provider: text("provider").notNull().default("inherit"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    secrets: jsonb("secrets").$type<Record<string, string>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Durable job queue. Rows are drained by the cross-runtime cron tick
 * (`processJobs` inside `cronTick`), claimed with a `status='active' + claimedAt`
 * lease, retried with exponential backoff, and promoted to `dead_letter` once
 * `attempts >= maxAttempts`. `runAt` supports delayed/scheduled execution.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    queue: text("queue").notNull().default("default"),
    /** Handler discriminator: function | webhook.deliver */
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** pending | active | succeeded | failed | dead_letter | cancelled */
    status: text("status").notNull().default("pending"),
    /** Lower runs sooner within a due batch. */
    priority: integer("priority").notNull().default(0),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    /** Lease marker — set when a tick claims the row; cleared on requeue. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastError: text("last_error"),
    result: jsonb("result").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
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
export const uploads = pgTable(
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
    parts: jsonb("parts").$type<{ partNumber: number; etag: string; size: number }[]>().notNull().default([]),
    contentType: text("content_type"),
    folderId: text("folder_id"),
    ownerId: text("owner_id"),
    /** Decoded TUS `Upload-Metadata` bag. */
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
    /** pending | completed | aborted */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("uploads_tenant_idx").on(t.tenantId),
    index("uploads_expires_idx").on(t.expiresAt),
    index("uploads_status_idx").on(t.status),
  ],
);

export const revisions = pgTable(
  "revisions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    collection: text("collection").notNull(),
    itemId: text("item_id").notNull(),
    parentRevisionId: text("parent_revision_id"),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("revisions_item_idx").on(t.collection, t.itemId),
    index("revisions_tenant_idx").on(t.tenantId),
  ],
);

/** Immutable schema snapshot — the schema-relevant subset of a workspace's
 *  `collections` rows (`SchemaCollection[]`), captured for migration diffing /
 *  branching (#9). `hash` is the sha256 of the canonical snapshot; `parent_
 *  snapshot_id` links lineage; `branch_id` ties it to its branch (null = live).
 *  See the sqlite/schema.ts twin. */
export const schemaSnapshots = pgTable(
  "schema_snapshots",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    note: text("note"),
    snapshot: jsonb("snapshot").$type<unknown[]>().notNull(),
    hash: text("hash").notNull(),
    kind: text("kind").notNull().default("manual"),
    branchId: text("branch_id"),
    parentSnapshotId: text("parent_snapshot_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("schema_snapshots_tenant_idx").on(t.tenantId, t.createdAt),
    index("schema_snapshots_branch_idx").on(t.branchId),
  ],
);

/** Named, mutable pointer into the snapshot history — a "schema branch".
 *  `head_snapshot_id` is the working schema; `base_snapshot_id` is the fork
 *  point used as the merge base when diffing against live. See the twin. */
export const schemaBranches = pgTable(
  "schema_branches",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    note: text("note"),
    headSnapshotId: text("head_snapshot_id"),
    baseSnapshotId: text("base_snapshot_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("schema_branches_tenant_name_idx").on(t.tenantId, t.name)],
);

/** Saved external-database connections for server-side migration (the admin
 *  "Database import" wizard). `url` is encrypted at rest with AUTH_SECRET
 *  (same envelope as integration configs — services/integrations.ts) and is
 *  always masked on the API; only the copy executor decrypts it. Deleting a
 *  source cascades to its runs (history is meaningless without the source). */
export const externalSources = pgTable(
  "external_sources",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("postgres"),
    /** Encrypted connection string (lib/crypto envelope). */
    url: text("url").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("external_sources_tenant_name_idx").on(t.tenantId, t.name)],
);

/** One server-side migration execution. The scheduler tick claims runs and
 *  copies in bounded slices; `state` carries per-table keyset cursors +
 *  counters so a run survives isolate death and resumes where it left off
 *  (the ingest path is idempotent — re-copying an overlap never dupes). */
export const migrationRuns = pgTable(
  "migration_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => externalSources.id, { onDelete: "cascade" }),
    /** The validated MigrationPlan document (packages/migrate parsePlan). */
    plan: jsonb("plan").$type<unknown>().notNull(),
    /** Per-table progress: `{ [slug]: { cursor, copied, failed, done, … } }`. */
    state: jsonb("state").$type<unknown>().notNull(),
    /** pending | running | done | failed | cancelled */
    status: text("status").notNull().default("pending"),
    error: text("error"),
    /** Lease heartbeat — a `running` run whose lease expired is reclaimable
     *  by any isolate's tick (same stale-lease model as the job queue). */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("migration_runs_tenant_idx").on(t.tenantId, t.createdAt)],
);

export const activity = pgTable(
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
    payload: jsonb("payload").$type<unknown | null>(),
    response: jsonb("response").$type<unknown | null>(),
    /** Request handler duration in ms — populated by sessionMiddleware
     *  via a per-request timer. Lets the metrics endpoint compute p95
     *  without a separate analytics pipeline. */
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
export const spans = pgTable(
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
    attributes: jsonb("attributes").$type<Record<string, unknown> | null>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
export const usageCounters = pgTable(
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
    storageBytes: bigint("storage_bytes", { mode: "number" }),
    /** Gauge: total rows across the workspace's collections at last sweep. */
    dbRows: bigint("db_rows", { mode: "number" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("usage_counters_pk").on(t.tenantId, t.apiKeyId, t.day)],
);

export const apiKeys = pgTable(
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
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** MCP per-key tool allowlist. `NULL` = every tool the MCP server exposes
     *  is available to this key (default for keys created before MCP existed
     *  and for any key that omits the field on create). When set to an array
     *  of tool names (e.g. `["collections.list","collections.read"]`), the
     *  dispatcher filters `tools/list` to the intersection and 403s any
     *  `tools/call` outside it. Defense-in-depth on top of the permissions
     *  DSL: a key that has `delete` on a collection can still be denied the
     *  `collections.delete` MCP tool. */
    mcpTools: jsonb("mcp_tools").$type<string[] | null>(),
    /** When true, MCP refuses every write tool — insert/update/delete/grant/
     *  revoke/invoke/assign — for this key, regardless of the permissions
     *  DSL or the allowlist. Designed for read-only AI agents pointed at a
     *  production workspace. The underlying REST endpoints stay open to the
     *  same identity; the lock is enforced only on the MCP surface. */
    mcpReadOnly: boolean("mcp_read_only").notNull().default(false),
    /** Per-key requests-per-minute cap. NULL = the shared global budget
     *  (`lib/api-rate-limit.ts`). A set value is enforced even on deploys
     *  where the global limiter is disabled — explicit config always wins. */
    rateLimitPerMinute: integer("rate_limit_per_minute"),
    /** Per-key requests-per-UTC-month quota, checked against the usage
     *  ledger (`usage_counters`). NULL = unmetered. Over-quota requests get
     *  429 QUOTA_EXCEEDED until the month rolls over. */
    monthlyQuota: integer("monthly_quota"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_keys_hashed_idx").on(t.hashedKey),
    index("api_keys_prefix_idx").on(t.prefix),
    index("api_keys_user_idx").on(t.userId),
    index("api_keys_role_idx").on(t.roleId),
    index("api_keys_tenant_idx").on(t.tenantId),
  ],
);

/**
 * `collections` is the metadata table. Each row defines a dynamic
 * collection whose actual data lives in a physical table whose name is
 * stored in `physical_table` and created at runtime via the schema applier
 * (packages/db/src/schema-applier.ts). Each collection belongs to exactly
 * one tenant — `(tenant_id, slug)` is unique, but two tenants may reuse
 * the same slug independently.
 */
export const collections = pgTable(
  "collections",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Physical table name (e.g. `c_<tenantPrefix>_<slug>`). Stored so we
     *  never have to re-derive it; legacy rows may still be `c_<slug>`. */
    physicalTable: text("physical_table").notNull(),
    singular: text("singular"),
    plural: text("plural"),
    note: text("note"),
    displayTemplate: text("display_template"),
    /** Admin icon key from the SPA's icon set (e.g. `"FileText"`). Null falls
     *  back to the default `Database` icon. Purely presentational. */
    icon: text("icon"),
    /** Admin accent color for the icon/labels. A preset token name
     *  (`"violet"`, `"teal"`, …) or a custom `#rrggbb` hex. Null = default. */
    color: text("color"),
    /** When true, the collection is hidden from the admin sidebar and the
     *  Collections index (an explicit "show hidden" toggle reveals it).
     *  Purely presentational — API access and permissions are unaffected. */
    hidden: boolean("hidden").notNull().default(false),
    /** Optional preview-URL template with `{{field}}` placeholders
     *  (e.g. `https://site.com/blog/{{slug}}?preview=1`). Renders an
     *  "Open preview" action on items in the admin. */
    previewUrl: text("preview_url"),
    fields: jsonb("fields").$type<unknown[]>().notNull(),
    ownerScoped: boolean("owner_scoped").notNull().default(false),
    /** When true, the physical table gains a `tenant_id` column and
     *  reads/writes are auto-scoped by the active tenant. */
    tenantScoped: boolean("tenant_scoped").notNull().default(true),
    /** When true, the physical table has `_status` + `_published_at` columns. */
    versioned: boolean("versioned").notNull().default(false),
    /** Staged edits (only meaningful with `versioned`). When true, a PATCH
     *  against a *published* row is stored as a staged patch in `item_staged`
     *  instead of mutating the live row — readers keep seeing the published
     *  content until `publish` applies the staged changes. `?live=1` (publish
     *  permission) bypasses staging; unpublish/archive fold the staged patch
     *  into the row as it leaves the published state. See the sqlite twin. */
    stagedEdits: boolean("staged_edits").notNull().default(false),
    /** When true, the physical table gains a nullable `deleted_at` column and
     *  DELETE soft-deletes (sets `deleted_at = now()`) instead of removing the
     *  row; every read path filters `deleted_at IS NULL`. Forced false for
     *  adopted collections (no DDL on the source table). */
    softDelete: boolean("soft_delete").notNull().default(false),
    /** When true, the collection is locked to a single row — inserts are
     *  rejected once one live row exists (useful for site settings). */
    singleton: boolean("singleton").notNull().default(false),
    /** Opt-in sensitive-read auditing. When true, REST read operations on this
     *  collection (list + by-id) record an `access.read` activity row so admins
     *  get a "who viewed this" trail for regulated data (HIPAA/PCI/gov). Off by
     *  default — reads are otherwise never logged to keep the audit table small. */
    auditReads: boolean("audit_reads").notNull().default(false),
    /** When true, item writes auto-generate embeddings from fields flagged
     *  `vectorize: true` on the field definition. Drives both the on-write
     *  hook in routes/items.ts and the bulk `POST /:slug/vectorize` route. */
    vectorize: boolean("vectorize").notNull().default(false),
    /** Embedding model key from `EMBEDDING_MODELS`. When null, falls back
     *  to `env.EMBEDDING_DEFAULT_MODEL`; when neither is set, vectorization
     *  is silently skipped for this collection. */
    vectorizeModel: text("vectorize_model"),
    /** When true, item writes maintain a keyword full-text-search index
     *  (Postgres `tsvector` column + GIN; SQLite FTS5 shadow table) built
     *  from the fields flagged `searchable: true`. Drives the on-write hook,
     *  the `?q=` precision filter, the `POST /:slug/search` endpoint, and the
     *  bulk `POST /:slug/fts-reindex` backfill route. */
    fts: boolean("fts").notNull().default(false),
    /** Default sort applied by `parseQuery` when the request omits `?sort=`.
     *  Comma-separated field list, `-` prefix = DESC (`-` prefix = DESC).
     *  e.g. `"-published_at,name"`. Null falls back to `-created_at` if the
     *  collection has that column, otherwise the PK. */
    defaultSort: text("default_sort"),
    /** Field name the admin Kanban view groups cards by. Stores a user
     *  field's name (a `dropdown`/`select` field) or the special `_status`
     *  lifecycle column on versioned collections. Null = auto-detect (a field
     *  literally named `status`, else the first dropdown). See the
     *  sqlite/schema.ts twin. */
    kanbanGroupBy: text("kanban_group_by"),
    /** Maps a Kanban group-by dropdown *value* to a draft/publish lifecycle
     *  action (`publish` | `unpublish` | `archive`). When a card on a
     *  custom-status board moves into a mapped column, backlex sets the field
     *  AND fires that lifecycle action — e.g. a `done` column that also
     *  publishes. Only meaningful on a `versioned` collection whose
     *  `kanbanGroupBy` is a user dropdown. Null/empty = no triggers. See the
     *  sqlite/schema.ts twin. */
    kanbanActionMap: jsonb("kanban_action_map").$type<Record<string, string>>(),
    /** Admin grouping: section header this collection sits under on the
     *  Collections page + sidebar tree. Column is `group_name` because
     *  `GROUP` is reserved in both dialects; the JSON key stays `group`.
     *  Null = ungrouped (rendered last). Group-header order lives in the
     *  `collectionGroups` app_settings key. */
    group: text("group_name"),
    /** Manual position within its group. Null = unordered (sorted by slug
     *  after all explicitly-ordered rows). */
    sortOrder: integer("sort_order"),
    /** True when this collection was adopted from an existing physical table
     *  (vs. created by us). Schema applier becomes a no-op for these rows,
     *  drop never touches the underlying table, and ownership uses the
     *  side-table `item_ownership` instead of an injected `owner_id`
     *  column. */
    adopted: boolean("adopted").notNull().default(false),
    /** Name of the PK column on the physical table. Default `id` covers
     *  every collection we create; adoption surfaces this for source
     *  tables that use a different PK name (e.g. `sku`, `uuid_v7`). */
    pkColumn: text("pk_column").notNull().default("id"),
    /** Storage type of the PK column (`uuid` | `text` | `integer`). Managed
     *  collections default to `uuid` (the historical shape); external-DB
     *  migration creates `text`/`integer`-keyed collections so source PKs can
     *  be preserved verbatim (FK values keep working without a remap table).
     *  Non-`uuid` integer PKs are never auto-generated — POST requires the
     *  key in the body, same contract as adopted tables. */
    pkType: text("pk_type").notNull().default("uuid"),
    /** True when the physical table has a `created_at` column. Always true
     *  for managed collections; flexible for adopted ones. Affects whether
     *  POST sets it, whether the projection includes it, and the default
     *  sort fallback in `parseQuery`. */
    hasCreatedAt: boolean("has_created_at").notNull().default(true),
    /** Mirror of `hasCreatedAt` for `updated_at`. */
    hasUpdatedAt: boolean("has_updated_at").notNull().default(true),
    /** Physical column name backing `createdAt`. Null means "use the
     *  conventional name `created_at`" (every managed collection). Adopted
     *  collections can map to an existing column with a different name —
     *  e.g. `inserted_at` — without DDL on the source table. */
    createdAtColumn: text("created_at_column"),
    /** Mirror of `createdAtColumn` for `updatedAt` (`modified_at` etc.). */
    updatedAtColumn: text("updated_at_column"),
    /** Physical column name backing `ownerId`. When set, ownership reads
     *  from this column on the source table instead of the `item_ownership`
     *  side-table — useful when the adopted table already carries a
     *  `user_id` / `created_by` column the user wants to keep authoritative. */
    ownerIdColumn: text("owner_id_column"),
    /** Lifecycle status. `'active'` (default) = the normal state.
     *  `'archived'` = soft-archived (adopted collections only); items
     *  endpoints return 404 and the collection is hidden from the
     *  default list response, but the physical table stays intact and
     *  `POST /collections/:slug/restore` flips it back. Managed `c_*`
     *  collections never reach `'archived'` — they're hard-dropped on
     *  delete because the physical table goes with them. */
    status: text("status").notNull().default("active"),
    /** When `status` flipped to `'archived'`. Null while active. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("collections_tenant_slug_idx").on(t.tenantId, t.slug),
    uniqueIndex("collections_physical_table_idx").on(t.physicalTable),
  ],
);

/**
 * Row-level ownership for items. One row per (collection, item) when the
 * owning collection is `ownerScoped`. We keep ownership in this side table
 * instead of an `owner_id` column on every `c_<slug>` for two reasons:
 *   (1) **adopt-friendly** — adopted tables stay non-invasive (no DDL on
 *       the user's table); ownership lives entirely in our side table.
 *   (2) **toggle-friendly** — flipping `ownerScoped` off no longer leaves
 *       orphan columns behind on the physical table.
 * Permission filters compile `owner_id` references to a semi-join against
 * this table. `routes/items.ts` LEFT JOINs it on read to surface the
 * resolved `owner_id` to the API response.
 */
export const itemOwnership = pgTable(
  "item_ownership",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    /** PK value of the row in the physical table, stringified so uuid/int/
     *  text PKs all fit in one column. */
    itemId: text("item_id").notNull(),
    ownerId: text("owner_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("item_ownership_pk_idx").on(t.collectionId, t.itemId),
    index("item_ownership_owner_idx").on(t.ownerId, t.collectionId),
  ],
);

/**
 * Staged (unpublished) edits for published rows of a `stagedEdits` collection.
 * One row per (collection, item): the accumulated PATCH — deserialized field
 * values, merged shallowly per field across saves — that `publish` will apply
 * to the live row. Kept as a JSON sidecar (not a second physical row) so
 * unique constraints, relations, and adopted tables need no special casing.
 * Cleared on publish/unpublish/archive (applied) and on discard/delete.
 */
export const itemStaged = pgTable(
  "item_staged",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    /** PK value of the target row, stringified (uuid/int/text all fit). */
    itemId: text("item_id").notNull(),
    tenantId: text("tenant_id"),
    /** The staged patch: field name → deserialized value (hash fields are
     *  stored pre-digested — never plaintext). */
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by"),
  },
  (t) => [uniqueIndex("item_staged_pk_idx").on(t.collectionId, t.itemId)],
);

/**
 * Embeddings — one table per embedding model. Vectors from different models
 * live in disjoint vector spaces and have different dimensions, so mixing
 * them in one table would force `vector(N)` to compromise on N and would
 * yield meaningless cosine results across models. Adding a new model means
 * adding a sibling table here, registering it in
 * `packages/core/src/embedding-models.ts`, and (on Workers) binding a
 * matching `[[vectorize]]` index in wrangler.toml.
 *
 * drizzle-kit may not generate the `USING hnsw` part — if a generated
 * migration omits it, add manually:
 *   CREATE INDEX <name>_hnsw_idx ON <table> USING hnsw (embedding vector_cosine_ops);
 */

export const embeddingsOpenai1536 = pgTable(
  "embeddings_openai_1536",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull().default("default"),
    refId: text("ref_id"),
    content: text("content"),
    embedding: vector("embedding", 1536).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("embeddings_openai_1536_namespace_idx").on(t.namespace),
    index("embeddings_openai_1536_ref_idx").on(t.refId),
    index("embeddings_openai_1536_hnsw_idx")
      .using("hnsw", sql`embedding vector_cosine_ops`),
  ],
);

export const embeddingsOpenai3072 = pgTable(
  "embeddings_openai_3072",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull().default("default"),
    refId: text("ref_id"),
    content: text("content"),
    embedding: vector("embedding", 3072).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("embeddings_openai_3072_namespace_idx").on(t.namespace),
    index("embeddings_openai_3072_ref_idx").on(t.refId),
    // NOTE: pgvector's HNSW index caps at 2000 dimensions. For 3072-dim
    // vectors use IVFFlat instead (slightly slower build, comparable recall
    // at the right `lists` setting). Add manually once the table has rows:
    //   CREATE INDEX embeddings_openai_3072_ivfflat_idx ON embeddings_openai_3072
    //     USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  ],
);

/** Self-hosted bge-m3 vectors (TEI/Ollama/etc). Same dimension as the
 * Workers AI variant, but vectors live in a separate space — a different
 * build/quantization of the same model yields shifted outputs that aren't
 * comparable across stores. Keep them isolated. */
export const embeddingsSelfHostBgeM3 = pgTable(
  "embeddings_self_host_bge_m3",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull().default("default"),
    refId: text("ref_id"),
    content: text("content"),
    embedding: vector("embedding", 1024).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("embeddings_self_host_bge_m3_namespace_idx").on(t.namespace),
    index("embeddings_self_host_bge_m3_ref_idx").on(t.refId),
    index("embeddings_self_host_bge_m3_hnsw_idx")
      .using("hnsw", sql`embedding vector_cosine_ops`),
  ],
);

export const embeddingsBgeM3 = pgTable(
  "embeddings_bge_m3",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull().default("default"),
    refId: text("ref_id"),
    content: text("content"),
    embedding: vector("embedding", 1024).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("embeddings_bge_m3_namespace_idx").on(t.namespace),
    index("embeddings_bge_m3_ref_idx").on(t.refId),
    index("embeddings_bge_m3_hnsw_idx")
      .using("hnsw", sql`embedding vector_cosine_ops`),
  ],
);

export const folders = pgTable(
  "folders",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    parentId: text("parent_id"),
    ownerId: text("owner_id"),
    tenantId: text("tenant_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("folders_parent_idx").on(t.parentId),
    index("folders_tenant_idx").on(t.tenantId),
  ],
);

export const files = pgTable(
  "files",
  {
    key: text("key").primaryKey(),
    folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
    ownerId: text("owner_id"),
    tenantId: text("tenant_id"),
    size: integer("size").notNull(),
    contentType: text("content_type"),
    /** public | private. */
    acl: text("acl").notNull().default("private"),
    metadata: jsonb("metadata").$type<Record<string, string>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("files_folder_idx").on(t.folderId),
    index("files_tenant_idx").on(t.tenantId),
  ],
);

/* ─────────────────────────────────────────────────────────────────────
 * Admin-page backing tables: email templates, i18n, settings, panels.
 * All tenant-scoped (tenant_id NULL means cross-tenant fallback).
 * ───────────────────────────────────────────────────────────────────── */

export const emailTemplates = pgTable(
  "email_templates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    /** verify | reset | magic | invite | change_email | custom */
    key: text("key").notNull(),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    fromAddress: text("from_address"),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text"),
    variables: jsonb("variables").$type<string[]>(),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("email_templates_tenant_key_idx").on(t.tenantId, t.key),
  ],
);

export const i18nStrings = pgTable(
  "i18n_strings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    key: text("key").notNull(),
    locale: text("locale").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("i18n_strings_unique_idx").on(t.tenantId, t.key, t.locale),
    index("i18n_strings_locale_idx").on(t.locale),
  ],
);

export const appSettings = pgTable(
  "app_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
export const featureFlags = pgTable(
  "feature_flags",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    key: text("key").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    /** Remote-config payload returned when the flag is on (any JSON). */
    value: jsonb("value").$type<unknown>(),
    /** Targeting: `{ condition?: Condition, rollout?: number }`. Null = everyone. */
    rules: jsonb("rules").$type<{ condition?: unknown; rollout?: number } | null>(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("feature_flags_unique_idx").on(t.tenantId, t.key),
    index("feature_flags_tenant_idx").on(t.tenantId),
  ],
);

export const savedPanels = pgTable(
  "saved_panels",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    description: text("description"),
    /** sql | items-aggregate | static. */
    kind: text("kind").notNull().default("sql"),
    sql: text("sql"),
    /** sparkline | bars | donut | counter | table. */
    viz: text("viz").notNull().default("sparkline"),
    /** Display config (axis, colors, fields, etc.). */
    config: jsonb("config").$type<Record<string, unknown>>(),
    /** Optional dashboard layout (x,y,w,h). */
    layout: jsonb("layout").$type<{ x: number; y: number; w: number; h: number } | null>(),
    /** Optional parent dashboard. NULL = legacy "loose" panel rendered on the
     *  workspace's default/ungrouped grid. */
    dashboardId: text("dashboard_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("saved_panels_tenant_idx").on(t.tenantId),
    index("saved_panels_dashboard_idx").on(t.dashboardId),
  ],
);

/**
 * Embedded BI dashboards — named groupings of `saved_panels` that can be
 * published to a public, unauthenticated embed URL. The plaintext embed token
 * (`dsh_<hex>`) is returned once on share; only its SHA-256 hash is stored
 * (`embedTokenHash`), mirroring `shared_links`. `embedRoleId` scopes the
 * permissions the public embed resolves data against (same idea as
 * `api_keys.roleId`) — NULL means the embed runs unscoped (admin-equivalent
 * read, intended for fully public stats).
 */
export const dashboards = pgTable(
  "dashboards",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    description: text("description"),
    /** Dashboard-level layout/display config (column count, theme, …). */
    layout: jsonb("layout").$type<Record<string, unknown> | null>(),
    /** When true, the public embed route serves this dashboard by token. */
    embedEnabled: boolean("embed_enabled").notNull().default(false),
    /** SHA-256 hash of the one-time embed token. Null = never shared / revoked. */
    embedTokenHash: text("embed_token_hash"),
    /** Optional role the public embed resolves panel data against. */
    embedRoleId: text("embed_role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
export const forms = pgTable(
  "forms",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    collection: text("collection").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** Ordered exposed fields: [{ name, label?, help? }]. */
    fields: jsonb("fields").$type<Array<Record<string, unknown>>>().notNull(),
    /** Behaviour knobs: submit label, success message/redirect, turnstile. */
    settings: jsonb("settings").$type<Record<string, unknown> | null>(),
    /** Paused forms answer 410 on the public endpoints without being deleted. */
    active: boolean("active").notNull().default(true),
    /** All-time accepted submissions (incremented per successful submit). */
    submissionCount: integer("submission_count").notNull().default(0),
    /** Submissions rejected by honeypot / Turnstile / rate limit. */
    blockedCount: integer("blocked_count").notNull().default(0),
    lastSubmissionAt: timestamp("last_submission_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("forms_token_idx").on(t.tokenHash),
    index("forms_tenant_idx").on(t.tenantId),
    index("forms_collection_idx").on(t.collection),
  ],
);

export const authConfig = pgTable(
  "auth_config",
  {
    tenantId: text("tenant_id").primaryKey(),
    /** Provider toggles: { email: true, github: { enabled: true, clientId: "..." }, ... } */
    providers: jsonb("providers").$type<Record<string, unknown>>().notNull().default({}),
    /** Policy flags: { requireEmailVerification: bool, mfaRequiredForAdmins: bool, openSignup: bool, ... } */
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull().default({}),
    sessionLifetime: text("session_lifetime").notNull().default("30d"),
    redirectUrls: jsonb("redirect_urls").$type<string[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Per-workspace SAML 2.0 IdP configuration. One row per IdP (`tenant_id`,
 * `slug`) — a workspace can wire multiple IdPs (e.g. corporate Okta + a
 * partner ADFS). `idp_cert_pem` is stored as an `enc:v1:…` ciphertext
 * (AES-256-GCM via lib/crypto). The route layer assigns the
 * SP entity id (`sp_entity_id`) — typically the metadata URL — and the
 * ACS URL is derived from `tenant.slug + slug` at request time.
 *
 * `attribute_map` maps assertion attribute names → backlex user fields
 * (`email`, `firstName`, `lastName`, `groups`).
 *
 * `groups_to_roles` is reserved for v2 — a mapping from IdP group string
 * to `roles.id` so SAML-assigned roles can be reconciled on every login.
 */
export const samlProviders = pgTable(
  "saml_providers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** URL-safe handle, scoped within the tenant. Used in `/auth/saml/<slug>/...`. */
    slug: text("slug").notNull(),
    /** Vendor template — drives default attribute maps in the admin UI. */
    idpTemplate: text("idp_template"),
    entityId: text("entity_id").notNull(),
    ssoUrl: text("sso_url").notNull(),
    sloUrl: text("slo_url"),
    /** AES-256-GCM ciphertext of the IdP signing cert PEM. */
    idpCertPem: text("idp_cert_pem").notNull(),
    spEntityId: text("sp_entity_id").notNull(),
    attributeMap: jsonb("attribute_map")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    defaultRoleId: text("default_role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    /** Reserved for v2: { "<idp-group>": "<role-id>" }. */
    groupsToRoles: jsonb("groups_to_roles").$type<Record<string, string>>(),
    signatureAlgorithm: text("signature_algorithm").notNull().default("sha256"),
    wantSignedAssertions: boolean("want_signed_assertions").notNull().default(true),
    /** When true, an existing `app_users` row matching the IdP-asserted email
     *  is reused instead of provisioning a new account. Off by default for
     *  security (see provisionAppUser). */
    linkByVerifiedEmail: boolean("link_by_verified_email").notNull().default(false),
    nameIdFormat: text("name_id_format").notNull().default("emailAddress"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
 * hand-written provider each.
 *
 * `discovery_url` is the preferred wiring: the endpoints below are resolved
 * from `.well-known/openid-configuration` at save time. The explicit URLs are
 * kept for plain OAuth2 providers that publish no discovery document.
 */
export const oidcProviders = pgTable(
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
    scopes: jsonb("scopes").$type<string[]>().notNull().default(["openid", "profile", "email"]),
    /** PKCE on by default — required by Entra and most modern IdPs. */
    pkce: boolean("pkce").notNull().default(true),
    /** Claim to read the user's email from, when the IdP is non-standard. */
    emailClaim: text("email_claim"),
    /** Claim carrying group membership, for `groups_to_roles`. */
    groupsClaim: text("groups_claim"),
    defaultRoleId: text("default_role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    groupsToRoles: jsonb("groups_to_roles").$type<Record<string, string>>(),
    /** Attach to an existing local account when the IdP asserts a verified
     *  email. Off by default: an IdP that does not verify emails would let a
     *  new sign-in take over an existing account. */
    linkByVerifiedEmail: boolean("link_by_verified_email").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
export const scimConfig = pgTable(
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
    lastRequestAt: timestamp("last_request_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
export const syncHooks = pgTable(
  "sync_hooks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    url: text("url").notNull(),
    /** HMAC signing secret, so the app can prove the call came from us. */
    secret: text("secret"),
    /** `<collection>.beforeCreate|beforeUpdate|beforeDelete`, `*` wildcards. */
    events: jsonb("events").$type<string[]>().notNull(),
    headers: jsonb("headers").$type<Record<string, string> | null>(),
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
    canMutate: boolean("can_mutate").notNull().default(false),
    /** Execution order; ties broken by `created_at`. Hooks run SEQUENTIALLY and
     *  each sees the previous one's patch. */
    priority: integer("priority").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sync_hooks_tenant_idx").on(t.tenantId),
    index("sync_hooks_enabled_idx").on(t.enabled),
  ],
);

/**
 * Federated identity link between a workspace user (or platform user) and an
 * external IdP. `plane` decides which pool `user_id` references:
 *   - `platform` → `users.id` (the admin app's identity pool)
 *   - `app`      → `app_users.id` (the workspace's end-user pool)
 *
 * No FK on `user_id` — the referent table depends on `plane`, mirroring the
 * `tenant_members.user_id` pattern. Lookups go through the
 * `(tenant_id, provider_type, provider_id, subject)` unique index.
 *
 * Rows are kept after a provider is deleted as an audit trail; the resolver
 * skips orphaned rows because the provider lookup fails first.
 */
export const externalIdentities = pgTable(
  "external_identities",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** platform | app — which user pool `user_id` points at. */
    plane: text("plane").notNull(),
    userId: text("user_id").notNull(),
    /** saml | ldap. */
    providerType: text("provider_type").notNull(),
    /** For SAML: `saml_providers.id`. For LDAP: the literal `"ldap"`. */
    providerId: text("provider_id").notNull(),
    /** SAML NameID or LDAP DN — the IdP's stable identifier for the subject. */
    subject: text("subject").notNull(),
    emailAtProvision: text("email_at_provision"),
    /** Snapshot of the role set last assigned via the IdP's groups for this
     *  subject. The provisioner diffs against the new SSO group set on each
     *  login and patches roles accordingly. */
    rolesFromGroups: jsonb("roles_from_groups").$type<string[]>(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastLoginIp: text("last_login_ip"),
    /** SAML AuthnContextClassRef (or LDAP bind class). */
    lastAuthnContext: text("last_authn_context"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
 * Per-workspace LDAP / Active Directory configuration. Single row per
 * workspace (PK = `tenant_id`); the `_global` sentinel works as the
 * instance-wide fallback, same pattern as `email_config` / `auth_config`.
 *
 * `bind_password` and the optional `ca_pem` (custom TLS CA chain for self-
 * signed LDAPS) live in `secrets` as `enc:v1:…` ciphertext — never returned in
 * the clear. `tls_options` holds non-secret TLS knobs (`rejectUnauthorized`).
 * `domain_match` is an optional email-domain allow-list applied BEFORE the
 * LDAP roundtrip (saves the IdP query when the username clearly isn't ours).
 */
export const ldapConfigs = pgTable(
  "ldap_configs",
  {
    /** Workspace id or the `_global` sentinel. */
    tenantId: text("tenant_id").primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    /** e.g. `ldaps://dc1.corp.example:636`. */
    url: text("url").notNull(),
    bindDn: text("bind_dn").notNull(),
    baseDn: text("base_dn").notNull(),
    /** Substituted with the escaped username before search. */
    userFilter: text("user_filter")
      .notNull()
      .default("(&(objectClass=person)(uid={{username}}))"),
    /** Optional group-membership search filter (AD `memberOf` is read straight
     *  off the user entry, so this is typically left null). */
    groupFilter: text("group_filter"),
    attributeMap: jsonb("attribute_map")
      .$type<{ email: string; firstName: string; lastName: string; groups: string }>()
      .notNull()
      .default({ email: "mail", firstName: "givenName", lastName: "sn", groups: "memberOf" }),
    defaultRoleId: text("default_role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    /** `{ "<directory-group>": "<role-id>" }`. Reconciled on every login. */
    groupsToRoles: jsonb("groups_to_roles").$type<Record<string, string>>(),
    /** Non-secret TLS knobs. `caPem` lives in `secrets`. */
    tlsOptions: jsonb("tls_options").$type<{ rejectUnauthorized?: boolean }>(),
    /** `{ bindPassword: "enc:v1:…", caPem?: "enc:v1:…" }` (AES-256-GCM). */
    secrets: jsonb("secrets").$type<Record<string, string>>().notNull().default({}),
    /** Optional allow-list of email domains. When set, usernames that look like
     *  emails must match before the LDAP roundtrip is attempted. */
    domainMatch: jsonb("domain_match").$type<string[]>(),
    /** Per-email rate limit. Failed bind attempts count too. */
    rateLimitPerMinute: integer("rate_limit_per_minute").notNull().default(10),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ldap_configs_tenant_idx").on(t.tenantId)],
);

/**
 * Instance-global SAML 2.0 IdP configuration for the **control plane** (admin
 * dashboard operators). Mirror of `saml_providers` minus `tenant_id`: admin SSO
 * is not workspace-scoped — one IdP set per instance. `slug` is unique
 * instance-wide and used in `/api/auth/saml/<slug>/...`. Identities provisioned
 * by these providers land in `users` (not `app_users`). See docs/auth-planes.md.
 */
export const platformSamlProviders = pgTable(
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
    attributeMap: jsonb("attribute_map")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    defaultRoleId: text("default_role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    /** Tenant-aware group→role map: `{ "<idp-group>": { tenantId, roleId } }`.
     *  Lets a platform operator's IdP group grant a role in a specific
     *  workspace (membership is ensured on login). */
    groupsToRoles: jsonb("groups_to_roles").$type<
      Record<string, { tenantId: string; roleId: string }>
    >(),
    signatureAlgorithm: text("signature_algorithm").notNull().default("sha256"),
    wantSignedAssertions: boolean("want_signed_assertions").notNull().default(true),
    linkByVerifiedEmail: boolean("link_by_verified_email").notNull().default(false),
    nameIdFormat: text("name_id_format").notNull().default("emailAddress"),
    /** Optional JIT allow-list: when set, only IdP-asserted emails whose domain
     *  is listed get a platform account provisioned. Empty/null = any email the
     *  IdP authenticates. */
    domainMatch: jsonb("domain_match").$type<string[]>(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("platform_saml_providers_slug_idx").on(t.slug)],
);

/**
 * Instance-global LDAP / AD configuration for the control plane. Singleton:
 * PK is the fixed `'singleton'` id. Mirror of `ldap_configs` minus tenant
 * scoping. NOTE: LDAP only runs on Bun / Node self-host — on Cloudflare Workers
 * (and other edge runtimes) `buildLdapAdapter` returns undefined, so this is a
 * self-host-only auth method (see apps/web/src/server/lib/auth-select.ts).
 */
export const platformLdapConfig = pgTable("platform_ldap_config", {
  id: text("id").primaryKey().default("singleton"),
  enabled: boolean("enabled").notNull().default(false),
  url: text("url").notNull(),
  bindDn: text("bind_dn").notNull(),
  baseDn: text("base_dn").notNull(),
  userFilter: text("user_filter")
    .notNull()
    .default("(&(objectClass=person)(uid={{username}}))"),
  groupFilter: text("group_filter"),
  attributeMap: jsonb("attribute_map")
    .$type<{ email: string; firstName: string; lastName: string; groups: string }>()
    .notNull()
    .default({ email: "mail", firstName: "givenName", lastName: "sn", groups: "memberOf" }),
  defaultRoleId: text("default_role_id").references(() => roles.id, {
    onDelete: "set null",
  }),
  /** Tenant-aware group→role map: `{ "<group>": { tenantId, roleId } }`. */
  groupsToRoles: jsonb("groups_to_roles").$type<
    Record<string, { tenantId: string; roleId: string }>
  >(),
  tlsOptions: jsonb("tls_options").$type<{ rejectUnauthorized?: boolean }>(),
  secrets: jsonb("secrets").$type<Record<string, string>>().notNull().default({}),
  domainMatch: jsonb("domain_match").$type<string[]>(),
  rateLimitPerMinute: integer("rate_limit_per_minute").notNull().default(10),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Federated identity link for the **platform** plane — maps an IdP subject to a
 * `users` row. Mirror of `external_identities` minus `tenant_id`/`plane`
 * (always platform here) with a real FK to `users`. Lookups go through the
 * `(provider_type, provider_id, subject)` unique index (instance-global).
 */
export const platformExternalIdentities = pgTable(
  "platform_external_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** saml | ldap. */
    providerType: text("provider_type").notNull(),
    /** For SAML: `platform_saml_providers.id`. For LDAP: the literal `"ldap"`. */
    providerId: text("provider_id").notNull(),
    /** SAML NameID or LDAP DN. */
    subject: text("subject").notNull(),
    emailAtProvision: text("email_at_provision"),
    rolesFromGroups: jsonb("roles_from_groups").$type<string[]>(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastLoginIp: text("last_login_ip"),
    lastAuthnContext: text("last_authn_context"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
export const emailConfig = pgTable(
  "email_config",
  {
    tenantId: text("tenant_id").primaryKey(),
    /** inherit | console | resend | sendgrid | mailgun | ses | smtp */
    provider: text("provider").notNull().default("inherit"),
    fromAddress: text("from_address"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    secrets: jsonb("secrets").$type<Record<string, string>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Per-workspace **bring-your-own** AI provider key. Same `tenant_id`-PK +
 * `_global` fallback pattern as `email_config`. When a workspace stores a usable
 * key here it overrides the deployment default for AI generation (Ask AI, the
 * `ai.*` MCP tools, auto-translate) — including on managed cloud, where it lets
 * a tenant opt out of the metered/capped platform gateway and bill their own
 * provider instead. `provider = "inherit"` (or no usable key) falls through to
 * the deployment's behaviour (cloud gateway on cloud, env keys on self-host).
 *
 * `provider` is `inherit` or an id from the server's provider registry
 * (`apps/web/src/server/services/ai-providers.ts`) — today `gateway` (Vercel AI
 * Gateway, multi-provider), `anthropic`, `openai`, `google`. `secrets` holds
 * the encrypted key material under that registry's per-provider key names
 * (`gatewayKey`, `anthropicKey`, `openaiKey`, `googleKey`) and is never
 * returned in the clear; because it is an opaque JSON blob, widening the
 * registry needs no migration. `config.model` optionally pins a default model
 * id (stored gateway-style, provider-prefixed).
 */
export const aiConfig = pgTable(
  "ai_config",
  {
    tenantId: text("tenant_id").primaryKey(),
    provider: text("provider").notNull().default("inherit"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    secrets: jsonb("secrets").$type<Record<string, string>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
export const workspaceConfig = pgTable(
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const backups = pgTable(
  "backups",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    /** auto | manual */
    kind: text("kind").notNull().default("manual"),
    label: text("label"),
    /** R2/S3 key where the dump lives. */
    storageKey: text("storage_key").notNull(),
    size: integer("size").notNull().default(0),
    tableCount: integer("table_count").notNull().default(0),
    /** queued | running | done | failed. */
    status: text("status").notNull().default("queued"),
    error: text("error"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("backups_tenant_idx").on(t.tenantId),
    index("backups_created_idx").on(t.createdAt),
  ],
);

/**
 * Third-party integrations (Slack/Discord/Datadog/GitHub) connected at the
 * workspace level. Data events fan out to them via @backlex/integrations.
 * `config` holds provider settings with secret fields encrypted at rest
 * (AUTH_SECRET); `events` null = all events, else a subscribed list.
 */
export const integrations = pgTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    kind: text("kind").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    events: jsonb("events").$type<string[] | null>(),
    /** `connected` while delivering; `disabled` once the breaker trips (or an
     *  admin pauses it). `dispatchIntegrations` only fans out to `connected`. */
    status: text("status").notNull().default("connected"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    /** Consecutive failed deliveries since the last success — drives the
     *  auto-disable circuit breaker. Reset to 0 on any success. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Timestamp of the most recent failed delivery (null once healthy). */
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    /** Human-readable reason set when the breaker auto-disables this
     *  integration; null while healthy or when paused manually. */
    disabledReason: text("disabled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("integrations_tenant_idx").on(t.tenantId)],
);

/**
 * One row per attempt to deliver an event to a connected integration — the
 * audit trail behind the admin's delivery log and the `integration.deliver`
 * job's retries. Mirrors `webhook_deliveries`, but carries `tenant_id` so a
 * workspace's log can be scoped without joining back to `integrations`.
 */
export const integrationDeliveries = pgTable(
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
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("integration_deliveries_integration_idx").on(t.integrationId),
    index("integration_deliveries_tenant_idx").on(t.tenantId),
    index("integration_deliveries_at_idx").on(t.deliveredAt),
  ],
);

/**
 * A connected payment provider (Stripe / Polar / Lemon Squeezy). Distinct from
 * `integrations` because the direction of travel is the opposite: the provider
 * pushes signed webhooks at us and we pull its objects back to reconcile.
 * `config` holds the API key + webhook secret encrypted at rest (AUTH_SECRET);
 * `webhook_token` is the public path segment of the receive URL and is
 * rotatable without touching the provider credentials.
 */
export const paymentProviders = pgTable(
  "payment_providers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    provider: text("provider").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("connected"),
    webhookToken: text("webhook_token").notNull(),
    /** Cursor per record kind, so an interrupted reconcile resumes. */
    syncCursor: jsonb("sync_cursor").$type<Record<string, string | null> | null>(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
export const paymentEvents = pgTable(
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
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
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
export const analyticsEvents = pgTable(
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
    props: jsonb("props").$type<Record<string, unknown> | null>(),
    path: text("path"),
    referrer: text("referrer"),
    /** `web` / `ios` / `android` / `server`, or any free-form client label. */
    source: text("source"),
    /** App or build version, so a metric shift can be tied to a release. */
    release: text("release"),
    country: text("country"),
    /** Event time. Client-supplied (offline queues replay late) but clamped
     *  server-side so a skewed clock can't park rows in the far future. */
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    /** UTC calendar day of `ts`, `YYYY-MM-DD`. Denormalized so funnel and
     *  retention cohorts group without dialect-specific date math — the same
     *  trick `usage_counters.day` uses. */
    day: text("day").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
 * unique index over the nullable `tenant_id`.
 */
export const errorGroups = pgTable(
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
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
export const errorEvents = pgTable(
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
    context: jsonb("context").$type<Record<string, unknown> | null>(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("error_events_group_ts_idx").on(t.groupId, t.ts),
    index("error_events_tenant_ts_idx").on(t.tenantId, t.ts),
  ],
);
