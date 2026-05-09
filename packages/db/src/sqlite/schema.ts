import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const ts = (name: string) =>
  integer(name, { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date());

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
    activeTenantId: text("active_tenant_id"),
    status: text("status").notNull().default("active"),
    suspendedAt: integer("suspended_at", { mode: "timestamp_ms" }),
    isAnonymous: integer("is_anonymous", { mode: "boolean" }).notNull().default(false),
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
    credentialId: text("credential_id").notNull(),
    counter: integer("counter").notNull().default(0),
    deviceType: text("device_type"),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
    transports: text("transports"),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("passkey_credential_idx").on(t.credentialId),
    index("passkey_user_idx").on(t.userId),
  ],
);

export const roles = sqliteTable(
  "roles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    admin: integer("admin", { mode: "boolean" }).notNull().default(false),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("roles_name_idx").on(t.name)],
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

export const flows = sqliteTable(
  "flows",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    trigger: text("trigger").notNull(),
    operations: text("operations", { mode: "json" }).$type<unknown[]>().notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("flows_active_idx").on(t.active),
    index("flows_tenant_idx").on(t.tenantId),
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
    durationMs: integer("duration_ms"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("activity_collection_item_idx").on(t.collection, t.itemId),
    index("activity_user_idx").on(t.userId),
    index("activity_created_idx").on(t.createdAt),
    index("activity_tenant_idx").on(t.tenantId),
  ],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    prefix: text("prefix").notNull(),
    hashedKey: text("hashed_key").notNull(),
    name: text("name").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: ts("created_at"),
  },
  (t) => [
    uniqueIndex("api_keys_hashed_idx").on(t.hashedKey),
    index("api_keys_prefix_idx").on(t.prefix),
    index("api_keys_user_idx").on(t.userId),
  ],
);

export const collections = sqliteTable("collections", {
  slug: text("slug").primaryKey(),
  tenantId: text("tenant_id"),
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
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

/**
 * SQLite (D1) does not support native vector indexes. On the edge, vectors
 * live in Cloudflare Vectorize (bound separately). This table only mirrors
 * the metadata so we can list/delete embeddings transactionally.
 */
export const embeddings = sqliteTable(
  "embeddings",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull().default("default"),
    refId: text("ref_id"),
    content: text("content"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("embeddings_namespace_idx").on(t.namespace),
    index("embeddings_ref_idx").on(t.refId),
  ],
);

export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    parentId: text("parent_id"),
    ownerId: text("owner_id"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("folders_parent_idx").on(t.parentId)],
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
    createdBy: text("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("saved_panels_tenant_idx").on(t.tenantId)],
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
