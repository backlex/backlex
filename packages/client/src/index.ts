/**
 * @module
 *
 * The backlex client — a typed `fetch` wrapper over the backlex API. Create one
 * with {@link createClient}, then use `.from(slug)` for typed collection CRUD,
 * `.auth` for sign-in/up, `.subscribe` for realtime (SSE), plus `.storage`,
 * `.jobs`, `.flags`, and offline-first `.sync`.
 *
 * ```ts
 * import { createClient } from "backlex";
 *
 * const backlex = createClient({ url: "https://api.your.app", workspace: "acme" });
 * await backlex.auth.signIn({ email, password });
 * const { data } = await backlex.from("todos").list({ sort: ["-created_at"] });
 * const off = backlex.subscribe("items:todos", (e) => console.log(e.event, e.data));
 * ```
 *
 * ## Layout
 *
 * | File | Holds |
 * |---|---|
 * | `core.ts` | `ClientOptions`, `CollectionClient`, and `ClientCore` — the transport handle |
 * | `clients/<domain>.ts` | one domain each: its shapes AND its `make<Domain>(core)` factory |
 * | `index.ts` | the transport, `createClient`, and the public re-export barrel |
 *
 * A domain module never sees `fetch`, an auth header, or another domain — it is
 * handed a `ClientCore` and returns its client. Adding an endpoint is therefore
 * an edit to exactly one file, which is what this file being 5586 lines used to
 * prevent.
 */
import type { AdvisorClient } from "./clients/advisor";
import type { AgentsClient } from "./clients/agents";
import type { AnalyticsClient } from "./clients/analytics";
import type { AppUsersClient } from "./clients/app-users";
import type { ApprovalsClient } from "./clients/approvals";
import type { AuthClient } from "./clients/auth";
import type { BackupsClient } from "./clients/backups";
import type { BookingClient } from "./clients/booking";
import type { DashboardsClient } from "./clients/dashboards";
import type { DocumentsClient } from "./clients/documents";
import type { ExtensionsClient } from "./clients/extensions";
import type { FlagsClient } from "./clients/flags";
import type { FlowsClient } from "./clients/flows";
import type { FormsClient } from "./clients/forms";
import type { IntegrationsClient } from "./clients/integrations";
import type { JobsClient } from "./clients/jobs";
import type { KpisClient } from "./clients/kpis";
import type { MessagingClient } from "./clients/messaging";
import type { MigrateClient } from "./clients/migrate";
import type { OrgsClient } from "./clients/orgs";
import type { PaymentsClient } from "./clients/payments";
import type { PermissionsClient } from "./clients/permissions";
import type { SchemaClient } from "./clients/schema";
import type { SignaturesClient } from "./clients/signatures";
import type { StorageClient } from "./clients/storage";
import type { SyncHooksClient } from "./clients/sync-hooks";
import type { AuthHooksClient } from "./clients/auth-hooks";
import type { ChannelsClient } from "./clients/channels";
import type { RlsClient } from "./clients/rls";
import type { TemplatesClient } from "./clients/templates";
import type { UsageClient } from "./clients/usage";
import type { EmailNormalizeReport, FieldTransitions, GeoBackfillReport, NormalizeOrderReport, PhoneNormalizeReport, ReorderReport, SequenceSyncReport, SlugBackfillReport, WriteLocaleOpts, WriteUpdateOpts } from "./core";
import {
  type AggregateQuery,
  type AggregateRow,
  type BatchOperation,
  type BatchResponse,
  type BulkUpdateResponse,
  type ItemEvent,
  type ItemQuery,
  type ItemResponse,
  type ListQuery,
  type ListResponse,
  type SearchQuery,
  type SearchResponse,
  type ChangesQuery,
  type ChangesResponse,
  type ImportSummary,
  BacklexError,
} from "./types";

export type {
  ListQuery,
  ListResponse,
  ItemResponse,
  ItemQuery,
  ItemEvent,
  AggregateQuery,
  AggregateRow,
  SearchQuery,
  SearchResponse,
  ChangesQuery,
  ChangesResponse,
  ChangeRow,
  ImportSummary,
  BatchOperation,
  BatchResponse,
  BulkUpdateResponse,
  DeviceToken,
  PhoneNumber,
  Job,
  JobStatus,
  Upload,
  UploadStatus,
  ResumableUploadResult,
  FlagState,
} from "./types";
export { BacklexError } from "./types";
export { normalizeCondition, matchesCondition, shapeKey } from "./condition";
export type { Condition, ComparisonObj, RelativeNow, MatchResult } from "./condition";
export { QueryBuilder } from "./query";
export type { FilterBuilder, FieldKey, SortKey } from "./query";

