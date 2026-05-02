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

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    name: text("name"),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
  }),
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
  },
  (t) => ({
    tokenIdx: uniqueIndex("sessions_token_idx").on(t.token),
    userIdx: index("sessions_user_idx").on(t.userId),
  }),
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
});

/**
 * `collections` is the directus-like meta table. Each row defines a dynamic
 * "table" exposed via the REST API.  The actual data is stored in `records`
 * (jsonb) so we don't need DDL at runtime — fast to iterate, easy to deploy
 * to D1 and Postgres alike.
 */
export const collections = pgTable("collections", {
  slug: text("slug").primaryKey(),
  fields: jsonb("fields").$type<unknown[]>().notNull(),
  ownerScoped: boolean("owner_scoped").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const records = pgTable(
  "records",
  {
    id: text("id").primaryKey(),
    collectionSlug: text("collection_slug")
      .notNull()
      .references(() => collections.slug, { onDelete: "cascade" }),
    ownerId: text("owner_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    collectionIdx: index("records_collection_idx").on(t.collectionSlug),
    ownerIdx: index("records_owner_idx").on(t.ownerId),
  }),
);

/**
 * Embeddings are kept in a dedicated table so the vector dimension can be
 * fixed at schema time.  Default 1536 (OpenAI/text-embedding-3-small).  If
 * you need multiple models, create one table per model.
 */
export const embeddings = pgTable(
  "embeddings",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull().default("default"),
    refId: text("ref_id"),
    content: text("content"),
    embedding: vector("embedding", 1536).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nsIdx: index("embeddings_namespace_idx").on(t.namespace),
    refIdx: index("embeddings_ref_idx").on(t.refId),
    // pgvector HNSW index for cosine similarity. Created via raw SQL in
    // migrations because drizzle-kit doesn't generate vector indexes yet.
    hnsw: index("embeddings_hnsw_idx")
      .using("hnsw", sql`embedding vector_cosine_ops`),
  }),
);

export const files = pgTable("files", {
  key: text("key").primaryKey(),
  ownerId: text("owner_id"),
  size: integer("size").notNull(),
  contentType: text("content_type"),
  metadata: jsonb("metadata").$type<Record<string, string>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
