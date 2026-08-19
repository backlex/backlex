// Static config + shared domain types for the backlex admin.
//
// Nothing here is mock data: the navigation menu is the admin's own structure
// (there is no API for it) and ADAPTER_PROFILES is a fixed description of what
// each deploy target's adapter layer uses. The *active* adapter is detected at
// runtime via /api/admin/settings/runtime; every collection / item / metric /
// user / role surface in the admin reads from its real API endpoint.
import type { IconKey } from "./icons";
import type { StorageType } from "./fields/interfaces";

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
  /** An item row is whatever columns its collection defines — the named
   *  members above are only the ones every surface expects to find. The item
   *  list, grid and Kanban all read user-defined columns off these rows by
   *  name, which is why the row type has to admit them; without this the code
   *  reached for `as Record<string, unknown>` at a dozen sites and TypeScript
   *  rejected the conversion outright, so the file was suppressed instead. */
  [column: string]: unknown;
}

export interface SchemaField {
  name: string;
  /** The one storage-type union, shared with the interface catalog.
   *
   *  This used to spell out its own list of ten, which had fallen behind the
   *  catalog by eight: money / phone / email / url / hash / geo /
   *  relation_many, plus the presentational divider + notice. Fields of those
   *  types are created and rendered all over the admin, but were
   *  unrepresentable here — so a check like `f.type === "divider"` compared
   *  against a union that could not hold it. The dropped `"enum"` was the
   *  reverse: no interface maps to it and the backend has no such type. */
  type: StorageType;
  system?: boolean;
  nullable: boolean;
  default: string | null;
  unique?: boolean;
  values?: string[];
  relation?: string;
  indexed?: boolean;
  /** Target collection slug for a relation / relation_many column. Read all
   *  over the item list to resolve the row label of a linked record; it was
   *  simply never declared. */
  to?: string;
  /** Display name shown instead of the column name. */
  label?: string;
  /** The UI interface the field is edited with — an id from the catalog. */
  interface?: string;
  /** Per-locale label overrides. */
  translations?: Record<string, string>;
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
  /** Staged edits (versioned only): editing a published item stages the change
   *  (applied by the next publish) instead of changing the live row. */
  stagedEdits?: boolean;
  adopted?: boolean;
  /** Admin icon key. Null = default Database icon. */
  icon?: string | null;
  /** Admin accent color — preset token or `#rrggbb`. */
  color?: string | null;
  /** Hidden from the sidebar + Collections index (presentational only). */
  hidden?: boolean;
  /** Preview-URL template with `{{field}}` placeholders. */
  previewUrl?: string | null;
  /** Lifecycle: `active` | `inactive` (admin-visible, item API blocked). */
  status?: string;
  // ── Settings-tab keys ──────────────────────────────────────────────────
  // The Settings tab patches these through `onPatch`, and app.tsx merges the
  // patch straight into `schemaState`. They were declared only on that tab's
  // local `SchemaLike`, so the merge widened the state object past its own
  // type and every read of one of them here was untyped. Adding a key to
  // `SchemaLike` means adding it here too — otherwise the toggle round-trips
  // through state the compiler cannot see.
  /** Record reads of this collection into the activity log. */
  auditReads?: boolean;
  /** Maintain the keyword full-text index from `searchable` fields. */
  fts?: boolean;
  /** Embed `vectorize`-flagged fields on write. */
  vectorize?: boolean;
  /** Embedding model key. Null → the deployment default. */
  vectorizeModel?: string | null;
  /** Field the Kanban board groups columns by. */
  kanbanGroupBy?: string | null;
  /** Group value → lifecycle action fired when a card lands in that column. */
  kanbanActionMap?: Record<string, "publish" | "unpublish" | "archive"> | null;
}

