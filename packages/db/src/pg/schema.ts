import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
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
    index("activity_tenant_idx").on(t.tenantId),
  ],
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
 * `collections` is the directus-like meta table. Each row defines a dynamic
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
    fields: jsonb("fields").$type<unknown[]>().notNull(),
    ownerScoped: boolean("owner_scoped").notNull().default(false),
    /** When true, the physical table gains a `tenant_id` column and
     *  reads/writes are auto-scoped by the active tenant. */
    tenantScoped: boolean("tenant_scoped").notNull().default(true),
    /** When true, the physical table has `_status` + `_published_at` columns. */
    versioned: boolean("versioned").notNull().default(false),
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
    /** Default sort applied by `parseQuery` when the request omits `?sort=`.
     *  Comma-separated field list, `-` prefix = DESC (Directus-style).
     *  e.g. `"-published_at,name"`. Null falls back to `-created_at` if the
     *  collection has that column, otherwise the PK. */
    defaultSort: text("default_sort"),
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
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("saved_panels_tenant_idx").on(t.tenantId)],
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
    status: text("status").notNull().default("connected"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("integrations_tenant_idx").on(t.tenantId)],
);