import { QueryBuilder } from "./query";
import { makeTraceparent } from "./trace";
export { makeTraceparent, newTraceId, newSpanId } from "./trace";
import { createSync, type SyncController, type SyncOptions } from "./sync";
import { createLiveQuery, type LiveQueryOptions } from "./live";
export { matchesRow, isIncrementalSafe } from "./live";
export type { LiveQueryOptions, LiveQueryDeps } from "./live";
import type { Condition } from "./condition";
import {
  createSignalHub,
  createSignalHydrator,
  idBatchFilter,
  signalChannel,
  type ItemsTransportKind,
  type SignalHub,
} from "./signal";
export type { ItemSignal, ItemsTransportKind } from "./signal";
export * from "./core";
export * from "./clients/auth";
export * from "./clients/storage";
export * from "./clients/messaging";
export * from "./clients/jobs";
export * from "./clients/flows";
export * from "./clients/documents";
export * from "./clients/approvals";
export * from "./clients/signatures";
export * from "./clients/booking";
export * from "./clients/integrations";
export * from "./clients/sync-hooks";
export * from "./clients/auth-hooks";
export * from "./clients/channels";
export * from "./clients/rls";
export * from "./clients/payments";
export * from "./clients/kpis";
export * from "./clients/dashboards";
export * from "./clients/analytics";
export * from "./clients/forms";
export * from "./clients/extensions";
export * from "./clients/usage";
export * from "./clients/advisor";
export * from "./clients/backups";
export * from "./clients/agents";
export * from "./clients/permissions";
export * from "./clients/schema";
export * from "./clients/migrate";
export * from "./clients/templates";
export * from "./clients/app-users";
export * from "./clients/orgs";
export * from "./clients/flags";
import { makeAuth } from "./clients/auth";
import { makeStorage } from "./clients/storage";
import { makeMessaging } from "./clients/messaging";
import { makeJobs } from "./clients/jobs";
import { makeFlows } from "./clients/flows";
import { makeDocuments } from "./clients/documents";
import { makeApprovals } from "./clients/approvals";
import { makeSignatures } from "./clients/signatures";
import { makeBooking } from "./clients/booking";
import { makeIntegrations } from "./clients/integrations";
import { makeSyncHooks } from "./clients/sync-hooks";
import { makeAuthHooks } from "./clients/auth-hooks";
import { makeChannels } from "./clients/channels";
import { makeRls } from "./clients/rls";
import { makePayments } from "./clients/payments";
import { makeKpis } from "./clients/kpis";
import { makeDashboards } from "./clients/dashboards";
import { makeAnalytics } from "./clients/analytics";
import { makeForms } from "./clients/forms";
import { makeExtensions } from "./clients/extensions";
import { makeUsage } from "./clients/usage";
import { makeAdvisor } from "./clients/advisor";
import { makeBackups } from "./clients/backups";
import { makeAgents } from "./clients/agents";
import { makePermissions } from "./clients/permissions";
import { makeSchema } from "./clients/schema";
import { makeMigrate } from "./clients/migrate";
import { makeTemplates } from "./clients/templates";
import { makeAppUsers } from "./clients/app-users";
import { makeOrgs } from "./clients/orgs";
import { makeFlags } from "./clients/flags";
import type { ClientOptions, CollectionClient } from "./core";
import type { ClientCore } from "./core";

const buildSearch = (q: ListQuery | undefined): string => {
  if (!q) return "";
  const params = new URLSearchParams();
  if (q.filter) params.set("filter", JSON.stringify(q.filter));
  if (q.sort) {
    params.set("sort", Array.isArray(q.sort) ? q.sort.join(",") : q.sort);
  }
  if (q.fields) {
    params.set("fields", Array.isArray(q.fields) ? q.fields.join(",") : q.fields);
  }
  if (q.expand) {
    params.set("expand", Array.isArray(q.expand) ? q.expand.join(",") : q.expand);
  }
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  if (q.offset !== undefined) params.set("offset", String(q.offset));
  // `!== undefined` (not truthy): an empty cursor is meaningful — it requests
  // keyset mode's first page (server keys on the param's PRESENCE).
  if (q.cursor !== undefined) params.set("cursor", q.cursor);
  if (q.meta) params.set("meta", q.meta);
  if (q.locale) params.set("locale", q.locale);
  if (q.q) params.set("q", q.q);
  if (q.status) params.set("status", q.status);
  const s = params.toString();
  return s ? `?${s}` : "";
};

// Single-item read extras — a strict subset of buildSearch (expand + locale).
const buildItemSearch = (q: ItemQuery | undefined): string => {
  if (!q) return "";
  const params = new URLSearchParams();
  if (q.expand) {
    params.set("expand", Array.isArray(q.expand) ? q.expand.join(",") : q.expand);
  }
  if (q.locale) params.set("locale", q.locale);
  if (q.staged) params.set("staged", "1");
  const s = params.toString();
  return s ? `?${s}` : "";
};

const writeLocaleQuery = (opts: WriteLocaleOpts | undefined): string =>
  opts?.locale ? `?locale=${encodeURIComponent(opts.locale)}` : "";

