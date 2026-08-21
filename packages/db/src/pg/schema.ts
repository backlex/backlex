import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  doublePrecision,
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
    // Lockout state, added by better-auth 1.6.29's two-factor plugin. It counts
    // consecutive bad codes and, past the plugin's threshold, stamps
    // `locked_until` so further attempts are refused until it passes. The
    // adapter looks these up by the property name, so both must stay camelCase.
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
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
    /** May an **organization** admin bind this role to their own members?
     *
     *  Org-scoped grants (`app_org_member_roles`) are handed out from the app
     *  plane by a customer's own org admin, not by the operator. Without this
     *  flag the only role they couldn't grant was `admin`, so a role written
     *  for internal staff — "Support", reading every collection — was
     *  self-grantable by anyone who ran an org.
     *
     *  Defaults to false: a role is for the workspace unless its author says
     *  otherwise. The control plane (`/api/app-orgs`, GraphQL, MCP) ignores it
     *  entirely — an operator administering a customer's org may bind anything
     *  except `admin`, which stays barred everywhere. */
    orgAssignable: boolean("org_assignable").notNull().default(false),
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
    /**
     * Reachable by the workspace's END USERS (app plane), not just operators.
     *
     * Defaults to false, and that is load-bearing: a workspace's agents were
     * built when only operators could reach them, so some carry internal
     * prompts and privileged tools. Shipping an app-plane route must not
     * retroactively hand those to every signed-in end user — exposure is a
     * decision an operator makes per agent.
     */
    appAccess: boolean("app_access").notNull().default(false),
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
    /** Allow-list of top-level `data` keys this hook may carry. NULL/empty =
     *  the whole row (the default). An allow-list rather than a deny-list so a
     *  column added later never starts flowing to an endpoint configured before
     *  it existed. */
    payloadFields: jsonb("payload_fields").$type<string[] | null>(),
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
    /** How far a long-running job has got: `{done, total, phase, note}`. NULL
     *  until the handler reports once — a job that never reports is not
     *  "0% done", it simply does not answer the question. Written once per
     *  BATCH, never per row: a per-row write would cost more than the work. */
    progress: jsonb("progress").$type<unknown>(),
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
    /** The retention sweep's cutoff column. `revisions` is the fastest-growing
     *  table here (a full-row snapshot per update) and nothing pruned it before,
     *  so the prune needs the same indexed clock `activity` and `spans` have. */
    index("revisions_created_idx").on(t.createdAt),
    /** `recordRevision` looks up the newest revision for one item on EVERY
     *  write. `revisions_item_idx` narrows to the item but leaves an unindexed
     *  sort over a per-item set that only grows; with `created_at` trailing the
     *  key this is an index-only backwards scan with LIMIT 1. */
    index("revisions_item_created_idx").on(
      t.tenantId,
      t.collection,
      t.itemId,
      t.createdAt,
    ),
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
    /**
     * The operator behind an impersonated request, when there is one.
     *
     * A COLUMN rather than a key in `payload`, because the question it answers
     * — "what did support do while acting as a customer" — is a query, and a
     * JSON grep over every activity row is not one. `user_id` stays the
     * SUBJECT's: an impersonated write genuinely is theirs, which is what makes
     * it a faithful reproduction, and a log that recorded only one of the two
     * parties would answer the wrong half of the question.
     */
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
    aiTokensIn: bigint("ai_tokens_in", { mode: "number" }).notNull().default(0),
    aiTokensOut: bigint("ai_tokens_out", { mode: "number" }).notNull().default(0),
    /** Workers AI neurons, on the managed-cloud path. Zero elsewhere. */
    aiNeurons: bigint("ai_neurons", { mode: "number" }).notNull().default(0),
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

export const documentTemplates = pgTable(
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
    pageOptions: jsonb("page_options").$type<Record<string, unknown>>(),
    /** Suggested output name; templated like the body (`invoice-{{ data.no }}.pdf`). */
    filename: text("filename"),
    variables: jsonb("variables").$type<string[]>(),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("document_templates_tenant_key_idx").on(t.tenantId, t.key)],
);

export const signatureRequests = pgTable(
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
    pageOptions: jsonb("page_options").$type<Record<string, unknown>>(),
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
    ordered: boolean("ordered").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    /** `{ collection, id, field }` — where the signed document's key lands. */
    writeBack: jsonb("write_back").$type<Record<string, unknown> | null>(),
    /** Extra addresses that receive the completed copy. */
    notifyEmails: jsonb("notify_emails").$type<string[]>(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("signature_requests_tenant_idx").on(t.tenantId),
    index("signature_requests_status_idx").on(t.tenantId, t.status),
  ],
);

export const signatureSigners = pgTable(
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
    sentAt: timestamp("sent_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("signature_signers_token_idx").on(t.tokenHash),
    index("signature_signers_request_idx").on(t.requestId, t.orderIndex),
  ],
);

/**
 * A record waiting on a human decision. SQLite/D1 twin:
 * packages/db/src/sqlite/schema.ts, where the column-level reasoning lives.
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    title: text("title").notNull(),
    message: text("message"),
    subjectCollection: text("subject_collection"),
    subjectId: text("subject_id"),
    summary: jsonb("summary").$type<unknown[]>(),
    /** all | any | quorum */
    policy: text("policy").notNull().default("all"),
    quorum: integer("quorum").notNull().default(1),
    ordered: boolean("ordered").notNull().default(false),
    /** pending | approved | rejected | expired | cancelled. Expiry IS written
     *  here (unlike a signature request) because it has to resume a waiting
     *  flow down its rejected branch. */
    status: text("status").notNull().default("pending"),
    continuation: jsonb("continuation").$type<unknown>(),
    timeoutTaskId: text("timeout_task_id"),
    writeBack: jsonb("write_back").$type<Record<string, unknown> | null>(),
    notifyEmails: jsonb("notify_emails").$type<string[]>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    outcomeReason: text("outcome_reason"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("approval_requests_tenant_idx").on(t.tenantId),
    index("approval_requests_status_idx").on(t.tenantId, t.status),
    index("approval_requests_subject_idx").on(t.subjectCollection, t.subjectId),
  ],
);

