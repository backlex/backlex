import type { VectorStore } from "@backlex/core";
import { api } from "@/lib/api";
import type { Envelope } from "./types";

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
    /** Values live in the translations sidecar, one per locale, rather than in
     *  the column. Read by the validation editor, which cannot offer such a
     *  column as a one-relation-hop target. */
    localized?: boolean;
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
  /** Change a member's workspace role or status. The server owns the ladder —
   *  an `admin` cannot mint an `owner`, nobody may demote the last one — so
   *  callers apply the change optimistically and roll back on rejection. */
  updateMember: (
    tenantId: string,
    memberId: string,
    input: { role?: string; status?: "active" | "suspended" },
  ) =>
    api<{ ok: true; data?: ApiTenantMember }>(
      `/api/tenants/${tenantId}/members/${memberId}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  /** Hand the workspace over. The caller is demoted to `admin` in the same
   *  statement, which is why every callsite must confirm first. */
  transferOwnership: (tenantId: string, memberId: string) =>
    api<{ ok: true }>(`/api/tenants/${tenantId}/transfer-ownership`, {
      method: "POST",
      body: JSON.stringify({ memberId }),
    }),
  /** Mint a fresh invite token for a member who is still `invited`. The link
   *  comes back only here and on the original invite — the members list
   *  deliberately no longer carries one. */
  resendInvite: (tenantId: string, memberId: string) =>
    api<{ ok: true; data?: { url?: string; sent?: boolean } }>(
      `/api/tenants/${tenantId}/members/${memberId}/resend-invite`,
      { method: "POST" },
    ),
  /** Withdraw a pending invitation. Distinct from `removeMember`, which evicts
   *  someone who already accepted. */
  revokeInvite: (tenantId: string, memberId: string) =>
    api<{ ok: true }>(`/api/tenants/${tenantId}/members/${memberId}/invite`, {
      method: "DELETE",
    }),
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
  /** Delete a collection. The confirm header is required only when the table
   *  actually holds rows; the server then saves them to a `pre-drop` backup and
   *  hands back its id. */
  remove: (slug: string, opts?: { confirm?: boolean }) =>
    api<{ ok: true; archived?: boolean; rows?: number; snapshotId?: string | null }>(
      `/api/collections/${slug}`,
      {
        method: "DELETE",
        ...(opts?.confirm ? { headers: { "x-backlex-confirm": "yes" } } : {}),
      },
    ),
  /** What deleting a collection would destroy. Changes nothing. */
  removeImpact: (slug: string) =>
    api<{ ok: false; dryRun: true; slug: string; adopted: boolean; rows: number }>(
      `/api/collections/${slug}?dryRun=1`,
      { method: "DELETE" },
    ),
  /** Drop a single field (column) from a managed collection. The column is gone
   *  for good, but its VALUES are saved to a `pre-drop` backup first (the
   *  returned `snapshotId`) whenever any row holds one. Refused on adopted
   *  collections. The confirm header is required only when data would be lost. */
  dropField: (slug: string, name: string, opts?: { confirm?: boolean }) =>
    api<{
      ok: true;
      slug: string;
      field: string;
      rows: number;
      nonNull: number;
      snapshotId: string | null;
    }>(`/api/collections/${slug}/fields/${encodeURIComponent(name)}`, {
      method: "DELETE",
      ...(opts?.confirm ? { headers: { "x-backlex-confirm": "yes" } } : {}),
    }),
  /** How many rows the column holds a value in. Changes nothing. */
  dropFieldImpact: (slug: string, name: string) =>
    api<{
      ok: false;
      dryRun: true;
      slug: string;
      field: string;
      table: string;
      rows: number;
      nonNull: number;
    }>(`/api/collections/${slug}/fields/${encodeURIComponent(name)}?dryRun=1`, {
      method: "DELETE",
    }),
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
  /** How much of a working application arrives with the collections — counts,
   *  because the preview pane has no room for six more name lists. */
  bundles: {
    kpis: number;
    flows: number;
    documents: number;
    forms: number;
    agents: number;
    flags: number;
    channels: number;
  };
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
  kpis: string[];
  flows: string[];
  documents: string[];
  /** Form NAMES — the one-time token is never returned by any surface. */
  forms: string[];
  agents: string[];
  flags: string[];
  channels: string[];
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
  /**
   * Take a row out of play, or put it back.
   *
   * Not a delete and not a hide — the row stays readable and every existing
   * reference to it keeps resolving. What changes is that it stops being
   * offered for new work.
   */
  retire: (slug: string, id: string, restore = false) =>
    api<{ data: Record<string, unknown>; field: string; retired: boolean }>(
      `/api/items/${slug}/${id}/retire${restore ? "?restore=1" : ""}`,
      { method: "POST", body: "{}" },
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
  /** `async` queues the dump as a durable job: the tracking row is written
   *  before this returns (so the list shows it straight away) and the response
   *  carries a `jobId` to watch instead of a finished row. */
  backupNow: (label?: string, opts?: { async?: boolean }) =>
    api<
      Envelope<{
        id?: string;
        storageKey: string;
        status: string;
        jobId?: string;
        backupId?: string;
      }>
    >(`/api/admin/db/backups/now${opts?.async ? "?async=1" : ""}`, {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  restoreBackup: (
    id: string,
    opts?: { mode?: "additive" | "overwrite"; onlyTables?: string[] },
  ) => {
    const q = new URLSearchParams();
    if (opts?.mode) q.set("mode", opts.mode);
    if (opts?.onlyTables?.length) q.set("onlyTables", opts.onlyTables.join(","));
    const qs = q.toString();
    return api<
      Envelope<{
        tableCount: number;
        rowCount: number;
        skipped: number;
        overwritten: number;
        keptAdditive: string[];
      }>
    >(`/api/admin/db/backups/${id}/restore${qs ? `?${qs}` : ""}`, {
      method: "POST",
      headers: { "x-backlex-confirm": "yes" },
    });
  },
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