export interface CollectionListItem {
  slug: string;
  count: number;
  ownerScoped: boolean;
  fields: number;
  icon: IconKey | string;
  /** Accent color — preset token or `#rrggbb`. Null = default violet. */
  color?: string | null;
  /** Hidden from the sidebar + index unless "Show hidden" is on. */
  hidden?: boolean;
  /** Collection description (the `note` column) — shown on cards/rows. */
  note?: string | null;
  writes24h: number;
  lastWrite: string;
  singleton: boolean;
  /** Admin grouping section header. Null = ungrouped (rendered last). */
  group: string | null;
  /** Manual position within the group. Null sorts after ordered rows. */
  sortOrder?: number | null;
  /**
   * The collection's actual field definitions, as returned by the list
   * endpoint. `fields` above is only their COUNT; the rollup editor needs the
   * definitions themselves to offer valid sources / relations / value columns,
   * and the list response already carries them, so this saves a request per
   * candidate collection rather than adding one.
   */
  fieldDefs?: Array<{ name: string; type: string; to?: string; rollup?: unknown }>;
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

export type AdapterId =
  | "bun"
  | "node"
  | "deno"
  | "workers"
  | "vercel"
  | "netlify";

// Nav ids double as URL slugs — keep them human-readable (not "api" or
// "email") because they're rendered into the address bar by AdminApp's
// URL-driven nav.
//
// The workspace nav is split into themed sub-groups so the sidebar reads as a
// few short clusters instead of one ~17-item scroll. The sidebar (`ui.tsx`)
// renders each array under its own header; NAV_PRIMARY is headerless. The flat
// NAV_ITEMS union below is what the URL router (`app.tsx`) and command palette
// (`extras.tsx`) consume — keep it as the concatenation, in sidebar order.

// Primary entry points — rendered at the top with no group header.
export const NAV_PRIMARY: NavItem[] = [
  { id: "overview", icon: "Activity" },
  { id: "ask-ai", icon: "Sparkles" },
];

// Data — the collection model and the stores behind it.
export const NAV_DATA: NavItem[] = [
  { id: "collections", icon: "Database" },
  { id: "forms", icon: "Form" },
  { id: "booking", icon: "CalendarDays" },
  { id: "access", icon: "Shield" },
  { id: "database", icon: "Server" },
  { id: "storage", icon: "Folder" },
  { id: "search", icon: "Search" },
  { id: "schema-graph", icon: "Network" },
  { id: "schema-versions", icon: "Layers" },
  { id: "database-import", icon: "Download" },
];

// Automation — logic that runs on top of the data.
export const NAV_AUTOMATION: NavItem[] = [
  { id: "flows", icon: "Bolt" },
  { id: "approvals", icon: "ShieldCheck" },
  { id: "agents", icon: "Sparkles" },
  { id: "chat", icon: "MessageSquare" },
  { id: "functions", icon: "Function" },
  { id: "jobs", icon: "Clock" },
  { id: "feature-flags", icon: "ToggleLeft" },
  { id: "webhooks", icon: "Webhook" },
  { id: "integrations", icon: "Plug" },
  { id: "payments", icon: "CreditCard" },
  { id: "realtime", icon: "Zap" },
];

// Observability — what happened, health, and history.
export const NAV_OBSERVABILITY: NavItem[] = [
  { id: "logs", icon: "ScrollText" },
  { id: "traces", icon: "Activity" },
  { id: "usage", icon: "Gauge" },
  { id: "analytics", icon: "BarChart" },
  { id: "tag-manager", icon: "Tag" },
  { id: "advisor", icon: "ShieldAlert" },
  { id: "kpis", icon: "Gauge" },
  { id: "insights", icon: "BarChart" },
  { id: "revisions", icon: "History" },
  { id: "translations", icon: "Globe" },
];

// Flat union of every workspace-level nav id, in sidebar order. Consumed by the
// URL router and command palette; the sidebar renders the sub-groups directly.
export const NAV_ITEMS: NavItem[] = [
  ...NAV_PRIMARY,
  ...NAV_DATA,
  ...NAV_AUTOMATION,
  ...NAV_OBSERVABILITY,
];

// Developer-facing tools: REST explorer, GraphQL playground, OpenAPI export.
// Kept in their own group so they sit together in the sidebar without
// crowding the workspace nav.
export const NAV_DEVELOPERS: NavItem[] = [
  { id: "rest-explorer", icon: "Braces" },
  { id: "graphql", icon: "Code" },
  { id: "openapi", icon: "Download" },
  // Admin-only (not in NON_ADMIN_NAV_IDS). Enabled extensions additionally
  // append their contributed panels after this group's entries (see app.tsx).
  { id: "extensions", icon: "Puzzle" },
];

export const NAV_SETTINGS: NavItem[] = [
  { id: "authentication", icon: "Shield" },
  { id: "platform-sso", icon: "Shield" },
  { id: "users", icon: "Users" },
  { id: "app-users", icon: "Users" },
  { id: "app-orgs", icon: "Building" },
  { id: "api-keys", icon: "Code" },
  { id: "email-templates", icon: "Mail" },
  { id: "documents", icon: "ScrollText" },
  { id: "signatures", icon: "Signature" },
  { id: "settings", icon: "Settings" },
];

/**
 * Nav ids whose pages a NON-admin can actually use — everything else is
 * backed exclusively by admin-gated endpoints (requireAdminMw and friends)
 * and would render as a wall of 403s. The sidebar and command palette hide
 * the rest once `/api/me` resolves `isAdmin: false`; hiding is cosmetic —
 * every endpoint stays gated server-side regardless.
 *
 *  - collections / logs: plain `requireUser` reads (collections list is
 *    additionally permission-filtered server-side)
 *  - storage / revisions: `requirePermission(…, "read")`-based
 *  - rest-explorer: static client-side explorer over the user's own access
 *  - account: the user's own profile (avatar dropdown, never in the sidebar
 *    itself) — listed so the landing redirect in `AdminApp` doesn't bounce a
 *    non-admin off their own settings page
 */
export const NON_ADMIN_NAV_IDS: ReadonlySet<string> = new Set([
  "collections",
  "storage",
  "logs",
  "revisions",
  "rest-explorer",
  "account",
]);

/** Per-permission nav grants computed server-side by `GET /api/me` — which
 *  of the permission-gated non-admin pages this user can actually use.
 *  `collections`/`revisions` = at least one readable collection; `storage` =
 *  a read grant on the system files collection. */
export interface MeNav {
  collections: boolean;
  storage: boolean;
  revisions: boolean;
}

/** Sidebar/palette visibility for a nav id. `isAdmin` is tri-state: while
 *  `/api/me` is still loading (`null`/`undefined`) everything stays visible
 *  so admins don't watch their menu pop in. For non-admins the static
 *  allow-list is further narrowed by the per-permission `nav` grants from
 *  `/api/me` (missing grants object — older server — keeps the allow-list
 *  behaviour). Hiding is cosmetic; every endpoint stays gated server-side. */
export const isNavVisible = (
  id: string,
  isAdmin: boolean | null | undefined,
  nav?: MeNav | null,
): boolean => {
  if (isAdmin !== false) return true;
  if (!NON_ADMIN_NAV_IDS.has(id)) return false;
  if (!nav) return true;
  if (id === "collections") return nav.collections;
  if (id === "storage") return nav.storage;
  if (id === "revisions") return nav.revisions;
  return true; // logs (own activity) + rest-explorer stay available
};

export const ADAPTER_PROFILES: Record<AdapterId, AdapterProfile> = {
  bun: { db: "sqlite", storage: "fs", realtime: "in-proc + SSE" },
  node: { db: "pg", storage: "fs / s3", realtime: "in-proc + SSE" },
  deno: { db: "pg (neon)", storage: "s3", realtime: "upstash / sse" },
  workers: { db: "d1", storage: "r2", realtime: "durable object" },
  vercel: { db: "pg (neon)", storage: "s3", realtime: "upstash" },
  netlify: { db: "pg (neon)", storage: "s3", realtime: "upstash" },
};