export const approvalApprovers = pgTable(
  "approval_approvers",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    role: text("role"),
    orderIndex: integer("order_index").notNull().default(0),
    tokenHash: text("token_hash").notNull(),
    /** pending | viewed | approved | rejected */
    status: text("status").notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: text("reason"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("approval_approvers_token_idx").on(t.tokenHash),
    index("approval_approvers_request_idx").on(t.requestId, t.orderIndex),
  ],
);

/**
 * A bookable thing — a dentist, a court, a viewing agent, a table by the window.
 * SQLite/D1 twin: packages/db/src/sqlite/schema.ts, where the column-level
 * reasoning lives.
 *
 * Everything on the row is POLICY — duration, capacity, notice, horizon. The
 * opening pattern lives in `booking_rules` and the slots are computed from
 * both, never stored: a stored slot table has to be regenerated every time a
 * rule moves, and is wrong in the meantime.
 */
export const bookingResources = pgTable(
  "booking_resources",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** IANA zone the RULES are written in — the only thing that can settle
     *  which instant "Mondays 09:00" names. */
    timeZone: text("time_zone").notNull().default("UTC"),
    slotMinutes: integer("slot_minutes").notNull().default(30),
    stepMinutes: integer("step_minutes"),
    capacity: integer("capacity").notNull().default(1),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    leadMinutes: integer("lead_minutes").notNull().default(0),
    horizonDays: integer("horizon_days").notNull().default(60),
    holdMinutes: integer("hold_minutes").notNull().default(10),
    questions: jsonb("questions").$type<Array<Record<string, unknown>>>(),
    /** Public page appearance: `{ theme, accent, font }` — the same vocabulary
     *  `forms.settings` stores, so both pages are themed one way. */
    settings: jsonb("settings").$type<Record<string, unknown> | null>(),
    /** Whether bookings are recorded in a collection at all — on by default. */
    mirrorEnabled: boolean("mirror_enabled").notNull().default(true),
    /** NULL means the provisioned default (`booking_records`); a value points at
     *  a collection the workspace owns, and only then is `mirrorFieldMap` read. */
    mirrorCollection: text("mirror_collection"),
    mirrorFieldMap: jsonb("mirror_field_map").$type<Record<string, string> | null>(),
    /** SHA-256 of the public page token (`bkg_<hex>`), shown once on create. */
    tokenHash: text("token_hash").notNull(),
    active: boolean("active").notNull().default(true),
    confirmationMessage: text("confirmation_message"),
    notifyEmails: jsonb("notify_emails").$type<string[]>(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("booking_resources_tenant_key_idx").on(t.tenantId, t.key),
    uniqueIndex("booking_resources_token_idx").on(t.tokenHash),
    index("booking_resources_tenant_idx").on(t.tenantId),
  ],
);

/**
 * One line of an opening pattern, or one exception to it. Times are minutes
 * from LOCAL midnight, never instants; a shift crossing midnight is two rules.
 */
export const bookingRules = pgTable(
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
    /** `YYYY-MM-DD`, inclusive. TEXT rather than `date` so it cannot shift with
     *  an offset — a rule bound is a calendar date, not an instant. */
    startsOn: text("starts_on"),
    endsOn: text("ends_on"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("booking_rules_resource_idx").on(t.resourceId, t.kind)],
);

/**
 * A taken slot. `held` occupies the slot exactly like `confirmed` does, but
 * only until `hold_expires_at`; that expiry — and `completed`, a confirmed
 * booking whose end has passed — are DERIVED at read time rather than swept by
 * a job, so a wedged cron cannot keep a slot closed.
 */
