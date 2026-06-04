// Static config + shared domain types for the backlex admin.
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
  // Collection metadata edited in the Settings tab. These ride along on the
  // GET /api/collections/:slug response and must be hydrated into schemaState
  // so the Settings form reseeds them on load (otherwise edits appear to save
  // but revert to empty on refresh).
  singular?: string | null;
  plural?: string | null;
  note?: string | null;
  displayTemplate?: string | null;
  defaultSort?: string | null;
  tenantScoped?: boolean;
  versioned?: boolean;
  adopted?: boolean;
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

// Nav display labels are NOT stored here: `config.ts` has no JSX, so the
// Lingui `msg` macro would not be transformed in it. The id→label map lives
// in `ui.tsx::navLabel` (a JSX module) instead.
export interface NavItem {
  id: string;
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
  { id: "overview", icon: "Activity" },
  { id: "ask-ai", icon: "Sparkles" },
  { id: "collections", icon: "Database" },
  { id: "access", icon: "Shield" },
  { id: "database", icon: "Server" },
  { id: "storage", icon: "Folder" },
  { id: "flows", icon: "Bolt" },
  { id: "functions", icon: "Function" },
  { id: "webhooks", icon: "Webhook" },
  { id: "integrations", icon: "Plug" },
  { id: "realtime", icon: "Zap" },
  { id: "logs", icon: "ScrollText" },
  { id: "advisor", icon: "ShieldAlert" },
  { id: "schema-graph", icon: "Network" },
  { id: "insights", icon: "BarChart" },
  { id: "revisions", icon: "History" },
  { id: "translations", icon: "Globe" },
];

// Developer-facing tools: REST explorer, GraphQL playground, OpenAPI export.
// Kept in their own group so they sit together in the sidebar without
// crowding the workspace nav.
export const NAV_DEVELOPERS: NavItem[] = [
  { id: "rest-explorer", icon: "Braces" },
  { id: "graphql", icon: "Code" },
  { id: "openapi", icon: "Download" },
];

export const NAV_SETTINGS: NavItem[] = [
  { id: "authentication", icon: "Shield" },
  { id: "users", icon: "Users" },
  { id: "app-users", icon: "Users" },
  { id: "api-keys", icon: "Code" },
  { id: "email-templates", icon: "Mail" },
  { id: "settings", icon: "Settings" },
];

export const ADAPTER_PROFILES: Record<AdapterId, AdapterProfile> = {
  bun: { db: "sqlite", storage: "fs", realtime: "in-proc + SSE" },
  workers: { db: "d1", storage: "r2", realtime: "durable object" },
  vercel: { db: "pg (neon)", storage: "s3", realtime: "sse" },
};
