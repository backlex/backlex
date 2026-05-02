import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const ts = (name: string) =>
  integer(name, { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date());

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    name: text("name"),
    image: text("image"),
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
});

export const collections = sqliteTable("collections", {
  slug: text("slug").primaryKey(),
  fields: text("fields", { mode: "json" }).$type<unknown[]>().notNull(),
  ownerScoped: integer("owner_scoped", { mode: "boolean" }).notNull().default(false),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const records = sqliteTable(
  "records",
  {
    id: text("id").primaryKey(),
    collectionSlug: text("collection_slug")
      .notNull()
      .references(() => collections.slug, { onDelete: "cascade" }),
    ownerId: text("owner_id"),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("records_collection_idx").on(t.collectionSlug),
    index("records_owner_idx").on(t.ownerId),
  ],
);

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

export const files = sqliteTable("files", {
  key: text("key").primaryKey(),
  ownerId: text("owner_id"),
  size: integer("size").notNull(),
  contentType: text("content_type"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, string>>(),
  createdAt: ts("created_at"),
});
