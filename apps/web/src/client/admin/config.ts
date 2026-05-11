// Static config + shared domain types for the workeros admin.
//
// Nothing here is mock data: the navigation menu is the admin's own structure
// (there is no API for it) and ADAPTER_PROFILES is a fixed description of what
// each deploy target's adapter layer uses. The *active* adapter is detected at
// runtime via /api/admin/settings/runtime; every collection / item / metric /
// user / role surface in the admin reads from its real API endpoint.
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

export type AdapterId = "bun" | "workers" | "vercel";

// Nav ids double as URL slugs — keep them human-readable (not "api" or
// "email") because they're rendered into the address bar by AdminApp's
// URL-driven nav.
export const NAV_ITEMS: NavItem[] = [
  { id: "overview", label: "Overview", icon: "Activity" },
  { id: "collections", label: "Collections", icon: "Database" },
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

export const NAV_SETTINGS: NavItem[] = [
  { id: "authentication", label: "Authentication", icon: "Shield" },
  { id: "roles", label: "Roles & permissions", icon: "Shield" },
  { id: "users", label: "Users", icon: "Users" },
  { id: "api-keys", label: "API keys", icon: "Code" },
  { id: "email-templates", label: "Email templates", icon: "Mail" },
  { id: "settings", label: "Settings", icon: "Settings" },
];

export const ADAPTER_PROFILES: Record<AdapterId, AdapterProfile> = {
  bun: { db: "sqlite", storage: "fs", realtime: "in-proc + SSE", sandbox: "worker" },
  workers: { db: "d1", storage: "r2", realtime: "durable object", sandbox: "cf-dispatch" },
  vercel: { db: "pg (neon)", storage: "s3", realtime: "sse", sandbox: "quickjs" },
};
