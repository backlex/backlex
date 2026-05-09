// Mock data for the workeros admin design prototype.
import type { IconKey } from "./icons";

export interface Author {
  id: string;
  name: string;
  initials: string;
}

export interface Post {
  id: string;
  title: string;
  slug: string;
  status: "draft" | "review" | "published" | "archived";
  author: string;
  word_count: number;
  published_at: string | null;
  updated_at: string;
  view_count: number;
  body?: string;
  tags?: unknown;
}

export interface SchemaField {
  name: string;
  type: "text" | "longtext" | "integer" | "number" | "boolean" | "json" | "timestamp" | "uuid" | "enum" | "relation";
  system?: boolean;
  nullable: boolean;
  default: string | null;
  unique?: boolean;
  values?: string[];
  relation?: string;
  indexed?: boolean;
}

export interface CollectionSchema {
  slug: string;
  ownerScoped: boolean;
  fields: SchemaField[];
}

export interface CollectionListItem {
  slug: string;
  count: number;
  ownerScoped: boolean;
  fields: number;
  icon: IconKey | string;
  writes24h: number;
  lastWrite: string;
  singleton: boolean;
  group: string;
}

export interface NavItem {
  id: string;
  label: string;
  icon: IconKey | string;
  badge?: number;
}

export interface AdapterProfile {
  db: string;
  storage: string;
  realtime: string;
  sandbox: string;
}

export const POST_AUTHORS: Author[] = [
  { id: "u_1", name: "rana", initials: "RM" },
  { id: "u_2", name: "kai", initials: "KT" },
  { id: "u_3", name: "alex", initials: "AS" },
  { id: "u_4", name: "jules", initials: "JL" },
  { id: "u_5", name: "priya", initials: "PR" },
];

export const initialPosts: Post[] = [
  { id: "01HZ7K8M9NPQ", title: "Edge functions are now generally available", slug: "edge-functions-ga", status: "published", author: "u_1", word_count: 1420, published_at: "2026-04-30T09:12:00Z", updated_at: "2026-05-04T11:02:00Z", view_count: 24102 },
  { id: "01HZ7K8N2RST", title: "A simpler permissions DSL", slug: "permissions-dsl", status: "published", author: "u_2", word_count: 884, published_at: "2026-04-22T15:33:00Z", updated_at: "2026-04-25T08:14:00Z", view_count: 9120 },
  { id: "01HZ7K8P4UVW", title: "Realtime channels: WebSockets vs SSE on the edge", slug: "realtime-edge-tradeoffs", status: "published", author: "u_3", word_count: 2210, published_at: "2026-04-12T07:00:00Z", updated_at: "2026-04-13T22:48:00Z", view_count: 17430 },
  { id: "01HZ7K8Q6XYZ", title: "Drizzle 1.0 in production", slug: "drizzle-1-0-prod", status: "review", author: "u_4", word_count: 1102, published_at: null, updated_at: "2026-05-05T10:50:00Z", view_count: 0 },
  { id: "01HZ7K8R8ABC", title: "pgvector → Vectorize migration playbook", slug: "pgvector-vectorize-migration", status: "review", author: "u_2", word_count: 1844, published_at: null, updated_at: "2026-05-04T18:20:00Z", view_count: 0 },
  { id: "01HZ7K8S0DEF", title: "Anatomy of a passkey login", slug: "passkey-anatomy", status: "draft", author: "u_1", word_count: 612, published_at: null, updated_at: "2026-05-03T14:08:00Z", view_count: 0 },
  { id: "01HZ7K8T2GHI", title: "Self-hosting on a single Bun process", slug: "self-hosting-bun", status: "draft", author: "u_5", word_count: 450, published_at: null, updated_at: "2026-05-02T20:30:00Z", view_count: 0 },
  { id: "01HZ7K8U4JKL", title: "OAuth done right (or: why we ditched our parallel flow)", slug: "oauth-parallel-flow", status: "published", author: "u_3", word_count: 1320, published_at: "2026-03-30T11:11:00Z", updated_at: "2026-03-30T11:11:00Z", view_count: 5780 },
  { id: "01HZ7K8V6MNO", title: "API keys, hashed", slug: "api-keys-hashed", status: "published", author: "u_4", word_count: 720, published_at: "2026-03-21T09:45:00Z", updated_at: "2026-03-22T11:17:00Z", view_count: 3420 },
  { id: "01HZ7K8W8PQR", title: "Webhooks with retries (the boring way)", slug: "webhooks-retries", status: "archived", author: "u_2", word_count: 980, published_at: "2025-11-02T08:00:00Z", updated_at: "2025-12-15T16:00:00Z", view_count: 14080 },
  { id: "01HZ7K8X0STU", title: "A flow language without YAML", slug: "flow-no-yaml", status: "draft", author: "u_5", word_count: 220, published_at: null, updated_at: "2026-04-29T07:25:00Z", view_count: 0 },
  { id: "01HZ7K8Y2VWX", title: "Sandboxing user code: three providers, one RPC bridge", slug: "sandbox-three-providers", status: "review", author: "u_3", word_count: 1640, published_at: null, updated_at: "2026-05-05T19:55:00Z", view_count: 0 },
];

