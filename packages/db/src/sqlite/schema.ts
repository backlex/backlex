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
    description: text("description"),
    systemPrompt: text("system_prompt"),
    model: text("model"),
    tools: text("tools", { mode: "json" }).$type<string[]>().notNull().default([]),
    maxSteps: integer("max_steps").notNull().default(8),
    memory: integer("memory", { mode: "boolean" }).notNull().default(false),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    uniqueIndex("agents_tenant_name_idx").on(t.tenantId, t.name),
    index("agents_tenant_idx").on(t.tenantId),
  ],
);

export const agentThreads = sqliteTable(
  "agent_threads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    agentId: text("agent_id").notNull(),
    title: text("title"),
    status: text("status").notNull().default("idle"),
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("agent_threads_tenant_agent_idx").on(t.tenantId, t.agentId),
    index("agent_threads_agent_idx").on(t.agentId),
  ],
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    threadId: text("thread_id").notNull(),
    role: text("role").notNull(),
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
    /** inherit | console | twilio | sns */
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
    fields: text("fields", { mode: "json" }).$type<unknown[]>().notNull(),
    ownerScoped: integer("owner_scoped", { mode: "boolean" }).notNull().default(false),
    tenantScoped: integer("tenant_scoped", { mode: "boolean" }).notNull().default(true),
    /** When true, the physical table gains a `_status` ('draft'|'published')
     *  + `_published_at` column. PATCH writes update the draft; explicit
     *  `POST /:id/publish` flips status. */
    versioned: integer("versioned", { mode: "boolean" }).notNull().default(false),
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
 * `ai_config` table. See the pg schema for the full contract. `provider`:
 * `inherit` | `gateway` | `anthropic`; `secrets` holds encrypted key material
 * (`gatewayKey`, `anthropicKey`).
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
    status: text("status").notNull().default("connected"),
    lastEventAt: integer("last_event_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("integrations_tenant_idx").on(t.tenantId)],
);