export const bookings = pgTable(
  "bookings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    resourceId: text("resource_id").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    /** held | confirmed | cancelled | no_show | expired. `completed` is always
     *  derived; `expired` is derived for reads and only written lazily, by a
     *  writer that needs the seat back. */
    status: text("status").notNull().default("confirmed"),
    /** Which of the resource's `capacity` places this booking holds, 0-based —
     *  the column the partial unique index below turns into a hard capacity
     *  guarantee the database enforces atomically. */
    seat: integer("seat").notNull().default(0),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    customerName: text("customer_name"),
    customerEmail: text("customer_email"),
    customerPhone: text("customer_phone"),
    answers: jsonb("answers").$type<Record<string, unknown> | null>(),
    notes: text("notes"),
    /** SHA-256 of the manage link token — the entire grant to cancel or
     *  reschedule, so the plaintext is never at rest. */
    tokenHash: text("token_hash").notNull(),
    mirrorCollection: text("mirror_collection"),
    mirrorItemId: text("mirror_item_id"),
    /** Why the last recording attempt failed, when it did. Cleared by the next
     *  success — recording is best-effort, so the failure has to be legible. */
    mirrorError: text("mirror_error"),
    /** public | admin | api */
    source: text("source").notNull().default("public"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    cancelledBy: text("cancelled_by"),
    /** Set on the row a reschedule REPLACED, so the trail survives. */
    rescheduledToId: text("rescheduled_to_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("bookings_token_idx").on(t.tokenHash),
    // The hard capacity guarantee — partial, so a cancelled or expired booking
    // gives its seat back without any row having to move.
    uniqueIndex("bookings_seat_idx")
      .on(t.resourceId, t.startAt, t.seat)
      .where(sql`status IN ('held','confirmed')`),
    index("bookings_resource_start_idx").on(t.resourceId, t.startAt),
    index("bookings_tenant_status_idx").on(t.tenantId, t.status),
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
export const kpis = pgTable(
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
    filter: jsonb("filter").$type<Record<string, unknown> | null>(),
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
    alertValue: doublePrecision("alert_value"),
    /** Whether the KPI is currently breaching — what makes the alert fire on
     *  the transition rather than on every scheduler tick. */
    alertFiring: boolean("alert_firing").notNull().default(false),
    /** The collection whose ITEM PAGE this tile belongs on — not the one the
     *  KPI aggregates. "Revenue per product" sums order lines and belongs on a
     *  product. */
    pinTo: text("pin_to"),
    /** The relation column on the KPI's own collection pointing back at that
     *  row, so the server never guesses which relation the pin meant. */
    pinField: text("pin_field"),
    alertLastFiredAt: timestamp("alert_last_fired_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

/**
 * One invitation to answer a form — the shape that makes "one response per
 * person" mean a person.
 *
 * The form's own token is a door anyone with the link walks through, which is
 * why the cookie guard beside it is a courtesy and not a count. An invite is
 * per-recipient and single-use: `used_at` is written by the submit that spends
 * it, in an UPDATE conditional on the column still being null, so two tabs
 * racing the same link produce one answer.
 *
 * Same token discipline as `approval_approvers` and `signature_requests`: only
 * the SHA-256 lands here, the plaintext is returned once at mint time.
 */
export const formInvites = pgTable(
  "form_invites",
  {
    id: text("id").primaryKey(),
    formId: text("form_id").notNull(),
    tenantId: text("tenant_id"),
    /** Who it was minted for. Null for a batch of unaddressed links an
     *  operator hands out themselves. */
    email: text("email"),
    name: text("name"),
    /** The link it was minted with. Reminders mint more, and those live in
     *  `form_invite_tokens` — all of them open this one turn. */
    tokenHash: text("token_hash").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    /** When a reminder last went out, and how many have. Both are about the
     *  invite and not about a link: a reminder mints another way in to the
     *  same turn. */
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    reminderCount: integer("reminder_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The token IS the grant, so its lookup must be unique — two invites
    // sharing one would let either answer as the other.
    uniqueIndex("form_invites_token_idx").on(t.tokenHash),
    index("form_invites_form_idx").on(t.formId),
    index("form_invites_tenant_idx").on(t.tenantId),
  ],
);

/**
 * A LATER link into an invite — the ones a reminder mints.
 *
 * An invite is a turn, not a link. It gets more than one because the plaintext
 * token is never stored, only its SHA-256, so a reminder cannot re-send the
 * link that was mailed and has to mint another. Rotating the invite's own token
 * instead would kill the link in the first mail, in front of exactly the person
 * the reminder is trying to reach.
 *
 * The first link stays on the invite (`form_invites.token_hash`) and every one
 * after it lands here. All of them open the same turn; spending any one spends
 * it (`form_invites.used_at`) and the rest stop working with it. Uniqueness is
 * still global — two links resolving to two different turns would let either
 * answer as the other.
 */
export const formInviteTokens = pgTable(
  "form_invite_tokens",
  {
    id: text("id").primaryKey(),
    inviteId: text("invite_id").notNull(),
    /** Denormalised from the invite so the lookup can be scoped to one form
     *  without a join — an invite to the staff survey must not open the
     *  customer one. */
    formId: text("form_id").notNull(),
    tenantId: text("tenant_id"),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("form_invite_tokens_hash_idx").on(t.tokenHash),
    index("form_invite_tokens_invite_idx").on(t.inviteId),
    index("form_invite_tokens_form_idx").on(t.formId),
  ],
);

/**
 * A half-filled form, kept so the person can come back to it.
 *
 * Opt-in per form (`settings.saveProgress`) — a form that does not ask for this
 * stores nothing. The row is found by `key_hash`: the SHA-256 of whatever the
 * visitor holds, which is an opaque cookie value for an open link and the
 * invite token for an invited one. Only the hash lands here, exactly as for
 * `form_invites`, so the table is a pile of answers nobody can look up without
 * the secret that wrote them.
 *
 * The submit that completes the form deletes its draft; the cron sweep deletes
 * the ones that were abandoned.
 */
export const formDrafts = pgTable(
  "form_drafts",
  {
    id: text("id").primaryKey(),
    formId: text("form_id").notNull(),
    tenantId: text("tenant_id"),
    /** SHA-256 of the resume secret — never the secret itself. */
    keyHash: text("key_hash").notNull(),
    /** Answers so far, clamped to the form's currently-exposed fields. */
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    /** Step page the visitor had reached, so they return to it and not to the
     *  first question of a form they are two-thirds through. */
    step: integer("step").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One draft per (form, holder): the upsert targets this, so two tabs of the
    // same visitor race into one row instead of forking the answers.
    uniqueIndex("form_drafts_key_idx").on(t.formId, t.keyHash),
    index("form_drafts_form_idx").on(t.formId),
    index("form_drafts_updated_idx").on(t.updatedAt),
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
    /** Captcha configuration: `{ provider, siteKey, secretKey (enc:v1:…),
     *  protect: [...], onError }`. Its own column rather than another key under
     *  `providers`, because a captcha is not a way to sign in — it gates the
     *  ones that are. NULL = no captcha. */
    captcha: jsonb("captcha").$type<Record<string, unknown> | null>(),
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
 * An external issuer whose JWTs this workspace accepts **as they are** —
 * Clerk, Auth0, Firebase Auth, AWS Cognito, WorkOS, or any OIDC provider.
 *
 * This is not `oidc_providers`, and the difference is the whole point.
 * `oidc_providers` makes backlex an OAuth *client*: the user is redirected to
 * the IdP, we exchange a code, and we mint our own session. That requires a
 * client secret and a second login. Here the app **already holds** a token
 * from its own auth provider and simply sends it to us; we verify the
 * signature against the issuer's published JWKS and map the subject onto an
 * `app_users` row. No redirect, no client secret, no migration of anyone's
 * user table.
 *
 * `issuer` is unique **instance-wide**, not per tenant: a request carrying one
 * of these tokens has no session and no workspace header to lean on, so the
 * `iss` claim is the only thing that can name the workspace. In practice
 * issuers are already customer-specific (`https://<x>.clerk.accounts.dev`,
 * `https://securetoken.google.com/<project>`, `https://<t>.auth0.com/`), so
 * this costs nothing real.
 *
 * The claim-mapping columns deliberately carry the same names and defaults as
 * `oidc_providers` — both feed the same `provisionAppUser`, and two spellings
 * of "which claim holds the email" is how they would drift apart.
 */
export const thirdPartyAuthProviders = pgTable(
  "third_party_auth_providers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Display name, shown in the admin list. */
    name: text("name").notNull(),
    /** URL-safe handle, scoped within the tenant. */
    slug: text("slug").notNull(),
    /** Exact `iss` claim value to match. Instance-wide unique — see above. */
    issuer: text("issuer").notNull(),
    /** Where the signing public keys live. Resolved from `discovery_url` at
     *  save time when one was given. */
    jwksUrl: text("jwks_url").notNull(),
    /** `.well-known/openid-configuration`, kept so a re-resolve can refresh
     *  `jwks_url` if the IdP moves it. */
    discoveryUrl: text("discovery_url"),
    /** Expected `aud`. Null accepts any audience — fine when the issuer is
     *  yours alone, wrong when one IdP serves several relying parties. */
    audience: text("audience"),
    /** Claim carrying the IdP's stable subject id. */
    subjectClaim: text("subject_claim").notNull().default("sub"),
    emailClaim: text("email_claim").notNull().default("email"),
    nameClaim: text("name_claim"),
    groupsClaim: text("groups_claim"),
    groupsToRoles: jsonb("groups_to_roles").$type<Record<string, string>>(),
    defaultRoleId: text("default_role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    /** Attach to an existing `app_users` row matching the asserted email.
     *  Off by default: an issuer that does not verify emails would otherwise
     *  let a new token take over an existing account. */
    linkByVerifiedEmail: boolean("link_by_verified_email").notNull().default(false),
    /** When false, a subject with no linked identity is rejected instead of
     *  provisioned — the right setting when SCIM owns the user lifecycle. */
    autoProvision: boolean("auto_provision").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
 * An AUTH hook — the app participating in its own end-users' authentication.
 *
 * `sync_hooks` above lets an app take part in an item write; flow triggers see
 * item / cron / manual / webhook events. Neither can reach the four moments
 * that decide who an end-user *is*: nothing could put `plan` or `tenant` into
 * an access token, veto a sign-up on the app's own rules, react to a password
 * check, or deliver an auth mail through the app's own transport.
 *
 * Scoped to the **workspace (app) plane** — the `app_users` pool behind
 * `/api/t/<slug>/auth/*`. The platform plane (the operators who administer
 * backlex itself) is deliberately not hookable: a workspace admin is a customer
 * on managed cloud, and a hook there would let one customer observe and veto
 * the operator sign-ins of the instance they live on.
 *
 * At most ONE hook per (workspace, event). Each event carries a different
 * payload and a different verdict, so a hook subscribing to several would have
 * to implement four contracts; and two hooks answering `custom-access-token`
 * would fight over the same claim. Chaining belongs in the app's own endpoint.
 */
export const authHooks = pgTable(
  "auth_hooks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** `before-user-created` | `custom-access-token` | `password-verification`
     *  | `send-email`. One row per event per workspace. */
    event: text("event").notNull(),
    /** `url` — an HTTPS endpoint, called with Standard Webhooks headers.
     *  `function` — a backlex function, run in the sandbox with no network hop.
     *  The latter exists for `custom-access-token`, which sits on the token
     *  mint path where a round trip is the dominant cost. */
    targetType: text("target_type").notNull(),
    url: text("url"),
    functionName: text("function_name"),
    /** Standard Webhooks signing secret (`whsec_<base64>`), so the app can
     *  prove the call came from us. Write-only — never read back. */
    secret: text("secret"),
    headers: jsonb("headers").$type<Record<string, string> | null>(),
    /** Hard ceiling on how long an auth request may block on this hook. */
    timeoutMs: integer("timeout_ms").notNull().default(2000),
    /**
     * What happens when the hook cannot answer. No default, for the same
     * reason `sync_hooks.on_error` has none — and the stakes here are higher:
     * a `custom-access-token` hook failing open mints a token MISSING the
     * claim a downstream authorizer reads, and an absent `plan` claim is the
     * shape most apps treat as "free tier" rather than "unknown".
     */
    onError: text("on_error").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_hooks_tenant_event_idx").on(t.tenantId, t.event),
    index("auth_hooks_tenant_idx").on(t.tenantId),
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
    /**
     * Comma-separated tables named in the dump that did not exist in this
     * database, so contributed no rows.
     *
     * The dump used to swallow every read error, making "absent" and "could not
     * be read" the same silent outcome on a backup that still reported `done`.
     * Absence lands here; a real read failure now fails the backup.
     */
    missingTables: text("missing_tables"),
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
    revenue: bigint("revenue", { mode: "number" }),
    /** ISO-4217 code for `revenue`. Reports group by it and never sum across
     *  it — this repo has no FX rate source, and a silently mixed total is
     *  worse than no total. */
    currency: text("currency"),
    /** Event time. Client-supplied (offline queues replay late) but clamped
     *  server-side so a skewed clock can't park rows in the far future. */
    ts: timestamp("ts", { withTimezone: true }).notNull(),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
export const analyticsSites = pgTable(
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
    excludedPaths: jsonb("excluded_paths").$type<string[] | null>(),
    /** Source IPs never recorded — the office, a monitoring probe. Matched
     *  against the request IP, which is used and discarded either way. */
    ignoredIps: jsonb("ignored_ips").$type<string[] | null>(),
    /** Drop declared crawlers instead of labelling them `bot`. */
    filterBots: boolean("filter_bots").notNull().default(true),
    requireKnownOrigin: boolean("require_known_origin").notNull().default(true),
    /** ── Tag manager ──────────────────────────────────────────────────
     *  May this site run operator-authored code (a custom HTML/JS tag, or a
     *  `js_expression` variable)? Default false, and deliberately per-site:
     *  a custom tag is arbitrary JavaScript on a public website, so it stays
     *  off until somebody turns it on for a site they mean to turn it on for. */
    allowCustomCode: boolean("allow_custom_code").notNull().default(false),
    /** The container version currently served, and the row it was compiled
     *  into. Null until the first publish — a site that has never published
     *  serves the tracker alone, which is exactly what it does today. */
    publishedVersion: integer("published_version"),
    publishedVersionId: text("published_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
export const analyticsSegments = pgTable(
  "analytics_segments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    /** Optional: scope the segment to one registered site. */
    siteId: text("site_id"),
    name: text("name").notNull(),
    definition: jsonb("definition").$type<unknown>(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("analytics_segments_tenant_idx").on(t.tenantId, t.siteId)],
);


/**
 * The cookie-consent policy a site publishes — one row per site, and the
 * primary key says so.
 *
 * `site_id` is the primary key rather than a `text("id")` with a unique index
 * beside it, because "exactly one consent policy per site" is an invariant
 * worth encoding structurally rather than enforcing in a service. It also
 * removes a race this repo has already been bitten by: a check-then-insert
 * around a separate unique column loses to a concurrent writer and surfaces as
 * an intermittent 500, whereas `onConflictDoUpdate` against a primary key is
 * one atomic statement.
 *
 * ## Two columns have no default, deliberately
 *
 * `undecided_behaviour` and `tracker_category` follow the reasoning written
 * out in `services/captcha.ts` for `onError`: when neither answer is safe to
 * pick on an operator's behalf, the choice is theirs and it is written down
 * next to its consequence. Here the consequence is legal rather than
 * operational, which makes defaulting worse, not better — a silent default is
 * a compliance posture nobody chose.
 *
 * - `undecided_behaviour = "block"` — nothing optional fires until the visitor
 *   decides. Correct under GDPR/ePrivacy; costs measurement on every visitor
 *   who ignores the banner.
 * - `undecided_behaviour = "allow"` — optional tags fire until the visitor
 *   declines. The CCPA/CPRA opt-out model, and **not lawful in the EU**.
 * - `tracker_category = "none"` — backlex's own cookieless tag counts as
 *   strictly necessary and measures everyone. Defensible because that tag
 *   stores nothing on the device and its visitor id is server-derived and
 *   rotates daily, so ePrivacy Art. 5(3) — which is triggered by storing or
 *   accessing information on the visitor's equipment — is arguably not
 *   triggered at all. That is a legal position, not a fact, and it varies by
 *   member state.
 * - `tracker_category = "analytics"` — the tag is gated like any other
 *   analytics tag.
 *
 * ## The wording is server-owned
 *
 * `wording` is stored here and served from the published artifact, never
 * supplied by the page. The principle is the one `docs/e-signature.md` states
 * for signature consent: if the browser supplies the text, the person being
 * held to the record is the one choosing what the evidence says they agreed
 * to.
 */
export const consentPolicies = pgTable(
  "consent_policies",
  {
    /** The site this policy governs. PK — see the note above. */
    siteId: text("site_id").primaryKey(),
    tenantId: text("tenant_id"),
    /** Which optional categories the banner offers. A LIST, not a switch, for
     *  the same reason `captcha.protect` is one: a site running only a support
     *  widget should not be made to ask about advertising it does not do.
     *  `none` never appears here — strictly-necessary is not a choice. */
    categoriesOffered: jsonb("categories_offered").$type<string[] | null>(),
    /** `"block" | "allow"`. No default — see the note above. */
    undecidedBehaviour: text("undecided_behaviour").notNull(),
    /** `"none" | "analytics"`. No default — see the note above. */
    trackerCategory: text("tracker_category").notNull(),
    /** Per-locale banner copy: `{ en: {...}, tr: {...} }`. Server-owned; the
     *  page never supplies it. */
    wording: jsonb("wording").$type<Record<string, Record<string, string>> | null>(),
    defaultLocale: text("default_locale").notNull().default("en"),
    /** The operator's own privacy/cookie policy, linked from the banner. */
    policyUrl: text("policy_url"),
    /** `"bottom" | "top" | "corner"`. */
    position: text("position").notNull().default("bottom"),
    /** Colours and radius, as a flat token map the banner inlines. */
    theme: jsonb("theme").$type<Record<string, string> | null>(),
    /** How long a visitor's decision stands before they are asked again. The
     *  CNIL's guidance is 6 months, which is where 180 comes from. */
    cookieMaxAgeDays: integer("cookie_max_age_days").notNull().default(180),
    /** Whether the banner is served at all. A site can hold a configured
     *  policy without showing anything yet. */
    enabled: boolean("enabled").notNull().default(false),
    /** Content hash of the artifact this policy currently compiles to.
     *
     *  DERIVED, not a pointer. It is recomputed from the resolved row on every
     *  save and always agrees with what the config route serves, which is why
     *  it can be last-writer-wins. A `published_version_id` pointer was the
     *  obvious shape and is deliberately absent: it would introduce a second
     *  meaning of "live" that can disagree with `enabled`, and there is no
     *  draft state here for it to point past. Nullable because the migration
     *  cannot compute a SHA-256 for rows that already exist; nothing on the
     *  read path depends on it, so a NULL is inert until the next save. */
    artifactHash: text("artifact_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("consent_policies_tenant_idx").on(t.tenantId)],
);

/**
 * Every distinct artifact a site's consent policy has ever compiled to.
 *
 * This exists so "which version did they agree to" has an answer that cannot
 * be edited afterwards. A consent record (a later phase) stores the hash it
 * showed the visitor; this table is what that hash resolves to. Without it the
 * evidence is a pointer into mutable state, which is no evidence at all.
 *
 * **Content-addressed, not counter-versioned** — and that is the difference
 * from `tag_versions`, which this otherwise mirrors. A tag container has a
 * draft the operator publishes, so a monotonic `version` is the number they
 * roll back to. A consent policy has no draft: `consent_policies` is one row
 * per site and `enabled` is the live switch. So there is nothing to publish,
 * nothing to roll back to, and a counter would only be a race — the tag
 * manager's `max(version) + 1` is an unguarded check-then-insert whose only
 * guard is its unique index. Keying on `(site_id, hash)` removes the race and
 * makes a repeated or reverted save a free no-op insert.
 *
 * No foreign key, matching every table in this block: D1 runs with foreign
 * keys off, so a constraint that exists only on Postgres is a dialect
 * difference pretending to be an invariant. The cascade is in the service.
 */
export const consentVersions = pgTable(
  "consent_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    siteId: text("site_id").notNull(),
    /** SHA-256 of the canonical artifact JSON. This is the ETag. */
    hash: text("hash").notNull(),
    /** The compiled artifact, exactly as the config route serves it. */
    snapshot: jsonb("snapshot").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // No `updated_at`: the row is immutable by construction. Uniqueness on
  // (site, hash) is what makes re-saving identical content free.
  (t) => [uniqueIndex("consent_versions_site_hash_idx").on(t.siteId, t.hash)],
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
export const tagVariables = pgTable(
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
    config: jsonb("config").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tag_variables_site_idx").on(t.siteId),
    uniqueIndex("tag_variables_site_key_idx").on(t.siteId, t.key),
  ],
);

export const tagTriggers = pgTable(
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
    config: jsonb("config").$type<unknown>(),
    /** Optional predicate tree narrowing when the trigger fires. Same node
     *  grammar as an analytics segment; evaluated in the browser rather than
     *  compiled to SQL. */
    condition: jsonb("condition").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tag_triggers_site_idx").on(t.siteId)],
);

export const tagDefinitions = pgTable(
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
    params: jsonb("params").$type<unknown>(),
    /** Trigger ids that fire this tag, and ids that suppress it. Arrays
     *  rather than a join table because nothing ever groups or filters by
     *  them, and the published artifact is one JSON document either way. */
    triggerIds: jsonb("trigger_ids").$type<string[] | null>(),
    blockingTriggerIds: jsonb("blocking_trigger_ids").$type<string[] | null>(),
    /** `none` | `functional` | `analytics` | `marketing`, gated against the
     *  signals the tracker already reads. Defaults to the strictest useful
     *  answer: most tags an operator adds here are advertising tags. */
    consentCategory: text("consent_category").notNull().default("marketing"),
    /** `always` | `once_per_page` | `once_per_visitor_day`. */
    fireRule: text("fire_rule").notNull().default("always"),
    /** Higher fires first within one trigger. */
    priority: integer("priority").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tag_definitions_site_idx").on(t.siteId)],
);

export const tagVersions = pgTable(
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
    snapshot: jsonb("snapshot").$type<unknown>().notNull(),
    /** Content hash of `snapshot` — this is the ETag. */
    hash: text("hash").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
 * Mirror of the SQLite table.
 */
export const integrationOauthStates = pgTable(
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
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
 * in. Mirror of the SQLite table.
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
export const integrationTaskRuns = pgTable(
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
    outputs: jsonb("outputs").$type<Record<string, unknown>>().notNull().default({}),
    /** Storage key of the artifact this run produced, when it produced one. */
    artifactKey: text("artifact_key"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

export const integrationSyncs = pgTable(
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
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    /** Field mapping. Read in the direction of travel: `external → field` on a
     *  pull, `field → external column` on a push. Unmapped keys are dropped. */
    mapping: jsonb("mapping").$type<Record<string, string>>().notNull().default({}),
    /**
     * Where a source record's CHILD rows land. Pull only.
     *
     * A marketplace order is a header plus its lines, and a flat mapping can
     * only describe the header — the lines would have to be flattened into
     * numbered columns or dropped. Keyed by the group name the provider hands
     * back on `SourceRecord.children`, so one order can fan out to more than
     * one child collection.
     */
    childMappings: jsonb("child_mappings")
      .$type<Record<string, { collection: string; parentField: string; mapping: Record<string, string> }>>()
      .notNull()
      .default({}),
    /** How often the scheduler runs it. 0 = manual only. */
    intervalMinutes: integer("interval_minutes").notNull().default(60),
    enabled: boolean("enabled").notNull().default(true),
    /** Provider resume token; null starts from the beginning. */
    cursor: text("cursor"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
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
    webhookEvents: jsonb("webhook_events").$type<string[]>().notNull().default([]),
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
    outputsMapping: jsonb("outputs_mapping").$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
export const integrationWebhookDeliveries = pgTable(
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
 */
export const integrationListingMaps = pgTable(
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
    attributes: jsonb("attributes")
      .$type<Record<string, { valueId?: string; custom?: string; field?: string }>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
 */
export const integrationListingBatches = pgTable(
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
    sent: jsonb("sent")
      .$type<Record<string, { rowId: string; collection: string }>>()
      .notNull()
      .default({}),
    /** How many units this batch is still waiting on. */
    pendingCount: integer("pending_count").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when nothing is pending. The sweep reads `status`, not this. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
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
 * Mirror of the SQLite table.
 */
export const erasureRequests = pgTable(
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
    plan: jsonb("plan").$type<Record<string, unknown> | null>(),
    /** What the run actually did, in the same shape as `plan`. */
    report: jsonb("report").$type<Record<string, unknown> | null>(),
    error: text("error"),
    /** The operator's own ticket / case id. Free text, and theirs to manage. */
    reference: text("reference"),
    /** Admin who filed it — an erasure needs an accountable requester. */
    requestedBy: text("requested_by"),
    previewedAt: timestamp("previewed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("erasure_requests_tenant_idx").on(t.tenantId),
    // "Has this person asked before?" is a lookup by hash within a workspace.
    index("erasure_requests_subject_idx").on(t.tenantId, t.subjectHash),
  ],
);

/**
 * One row per (schedule flow, subject row, fire instant) that has been
 * dispatched.
 *
 * This table IS the exactly-once guarantee for date-relative triggers, and it
 * exists because a time window alone cannot be one. The scan deliberately looks
 * back over a two-day catch-up window so a restart or a cold serverless gap
 * cannot silently drop a reminder; that same catch-up means every tick re-sees
 * rows it has already fired. Something has to remember, durably and across
 * processes, and a unique index is the only thing here that can — the same
 * reasoning as the booking seat index, one table over.
 *
 * The claim is INSERT-then-run: whoever wins the insert owns the dispatch, and
 * a loser does nothing. That ordering matters. Running first and recording
 * afterwards would send twice whenever two instances tick together, and the
 * operations behind a flow are arbitrary — a second email, a second charge.
 *
 * `fire_at` is in the key rather than just (flow, row) so that moving a due
 * date is honoured: the new instant is a new claim, while a row nobody touched
 * keeps colliding with the one already there. Rows age out of the prune sweep
 * once they fall behind the catch-up window, where they can never be selected
 * again.
 */
export const flowScheduleFires = pgTable(
  "flow_schedule_fires",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    flowId: text("flow_id").notNull(),
    /** Primary key of the row the run was about, as text — a collection's PK
     *  may be uuid, text or integer, and the ledger only ever compares it. */
    rowId: text("row_id").notNull(),
    fireAt: timestamp("fire_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
 * The counter is bumped by a single `INSERT … ON CONFLICT DO UPDATE SET
 * last_value = last_value + n RETURNING last_value`. One statement, evaluated
 * by the database, so two concurrent inserts cannot read the same "before"
 * value and both claim it — the same reasoning the rollup refresh is built on,
 * and the same reasoning behind every check-then-insert bug this repo has
 * already paid for once.
 *
 * `tenant_id` and `scope` are NOT NULL with `''` meaning "none". Every
 * neighbouring table leaves `tenant_id` nullable, so the difference is worth
 * stating: a unique index treats NULLs as DISTINCT in both dialects, so a
 * nullable key column would let a second counter row be created beside the
 * first. `ON CONFLICT` would then never match, every insert would allocate a
 * fresh row at `start`, and every document would carry the same number — a
 * failure that only shows up on an install with no tenant, which is exactly
 * where nobody is looking.
 *
 * There is no scheduled reset. A yearly sequence does not notice January; it
 * asks for the bucket named `2027`, finds nothing there, and starts at `start`.
 * Nothing has to run at midnight, so nothing can fail to.
 */
export const sequences = pgTable(
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
    lastValue: bigint("last_value", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sequences_key_idx").on(t.tenantId, t.collection, t.field, t.scope),
  ],
);

/**
 * A broadcast channel RULE — who may subscribe to, and who may publish on, a
 * free-form realtime channel.
 *
 * ## Why this table exists
 *
 * `items:*`, `signal:items:*`, `collab:*`, `presence:*`, `agent:thread:*` and
 * `collections` each carry their own permission gate. Everything else — every
 * channel name an application might invent for a chat room, a cursor feed or a
 * notification bus — fell through to a branch that returned an empty gate: no
 * sign-in required to subscribe, no sign-in required to publish. That is not a
 * pub/sub system an application can put anything real on, so applications
 * reached for Ably instead.
 *
 * A rule is matched by PATTERN, not by exact name, because the channels an app
 * invents are per-room (`room:42`) and enumerating them is the app's job, not
 * the operator's. The grammar is closed on purpose (literal / `*` / `**` /
 * `{name}`) so a pattern can be DECODED as well as matched — a `{name}` segment
 * captures the value into `$channel.<name>`, which is what lets one rule say
 * "you may subscribe to `org:{org}:feed` when `{org}` is an org you belong to".
 *
 * `subscribe` and `publish` are stored as whole JSON objects rather than as a
 * roles column plus a condition column, because "who" has FOUR answers and two
 * nullable columns can only spell three. See `services/broadcast.ts`.
 */
export const broadcastChannels = pgTable(
  "broadcast_channels",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Operator-facing label. The pattern is the identity. */
    name: text("name").notNull(),
    /** Closed grammar: `chat:*`, `org:{org}:feed`, `logs:**`. */
    pattern: text("pattern").notNull(),
    /** `{ access: "none" | "public" | "authenticated" | "roles", roles?, condition? }`,
     *  serialized. TEXT rather than `jsonb` so that BOTH dialects hand the
     *  application a string and one `readAccess` decides what an unparseable
     *  rule means. With a driver-parsed column the SQLite twin throws inside
     *  the row mapper, where no fail-closed default can be applied. */
    subscribe: text("subscribe").notNull(),
    publish: text("publish").notNull(),
    /** Members may announce themselves on this channel (stateless roster —
     *  hello/ping/bye, same protocol `collab:*` uses, so it works on every
     *  transport rather than only the two that can hold a server-side roster). */
    presence: boolean("presence").notNull().default(false),
    /** Persist messages so a late or reconnecting subscriber can read the
     *  recent past back over REST. */
    replay: boolean("replay").notNull().default(false),
    /** How far back `replay` reaches. Capped at 72h — see the messages table. */
    retentionHours: integer("retention_hours").notNull().default(24),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("broadcast_channels_pattern_idx").on(t.tenantId, t.pattern),
    index("broadcast_channels_tenant_idx").on(t.tenantId),
  ],
);

/**
 * A retained broadcast message, for `GET /api/realtime/{channel}/replay`.
 *
 * `day` is the coarse partition key. Supabase drops a day-partitioned table
 * after three days; we cannot partition (D1 has no such thing and the SQLite
 * twin has to be the same table), so the same operational property is bought
 * with an indexed `YYYYMMDD` integer: the prune is one ranged DELETE per run
 * rather than a scan over timestamps, and it stays one statement on both
 * dialects.
 *
 * Ordering is the keyset `(created_at, id)`. `created_at` alone is not a
 * cursor: two messages published in the same millisecond would make `>` either
 * skip one or repeat it forever.
 */
export const broadcastMessages = pgTable(
  "broadcast_messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    /** `YYYYMMDD` in UTC — the prune's range key. */
    day: integer("day").notNull(),
    /** Caller-chosen event name within the channel (`message` by default). */
    event: text("event").notNull(),
    /** The `data` half of the envelope, as published — serialized, for the
     *  same reason the rule columns are: a corrupt row must degrade to `null`
     *  in one place, not throw out of the row mapper. */
    payload: text("payload"),
    /** Who published it — server-stamped, never taken from the body. Null for
     *  a message published by an anonymous caller on a `public` channel. */
    senderId: text("sender_id"),
    senderName: text("sender_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("broadcast_messages_read_idx").on(t.tenantId, t.channel, t.createdAt, t.id),
    index("broadcast_messages_day_idx").on(t.day),
  ],
);

/**
 * A credential for the S3-compatible endpoint.
 *
 * ## Why the secret is stored, when every other credential here is hashed
 *
 * `api_keys` stores a scrypt digest and can, because a bearer token is checked
 * by hashing what arrived. SigV4 is not a bearer scheme: the client derives a
 * signing key from the secret and signs the request with it, and the server has
 * to derive the SAME key to check the signature. A digest cannot do that. This
 * is the trade AWS itself makes, and the only honest options are to store the
 * secret or to have no S3 endpoint.
 *
 * So it is stored ENCRYPTED with the deployment's `AUTH_SECRET` (AES-GCM, the
 * same `encryptSecret` the auth-config secrets use), which is real protection
 * against a database dump and none at all against an attacker who already has
 * the application's environment. The docs say exactly that rather than implying
 * the credential is as safe as an API key.
 *
 * A credential is deliberately narrower than an API key: it reaches storage and
 * nothing else, it can be pinned to a key `prefix`, and it can be read-only.
 */
export const s3Credentials = pgTable(
  "s3_credentials",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The SigV4 `Credential=` access key id. Unique instance-wide: a request
     *  carries no workspace header, so this is the only thing that can name
     *  the workspace it belongs to. */
    accessKeyId: text("access_key_id").notNull(),
    /** `enc:v1:…` — see the note above about why this is not a digest. */
    secretKey: text("secret_key").notNull(),
    /** Restrict this credential to keys under one prefix. NULL = the whole
     *  workspace bucket. */
    prefix: text("prefix"),
    /** Refuse every mutating verb. A backup tool that only reads should hold
     *  a credential that cannot delete. */
    readOnly: boolean("read_only").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("s3_credentials_akid_idx").on(t.accessKeyId),
    index("s3_credentials_tenant_idx").on(t.tenantId),
  ],
);

/**
 * An impersonation — an operator acting as one of the workspace's end-users.
 *
 * ## Why a row, and not just a token
 *
 * The point of impersonation is that support can reproduce what a customer
 * sees. The point of AUDITING it is that nobody can do so unobserved, and a
 * signed token alone cannot deliver that: it is valid until it expires, so
 * "end this session now" would have no meaning and the record of what happened
 * would live only in whatever the operator chose to write down.
 *
 * So the token carries the impersonation's ID and every request it
 * authenticates re-reads THIS row. That costs one indexed lookup per
 * impersonated request — paid only while somebody is impersonating — and buys
 * instant revocation plus a record that exists whether or not the operator
 * cooperates.
 *
 * `reason` is NOT NULL and rejected when blank. An audit trail of who acted as
 * whom, with no why, answers the easy half of the question.
 */
export const impersonations = pgTable(
  "impersonations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** The operator. A platform-plane user id. */
    actorUserId: text("actor_user_id").notNull(),
    actorEmail: text("actor_email"),
    /** The end-user being acted as. An `app_users` id — never a platform user;
     *  one operator impersonating another is a privilege move, not support. */
    subjectUserId: text("subject_user_id").notNull(),
    subjectEmail: text("subject_email"),
    reason: text("reason").notNull(),
    /** Default TRUE. Reproducing what a customer sees needs reads; changing
     *  their data on their behalf is a different act and has to be asked for. */
    readOnly: boolean("read_only").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: text("ended_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("impersonations_tenant_idx").on(t.tenantId, t.createdAt),
    index("impersonations_subject_idx").on(t.subjectUserId),
  ],
);

/**
 * A JWT signing key, and where it is in its life.
 *
 * ## Why the database, when env vars already work
 *
 * `AUTH_JWT_PRIVATE_KEY` signs tokens today and that is fine until you have to
 * ROTATE. Rotation by env var means editing a secret and redeploying, twice —
 * once to publish the new public key so verifiers learn it, once more to start
 * signing with it — and there is no way back except a third deploy. Every one
 * of those steps is a deploy, in an incident, under time pressure.
 *
 * A row has states instead, and every transition is reversible:
 *
 *   standby          generated, PUBLISHED in the JWKS, signing nothing yet.
 *                    That is the whole point of the state: verifiers cache the
 *                    JWKS, so a key has to be visible BEFORE it signs anything.
 *   in_use           exactly one; new tokens are signed with it.
 *   previously_used  no longer signs; still verifies, because tokens it signed
 *                    are still in the wild.
 *   revoked          removed from the JWKS; tokens it signed stop verifying.
 *
 * Promoting a standby key demotes the current one to `previously_used`, which
 * is what makes a rollback a promotion in the other direction rather than a
 * restore from somewhere.
 *
 * `private_key` is encrypted with the deployment's `AUTH_SECRET` — the same
 * `encryptSecret` the auth-config secrets use. That protects a database dump
 * and nothing beyond it, which is the honest description; the alternative is
 * keys that can only ever live in env.
 *
 * INSTANCE-level, not per workspace: the JWKS is one document at one URL and a
 * token's `iss` names the instance. A per-workspace key would need a
 * per-workspace JWKS URL, which is a different feature.
 */
export const signingKeys = pgTable(
  "signing_keys",
  {
    id: text("id").primaryKey(),
    /** RFC 7638 thumbprint of the public key — derived, never chosen, so it is
     *  stable for a key and changes exactly when the key does. */
    kid: text("kid").notNull(),
    /** `ES256` | `RS256`. */
    alg: text("alg").notNull(),
    /** `enc:v1:…` over the PKCS#8 PEM. */
    privateKey: text("private_key").notNull(),
    /** SPKI PEM. Public by definition — this is what the JWKS publishes. */
    publicKey: text("public_key").notNull(),
    /** `standby` | `in_use` | `previously_used` | `revoked`. */
    status: text("status").notNull().default("standby"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("signing_keys_kid_idx").on(t.kid),
    index("signing_keys_status_idx").on(t.status),
  ],
);

/**
 * A CDC sink — the changefeed, delivered somewhere.
 *
 * `/{slug}/changes` already produces the hard part: an incremental feed with
 * delete tombstones and shape move-out markers, keyset-paginated so a reader
 * can resume exactly. What it had was no consumer other than a client that
 * polls it. This row is the consumer: a destination, and a WATERMARK.
 *
 * `cursor` is the whole design. It is the changefeed's own cursor, and it
 * advances only after a delivery is acknowledged — so a sink is at-least-once
 * and never at-most-once. Duplicates on retry are the honest trade, and the
 * payload carries a stable key so a destination can deduplicate; the
 * alternative (advance first, deliver after) loses rows on any failure and
 * nobody can tell which.
 */
export const cdcSinks = pgTable(
  "cdc_sinks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Collection slug this sink replicates. */
    collection: text("collection").notNull(),
    /** `webhook` — POST each batch to a URL. `storage` — write NDJSON objects
     *  into this workspace's own bucket, where the S3 endpoint can read them. */
    destination: text("destination").notNull(),
    /** Destination-specific: `{ url, secret, headers }` or `{ prefix }`. */
    config: jsonb("config").notNull(),
    /** Optional shape (a flat filter) and projection, passed to the changefeed
     *  verbatim — a sink narrows what it replicates the same way a client does. */
    shape: text("shape"),
    fields: text("fields"),
    batchSize: integer("batch_size").notNull().default(100),
    enabled: boolean("enabled").notNull().default(true),
    /** The changefeed cursor. Advanced only after a delivery is acknowledged. */
    cursor: text("cursor"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    disabledReason: text("disabled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cdc_sinks_tenant_idx").on(t.tenantId),
    index("cdc_sinks_enabled_idx").on(t.enabled),
  ],
);
