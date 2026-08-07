import type { VectorStore } from "@backlex/core";
// Lightweight typed client for the admin pages. Wraps the shared `api()`
// helper so the rest of the admin module only sees domain-shaped payloads.
import { api, API_BASE, captureBookmark, sessionHeaders } from "@/lib/api";
import type { PublicAppearance } from "@/lib/public-theme";

export interface ApiTenant {
  id: string;
  slug: string;
  name: string;
  project: string;
  branch: string;
  env: string;
  mark: string | null;
  color: string | null;
  role: string;
}

export interface ApiTenantMember {
  id: string;
  tenantId: string;
  userId: string | null;
  email: string;
  role: string;
  status: "active" | "invited" | "suspended";
  invitedAt?: string | null;
  joinedAt?: string | null;
  createdAt?: string;
}

interface Envelope<T> {
  data: T;
  active?: string | null;
}

export interface ApiCollection {
  slug: string;
  singular?: string | null;
  plural?: string | null;
  note?: string | null;
  /** Mustache-style row-display template, e.g. `{{ title }} — {{ status }}`. */
  displayTemplate?: string | null;
  /** Admin icon key from the SPA icon set. Null = default Database icon. */
  icon?: string | null;
  /** Admin accent color — a preset token name (`"violet"`) or `#rrggbb`. */
  color?: string | null;
  /** Hidden from the sidebar + Collections index (presentational only). */
  hidden?: boolean;
  /** Preview-URL template with `{{field}}` placeholders (absolute http(s)). */
  previewUrl?: string | null;
  /** Lifecycle: `active` | `inactive` (admin-visible, item API blocked) |
   *  `archived` (hidden; restore via the Archived panel). */
  status?: string;
  fields: {
    name: string;
    type: string;
    required?: boolean;
    unique?: boolean;
    /** Target collection slug — present when `type === "relation"`. */
    to?: string;
    interface?: string;
  }[];
  ownerScoped: boolean;
  tenantScoped?: boolean;
  versioned: boolean;
  /** When true, the physical table has a `deleted_at` column and DELETE
   *  soft-deletes. Managed-only. */
  softDelete?: boolean;
  /** When true, the collection is locked to a single live row. */
  singleton?: boolean;
  /** When true, backlex only owns the metadata row — the physical table is
   *  user-owned and never altered (no inline DDL, no field drops). */
  adopted?: boolean;
  /** Opt-in sensitive-read auditing. When true, reads (list + by-id) record an
   *  `access.read` row in the audit log. Off by default. */
  auditReads?: boolean;
  /** Whether the physical table has created_at/updated_at columns. "Timestamps
   *  off" sends both as false. */
  hasCreatedAt?: boolean;
  hasUpdatedAt?: boolean;
  /** Admin grouping section header. Null = ungrouped (rendered last). */
  group?: string | null;
  /** Manual position within the group. Null sorts after ordered rows. */
  sortOrder?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Full-layout write for the Collections "Edit layout" mode. */
export interface CollectionsLayoutInput {
  /** Ordered group-header names (empty groups persist here). */
  groups: string[];
  /** Every collection's target placement; unknown slugs are skipped server-side. */
  items: { slug: string; group: string | null; sortOrder: number | null }[];
}

export interface ApiUser {
  id: string;
  email: string;
  name: string | null;
  status?: "active" | "suspended" | "invited";
  createdAt?: string;
  roles: { id: string; name: string }[];
  /** Auth method: `password`/`github`/`google`/`magic` or a federated
   *  identity (`saml`/`ldap`/`cloud`) — `invite` for pending invite rows. */
  provider?: string;
  lastSeenAt?: number | null;
  /** Whether the user has an authenticator-app (TOTP) second factor enrolled. */
  twoFactorEnabled?: boolean;
  /** tenant_members row id — present on pending-invite rows (revoke target). */
  memberId?: string;
  /** Shareable accept link — present on pending-invite rows. */
  inviteUrl?: string;
}

/** A workspace end-user (the `app_users` pool — the customers of the app
 *  built on this workspace, distinct from the control-plane `ApiUser`). */
export interface ApiAppUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  status: "active" | "suspended";
  createdAt: string | number;
  roles: { id: string; name: string }[];
}

export interface ApiRole {
  id: string;
  name: string;
  description?: string | null;
  admin: boolean;
}

export interface ApiSession {
  id: string;
  userId: string;
  userEmail: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  current?: boolean;
}

/** Per-workspace email transport config (`/api/admin/email-config`). Secret
 *  values are never sent to the browser — only the `secretsSet` flags. */
export interface ApiEmailConfig {
  tenantId: string;
  /** inherit | console | resend | sendgrid | mailgun | ses | smtp */
  provider: string;
  fromAddress: string | null;
  /** Non-secret provider params (mailgun: domain/host; ses: region/accessKeyId;
   *  smtp: host/port/secure/user). */
  config: Record<string, unknown>;
  secretsSet: { apiKey: boolean; secretAccessKey: boolean; pass: boolean };
  updatedAt: number | string | null;
  /** Deployment-level fallback, for context in the UI. */
  env: { provider: string | null; from: string | null };
  providerIds: readonly string[];
}

/** Resolved (public) workspace branding view returned by
 *  `GET /api/workspace-config` — workspace's own row merged onto `_global`
 *  for text/color/theme fields. `logoUrl` / `faviconUrl` already include the
 *  cache-busting query param when set. */
export interface ApiWorkspaceConfigResolved {
  workspaceName: string | null;
  description: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  defaultTheme: "light" | "dark" | "system" | null;
}

/** Raw workspace branding row as returned by `/api/workspace-config/raw` —
 *  the workspace's own values (no `_global` fallback) so the admin form edits
 *  this workspace specifically. */
export interface ApiWorkspaceConfigRaw {
  tenantId: string;
  workspaceName: string | null;
  description: string | null;
  /** Logical file keys (no `tenants/<id>/` prefix). Build the preview URL as
   *  `/api/storage/<encoded-key>`. */
  logoFileKey: string | null;
  faviconFileKey: string | null;
  /** Raw OKLCH string or null (= use the design-system default). */
  primaryColor: string | null;
  /** "light" | "dark" | "system" | null (= leave to user). */
  defaultTheme: string | null;
  updatedAt: number | string | null;
}

export interface ApiEmailTemplate {
  id: string;
  tenantId: string | null;
  key: string;
  name: string;
  subject: string;
  fromAddress: string | null;
  bodyHtml: string;
  bodyText: string | null;
  variables: string[] | null;
}

export interface ApiDocumentTemplate {
  id: string;
  key: string;
  name: string;
  description: string | null;
  /** A COMPLETE html document, not a fragment. */
  bodyHtml: string;
  headerHtml: string | null;
  footerHtml: string | null;
  pageOptions: {
    format?: "A4" | "Letter" | "Legal" | "A3" | "A5";
    landscape?: boolean;
    margin?: string;
    printBackground?: boolean;
  };
  filename: string | null;
  variables: string[] | null;
  /** An instance-wide default this workspace has not overridden. Saving one
   *  creates the override; it never changes the shared row. */
  inherited: boolean;
}