/** The backlex client returned by `createClient` — data, auth, storage, realtime, and more. */
export interface BacklexClient {
  /** Typed data API for one collection by slug. */
  from<T extends Record<string, unknown>>(slug: string): CollectionClient<T>;
  /** Subscribe to a realtime channel (SSE); returns an unsubscribe function. */
  subscribe<T = Record<string, unknown>>(
    channel: string,
    onEvent: (e: ItemEvent<T>) => void,
    onError?: (err: unknown) => void,
  ): () => void;
  /** Reactive query — subscribe to a collection query (filter/sort/limit) and
   *  get a fresh, consistent result array on every relevant change. Runs the
   *  initial `list()`, then keeps the array up to date over realtime (no manual
   *  event wiring, no stale data). Returns an unsubscribe function. */
  liveQuery<T extends Record<string, unknown> = Record<string, unknown>>(
    slug: string,
    opts: LiveQueryOptions,
    onResult: (rows: T[]) => void,
    onError?: (err: unknown) => void,
  ): () => void;
  /** Auth surface (sign-in/up, sessions, tokens). */
  auth: AuthClient;
  /** File storage + resumable uploads. */
  storage: StorageClient;
  /** Push + SMS device registration. */
  messaging: MessagingClient;
  /** Durable background job queue. */
  jobs: JobsClient;
  /** Visual workflows (flows). */
  flows: FlowsClient;
  /** Document generation — HTML templates rendered to PDF. */
  documents: DocumentsClient;
  /** E-signature — send a rendered document out to be signed. */
  signatures: SignaturesClient;
  /** Approvals — park something on a human decision. */
  approvals: ApprovalsClient;
  /** Availability & booking — publish a calendar, take what is on it. */
  booking: BookingClient;
  /** Connected payment providers (Stripe / Polar / Lemon Squeezy). */
  payments: PaymentsClient;
  /** Connected third-party integrations (Slack, Jira, Algolia, …). */
  integrations: IntegrationsClient;
  /** Blocking hooks that participate in a write. */
  syncHooks: SyncHooksClient;
  /** Hooks into this workspace's END-USER auth: sign-up admission, access-token
   *  claims, password verification and auth-mail delivery. */
  authHooks: AuthHooksClient;
  /** Application-owned realtime channels: the rules that authorize them, plus
   *  publish / presence / retained history. Subscribing is `client.subscribe`. */
  channels: ChannelsClient;
  /** Postgres row-level security compiled from this workspace's permission
   *  rules, so a direct database connection is filtered too. */
  rls: RlsClient;
  extensions: ExtensionsClient;
  /** Named KPIs — the shared definition layer every surface reads a figure from. */
  kpis: KpisClient;
  /** Embedded BI dashboards. */
  dashboards: DashboardsClient;
  /** Product analytics + crash reporting. */
  analytics: AnalyticsClient;
  forms: FormsClient;
  /** Usage metering — per-day/per-key counters + workspace limits. */
  usage: UsageClient;
  /** Advisor — security/performance lint, runtime query insights, and
   *  one-call remediation of the findings that carry an `action`. */
  advisor: AdvisorClient;
  /** Backup / restore + the automatic-backup schedule. */
  backups: BackupsClient;
  /** AI agents (definitions, threads, and running turns). */
  agents: AgentsClient;
  /** Permission tooling (simulator). */
  permissions: PermissionsClient;
  /** Schema templates (catalog + apply). */
  templates: TemplatesClient;
  /** Workspace end-user provisioning (invites — admin plane). */
  appUsers: AppUsersClient;
  /** Organizations ("teams") — the B2B grouping level inside a workspace. */
  orgs: OrgsClient;
  /** Schema versions — migration diffing / schema branching. */
  schema: SchemaClient;
  /** External-DB migration (sources + server-side copy runs). */
  migrate: MigrateClient;
  /** Feature flags / remote config. */
  flags: FlagsClient;
  /** Offline-first sync controller for one collection. */
  sync(options: SyncOptions): SyncController;
  /** Raw escape hatch — issues a request with auth headers applied. */
  request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T>;
}

/** Create a backlex client. In app mode (`workspace` set) auth + data scope to
 *  one workspace and the session token is captured + replayed as a bearer. */

