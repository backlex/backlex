// Static config + shared domain types for the workeros admin.
//
// Nothing here is mock data: the navigation menu is the admin's own structure
// (there is no API for it) and ADAPTER_PROFILES is a fixed description of what
// each deploy target's adapter layer uses. The *active* adapter is detected at
// runtime via /api/admin/settings/runtime; every collection / item / metric /
// user / role surface in the admin reads from its real API endpoint.
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
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
  label: MessageDescriptor;
  icon: IconKey | string;
  badge?: number;
}

export interface AdapterProfile {
  db: string;
  storage: string;
  realtime: string;
}

export type AdapterId = "bun" | "workers" | "vercel";

// Nav ids double as URL slugs — keep them human-readable (not "api" or
// "email") because they're rendered into the address bar by AdminApp's
// URL-driven nav.
export const NAV_ITEMS: NavItem[] = [
  { id: "overview", label: msg`Overview`, icon: "Activity" },
  { id: "collections", label: msg`Collections`, icon: "Database" },
  { id: "access", label: msg`Access`, icon: "Shield" },
  { id: "database", label: msg`Database`, icon: "Server" },
  { id: "storage", label: msg`Storage`, icon: "Folder" },
  { id: "flows", label: msg`Flows`, icon: "Bolt" },
  { id: "functions", label: msg`Functions`, icon: "Function" },
  { id: "webhooks", label: msg`Webhooks`, icon: "Webhook" },
  { id: "realtime", label: msg`Realtime`, icon: "Zap" },
  { id: "logs", label: msg`Logs`, icon: "ScrollText" },
  { id: "advisor", label: msg`Advisor`, icon: "ShieldAlert" },
  { id: "schema-graph", label: msg`Schema graph`, icon: "Network" },
  { id: "insights", label: msg`Insights`, icon: "BarChart" },
  { id: "revisions", label: msg`Revisions`, icon: "History" },
  { id: "translations", label: msg`Translations`, icon: "Globe" },
];

// Developer-facing tools: REST explorer, GraphQL playground, OpenAPI export.
// Kept in their own group so they sit together in the sidebar without
// crowding the workspace nav.
export const NAV_DEVELOPERS: NavItem[] = [
  { id: "rest-explorer", label: msg`REST Explorer`, icon: "Braces" },
  { id: "graphql", label: msg`GraphQL`, icon: "Code" },
  { id: "openapi", label: msg`OpenAPI`, icon: "Download" },
];

export const NAV_SETTINGS: NavItem[] = [
  { id: "authentication", label: msg`Authentication`, icon: "Shield" },
  { id: "users", label: msg`Users`, icon: "Users" },
  { id: "app-users", label: msg`App users`, icon: "Users" },
  { id: "api-keys", label: msg`API keys`, icon: "Code" },
  { id: "email-templates", label: msg`Email templates`, icon: "Mail" },
  { id: "settings", label: msg`Settings`, icon: "Settings" },
];

export const ADAPTER_PROFILES: Record<AdapterId, AdapterProfile> = {
  bun: { db: "sqlite", storage: "fs", realtime: "in-proc + SSE" },
  workers: { db: "d1", storage: "r2", realtime: "durable object" },
  vercel: { db: "pg (neon)", storage: "s3", realtime: "sse" },
};