export interface ApiSignatureSigner {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  order: number;
  status: "pending" | "viewed" | "signed" | "declined";
  sentAt: number | string | null;
  viewedAt: number | string | null;
  signedAt: number | string | null;
  declinedAt: number | string | null;
  declineReason: string | null;
  signatureKind: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** One line of an opening pattern, or one exception to it. Minutes count from
 *  LOCAL midnight in the resource's own zone. */
export interface ApiBookingRule {
  id?: string;
  kind: "open" | "block";
  /** 0 = Sunday … 6 = Saturday, or null for every day in the date range. */
  weekday: number | null;
  startMinute: number;
  endMinute: number;
  startsOn: string | null;
  endsOn: string | null;
  reason: string | null;
}

/** What the booker is asked beyond name, email and phone. The stored `type` is
 *  advisory — a question carrying `options` is a choice whatever it says. */
export interface ApiBookingQuestion {
  name: string;
  label?: string;
  type?: "text" | "textarea" | "select" | "boolean";
  required?: boolean;
  options?: string[];
}

export interface ApiBookingResource {
  id: string;
  key: string;
  name: string;
  description: string | null;
  /** The zone the RULES are written in — not a display preference. */
  timeZone: string;
  slotMinutes: number;
  stepMinutes: number | null;
  capacity: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  leadMinutes: number;
  horizonDays: number;
  holdMinutes: number;
  questions: ApiBookingQuestion[];
  /** Public page appearance — `{ theme, accent, font }`, or null for ours. */
  settings: PublicAppearance | null;
  /** Whether bookings are recorded into a collection at all. */
  mirrorEnabled: boolean;
  /** Null means the provisioned default. */
  mirrorCollection: string | null;
  /** The slug bookings actually land in — null when recording is off. */
  recordCollection: string | null;
  mirrorFieldMap: Record<string, string> | null;
  active: boolean;
  confirmationMessage: string | null;
  notifyEmails: string[];
  rules: ApiBookingRule[];
  createdAt: number | string | null;
  updatedAt: number | string | null;
}

export interface ApiBooking {
  id: string;
  resourceId: string;
  /** ISO instants. Render them in the resource's `timeZone`. */
  start: string;
  end: string;
  /** Includes the DERIVED `completed` / `expired`. */
  status: "held" | "confirmed" | "cancelled" | "no_show" | "completed" | "expired";
  storedStatus: string;
  holdExpiresAt: number | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  answers: Record<string, unknown>;
  notes: string | null;
  mirrorCollection: string | null;
  mirrorItemId: string | null;
  /** Why this booking is not in its collection yet, when it isn't. */
  mirrorError: string | null;
  source: string;
  cancelledAt: number | null;
  cancelReason: string | null;
  rescheduledToId: string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
}

export interface ApiBookingSlot {
  start: string;
  end: string;
  /** Capacity left. Never 0 — a full slot is not returned at all. */
  remaining: number;
}

export interface ApiSignatureRequest {
  id: string;
  title: string;
  message: string | null;
  templateKey: string | null;
  /** `expired` is derived from the expiry timestamp, not stored. */
  status: "pending" | "completed" | "declined" | "voided" | "expired";
  ordered: boolean;
  documentHash: string;
  documentKey: string | null;
  signedDocumentKey: string | null;
  signedDocumentHash: string | null;
  filename: string | null;
  expiresAt: number | string | null;
  completedAt: number | string | null;
  voidedAt: number | string | null;
  voidReason: string | null;
  writeBack: { collection: string; id: string; field: string } | null;
  notifyEmails: string[];
  createdBy: string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
  signers: ApiSignatureSigner[];
  /** Only on the single-request read — the frozen document that was sent. */
  bodyHtml?: string;
}

/** The signer's view of their own link (`GET /api/public/sign/:token`). */
export interface ApiSignerView {
  title: string;
  message: string | null;
  status: ApiSignatureRequest["status"];
  signerStatus: ApiSignatureSigner["status"];
  signerName: string | null;
  signerEmail: string;
  signerRole: string | null;
  yourTurn: boolean;
  signedCount: number;
  signerCount: number;
  expiresAt: number | string | null;
  documentHash: string;
  /** Server-owned wording; the page displays it verbatim and never composes
   *  its own — the certificate quotes this exact string. */
  consentText: string;
  html: string;
  completedAt: number | string | null;
}

export interface ApiFunction {
  id: string;
  tenantId: string | null;
  name: string;
  trigger: "http" | "event" | "cron";
  pattern: string | null;
  active: boolean;
  timeoutMs: number;
}

export interface ApiI18nString {
  id: string;
  tenantId: string | null;
  key: string;
  locale: string;
  value: string;
}

export interface ApiPanel {
  id: string;
  name: string;
  description: string | null;
  kind: "sql" | "items-aggregate" | "static";
  sql: string | null;
  viz: string;
  config: Record<string, unknown> | null;
  layout: { x: number; y: number; w: number; h: number } | null;
  /** Parent dashboard id, or null for a loose (ungrouped) panel. */
  dashboardId?: string | null;
}

export interface ApiDashboard {
  id: string;
  tenantId: string | null;
  name: string;
  description: string | null;
  layout: Record<string, unknown> | null;
  embedEnabled: boolean;
  embedRoleId: string | null;
}

/** A named KPI definition — the shared formula every surface reads a figure
 *  from. See `services/kpis.ts` for why the definition is stored rather than
 *  re-spelled per panel. */
export interface ApiKpi {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  collection: string;
  agg: "count" | "sum" | "avg" | "min" | "max";
  field: string | null;
  filter: Record<string, unknown> | null;
  dateField: string | null;
  groupBy: string | null;
  topN: number | null;
  format: "number" | "money" | "percent" | "duration";
  unit: string | null;
  decimals: number | null;
  direction: "up" | "down" | "neutral";
  /** Watch: notify when the figure crosses `alertValue`. Null = unwatched.
   *  `change_*` compare `deltaPct`, so their value is a FRACTION (0.2 = 20%). */
  alertOperator: "above" | "below" | "change_above" | "change_below" | null;
  alertValue: number | null;
  /** Currently outside the threshold. Server-owned — the flag is what makes an
   *  alert fire on the transition rather than on every scheduler tick. */
  alertFiring: boolean;
  /** The collection whose ITEM PAGE this tile belongs on — not the one the KPI
   *  aggregates. Null = not pinned. */
  pinTo: string | null;
  /** The relation column on the KPI's own collection pointing back at that row. */
  pinField: string | null;
  createdBy: string | null;
}

export interface ApiKpiPoint {
  /** Present only on a grouped KPI's rows. */
  label?: string;
  value: number | null;
  previousValue: number | null;
  delta: number | null;
  /** Fractional change (0.12 = +12%); null when there is no baseline to
   *  divide by, which the UI must render as "—" rather than 0%. */
  deltaPct: number | null;
  currency?: string | null;
}

export interface ApiKpiSeriesPoint {
  /** Bucket START, epoch ms. */
  t: number;
  value: number | null;
}

export interface ApiKpiResult {
  slug: string;
  name: string;
  description: string | null;
  collection: string;
  format: ApiKpi["format"];
  unit: string | null;
  decimals: number | null;
  direction: ApiKpi["direction"];
  groupBy: string | null;
  /** Null when the KPI has no `dateField` — a running total with no period
   *  comparison, which the UI must show WITHOUT a delta badge. */
  window: { from: number; to: number } | null;
  previousWindow: { from: number; to: number } | null;
  point: ApiKpiPoint | null;
  rows: ApiKpiPoint[] | null;
  /** The window in buckets, oldest first. Null unless requested. */
  series: ApiKpiSeriesPoint[] | null;
  computedAt: number;
}

export type ApiKpiInput = Omit<ApiKpi, "id" | "tenantId" | "createdBy" | "alertFiring">;

export interface ApiDashboardReportInput {
  filename?: string;
  pageOptions?: { format?: string; landscape?: boolean; printBackground?: boolean };
  /** Omit to render + store only. */
  email?: { to: string; subject?: string; templateKey?: string };
}

export interface ApiDashboardReport {
  key: string;
  filename: string;
  size: number;
  renderer: string;
  dashboard: { id: string; name: string };
  panels: number;
  failedPanels: number;
  sentTo: string[];
  attachmentsDropped?: boolean;
}

/** A single panel's rendered result from a dashboard run / public embed. */
export interface ApiDashboardPanelResult {
  panelId: string;
  name: string;
  viz: string;
  kind: string;
  config: Record<string, unknown> | null;
  data: Record<string, unknown>[];
  note?: string;
  error?: string;
}

export interface ApiPublicDashboard {
  id: string;
  name: string;
  description: string | null;
  layout: Record<string, unknown> | null;
  panels: ApiDashboardPanelResult[];
}

export interface ApiAuthConfigProvider {
  enabled?: boolean;
  configured?: boolean;
  clientId?: string | null;
  system?: boolean;
  /** Display name for custom OIDC providers. */
  name?: string;
  /** OIDC discovery / issuer URL for custom providers. */
  discoveryUrl?: string | null;
}

export interface ApiAuthConfig {
  tenantId: string;
  providers: Record<string, ApiAuthConfigProvider>;
  policy: Record<string, boolean>;
  sessionLifetime: string;
  redirectUrls: string[];
}

export interface ApiRuntime {
  adapter: "bun" | "workers" | "vercel";
  dialect: "pg" | "sqlite";
  bindings: { type: string; name: string; target: string; status: string }[];
  envVars: { key: string; set: boolean; secret: boolean; source: string }[];
  version: string;
  commit: string;
  released: string;
  wrangler: string;
}

export interface ApiActivity {
  id: string;
  userId: string | null;
  action: string;
  collection: string;
  itemId: string | null;
  ip: string | null;
  userAgent: string | null;
  payload: unknown;
  response: unknown;
  durationMs: number | null;
  createdAt: string;
}

export interface ApiBackup {
  id: string;
  kind: string;
  label: string | null;
  storageKey: string;
  size: number;
  tableCount: number;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export const tenantsApi = {
  list: () => api<Envelope<ApiTenant[]>>("/api/tenants"),
  create: (input: { name: string; project?: string; env?: string }) =>
    api<Envelope<{ id: string; slug: string; name: string }>>("/api/tenants", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  switchTo: (tenant: string) =>
    api<Envelope<{ id: string; slug: string }>>("/api/tenants/switch", {
      method: "POST",
      body: JSON.stringify({ tenant }),
    }),
  members: (id: string) =>
    api<Envelope<ApiTenantMember[]>>(`/api/tenants/${id}/members`),
  invite: (id: string, input: { email: string; role: string }) =>
    api<Envelope<{ id: string; token: string; url: string; sent: boolean }>>(
      `/api/tenants/${id}/members/invite`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  removeMember: (tenantId: string, memberId: string) =>
    api<{ ok: true }>(`/api/tenants/${tenantId}/members/${memberId}`, {
      method: "DELETE",
    }),
};

export interface FtsBackfillResult {
  /** Rows whose searchable fields produced index text. */
  processed: number;
  /** Rows whose searchable fields were all empty. */
  skipped: number;
  total: number;
}

export const collectionsApi = {
  list: () =>
    api<Envelope<ApiCollection[]> & { meta?: { groups: string[] } }>(
      `/api/collections`,
    ),
  get: (slug: string) => api<Envelope<ApiCollection>>(`/api/collections/${slug}`),
  create: (input: Partial<ApiCollection> & { slug: string; fields: ApiCollection["fields"] }) =>
    api<Envelope<ApiCollection>>(`/api/collections`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  patch: (slug: string, input: Partial<ApiCollection>) =>
    api<{ ok: true; ftsBackfill?: FtsBackfillResult | null }>(`/api/collections/${slug}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  /** Duplicate a collection's schema (fields + metadata; never data) into a
   *  new managed collection. */
  clone: (slug: string, newSlug: string) =>
    api<Envelope<ApiCollection>>(`/api/collections/${slug}/clone`, {
      method: "POST",
      body: JSON.stringify({ slug: newSlug }),
    }),
  /** Rebuild the full-text index for every existing row. Only needed as a
   *  manual recovery — PATCH auto-backfills when the searchable set changes. */
  ftsReindex: (slug: string) =>
    api<{ ok: true } & FtsBackfillResult>(`/api/collections/${slug}/fts-reindex`, {
      method: "POST",
    }),
  /** Embed every existing row into the vector store. Deliberately manual
   *  (unlike the FTS auto-backfill) — each row costs an embedding call. */
  vectorizeBackfill: (slug: string) =>
    api<{ ok: true } & FtsBackfillResult>(`/api/collections/${slug}/vectorize`, {
      method: "POST",
    }),
  remove: (slug: string) =>
    api<{ ok: true; archived?: boolean }>(`/api/collections/${slug}`, { method: "DELETE" }),
  /** Drop a single field (column) from a managed collection. Destructive —
   *  the column's data is gone. Refused on adopted collections. */
  dropField: (slug: string, name: string) =>
    api<{ ok: true; slug: string; field: string }>(
      `/api/collections/${slug}/fields/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
  /** Re-activate an archived (adopted) collection. No-op on already-active rows. */
  restore: (slug: string) =>
    api<{ ok: true; alreadyActive?: boolean }>(`/api/collections/${slug}/restore`, {
      method: "POST",
    }),
  /** Fetch collections list, optionally including archived (adopted-soft-delete) rows. */
  listWithArchived: (includeArchived?: boolean) =>
    api<Envelope<ApiCollection[]> & { meta?: { groups: string[] } }>(
      `/api/collections${includeArchived ? "?include_archived=true" : ""}`,
    ),
  /** Persist the whole grouping/order layout in one request (Edit layout mode). */
  saveLayout: (input: CollectionsLayoutInput) =>
    api<{ ok: true; changed: number }>(`/api/collections/layout`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

export interface VectorCapabilityModel {
  key: string;
  label: string;
  provider: "workers-ai" | "openai" | "self-host";
  dimensions: number;
  /** Usable right now: provider configured + store can hold its vectors. */
  ready: boolean;
}

export interface VectorCapabilities {
  store: VectorStore;
  defaultModel: string | null;
  models: VectorCapabilityModel[];
}

export const vectorApi = {
  /** Deployment-level vector-search readiness — drives the collection
   *  Settings model picker so it never offers a model that can't embed. */
  capabilities: () => api<Envelope<VectorCapabilities>>(`/api/vector/capabilities`),
};

export interface TemplateSummary {
  id: string;
  label: string;
  description: string;
  /** Picker grouping (e.g. "Commerce", "Operations"). */
  category: string;
  /** Surfaced with a "Recommended" badge in the picker. */
  recommended: boolean;
  /** Total example rows seeded on apply across all the template's collections. */
  sampleRows: number;
  /** Admin group headers this template seeds, in order. */
  groups: string[];
  /** Bundled role names seeded on apply. */
  roles: string[];
  /** Bundled insights-dashboard names seeded on apply. */
  dashboards: string[];
  collections: { slug: string; label: string; fieldCount: number; group: string | null }[];
}
export interface TemplateCatalog {
  data: TemplateSummary[];
  defaultTemplateId: string;
  hasCollections: boolean;
  /** Sample rows still recorded in the seed manifest — drives the
   *  "Remove sample data" affordance on the Collections page. */
  sampleSeeds: number;
}
export interface ApplyTemplateResult {
  templateId: string;
  created: string[];
  skipped: string[];
  seeded: number;
  roles: string[];
  dashboards: string[];
}
export const templatesApi = {
  list: () => api<TemplateCatalog>(`/api/admin/templates`),
  apply: (templateId: string) =>
    api<{ data: ApplyTemplateResult }>(`/api/admin/templates/apply`, {
      method: "POST",
      body: JSON.stringify({ templateId }),
    }),
  /** Remove every template-seeded sample row (seed-manifest scoped). */
  clearSamples: () =>
    api<{ data: { removed: number; collections: string[] } }>(
      `/api/admin/templates/clear-samples`,
      { method: "POST", body: JSON.stringify({}) },
    ),
};

export interface ItemsListResp<T = Record<string, unknown>> {
  data: T[];
  limit: number;
  offset: number;
  meta?: { filter_count?: number; total_count?: number };
}

export const itemsApi = {
  list: (slug: string, query?: Record<string, string | number>) => {
    const qs = query
      ? "?" + new URLSearchParams(
          Object.fromEntries(
            Object.entries(query).map(([k, v]) => [k, String(v)]),
          ),
        ).toString()
      : "";
    return api<ItemsListResp>(`/api/items/${slug}${qs}`);
  },
  get: (slug: string, id: string, query?: Record<string, string | number>) => {
    const qs = query
      ? "?" + new URLSearchParams(
          Object.fromEntries(
            Object.entries(query).map(([k, v]) => [k, String(v)]),
          ),
        ).toString()
      : "";
    return api<Envelope<Record<string, unknown>>>(`/api/items/${slug}/${id}${qs}`);
  },
  create: (slug: string, body: Record<string, unknown>) =>
    api<Envelope<Record<string, unknown>>>(`/api/items/${slug}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patch: (slug: string, id: string, body: Record<string, unknown>, opts?: { ifUnmodifiedSince?: string }) =>
    api<Envelope<Record<string, unknown>>>(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      // Optimistic-concurrency precondition — the server answers 409 CONFLICT
      // when the row's updatedAt no longer matches (someone else saved).
      ...(opts?.ifUnmodifiedSince
        ? { headers: { "x-if-unmodified-since": opts.ifUnmodifiedSince } }
        : {}),
    }),
  remove: (slug: string, id: string) =>
    api<{ ok: true }>(`/api/items/${slug}/${id}`, { method: "DELETE" }),
  /** Many independent ops in one request (partial-success per row). The grid's
   *  paste path uses `update` ops when rows receive different values. */
  batch: (slug: string, operations: Array<{ op: "create" | "update" | "delete"; id?: string; data?: Record<string, unknown> }>) =>
    api<Envelope<{ total: number; succeeded: number; failed: number; results: { index: number; op: string; ok: boolean; id?: string; error?: { code: string; message: string } }[] }>>(
      `/api/items/${slug}/batch`,
      {
        method: "POST",
        body: JSON.stringify({ operations }),
      },
    ),
  /** Apply one shared patch to many selected ids (only the named fields change). */
  bulkUpdate: (slug: string, keys: string[], data: Record<string, unknown>) =>
    api<Envelope<{ total: number; updated: number; failed: number; results: { id: string; ok: boolean; error?: { code: string; message: string } }[] }>>(
      `/api/items/${slug}/bulk-update`,
      {
        method: "POST",
        body: JSON.stringify({ keys, data }),
      },
    ),
  /** Move a row before or after another in the same hand-arranged list. The
   *  server renumbers only what sits between the two — the caller states the
   *  intent, never a position. */
  reorder: (
    slug: string,
    field: string,
    id: string,
    to: { before: string } | { after: string },
  ) =>
    api<Envelope<{ position: number; shifted: number; repaired: number }>>(
      `/api/items/${slug}/reorder`,
      { method: "POST", body: JSON.stringify({ field, id, ...to }) },
    ),
  /** Discard a staged-edits item's pending staged patch without applying it. */
  discardStaged: (slug: string, id: string) =>
    api<{ ok: true }>(`/api/items/${slug}/${id}/staged`, { method: "DELETE" }),
  /** Publish now (versioned collections). */
  publish: (slug: string, id: string) =>
    api<Envelope<Record<string, unknown>>>(`/api/items/${slug}/${id}/publish`, {
      method: "POST",
    }),
  /** Revert to draft (clears any pending schedule). */
  unpublish: (slug: string, id: string) =>
    api<Envelope<Record<string, unknown>>>(`/api/items/${slug}/${id}/publish?unpublish=1`, {
      method: "POST",
    }),
  /** Archive — hidden from readers like a draft, but a distinct state. Leaves
   *  archived via publish/unpublish. */
  archive: (slug: string, id: string) =>
    api<Envelope<Record<string, unknown>>>(`/api/items/${slug}/${id}/publish?archive=1`, {
      method: "POST",
    }),
  /** Schedule a future publish (ISO), or pass null to cancel a pending one. */
  schedulePublish: (slug: string, id: string, publishAt: string | null) =>
    api<Envelope<Record<string, unknown>>>(`/api/items/${slug}/${id}/publish`, {
      method: "POST",
      body: JSON.stringify({ publishAt }),
    }),
  /** Set/clear an expiry (auto-unpublish, ISO), preserving current state. */
  scheduleUnpublish: (slug: string, id: string, unpublishAt: string | null) =>
    api<Envelope<Record<string, unknown>>>(`/api/items/${slug}/${id}/publish`, {
      method: "POST",
      body: JSON.stringify({ unpublishAt }),
    }),
  /** Bulk-import rows from a raw JSON-array or CSV string. */
  importItems: (slug: string, raw: string, format: "json" | "csv") =>
    api<Envelope<{ inserted: number; updated: number; failed: number; total: number; errors: { row: number; error: string }[] }>>(
      `/api/items/${slug}/import?format=${format}`,
      {
        method: "POST",
        headers: { "content-type": format === "csv" ? "text/csv" : "application/json" },
        body: raw,
      },
    ),
};

export interface ApiFlag {
  id: string;
  tenantId: string | null;
  key: string;
  enabled: boolean;
  value: unknown;
  rules: { condition?: unknown; rollout?: number } | null;
  description: string | null;
  createdAt: string | number;
  updatedAt: string | number;
}

export const flagsApi = {
  list: () => api<Envelope<ApiFlag[]>>("/api/admin/feature-flags"),
  upsert: (
    key: string,
    body: { enabled?: boolean; value?: unknown; rules?: { condition?: unknown; rollout?: number } | null; description?: string | null },
    scope: "tenant" | "global" = "tenant",
  ) =>
    api<Envelope<ApiFlag>>(
      `/api/admin/feature-flags/${encodeURIComponent(key)}${scope === "global" ? "?scope=global" : ""}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  remove: (key: string, scope: "tenant" | "global" = "tenant") =>
    api<{ ok: true }>(
      `/api/admin/feature-flags/${encodeURIComponent(key)}${scope === "global" ? "?scope=global" : ""}`,
      { method: "DELETE" },
    ),
};

export const usersApi = {
  list: () => api<Envelope<ApiUser[]>>(`/api/users`),
  invite: (email: string, role?: string) =>
    api<
      Envelope<{ id: string; email: string; token: string; url: string; sent: boolean }>
    >(`/api/users/invite`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),
  suspend: (id: string) =>
    api<{ ok: true }>(`/api/users/${id}/suspend`, { method: "PATCH" }),
  activate: (id: string) =>
    api<{ ok: true }>(`/api/users/${id}/activate`, { method: "PATCH" }),
  revokeInvite: (memberId: string) =>
    api<{ ok: true }>(`/api/users/invite/${memberId}`, { method: "DELETE" }),
  revokeAll: (id: string) =>
    api<{ ok: true }>(`/api/users/${id}/sessions/revoke-all`, { method: "POST" }),
  /** Recover a user locked out of 2FA: clears their TOTP secret + backup
   *  codes and revokes their sessions so they can sign in and re-enrol. */
  resetTwoFactor: (id: string) =>
    api<{ ok: true }>(`/api/users/${id}/reset-two-factor`, { method: "POST" }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/users/${id}`, { method: "DELETE" }),
  addRole: (userId: string, roleId: string) =>
    api<{ ok: true }>(`/api/users/${userId}/roles`, {
      method: "POST",
      body: JSON.stringify({ roleId }),
    }),
  removeRole: (userId: string, roleId: string) =>
    api<{ ok: true }>(`/api/users/${userId}/roles/${roleId}`, { method: "DELETE" }),
  update: (id: string, body: { name: string }) =>
    api<{ ok: true }>(`/api/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  sessions: (id: string) =>
    api<Envelope<{ id: string; userAgent: string | null; ipAddress: string | null; createdAt: number | null; updatedAt: number | null }[]>>(
      `/api/users/${id}/sessions`,
    ),
  revokeSession: (id: string, sessionId: string) =>
    api<{ ok: true }>(`/api/users/${id}/sessions/${sessionId}`, { method: "DELETE" }),
};

export const rolesApi = {
  list: () => api<Envelope<ApiRole[]>>(`/api/roles`),
};

export type PermissionAction = "read" | "create" | "update" | "delete" | "publish";

export interface PermissionSimRule {
  permissionId: string;
  roleId: string;
  roleName: string;
  collection: string;
  condition: unknown | null;
  fields: string[] | null;
  rowMatch?: boolean;
}

export interface PermissionSimulation {
  subject: {
    userId: string | null;
    email: string | null;
    roles: string[];
    tenantId: string | null;
    plane: "platform" | "app";
  };
  collection: string;
  action: string;
  allowed: boolean;
  isAdmin: boolean;
  reason: string;
  roles: { id: string; name: string; admin: boolean }[];
  matchedRules: PermissionSimRule[];
  resolvedVars: Record<string, unknown>;
  whereSql: { sql: string; params: unknown[] } | null;
  fields: string[] | null;
  rowMatch?: boolean;
}

export interface PermissionSimulateInput {
  collection: string;
  action: PermissionAction;
  userId?: string | null;
  email?: string | null;
  roles?: string[] | null;
  plane?: "platform" | "app";
  sampleRow?: Record<string, unknown> | null;
}

export const permissionsApi = {
  /** Dry-run the permission resolver and return the full allow/deny trace. */
  simulate: (input: PermissionSimulateInput) =>
    api<Envelope<PermissionSimulation>>(`/api/permissions/simulate`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

/** Workspace end-user pool admin (the `app_users` table). All endpoints are
 *  admin-only and scoped to the active workspace. */
export const appUsersApi = {
  /** `q` = email/name substring search; `ids` = batch label resolution for
   *  `interface: "user"` fields. */
  list: (params?: { q?: string; ids?: string[] }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.ids?.length) qs.set("ids", params.ids.join(","));
    const query = qs.toString();
    return api<Envelope<ApiAppUser[]>>(`/api/app-users${query ? `?${query}` : ""}`);
  },
  setRoles: (id: string, roleIds: string[]) =>
    api<{ ok: true; roleIds: string[] }>(`/api/app-users/${id}/roles`, {
      method: "PUT",
      body: JSON.stringify({ roleIds }),
    }),
  patch: (id: string, body: { status?: "active" | "suspended"; name?: string }) =>
    api<{ ok: true }>(`/api/app-users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/app-users/${id}`, { method: "DELETE" }),
  sessions: (id: string) =>
    api<Envelope<{ id: string; userAgent: string | null; ipAddress: string | null; createdAt: number | null; updatedAt: number | null }[]>>(
      `/api/app-users/${id}/sessions`,
    ),
  revokeSession: (id: string, sessionId: string) =>
    api<{ ok: true }>(`/api/app-users/${id}/sessions/${sessionId}`, { method: "DELETE" }),
};

/** A member's standing inside an organization — governs org administration,
 *  not data access. The workspace roles bound to them *within* the org do
 *  that, and live on `ApiOrgMember.roles`. */
export type OrgRole = "owner" | "admin" | "member";

export interface ApiOrg {
  id: string;
  slug: string;
  name: string;
  image: string | null;
  metadata: Record<string, unknown> | null;
  createdBy: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  memberCount: number;
}

export interface ApiOrgMember {
  appUserId: string;
  email: string;
  name: string | null;
  status: string;
  role: OrgRole;
  /** Workspace roles bound to this member within this org. */
  roles: { id: string; name: string }[];
  createdAt: number | null;
}

export interface ApiOrgInvite {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  roleIds: string[];
  invitedBy: string | null;
  expiresAt: number;
  acceptedAt: number | null;
  createdAt: number | null;
  pending: boolean;
}

/** App-plane organizations ("teams"). Admin-only, scoped to the active
 *  workspace. Every id argument also accepts the org's slug. */
export const appOrgsApi = {
  list: (params?: { q?: string }) => {
    const qs = params?.q ? `?q=${encodeURIComponent(params.q)}` : "";
    return api<Envelope<ApiOrg[]>>(`/api/app-orgs${qs}`);
  },
  create: (body: { name: string; slug?: string; ownerAppUserId?: string }) =>
    api<Envelope<ApiOrg>>(`/api/app-orgs`, { method: "POST", body: JSON.stringify(body) }),
  patch: (id: string, body: { name?: string; slug?: string; image?: string | null }) =>
    api<Envelope<ApiOrg>>(`/api/app-orgs/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) => api<{ ok: true }>(`/api/app-orgs/${id}`, { method: "DELETE" }),

  members: (id: string) => api<Envelope<ApiOrgMember[]>>(`/api/app-orgs/${id}/members`),
  addMember: (id: string, body: { appUserId: string; role?: OrgRole; roleIds?: string[] }) =>
    api<Envelope<ApiOrgMember>>(`/api/app-orgs/${id}/members`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchMember: (id: string, appUserId: string, body: { role?: OrgRole; roleIds?: string[] }) =>
    api<Envelope<ApiOrgMember>>(`/api/app-orgs/${id}/members/${appUserId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  removeMember: (id: string, appUserId: string) =>
    api<{ ok: true }>(`/api/app-orgs/${id}/members/${appUserId}`, { method: "DELETE" }),

  invites: (id: string, params?: { pending?: boolean }) =>
    api<Envelope<ApiOrgInvite[]>>(
      `/api/app-orgs/${id}/invites${params?.pending ? "?pending=true" : ""}`,
    ),
  invite: (id: string, body: { email: string; role?: OrgRole; roleIds?: string[] }) =>
    api<Envelope<{ id: string; email: string; role: OrgRole; token: string; expiresAt: number }>>(
      `/api/app-orgs/${id}/invites`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  revokeInvite: (id: string, inviteId: string) =>
    api<{ ok: true }>(`/api/app-orgs/${id}/invites/${inviteId}`, { method: "DELETE" }),
};

export const functionsApi = {
  list: () => api<Envelope<ApiFunction[]>>(`/api/functions`),
};

// ── Integrations (connected third-party providers) ──────────────────────────
export interface ApiIntegration {
  id: string;
  kind: string;
  status: string;
  events: string[] | null;
  lastEventAt?: number | string | null;
  consecutiveFailures?: number;
  disabledReason?: string | null;
}

export const integrationsApi = {
  list: () => api<Envelope<ApiIntegration[]>>(`/api/admin/integrations`),
};

// ── Extensions (installable admin add-ons, #13) ─────────────────────────────
export interface ApiExtensionPanel {
  id: string;
  title: string;
  icon?: string;
  entry: string;
}

export interface ApiExtensionFieldEditor {
  /** Interface id persisted as `field.interface` when an admin picks it. */
  interface: string;
  title: string;
  /** Storage types this editor accepts; absent = any type. */
  types?: string[];
  entry: string;
}

export interface ApiExtensionHook {
  id: string;
  trigger: "event" | "manual";
  pattern?: string;
  entry: string;
  timeoutMs?: number;
}

export interface ApiExtensionManifest {
  name: string;
  version: string;
  title: string;
  description?: string;
  contributes: {
    panels?: ApiExtensionPanel[];
    fieldEditors?: ApiExtensionFieldEditor[];
    hooks?: ApiExtensionHook[];
  };
  /** API allow-list for the iframe bridge, e.g. `"GET /api/items/posts"`,
   *  `"* /api/items/*"`. Enforced client- AND server-side. */
  permissions?: { api?: string[] };
}

export interface ApiExtension {
  id: string;
  name: string;
  version: string;
  source: "npm" | "upload";
  npmPackage: string | null;
  enabled: boolean;
  manifest: ApiExtensionManifest;
}

/** SandboxResult shape returned by the manual hook-invoke endpoint. */
export interface ApiExtensionHookResult {
  ok: boolean;
  logs: string[];
  error?: string;
  durationMs: number;
  value?: unknown;
}

export const extensionsApi = {
  list: () => api<Envelope<ApiExtension[]>>(`/api/extensions`),
  /** Enabled extensions only — readable by any signed-in user (drives the
   *  sidebar panels + field-editor injection, not just the admin page). */
  enabled: () => api<Envelope<ApiExtension[]>>(`/api/extensions/enabled`),
  install: (pkg: string, version?: string) =>
    api<Envelope<ApiExtension>>(`/api/extensions/install`, {
      method: "POST",
      body: JSON.stringify({ package: pkg, ...(version ? { version } : {}) }),
    }),
  upload: (files: Record<string, string>) =>
    api<Envelope<ApiExtension>>(`/api/extensions/upload`, {
      method: "POST",
      body: JSON.stringify({ files }),
    }),
  setEnabled: (name: string, enabled: boolean) =>
    api<Envelope<ApiExtension>>(`/api/extensions/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  uninstall: (name: string) =>
    api<{ ok: true }>(`/api/extensions/${encodeURIComponent(name)}`, { method: "DELETE" }),
  invokeHook: (name: string, hookId: string, body: unknown) =>
    api<ApiExtensionHookResult>(
      `/api/extensions/${encodeURIComponent(name)}/hooks/${encodeURIComponent(hookId)}/invoke`,
      { method: "POST", body: JSON.stringify(body ?? {}) },
    ),
};

export type ApiJobStatus =
  | "pending"
  | "active"
  | "succeeded"
  | "failed"
  | "dead_letter"
  | "cancelled";

export interface ApiJob {
  id: string;
  tenantId: string | null;
  queue: string;
  type: string;
  payload: Record<string, unknown>;
  status: ApiJobStatus;
  priority: number;
  runAt: string | number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  result: unknown;
  createdAt: string | number;
  completedAt: string | number | null;
}

export const jobsApi = {
  list: (q?: { queue?: string; status?: ApiJobStatus; limit?: number }) => {
    const params = new URLSearchParams();
    if (q?.queue) params.set("queue", q.queue);
    if (q?.status) params.set("status", q.status);
    if (q?.limit != null) params.set("limit", String(q.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return api<{ jobs: ApiJob[] }>(`/api/jobs${suffix}`);
  },
  get: (id: string) => api<ApiJob>(`/api/jobs/${encodeURIComponent(id)}`),
  enqueue: (body: {
    type: "function" | "webhook.deliver";
    payload?: Record<string, unknown>;
    queue?: string;
    runAt?: string;
    maxAttempts?: number;
    priority?: number;
  }) => api<{ id: string }>(`/api/jobs`, { method: "POST", body: JSON.stringify(body) }),
  retry: (id: string) =>
    api<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  cancel: (id: string) =>
    api<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

// ── Schema versions (migration diffing / schema branching, #9) ──────────────
export interface ApiSchemaSnapshotCollection {
  slug: string;
  fields: { name: string; type: string; [k: string]: unknown }[];
  [k: string]: unknown;
}
export interface ApiSchemaSnapshot {
  id: string;
  name: string;
  note: string | null;
  hash: string;
  kind: string;
  branchId: string | null;
  parentSnapshotId: string | null;
  createdBy: string | null;
  createdAt: number | string | null;
  collectionCount: number;
}
export interface ApiSchemaSnapshotFull extends ApiSchemaSnapshot {
  snapshot: ApiSchemaSnapshotCollection[];
}
export interface ApiSchemaBranch {
  id: string;
  name: string;
  note: string | null;
  headSnapshotId: string | null;
  baseSnapshotId: string | null;
  createdBy: string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
}
export interface ApiSchemaChange {
  kind: string;
  severity: "additive" | "destructive" | "metadata";
  collection: string;
  field?: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  ddl?: { pg: string[]; sqlite: string[] };
}
export interface ApiSchemaDiff {
  changes: ApiSchemaChange[];
  counts: { additive: number; destructive: number; metadata: number; total: number };
  hasDestructive: boolean;
}
export type ApiSchemaRef =
  | { kind: "live" }
  | { kind: "snapshot"; id: string }
  | { kind: "branch"; id: string };
export interface ApiSchemaApplyResult {
  diff: ApiSchemaDiff;
  applied: string[];
  safetySnapshotId: string | null;
  noop: boolean;
}

export const schemaVersionsApi = {
  listSnapshots: () => api<Envelope<ApiSchemaSnapshot[]>>(`/api/admin/schema/snapshots`),
  getSnapshot: (id: string) =>
    api<Envelope<ApiSchemaSnapshotFull>>(`/api/admin/schema/snapshots/${encodeURIComponent(id)}`),
  capture: (name: string, note?: string | null) =>
    api<Envelope<ApiSchemaSnapshotFull>>(`/api/admin/schema/snapshots`, {
      method: "POST",
      body: JSON.stringify({ name, note: note ?? null }),
    }),
  importSnapshot: (name: string, snapshot: ApiSchemaSnapshotCollection[], note?: string | null) =>
    api<Envelope<ApiSchemaSnapshotFull>>(`/api/admin/schema/snapshots/import`, {
      method: "POST",
      body: JSON.stringify({ name, snapshot, note: note ?? null }),
    }),
  deleteSnapshot: (id: string) =>
    api<{ ok: true }>(`/api/admin/schema/snapshots/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listBranches: () => api<Envelope<ApiSchemaBranch[]>>(`/api/admin/schema/branches`),
  createBranch: (name: string, opts?: { note?: string | null; fromSnapshotId?: string | null }) =>
    api<Envelope<ApiSchemaBranch>>(`/api/admin/schema/branches`, {
      method: "POST",
      body: JSON.stringify({ name, ...opts }),
    }),
  setBranchHead: (
    id: string,
    body: { data?: ApiSchemaSnapshotCollection[]; fromSnapshotId?: string | null; name?: string },
  ) =>
    api<Envelope<ApiSchemaBranch>>(`/api/admin/schema/branches/${encodeURIComponent(id)}/head`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteBranch: (id: string) =>
    api<{ ok: true }>(`/api/admin/schema/branches/${encodeURIComponent(id)}`, { method: "DELETE" }),
  diff: (from: ApiSchemaRef, to: ApiSchemaRef) =>
    api<Envelope<{ from: string; to: string; diff: ApiSchemaDiff }>>(`/api/admin/schema/diff`, {
      method: "POST",
      body: JSON.stringify({ from, to }),
    }),
  apply: (target: ApiSchemaRef, confirmDestructive?: boolean) =>
    api<Envelope<ApiSchemaApplyResult>>(`/api/admin/schema/apply`, {
      method: "POST",
      body: JSON.stringify({ target, confirmDestructive }),
    }),
};

export const documentsApi = {
  list: () => api<Envelope<ApiDocumentTemplate[]>>(`/api/admin/documents/templates`),
  save: (key: string, body: Partial<ApiDocumentTemplate>) =>
    api<Envelope<ApiDocumentTemplate>>(`/api/admin/documents/templates/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  remove: (key: string) =>
    api<{ ok: true }>(`/api/admin/documents/templates/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  /** Returns the PDF itself, so this bypasses the JSON envelope helper. */
  render: async (body: Record<string, unknown>): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/api/admin/documents/render`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", ...sessionHeaders() },
      body: JSON.stringify(body),
    });
    captureBookmark(res);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(err.error?.message ?? `Render failed (${res.status})`);
    }
    return res.blob();
  },
};

/**
 * Availability & booking. Mirrors `/api/admin/booking`.
 *
 * `createResource` and `rotateToken` are the only two calls that ever see the
 * public page token, and each sees it once: only its hash is stored, so a page
 * that does not keep what it was handed cannot ask again.
 */
export const bookingApi = {
  listResources: () => api<Envelope<ApiBookingResource[]>>(`/api/admin/booking/resources`),
  getResource: (key: string) =>
    api<Envelope<ApiBookingResource>>(`/api/admin/booking/resources/${encodeURIComponent(key)}`),
  createResource: (body: Record<string, unknown>) =>
    api<Envelope<{ resource: ApiBookingResource; token: string; url: string }>>(
      `/api/admin/booking/resources`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  updateResource: (key: string, body: Record<string, unknown>) =>
    api<Envelope<ApiBookingResource>>(`/api/admin/booking/resources/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteResource: (key: string, force = false) =>
    api<Envelope<{ ok: boolean }>>(
      `/api/admin/booking/resources/${encodeURIComponent(key)}${force ? "?force=true" : ""}`,
      { method: "DELETE" },
    ),
  rotateToken: (key: string) =>
    api<Envelope<{ token: string; url: string }>>(
      `/api/admin/booking/resources/${encodeURIComponent(key)}/rotate-token`,
      { method: "POST" },
    ),
  slots: (key: string, window: { from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    if (window.from) q.set("from", window.from);
    if (window.to) q.set("to", window.to);
    const qs = q.toString();
    return api<
      Envelope<{
        resource: Record<string, unknown>;
        from: string;
        to: string;
        slots: ApiBookingSlot[];
      }>
    >(`/api/admin/booking/resources/${encodeURIComponent(key)}/slots${qs ? `?${qs}` : ""}`);
  },
  listBookings: (query: Record<string, string | undefined> = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
    const qs = q.toString();
    return api<Envelope<ApiBooking[]> & { total: number }>(
      `/api/admin/booking/bookings${qs ? `?${qs}` : ""}`,
    );
  },
  book: (body: Record<string, unknown>) =>
    api<Envelope<{ booking: ApiBooking; manageToken: string; manageUrl: string; emailed: boolean }>>(
      `/api/admin/booking/bookings`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  confirm: (id: string) =>
    api<Envelope<ApiBooking>>(`/api/admin/booking/bookings/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
    }),
  cancel: (id: string, body: Record<string, unknown> = {}) =>
    api<Envelope<ApiBooking>>(`/api/admin/booking/bookings/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  reschedule: (id: string, start: string) =>
    api<Envelope<{ booking: ApiBooking; manageToken: string; manageUrl: string; emailed: boolean }>>(
      `/api/admin/booking/bookings/${encodeURIComponent(id)}/reschedule`,
      { method: "POST", body: JSON.stringify({ start }) },
    ),
  noShow: (id: string) =>
    api<Envelope<ApiBooking>>(`/api/admin/booking/bookings/${encodeURIComponent(id)}/no-show`, {
      method: "POST",
    }),
  /** Record it into its collection again. Answers 422 with the reason when it
   *  still cannot — the write path swallows that so a customer never meets an
   *  error over a bookkeeping problem, which is why the retry must not. */
  record: (id: string) =>
    api<Envelope<ApiBooking>>(`/api/admin/booking/bookings/${encodeURIComponent(id)}/record`, {
      method: "POST",
    }),
};

export const signaturesApi = {
  list: (status?: string) =>
    api<Envelope<ApiSignatureRequest[]> & { total: number }>(
      `/api/admin/signatures${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  get: (id: string) => api<Envelope<ApiSignatureRequest>>(`/api/admin/signatures/${encodeURIComponent(id)}`),
  create: (body: Record<string, unknown>) =>
    api<
      Envelope<{
        request: ApiSignatureRequest;
        /** Shown once, right after creation — only hashes are stored. */
        links: Array<{ signerId: string; email: string; url: string }>;
        sent: boolean;
      }>
    >(`/api/admin/signatures`, { method: "POST", body: JSON.stringify(body) }),
  void: (id: string, reason?: string) =>
    api<Envelope<ApiSignatureRequest>>(`/api/admin/signatures/${encodeURIComponent(id)}/void`, {
      method: "POST",
      body: JSON.stringify({ reason: reason ?? null }),
    }),
  resend: (id: string, signerId: string) =>
    api<Envelope<{ sent: boolean; email: string }>>(
      `/api/admin/signatures/${encodeURIComponent(id)}/signers/${encodeURIComponent(signerId)}/resend`,
      { method: "POST" },
    ),
  /** Produce the signed copy for a request whose signers have all signed but
   *  whose artefact never rendered. Idempotent — see the route's own note. */
  finalize: (id: string) =>
    api<Envelope<ApiSignatureRequest>>(
      `/api/admin/signatures/${encodeURIComponent(id)}/finalize`,
      { method: "POST" },
    ),
  /** The stored PDF — bytes, so it bypasses the JSON envelope helper (and the
   *  bookmark capture that rides on it, which is why it is done by hand). */
  document: async (id: string, which: "original" | "signed" = "signed"): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/api/admin/signatures/${encodeURIComponent(id)}/document?which=${which}`,
      { credentials: "include", headers: sessionHeaders() },
    );
    captureBookmark(res);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(err.error?.message ?? `Download failed (${res.status})`);
    }
    return res.blob();
  },
};

/** The signer's side — unauthenticated, token in the path. */
export const signPublicApi = {
  /** `lang` is the locale the page actually rendered in — the server picks the
   *  consent wording from it and stores the sentence it picked. */
  get: (token: string, lang?: string) =>
    api<Envelope<ApiSignerView>>(
      `/api/public/sign/${encodeURIComponent(token)}${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`,
    ),
  sign: (
    token: string,
    body: { kind: "drawn" | "typed"; image?: string; text?: string; consent: boolean },
    lang?: string,
  ) =>
    api<Envelope<{ status: string; signedCount: number; signerCount: number; finalized: boolean }>>(
      `/api/public/sign/${encodeURIComponent(token)}/sign${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  decline: (token: string, reason: string | null) =>
    api<Envelope<{ status: string }>>(`/api/public/sign/${encodeURIComponent(token)}/decline`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  documentUrl: (token: string) => `${API_BASE}/api/public/sign/${encodeURIComponent(token)}/document`,
};

export interface ApiApprover {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  order: number;
  status: "pending" | "viewed" | "approved" | "rejected";
  sentAt?: unknown;
  viewedAt?: unknown;
  decidedAt?: unknown;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface ApiApprovalRequest {
  id: string;
  title: string;
  message: string | null;
  subject: { collection: string; id: string } | null;
  summary: Array<{ label: string; value: string }>;
  policy: "all" | "any" | "quorum";
  quorum: number;
  ordered: boolean;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  expiresAt?: unknown;
  settledAt?: unknown;
  outcomeReason: string | null;
  writeBack: Record<string, unknown> | null;
  createdBy: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  approvers: ApiApprover[];
}

/** Approvals, operator side. There is no decide call here on purpose — that is
 *  the approver's act, authenticated by their own link. */
export const approvalsApi = {
  list: (status?: string) =>
    api<Envelope<ApiApprovalRequest[]>>(
      `/api/admin/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  get: (id: string) => api<Envelope<ApiApprovalRequest>>(`/api/admin/approvals/${encodeURIComponent(id)}`),
  cancel: (id: string, reason: string | null) =>
    api<Envelope<ApiApprovalRequest>>(`/api/admin/approvals/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
};

export interface ApiApprovalDecisionView {
  title: string;
  message: string | null;
  summary: Array<{ label: string; value: string }>;
  status: string;
  policy: string;
  ordered: boolean;
  expiresAt?: unknown;
  you: {
    email: string;
    name: string | null;
    role: string | null;
    status: string;
    position: number;
    of: number;
  };
  decided: Array<{ name: string | null; email: string; status: string; decidedAt?: unknown }>;
  /** Non-null when the page must explain why it cannot be acted on. */
  blocked: string | null;
}

/** The approver's side — unauthenticated, token in the path. */
export const approvePublicApi = {
  get: (token: string) =>
    api<Envelope<ApiApprovalDecisionView>>(`/api/public/approve/${encodeURIComponent(token)}`),
  decide: (token: string, decision: "approve" | "reject", reason?: string) =>
    api<Envelope<{ status: string; outcome: string }>>(
      `/api/public/approve/${encodeURIComponent(token)}`,
      { method: "POST", body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }) },
    ),
};

export interface ApiBookerView {
  id: string;
  resource: { key: string; name: string; timeZone: string; settings: PublicAppearance | null };
  start: string;
  end: string;
  status: string;
  customerName: string | null;
  customerEmail: string | null;
  answers: Record<string, unknown>;
  cancelReason: string | null;
  canCancel: boolean;
}

export interface ApiPublicSlots {
  resource: {
    key: string;
    name: string;
    description: string | null;
    timeZone: string;
    slotMinutes: number;
    capacity: number;
    questions: ApiBookingQuestion[];
    confirmationMessage: string | null;
    /** How the page paints itself. Null is the system light/dark default. */
    settings: PublicAppearance | null;
  };
  from: string;
  to: string;
  slots: ApiBookingSlot[];
}

/**
 * The booker's own endpoints. No credentials anywhere: the page token is the
 * grant to see a calendar and the manage token the grant to change one
 * appointment, so neither call carries a session.
 */
export const bookPublicApi = {
  slots: (token: string, window: { from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    if (window.from) q.set("from", window.from);
    if (window.to) q.set("to", window.to);
    const qs = q.toString();
    return api<Envelope<ApiPublicSlots>>(
      `/api/public/book/${encodeURIComponent(token)}/slots${qs ? `?${qs}` : ""}`,
    );
  },
  book: (token: string, body: Record<string, unknown>) =>
    api<Envelope<{ booking: ApiBookerView; manageUrl: string; emailed: boolean }>>(
      `/api/public/book/${encodeURIComponent(token)}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  get: (token: string) =>
    api<Envelope<ApiBookerView>>(`/api/public/book/manage/${encodeURIComponent(token)}`),
  cancel: (token: string, reason?: string) =>
    api<Envelope<ApiBookerView>>(`/api/public/book/manage/${encodeURIComponent(token)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ ...(reason ? { reason } : {}) }),
    }),
  reschedule: (token: string, start: string) =>
    api<Envelope<{ booking: ApiBookerView; manageUrl: string; emailed: boolean }>>(
      `/api/public/book/manage/${encodeURIComponent(token)}/reschedule`,
      { method: "POST", body: JSON.stringify({ start }) },
    ),
};

export const emailTemplatesApi = {
  list: () => api<Envelope<ApiEmailTemplate[]>>(`/api/admin/email-templates`),
  get: (id: string) => api<Envelope<ApiEmailTemplate>>(`/api/admin/email-templates/${id}`),
  create: (body: Omit<ApiEmailTemplate, "id" | "tenantId">) =>
    api<Envelope<ApiEmailTemplate>>(`/api/admin/email-templates`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patch: (id: string, body: Partial<ApiEmailTemplate>) =>
    api<{ ok: true }>(`/api/admin/email-templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/email-templates/${id}`, { method: "DELETE" }),
  sendTest: (id: string, vars?: Record<string, string>) =>
    api<{ ok: true }>(`/api/admin/email-templates/${id}/send-test`, {
      method: "POST",
      body: JSON.stringify({ vars }),
    }),
};

export const workspaceConfigApi = {
  /** Public resolved view — used by `main.tsx` boot-time branding injection. */
  getResolved: () =>
    api<Envelope<ApiWorkspaceConfigResolved>>(`/api/workspace-config`),
  /** Admin form: workspace's own row, no `_global` fallback applied. */
  getRaw: () => api<Envelope<ApiWorkspaceConfigRaw>>(`/api/workspace-config/raw`),
  put: (body: {
    workspaceName?: string | null;
    description?: string | null;
    logoFileKey?: string | null;
    faviconFileKey?: string | null;
    primaryColor?: string | null;
    defaultTheme?: "light" | "dark" | "system" | "" | null;
  }) =>
    api<{ ok: true }>(`/api/workspace-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};

export const emailConfigApi = {
  get: () => api<Envelope<ApiEmailConfig>>(`/api/admin/email-config`),
  put: (body: {
    provider: string;
    fromAddress?: string | null;
    config?: Record<string, unknown>;
    secrets?: Record<string, string | null>;
  }) =>
    api<{ ok: true }>(`/api/admin/email-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  sendTest: (to?: string) =>
    api<{ ok: true; to: string }>(`/api/admin/email-config/test`, {
      method: "POST",
      body: JSON.stringify({ to }),
    }),
};

export interface ApiPushConfig {
  tenantId: string;
  /** inherit | console | fcm | apns | web-push */
  provider: string;
  /** Non-secret provider params (fcm: projectId/clientEmail; apns:
   *  keyId/teamId/bundleId/production; web-push: subject/vapidPublicKey). */
  config: Record<string, unknown>;
  secretsSet: { privateKey: boolean; vapidPrivateKey: boolean };
  updatedAt: number | string | null;
  env: { provider: string | null };
  providerIds: readonly string[];
}

export const pushConfigApi = {
  get: () => api<Envelope<ApiPushConfig>>(`/api/admin/push-config`),
  put: (body: {
    provider: string;
    config?: Record<string, unknown>;
    secrets?: Record<string, string | null>;
  }) =>
    api<{ ok: true }>(`/api/admin/push-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  sendTest: () =>
    api<{ ok: true; sent: number; failed: number }>(`/api/admin/push-config/test`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
};

export interface ApiDeviceToken {
  id: string;
  platform: string;
  token: string;
  deviceName: string | null;
  isActive: boolean;
  createdAt: number | string;
  lastSeenAt: number | string | null;
}

export const deviceTokensApi = {
  list: () => api<Envelope<ApiDeviceToken[]>>(`/api/device-tokens`),
  register: (body: {
    platform: "fcm" | "apns" | "web-push";
    token: string;
    keys?: { p256dh: string; auth: string };
    deviceName?: string;
  }) =>
    api<Envelope<{ id: string }>>(`/api/device-tokens`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/device-tokens/${id}`, { method: "DELETE" }),
};

export interface ApiSmsConfig {
  tenantId: string;
  /** inherit | console | twilio | sns */
  provider: string;
  /** Non-secret provider params (twilio: accountSid/from/messagingServiceSid;
   *  sns: region/accessKeyId/senderId). */
  config: Record<string, unknown>;
  secretsSet: { authToken: boolean; secretAccessKey: boolean };
  updatedAt: number | string | null;
  env: { provider: string | null };
  providerIds: readonly string[];
}

export const smsConfigApi = {
  get: () => api<Envelope<ApiSmsConfig>>(`/api/admin/sms-config`),
  put: (body: {
    provider: string;
    config?: Record<string, unknown>;
    secrets?: Record<string, string | null>;
  }) =>
    api<{ ok: true }>(`/api/admin/sms-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  sendTest: (to?: string) =>
    api<{ ok: true; sent: number; failed: number }>(`/api/admin/sms-config/test`, {
      method: "POST",
      body: JSON.stringify(to ? { to } : {}),
    }),
};

/** One entry of the server's AI provider registry (`services/ai-providers.ts`).
 *  Descriptive only — `envKey` is the NAME of an env var, never its value. */
export interface ApiAiProvider {
  id: string;
  label: string;
  secretKey: string;
  secretLabel: string;
  envKey: string;
  transport: "gateway" | "direct";
  defaultModel: string;
  hint: string;
  docsUrl: string;
}

/** One selectable model from the server's catalog. */
export interface ApiAiModel {
  id: string;
  label: string;
  namespace: string;
  hint: string;
  tier: "flagship" | "balanced" | "fast";
}

export interface ApiAiConfig {
  tenantId: string;
  /** `inherit` or a registry provider id. */
  provider: string;
  config: Record<string, unknown>;
  /** Per-provider "is a key stored" flag, keyed by `ApiAiProvider.secretKey`.
   *  Never the key itself. */
  secretsSet: Record<string, boolean>;
  updatedAt: number | string | null;
  env: { cloud: boolean; hasGatewayKey: boolean; hasAnthropicKey: boolean };
  providerIds: readonly string[];
  providers: readonly ApiAiProvider[];
  models: readonly ApiAiModel[];
  /** Model ids each provider id can actually run — drives the picker filter. */
  modelsByProvider: Record<string, readonly string[]>;
}

export const aiConfigApi = {
  get: () => api<Envelope<ApiAiConfig>>(`/api/admin/ai-config`),
  put: (body: {
    provider: string;
    config?: Record<string, unknown>;
    secrets?: Record<string, string | null>;
  }) =>
    api<{ ok: true }>(`/api/admin/ai-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  test: () =>
    api<{ ok: true; reply: string }>(`/api/admin/ai-config/test`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
};

export const i18nApi = {
  list: () => api<Envelope<ApiI18nString[]>>(`/api/admin/i18n`),
  matrix: () =>
    api<{
      data: Record<string, Record<string, string>>;
      locales: string[];
      configuredLocales: string[];
      defaultLocale: string;
    }>(`/api/admin/i18n/_matrix`),
  upsert: (key: string, locale: string, value: string) =>
    api<Envelope<ApiI18nString>>(`/api/admin/i18n`, {
      method: "PUT",
      body: JSON.stringify({ key, locale, value }),
    }),
  bulkUpsert: (rows: { key: string; locale: string; value: string }[]) =>
    api<{ ok: true; upserts: number }>(`/api/admin/i18n/_bulk`, {
      method: "PUT",
      body: JSON.stringify(rows),
    }),
  autoTranslate: (input: {
    targetLocale: string;
    sourceLocale?: string;
    keys?: string[];
    onlyMissing?: boolean;
  }) =>
    api<{
      ok: true;
      translated: number;
      remaining?: number;
      rows: { id: string; key: string; locale: string; value: string }[];
    }>(`/api/admin/i18n/_auto-translate`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

export const panelsApi = {
  list: () => api<Envelope<ApiPanel[]>>(`/api/admin/panels`),
  create: (body: Omit<ApiPanel, "id">) =>
    api<Envelope<ApiPanel>>(`/api/admin/panels`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<Omit<ApiPanel, "id">>) =>
    api<Envelope<ApiPanel>>(`/api/admin/panels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/panels/${id}`, { method: "DELETE" }),
  run: (id: string) =>
    api<Envelope<Record<string, unknown>[]> & { ms: number }>(`/api/admin/panels/${id}/run`, {
      method: "POST",
    }),
  preview: (body: {
    kind: "sql" | "items-aggregate" | "analytics" | "kpi";
    sql?: string;
    config?: unknown;
  }) =>
    api<Envelope<Record<string, unknown>[]> & { ms: number }>(`/api/admin/panels/preview`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export const kpisApi = {
  list: () => api<Envelope<ApiKpi[]>>(`/api/admin/kpis`),
  get: (ref: string) => api<Envelope<ApiKpi>>(`/api/admin/kpis/${encodeURIComponent(ref)}`),
  create: (body: ApiKpiInput) =>
    api<Envelope<ApiKpi>>(`/api/admin/kpis`, { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: Partial<ApiKpiInput>) =>
    api<Envelope<ApiKpi>>(`/api/admin/kpis/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) => api<{ ok: true }>(`/api/admin/kpis/${id}`, { method: "DELETE" }),
  /** Evaluate one KPI. `rangeDays` is the friendly form; `from`/`to` are epoch
   *  ms for an explicit window. Scoped server-side to the caller's read
   *  permission on the KPI's collection. */
  run: (
    ref: string,
    params: {
      rangeDays?: number;
      from?: number;
      to?: number;
      series?: boolean;
      buckets?: number;
      /** Narrow to one row of the KPI's `pinTo` collection. */
      rowId?: string;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs}` : "";
    return api<Envelope<ApiKpiResult>>(
      `/api/admin/kpis/${encodeURIComponent(ref)}/run${suffix}`,
    );
  },
};

export const dashboardsApi = {
  list: () => api<Envelope<ApiDashboard[]>>(`/api/admin/dashboards`),
  get: (id: string) => api<Envelope<ApiDashboard>>(`/api/admin/dashboards/${id}`),
  create: (body: { name: string; description?: string | null; layout?: Record<string, unknown> | null }) =>
    api<Envelope<ApiDashboard>>(`/api/admin/dashboards`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<{ name: string; description: string | null; layout: Record<string, unknown> | null }>) =>
    api<{ ok: true }>(`/api/admin/dashboards/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/dashboards/${id}`, { method: "DELETE" }),
  run: (id: string) =>
    api<Envelope<ApiDashboardPanelResult[]> & { ms: number }>(`/api/admin/dashboards/${id}/run`, {
      method: "POST",
    }),
  share: (id: string, body: { roleId?: string | null } = {}) =>
    api<{ token: string; url: string }>(`/api/admin/dashboards/${id}/share`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revoke: (id: string) =>
    api<{ ok: true }>(`/api/admin/dashboards/${id}/share`, { method: "DELETE" }),
  report: (id: string, body: ApiDashboardReportInput = {}) =>
    api<ApiDashboardReport>(`/api/admin/dashboards/${id}/report`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** The download shape — bytes, not JSON, so it bypasses the envelope helper
   *  and comes back as a Blob the browser can save. Mirrors `documentsApi.render`. */
  reportPdf: async (id: string, body: ApiDashboardReportInput = {}): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/api/admin/dashboards/${id}/report`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({ ...body, download: true }),
    });
    captureBookmark(res);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(err.error?.message ?? `Report failed (${res.status})`);
    }
    return res.blob();
  },
};

export const dashboardsPublicApi = {
  get: (token: string) =>
    api<Envelope<ApiPublicDashboard>>(`/api/public/dashboards/${encodeURIComponent(token)}`),
};

export const authAdminApi = {
  config: () => api<Envelope<ApiAuthConfig>>(`/api/admin/auth/config`),
  patch: (body: Partial<ApiAuthConfig>) =>
    api<{ ok: true }>(`/api/admin/auth/config`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  sessions: () => api<Envelope<ApiSession[]>>(`/api/admin/auth/sessions`),
  revokeSession: (id: string) =>
    api<{ ok: true }>(`/api/admin/auth/sessions/${id}`, { method: "DELETE" }),
  revokeOthers: () =>
    api<{ ok: true; removed: number }>(`/api/admin/auth/sessions/revoke-others`, {
      method: "POST",
    }),
};

export interface ApiSamlProvider {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  idpTemplate: string | null;
  entityId: string;
  ssoUrl: string;
  sloUrl: string | null;
  /** True when an encrypted cert PEM is stored. Plaintext is never returned. */
  idpCertSet: boolean;
  spEntityId: string;
  attributeMap: Record<string, string>;
  defaultRoleId: string | null;
  groupsToRoles: Record<string, string> | null;
  signatureAlgorithm: string;
  wantSignedAssertions: boolean;
  linkByVerifiedEmail: boolean;
  nameIdFormat: string;
  enabled: boolean;
  createdAt: string | number;
  updatedAt: string | number;
}

export interface SamlProviderCreate {
  name: string;
  slug?: string;
  idpTemplate?: string | null;
  entityId: string;
  ssoUrl: string;
  sloUrl?: string | null;
  idpCertPem: string;
  spEntityId: string;
  attributeMap?: Record<string, string>;
  defaultRoleId?: string | null;
  groupsToRoles?: Record<string, string> | null;
  signatureAlgorithm?: "sha1" | "sha256" | "sha512";
  wantSignedAssertions?: boolean;
  linkByVerifiedEmail?: boolean;
  nameIdFormat?: string;
  enabled?: boolean;
}

export const samlAdminApi = {
  list: () => api<Envelope<ApiSamlProvider[]>>(`/api/admin/saml/providers`),
  create: (body: SamlProviderCreate) =>
    api<Envelope<ApiSamlProvider>>(`/api/admin/saml/providers`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<SamlProviderCreate>) =>
    api<Envelope<ApiSamlProvider>>(`/api/admin/saml/providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/saml/providers/${id}`, { method: "DELETE" }),
  testAssertion: (id: string, samlResponse: string) =>
    api<Envelope<{
      nameId: string;
      issuer: string;
      audience: string;
      authnContext: string | null;
      sessionIndex: string | null;
      notOnOrAfter: string;
      attributes: Record<string, string[]>;
      mapped: { email: string | null; firstName: string | null; lastName: string | null; groups: string[] };
    }>>(`/api/admin/saml/providers/${id}/test-assertion`, {
      method: "POST",
      body: JSON.stringify({ samlResponse }),
    }),
  importMetadata: (body: { metadataXml?: string; metadataUrl?: string }) =>
    api<Envelope<{
      entityId: string;
      ssoUrl: string;
      sloUrl: string | null;
      idpCertPem: string;
      spEntityIdSuggested: string;
    }>>(`/api/admin/saml/providers/import-metadata`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

/** Sanitized generic OIDC / OAuth2 provider row from GET /api/admin/oidc/providers.
 *  The client secret has no read-back path — the server only tells us whether one
 *  is stored via `hasClientSecret`, so the edit form must never treat a blank
 *  secret field as "clear the credential". */
export interface ApiOidcProvider {
  id: string;
  name: string;
  slug: string;
  clientId: string;
  /** True when an encrypted client secret is stored. Plaintext never returned. */
  hasClientSecret: boolean;
  discoveryUrl: string | null;
  authorizationUrl: string | null;
  tokenUrl: string | null;
  userInfoUrl: string | null;
  scopes: string[];
  pkce: boolean;
  emailClaim: string | null;
  groupsClaim: string | null;
  defaultRoleId: string | null;
  groupsToRoles: Record<string, string> | null;
  linkByVerifiedEmail: boolean;
  enabled: boolean;
  createdAt: string | number | null;
  updatedAt: string | number | null;
}

export interface OidcProviderCreate {
  name: string;
  slug: string;
  clientId: string;
  /** Plaintext, write-only. Omit on PATCH to keep the stored credential. */
  clientSecret?: string;
  discoveryUrl?: string | null;
  authorizationUrl?: string | null;
  tokenUrl?: string | null;
  userInfoUrl?: string | null;
  scopes?: string[];
  pkce?: boolean;
  emailClaim?: string | null;
  groupsClaim?: string | null;
  defaultRoleId?: string | null;
  groupsToRoles?: Record<string, string> | null;
  linkByVerifiedEmail?: boolean;
  enabled?: boolean;
}

/** What POST /api/admin/oidc/discover resolves out of an IdP's
 *  `.well-known/openid-configuration`. Every field is optional because a
 *  discovery document is only required to carry authorize + token. */
export interface OidcDiscovery {
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopesSupported?: string[];
}

/** SCIM provisioning config. The bearer token is write-only: this shape carries
 *  a display prefix, never the token, and `POST /token` is the only place the
 *  plaintext ever appears. */
export interface ApiScimConfig {
  id: string;
  enabled: boolean;
  tokenPrefix: string;
  defaultRoleId: string | null;
  lastRequestAt: number | string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
}

/** A blocking hook: runs before a write and decides whether it happens. */
export interface ApiSyncHook {
  id: string;
  name: string;
  url: string;
  events: string[];
  headers: Record<string, string> | null;
  timeoutMs: number;
  onError: "allow" | "deny";
  canMutate: boolean;
  priority: number;
  enabled: boolean;
  /** Presence only — the signing secret has no read-back path. */
  hasSecret: boolean;
  consecutiveFailures: number;
  lastFailureAt: number | string | null;
  disabledReason: string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
}

export interface SyncHookInput {
  name: string;
  url: string;
  events: string[];
  onError: "allow" | "deny";
  secret?: string | null;
  headers?: Record<string, string> | null;
  timeoutMs?: number;
  canMutate?: boolean;
  priority?: number;
  enabled?: boolean;
}

export interface SyncHookTestResult {
  ok: boolean;
  ms: number;
  error?: string;
  verdict?: { allow: boolean; reason?: string; data?: Record<string, unknown> };
}

export const syncHooksApi = {
  list: () => api<Envelope<ApiSyncHook[]>>(`/api/admin/sync-hooks`),
  create: (body: SyncHookInput) =>
    api<Envelope<ApiSyncHook>>(`/api/admin/sync-hooks`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<SyncHookInput>) =>
    api<Envelope<ApiSyncHook>>(`/api/admin/sync-hooks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) => api<{ ok: true }>(`/api/admin/sync-hooks/${id}`, { method: "DELETE" }),
  test: (id: string) =>
    api<SyncHookTestResult>(`/api/admin/sync-hooks/${id}/test`, { method: "POST" }),
};

export const scimAdminApi = {
  get: () => api<Envelope<ApiScimConfig | null>>(`/api/admin/scim`),
  /** Creates or rotates. `token` is returned ONCE and is not recoverable. */
  issueToken: (body: { defaultRoleId?: string | null } = {}) =>
    api<Envelope<ApiScimConfig> & { token: string; baseUrl: string }>(`/api/admin/scim/token`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (body: { enabled?: boolean; defaultRoleId?: string | null }) =>
    api<Envelope<ApiScimConfig>>(`/api/admin/scim`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: () => api<{ ok: true }>(`/api/admin/scim`, { method: "DELETE" }),
};

export const oidcAdminApi = {
  list: () => api<Envelope<ApiOidcProvider[]>>(`/api/admin/oidc/providers`),
  create: (body: OidcProviderCreate) =>
    api<Envelope<ApiOidcProvider>>(`/api/admin/oidc/providers`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<OidcProviderCreate>) =>
    api<Envelope<ApiOidcProvider>>(`/api/admin/oidc/providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/oidc/providers/${id}`, { method: "DELETE" }),
  discover: (url: string) =>
    api<Envelope<OidcDiscovery>>(`/api/admin/oidc/discover`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
};

/** Sanitized LDAP config row returned by GET /api/admin/ldap-config. The
 *  encrypted `bindPassword` + `caPem` never travel the wire — `secretsSet`
 *  carries a "is this set" flag per key instead. */
export interface ApiLdapConfig {
  tenantId: string;
  enabled: boolean;
  url: string;
  bindDn: string;
  baseDn: string;
  userFilter: string;
  groupFilter: string | null;
  attributeMap: { email: string; firstName: string; lastName: string; groups: string };
  defaultRoleId: string | null;
  groupsToRoles: Record<string, string> | null;
  tlsOptions: { rejectUnauthorized?: boolean } | null;
  secretsSet: { bindPassword: boolean; caPem: boolean };
  domainMatch: string[] | null;
  rateLimitPerMinute: number;
  updatedAt: string | number | null;
}

export interface LdapConfigPatch {
  enabled?: boolean;
  url?: string;
  bindDn?: string;
  baseDn?: string;
  userFilter?: string;
  groupFilter?: string | null;
  attributeMap?: Partial<{
    email: string;
    firstName: string;
    lastName: string;
    groups: string;
  }>;
  defaultRoleId?: string | null;
  groupsToRoles?: Record<string, string> | null;
  tlsOptions?: { rejectUnauthorized?: boolean } | null;
  domainMatch?: string[] | null;
  rateLimitPerMinute?: number;
  /** `""`/`null` clears a key; omitting one leaves the stored ciphertext
   *  in place. */
  secrets?: { bindPassword?: string | null; caPem?: string | null };
}

export const ldapAdminApi = {
  load: () => api<Envelope<ApiLdapConfig>>(`/api/admin/ldap-config`),
  save: (body: LdapConfigPatch) =>
    api<{ ok: true }>(`/api/admin/ldap-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  test: (username: string, password: string) =>
    api<
      | { ok: true; dn: string; attributes: { email: string | null; firstName: string | null; lastName: string | null; groups: string[] } }
      | { ok: false; reason: string }
    >(`/api/admin/ldap-config/test`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
};

// --- Platform (control-plane / admin) SSO — instance-global, no tenant. ---

/** Sanitized platform SAML provider (no `tenantId`; cert PEM never returned). */
export interface ApiPlatformSamlProvider {
  id: string;
  name: string;
  slug: string;
  idpTemplate: string | null;
  entityId: string;
  ssoUrl: string;
  sloUrl: string | null;
  idpCertSet: boolean;
  spEntityId: string;
  attributeMap: Record<string, string>;
  defaultRoleId: string | null;
  groupsToRoles: Record<string, { tenantId: string; roleId: string }> | null;
  signatureAlgorithm: string;
  wantSignedAssertions: boolean;
  linkByVerifiedEmail: boolean;
  nameIdFormat: string;
  /** JIT email-domain allow-list; null/empty = any IdP-authenticated email. */
  domainMatch: string[] | null;
  enabled: boolean;
  createdAt: string | number;
  updatedAt: string | number;
}

/** Platform SAML create input — the shared workspace shape plus the platform-
 *  only JIT `domainMatch` allow-list. */
export type PlatformSamlProviderCreate = Omit<SamlProviderCreate, "groupsToRoles"> & {
  domainMatch?: string[] | null;
  /** Tenant-aware group→role map (platform-only). */
  groupsToRoles?: Record<string, { tenantId: string; roleId: string }> | null;
};

export const platformSamlAdminApi = {
  list: () =>
    api<Envelope<ApiPlatformSamlProvider[]>>(`/api/admin/platform-saml/providers`),
  create: (body: PlatformSamlProviderCreate) =>
    api<Envelope<ApiPlatformSamlProvider>>(`/api/admin/platform-saml/providers`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<PlatformSamlProviderCreate>) =>
    api<Envelope<ApiPlatformSamlProvider>>(`/api/admin/platform-saml/providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/platform-saml/providers/${id}`, { method: "DELETE" }),
  importMetadata: (body: { metadataXml?: string; metadataUrl?: string }) =>
    api<Envelope<{
      entityId: string;
      ssoUrl: string;
      sloUrl: string | null;
      idpCertPem: string;
      spEntityIdSuggested: string;
    }>>(`/api/admin/platform-saml/providers/import-metadata`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

/** Sanitized platform LDAP singleton config (`id` instead of `tenantId`). */
export interface ApiPlatformLdapConfig {
  id: string;
  enabled: boolean;
  url: string;
  bindDn: string;
  baseDn: string;
  userFilter: string;
  groupFilter: string | null;
  attributeMap: { email: string; firstName: string; lastName: string; groups: string };
  defaultRoleId: string | null;
  groupsToRoles: Record<string, { tenantId: string; roleId: string }> | null;
  tlsOptions: { rejectUnauthorized?: boolean } | null;
  secretsSet: { bindPassword: boolean; caPem: boolean };
  domainMatch: string[] | null;
  rateLimitPerMinute: number;
  updatedAt: string | number | null;
}

export const platformLdapAdminApi = {
  load: () => api<Envelope<ApiPlatformLdapConfig>>(`/api/admin/platform-ldap-config`),
  save: (body: LdapConfigPatch) =>
    api<{ ok: true }>(`/api/admin/platform-ldap-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  test: (username: string, password: string) =>
    api<
      | { ok: true; dn: string; attributes: { email: string | null; firstName: string | null; lastName: string | null; groups: string[] } }
      | { ok: false; reason: string }
    >(`/api/admin/platform-ldap-config/test`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
};

export const settingsApi = {
  load: () => api<Envelope<Record<string, unknown>>>(`/api/admin/settings`),
  patch: (body: Record<string, unknown>) =>
    api<{ ok: true }>(`/api/admin/settings`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  runtime: () => api<Envelope<ApiRuntime>>(`/api/admin/settings/runtime`),
};

export const dbAdminApi = {
  runSql: (sql: string, opts?: { writes?: boolean }) =>
    api<{ data: { rows: Record<string, unknown>[]; ms: number }[]; ms: number; count: number }>(
      `/api/admin/db/sql/run${opts?.writes ? "?writes=1" : ""}`,
      {
        method: "POST",
        headers: opts?.writes ? { "x-backlex-confirm": "yes" } : undefined,
        body: JSON.stringify({ sql }),
      },
    ),
  tables: () => api<Envelope<{ name: string; rows: number }[]>>(`/api/admin/db/tables`),
  migrations: () =>
    api<Envelope<{ id: string | number; hash: string; created_at: string | number; tag: string | null; applied: boolean }[]>>(`/api/admin/db/migrations`),
  backups: () => api<Envelope<ApiBackup[]>>(`/api/admin/db/backups`),
  backupNow: (label?: string) =>
    api<Envelope<{ id: string; storageKey: string; status: string }>>(`/api/admin/db/backups/now`, {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  restoreBackup: (id: string) =>
    api<Envelope<{ tableCount: number; rowCount: number; skipped: number }>>(
      `/api/admin/db/backups/${id}/restore`,
      { method: "POST", headers: { "x-backlex-confirm": "yes" } },
    ),
  backupConfig: () => api<Envelope<BackupConfig>>(`/api/admin/db/backups/config`),
  saveBackupConfig: (cfg: Partial<BackupConfig>) =>
    api<Envelope<BackupConfig>>(`/api/admin/db/backups/config`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    }),
};

export interface BackupConfig {
  schedule: "off" | "daily" | "weekly";
  retain: number;
  /** Prune autos older than this many days; null = count-only retention. */
  retainDays: number | null;
}

export interface ActivityListParams {
  limit?: number;
  offset?: number;
  /** Action namespace prefix — `item` matches `item.create`, `item.update`, … */
  action?: string;
  /** Inclusive lower bound on `createdAt`, epoch milliseconds. */
  from?: number;
  /** Inclusive upper bound on `createdAt`, epoch milliseconds. */
  to?: number;
  collection?: string;
  itemId?: string;
  /** `"count"` → response carries `meta.count` (total matching the filters). */
  meta?: "count";
}

export const activityApi = {
  list: (opts?: ActivityListParams) => {
    const qs = new URLSearchParams();
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    if (opts?.offset != null) qs.set("offset", String(opts.offset));
    if (opts?.action) qs.set("action", opts.action);
    if (opts?.from != null) qs.set("from", String(opts.from));
    if (opts?.to != null) qs.set("to", String(opts.to));
    if (opts?.collection) qs.set("collection", opts.collection);
    if (opts?.itemId) qs.set("itemId", opts.itemId);
    if (opts?.meta) qs.set("meta", opts.meta);
    const tail = qs.toString();
    return api<
      Envelope<ApiActivity[]> & {
        limit: number;
        offset: number;
        meta?: { count: number };
      }
    >(`/api/activity${tail ? `?${tail}` : ""}`);
  },
};

export interface ApiMetrics {
  range: string;
  windowMs: number;
  bucketMs: number;
  series: { ts: number; requests: number; errors: number }[];
  totals: { requests: number; errors: number; errorRate: number; activeUsers: number; p95Ms?: number };
  counts: {
    collections: number;
    files: number;
    flows: number;
    functions: number;
    activeFlows: number;
    pausedFlows: number;
  };
  topCollections?: { slug: string; rows: number; bytes?: number; lastWrite: number | null; writes24h?: number }[];
  recent?: { t: number; action: string; collection?: string; itemId?: string | null; userId?: string | null; ms?: number | null; error?: boolean }[];
  recentErrors?: { code: string; resource: string; msg: string; count: number; last: number }[];
}

export interface ApiEntityMetrics {
  flows: Record<string, { runs: number; lastRun: number | null }>;
  functions: Record<string, { invocations: number; p95Ms: number; lastInvoke: number | null }>;
  webhooks: Record<string, { deliveries: number; lastDelivery: number | null }>;
}

export const metricsApi = {
  overview: (range = "1h") => api<Envelope<ApiMetrics>>(`/api/admin/metrics/overview?range=${range}`),
  entities: () => api<Envelope<ApiEntityMetrics>>(`/api/admin/metrics/entities`),
};

/** Minimal "who am I" identity surface (`GET /api/me`). */
export interface ApiMe {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  roles: string[];
  isAdmin: boolean;
  tenantId: string | null;
}

export const meApi = {
  get: () => api<Envelope<ApiMe>>(`/api/me`),
};

/** Resolved locale + time-zone preferences for the signed-in admin
 *  (`GET /api/account/preferences`). `user.*` is the raw, possibly-unset
 *  choice; `effective.*` is what the UI should actually use. */
export interface ApiAccountPreferences {
  user: { locale: string | null; timezone: string | null };
  workspace: { defaultLocale: string; locales: string[]; timezone: string };
  effective: { locale: string; timezone: string };
}

export const accountApi = {
  getPreferences: () =>
    api<Envelope<ApiAccountPreferences>>(`/api/account/preferences`),
  /** Pass `null` to clear a field back to the workspace default; omit it to
   *  leave the stored value unchanged. */
  patchPreferences: (body: {
    locale?: string | null;
    timezone?: string | null;
  }) =>
    api<{ ok: true }>(`/api/account/preferences`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** Per-user list-view columns (slug → ordered field names). PATCH replaces
   *  the full map; drop a slug to fall back to the workspace default. */
  getListColumns: () =>
    api<Envelope<Record<string, string[]>>>(`/api/account/list-columns`),
  patchListColumns: (listColumns: Record<string, string[]>) =>
    api<{ ok: true }>(`/api/account/list-columns`, {
      method: "PATCH",
      body: JSON.stringify({ listColumns }),
    }),
};

/** In-app notification row (`/api/notifications`). The real schema has no
 *  `kind`/`icon`/`who` columns — the bell derives an icon from `flowId`. */
export interface ApiNotification {
  id: string;
  userId: string | null;
  title: string;
  body: string | null;
  url: string | null;
  flowId: string | null;
  /** Unix-ms / ISO / null. `null` = unread. */
  readAt: unknown | null;
  createdAt: unknown;
}

export const notificationsApi = {
  list: (opts?: { unread?: boolean; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.unread) qs.set("unread", "1");
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    const tail = qs.toString();
    return api<Envelope<ApiNotification[]>>(
      `/api/notifications${tail ? `?${tail}` : ""}`,
    );
  },
  unreadCount: () =>
    api<Envelope<{ count: number }>>(`/api/notifications/_unread-count`),
  markRead: (id: string) =>
    api<{ ok: true }>(`/api/notifications/${id}/read`, { method: "POST" }),
  markAllRead: () =>
    api<{ ok: true }>(`/api/notifications/_read-all`, { method: "POST" }),
};

/** Per-item discussion comment (`/api/comments`). */
export interface ApiComment {
  id: string;
  collection: string;
  itemId: string;
  userId: string | null;
  body: string;
  createdAt: unknown;
}

export const commentsApi = {
  list: (collection: string, itemId: string) =>
    api<Envelope<ApiComment[]>>(
      `/api/comments?collection=${encodeURIComponent(collection)}&itemId=${encodeURIComponent(itemId)}`,
    ),
  create: (input: { collection: string; itemId: string; body: string }) =>
    api<Envelope<ApiComment>>(`/api/comments`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/comments/${id}`, { method: "DELETE" }),
};

/** One recorded snapshot of an item (`/api/revisions/:collection/:itemId`).
 *  `snapshot` is the full field map captured at write time; newest-first. */
export interface ApiRevision {
  id: string;
  collection: string;
  itemId: string;
  tenantId: string | null;
  userId: string | null;
  snapshot: Record<string, unknown>;
  createdAt: unknown;
}

export const revisionsApi = {
  list: (collection: string, itemId: string) =>
    api<Envelope<ApiRevision[]>>(
      `/api/revisions/${encodeURIComponent(collection)}/${encodeURIComponent(itemId)}`,
    ),
  /** Revert the live row to a recorded revision (by revision id, not item id). */
  revert: (revisionId: string) =>
    api<{ ok: true }>(`/api/revisions/${encodeURIComponent(revisionId)}/revert`, {
      method: "POST",
    }),
};

/** A public read-only share link for a record (`/api/shared-links`).
 *  The plaintext `token` is only present on the create response. */
export interface ApiSharedLink {
  id: string;
  createdAt: unknown;
  revokedAt: unknown;
}

export interface ApiCreatedSharedLink {
  id: string;
  /** One-time plaintext token — only returned here, never on list. */
  token: string;
  /** Relative `/s/<token>` path. */
  url: string;
}

export const sharedLinksApi = {
  list: (collection: string, itemId: string) =>
    api<Envelope<ApiSharedLink[]>>(
      `/api/shared-links?collection=${encodeURIComponent(collection)}&itemId=${encodeURIComponent(itemId)}`,
    ),
  create: (input: { collection: string; itemId: string }) =>
    api<Envelope<ApiCreatedSharedLink>>(`/api/shared-links`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revoke: (id: string) =>
    api<{ ok: true }>(`/api/shared-links/${id}`, { method: "DELETE" }),
};

/** The public, unauthenticated record-share payload (`GET /api/shared/:token`). */
export interface ApiSharedRecord {
  collection: string;
  item: Record<string, unknown>;
  fields: { name: string; type: string }[];
}

export const sharedPublicApi = {
  get: (token: string) =>
    api<Envelope<ApiSharedRecord>>(`/api/shared/${encodeURIComponent(token)}`),
};

/* ── Public form builder ──────────────────────────────────────────── */

export interface ApiFormBlockI18n {
  label?: string;
  placeholder?: string;
  help?: string;
}

/** One statement of a matrix, answered into its own collection field. */
export interface ApiFormBlockMatrixRow {
  name: string;
  label?: string;
  i18n?: Record<string, ApiFormBlockI18n>;
}

/** One form block: a collection field, a "step" page break, or a "matrix"
 *  grid of rows sharing one set of columns. */
export interface ApiFormBlock {
  id?: string;
  kind?: "field" | "step" | "matrix";
  name?: string;
  label?: string;
  placeholder?: string;
  help?: string;
  /** @deprecated Superseded by `scale` — still accepted and still renders. */
  rating?: boolean;
  /** Integer fields only: answer by picking a point on a row. On a matrix, the
   *  shared scale every row is answered on. */
  scale?: ApiFormBlockScale;
  /** Matrix blocks: the statements the grid asks, top to bottom. Their fields
   *  are all integer (answered on `scale`) or all offer the same choices. */
  rows?: ApiFormBlockMatrixRow[];
  consent?: boolean;
  policyUrl?: string;
  /** File blocks: MIME allow-list + per-upload byte cap. */
  accept?: string[];
  maxBytes?: number;
  cond?: { field: string; op: "is" | "is_not"; value: string };
  i18n?: Record<string, ApiFormBlockI18n>;
}

/** A question answered by picking one point on a row — stars, a numbered row,
 *  or the 0–10 NPS row. Integer fields only; at most 11 points wide. */
export interface ApiFormBlockScale {
  min: number;
  max: number;
  style: "stars" | "number" | "nps";
  minLabel?: string;
  maxLabel?: string;
}

export interface ApiFormI18n {
  title?: string;
  description?: string;
  submitLabel?: string;
  successMessage?: string;
}

export interface ApiFormSettings {
  description?: string;
  submitLabel?: string;
  successMessage?: string;
  redirectUrl?: string;
  turnstile?: boolean;
  theme?: "dark" | "light";
  accent?: string;
  font?: "sans" | "lexend" | "mono" | "system";
  languages?: string[];
  i18n?: Record<string, ApiFormI18n>;
  /** Epoch ms. Outside [opensAt, closesAt) the public page shows
   *  `closedMessage` instead of the questions. */
  opensAt?: number;
  closesAt?: number;
  maxResponses?: number;
  /** One answer per browser (a cookie, not an identity). */
  onePerBrowser?: boolean;
  /** Only a visitor holding an unspent invite may answer. */
  inviteOnly?: boolean;
  /** Keep half-filled answers so a visitor can come back to them. */
  saveProgress?: boolean;
  closedMessage?: string;
}

export interface ApiForm {
  id: string;
  tenantId: string | null;
  name: string;
  collection: string;
  fields: ApiFormBlock[];
  settings: ApiFormSettings | null;
  active: boolean;
  submissionCount: number;
  blockedCount: number;
  lastSubmissionAt: unknown;
  createdBy: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface ApiFormInput {
  name: string;
  collection: string;
  fields: ApiFormBlock[];
  settings?: ApiFormSettings | null;
  active?: boolean;
}

/** One-time token payload — returned only by create / rotate-token. */
export interface ApiCreatedForm {
  form: ApiForm;
  token: string;
  url: string;
  embedUrl: string;
}

export interface ApiFormEligibleField {
  name: string;
  type: string;
  label: string | null;
  required: boolean;
  choices: string[] | null;
  format: string | null;
}

/** One question's answers, summarised (`GET /api/admin/forms/:id/results`). */
export interface ApiFormResultBlock {
  name: string;
  label: string;
  type: string;
  kind:
    | "choice"
    | "multi_choice"
    | "scale"
    | "boolean"
    | "number"
    | "text"
    | "timestamp"
    | "file";
  /** Rows whose answer is not null. For `multi_choice` the bucket counts are
   *  choices, not people, so they can sum to more than this. */
  answered: number;
  buckets: { value: string; label: string; count: number }[] | null;
  average: number | null;
  nps: { promoters: number; passives: number; detractors: number; score: number } | null;
  /** Set when the question is one row of a matrix — blocks sharing an `id`
   *  were asked under one heading and are shown under it again. */
  matrix: { id: string; label: string } | null;
}

export interface ApiFormResults {
  formId: string;
  collection: string;
  /** Rows in the target collection — not only ones this form wrote. */
  rows: number;
  submissionCount: number;
  blockedCount: number;
  /** Half-filled forms saved but not submitted (0 unless `saveProgress`). */
  inProgress: number;
  lastSubmissionAt: unknown;
  blocks: ApiFormResultBlock[];
  truncated: number;
}

/** One invitation to answer a form. Read responses never carry the token. */
export interface ApiFormInvite {
  id: string;
  formId: string;
  email: string | null;
  name: string | null;
  sentAt: unknown;
  usedAt: unknown;
  /** When a reminder last went out to this person, and how many have. */
  remindedAt: unknown;
  reminderCount: number;
  createdAt: unknown;
}

/** A freshly minted invite — `token`/`url` appear only in the mint response. */
export interface ApiMintedFormInvite extends ApiFormInvite {
  token: string;
  url: string;
}

export const formsApi = {
  list: () => api<Envelope<ApiForm[]>>(`/api/admin/forms`),
  results: (id: string) => api<Envelope<ApiFormResults>>(`/api/admin/forms/${id}/results`),
  invites: (id: string) => api<Envelope<ApiFormInvite[]>>(`/api/admin/forms/${id}/invites`),
  invite: (
    id: string,
    input: {
      recipients: { email?: string; name?: string }[];
      formToken?: string;
      send?: boolean;
    },
  ) =>
    api<Envelope<{ invites: ApiMintedFormInvite[]; sent: number }>>(
      `/api/admin/forms/${id}/invites`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  /** Mint a fresh link for whoever hasn't answered (earlier links keep
   *  working — every link into an invite opens the same turn). */
  remindInvites: (
    id: string,
    input: {
      inviteIds?: string[];
      formToken?: string;
      send?: boolean;
      minIntervalHours?: number;
      force?: boolean;
    } = {},
  ) =>
    api<Envelope<{ invites: ApiMintedFormInvite[]; sent: number; skipped: number }>>(
      `/api/admin/forms/${id}/invites/remind`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  revokeInvite: (id: string, inviteId: string) =>
    api<{ ok: true }>(`/api/admin/forms/${id}/invites/${inviteId}`, { method: "DELETE" }),
  eligibleFields: (collection: string) =>
    api<Envelope<ApiFormEligibleField[]>>(
      `/api/admin/forms/eligible-fields/${encodeURIComponent(collection)}`,
    ),
  create: (input: ApiFormInput) =>
    api<Envelope<ApiCreatedForm>>(`/api/admin/forms`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (id: string, patch: Partial<ApiFormInput>) =>
    api<Envelope<ApiForm>>(`/api/admin/forms/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  rotateToken: (id: string) =>
    api<Envelope<{ token: string; url: string; embedUrl: string }>>(
      `/api/admin/forms/${id}/rotate-token`,
      { method: "POST" },
    ),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/forms/${id}`, { method: "DELETE" }),
};

/** Public form definition (`GET /api/public/forms/:token`). */
export interface ApiPublicFormBlock {
  kind: string;
  name?: string;
  type?: string;
  label: string;
  placeholder: string | null;
  help: string | null;
  required: boolean;
  /** @deprecated True only for the legacy 1–5 star row; read `scale`. */
  rating: boolean;
  scale: ApiFormBlockScale | null;
  consent: boolean;
  policyUrl: string | null;
  choices: { value: string; label?: string }[] | null;
  /** File blocks: accepted MIME patterns (null ⇒ any) + effective byte cap. */
  accept: string[] | null;
  maxBytes: number | null;
  validation: Record<string, unknown> | null;
  cond: { field: string; op: string; value: string } | null;
  /** Non-null ⇒ one row of a matrix. Consecutive blocks sharing an `id` are
   *  drawn as one grid; each is still an ordinary field block, so a bundle
   *  that predates matrices renders them as plain rows instead. */
  matrix?: { id: string; label: string; help: string | null } | null;
}

export interface ApiPublicForm {
  name: string;
  description: string | null;
  collection: string;
  blocks: ApiPublicFormBlock[];
  submitLabel: string | null;
  successMessage: string | null;
  redirectUrl: string | null;
  theme: "dark" | "light";
  accent: string | null;
  font: "sans" | "lexend" | "mono" | "system";
  languages: string[];
  locale: string;
  turnstileSiteKey: string | null;
  /** Non-null ⇒ the form is not taking answers right now. */
  closed: {
    reason: "scheduled" | "ended" | "full" | "answered" | "invite" | "invite_used";
    message: string;
  } | null;
  /** True ⇒ post what is filled in as it is filled in, and expect `draft`. */
  saveProgress: boolean;
  /** What this visitor left behind last time, or null for a fresh start. */
  draft: { data: Record<string, unknown>; step: number; savedAt: number } | null;
}

export interface ApiPublicFormUpload {
  /** Signed one-time ticket the submit payload carries as the field value. */
  ticket: string;
  name: string;
  size: number;
  contentType: string | null;
}

export const formsPublicApi = {
  get: (token: string, lang?: string, invite?: string) => {
    const qs = new URLSearchParams();
    if (lang) qs.set("lang", lang);
    // The invite rides on the definition read too, so an already-spent link
    // says so before anyone answers six questions they can't submit.
    if (invite) qs.set("i", invite);
    const q = qs.toString();
    return api<Envelope<ApiPublicForm>>(
      `/api/public/forms/${encodeURIComponent(token)}${q ? `?${q}` : ""}`,
    );
  },
  upload: (token: string, field: string, file: File) => {
    const fd = new FormData();
    fd.append("field", field);
    fd.append("file", file);
    return api<Envelope<ApiPublicFormUpload>>(
      `/api/public/forms/${encodeURIComponent(token)}/upload`,
      { method: "POST", body: fd },
    );
  },
  /** Save what has been filled in so far. Only forms with `saveProgress` take
   *  this; the resume key is the invite token or a cookie the server mints. */
  saveDraft: (
    token: string,
    body: { data: Record<string, unknown>; step?: number; invite?: string },
  ) =>
    api<Envelope<{ savedAt: number }>>(
      `/api/public/forms/${encodeURIComponent(token)}/draft`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  /** Throw the saved answers away — the "start over" button. */
  clearDraft: (token: string, invite?: string) =>
    api<Envelope<{ cleared: boolean }>>(
      `/api/public/forms/${encodeURIComponent(token)}/draft${invite ? `?i=${encodeURIComponent(invite)}` : ""}`,
      { method: "DELETE" },
    ),
  submit: (
    token: string,
    body: {
      data: Record<string, unknown>;
      turnstileToken?: string;
      website?: string;
      /** Single-use invite token, carried over from `?i=` on the page URL. */
      invite?: string;
    },
    lang?: string,
  ) =>
    api<Envelope<{ id: string | null; successMessage: string | null; redirectUrl: string | null }>>(
      `/api/public/forms/${encodeURIComponent(token)}/submit${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
};

/** Advisor finding (`GET /api/admin/advisor`). */
export interface ApiAdvisorCheck {
  id: string;
  kind: "security" | "performance";
  level: "error" | "warn" | "info";
  /** Stable rule-family identifier — findings sharing it are grouped. */
  rule: string;
  /** Category label shown when several findings share the same `rule`. */
  groupTitle: string;
  title: string;
  body: string;
  fix: string;
  resource: string;
  /** Optional admin SPA route path to the relevant surface. */
  link?: string;
  /** Present when the advisor can apply the fix itself. */
  action?: ApiAdvisorAction;
  /** Observed numbers behind a traffic-derived finding. Its presence is what
   *  marks a finding as measured rather than inferred from the schema. */
  evidence?: {
    /** Requests observed in the window — spans seen, never extrapolated. */
    requests: number;
    windowDays: number;
    p95?: number;
    errorRate?: number;
    /** Share of the collection's list traffic touching the column, 0..1. */
    share?: number;
  };
}

/** A fix the server can carry out itself (`POST /api/admin/advisor/apply`). */
export interface ApiAdvisorAction {
  type: "create-index";
  table: string;
  indexName: string;
  columns: string[];
  /** Informational — the server re-derives it and never accepts one back. */
  sql: string;
}

/** Advisor run result (`GET /api/admin/advisor`). */
export interface ApiAdvisorResult {
  data: ApiAdvisorCheck[];
  /** 0–100 server-computed health score. */
  score: number;
  /** ISO timestamp — one honest value per run. */
  generatedAt: string;
  /** What the traffic-derived rules had to work with. `spanCount: 0` means no
   *  runtime rule could fire — not the same as "no problems found". */
  runtime: {
    windowDays: number;
    spanCount: number;
    sampleRate: number;
    truncated: boolean;
  };
}

/** One endpoint's latency + error profile (`GET /api/admin/advisor/insights`). */
export interface ApiAdvisorEndpointStat {
  /** `GET /api/items/posts/:id`. */
  route: string;
  method: string;
  path: string;
  requests: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  avgMs: number;
  serverErrors: number;
  clientErrors: number;
  errorRate: number;
}

export interface ApiAdvisorColumnUse {
  column: string;
  requests: number;
  /** Share of the collection's list requests touching this column, 0..1. */
  share: number;
}

export interface ApiAdvisorCollectionStat {
  collection: string;
  listRequests: number;
  p50: number;
  p95: number;
  filters: ApiAdvisorColumnUse[];
  sorts: ApiAdvisorColumnUse[];
}

export interface ApiAdvisorInsights {
  /** Slowest first (p95 desc, ties broken by traffic). */
  endpoints: ApiAdvisorEndpointStat[];
  /** Busiest first. */
  collections: ApiAdvisorCollectionStat[];
  window: {
    from: number;
    to: number;
    days: number;
    spanCount: number;
    /** Start of the oldest span seen. Well after `from` means span retention,
     *  not traffic, bounded the window. */
    oldestSpanAt: number | null;
    /** `TRACES_SAMPLE_RATE`. Below 1, the numbers describe a sample. */
    sampleRate: number;
    truncated: boolean;
  };
}

export const advisorApi = {
  list: (days?: number) =>
    api<ApiAdvisorResult>(
      `/api/admin/advisor${days ? `?days=${days}` : ""}`,
    ),
  insights: (days?: number) =>
    api<ApiAdvisorInsights>(
      `/api/admin/advisor/insights${days ? `?days=${days}` : ""}`,
    ),
  /** Apply a finding's fix. Only the id goes over the wire — the server
   *  re-runs the advisor and executes the statement it derives itself. */
  apply: (id: string, days?: number) =>
    api<{ ok: true; applied: ApiAdvisorAction }>(`/api/admin/advisor/apply`, {
      method: "POST",
      body: JSON.stringify(days ? { id, days } : { id }),
    }),
};

export interface ApiTraceSummary {
  traceId: string;
  name: string;
  rootStatus: number | null;
  spanCount: number;
  durationMs: number;
  startedAt: number;
  hasError: boolean;
}

export interface ApiSpan {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  method: string | null;
  path: string | null;
  status: number | null;
  userId: string | null;
  durationMs: number | null;
  attributes: Record<string, unknown> | null;
  startedAt: number;
}

export interface TracesListParams {
  path?: string;
  minStatus?: number;
  limit?: number;
  from?: number;
}

export const tracesApi = {
  list: (opts?: TracesListParams) => {
    const qs = new URLSearchParams();
    if (opts?.path) qs.set("path", opts.path);
    if (opts?.minStatus != null) qs.set("minStatus", String(opts.minStatus));
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    if (opts?.from != null) qs.set("from", String(opts.from));
    const tail = qs.toString();
    return api<Envelope<ApiTraceSummary[]>>(
      `/api/admin/traces${tail ? `?${tail}` : ""}`,
    );
  },
  get: (traceId: string) =>
    api<{ traceId: string; spans: ApiSpan[] }>(
      `/api/admin/traces/${encodeURIComponent(traceId)}`,
    ),
};

// ── Usage metering (#12) ─────────────────────────────────────────────────────

export interface ApiUsageLimits {
  mode: "off" | "soft" | "hard";
  maxRequestsPerMonth: number | null;
  maxStorageBytes: number | null;
  maxDbRows: number | null;
}

export interface ApiUsageOverview {
  month: string;
  days: number;
  series: { day: string; requests: number; errors: number }[];
  /** Per-key day points (only days with traffic). `apiKeyId: ""` = sessions. */
  keySeries: { day: string; apiKeyId: string; requests: number; errors: number }[];
  monthTotals: { requests: number; errors: number };
  byKey: {
    /** Empty id = the session / no-API-key traffic bucket. */
    id: string;
    name: string;
    prefix: string | null;
    revoked: boolean;
    rateLimitPerMinute: number | null;
    monthlyQuota: number | null;
    monthRequests: number;
    monthErrors: number;
  }[];
  gauges: {
    storageBytes: number | null;
    dbRows: number | null;
    measuredAt: number | null;
  };
  limits: ApiUsageLimits;
  settingsLimits: ApiUsageLimits;
  envPinned: ("mode" | "maxRequestsPerMonth" | "maxStorageBytes" | "maxDbRows")[];
  over: ("requests" | "storage" | "rows")[];
}

export const usageApi = {
  overview: (days?: number) =>
    api<Envelope<ApiUsageOverview>>(
      `/api/admin/usage/overview${days ? `?days=${days}` : ""}`,
    ),
  setLimits: (limits: ApiUsageLimits) =>
    api<{ ok: boolean }>(`/api/admin/usage/limits`, {
      method: "PUT",
      body: JSON.stringify(limits),
    }),
  setKeyLimits: (
    id: string,
    patch: { rateLimitPerMinute?: number | null; monthlyQuota?: number | null },
  ) =>
    api<{ ok: boolean }>(`/api/api-keys/${encodeURIComponent(id)}/limits`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
};

// ── External-DB migration (docs/migrating-in.md) ─────────────────────────────

export interface ApiMigrateSource {
  id: string;
  name: string;
  kind: string;
  /** Redacted — scheme + host + database, credentials never leave the server. */
  urlMasked: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ApiMigratePlanField {
  column: string;
  name: string;
  type: string;
  required?: boolean;
  to?: string;
  choices?: string[];
}

export interface ApiMigratePlanTable {
  table: string;
  slug: string;
  include: boolean;
  reason?: string;
  pkColumn: string;
  pkType: "uuid" | "text" | "integer";
  createdAtColumn: string | null;
  updatedAtColumn: string | null;
  fields: ApiMigratePlanField[];
  warnings: string[];
  approxRows: number | null;
}

export interface ApiMigratePlan {
  version: 1;
  source: { kind: string };
  order: string[];
  tables: ApiMigratePlanTable[];
}

export type ApiMigrateRunStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface ApiMigrateRunTable {
  table: string;
  copied: number;
  failed: number;
  done: boolean;
  sourceCount?: number;
  targetTotal?: number;
}

export interface ApiMigrateRun {
  id: string;
  sourceId: string;
  status: ApiMigrateRunStatus;
  error: string | null;
  plan: ApiMigratePlan;
  state: { tables: Record<string, ApiMigrateRunTable> };
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const migrateApi = {
  sources: () => api<Envelope<ApiMigrateSource[]>>(`/api/admin/migrate/sources`),
  createSource: (name: string, url: string) =>
    api<Envelope<ApiMigrateSource>>(`/api/admin/migrate/sources`, {
      method: "POST",
      body: JSON.stringify({ name, url }),
    }),
  deleteSource: (id: string) =>
    api<{ ok: true }>(`/api/admin/migrate/sources/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  testSource: (id: string) =>
    api<Envelope<{ ok: boolean; tables?: number; error?: string }>>(
      `/api/admin/migrate/sources/${encodeURIComponent(id)}/test`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  sourceTables: (id: string) =>
    api<Envelope<{ name: string; approxRows: number | null }[]>>(
      `/api/admin/migrate/sources/${encodeURIComponent(id)}/tables`,
    ),
  plan: (id: string, tables?: string[]) =>
    api<Envelope<ApiMigratePlan>>(
      `/api/admin/migrate/sources/${encodeURIComponent(id)}/plan`,
      { method: "POST", body: JSON.stringify({ tables }) },
    ),
  runs: () => api<Envelope<ApiMigrateRun[]>>(`/api/admin/migrate/runs`),
  run: (id: string) =>
    api<Envelope<ApiMigrateRun>>(`/api/admin/migrate/runs/${encodeURIComponent(id)}`),
  startRun: (sourceId: string, plan: ApiMigratePlan) =>
    api<Envelope<ApiMigrateRun>>(`/api/admin/migrate/runs`, {
      method: "POST",
      body: JSON.stringify({ sourceId, plan }),
    }),
  cancelRun: (id: string) =>
    api<Envelope<ApiMigrateRun>>(`/api/admin/migrate/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  resumeRun: (id: string) =>
    api<Envelope<ApiMigrateRun>>(`/api/admin/migrate/runs/${encodeURIComponent(id)}/resume`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
};

// ── Product analytics + crash reporting (#22) ────────────────────────────────

export interface ApiAnalyticsOverview {
  totals: { events: number; users: number; sessions: number };
  series: { day: string; events: number; users: number }[];
  topEvents: { name: string; count: number; users: number }[];
  topPaths: { path: string; count: number }[];
  topReferrers: { referrer: string; count: number }[];
  sources: { source: string; count: number }[];
}

export interface ApiAnalyticsFunnel {
  windowDays: number;
  steps: { name: string; count: number; conversion: number; dropOff: number }[];
}

export interface ApiAnalyticsRetention {
  maxOffset: number;
  cohorts: { day: string; size: number; values: number[] }[];
}

export interface ApiAnalyticsEvent {
  id: string;
  name: string;
  distinctId: string;
  userId: string | null;
  sessionId: string | null;
  props: Record<string, unknown> | null;
  path: string | null;
  referrer: string | null;
  source: string | null;
  release: string | null;
  country: string | null;
  ts: number;
}

export type ApiErrorStatus = "open" | "resolved" | "ignored";

export interface ApiErrorGroup {
  id: string;
  fingerprint: string;
  type: string;
  message: string;
  culprit: string | null;
  level: string;
  platform: string | null;
  release: string | null;
  status: ApiErrorStatus;
  events: number;
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

export interface ApiErrorOccurrence {
  id: string;
  message: string;
  stack: string | null;
  level: string;
  platform: string | null;
  release: string | null;
  url: string | null;
  userId: string | null;
  distinctId: string | null;
  sessionId: string | null;
  context: Record<string, unknown> | null;
  ts: number;
}

export interface ApiErrorGroupDetail {
  group: ApiErrorGroup;
  occurrences: ApiErrorOccurrence[];
  series: { day: string; count: number }[];
  users: number;
}

/** Build a query string, dropping empty values. */
const analyticsQs = (params: Record<string, string | number | undefined>): string => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const tail = qs.toString();
  return tail ? `?${tail}` : "";
};

export const analyticsApi = {
  overview: (from: number, to: number) =>
    api<Envelope<ApiAnalyticsOverview>>(
      `/api/admin/analytics/overview${analyticsQs({ from, to })}`,
    ),
  eventNames: () => api<Envelope<string[]>>("/api/admin/analytics/event-names"),
  funnel: (body: { steps: string[]; windowDays?: number; from: number; to: number }) =>
    api<Envelope<ApiAnalyticsFunnel>>("/api/admin/analytics/funnel", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  retention: (body: { event?: string | null; from: number; to: number }) =>
    api<Envelope<ApiAnalyticsRetention>>("/api/admin/analytics/retention", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  events: (opts: {
    from?: number;
    to?: number;
    name?: string;
    distinctId?: string;
    limit?: number;
  }) => api<Envelope<ApiAnalyticsEvent[]>>(`/api/admin/analytics/events${analyticsQs(opts)}`),
  errors: (opts: { status?: string; level?: string; since?: number; limit?: number }) =>
    api<Envelope<ApiErrorGroup[]>>(`/api/admin/analytics/errors${analyticsQs(opts)}`),
  error: (id: string) =>
    api<Envelope<ApiErrorGroupDetail>>(
      `/api/admin/analytics/errors/${encodeURIComponent(id)}`,
    ),
  updateError: (id: string, status: ApiErrorStatus) =>
    api<Envelope<ApiErrorGroup>>(`/api/admin/analytics/errors/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  deleteError: (id: string) =>
    api<{ ok: boolean }>(`/api/admin/analytics/errors/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  ingestKeyStatus: () =>
    api<Envelope<{ exists: boolean }>>("/api/admin/analytics/ingest-key"),
  mintIngestKey: () =>
    api<Envelope<{ key: string }>>("/api/admin/analytics/ingest-key", { method: "POST" }),
  revokeIngestKey: () =>
    api<{ ok: boolean }>("/api/admin/analytics/ingest-key", { method: "DELETE" }),
};