export const collectionSchema: CollectionSchema = {
  slug: "posts",
  ownerScoped: true,
  fields: [
    { name: "id", type: "uuid", system: true, nullable: false, default: "gen_uuid()" },
    { name: "title", type: "text", nullable: false, default: null },
    { name: "slug", type: "text", nullable: false, default: null, unique: true },
    { name: "status", type: "text", nullable: false, default: "draft" },
    { name: "body", type: "longtext", nullable: true, default: null },
    { name: "author", type: "uuid", nullable: false, default: null },
    { name: "word_count", type: "integer", nullable: false, default: "0" },
    { name: "view_count", type: "integer", nullable: false, default: "0" },
    { name: "tags", type: "json", nullable: true, default: "[]" },
    { name: "published_at", type: "timestamp", nullable: true, default: null },
    { name: "created_at", type: "timestamp", system: true, nullable: false, default: "now()" },
    { name: "updated_at", type: "timestamp", system: true, nullable: false, default: "now()" },
    { name: "owner_id", type: "uuid", system: true, nullable: false, default: "$user.id" },
  ],
};

export const collectionsList: CollectionListItem[] = [
  { slug: "posts", count: 12, ownerScoped: true, fields: 13, icon: "Inbox", writes24h: 24, lastWrite: "2m ago", singleton: false, group: "Content" },
  { slug: "authors", count: 5, ownerScoped: false, fields: 8, icon: "Users", writes24h: 0, lastWrite: "14d ago", singleton: false, group: "Content" },
  { slug: "comments", count: 184, ownerScoped: true, fields: 9, icon: "Inbox", writes24h: 312, lastWrite: "just now", singleton: false, group: "Content" },
  { slug: "tags", count: 22, ownerScoped: false, fields: 5, icon: "Hash", writes24h: 1, lastWrite: "4h ago", singleton: false, group: "Content" },
  { slug: "site_settings", count: 1, ownerScoped: false, fields: 12, icon: "Settings", writes24h: 0, lastWrite: "6d ago", singleton: true, group: "System" },
  { slug: "newsletter_subs", count: 4280, ownerScoped: false, fields: 6, icon: "Mail", writes24h: 41, lastWrite: "11m ago", singleton: false, group: "Marketing" },
];

export const navItems: NavItem[] = [
  { id: "dashboard", label: "Overview", icon: "Activity" },
  { id: "collections", label: "Collections", icon: "Database", badge: 4 },
  { id: "database", label: "Database", icon: "Server" },
  { id: "storage", label: "Storage", icon: "Folder" },
  { id: "flows", label: "Flows", icon: "Bolt" },
  { id: "functions", label: "Functions", icon: "Function" },
  { id: "webhooks", label: "Webhooks", icon: "Webhook" },
  { id: "realtime", label: "Realtime", icon: "Zap" },
  { id: "insights", label: "Insights", icon: "BarChart" },
  { id: "activity", label: "Activity log", icon: "Clock" },
  { id: "revisions", label: "Revisions", icon: "History" },
  { id: "translations", label: "Translations", icon: "Globe" },
];

export const navSettings: NavItem[] = [
  { id: "authsettings", label: "Authentication", icon: "Shield" },
  { id: "roles", label: "Roles & permissions", icon: "Shield" },
  { id: "users", label: "Users", icon: "Users" },
  { id: "api", label: "API keys", icon: "Code" },
  { id: "email", label: "Email templates", icon: "Mail" },
  { id: "settings", label: "Settings", icon: "Settings" },
];

export type AdapterId = "bun" | "workers" | "vercel";

export const adapterProfiles: Record<AdapterId, AdapterProfile> = {
  bun: { db: "sqlite", storage: "fs", realtime: "in-proc + SSE", sandbox: "worker" },
  workers: { db: "d1", storage: "r2", realtime: "durable object", sandbox: "cf-dispatch" },
  vercel: { db: "pg (neon)", storage: "s3", realtime: "sse", sandbox: "quickjs" },
};

export const MOCK = {
  initialPosts,
  POST_AUTHORS,
  collectionSchema,
  collectionsList,
  navItems,
  navSettings,
  adapterProfiles,
};

export type Mock = typeof MOCK;