export const createClient = (opts: ClientOptions): BacklexClient => {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  // App-mode workspace session token, captured from sign-in/up and replayed
  // as a bearer on later calls.
  let appToken: string | null = opts.token ?? null;
  const authBase = opts.workspace
    ? `/api/t/${encodeURIComponent(opts.workspace)}/auth`
    : "/api/auth";

  const authHeader = (): Record<string, string> => {
    if (opts.apiKey) return { authorization: `Bearer ${opts.apiKey}` };
    if (appToken) return { authorization: `Bearer ${appToken}` };
    return {};
  };

  // Optional explicit tenant scoping (slug or id) for anonymous / cross-tenant calls.
  const tenantHeader = (): Record<string, string> =>
    opts.tenant ? { "x-backlex-tenant": opts.tenant } : {};

  // Active organization for app-plane requests, set via `orgs.use(...)`. Rides
  // every request so `$org.id` in permission rules resolves without the caller
  // threading it through each call.
  let activeOrg: string | null = opts.org ?? null;
  const orgHeader = (): Record<string, string> =>
    activeOrg ? { "x-backlex-org": activeOrg } : {};

  // W3C traceparent — on by default. `tracing: false` opts out; a function lets
  // the caller continue an existing trace (return a traceparent) or start a
  // fresh one (return undefined).
  const traceHeader = (): Record<string, string> => {
    if (opts.tracing === false) return {};
    if (typeof opts.tracing === "function") {
      const provided = opts.tracing();
      return { traceparent: provided ?? makeTraceparent() };
    }
    return { traceparent: makeTraceparent() };
  };

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> => {
    const headers: Record<string, string> = {
      // Only advertise a JSON body when we actually send one. A bodyless POST
      // (publish, unpublish, restore, fts-reindex, …) that still carried
      // `content-type: application/json` made the server's body validator try to
      // parse an empty body and fail with "Malformed JSON in request body".
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...authHeader(),
      ...tenantHeader(),
      ...orgHeader(),
      ...traceHeader(),
      ...(extraHeaders ?? {}),
    };
    const res = await f(`${opts.url}${path}`, {
      method,
      credentials: "include",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as
        | { error?: { code: string; message: string; details?: unknown } }
        | undefined;
      throw new BacklexError(res.status, errBody);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };

  /** Like {@link request} but for endpoints whose body/response isn't JSON —
   *  the bulk export (returns a file) and import (takes a raw CSV/JSON upload).
   *  Returns the raw `Response` so callers pick `.text()` or `.json()`. */
  const requestRaw = async (
    method: string,
    path: string,
    rawBody?: string,
    contentType?: string,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      ...authHeader(),
      ...tenantHeader(),
      ...orgHeader(),
      ...traceHeader(),
    };
    if (contentType) headers["content-type"] = contentType;
    const res = await f(`${opts.url}${path}`, {
      method,
      credentials: "include",
      headers,
      body: rawBody,
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as
        | { error?: { code: string; message: string; details?: unknown } }
        | undefined;
      throw new BacklexError(res.status, errBody);
    }
    return res;
  };

  const collection = <T extends Record<string, unknown>>(
    slug: string,
  ): CollectionClient<T> => {
    const list = (q?: ListQuery): Promise<ListResponse<T>> =>
      request<ListResponse<T>>("GET", `/api/items/${slug}${buildSearch(q)}`);
    return {
      list,
      /** Fluent, type-safe query builder that compiles to `ListQuery`. */
      query: (): QueryBuilder<T> => new QueryBuilder<T>(list),
      /** Run a single-function aggregate (count/sum/avg/min/max), optionally grouped. */
      aggregate: (body: AggregateQuery): Promise<{ data: AggregateRow[] }> =>
        request<{ data: AggregateRow[] }>("POST", `/api/items/${slug}/aggregate`, body),
      /** Relevance search (full-text / vector / hybrid). */
      search: (body: SearchQuery): Promise<SearchResponse<T>> =>
        request<SearchResponse<T>>("POST", `/api/items/${slug}/search`, body),
      /** One page of the incremental changefeed (offline sync primitive). */
      changes: (q?: ChangesQuery): Promise<ChangesResponse<T>> => {
        const p = new URLSearchParams();
        if (q?.since) p.set("since", q.since);
        if (q?.limit) p.set("limit", String(q.limit));
        if (q?.shape) p.set("shape", JSON.stringify(q.shape));
        if (q?.fields?.length) p.set("fields", q.fields.join(","));
        const qs = p.toString();
        return request<ChangesResponse<T>>("GET", `/api/items/${slug}/changes${qs ? `?${qs}` : ""}`);
      },
      /** Export every readable row as a JSON or CSV string (honors the same
       *  read filters as `list`). */
      exportItems: (format: "json" | "csv" = "json"): Promise<string> =>
        requestRaw("GET", `/api/items/${slug}/export?format=${format}`).then((r) =>
          r.text(),
        ),
      /** Bulk-import rows from a JSON array (or raw JSON/CSV string). Each row
       *  runs the normal create path; row-level failures land in `errors`. */
      importItems: (
        body: string | Partial<T>[],
        format: "json" | "csv" = "json",
      ): Promise<ImportSummary> => {
        const raw = typeof body === "string" ? body : JSON.stringify(body);
        const contentType = format === "csv" ? "text/csv" : "application/json";
        return requestRaw(
          "POST",
          `/api/items/${slug}/import?format=${format}`,
          raw,
          contentType,
        ).then((r) => r.json() as Promise<ImportSummary>);
      },
      one: (id: string, opts?: ItemQuery): Promise<ItemResponse<T>> =>
        request<ItemResponse<T>>("GET", `/api/items/${slug}/${id}${buildItemSearch(opts)}`),
      create: (data: Partial<T>, opts?: WriteLocaleOpts): Promise<ItemResponse<T>> =>
        request<ItemResponse<T>>("POST", `/api/items/${slug}${writeLocaleQuery(opts)}`, data),
      update: (id: string, patch: Partial<T>, opts?: WriteUpdateOpts): Promise<ItemResponse<T>> => {
        const base = writeLocaleQuery(opts);
        const search = opts?.live ? `${base ? `${base}&` : "?"}live=1` : base;
        return request<ItemResponse<T>>(
          "PATCH",
          `/api/items/${slug}/${id}${search}`,
          patch,
          opts?.ifUnmodifiedSince
            ? { "x-if-unmodified-since": opts.ifUnmodifiedSince }
            : undefined,
        );
      },
      delete: (id: string): Promise<{ ok: boolean }> =>
        request<{ ok: boolean }>("DELETE", `/api/items/${slug}/${id}`),
      /** Bulk-create rows. `atomic` runs the whole set in one transaction
       *  (all-or-nothing; Postgres/SQLite only). Default is partial-success. */
      createMany: (rows: Partial<T>[], opts?: { atomic?: boolean }): Promise<BatchResponse<T>> =>
        request<BatchResponse<T>>("POST", `/api/items/${slug}/batch`, {
          operations: rows.map((data) => ({ op: "create", data })),
          atomic: opts?.atomic,
        }),
      /** Bulk-update rows by id. */
      updateMany: (
        updates: { id: string; data: Partial<T> }[],
        opts?: { atomic?: boolean },
      ): Promise<BatchResponse<T>> =>
        request<BatchResponse<T>>("POST", `/api/items/${slug}/batch`, {
          operations: updates.map((u) => ({ op: "update", id: u.id, data: u.data })),
          atomic: opts?.atomic,
        }),
      /** Bulk-delete rows by id. */
      deleteMany: (ids: string[], opts?: { atomic?: boolean }): Promise<BatchResponse<T>> =>
        request<BatchResponse<T>>("POST", `/api/items/${slug}/batch`, {
          operations: ids.map((id) => ({ op: "delete", id })),
          atomic: opts?.atomic,
        }),
      /** Set the SAME fields on many ids at once (one shared patch). Only the
       *  named fields change per row; partial-success (a key the caller can't
       *  write is reported `NOT_FOUND`). Differs from `updateMany`, which sends
       *  a distinct patch per id. */
      bulkUpdate: (keys: string[], data: Partial<T>): Promise<BulkUpdateResponse> =>
        request<BulkUpdateResponse>("POST", `/api/items/${slug}/bulk-update`, {
          keys,
          data,
        }),
      /** Mixed create/update/delete in one request. `atomic` = all-or-nothing. */
      batch: (
        operations: BatchOperation<T>[],
        opts?: { atomic?: boolean },
      ): Promise<BatchResponse<T>> =>
        request<BatchResponse<T>>("POST", `/api/items/${slug}/batch`, {
          operations,
          atomic: opts?.atomic,
        }),
      /** Flip a versioned item to published (`_status`) now. */
      publish: (id: string): Promise<ItemResponse<T>> =>
        request<ItemResponse<T>>("POST", `/api/items/${slug}/${id}/publish`),
      /** Flip a versioned item back to draft (clears any pending schedule). */
      unpublish: (id: string): Promise<ItemResponse<T>> =>
        request<ItemResponse<T>>("POST", `/api/items/${slug}/${id}/publish?unpublish=1`),
      /** Archive a versioned item — hidden from readers like a draft, but a
       *  distinct "pulled from publication" state. Leave archived via
       *  `publish()` (→ published) or `unpublish()` (→ draft). */
      archive: (id: string): Promise<ItemResponse<T>> =>
        request<ItemResponse<T>>("POST", `/api/items/${slug}/${id}/publish?archive=1`),
      /** Schedule a versioned item to auto-publish at `at` (the cron tick applies
       *  it when due). Pass `null` to cancel a pending schedule. Requires the
       *  `publish` permission. */
      schedulePublish: (id: string, at: Date | string | null): Promise<ItemResponse<T>> =>
        request<ItemResponse<T>>("POST", `/api/items/${slug}/${id}/publish`, {
          publishAt: at == null ? null : at instanceof Date ? at.toISOString() : at,
        }),
      /** Set an expiry: auto-unpublish the item back to draft at `at` (the cron
       *  tick applies it when due), preserving its current state until then. Pass
       *  `null` to cancel. Requires the `publish` permission. */
      scheduleUnpublish: (id: string, at: Date | string | null): Promise<ItemResponse<T>> =>
        request<ItemResponse<T>>("POST", `/api/items/${slug}/${id}/publish`, {
          unpublishAt: at == null ? null : at instanceof Date ? at.toISOString() : at,
        }),
      /** Discard a staged-edits item's pending staged patch without applying
       *  it — the live row is untouched. (On a `stagedEdits` collection,
       *  `update()` against a published row stages the change; the next
       *  `publish()` applies it.) */
      discardStaged: (id: string): Promise<{ ok: boolean }> =>
        request<{ ok: boolean }>("DELETE", `/api/items/${slug}/${id}/staged`),
      /** Verify a plaintext against a `hash` field's stored digest. */
      verify: (id: string, field: string, value: string): Promise<{ valid: boolean }> =>
        request<{ valid: boolean }>("POST", `/api/items/${slug}/${id}/verify`, { field, value }),
      /** The status moves this row could make right now, refused ones included. */
      transitions: (id: string): Promise<{ data: FieldTransitions[] }> =>
        request<{ data: FieldTransitions[] }>("GET", `/api/items/${slug}/${id}/transitions`),
      /** Restate this collection's rollup columns from the rows they aggregate. */
      refreshRollups: (): Promise<{ ok: boolean; refreshed: string[] }> =>
        request<{ ok: boolean; refreshed: string[] }>(
          "POST",
          `/api/items/${slug}/rollups/refresh`,
        ),
      /** Catch this collection's sequence counters up to the rows already in it. */
      syncSequences: (): Promise<{ ok: boolean; synced: SequenceSyncReport[] }> =>
        request<{ ok: boolean; synced: SequenceSyncReport[] }>(
          "POST",
          `/api/items/${slug}/sequences/sync`,
        ),
      /** Peek at the next number each sequence column would issue. */
      nextSequences: (): Promise<Record<string, string>> =>
        request<{ data: Record<string, string> }>(
          "GET",
          `/api/items/${slug}/sequences/next`,
        ).then((r) => r.data),
      /** Move a row before or after another in the same hand-arranged list. */
      reorder: (
        field: string,
        id: string,
        to: { before: string } | { after: string },
      ): Promise<ReorderReport> =>
        request<{ data: ReorderReport }>("POST", `/api/items/${slug}/reorder`, {
          field,
          id,
          ...to,
        }).then((r) => r.data),
      /** Renumber this collection's order fields into dense 1…N per list. */
      normalizeOrder: (field?: string): Promise<NormalizeOrderReport> =>
        request<{ data: NormalizeOrderReport }>(
          "POST",
          `/api/items/${slug}/order/normalize`,
          field === undefined ? {} : { field },
        ).then((r) => r.data),
      /**
       * Fill in slugs for the rows of this collection that have none.
       *
       * A **dry run by default** — pass `apply: true` to write. Never revises a
       * slug that is already set, because that one may be a published URL, so
       * it is safe to re-run and safe to run after someone has hand-corrected
       * one. Bounded per call at a thousand rows per field; re-run while
       * `filled` is non-zero.
       */
      backfillSlugs: (
        opts: { field?: string; apply?: boolean } = {},
      ): Promise<SlugBackfillReport> =>
        request<{ data: SlugBackfillReport }>(
          "POST",
          `/api/items/${slug}/slugs/backfill`,
          opts,
        ).then((r) => r.data),
      /**
       * Geocode the rows of this collection that have an address and no point.
       *
       * Bounded per call — loop while `remaining > 0`. Never revises a point
       * that is already set, so it is safe to re-run and safe to run after
       * someone has hand-corrected one.
       */
      backfillGeo: (field: string, limit?: number): Promise<GeoBackfillReport> =>
        request<{ data: GeoBackfillReport }>(
          "POST",
          `/api/geo/backfill/${slug}`,
          limit === undefined ? { field } : { field, limit },
        ).then((r) => r.data),
      /**
       * Rewrite this collection's existing phone values into E.164.
       *
       * Paged by cursor rather than by "how many are left", because an
       * already-canonical row never leaves the candidate set — a `remaining`
       * count would never reach zero and the loop would re-scan page one
       * forever.
       */
      normalizePhones: (
        field: string,
        opts: { limit?: number; after?: string; dryRun?: boolean } = {},
      ): Promise<PhoneNormalizeReport> =>
        request<{ data: PhoneNormalizeReport }>("POST", `/api/phone/normalize/${slug}`, {
          field,
          ...(opts.limit === undefined ? {} : { limit: opts.limit }),
          ...(opts.after === undefined ? {} : { after: opts.after }),
          ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
        }).then((r) => r.data),
      /**
       * Rewrite this collection's existing email values into canonical form.
       *
       * Same cursor loop as `normalizePhones`, and for the same reason. The one
       * extra counter is `collided`: folding can make two rows equal, and the
       * columns most worth normalizing are exactly the `unique` ones that were
       * letting the duplicate in.
       */
      normalizeEmails: (
        field: string,
        opts: { limit?: number; after?: string; dryRun?: boolean } = {},
      ): Promise<EmailNormalizeReport> =>
        request<{ data: EmailNormalizeReport }>("POST", `/api/email/normalize/${slug}`, {
          field,
          ...(opts.limit === undefined ? {} : { limit: opts.limit }),
          ...(opts.after === undefined ? {} : { after: opts.after }),
          ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
        }).then((r) => r.data),
    };
  };

  // ── Realtime transport selection ──────────────────────────────────────────
  //
  // Which data-plane transport this deployment offers is deployment-static, so
  // it's probed ONCE per client and every later subscribe reuses the answer.
  // The probe has to come first (rather than optimistically opening an
  // EventSource and switching): on a stateless-serverless deployment an
  // `items:*` SSE subscribe would hold a function invocation open for a stream
  // that can never deliver anything.
  let itemsTransportPromise: Promise<ItemsTransportKind> | null = null;
  const itemsTransport = (): Promise<ItemsTransportKind> => {
    itemsTransportPromise ??= request<{ transport?: ItemsTransportKind }>(
      "GET",
      "/api/realtime/items-config",
    )
      .then((j) => j.transport ?? "sse")
      // A probe failure must not take realtime down on deployments where SSE
      // works — assume the historical transport.
      .catch(() => "sse" as const);
    return itemsTransportPromise;
  };

  /** Lazily-created Ably connection shared by every signal subscription. */
  let signalHub: SignalHub | null = null;
  const getSignalHub = (): SignalHub => {
    signalHub ??= createSignalHub({
      token: (channels) =>
        request<{ tokenRequest: unknown }>("POST", "/api/realtime/ably-token", {
          channels,
        }).then((r) => r.tokenRequest),
    });
    return signalHub;
  };

  /** Pull the `filter=<json>` a live query appended to the subscribe URL back
   *  out, so the signal plane's read-back can apply the same narrowing the SSE
   *  plane applies server-side. Anything unparseable is treated as no filter —
   *  the read-back is then merely wider, never wrong. */
  const filterFromQuery = (query: string | undefined): Condition | null => {
    if (!query) return null;
    const raw = new URLSearchParams(query).get("filter");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Condition;
    } catch {
      return null;
    }
  };

  const subscribeSse = <T>(
    channel: string,
    onEvent: (e: ItemEvent<T>) => void,
    onError: ((err: unknown) => void) | undefined,
    query: string | undefined,
  ): (() => void) => {
    const url = `${opts.url}/api/realtime/${channel}/subscribe${query ? `?${query}` : ""}`;
    const es = new EventSource(url, { withCredentials: true });
    es.addEventListener("message", (ev: MessageEvent<string>) => {
      try {
        onEvent(JSON.parse(ev.data) as ItemEvent<T>);
      } catch (e) {
        onError?.(e);
      }
    });
    es.addEventListener("error", (e) => onError?.(e));
    return () => es.close();
  };

  /** Signal plane: listen for id-only signals on Ably, read the changed rows
   *  back through the permission-filtered REST path, and emit the same
   *  `ItemEvent`s the SSE plane would have. */
  const subscribeSignal = <T extends Record<string, unknown>>(
    slug: string,
    onEvent: (e: ItemEvent<T>) => void,
    onError: ((err: unknown) => void) | undefined,
    query: string | undefined,
  ): Promise<() => void> => {
    const filter = filterFromQuery(query);
    const hydrator = createSignalHydrator<T>(
      {
        fetchByIds: (ids) =>
          collection<T>(slug)
            .list({ filter: idBatchFilter(filter, ids), limit: ids.length })
            .then((r) => r.data),
      },
      onEvent,
      onError,
    );
    return getSignalHub()
      .attach(signalChannel(slug), (s) => hydrator.push(s))
      .then((detach) => () => {
        hydrator.close();
        detach();
      })
      .catch((e: unknown) => {
        onError?.(e);
        hydrator.close();
        return () => {};
      });
  };

  const subscribe = <T = Record<string, unknown>>(
    channel: string,
    onEvent: (e: ItemEvent<T>) => void,
    onError?: (err: unknown) => void,
    query?: string,
  ): (() => void) => {
    const slug = channel.startsWith("items:") ? channel.slice("items:".length) : null;
    // Non-`items:` channels (presence, collab, agent threads, free-form) have
    // no signal twin — they stay on SSE exactly as before.
    if (!slug) return subscribeSse(channel, onEvent, onError, query);

    let disposed = false;
    let stop: (() => void) | null = null;
    void (async () => {
      const transport = await itemsTransport();
      if (disposed) return;
      if (transport === "off") {
        onError?.(
          new Error(
            "Realtime is not available on this deployment — no Durable Object, long-lived process, Upstash Redis or ABLY_API_KEY is configured.",
          ),
        );
        return;
      }
      stop =
        transport === "ably-signal"
          ? await subscribeSignal(
              slug,
              onEvent as (e: ItemEvent<Record<string, unknown>>) => void,
              onError,
              query,
            )
          : subscribeSse(channel, onEvent, onError, query);
      if (disposed) {
        stop();
        stop = null;
      }
    })();
    return () => {
      disposed = true;
      stop?.();
      stop = null;
    };
  };

  /** The one handle every domain module is built from. Assembled after the
   *  transport above so a domain client can never reach around it. */
  const core: ClientCore = {
    opts,
    fetch: f,
    authBase,
    request,
    requestRaw,
    collection,
    authHeaders: () => ({ ...authHeader(), ...tenantHeader(), ...orgHeader() }),
    getToken: () => appToken,
    setToken: (t) => {
      appToken = t;
    },
    getActiveOrg: () => activeOrg,
    setActiveOrg: (o) => {
      activeOrg = o;
    },
  };

  const auth = makeAuth(core);
  const storage = makeStorage(core);
  const messaging = makeMessaging(core);
  const jobs = makeJobs(core);
  const flows = makeFlows(core);
  const documents = makeDocuments(core);
  const approvals = makeApprovals(core);
  const signatures = makeSignatures(core);
  const booking = makeBooking(core);
  const integrations = makeIntegrations(core);
  const syncHooks = makeSyncHooks(core);
  const authHooks = makeAuthHooks(core);
  const channels = makeChannels(core);
  const rls = makeRls(core);
  const payments = makePayments(core);
  const kpis = makeKpis(core);
  const dashboards = makeDashboards(core);
  const analytics = makeAnalytics(core);
  const forms = makeForms(core);
  const extensions = makeExtensions(core);
  const usage = makeUsage(core);
  const advisor = makeAdvisor(core);
  const backups = makeBackups(core);
  const agents = makeAgents(core);
  const permissions = makePermissions(core);
  const schema = makeSchema(core);
  const migrate = makeMigrate(core);
  const templates = makeTemplates(core);
  const appUsers = makeAppUsers(core);
  const orgs = makeOrgs(core);
  const flags = makeFlags(core);


  /** Offline-first sync for one collection — pulls the changefeed into a local
   *  store, stays live over SSE, and queues writes while offline. See
   *  `createSync` in `./sync`. */
  const sync = (options: SyncOptions) => createSync({ request, subscribe }, options);

  const liveQuery = <T extends Record<string, unknown> = Record<string, unknown>>(
    slug: string,
    opts: LiveQueryOptions,
    onResult: (rows: T[]) => void,
    onError?: (err: unknown) => void,
  ): (() => void) =>
    createLiveQuery<T>(
      { list: (q) => collection<T>(slug).list(q), subscribe },
      slug,
      opts,
      onResult,
      onError,
    );

  return {
    from: collection,
    subscribe,
    liveQuery,
    auth,
    storage,
    messaging,
    jobs,
    flows,
    documents,
    approvals,
    signatures,
    booking,
    payments,
    integrations,
    syncHooks,
    authHooks,
    channels,
    rls,
    extensions,
    kpis,
    dashboards,
    analytics,
    forms,
    usage,
    advisor,
    backups,
    agents,
    permissions,
    templates,
    appUsers,
    orgs,
    schema,
    migrate,
    flags,
    sync,
    /** Raw escape hatch — issues a request with auth headers applied. */
    request,
  };
};

/** A registry mapping each collection slug to its row type — the shape
 *  `backlex gen-types --sdk` emits as `Collections`. */
export type CollectionsMap = Record<string, Record<string, unknown>>;

/** `{ [slug]: CollectionClient<Row> }` — the typed `collections` accessor. */
export type TypedCollections<R extends CollectionsMap> = {
  [K in keyof R]: CollectionClient<R[K]>;
};

/** A `BacklexClient` augmented with a strongly-typed `collections` accessor,
 *  so `db.collections.<slug>.list()` returns `ListResponse<Row>`. */
export type TypedClient<R extends CollectionsMap> = BacklexClient & {
  collections: TypedCollections<R>;
};

/**
 * Wrap a client with a typed `collections` accessor keyed by collection slug.
 * Generated SDKs call this with the generated `Collections` registry:
 *
 *   export const createTypedClient = (opts: ClientOptions) =>
 *     typedCollections<Collections>(createClient(opts));
 *
 * Access is a thin proxy over `client.from(slug)` — no per-collection runtime
 * code is generated; all the type information lives in `R`.
 */
export const typedCollections = <R extends CollectionsMap>(
  client: BacklexClient,
): TypedClient<R> => {
  const collections = new Proxy({} as TypedCollections<R>, {
    get: (_target, slug) =>
      typeof slug === "string" ? client.from(slug) : undefined,
  });
  return Object.assign(client, { collections });
};

export {
  createSync,
  memoryStore,
  indexedDbStore,
  sqliteStore,
  type SqliteLike,
  type SyncStore,
  type SyncOptions,
  type SyncController,
  type QueuedOp,
  type ConflictPolicy,
  type SyncConflict,
} from "./sync";

export { verifyWebhook, type VerifyWebhookOptions } from "./webhook";

export {
  createTokenVerifier,
  type AccessTokenClaims,
  type TokenVerifier,
  type TokenVerifierOptions,
} from "./token";
