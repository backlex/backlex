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
 */
import {
  type AggregateQuery,
  type AggregateRow,
  type BatchOperation,
  type BatchResponse,
  type BulkUpdateResponse,
  type DeviceToken,
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
  type PhoneNumber,
  type Job,
  type JobStatus,
  type ResumableUploadResult,
  type FlagState,
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

export interface ClientOptions {
  url: string;
  /** Static API key (`pak_...`) for server-to-server calls. Browser apps
   *  should rely on the cookie session / a workspace session token and omit
   *  this. */
  apiKey?: string;
  /**
   * Workspace slug. When set, the client operates in **app mode**: `auth.*`
   * targets that workspace's own auth surface (`/api/t/<slug>/auth/*`, the
   * "auth as a service" pool — distinct from the admin/control-plane auth),
   * and the session token returned by `auth.signUp` / `auth.signIn` is
   * captured and sent as `Authorization: Bearer <token>` on every subsequent
   * request (data + auth). Persist it across page loads with `auth.getToken()`
   * / restore it with `auth.setToken()`.
   */
  workspace?: string;
  /** Restore a previously-saved workspace session token (app mode). */
  token?: string;
  /**
   * Scope every request to a specific tenant/workspace by sending the
   * `X-Backlex-Tenant` header (slug or id). Needed for anonymous public reads
   * and for a `pak_` key addressing a tenant other than its home one. The server
   * ignores it for app-mode bearer sessions (the tenant comes from the session).
   */
  tenant?: string;
  /**
   * Publishable analytics ingest key (`alk_...`). Safe to ship in a browser or
   * mobile bundle: it authorises append-only `analytics.track` /
   * `analytics.trackError` calls and cannot read anything back. Omit it when
   * the client already carries a session or API key — ingest accepts those too.
   */
  ingestKey?: string;
  /**
   * Act inside a specific organization by sending the `X-Backlex-Org` header
   * (slug or id) on every request, so `$org.id` in permission rules resolves to
   * it. Only meaningful for app-plane sessions, and only accepted for orgs the
   * signed-in end-user actually belongs to. Change it later with
   * `client.orgs.use(...)`.
   */
  org?: string;
  /** Optional fetch override (testing / Node polyfill). */
  fetch?: typeof fetch;
  /**
   * Distributed tracing. When enabled (the default), every request carries a
   * W3C `traceparent` header so the call shows up in the admin Traces panel and
   * stitches together with any server-side spans it triggers. Set `false` to
   * omit the header entirely.
   *
   * Pass a function to control the trace context — return a `traceparent` value
   * to continue an existing trace (e.g. one already active in the browser), or
   * `undefined` to let the SDK start a fresh trace for that call. The default
   * starts a new trace per request.
   */
  tracing?: boolean | (() => string | undefined);
}

/** A signed-in user as returned by the auth surface. */
export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
}
/** Result of a sign-in / sign-up — the user and (app mode) the session token. */
export interface AuthResult {
  user: AuthUser;
  token?: string;
}
/** One active session (device/login) of the signed-in user. */
export interface AuthSession {
  id: string;
  token: string;
  userId: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
  updatedAt: string;
}
/** A public sign-in provider as advertised by `auth.providers()`. */
export interface PublicProvider {
  id: string;
  kind: "credential" | "magic-link" | "email-otp" | "passkey" | "social";
  label: string;
  enabled: boolean;
}
/** Public description of a workspace's auth surface (provider list + policy). */
export interface AuthSurface {
  tenantId: string | null;
  providers: PublicProvider[];
  policy: { openSignup: boolean; requireEmailVerification: boolean } & Record<string, unknown>;
}

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

/** Write-time locale target for `localized` fields. */
export interface WriteLocaleOpts {
  /** When set, `localized` field values in the body are the native value for
   *  this one locale (upserted without disturbing other locales). Omit to send
   *  full `{locale: value}` maps. */
  locale?: string;
}

const writeLocaleQuery = (opts: WriteLocaleOpts | undefined): string =>
  opts?.locale ? `?locale=${encodeURIComponent(opts.locale)}` : "";

/** Options for `update()` — locale targeting plus optimistic concurrency. */
export interface WriteUpdateOpts extends WriteLocaleOpts {
  /** Optimistic-concurrency precondition: pass the `updatedAt` you loaded the
   *  row with; the server refuses with 409 CONFLICT when the row was modified
   *  since (instead of silently last-write-winning). */
  ifUnmodifiedSince?: string;
  /** Staged-edits collections: bypass staging and edit the live row of a
   *  published item directly. Requires the `publish` permission. */
  live?: boolean;
}

// ── Resumable-upload helpers (TUS) ──────────────────────────────────────────
/** Default PATCH chunk size: 8 MiB (object stores require ≥5 MiB non-final parts). */
const DEFAULT_CHUNK = 8 * 1024 * 1024;
const OFFSET_OCTET = "application/offset+octet-stream";

/** Base64-encode a UTF-8 string for a TUS `Upload-Metadata` value. */
const b64 = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)));

interface UploadSource {
  size: number;
  /** Returns a chunk `[start, end)` as a fetch body. */
  slice(start: number, end: number): BodyInit;
}

const normalizeUploadData = (data: Blob | ArrayBuffer | Uint8Array): UploadSource => {
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return { size: data.size, slice: (s, e) => data.slice(s, e) };
  }
  const u = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  // Cast: a Uint8Array view is a valid fetch body at runtime, but TS's DOM
  // `BodyInit` wants `Uint8Array<ArrayBuffer>` (not `ArrayBufferLike`).
  return { size: u.byteLength, slice: (s, e) => u.subarray(s, e) as unknown as BodyInit };
};

/** The per-collection data API returned by `client.from<T>(slug)`. Exported so
 *  generated SDKs (see `backlex gen-types --sdk`) and apps can name the shape. */
export interface CollectionClient<T extends Record<string, unknown>> {
  list(q?: ListQuery): Promise<ListResponse<T>>;
  /** Fluent, type-safe query builder that compiles to `ListQuery`. */
  query(): QueryBuilder<T>;
  /** Run a single-function aggregate (count/sum/avg/min/max), optionally grouped. */
  aggregate(body: AggregateQuery): Promise<{ data: AggregateRow[] }>;
  /** Relevance search — full-text, vector, or `hybrid` (RRF). Requires the
   *  matching capability enabled on the collection. Rows come back best-first
   *  with the caller's read permission + tenant scope enforced. */
  search(body: SearchQuery): Promise<SearchResponse<T>>;
  /** One page of the incremental changefeed. Rows changed past `since`, with
   *  soft-delete tombstones (`_deleted`) and — when a `shape` is given — id-only
   *  move-out markers (`_shape_exit`) for rows that left the subset. This is the
   *  raw primitive; `client.sync()` is the managed loop built on it. */
  changes(q?: ChangesQuery): Promise<ChangesResponse<T>>;
  /** Export every readable row as a JSON or CSV string. */
  exportItems(format?: "json" | "csv"): Promise<string>;
  /** Bulk-import rows from a JSON array (or a raw JSON/CSV string). */
  importItems(
    body: string | Partial<T>[],
    format?: "json" | "csv",
  ): Promise<ImportSummary>;
  one(id: string, opts?: ItemQuery): Promise<ItemResponse<T>>;
  /** Create a row. Pass `{ locale }` to write a single locale of every
   *  `localized` field (the field values are then the native per-locale value);
   *  omit it to send full `{locale: value}` maps. */
  create(data: Partial<T>, opts?: WriteLocaleOpts): Promise<ItemResponse<T>>;
  /** Update a row. Pass `{ locale }` to upsert a single locale of the
   *  `localized` fields in `patch` without disturbing the others. Pass
   *  `{ ifUnmodifiedSince }` (the `updatedAt` you loaded) to get a 409
   *  CONFLICT instead of overwriting someone else's concurrent save. */
  update(id: string, patch: Partial<T>, opts?: WriteUpdateOpts): Promise<ItemResponse<T>>;
  delete(id: string): Promise<{ ok: boolean }>;
  createMany(rows: Partial<T>[], opts?: { atomic?: boolean }): Promise<BatchResponse<T>>;
  updateMany(
    updates: { id: string; data: Partial<T> }[],
    opts?: { atomic?: boolean },
  ): Promise<BatchResponse<T>>;
  deleteMany(ids: string[], opts?: { atomic?: boolean }): Promise<BatchResponse<T>>;
  bulkUpdate(keys: string[], data: Partial<T>): Promise<BulkUpdateResponse>;
  batch(operations: BatchOperation<T>[], opts?: { atomic?: boolean }): Promise<BatchResponse<T>>;
  publish(id: string): Promise<ItemResponse<T>>;
  unpublish(id: string): Promise<ItemResponse<T>>;
  archive(id: string): Promise<ItemResponse<T>>;
  schedulePublish(id: string, at: Date | string | null): Promise<ItemResponse<T>>;
  scheduleUnpublish(id: string, at: Date | string | null): Promise<ItemResponse<T>>;
  /** Discard a staged-edits item's pending staged patch without applying it. */
  discardStaged(id: string): Promise<{ ok: boolean }>;
  /** Check a plaintext against the stored digest of a `hash` field on the row.
   *  The digest never leaves the server; this returns only `{ valid }`.
   *  Requires read permission on the item; the server throttles attempts. */
  verify(id: string, field: string, value: string): Promise<{ valid: boolean }>;
  /** Restate this collection's `rollup` columns from the rows they aggregate.
   *  Ordinary writes keep rollups in step on their own — this is the repair
   *  path for rows written around the API (a restore, a bulk seed, direct SQL).
   *  Idempotent; returns the columns it refreshed. Requires `update`. */
  refreshRollups(): Promise<{ ok: boolean; refreshed: string[] }>;
  /** Move this collection's `sequence` counters forward to the highest number
   *  already stored in each column. The repair path for a series that predates
   *  its counter — an adopted table, a restore, a bulk seed. Counters only ever
   *  move forward. Idempotent. Requires `update`. */
  syncSequences(): Promise<{ ok: boolean; synced: SequenceSyncReport[] }>;
  /** The value each sequence column would render next, without consuming it.
   *  A preview: another create can take that number first, so never write it. */
  nextSequences(): Promise<Record<string, string>>;
}

/** What {@link CollectionClient.syncSequences} did to one sequence column. */
export interface SequenceSyncReport {
  field: string;
  /** Reset periods whose counter was moved forward, and to what. */
  advanced: { scope: string; to: number }[];
  /** Stored values this field's pattern could not have produced, so they were
   *  left out of the maximum rather than guessed at. */
  unreadable: number;
}

/** Auth surface for a workspace's end-users (and the admin pool). See `createClient`. */
export interface AuthClient {
  /** Email + password sign-up (app mode → a workspace end-user). */
  signUp(input: { email: string; password: string; name?: string }): Promise<AuthResult>;
  /** Email + password sign-in. */
  signIn(input: { email: string; password: string }): Promise<AuthResult>;
  /** Begin an OAuth sign-in; returns the provider authorize `url` to navigate to. */
  signInSocial(
    provider: string,
    input?: { callbackURL?: string; errorCallbackURL?: string },
  ): Promise<{ url: string; redirect: boolean }>;
  /** Send a one-time sign-in link by email (magic-link provider). */
  signInMagicLink(input: { email: string; callbackURL?: string }): Promise<{ status: boolean }>;
  /** Email a one-time numeric code (email-otp provider). */
  sendVerificationOTP(input: {
    email: string;
    type?: "sign-in" | "email-verification" | "forget-password";
  }): Promise<{ success: boolean }>;
  /** Complete an email-OTP sign-in with the emailed code. */
  signInEmailOTP(input: { email: string; otp: string }): Promise<AuthResult>;
  /** Send a password-reset email. */
  requestPasswordReset(input: { email: string; redirectTo?: string }): Promise<{ status: boolean }>;
  /** Complete a reset with the emailed token and a new password. */
  resetPassword(input: { newPassword: string; token: string }): Promise<{ status: boolean }>;
  /** Accept an admin-issued end-user invite (app mode only — the admin plane
   *  has no invite/accept endpoint): sets the password on the pending account
   *  and signs straight in; the session token is captured like `signIn`. */
  acceptInvite(input: { token: string; password: string }): Promise<AuthResult>;
  /** Mint a fresh short-lived access JWT from the stored session token (app mode). */
  refresh(): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; tokenType: string }>;
  /** Change the signed-in user's password. */
  changePassword(input: {
    newPassword: string;
    currentPassword: string;
    revokeOtherSessions?: boolean;
  }): Promise<Record<string, unknown>>;
  /** Update the signed-in user's profile (e.g. `{ name, image }`). */
  updateUser(attributes: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Send an email-verification link to the signed-in (or named) user. */
  sendVerificationEmail(input: { email: string; callbackURL?: string }): Promise<{ status: boolean }>;
  /** Sign out the current session. */
  signOut(): Promise<{ success: boolean }>;
  /** Current session, or `{ user: null }`. */
  getSession(): Promise<{ user: AuthUser | null } & Record<string, unknown>>;
  /** List the signed-in user's active sessions. */
  listSessions(): Promise<AuthSession[]>;
  /** Revoke one session by its token. */
  revokeSession(input: { token: string }): Promise<{ status: boolean }>;
  /** Revoke every session except the current one. */
  revokeOtherSessions(): Promise<{ status: boolean }>;
  /** Revoke all sessions, including the current one. */
  revokeSessions(): Promise<{ status: boolean }>;
  /** Public description of this workspace's auth surface (providers + policy). */
  providers(): Promise<AuthSurface>;
  /** The current workspace session token (app mode) — persist across reloads. */
  getToken(): string | null;
  /** Restore a workspace session token (app mode). */
  setToken(token: string | null): void;
}

/** File storage + resumable (TUS) uploads. See `createClient`. */
export interface StorageClient {
  /** List stored objects, optionally under a key prefix. */
  list(prefix?: string): Promise<{
    data: {
      key: string;
      size: number;
      contentType?: string;
      ownerId: string | null;
      uploadedAt: string;
    }[];
  }>;
  /** Upload an object in one request. */
  put(key: string, body: BodyInit, contentType?: string, folderId?: string): Promise<unknown>;
  /** Download an object; returns the raw `Response`. */
  download(key: string): Promise<Response>;
  /** Delete an object by key. */
  delete(key: string): Promise<{ ok: boolean }>;
  /** Resumable upload (TUS 1.0.0) that resumes after a transient failure. */
  uploadResumable(input: {
    key: string;
    data: Blob | ArrayBuffer | Uint8Array;
    contentType?: string;
    folderId?: string;
    chunkSize?: number;
    onProgress?: (sent: number, total: number) => void;
    signal?: AbortSignal;
  }): Promise<ResumableUploadResult>;
  /** Resume a previously-started resumable upload at the server's offset. */
  resumeUpload(
    location: string,
    data: Blob | ArrayBuffer | Uint8Array,
    opts2?: { chunkSize?: number; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal },
  ): Promise<void>;
}

/** Push + SMS device registration for the current user. See `createClient`. */
export interface MessagingClient {
  /** Register (or refresh) the current user's push device. */
  registerDevice(input: {
    platform: "fcm" | "apns" | "web-push";
    token: string;
    keys?: { p256dh: string; auth: string };
    deviceName?: string;
  }): Promise<{ data: { id: string } }>;
  /** Remove one of the caller's registered devices by id. */
  unregister(id: string): Promise<{ ok: boolean }>;
  /** List the caller's registered devices. */
  listDevices(): Promise<{ data: DeviceToken[] }>;
  /** Register (or refresh) the caller's E.164 phone number for SMS. */
  registerPhone(input: { phoneNumber: string }): Promise<{ data: { id: string } }>;
  /** Remove one of the caller's registered phone numbers by id. */
  unregisterPhone(id: string): Promise<{ ok: boolean }>;
  /** List the caller's registered phone numbers. */
  listPhones(): Promise<{ data: PhoneNumber[] }>;
  /** Send a push notification to a user's registered devices (dispatch-only —
   *  no in-app notification row). Admins may target any user; non-admins only
   *  themselves. */
  sendPush(input: {
    userId: string;
    title: string;
    body: string;
    url?: string;
    data?: Record<string, string>;
  }): Promise<{ ok: boolean; sent: number; failed: number }>;
  /** Send an SMS to a user's registered phone numbers. Admins may target any
   *  user; non-admins only themselves. */
  sendSms(input: {
    userId: string;
    body: string;
  }): Promise<{ ok: boolean; sent: number; failed: number }>;
}

/** Durable background job queue (admin-scoped). See `createClient`. */
export interface JobsClient {
  /** Enqueue a durable background job. */
  enqueue(input: {
    type: "function" | "webhook.deliver";
    payload?: Record<string, unknown>;
    queue?: string;
    runAt?: string;
    maxAttempts?: number;
    priority?: number;
  }): Promise<{ id: string }>;
  /** List jobs (newest first), optionally filtered by queue/status. */
  list(q?: { queue?: string; status?: JobStatus; limit?: number }): Promise<{ jobs: Job[] }>;
  /** Fetch a single job by id. */
  get(id: string): Promise<Job>;
  /** Requeue a failed / dead-lettered / cancelled job. */
  retry(id: string): Promise<{ ok: boolean }>;
  /** Cancel a pending job. */
  cancel(id: string): Promise<{ ok: boolean }>;
  /** Delete a job row. */
  remove(id: string): Promise<{ ok: boolean }>;
}

/** Feature flags / remote config evaluated for the current caller. See `createClient`. */
export interface FlagsClient {
  /** Fetch + cache the evaluated flag map. */
  all(): Promise<Record<string, FlagState>>;
  /** Resolved value (remote config payload) for a flag, or `undefined`. */
  get(key: string, opts?: { refresh?: boolean }): Promise<unknown>;
  /** Whether a flag is on for the caller. */
  isEnabled(key: string, opts?: { refresh?: boolean }): Promise<boolean>;
}

/** A visual workflow (flow) row. `operations` is the serialized op DSL the
 *  builder compiles; `layout` is a purely-presentational graph snapshot. */
export interface Flow {
  id: string;
  tenantId?: string | null;
  name: string;
  trigger: string;
  operations: unknown[];
  layout?: unknown;
  active: boolean;
}

/** Create/update payload for a flow. `operations` must be non-empty on create;
 *  `update` accepts any subset. */
export interface FlowInput {
  name: string;
  trigger: string;
  operations: unknown[];
  layout?: unknown;
  active?: boolean;
}

/** Outcome of a manual flow run. `ok: false` means the run halted on an
 *  unhandled op error; `error` carries the first failure message. */
export interface FlowRunResult {
  ok: boolean;
  error?: string;
}

/** A BI dashboard row — a named grouping of saved panels, optionally published
 *  to a public embed URL. Mirrors `/api/admin/dashboards`. */
export interface Dashboard {
  id: string;
  tenantId?: string | null;
  name: string;
  description: string | null;
  layout?: unknown;
  /** Whether the public embed is currently live. */
  embedEnabled: boolean;
  /** Role the public embed scopes panel data to (null = unscoped public). */
  embedRoleId: string | null;
}

/** Create/update payload for a dashboard. */
export interface DashboardInput {
  name: string;
  description?: string | null;
  layout?: unknown;
}

/** One panel's rendered result inside a dashboard run. */
export interface DashboardPanelResult {
  panelId: string;
  name: string;
  viz: string;
  kind: string;
  config: unknown;
  data: Record<string, unknown>[];
  note?: string;
  error?: string;
}

/** Outcome of minting/rotating a dashboard embed token. The plaintext `token`
 *  is shown once; `url` is the relative embed path. */
export interface DashboardShareResult {
  token: string;
  url: string;
}

/** One block on a public form (order = render order). `kind: "field"` exposes
 *  a collection field; `kind: "step"` is a presentation-only page break. */
export interface PublicFormBlockConfig {
  /** Stable client id for builder selection/reorder. Optional; preserved. */
  id?: string;
  /** Defaults to "field" when omitted (legacy configs). */
  kind?: "field" | "step";
  /** Collection field name — required for field blocks. */
  name?: string;
  /** Display label override; step blocks use it as the step title. */
  label?: string;
  placeholder?: string;
  /** Help text override shown beneath the input. */
  help?: string;
  /** Integer fields only: render as a 1–5 star rating. */
  rating?: boolean;
  /** Boolean fields only: consent checkbox — submits must carry `true`. */
  consent?: boolean;
  /** Optional "read the full text" URL shown next to a consent block. */
  policyUrl?: string;
  /** Show-condition: render only when another field's answer matches. */
  cond?: { field: string; op: "is" | "is_not"; value: string };
  /** Per-locale string overrides; missing strings fall back to the base. */
  i18n?: Record<string, { label?: string; placeholder?: string; help?: string }>;
}

/** @deprecated Renamed to {@link PublicFormBlockConfig}. */
export type PublicFormFieldConfig = PublicFormBlockConfig;

/** Behaviour + appearance knobs for a public form. */
export interface PublicFormSettings {
  /** Sub-heading under the form title on the public page. */
  description?: string;
  submitLabel?: string;
  successMessage?: string;
  redirectUrl?: string;
  /** Require a Cloudflare Turnstile pass on submit (server needs the secret). */
  turnstile?: boolean;
  theme?: "dark" | "light";
  accent?: string;
  font?: "sans" | "lexend" | "mono" | "system";
  /** Offered locales, base language first. `?lang=xx` forces one publicly. */
  languages?: string[];
  i18n?: Record<
    string,
    { title?: string; description?: string; submitLabel?: string; successMessage?: string }
  >;
}

/** A public form definition. Mirrors `/api/admin/forms`. The public token is
 *  never present — it is returned once by `create` / `rotateToken`. */
export interface PublicForm {
  id: string;
  tenantId?: string | null;
  name: string;
  collection: string;
  fields: PublicFormBlockConfig[];
  settings: PublicFormSettings | null;
  active: boolean;
  /** All-time accepted submissions. */
  submissionCount: number;
  /** Submissions rejected by honeypot / Turnstile / rate limit. */
  blockedCount: number;
  lastSubmissionAt: unknown;
}

/** Create/update payload for a public form. */
export interface PublicFormInput {
  name: string;
  collection: string;
  fields: PublicFormBlockConfig[];
  settings?: PublicFormSettings | null;
  active?: boolean;
}

/** Outcome of minting/rotating a form token. `token` is shown exactly once;
 *  `url`/`embedUrl` are the relative public page paths. */
export interface PublicFormToken {
  token: string;
  url: string;
  embedUrl: string;
}

/** A collection field that may be exposed on a public form. */
export interface PublicFormEligibleField {
  name: string;
  type: string;
  label: string | null;
  required: boolean;
  /** Dropdown choice values, when the field defines them. */
  choices: string[] | null;
  /** email/url format hint from the field's validation rules. */
  format: string | null;
}

/** An AI agent definition. Mirrors `/api/agents`. */
export interface Agent {
  id: string;
  tenantId?: string | null;
  name: string;
  /** Stable `@`-mention token, unique per workspace. This is what you type
   *  after `@` in a room to address the agent. */
  handle?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  model?: string | null;
  /** Reasoning effort (`low` | `medium` | `high`); null = provider default.
   *  Lower effort = fewer thinking tokens and fewer tool calls. Ignored by
   *  models that don't support it. */
  effort?: string | null;
  /** Allow-list of MCP tool names the agent may call. */
  tools: string[];
  maxSteps: number;
  /** Cross-turn memory — an episodic trace plus distilled semantic facts.
   *  Best-effort; needs an embedding provider. */
  memory: boolean;
  /** How far distilled facts reach. `thread` (default) keeps everything inside
   *  the conversation it was learned in; `agent` shares one pool across every
   *  thread, so the agent accumulates lasting knowledge — at the cost of facts
   *  learned from one person becoming visible to the next. */
  memoryScope?: AgentMemoryScope;
  active: boolean;
}

export type AgentMemoryScope = "thread" | "agent";

/** One durable fact an agent holds. Mirrors `/api/agents/:id/memory`. */
export interface AgentMemory {
  id: string;
  agentId: string;
  /** Conversation the fact was distilled from. */
  threadId: string | null;
  scope: AgentMemoryScope;
  content: string;
  /** False when the fact was stored with no embedding provider available — it's
   *  listable and forgettable, but not retrievable by similarity. */
  embedded: boolean;
  /** How many turns have retrieved this fact. */
  hits: number;
}

/** Create/update payload for an agent. */
export interface AgentInput {
  name: string;
  /** Mention handle. Derived from `name` when omitted; normalised and
   *  de-duplicated server-side. */
  handle?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  model?: string | null;
  effort?: "low" | "medium" | "high" | null;
  tools?: string[];
  maxSteps?: number;
  memory?: boolean;
  memoryScope?: AgentMemoryScope;
  active?: boolean;
}

/**
 * A conversation — a **room**, which may host several agents at once.
 *
 * `agentId` is the legacy single-agent pin (set on a thread opened against one
 * specific agent, null on a room); membership lives in `agentIds`.
 *
 * `routing` decides who answers a message that mentions nobody:
 * `mention` (nobody — the room is usable human-to-human), `default`
 * (`defaultAgentId` answers), or `auto` (a cheap router picks a participant).
 */
export interface AgentThread {
  id: string;
  tenantId?: string | null;
  agentId?: string | null;
  title?: string | null;
  status: "idle" | "running" | "error";
  routing?: AgentRoomRouting;
  defaultAgentId?: string | null;
  /** Participants. Present on room list/detail responses. */
  agentIds?: string[];
}

export type AgentRoomRouting = "mention" | "default" | "auto";

/** Create payload for a room. */
export interface AgentRoomInput {
  title?: string | null;
  agentIds?: string[];
  routing?: AgentRoomRouting;
  defaultAgentId?: string | null;
}

/**
 * One agent's turn — the unit of work AND the per-agent lock. Two agents can
 * answer the same room message at once; the same agent cannot run twice.
 */
export interface AgentRun {
  id: string;
  threadId: string;
  agentId: string;
  status: "queued" | "running" | "done" | "error";
  startedBy?: string | null;
  triggerMessageId?: string | null;
  error?: string | null;
}

/** One persisted message in a thread (user / assistant / tool). */
export interface AgentMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /** Team member who asked. Threads are workspace-wide, so a transcript can
   *  mix authors; null on assistant/tool rows and on API-key-driven turns. */
  userId?: string | null;
  /** Which agent wrote an assistant/tool row — a room's transcript mixes
   *  several. Null on user rows. */
  agentId?: string | null;
  toolName?: string | null;
  toolArgs?: unknown;
  toolResult?: unknown;
}

/** A team member referenced by a transcript's `userId`s, returned alongside
 *  the messages so a client can render "who asked" without an extra lookup. */
export interface AgentThreadAuthor {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

/** One reason→act step the agent took during a turn. */
export interface AgentRunStep {
  thought?: string;
  tool: string;
  args: Record<string, unknown>;
  observation: string;
  isError: boolean;
}

/** Outcome of a single agent turn. */
export interface AgentRunResult {
  answer: string;
  steps: AgentRunStep[];
  stoppedReason: "final" | "max_steps" | "error";
  /** The persisted user message that triggered it — one row however many
   *  agents answered. */
  messageId?: string;
  /** Turns that were started, in responder order. */
  runs?: { runId: string; agentId: string }[];
  /** Agents that were asked to answer but were already mid-turn. */
  busy?: { agentId: string; runId: string }[];
  /** Every turn this message produced. The top-level `answer`/`steps` mirror
   *  the first, so single-agent callers need not look here. */
  turns?: AgentRunResult[];
}

/** What `send(..., { async: true })` returns: nothing has run yet. */
export interface AgentSendQueued {
  messageId: string;
  runs: { runId: string; agentId: string }[];
  busy: { agentId: string; runId: string }[];
}

/** AI agents (admin-scoped). Mirrors `/api/agents`. See `createClient`. */
export interface AgentsClient {
  /** List every agent in the active workspace. */
  list(): Promise<{ data: Agent[] }>;
  /** Fetch a single agent by id. */
  get(id: string): Promise<{ data: Agent }>;
  /** Create an agent scoped to the active workspace. */
  create(input: AgentInput): Promise<{ data: Agent }>;
  /** Partial update of an agent by id. */
  update(id: string, patch: Partial<AgentInput>): Promise<{ ok: boolean }>;
  /** Delete an agent by id. */
  delete(id: string): Promise<{ ok: boolean }>;
  /** List threads for an agent (most recently active first). */
  threads(agentId: string): Promise<{ data: AgentThread[] }>;
  /** Start a new conversation thread for an agent. */
  createThread(agentId: string, title?: string): Promise<{ data: AgentThread }>;
  /** Fetch a thread, its full message transcript, and the people who wrote it.
   *  Rooms additionally return their participants and any turns in flight. */
  thread(threadId: string): Promise<{
    data: {
      thread: AgentThread;
      messages: AgentMessage[];
      authors: AgentThreadAuthor[];
      agentIds?: string[];
      activeRuns?: AgentRun[];
    };
  }>;
  /** Delete a thread and its messages. */
  deleteThread(threadId: string): Promise<{ ok: boolean }>;
  /** Send a message and run whichever agents it wakes, to completion.
   *
   *  `agentIds` forces specific responders, bypassing the room's routing mode.
   *  `async: true` queues the turns instead and resolves as soon as they're
   *  accepted — watch `agent:thread:<id>` over realtime, or poll `getRun`. */
  send(
    threadId: string,
    message: string,
    opts?: { agentIds?: string[]; async?: false },
  ): Promise<{ data: AgentRunResult }>;
  send(
    threadId: string,
    message: string,
    opts: { agentIds?: string[]; async: true },
  ): Promise<{ data: AgentSendQueued }>;
  /** Every conversation in the workspace, newest activity first. */
  rooms(): Promise<{ data: AgentThread[] }>;
  /** Open a room. With no `agentIds` it starts empty. */
  createRoom(input?: AgentRoomInput): Promise<{ data: AgentThread }>;
  /** Rename a room or change how it routes unaddressed messages. */
  updateRoom(
    threadId: string,
    patch: Omit<AgentRoomInput, "agentIds">,
  ): Promise<{ ok: boolean }>;
  /** Add an agent to a room. Idempotent. */
  addRoomAgent(threadId: string, agentId: string): Promise<{ ok: boolean }>;
  /** Remove an agent from a room. */
  removeRoomAgent(threadId: string, agentId: string): Promise<{ ok: boolean }>;
  /** Poll one turn's status — for async sends without a realtime connection. */
  getRun(runId: string): Promise<{ data: AgentRun }>;
  /** The durable facts this agent has learned, newest first. These are
   *  distilled from past conversations — for the raw transcript use `thread`.
   *  `threadId` narrows to one conversation's pool. */
  memory(
    agentId: string,
    opts?: { threadId?: string; limit?: number },
  ): Promise<{ data: AgentMemory[]; meta?: { scope: AgentMemoryScope } }>;
  /** Teach the agent one durable fact directly, as a self-contained sentence.
   *  Deduped: re-teaching something it already knows resolves with
   *  `data: null` and `meta.deduped`. `threadId` is required while the agent's
   *  `memoryScope` is `thread`. */
  remember(
    agentId: string,
    content: string,
    opts?: { threadId?: string },
  ): Promise<{ data: AgentMemory | null; meta?: { deduped?: boolean } }>;
  /** Delete one remembered fact by id, from both the row store and the vector
   *  index — the agent stops retrieving it. */
  forget(agentId: string, memoryId: string): Promise<{ ok: boolean }>;
  /** Convenience: start a fresh thread and run one turn. Returns the result
   *  plus the new `threadId` so you can continue the conversation. */
  run(
    agentId: string,
    message: string,
    title?: string,
  ): Promise<{ data: AgentRunResult; threadId: string }>;
}

/** One permission row that granted the simulated action. */
export interface PermissionSimRule {
  permissionId: string;
  roleId: string;
  roleName: string;
  collection: string;
  condition: unknown | null;
  fields: string[] | null;
  rowMatch?: boolean;
}

/** Full reasoning trace returned by `permissions.simulate`. */
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

/** Subject + target for a permission simulation. */
export interface PermissionSimulateInput {
  collection: string;
  action: "read" | "create" | "update" | "delete" | "publish";
  /** Existing user id — roles are read live from the DB. */
  userId?: string | null;
  /** Override email for `$user.email` resolution. */
  email?: string | null;
  /** Ad-hoc role names (ignored when `userId` is set). */
  roles?: string[] | null;
  /** `platform` (admin users, default) or `app` (workspace end-users). */
  plane?: "platform" | "app";
  /** Optional concrete row to evaluate against the combined condition. */
  sampleRow?: Record<string, unknown> | null;
}

/** Permission tooling (admin-scoped). Mirrors `/api/permissions`. */
export interface PermissionsClient {
  /** Dry-run the permission resolver for a subject against a
   *  (collection, action) and return the full allow/deny trace. Read-only. */
  simulate(input: PermissionSimulateInput): Promise<{ data: PermissionSimulation }>;
}


/** One connected payment provider. Secrets come back MASKED. */
export interface PaymentProviderConnection {
  id: string;
  /** `stripe` | `polar` | `lemonsqueezy`. */
  provider: string;
  status: string;
  /** Provider config with every secret field masked (`sk_l…3f9x`). */
  config: Record<string, unknown>;
  webhookToken: string;
  /** Origin-relative path to paste into the provider's webhook settings. */
  webhookPath: string;
  syncCursor: Record<string, string | null> | null;
  lastEventAt?: unknown;
  lastSyncAt?: unknown;
  lastSyncError: string | null;
  createdAt?: unknown;
}

export interface PaymentProviderInput {
  provider: string;
  /** Credentials. A masked value is treated as "leave the stored one alone". */
  config?: Record<string, unknown>;
  status?: "connected" | "disabled";
}

/** One inbound webhook delivery, verified or not. */
export interface PaymentEvent {
  id: string;
  providerId: string;
  /** The provider's own event id — the replay key. */
  externalId: string;
  type: string;
  /** `received` | `processed` | `skipped` | `failed`. */
  status: string;
  recordCount: number;
  error: string | null;
  createdAt?: unknown;
  processedAt?: unknown;
}

export interface PaymentSyncResult {
  queued?: boolean;
  jobId?: string;
  provider?: string;
  written?: number;
  failed?: number;
  cursors?: Record<string, string | null>;
  error?: string;
}

export interface PaymentCollectionsResult {
  /** Slugs this call created. */
  created: string[];
  /** Slugs that already existed as sync targets. */
  existing: string[];
  /** Slugs taken by an unrelated collection — nothing is written to these
   *  until one of the two is renamed. */
  conflicts: string[];
  /** Columns added to an already-existing sync target, by slug. Empty in the
   *  steady state; populated when a workspace catches up to a new column. */
  addedFields: Record<string, string[]>;
}

/** Where the customer pays, plus the reference that ties it back. */
export interface PaymentCheckout {
  provider: string;
  providerId: string;
  /** Hosted payment page — send the customer here. */
  url: string;
  /** The provider's own id for the checkout (session id / token). */
  externalId: string;
  /** Epoch ms, or null when the provider doesn't say. */
  expiresAt: number | null;
  /**
   * Travels out with the checkout and comes back on the settlement event as
   * `payment_transactions.reference` — this is what ties the payment to the
   * row that asked for it.
   */
  reference: string;
  /** Set when `writeBack` was given: what was updated where. */
  writtenBack: { collection: string; itemId: string; fields: string[] } | null;
}

export interface PaymentCheckoutInput {
  /** Connected provider row id. Takes precedence over `provider`. */
  providerId?: string;
  /** Provider name, for callers that don't hold the connection id. */
  provider?: string;
  /** MINOR units (cents), matching `payment_transactions.amount`. */
  amount: number;
  currency: string;
  description?: string;
  /** PayTR and iyzico both require `email`; the rest sharpens fraud scoring. */
  customer?: {
    email?: string;
    name?: string;
    phone?: string;
    address?: string;
    city?: string;
    country?: string;
    identityNumber?: string;
  };
  successUrl?: string;
  cancelUrl?: string;
  /** Overrides the reference derived from `writeBack.itemId`. Non-alphanumeric
   *  characters are stripped — PayTR's order id accepts nothing else. */
  reference?: string;
  /** The PAYING customer's IP. PayTR folds it into the token hash; the server
   *  falls back to the calling request's IP. */
  customerIp?: string;
  expiresInSec?: number;
  locale?: string;
  /** Store the link on the row that is asking to be paid. Both fields must
   *  already exist on the collection. */
  writeBack?: {
    collection: string;
    itemId: string;
    urlField: string;
    referenceField?: string;
  };
}

/** What a provider gave back, and what that did to the ledger. */
export interface PaymentRefund {
  provider: string;
  providerId: string;
  /** The `payment_transactions` row that was refunded. */
  paymentRowId: string;
  /** The provider's own id for the payment. */
  externalId: string;
  /** The provider's own id for the refund. Empty when it issues none. */
  refundId: string;
  /** MINOR units actually refunded. */
  amount: number;
  currency: string;
  /**
   * `pending` means the provider accepted the refund but has not decided it —
   * Adyen resolves this in a REFUND webhook and Paddle holds live refunds for
   * human approval. Treating it as done reports money that may not move.
   */
  status: "succeeded" | "pending";
  /** Whether this took the payment's refunded total to its full amount. */
  full: boolean;
  /**
   * What was written to `payment_transactions`, or null for providers that file
   * a refund as its own transaction (Adyen, Authorize.net) — there the refund's
   * own notification writes the row, and bumping the original would be undone.
   */
  ledger: { amountRefunded: number; status: string } | null;
  /** Set when the provider said something the operator should see. */
  note?: string;
}

export interface PaymentRefundInput {
  /** Connected provider row id. Takes precedence over `provider`. */
  providerId?: string;
  provider?: string;
  /** Which payment. One of these three; tried in this order. */
  paymentRowId?: string;
  externalId?: string;
  /** The reference an outbound checkout travelled with. Refused when it matches
   *  more than one payment. */
  reference?: string;
  /** MINOR units. Omitted refunds the whole remaining balance. */
  amount?: number;
  reason?: "duplicate" | "fraudulent" | "requested_by_customer" | "other";
  description?: string;
  /** Overrides the derived key. The default is derived from the payment and the
   *  amount already refunded, so a retry dedupes and a second refund does not. */
  idempotencyKey?: string;
}

export interface PaymentCatalogEntry {
  provider: string;
  label: string;
  /**
   * `adhoc` takes an amount and mints a one-off checkout; `catalog` needs a
   * pre-existing price id and is not supported yet; `null` means the provider
   * has no hosted checkout at all.
   */
  checkoutMode: "adhoc" | "catalog" | null;
  /**
   * How much of a payment this provider will give back. `full_only` is Paddle,
   * whose partial refunds adjust individual line items backlex does not store.
   */
  refundSupport?: "full_and_partial" | "full_only" | null;
  fields: {
    key: string;
    label: string;
    placeholder?: string;
    secret?: boolean;
    optional?: boolean;
    /** Finite value set — render a select rather than a text input. */
    choices?: string[];
    hint?: string;
  }[];
}

/**
 * Payment providers (admin-scoped). Mirrors `/api/admin/payments`.
 *
 * Connecting a provider provisions four collections — `payment_customers`,
 * `payment_subscriptions`, `payment_invoices`, `payments` — and everything the
 * provider pushes lands there, so you query billing data with the same
 * `client.from(...)` you use for the rest of the workspace.
 */
/** One connected third-party integration, secrets masked. */
export interface Integration {
  id: string;
  kind: string;
  status: string;
  events: string[] | null;
  config: Record<string, unknown>;
  lastEventAt?: number | string | null;
  createdAt?: number | string | null;
  consecutiveFailures?: number;
  lastFailureAt?: number | string | null;
  disabledReason?: string | null;
}

/** One delivery attempt against an integration. */
export interface IntegrationDelivery {
  id: string;
  integrationId: string;
  event: string;
  /** HTTP status; 0 when the provider was misconfigured or unreachable. */
  status: number;
  ms: number;
  error: string | null;
  attempts: number;
  deliveredAt: number | string;
}

/** A provider the instance can connect, and the config fields it needs. */
export interface IntegrationProvider {
  id: string;
  label: string;
  category: string;
  capabilities: string[];
  fields: {
    key: string;
    label: string;
    placeholder?: string;
    secret?: boolean;
    /** A closed set — the server refuses anything outside it. */
    options?: { value: string; label: string }[];
  }[];
  /** Connected by redirect rather than by pasting a key — use `oauthAuthorize`. */
  oauth: boolean;
}

/** A scheduled sync between an integration and a collection, either way. */
export interface IntegrationSync {
  id: string;
  integrationId: string;
  collection: string;
  /** `pull` brings rows in; `push` mirrors the collection out. */
  direction: "pull" | "push";
  /** Which spreadsheet / base / database. Non-secret by contract. */
  settings: Record<string, unknown>;
  /** External field name → collection field name. */
  mapping: Record<string, string>;
  /** 0 = manual only. */
  intervalMinutes: number;
  enabled: boolean;
  /** A run is part-way through more pages. The token itself is not exposed. */
  resuming: boolean;
  lastRunAt: number | string | null;
  lastRowCount: number;
  lastError: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
  createdAt: number | string | null;
}

export interface IntegrationSyncInput {
  integrationId: string;
  /** Managed collection slug. Adopted tables are refused. */
  collection: string;
  /**
   * Which way the rows travel. Defaults to `pull`.
   *
   * The provider has to declare the capability: a source-only provider cannot
   * be a `push` target and vice versa, and the mapping is read in the direction
   * of travel — external → field on a pull, field → external on a push.
   */
  direction?: "pull" | "push";
  settings?: Record<string, unknown>;
  /** At least one entry; every target must be a writable field. */
  mapping: Record<string, string>;
  intervalMinutes?: number;
  enabled?: boolean;
}

export interface IntegrationsClient {
  /** Providers available to connect, with their config field schema. */
  catalog: () => Promise<{
    data: {
      kinds: string[];
      providers: IntegrationProvider[];
      /** Register this exact URI with each OAuth provider. Server-derived, so
       *  it stays right behind a proxy where the browser's origin would not. */
      oauthRedirectUri: string;
    };
  }>;
  /** Connected integrations in the active workspace (secrets masked). */
  list: () => Promise<{ data: Integration[] }>;
  /** Connect or reconfigure one provider. Secret config is encrypted at rest. */
  connect: (input: {
    kind: string;
    config?: Record<string, unknown>;
    events?: string[] | null;
  }) => Promise<{ data: Integration }>;
  /** Disconnect by id; the delivery log goes with it. */
  disconnect: (id: string) => Promise<{ ok: boolean }>;
  /** Recent delivery attempts, newest first. */
  deliveries: (id: string, opts?: { limit?: number }) => Promise<{ data: IntegrationDelivery[] }>;
  /** Clear the failure counter and re-enable a breaker-paused integration. */
  resume: (id: string) => Promise<{ data: Integration }>;
  /**
   * Begin an OAuth connect flow and get the provider URL to open.
   *
   * Save `clientId` + `clientSecret` via `connect` first. The returned link is
   * single-use, expires in 10 minutes, and only completes in a browser signed
   * in as the same admin — so this returns the URL rather than following it.
   */
  oauthAuthorize: (id: string) => Promise<{ data: { url: string } }>;
  /** Scheduled pulls, optionally filtered to one connection. */
  syncs: (opts?: { integrationId?: string }) => Promise<{ data: IntegrationSync[] }>;
  /** Create a scheduled pull into a collection. */
  createSync: (input: IntegrationSyncInput) => Promise<{ data: IntegrationSync }>;
  /** Patch a sync. Changing `settings` resets the resume cursor. */
  updateSync: (
    id: string,
    patch: Partial<Omit<IntegrationSyncInput, "integrationId" | "collection">>,
  ) => Promise<{ data: IntegrationSync }>;
  deleteSync: (id: string) => Promise<{ ok: boolean }>;
  /**
   * Run one sync now and report what landed. Bounded to 20 pages / 2000 rows;
   * a longer import resumes on the schedule.
   */
  runSync: (id: string) => Promise<{ data: { written: number; pages: number; complete: boolean } }>;
}

/** A blocking hook: runs before a write and decides whether it happens. */
export interface SyncHook {
  id: string;
  name: string;
  url: string;
  events: string[];
  headers: Record<string, string> | null;
  timeoutMs: number;
  /** `deny` blocks the write when the hook cannot answer; `allow` lets it through. */
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
  /** `<collection>.beforeCreate|beforeUpdate|beforeDelete`, `<collection>.*`, `*.<phase>`, `*`. */
  events: string[];
  /** Required — there is no safe default. `allow` drops the guarantee the hook
   *  provides; `deny` turns the hook's outage into your callers'. */
  onError: "allow" | "deny";
  secret?: string;
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

export interface SyncHooksClient {
  list: () => Promise<{ data: SyncHook[] }>;
  create: (input: SyncHookInput) => Promise<{ data: SyncHook }>;
  /** Omit `secret` to keep the stored one — it cannot be read back. */
  update: (id: string, patch: Partial<SyncHookInput>) => Promise<{ data: SyncHook }>;
  delete: (id: string) => Promise<{ ok: boolean }>;
  /** One synthetic call; says whether a hook rejects deliberately or is down. */
  test: (id: string) => Promise<SyncHookTestResult>;
}

export interface PaymentsClient {
  /** Supported providers and the config fields each one needs. */
  catalog(): Promise<{ providers: PaymentCatalogEntry[]; recordKinds: string[] }>;
  /** Connected providers plus a count of deliveries per status. */
  list(): Promise<{ data: PaymentProviderConnection[]; stats: Record<string, number> }>;
  /** Connect or reconfigure a provider; also provisions the sync collections. */
  connect(
    input: PaymentProviderInput,
  ): Promise<{ data: PaymentProviderConnection; collections: PaymentCollectionsResult }>;
  /** Disconnect. Synced rows are kept — that data is the workspace's. */
  disconnect(id: string): Promise<{ ok: boolean }>;
  /** Issue a fresh receive URL and invalidate the previous one. */
  rotateToken(id: string): Promise<{ data: PaymentProviderConnection }>;
  /** Pull objects back from the provider API and upsert them. */
  sync(
    id: string,
    opts?: { kinds?: string[]; maxPages?: number; resume?: boolean; async?: boolean },
  ): Promise<PaymentSyncResult>;
  /**
   * Open a hosted checkout and get a link to send the customer to.
   *
   * The outbound half of payments. `writeBack` stores the URL on the row that
   * is asking to be paid; the `reference` it travels with comes back on the
   * settlement as `payment_transactions.reference`, which is what ties the
   * money to the invoice. Amounts are MINOR units, matching the ledger.
   *
   * Stripe, Adyen, Authorize.net, PayTR, iyzico, Klarna and the test `dummy`
   * provider take an ad-hoc amount. Polar, Lemon Squeezy and Paddle need a pre-made
   * price and are refused with a `catalog_only` explanation rather than a
   * confusing failure.
   *
   * Authorize.net is the one with extra rules: its API states no currency
   * anywhere, so it charges only in the currency the connected account settles
   * in and refuses anything else, and the reference is shortened to 20
   * characters because that is all its invoice number will carry back. The
   * returned `reference` is what was actually sent — store that, not the value
   * you passed in.
   */
  checkout(input: PaymentCheckoutInput): Promise<{ data: PaymentCheckout }>;
  /**
   * Give back some or all of a payment.
   *
   * Say which payment by `paymentRowId`, `externalId` or the checkout
   * `reference`; omit `amount` to refund everything still refundable. The
   * remainder is computed from `payment_transactions` and checked BEFORE the
   * provider is called, so a refund can never take the total past what was
   * charged.
   *
   * Every provider can refund. Paddle can only refund in FULL from here — a
   * partial Paddle refund adjusts individual transaction line items, which a
   * payment row does not carry.
   *
   * Watch `status`: Adyen decides refunds asynchronously (the outcome arrives
   * as a REFUND webhook) and Paddle holds live refunds for review, so both can
   * come back `pending`. For those two `ledger` is null as well — they file a
   * refund as its own transaction, and its own notification writes the row.
   */
  refund(input: PaymentRefundInput): Promise<{ data: PaymentRefund }>;
  /** Recent webhook deliveries, newest first. */
  events(opts?: { providerId?: string; limit?: number }): Promise<{ data: PaymentEvent[] }>;
  /** (Re-)provision the four sync collections. Idempotent. */
  provisionCollections(): Promise<PaymentCollectionsResult>;
}

/** Page setup for a rendered document. Defaults: A4 portrait, 20mm margins. */
export interface PdfPageOptions {
  format?: "A4" | "Letter" | "Legal" | "A3" | "A5";
  landscape?: boolean;
  margin?: string | { top?: string; right?: string; bottom?: string; left?: string };
  /** Backgrounds print by DEFAULT here, unlike a browser's print dialog. */
  printBackground?: boolean;
}

/** A stored HTML template a document is rendered from. */
export interface DocumentTemplate {
  id: string;
  key: string;
  name: string;
  description: string | null;
  /** A COMPLETE html document, not a fragment. */
  bodyHtml: string;
  headerHtml: string | null;
  footerHtml: string | null;
  pageOptions: PdfPageOptions;
  filename: string | null;
  variables: string[];
  /** True for an instance-wide default this workspace has not overridden.
   *  Saving one creates the override rather than changing the shared row. */
  inherited: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface DocumentTemplateInput {
  name?: string;
  description?: string | null;
  bodyHtml?: string;
  headerHtml?: string | null;
  footerHtml?: string | null;
  pageOptions?: PdfPageOptions | null;
  filename?: string | null;
  variables?: string[] | null;
}

export interface RenderDocumentInput {
  /** Exactly one of these two. */
  templateKey?: string;
  html?: string;
  vars?: Record<string, unknown>;
  pageOptions?: PdfPageOptions;
  filename?: string;
}

/**
 * Document generation (admin-scoped). Mirrors `/api/admin/documents`.
 *
 * `render` resolves to the PDF BYTES. There is deliberately no renderer bundled
 * with the server, so a deployment with none configured rejects the call rather
 * than returning a document with broken glyphs — see the Documents guide.
 */
export interface DocumentsClient {
  /** List this workspace's templates; an override hides the shared default. */
  list(): Promise<{ data: DocumentTemplate[] }>;
  /** Create or update a template. Always writes a workspace-scoped row. */
  save(key: string, input: DocumentTemplateInput): Promise<{ data: DocumentTemplate }>;
  /** Delete this workspace's own row. An inherited default 404s. */
  delete(key: string): Promise<{ ok: boolean }>;
  /** Render to PDF bytes. */
  render(input: RenderDocumentInput): Promise<Uint8Array>;
}

export type SignatureStatus = "pending" | "completed" | "declined" | "voided" | "expired";
export type SignerStatus = "pending" | "viewed" | "signed" | "declined";

export interface SignatureSigner {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  order: number;
  status: SignerStatus;
  sentAt?: unknown;
  viewedAt?: unknown;
  signedAt?: unknown;
  declinedAt?: unknown;
  declineReason: string | null;
  signatureKind: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface SignatureRequest {
  id: string;
  title: string;
  message: string | null;
  templateKey: string | null;
  /** `expired` is derived from the expiry timestamp rather than stored, so it
   *  becomes true by the clock alone. */
  status: SignatureStatus;
  ordered: boolean;
  /** SHA-256 of the frozen document SOURCE, not of the PDF bytes. */
  documentHash: string;
  documentKey: string | null;
  signedDocumentKey: string | null;
  signedDocumentHash: string | null;
  filename: string | null;
  expiresAt?: unknown;
  completedAt?: unknown;
  voidedAt?: unknown;
  voidReason: string | null;
  writeBack: { collection: string; id: string; field: string } | null;
  notifyEmails: string[];
  createdBy: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  signers: SignatureSigner[];
  /** Only on the single-request read: the document as it was frozen. */
  bodyHtml?: string;
}

export interface SignatureSignerInput {
  email: string;
  name?: string | null;
  role?: string | null;
}

export interface CreateSignatureRequestInput {
  title?: string;
  message?: string | null;
  /** Exactly one of these two. */
  templateKey?: string;
  html?: string;
  vars?: Record<string, unknown>;
  pageOptions?: PdfPageOptions;
  filename?: string;
  signers: SignatureSignerInput[];
  /** Each link only opens once the one before it has signed. */
  ordered?: boolean;
  expiresInDays?: number;
  /** Where the SIGNED document's storage key lands once everyone signs. */
  writeBack?: { collection: string; id: string; field: string } | null;
  notifyEmails?: string[];
  /** Off returns the links without emailing them. */
  send?: boolean;
}

/**
 * E-signature (admin-scoped). Mirrors `/api/admin/signatures`.
 *
 * `create` returns the plaintext signing links **once** — only their hashes are
 * stored, so nothing can reproduce them afterwards. `void` and `resend` both
 * mint a new token, which is what makes a link that went astray stop working.
 */
export interface SignaturesClient {
  list(opts?: { status?: SignatureStatus; limit?: number; offset?: number }): Promise<{
    data: SignatureRequest[];
    total: number;
  }>;
  /** Includes the frozen document HTML. */
  get(id: string): Promise<{ data: SignatureRequest }>;
  /** Freeze a document and send it out. The links come back here and nowhere
   *  else. */
  create(input: CreateSignatureRequestInput): Promise<{
    data: {
      request: SignatureRequest;
      links: Array<{ signerId: string; email: string; url: string }>;
      sent: boolean;
    };
  }>;
  /** Cancel, invalidating every outstanding link. */
  void(id: string, reason?: string | null): Promise<{ data: SignatureRequest }>;
  /** Re-send one signer's invitation with a FRESH link. */
  resend(id: string, signerId: string): Promise<{ data: { sent: boolean; email: string } }>;
  /** Produce the signed copy for a request everybody already signed — the
   *  recovery for a renderer that was down when the last signature landed. */
  finalize(id: string): Promise<{ data: SignatureRequest }>;
  /** The stored PDF: the signed copy by default, what was sent with
   *  `"original"`. */
  document(id: string, which?: "original" | "signed"): Promise<Uint8Array>;
}

/* ── Approvals (#36) ───────────────────────────────────────────────────── */

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";
export type ApproverStatus = "pending" | "viewed" | "approved" | "rejected";
/** `all` — everyone must approve, and one rejection ends it. `any` — the first
 *  approval wins, and it only rejects when everybody has. `quorum` — N
 *  approvals, rejected as soon as N can no longer be reached. */
export type ApprovalPolicy = "all" | "any" | "quorum";

export interface Approver {
  id: string;
  email: string;
  name: string | null;
  /** The capacity they decide in — "Line manager", "Finance". */
  role: string | null;
  order: number;
  status: ApproverStatus;
  sentAt?: unknown;
  viewedAt?: unknown;
  decidedAt?: unknown;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** What the outcome writes onto the subject row. `collection`/`id` default to
 *  the request's subject. An EXPIRY writes `rejectedValue`: to everything
 *  downstream, a request nobody answered is a request that was not approved. */
export interface ApprovalWriteBack {
  collection?: string;
  id?: string;
  field: string;
  approvedValue?: unknown;
  rejectedValue?: unknown;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  message: string | null;
  /** The row the decision is about. */
  subject: { collection: string; id: string } | null;
  /** What the approvers were shown, frozen at send time. */
  summary: Array<{ label: string; value: string }>;
  policy: ApprovalPolicy;
  quorum: number;
  ordered: boolean;
  status: ApprovalStatus;
  expiresAt?: unknown;
  settledAt?: unknown;
  outcomeReason: string | null;
  writeBack: ApprovalWriteBack | null;
  createdBy: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  approvers: Approver[];
}

export interface ApproverInput {
  email: string;
  name?: string | null;
  role?: string | null;
}

export interface CreateApprovalRequestInput {
  title: string;
  message?: string | null;
  approvers: ApproverInput[];
  policy?: ApprovalPolicy;
  /** Only read with `policy: "quorum"`, where it is required. */
  quorum?: number;
  /** Each link only opens once the one before it has decided. */
  ordered?: boolean;
  /** Default 72. On expiry the request REJECTS. */
  expiresInHours?: number;
  subject?: { collection: string; id: string } | null;
  summary?: Array<{ label: string; value: string }>;
  writeBack?: ApprovalWriteBack | null;
  notifyEmails?: string[];
  /** Off returns the links without emailing them. */
  send?: boolean;
}

/**
 * Approvals (admin-scoped). Mirrors `/api/admin/approvals`.
 *
 * `create` returns the plaintext decision links **once** — only their hashes
 * are stored, so nothing can reproduce them afterwards.
 *
 * There is deliberately no `decide` here: deciding is the approver's act,
 * authenticated by their link token and nothing else. An admin-authenticated
 * decision would also fire whatever the waiting flow does next.
 */
export interface ApprovalsClient {
  list(opts?: { status?: ApprovalStatus; limit?: number }): Promise<{ data: ApprovalRequest[] }>;
  /** The full decision trail — who was asked, who answered, when and why. */
  get(id: string): Promise<{ data: ApprovalRequest }>;
  /** Ask people to approve something. The links come back here and nowhere
   *  else. */
  create(input: CreateApprovalRequestInput): Promise<{
    data: {
      request: ApprovalRequest;
      links: Array<{ approverId: string; email: string; url: string }>;
      sent: boolean;
    };
  }>;
  /** Withdraw it, invalidating every outstanding link. Runs NEITHER flow
   *  branch. */
  cancel(id: string, reason?: string | null): Promise<{ data: ApprovalRequest }>;
}

/* ── Availability & booking (#32) ──────────────────────────────────────── */

export type BookingStatus =
  | "held"
  | "confirmed"
  | "cancelled"
  | "no_show"
  | "completed"
  | "expired";

/** One line of an opening pattern, or one exception to it. Minutes are counted
 *  from LOCAL midnight in the resource's own zone; a span crossing midnight is
 *  two rules. */
export interface BookingRule {
  id?: string;
  kind?: "open" | "block";
  /** 0 = Sunday … 6 = Saturday, or null for every day in the date range. */
  weekday?: number | null;
  startMinute: number;
  endMinute: number;
  /** `YYYY-MM-DD`, inclusive. */
  startsOn?: string | null;
  endsOn?: string | null;
  reason?: string | null;
}

export interface BookingResource {
  id: string;
  key: string;
  name: string;
  description: string | null;
  timeZone: string;
  slotMinutes: number;
  stepMinutes: number | null;
  capacity: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  leadMinutes: number;
  horizonDays: number;
  holdMinutes: number;
  questions: Array<Record<string, unknown>>;
  mirrorCollection: string | null;
  mirrorFieldMap: Record<string, string> | null;
  active: boolean;
  confirmationMessage: string | null;
  notifyEmails: string[];
  rules: BookingRule[];
}

export interface BookingResourceInput {
  key?: string;
  name?: string;
  description?: string | null;
  /** IANA zone the rules are written in. */
  timeZone?: string;
  slotMinutes?: number;
  stepMinutes?: number | null;
  capacity?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  leadMinutes?: number;
  horizonDays?: number;
  holdMinutes?: number;
  questions?: Array<Record<string, unknown>>;
  mirrorCollection?: string | null;
  mirrorFieldMap?: Record<string, string> | null;
  active?: boolean;
  confirmationMessage?: string | null;
  notifyEmails?: string[];
  /** REPLACES the whole rule set — opening hours are edited as one thing. */
  rules?: BookingRule[];
}

export interface Booking {
  id: string;
  resourceId: string;
  /** ISO instants. Render them in the resource's `timeZone`. */
  start: string;
  end: string;
  /** Includes the DERIVED `completed` / `expired`. */
  status: BookingStatus;
  /** The raw column, for telling a stored `cancelled` from a derived one. */
  storedStatus: string;
  holdExpiresAt: number | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  answers: Record<string, unknown>;
  notes: string | null;
  mirrorCollection: string | null;
  mirrorItemId: string | null;
  source: string;
  cancelledAt: number | null;
  cancelReason: string | null;
  rescheduledToId: string | null;
}

export interface BookingSlot {
  start: string;
  end: string;
  /** Capacity left at that instant. Never 0 — a full slot is not returned. */
  remaining: number;
}

export interface CreateBookingInput {
  start: string | number;
  end?: string | number;
  name?: string;
  email?: string;
  phone?: string;
  answers?: Record<string, unknown>;
  notes?: string;
  /** Park the slot instead of confirming it — what a deposit is taken during. */
  hold?: boolean;
}

export interface BookingResult {
  booking: Booking;
  /** Returned ONCE. Only its hash is stored. */
  manageToken: string;
  manageUrl: string;
  emailed: boolean;
}

/**
 * Availability & booking (admin-scoped). Mirrors `/api/admin/booking`.
 *
 * The operator's side. A booking made here is NOT restricted to the published
 * grid — that is the difference between taking a call and offering a calendar —
 * but the capacity guarantee applies to both. The booker's own side needs no
 * credentials at all and lives under `/api/public/book/<token>`.
 */
export interface BookingClient {
  /** Every bookable resource, each with its full rule set. */
  listResources(): Promise<{ data: BookingResource[] }>;
  /** One resource, by key or id. */
  getResource(key: string): Promise<{ data: BookingResource }>;
  /** Create one. The public page token comes back HERE and nowhere else. */
  createResource(
    input: BookingResourceInput & { key: string; name: string },
  ): Promise<{ data: { resource: BookingResource; token: string; url: string } }>;
  updateResource(key: string, patch: BookingResourceInput): Promise<{ data: BookingResource }>;
  /** Refuses while upcoming bookings reference it unless `force`. */
  deleteResource(key: string, opts?: { force?: boolean }): Promise<{ data: { ok: boolean } }>;
  /** Mint a new page token, invalidating the old URL. Manage links survive. */
  rotateToken(key: string): Promise<{ data: { token: string; url: string } }>;
  /** The open slots, computed from the rules, the exceptions and what is taken. */
  slots(
    key: string,
    window?: { from?: string; to?: string },
  ): Promise<{ data: { resource: Record<string, unknown>; from: string; to: string; slots: BookingSlot[] } }>;
  listBookings(opts?: {
    resource?: string;
    status?: BookingStatus;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ data: Booking[]; total: number }>;
  getBooking(id: string): Promise<{ data: Booking }>;
  /** Book as an operator — off-grid times allowed. */
  book(resource: string, input: CreateBookingInput): Promise<{ data: BookingResult }>;
  /** Promote a hold. A hold that already lapsed answers 409. */
  confirm(id: string): Promise<{ data: Booking }>;
  /** Idempotent. `notify:false` spares the customer the email. */
  cancel(id: string, opts?: { reason?: string; notify?: boolean }): Promise<{ data: Booking }>;
  /** Cancel-then-book, through the same guard. Returns a NEW manage link. */
  reschedule(id: string, start: string | number): Promise<{ data: BookingResult }>;
  /** Distinct from a cancellation: the time was held and spent. */
  noShow(id: string): Promise<{ data: Booking }>;
}

/** Visual workflows (admin-scoped). Mirrors `/api/flows`. See `createClient`. */
export interface FlowsClient {
  /** List every flow in the active workspace. */
  list(): Promise<{ data: Flow[] }>;
  /** Fetch a single flow's full definition by id. */
  get(id: string): Promise<{ data: Flow }>;
  /** Create a flow scoped to the active workspace. */
  create(input: FlowInput): Promise<{ data: Flow }>;
  /** Partial update of a flow by id. */
  update(id: string, patch: Partial<FlowInput>): Promise<{ ok: boolean }>;
  /** Delete a flow by id. */
  delete(id: string): Promise<{ ok: boolean }>;
  /** Synchronously run a flow with an arbitrary `input` trigger payload. */
  run(id: string, input?: Record<string, unknown>): Promise<FlowRunResult>;
}

/** Embedded BI dashboards (admin-scoped). Mirrors `/api/admin/dashboards`. */
export interface DashboardsClient {
  /** List every dashboard in the active workspace. */
  list(): Promise<{ data: Dashboard[] }>;
  /** Fetch a single dashboard by id. */
  get(id: string): Promise<{ data: Dashboard }>;
  /** Create a dashboard scoped to the active workspace. */
  create(input: DashboardInput): Promise<{ data: Dashboard }>;
  /** Partial update of a dashboard by id. */
  update(id: string, patch: Partial<DashboardInput>): Promise<{ ok: boolean }>;
  /** Delete a dashboard by id (panels are un-grouped, not deleted). */
  delete(id: string): Promise<{ ok: boolean }>;
  /** Run every panel and return their results. */
  run(id: string): Promise<{ data: DashboardPanelResult[]; ms: number }>;
  /** Enable the public embed; mints a one-time token (optionally role-scoped). */
  share(id: string, opts?: { roleId?: string | null }): Promise<DashboardShareResult>;
  /** Disable the public embed and forget the token. */
  revoke(id: string): Promise<{ ok: boolean }>;
  /**
   * Print the dashboard to a PDF and store it; with `email`, mail it too.
   *
   * The stored key comes back either way, so a caller that wants to send the
   * file itself can. Rejects when no PDF renderer is configured — there is no
   * fallback renderer, by design.
   */
  report(id: string, input?: DashboardReportInput): Promise<DashboardReport>;
  /** The same render, returning the PDF bytes instead of the metadata. Cannot
   *  be combined with `email` — a request that asked for both has one of the
   *  two intents wrong, and the server says so. */
  reportPdf(id: string, input?: Omit<DashboardReportInput, "email">): Promise<Uint8Array>;
}

export interface DashboardReportInput {
  /** Defaults to `<dashboard-name>-<date>.pdf`. */
  filename?: string;
  pageOptions?: {
    format?: "A4" | "Letter" | "Legal" | "A3" | "A5";
    landscape?: boolean;
    printBackground?: boolean;
  };
  /** Omit to render + store only. */
  email?: { to: string; subject?: string; templateKey?: string };
}

export interface DashboardReport {
  /** Storage key of the stored PDF. */
  key: string;
  filename: string;
  size: number;
  /** Which renderer produced it, for diagnostics. */
  renderer: string;
  dashboard: { id: string; name: string };
  panels: number;
  /** Panels that failed. The PDF prints their error rather than dropping them. */
  failedPanels: number;
  sentTo: string[];
  /** The covering mail went, WITHOUT the report — the configured transport
   *  cannot carry attachments. */
  attachmentsDropped?: boolean;
}

/* ── Product analytics + crash reporting (#22) ─────────────────────────── */

/** One tracked product event. `distinctId` defaults to the SDK's stable
 *  anonymous visitor id, so callers usually pass only a name and props. */
export interface TrackedEvent {
  name: string;
  distinctId?: string;
  userId?: string | null;
  sessionId?: string | null;
  props?: Record<string, unknown> | null;
  path?: string | null;
  referrer?: string | null;
  source?: string | null;
  release?: string | null;
  country?: string | null;
  /** Epoch ms. Defaults to now; the server clamps to −7d / +5min. */
  ts?: number;
}

/** One error occurrence to report. */
export interface TrackedError {
  message: string;
  type?: string | null;
  stack?: string | null;
  level?: "error" | "warning" | "fatal" | null;
  platform?: string | null;
  release?: string | null;
  url?: string | null;
  userId?: string | null;
  distinctId?: string | null;
  sessionId?: string | null;
  context?: Record<string, unknown> | null;
  ts?: number;
}

export interface AnalyticsIngestResult {
  accepted: number;
  /** Rows the server dropped as malformed, rather than failing the batch. */
  rejected: number;
}

export interface AnalyticsOverview {
  totals: { events: number; users: number; sessions: number };
  series: { day: string; events: number; users: number }[];
  topEvents: { name: string; count: number; users: number }[];
  topPaths: { path: string; count: number }[];
  topReferrers: { referrer: string; count: number }[];
  sources: { source: string; count: number }[];
}

export interface AnalyticsFunnelResult {
  windowDays: number;
  steps: { name: string; count: number; conversion: number; dropOff: number }[];
}

export interface AnalyticsRetentionResult {
  maxOffset: number;
  cohorts: { day: string; size: number; values: number[] }[];
}

export interface AnalyticsEventRow {
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

export interface ErrorGroup {
  id: string;
  fingerprint: string;
  type: string;
  message: string;
  culprit: string | null;
  level: string;
  platform: string | null;
  release: string | null;
  status: "open" | "resolved" | "ignored" | string;
  events: number;
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

export interface ErrorOccurrence {
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

export interface ErrorGroupDetail {
  group: ErrorGroup;
  occurrences: ErrorOccurrence[];
  series: { day: string; count: number }[];
  users: number;
}

/** Inclusive epoch-ms reporting window. Defaults to the last 30 days. */
export interface AnalyticsRange {
  from?: number;
  to?: number;
}

/**
 * Product analytics + crash reporting. The two `track*` methods are the
 * append-only ingest side (usable from a browser with a publishable
 * `ingestKey`); everything else is admin-scoped reporting.
 */
export interface AnalyticsClient {
  /** The stable anonymous visitor id this client stamps on events that omit
   *  one. Persisted in `localStorage` in a browser, in memory elsewhere. */
  distinctId(): string;
  /** Pin the visitor id — call after sign-in to tie a known user to the
   *  anonymous history already recorded under the generated id. */
  identify(distinctId: string, opts?: { userId?: string | null }): void;
  /** Track one event. */
  track(
    name: string,
    props?: Record<string, unknown> | null,
    extra?: Omit<TrackedEvent, "name" | "props">,
  ): Promise<AnalyticsIngestResult>;
  /** Track many events in one request (offline queues, batching). */
  trackBatch(events: TrackedEvent[]): Promise<AnalyticsIngestResult>;
  /** Report one error. Accepts a real `Error` (message/stack/type are read off
   *  it) or an explicit payload. */
  trackError(
    error: Error | TrackedError,
    extra?: Partial<TrackedError>,
  ): Promise<AnalyticsIngestResult & { groups: string[] }>;
  /** Report many errors in one request. */
  trackErrorBatch(
    errors: TrackedError[],
  ): Promise<AnalyticsIngestResult & { groups: string[] }>;
  /**
   * Browser only: forward uncaught errors and unhandled promise rejections to
   * `trackError` automatically. Returns a function that removes the listeners.
   * A no-op returning a no-op outside a browser.
   */
  captureErrors(opts?: { release?: string; platform?: string }): () => void;
  /** Headline counters, daily series and top-N breakdowns (admin). */
  overview(range?: AnalyticsRange): Promise<{ data: AnalyticsOverview }>;
  /** Distinct event names ordered by volume (admin). */
  eventNames(): Promise<{ data: string[] }>;
  /** Ordered conversion funnel (admin). */
  funnel(
    input: AnalyticsRange & { steps: string[]; windowDays?: number },
  ): Promise<{ data: AnalyticsFunnelResult }>;
  /** Cohort retention grid (admin). */
  retention(
    input?: AnalyticsRange & { event?: string | null },
  ): Promise<{ data: AnalyticsRetentionResult }>;
  /** Raw recent events — the debug view behind the aggregates (admin). */
  events(
    query?: AnalyticsRange & { name?: string; distinctId?: string; limit?: number },
  ): Promise<{ data: AnalyticsEventRow[] }>;
  /** Crash-report triage (admin). */
  errors: {
    list(query?: {
      status?: "open" | "resolved" | "ignored";
      level?: "error" | "warning" | "fatal";
      since?: number;
      limit?: number;
    }): Promise<{ data: ErrorGroup[] }>;
    get(id: string): Promise<{ data: ErrorGroupDetail }>;
    update(
      id: string,
      patch: { status: "open" | "resolved" | "ignored" },
    ): Promise<{ data: ErrorGroup }>;
    delete(id: string): Promise<{ ok: boolean }>;
  };
  /** Publishable ingest-key management (admin). */
  ingestKey: {
    /** Whether a key exists. The plaintext is never recoverable. */
    status(): Promise<{ data: { exists: boolean } }>;
    /** Mint a fresh key, invalidating any previous one. Shown once. */
    mint(): Promise<{ data: { key: string } }>;
    revoke(): Promise<{ ok: boolean }>;
  };
}

export interface FormsClient {
  /** List every public form in the active workspace. */
  list(): Promise<{ data: PublicForm[] }>;
  /** Fetch a single form by id. */
  get(id: string): Promise<{ data: PublicForm }>;
  /** A collection's form-eligible fields (scalar, non-private, non-computed). */
  eligibleFields(collection: string): Promise<{ data: PublicFormEligibleField[] }>;
  /** Create a form; returns the one-time plaintext token + public URLs. */
  create(input: PublicFormInput): Promise<{ data: { form: PublicForm } & PublicFormToken }>;
  /** Partial update of a form by id. */
  update(id: string, patch: Partial<PublicFormInput>): Promise<{ data: PublicForm }>;
  /** Replace the public token — the old link dies immediately. */
  rotateToken(id: string): Promise<{ data: PublicFormToken }>;
  /** Delete a form; its link stops working immediately. */
  delete(id: string): Promise<{ ok: boolean }>;
}

/** Workspace usage-limit knobs. `null` = unlimited for that dimension. */
export interface UsageLimits {
  mode: "off" | "soft" | "hard";
  maxRequestsPerMonth: number | null;
  maxStorageBytes: number | null;
  maxDbRows: number | null;
}

/** Admin usage overview — mirrors `GET /api/admin/usage/overview`. */
export interface UsageOverview {
  /** Current UTC month, `YYYY-MM`. */
  month: string;
  days: number;
  series: { day: string; requests: number; errors: number }[];
  /** Per-key day points (only days with traffic). `apiKeyId: ""` = sessions. */
  keySeries: { day: string; apiKeyId: string; requests: number; errors: number }[];
  monthTotals: { requests: number; errors: number };
  byKey: {
    /** API key id; empty string = the session / no-key traffic bucket. */
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
  /** Effective limits — `USAGE_LIMIT_*` env overrides already applied. */
  limits: UsageLimits;
  /** The admin-editable setting values, before env overrides. */
  settingsLimits: UsageLimits;
  /** Limit fields pinned by env (read-only — the platform plan wins). */
  envPinned: ("mode" | "maxRequestsPerMonth" | "maxStorageBytes" | "maxDbRows")[];
  /** Dimensions currently over their effective limit. */
  over: ("requests" | "storage" | "rows")[];
}

/** One raw ledger row from `GET /api/admin/usage/export`. */
export interface UsageExportRow {
  day: string;
  /** API key id; empty string = the session / no-key traffic bucket. */
  apiKeyId: string;
  keyName: string;
  keyPrefix: string | null;
  requests: number;
  errors: number;
  storageBytes: number | null;
  dbRows: number | null;
}

export interface UsageExport {
  from: string;
  to: string;
  rows: UsageExportRow[];
}

export interface UsageClient {
  /** Usage overview: day series, per-key month totals, gauges, limits. */
  overview(opts?: { days?: number }): Promise<{ data: UsageOverview }>;
  /** Raw ledger export for billing reconciliation — one row per (day, key).
   *  Defaults to the current UTC month-to-date. */
  export(opts?: { from?: string; to?: string }): Promise<{ data: UsageExport }>;
  /** Persist the workspace's admin-editable usage limits. */
  setLimits(limits: UsageLimits): Promise<{ ok: boolean }>;
}

/** A remediation the advisor can carry out itself. Present on findings that a
 *  single server-built DDL statement fixes. */
export interface AdvisorAction {
  type: "create-index";
  table: string;
  indexName: string;
  columns: string[];
  /** The exact statement `advisor.apply` will run. Informational — the server
   *  re-derives it and never accepts one from the client. */
  sql: string;
}

/** Observed numbers behind a traffic-derived finding. Its presence is what
 *  marks a finding as measured rather than inferred from the schema. */
export interface AdvisorEvidence {
  /** Requests observed in the window — spans seen, never extrapolated. */
  requests: number;
  windowDays: number;
  p95?: number;
  errorRate?: number;
  /** Share of the collection's list traffic touching the column, 0..1. */
  share?: number;
}

export interface AdvisorCheck {
  id: string;
  kind: "security" | "performance";
  level: "error" | "warn" | "info";
  rule: string;
  groupTitle: string;
  title: string;
  body: string;
  fix: string;
  resource: string;
  link?: string;
  action?: AdvisorAction;
  evidence?: AdvisorEvidence;
}

export interface AdvisorResult {
  data: AdvisorCheck[];
  /** 0–100 health score, server-computed over every finding. */
  score: number;
  generatedAt: string;
  /** What the traffic-derived rules had to work with. `spanCount: 0` means no
   *  runtime rule could fire — which is not the same as "no problems". */
  runtime: {
    windowDays: number;
    spanCount: number;
    sampleRate: number;
    truncated: boolean;
  };
}

/** One endpoint's latency + error profile over the insights window. */
export interface AdvisorEndpointStat {
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

export interface AdvisorColumnUse {
  column: string;
  requests: number;
  /** Share of the collection's list requests touching this column, 0..1. */
  share: number;
}

export interface AdvisorCollectionStat {
  collection: string;
  listRequests: number;
  p50: number;
  p95: number;
  filters: AdvisorColumnUse[];
  sorts: AdvisorColumnUse[];
}

export interface AdvisorInsights {
  /** Slowest first (p95 desc, ties broken by traffic). */
  endpoints: AdvisorEndpointStat[];
  /** Busiest first. */
  collections: AdvisorCollectionStat[];
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

export interface AdvisorClient {
  /** Run the advisor: findings + score + the runtime window behind the
   *  traffic-derived rules. */
  run(opts?: { days?: number }): Promise<AdvisorResult>;
  /** Runtime query insights aggregated from recorded request spans. */
  insights(opts?: { days?: number; limit?: number }): Promise<AdvisorInsights>;
  /** Apply a finding's `action`. Takes only the finding id — the server
   *  re-runs the advisor and executes the statement that fresh finding
   *  carries, so a stale finding can never be applied. */
  apply(
    id: string,
    opts?: { days?: number },
  ): Promise<{ ok: true; applied: AdvisorAction }>;
}

/** Validated `backlex-extension.json` of an installed extension. */
export interface ExtensionManifest {
  name: string;
  version: string;
  title: string;
  description?: string;
  contributes: {
    panels?: { id: string; title: string; icon?: string; entry: string }[];
    fieldEditors?: {
      interface: string;
      title: string;
      types?: string[];
      entry: string;
    }[];
    hooks?: {
      id: string;
      trigger: "event" | "manual";
      pattern?: string;
      entry: string;
      timeoutMs?: number;
    }[];
  };
  permissions?: { api?: string[] };
}

/** One installed extension row. */
export interface Extension {
  id: string;
  name: string;
  version: string;
  source: "npm" | "upload" | string;
  npmPackage: string | null;
  manifest: ExtensionManifest;
  enabled: boolean;
}

/** Result of running an extension hook in the functions sandbox. */
export interface ExtensionInvokeResult {
  ok: boolean;
  logs: unknown[];
  error?: string;
  durationMs: number;
  value?: unknown;
}

/** Extension system (admin-scoped). Mirrors `/api/extensions`. */
export interface ExtensionsClient {
  /** List every installed extension in the active workspace. */
  list(): Promise<{ data: Extension[] }>;
  /** Enabled extensions only — what the admin SPA mounts. Any signed-in user. */
  enabled(): Promise<{ data: Extension[] }>;
  /** Install (or upgrade) an extension from the npm registry. */
  install(pkg: string, version?: string): Promise<{ data: Extension }>;
  /** Install from a `path → content` file map (local development). */
  upload(files: Record<string, string>): Promise<{ data: Extension }>;
  /** Enable or disable an installed extension. */
  setEnabled(name: string, enabled: boolean): Promise<{ data: Extension }>;
  /** Uninstall an extension and delete its stored assets. */
  uninstall(name: string): Promise<{ ok: boolean }>;
  /** Run one of the extension's hooks with an arbitrary input payload. */
  invokeHook(
    name: string,
    hookId: string,
    input?: Record<string, unknown>,
  ): Promise<ExtensionInvokeResult>;
}

/** One backup tracking row. `status` moves queued → running → done/failed. */
export interface BackupRecord {
  id: string;
  tenantId: string | null;
  /** `manual` (taken via API/UI) or `auto` (scheduled from the cron tick). */
  kind: string;
  label: string | null;
  storageKey: string;
  size: number;
  tableCount: number;
  status: string;
  createdBy: string | null;
  createdAt: unknown;
}

/** Per-workspace automatic-backup schedule. */
export interface BackupScheduleConfig {
  schedule: "off" | "daily" | "weekly";
  retain: number;
  /** Age-based retention on top of the count — auto backups older than this
   *  many days are pruned. `null` disables the age rule. */
  retainDays: number | null;
}

/** Result of an additive restore (`ON CONFLICT DO NOTHING`). */
export interface BackupRestoreResult {
  tableCount: number;
  rowCount: number;
  skipped: number;
}

/** Backup / restore (admin-scoped). Mirrors `/api/admin/db/backups*`. */
export interface BackupsClient {
  /** Backup tracking rows for the active workspace, newest first. */
  list(): Promise<{ data: BackupRecord[] }>;
  /** Run a manual backup now; resolves once the dump is done/failed. */
  run(opts?: { label?: string }): Promise<{ data: BackupRecord }>;
  /** Additively restore a backup — missing rows come back, existing rows are
   *  never overwritten or removed. Sends the confirm header for you. */
  restore(id: string): Promise<{ data: BackupRestoreResult }>;
  /** Get the automatic-backup schedule + retention count. */
  getConfig(): Promise<{ data: BackupScheduleConfig }>;
  /** Set the automatic-backup schedule and/or retention count. */
  setConfig(
    patch: Partial<BackupScheduleConfig>,
  ): Promise<{ data: BackupScheduleConfig }>;
}

/** One collection inside a schema template (preview shape). */
export interface TemplateCollectionSummary {
  slug: string;
  label: string;
  fieldCount: number;
  /** Admin group this collection lands under on apply (null = ungrouped). */
  group: string | null;
}

/** A schema-template catalog entry — a ready-made vertical collection set. */
export interface TemplateSummary {
  id: string;
  label: string;
  description: string;
  category: string;
  recommended: boolean;
  /** Total example rows seeded on apply across the template's collections. */
  sampleRows: number;
  /** Admin group headers seeded by this template, in order. */
  groups: string[];
  /** Bundled role names seeded on apply. */
  roles: string[];
  /** Bundled insights-dashboard names seeded on apply. */
  dashboards: string[];
  collections: TemplateCollectionSummary[];
}

/** Catalog response from `GET /api/admin/templates`. */
export interface TemplateCatalog {
  data: TemplateSummary[];
  /** Cloud-preselected default (`SEED_TEMPLATE`), or `"blank"`. */
  defaultTemplateId: string;
  /** Whether the workspace already has managed collections. */
  hasCollections: boolean;
  /** Sample rows still recorded in the seed manifest — drives the
   *  "Remove sample data" affordance. */
  sampleSeeds: number;
}

/** Result of applying a template. Idempotent — `skipped` are collections that
 *  already existed; `seeded` counts sample rows inserted; `roles`/`dashboards`
 *  are bundled artifacts created by this apply. */
export interface ApplyTemplateResult {
  templateId: string;
  created: string[];
  skipped: string[];
  seeded: number;
  roles: string[];
  dashboards: string[];
}

/** Result of `templates.clearSamples()`. */
export interface ClearTemplateSamplesResult {
  /** Sample rows actually deleted. */
  removed: number;
  /** Collections that had seeded rows removed. */
  collections: string[];
}

/** A collection definition inside a custom/extracted template. */
export interface TemplateCollectionDef {
  slug: string;
  singular?: string;
  plural?: string;
  note?: string;
  /** Row-title format hint for the admin UI. */
  displayTemplate?: string;
  /** Admin icon key. */
  icon?: string;
  /** Admin accent color — preset token or `#rrggbb`. */
  color?: string;
  /** Hidden from the admin sidebar/index (presentational only). */
  hidden?: boolean;
  /** Preview-URL template with `{{field}}` placeholders. */
  previewUrl?: string;
  ownerScoped?: boolean;
  versioned?: boolean;
  vectorize?: boolean;
  /** Embedding model override. */
  vectorizeModel?: string;
  fts?: boolean;
  defaultSort?: string;
  /** Admin group header this collection lands under. */
  group?: string;
  /** Explicit position within the group (extract emits it; the array itself
   *  is dependency-ordered, not display-ordered). */
  sortOrder?: number;
  fields: Record<string, unknown>[];
  samples?: Record<string, unknown>[];
}

/** A workspace schema in template format — returned by `templates.extract()`
 *  and accepted by `templates.applyCustom()`. */
export interface ExtractedTemplate {
  label: string;
  description: string;
  /** Ordered admin group headers. */
  groups: string[];
  /** Collections in dependency order (relation targets first). */
  collections: TemplateCollectionDef[];
}

/** Workspace end-user provisioning (admin-scoped). Mirrors `/api/app-users`. */
export interface AppUsersClient {
  /** Invite an end-user: creates a pending `app_users` row (status `invited`,
   *  no credential), mints a 7-day one-shot invite token (also mailed
   *  best-effort), and optionally binds roles (`roleIds` — the admin role is
   *  rejected) and links a person row (`link` — stamps
   *  `<collection>.<itemId>.app_user_id` so `$user.id` permission conditions
   *  match after accept). The invitee completes the flow with
   *  `auth.acceptInvite({ token, password })` on an app-mode client. */
  invite(input: {
    email: string;
    name?: string;
    roleIds?: string[];
    link?: { collection: string; itemId: string };
  }): Promise<{ data: { id: string; email: string; token: string; expiresAt: number } }>;
}

/** A member's standing inside an organization. Distinct from the workspace
 *  `roles` they may also hold *within* that org. */
export type OrgRole = "owner" | "admin" | "member";

/** An app-plane organization — the B2B grouping level inside one workspace. */
export interface Org {
  id: string;
  slug: string;
  name: string;
  image: string | null;
  metadata: Record<string, unknown> | null;
  createdBy: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  /** Present on list responses. */
  memberCount?: number;
  /** Present when the listing was scoped to one end-user (app mode). */
  role?: OrgRole;
}

export interface OrgMember {
  appUserId: string;
  email: string;
  name: string | null;
  status: string;
  role: OrgRole;
  /** Workspace roles bound to this member *within this org*. */
  roles: Array<{ id: string; name: string }>;
  createdAt: number | null;
}

export interface OrgInvite {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  roleIds: string[];
  invitedBy: string | null;
  expiresAt: number;
  acceptedAt: number | null;
  createdAt: number | null;
  /** Neither accepted nor expired. */
  pending: boolean;
}

/**
 * Organizations ("teams") — the same namespace on both planes, routed by the
 * client's mode:
 *
 *  - **app mode** (`workspace` set) → `/api/t/{workspace}/orgs`. Scoped to the
 *    signed-in end-user: they see their own orgs and act with their membership
 *    role. `create`, `acceptInvite`, `setActive` and `leave` are here.
 *  - **admin mode** → `/api/app-orgs`. The workspace operator's view: every org
 *    in the workspace, plus `addMember`.
 *
 * Members are addressed by `app_users.id`. Every id argument also accepts the
 * org's slug.
 */
export interface OrgsClient {
  /** App mode: the orgs I belong to (plus `active`, the org this client is
   *  currently acting in). Admin mode: every org in the workspace. */
  list(opts?: {
    q?: string;
  }): Promise<{ data: Org[]; active?: { orgId: string | null; role: OrgRole | null } }>;
  get(idOrSlug: string): Promise<{ data: Org }>;
  /** App mode: the caller becomes the first `owner`. Admin mode: pass
   *  `ownerAppUserId` to seed one, or omit it for an empty org. */
  create(input: {
    name: string;
    slug?: string;
    image?: string | null;
    metadata?: Record<string, unknown> | null;
    ownerAppUserId?: string;
  }): Promise<{ data: Org }>;
  update(
    idOrSlug: string,
    patch: {
      name?: string;
      slug?: string;
      image?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<{ data: Org }>;
  delete(idOrSlug: string): Promise<{ ok: boolean }>;

  members(idOrSlug: string): Promise<{ data: OrgMember[] }>;
  /** Admin mode only — the app plane grows members through invitations. */
  addMember(
    idOrSlug: string,
    input: { appUserId: string; role?: OrgRole; roleIds?: string[] },
  ): Promise<{ data: OrgMember }>;
  /** Change the membership role and/or replace the member's org-scoped
   *  workspace roles. */
  updateMember(
    idOrSlug: string,
    appUserId: string,
    patch: { role?: OrgRole; roleIds?: string[] },
  ): Promise<{ data: OrgMember }>;
  removeMember(idOrSlug: string, appUserId: string): Promise<{ ok: boolean }>;

  invites(idOrSlug: string, opts?: { pending?: boolean }): Promise<{ data: OrgInvite[] }>;
  /** Mint a 7-day invitation (also mailed best-effort). The raw token comes
   *  back once, here — it is never listed again. */
  invite(
    idOrSlug: string,
    input: { email: string; role?: OrgRole; roleIds?: string[] },
  ): Promise<{
    data: { id: string; email: string; role: OrgRole; token: string; expiresAt: number };
  }>;
  revokeInvite(idOrSlug: string, inviteId: string): Promise<{ ok: boolean }>;
  /** App mode only. The signed-in account's email must match the invited one. */
  acceptInvite(token: string): Promise<{ data: { org: Org; role: OrgRole } }>;

  /** App mode only — pin this *session* to an org (`null` clears it). Only
   *  needed for multi-org end-users; a single-org one resolves automatically. */
  setActive(idOrSlug: string | null): Promise<{ data: Org | null }>;
  /** App mode only. The last owner must hand over first. */
  leave(idOrSlug: string): Promise<{ ok: boolean }>;

  /** Send `X-Backlex-Org` on every subsequent request from this client, so
   *  `$org.id` in permission rules resolves to it. Stateless alternative to
   *  {@link OrgsClient.setActive} — nothing is persisted server-side, and it
   *  works with access-JWT clients that have no session row. `null` clears. */
  use(idOrSlug: string | null): void;
  /** The org id/slug {@link OrgsClient.use} is currently sending, if any. */
  active(): string | null;
}

/** Schema templates (admin-scoped). Mirrors `/api/admin/templates`. */
export interface TemplatesClient {
  /** List the template catalog for the active workspace. */
  list(): Promise<TemplateCatalog>;
  /** Seed a template's collections (grouped, with sample data and any bundled
   *  roles/dashboards) into the active workspace. Idempotent — existing
   *  collections are skipped. */
  apply(templateId: string): Promise<{ data: ApplyTemplateResult }>;
  /** Apply a custom template (the `extract()` shape) — same idempotent
   *  semantics as `apply`. */
  applyCustom(template: ExtractedTemplate): Promise<{ data: ApplyTemplateResult }>;
  /** Delete every sample row a template apply seeded; user-created rows are
   *  never touched. */
  clearSamples(): Promise<{ data: ClearTemplateSamplesResult }>;
  /** Export the workspace's managed collections as a reusable template
   *  (schema + admin groups; no sample data). */
  extract(opts?: {
    collections?: string[];
    /** Also export the first N rows per collection (1–50) as template samples. */
    samples?: number;
  }): Promise<{ data: ExtractedTemplate }>;
}

/** A collection inside a schema snapshot — the schema-relevant subset of a
 *  collection's metadata (`/api/admin/schema`). */
export interface SchemaSnapshotCollection {
  slug: string;
  fields: { name: string; type: string; [k: string]: unknown }[];
  [k: string]: unknown;
}

/** One categorized change produced by a schema diff. `severity` decides how it
 *  can be applied: `additive` auto-applies, `destructive` needs confirmation,
 *  `metadata` carries no DDL or data risk. */
export interface SchemaChange {
  kind: string;
  severity: "additive" | "destructive" | "metadata";
  collection: string;
  field?: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  ddl?: { pg: string[]; sqlite: string[] };
}

export interface SchemaDiff {
  changes: SchemaChange[];
  counts: { additive: number; destructive: number; metadata: number; total: number };
  hasDestructive: boolean;
}

export interface SchemaSnapshotSummary {
  id: string;
  name: string;
  note: string | null;
  hash: string;
  kind: string;
  branchId: string | null;
  parentSnapshotId: string | null;
  createdBy: string | null;
  createdAt: unknown;
  collectionCount: number;
}

export interface SchemaSnapshotRecord extends SchemaSnapshotSummary {
  snapshot: SchemaSnapshotCollection[];
}

export interface SchemaBranch {
  id: string;
  name: string;
  note: string | null;
  headSnapshotId: string | null;
  baseSnapshotId: string | null;
  createdBy: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

/** Where a schema state comes from — the live workspace schema, a stored
 *  snapshot, or a branch head. */
export type SchemaRef =
  | { kind: "live" }
  | { kind: "snapshot"; id: string }
  | { kind: "branch"; id: string };

export interface SchemaApplyResult {
  diff: SchemaDiff;
  applied: string[];
  safetySnapshotId: string | null;
  noop: boolean;
}

export interface MigrateSource {
  id: string;
  name: string;
  kind: string;
  /** Redacted URL — scheme + host + database only, credentials stripped. */
  urlMasked: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface MigrateRunTableState {
  table: string;
  cursor?: unknown;
  copied: number;
  failed: number;
  done: boolean;
  sourceCount?: number;
  targetTotal?: number;
}

export interface MigrateRun {
  id: string;
  sourceId: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  error: string | null;
  /** The MigrationPlan document driving the run. */
  plan: unknown;
  state: { tables: Record<string, MigrateRunTableState> };
  startedAt: unknown;
  finishedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

/** External-DB migration (admin-scoped). Mirrors `/api/admin/migrate`:
 *  saved source connections (URL encrypted at rest, masked on read),
 *  introspection + plan building, and durable server-side copy runs
 *  (advanced by the scheduler tick; cancel/resume-able). See
 *  docs/migrating-in.md — the `backlex import-db` CLI is the client-side
 *  twin for sources the server can't reach. */
export interface MigrateClient {
  /** List saved source connections (URLs masked). */
  sources(): Promise<{ data: MigrateSource[] }>;
  /** Save a source connection. The URL is encrypted at rest. */
  createSource(name: string, url: string): Promise<{ data: MigrateSource }>;
  /** Delete a source (refused while one of its runs is in flight). */
  deleteSource(id: string): Promise<{ ok: boolean }>;
  /** Connectivity check — opens the source and counts its tables. */
  testSource(id: string): Promise<{ data: { ok: boolean; tables?: number; error?: string } }>;
  /** List the source's tables (name + planner row estimate). */
  sourceTables(id: string): Promise<{ data: { name: string; approxRows: number | null }[] }>;
  /** Introspect and build an editable migration plan. */
  plan(id: string, tables?: string[]): Promise<{ data: unknown }>;
  /** Queue a server-side copy run for a (possibly edited) plan. */
  startRun(sourceId: string, plan: unknown): Promise<{ data: MigrateRun }>;
  /** List runs, newest first. */
  runs(): Promise<{ data: MigrateRun[] }>;
  /** One run — poll this for live progress. */
  run(id: string): Promise<{ data: MigrateRun }>;
  cancelRun(id: string): Promise<{ data: MigrateRun }>;
  /** Re-queue a failed/cancelled run; cursors resume where it stopped. */
  resumeRun(id: string): Promise<{ data: MigrateRun }>;
}

/** Schema versions — migration diffing / schema branching (admin-scoped).
 *  Mirrors `/api/admin/schema`. Diff any two refs, snapshot/branch the live
 *  schema, and apply a target to reconcile live (destructive changes gated). */
export interface SchemaClient {
  /** List schema snapshots (newest first). */
  snapshots(): Promise<{ data: SchemaSnapshotSummary[] }>;
  /** Fetch one snapshot, including its full schema body. */
  snapshot(id: string): Promise<{ data: SchemaSnapshotRecord }>;
  /** Capture the current live schema as a new snapshot. */
  capture(name: string, note?: string | null): Promise<{ data: SchemaSnapshotRecord }>;
  /** Store an externally-authored schema as a snapshot (the GitOps entry point). */
  import(
    name: string,
    snapshot: SchemaSnapshotCollection[],
    note?: string | null,
  ): Promise<{ data: SchemaSnapshotRecord }>;
  /** Delete a snapshot (refused if it is a branch head). */
  deleteSnapshot(id: string): Promise<{ ok: boolean }>;
  /** List schema branches. */
  branches(): Promise<{ data: SchemaBranch[] }>;
  /** Fetch one branch. */
  branch(id: string): Promise<{ data: SchemaBranch }>;
  /** Fork a branch from the live schema (or a snapshot). */
  createBranch(
    name: string,
    opts?: { note?: string | null; fromSnapshotId?: string | null },
  ): Promise<{ data: SchemaBranch }>;
  /** Move a branch's head to an authored schema, a snapshot, or live. */
  setBranchHead(
    id: string,
    opts: { data?: SchemaSnapshotCollection[]; fromSnapshotId?: string | null; name?: string },
  ): Promise<{ data: SchemaBranch }>;
  /** Delete a branch and its branch-owned snapshots. */
  deleteBranch(id: string): Promise<{ ok: boolean }>;
  /** Diff two refs into a categorized change list. */
  diff(
    from: SchemaRef,
    to: SchemaRef,
  ): Promise<{ data: { from: string; to: string; diff: SchemaDiff } }>;
  /** Apply a target ref to the live schema. Destructive changes require
   *  `confirmDestructive`. A safety snapshot is captured before any change. */
  apply(
    target: SchemaRef,
    opts?: { confirmDestructive?: boolean },
  ): Promise<{ data: SchemaApplyResult }>;
  /** Clone a collection's schema (fields + metadata, never data) into a new
   *  managed collection. Mirrors `POST /api/collections/:slug/clone`. */
  cloneCollection(
    slug: string,
    newSlug: string,
  ): Promise<{ data: Record<string, unknown> }>;
}

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
  extensions: ExtensionsClient;
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

  const captureToken = (r: AuthResult): AuthResult => {
    if (opts.workspace && typeof r.token === "string") appToken = r.token;
    return r;
  };

  const auth: AuthClient = {
    /** Email + password sign-up. In app mode this creates a *workspace* end-
     *  user (in `app_users`), not a control-plane account. */
    signUp: (input: { email: string; password: string; name?: string }) =>
      request<AuthResult>("POST", `${authBase}/sign-up/email`, input).then(captureToken),
    /** Email + password sign-in. */
    signIn: (input: { email: string; password: string }) =>
      request<AuthResult>("POST", `${authBase}/sign-in/email`, input).then(captureToken),
    /**
     * Begin an OAuth sign-in. Returns `{ url }` — the provider's authorize
     * page — which a browser app should navigate to (`location.href = url`).
     * `provider` must be one of the ids returned by `auth.providers()`.
     */
    signInSocial: (
      provider: string,
      input?: { callbackURL?: string; errorCallbackURL?: string },
    ) =>
      request<{ url: string; redirect: boolean }>("POST", `${authBase}/sign-in/social`, {
        provider,
        ...input,
        // ask better-auth for the URL instead of a 302, so the caller controls
        // the navigation.
        disableRedirect: true,
      }),
    /** Send a one-time sign-in link by email (requires the `magic` provider
     *  to be enabled for the workspace). */
    signInMagicLink: (input: { email: string; callbackURL?: string }) =>
      request<{ status: boolean }>("POST", `${authBase}/sign-in/magic-link`, input),
    /** Email a one-time numeric code (requires the `email-otp` provider). `type`
     *  defaults to `"sign-in"`; use `"email-verification"` / `"forget-password"`
     *  for those flows. Complete a sign-in with `signInEmailOTP`. */
    sendVerificationOTP: (input: {
      email: string;
      type?: "sign-in" | "email-verification" | "forget-password";
    }) =>
      request<{ success: boolean }>("POST", `${authBase}/email-otp/send-verification-otp`, {
        type: "sign-in",
        ...input,
      }),
    /** Complete an email-OTP sign-in with the code from `sendVerificationOTP`. In
     *  app mode the returned session token is captured and replayed as a bearer. */
    signInEmailOTP: (input: { email: string; otp: string }) =>
      request<AuthResult>("POST", `${authBase}/sign-in/email-otp`, input).then(captureToken),
    /** Send a password-reset email. `redirectTo` is the link the email points at. */
    requestPasswordReset: (input: { email: string; redirectTo?: string }) =>
      request<{ status: boolean }>("POST", `${authBase}/request-password-reset`, input),
    /** Complete a reset with the token from the email and a new password. */
    resetPassword: (input: { newPassword: string; token: string }) =>
      request<{ status: boolean }>("POST", `${authBase}/reset-password`, input),
    /** Accept an admin-issued end-user invite (`appUsers.invite` on the admin
     *  plane): `{ token, password }` activates the pending account and signs
     *  in. App mode only — `/api/t/<slug>/auth/invite/accept`. */
    acceptInvite: (input: { token: string; password: string }) =>
      request<AuthResult>("POST", `${authBase}/invite/accept`, input).then(captureToken),
    /** Mint a fresh short-lived access JWT from the stored session token (app
     *  mode). The SDK's own requests keep using the session token; use this when a
     *  downstream service needs a proper access token. */
    refresh: () =>
      request<{ accessToken: string; refreshToken: string; expiresIn: number; tokenType: string }>(
        "POST",
        `${authBase}/token/refresh`,
        { refreshToken: appToken },
      ),
    /** Change the signed-in user's password (requires the current password). */
    changePassword: (input: {
      newPassword: string;
      currentPassword: string;
      revokeOtherSessions?: boolean;
    }) => request<Record<string, unknown>>("POST", `${authBase}/change-password`, input),
    /** Update the signed-in user's profile (e.g. `{ name, image }`). */
    updateUser: (attributes: Record<string, unknown>) =>
      request<Record<string, unknown>>("POST", `${authBase}/update-user`, attributes),
    /** Send an email-verification link to the signed-in (or named) user. */
    sendVerificationEmail: (input: { email: string; callbackURL?: string }) =>
      request<{ status: boolean }>("POST", `${authBase}/send-verification-email`, input),
    signOut: () => request<{ success: boolean }>("POST", `${authBase}/sign-out`).then((r) => {
      if (opts.workspace) appToken = null;
      return r;
    }),
    /** Current session, or `{ user: null }`. */
    getSession: () =>
      request<{ user: AuthUser | null } & Record<string, unknown>>("GET", `${authBase}/get-session`),
    /** List the signed-in user's active sessions (one row per device/login). */
    listSessions: () => request<AuthSession[]>("GET", `${authBase}/list-sessions`),
    /** Revoke one session by its `token` (from `listSessions`). */
    revokeSession: (input: { token: string }) =>
      request<{ status: boolean }>("POST", `${authBase}/revoke-session`, input),
    /** Revoke every session **except** the current one (sign out other devices). */
    revokeOtherSessions: () =>
      request<{ status: boolean }>("POST", `${authBase}/revoke-other-sessions`),
    /** Revoke **all** sessions, including the current one. */
    revokeSessions: () => request<{ status: boolean }>("POST", `${authBase}/revoke-sessions`),
    /** Public description of this workspace's auth surface (provider list +
     *  policy flags) — what a sign-in screen needs to render. No secrets. */
    providers: () =>
      request<{ data: AuthSurface }>("GET", `${authBase}/providers`).then((r) => r.data),
    /** The current workspace session token (app mode) — persist this across
     *  reloads and pass it back via `createClient({ token })`. */
    getToken: (): string | null => appToken,
    /** Restore a workspace session token (app mode). */
    setToken: (token: string | null): void => {
      appToken = token;
    },
  };

  const safeErr = async (res: Response) =>
    (await res.json().catch(() => ({}))) as
      | { error?: { code: string; message: string; details?: unknown } }
      | undefined;

  /** HEAD a TUS session to learn the server's committed offset. */
  const headOffset = async (location: string, signal?: AbortSignal): Promise<number> => {
    const res = await f(`${opts.url}${location}`, {
      method: "HEAD",
      credentials: "include",
      headers: {
        ...authHeader(),
        ...tenantHeader(),
        ...orgHeader(),
        "Tus-Resumable": "1.0.0",
      },
      signal,
    });
    if (!res.ok) throw new BacklexError(res.status, undefined);
    return Number(res.headers.get("Upload-Offset") ?? "0");
  };

  /**
   * PATCH chunks from the server's current offset to the end. On a network
   * error or 409 offset-conflict it re-HEADs to resync and retries with
   * backoff (up to 6 tries per chunk); other 4xx are fatal.
   */
  const patchLoop = async (
    location: string,
    src: UploadSource,
    chunkSize: number,
    onProgress?: (sent: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    let offset = await headOffset(location, signal);
    let retries = 0;
    while (offset < src.size) {
      const end = Math.min(offset + chunkSize, src.size);
      try {
        const res = await f(`${opts.url}${location}`, {
          method: "PATCH",
          credentials: "include",
          headers: {
            ...authHeader(),
            ...tenantHeader(),
      ...orgHeader(),
            "Tus-Resumable": "1.0.0",
            "Upload-Offset": String(offset),
            "content-type": OFFSET_OCTET,
          },
          body: src.slice(offset, end),
          signal,
        });
        if (res.status === 409) {
          offset = await headOffset(location, signal); // resync + retry
          continue;
        }
        if (!res.ok) throw new BacklexError(res.status, await safeErr(res));
        offset = Number(res.headers.get("Upload-Offset") ?? String(end));
        retries = 0;
        onProgress?.(offset, src.size);
      } catch (e) {
        if (signal?.aborted) throw e;
        if (e instanceof BacklexError && e.status >= 400 && e.status < 500 && e.status !== 409) {
          throw e; // fatal client error
        }
        if (++retries > 6) throw e;
        await new Promise((r) => setTimeout(r, 250 * 2 ** (retries - 1)));
        offset = await headOffset(location, signal);
      }
    }
  };

  const storage: StorageClient = {
    list: (prefix?: string) =>
      request<{
        data: {
          key: string;
          size: number;
          contentType?: string;
          ownerId: string | null;
          uploadedAt: string;
        }[];
      }>(
        "GET",
        `/api/storage${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`,
      ),
    put: async (
      key: string,
      body: BodyInit,
      contentType?: string,
      folderId?: string,
    ) => {
      const headers: Record<string, string> = {
        ...authHeader(),
        ...tenantHeader(),
      ...orgHeader(),
        ...(contentType ? { "content-type": contentType } : {}),
      };
      const url = `${opts.url}/api/storage/${encodeURIComponent(key)}${folderId ? `?folderId=${folderId}` : ""}`;
      const res = await f(url, {
        method: "PUT",
        credentials: "include",
        headers,
        body,
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as
          | { error?: { code: string; message: string; details?: unknown } }
          | undefined;
        throw new BacklexError(res.status, errBody);
      }
      return res.json();
    },
    download: async (key: string): Promise<Response> => {
      const res = await f(`${opts.url}/api/storage/${encodeURIComponent(key)}`, {
        credentials: "include",
        headers: { ...authHeader(), ...tenantHeader(), ...orgHeader() },
      });
      if (!res.ok) {
        throw new BacklexError(res.status, undefined);
      }
      return res;
    },
    delete: (key: string) =>
      request<{ ok: boolean }>(
        "DELETE",
        `/api/storage/${encodeURIComponent(key)}`,
      ),

    /**
     * Resumable upload (TUS 1.0.0). Splits `data` into chunks and PATCHes them
     * to `/api/uploads`, resuming from the server's committed offset after a
     * transient failure. `data` may be a `Blob`/`File`, `ArrayBuffer`, or
     * `Uint8Array`. Returns the final key + the TUS session `location` (persist
     * it to resume across page reloads via `resumeUpload`). The standard TUS
     * protocol means Uppy / tus-js-client can also target `/api/uploads`.
     */
    uploadResumable: async (input: {
      key: string;
      data: Blob | ArrayBuffer | Uint8Array;
      contentType?: string;
      folderId?: string;
      /** Bytes per PATCH. Default 8 MiB (object stores need ≥5 MiB non-final parts). */
      chunkSize?: number;
      onProgress?: (sent: number, total: number) => void;
      signal?: AbortSignal;
    }): Promise<ResumableUploadResult> => {
      const src = normalizeUploadData(input.data);
      const meta: string[] = [`key ${b64(input.key)}`];
      const ct = input.contentType ?? (input.data instanceof Blob ? input.data.type : "");
      if (ct) meta.push(`contentType ${b64(ct)}`);
      if (input.folderId) meta.push(`folderId ${b64(input.folderId)}`);

      const res = await f(`${opts.url}/api/uploads`, {
        method: "POST",
        credentials: "include",
        headers: {
          ...authHeader(),
          ...tenantHeader(),
      ...orgHeader(),
          "Tus-Resumable": "1.0.0",
          "Upload-Length": String(src.size),
          "Upload-Metadata": meta.join(","),
        },
        signal: input.signal,
      });
      if (!res.ok) throw new BacklexError(res.status, await safeErr(res));
      const location = res.headers.get("Location");
      if (!location) throw new BacklexError(res.status, undefined);
      await patchLoop(location, src, input.chunkSize ?? DEFAULT_CHUNK, input.onProgress, input.signal);
      return { key: input.key, location };
    },

    /** Resume a previously-started resumable upload at the server's offset. */
    resumeUpload: async (
      location: string,
      data: Blob | ArrayBuffer | Uint8Array,
      opts2?: { chunkSize?: number; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal },
    ): Promise<void> => {
      await patchLoop(
        location,
        normalizeUploadData(data),
        opts2?.chunkSize ?? DEFAULT_CHUNK,
        opts2?.onProgress,
        opts2?.signal,
      );
    },
  };

  const messaging: MessagingClient = {
    /** Register (or refresh) the current user's push device. Re-registering the
     *  same token reactivates it and updates last-seen, so call this on every
     *  app launch. `web-push` requires `keys` (the VAPID subscription keys). */
    registerDevice: (input: {
      platform: "fcm" | "apns" | "web-push";
      token: string;
      keys?: { p256dh: string; auth: string };
      deviceName?: string;
    }) => request<{ data: { id: string } }>("POST", "/api/device-tokens", input),
    /** Remove one of the caller's registered devices by id. */
    unregister: (id: string) =>
      request<{ ok: boolean }>("DELETE", `/api/device-tokens/${encodeURIComponent(id)}`),
    /** List the caller's registered devices. */
    listDevices: () => request<{ data: DeviceToken[] }>("GET", "/api/device-tokens"),
    /** Register (or refresh) the current user's phone number for SMS. Number
     *  must be E.164 (e.g. "+14155552671"). Re-registering reactivates it. */
    registerPhone: (input: { phoneNumber: string }) =>
      request<{ data: { id: string } }>("POST", "/api/phone-numbers", input),
    /** Remove one of the caller's registered phone numbers by id. */
    unregisterPhone: (id: string) =>
      request<{ ok: boolean }>("DELETE", `/api/phone-numbers/${encodeURIComponent(id)}`),
    /** List the caller's registered phone numbers. */
    listPhones: () => request<{ data: PhoneNumber[] }>("GET", "/api/phone-numbers"),
    /** Send a push to a user's registered devices — dispatch-only, no in-app
     *  row. Admins may target any user; non-admins only themselves. */
    sendPush: (input: {
      userId: string;
      title: string;
      body: string;
      url?: string;
      data?: Record<string, string>;
    }) =>
      request<{ ok: boolean; sent: number; failed: number }>(
        "POST",
        "/api/messaging/push",
        input,
      ),
    /** Send an SMS to a user's registered phone numbers. Admins may target any
     *  user; non-admins only themselves. */
    sendSms: (input: { userId: string; body: string }) =>
      request<{ ok: boolean; sent: number; failed: number }>(
        "POST",
        "/api/messaging/sms",
        input,
      ),
  };

  const jobs: JobsClient = {
    /** Enqueue a durable background job. `type` is `function` (run a named
     *  function with `payload.name` + `payload.input`) or `webhook.deliver`.
     *  Jobs retry with backoff and dead-letter after `maxAttempts`. Pass
     *  `runAt` (ISO string) to schedule for later. Admin-scoped. */
    enqueue: (input: {
      type: "function" | "webhook.deliver";
      payload?: Record<string, unknown>;
      queue?: string;
      runAt?: string;
      maxAttempts?: number;
      priority?: number;
    }) => request<{ id: string }>("POST", "/api/jobs", input),
    /** List jobs (newest first), optionally filtered by queue/status. */
    list: (q?: { queue?: string; status?: JobStatus; limit?: number }) => {
      const params = new URLSearchParams();
      if (q?.queue) params.set("queue", q.queue);
      if (q?.status) params.set("status", q.status);
      if (q?.limit != null) params.set("limit", String(q.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return request<{ jobs: Job[] }>("GET", `/api/jobs${suffix}`);
    },
    /** Fetch a single job by id. */
    get: (id: string) => request<Job>("GET", `/api/jobs/${encodeURIComponent(id)}`),
    /** Requeue a failed / dead-lettered / cancelled job to run again. */
    retry: (id: string) =>
      request<{ ok: boolean }>("POST", `/api/jobs/${encodeURIComponent(id)}/retry`),
    /** Cancel a pending job. */
    cancel: (id: string) =>
      request<{ ok: boolean }>("POST", `/api/jobs/${encodeURIComponent(id)}/cancel`),
    /** Delete a job row. */
    remove: (id: string) =>
      request<{ ok: boolean }>("DELETE", `/api/jobs/${encodeURIComponent(id)}`),
  };

  // Visual workflows. Admin-scoped CRUD over `/api/flows`; `run` triggers a
  // synchronous execution with an arbitrary input payload.
  const flows: FlowsClient = {
    /** List every flow in the active workspace. */
    list: () => request<{ data: Flow[] }>("GET", "/api/flows"),
    /** Fetch a single flow's full definition by id. */
    get: (id: string) =>
      request<{ data: Flow }>("GET", `/api/flows/${encodeURIComponent(id)}`),
    /** Create a flow scoped to the active workspace. */
    create: (input: FlowInput) => request<{ data: Flow }>("POST", "/api/flows", input),
    /** Partial update of a flow by id. */
    update: (id: string, patch: Partial<FlowInput>) =>
      request<{ ok: boolean }>("PATCH", `/api/flows/${encodeURIComponent(id)}`, patch),
    /** Delete a flow by id. */
    delete: (id: string) =>
      request<{ ok: boolean }>("DELETE", `/api/flows/${encodeURIComponent(id)}`),
    /** Run a flow synchronously with an arbitrary `input` trigger payload. */
    run: (id: string, input?: Record<string, unknown>) =>
      request<FlowRunResult>("POST", `/api/flows/${encodeURIComponent(id)}/run`, input ?? {}),
  };

  const documents: DocumentsClient = {
    list: () => request<{ data: DocumentTemplate[] }>("GET", "/api/admin/documents/templates"),
    save: (key: string, input: DocumentTemplateInput) =>
      request<{ data: DocumentTemplate }>(
        "PUT",
        `/api/admin/documents/templates/${encodeURIComponent(key)}`,
        input,
      ),
    delete: (key: string) =>
      request<{ ok: boolean }>(
        "DELETE",
        `/api/admin/documents/templates/${encodeURIComponent(key)}`,
      ),
    // Bytes, not JSON: the endpoint answers `application/pdf`, so this goes
    // through the raw path rather than the JSON one.
    render: async (input: RenderDocumentInput) => {
      const res = await requestRaw(
        "POST",
        "/api/admin/documents/render",
        JSON.stringify(input),
        "application/json",
      );
      return new Uint8Array(await res.arrayBuffer());
    },
  };

  const apv = (id: string) => `/api/admin/approvals/${encodeURIComponent(id)}`;
  const approvals: ApprovalsClient = {
    list: (opts) => {
      const q = new URLSearchParams();
      if (opts?.status) q.set("status", opts.status);
      if (opts?.limit != null) q.set("limit", String(opts.limit));
      const qs = q.toString();
      return request<{ data: ApprovalRequest[] }>(
        "GET",
        `/api/admin/approvals${qs ? `?${qs}` : ""}`,
      );
    },
    get: (id: string) => request<{ data: ApprovalRequest }>("GET", apv(id)),
    create: (input: CreateApprovalRequestInput) =>
      request<{
        data: {
          request: ApprovalRequest;
          links: Array<{ approverId: string; email: string; url: string }>;
          sent: boolean;
        };
      }>("POST", "/api/admin/approvals", input),
    cancel: (id: string, reason?: string | null) =>
      request<{ data: ApprovalRequest }>("POST", `${apv(id)}/cancel`, { reason: reason ?? null }),
  };

  const sig = (id: string) => `/api/admin/signatures/${encodeURIComponent(id)}`;
  const signatures: SignaturesClient = {
    list: (opts) => {
      const q = new URLSearchParams();
      if (opts?.status) q.set("status", opts.status);
      if (opts?.limit != null) q.set("limit", String(opts.limit));
      if (opts?.offset != null) q.set("offset", String(opts.offset));
      const qs = q.toString();
      return request<{ data: SignatureRequest[]; total: number }>(
        "GET",
        `/api/admin/signatures${qs ? `?${qs}` : ""}`,
      );
    },
    get: (id: string) => request<{ data: SignatureRequest }>("GET", sig(id)),
    create: (input: CreateSignatureRequestInput) =>
      request<{
        data: {
          request: SignatureRequest;
          links: Array<{ signerId: string; email: string; url: string }>;
          sent: boolean;
        };
      }>("POST", "/api/admin/signatures", input),
    void: (id: string, reason?: string | null) =>
      request<{ data: SignatureRequest }>("POST", `${sig(id)}/void`, { reason: reason ?? null }),
    resend: (id: string, signerId: string) =>
      request<{ data: { sent: boolean; email: string } }>(
        "POST",
        `${sig(id)}/signers/${encodeURIComponent(signerId)}/resend`,
      ),
    finalize: (id: string) => request<{ data: SignatureRequest }>("POST", `${sig(id)}/finalize`),
    // Bytes, not JSON — same raw path the document render uses.
    document: async (id: string, which: "original" | "signed" = "signed") => {
      const res = await requestRaw("GET", `${sig(id)}/document?which=${which}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };

  // Availability & booking. Every method here goes through the one service the
  // REST, GraphQL, MCP and CLI surfaces share, so the capacity guarantee and
  // the grid check cannot drift between them.
  const bookRes = (key: string) => `/api/admin/booking/resources/${encodeURIComponent(key)}`;
  const bookOne = (id: string) => `/api/admin/booking/bookings/${encodeURIComponent(id)}`;
  const booking: BookingClient = {
    listResources: () =>
      request<{ data: BookingResource[] }>("GET", "/api/admin/booking/resources"),
    getResource: (key) => request<{ data: BookingResource }>("GET", bookRes(key)),
    createResource: (input) =>
      request<{ data: { resource: BookingResource; token: string; url: string } }>(
        "POST",
        "/api/admin/booking/resources",
        input,
      ),
    updateResource: (key, patch) =>
      request<{ data: BookingResource }>("PATCH", bookRes(key), patch),
    deleteResource: (key, opts) =>
      request<{ data: { ok: boolean } }>(
        "DELETE",
        `${bookRes(key)}${opts?.force ? "?force=true" : ""}`,
      ),
    rotateToken: (key) =>
      request<{ data: { token: string; url: string } }>("POST", `${bookRes(key)}/rotate-token`),
    slots: (key, window) => {
      const q = new URLSearchParams();
      if (window?.from) q.set("from", window.from);
      if (window?.to) q.set("to", window.to);
      const qs = q.toString();
      return request<{
        data: { resource: Record<string, unknown>; from: string; to: string; slots: BookingSlot[] };
      }>("GET", `${bookRes(key)}/slots${qs ? `?${qs}` : ""}`);
    },
    listBookings: (opts) => {
      const q = new URLSearchParams();
      if (opts?.resource) q.set("resource", opts.resource);
      if (opts?.status) q.set("status", opts.status);
      if (opts?.from) q.set("from", opts.from);
      if (opts?.to) q.set("to", opts.to);
      if (opts?.limit != null) q.set("limit", String(opts.limit));
      if (opts?.offset != null) q.set("offset", String(opts.offset));
      const qs = q.toString();
      return request<{ data: Booking[]; total: number }>(
        "GET",
        `/api/admin/booking/bookings${qs ? `?${qs}` : ""}`,
      );
    },
    getBooking: (id) => request<{ data: Booking }>("GET", bookOne(id)),
    book: (resource, input) =>
      request<{ data: BookingResult }>("POST", "/api/admin/booking/bookings", {
        resource,
        ...input,
      }),
    confirm: (id) => request<{ data: Booking }>("POST", `${bookOne(id)}/confirm`),
    cancel: (id, opts) => request<{ data: Booking }>("POST", `${bookOne(id)}/cancel`, opts ?? {}),
    reschedule: (id, start) =>
      request<{ data: BookingResult }>("POST", `${bookOne(id)}/reschedule`, { start }),
    noShow: (id) => request<{ data: Booking }>("POST", `${bookOne(id)}/no-show`),
  };

  // Third-party integrations. Admin-scoped over `/api/admin/integrations`.
  // Credentials only ever travel inbound: `list` returns them masked and there
  // is no read-back endpoint.
  const integ = (id: string) => `/api/admin/integrations/${encodeURIComponent(id)}`;
  const integrations: IntegrationsClient = {
    catalog: () =>
      request<{ data: { kinds: string[]; providers: IntegrationProvider[]; oauthRedirectUri: string } }>(
        "GET",
        "/api/admin/integrations/catalog",
      ),
    list: () => request<{ data: Integration[] }>("GET", "/api/admin/integrations"),
    connect: (input) => request<{ data: Integration }>("POST", "/api/admin/integrations", input),
    disconnect: (id) => request<{ ok: boolean }>("DELETE", integ(id)),
    deliveries: (id, opts) => {
      const qs = opts?.limit === undefined ? "" : `?limit=${opts.limit}`;
      return request<{ data: IntegrationDelivery[] }>("GET", `${integ(id)}/deliveries${qs}`);
    },
    resume: (id) => request<{ data: Integration }>("POST", `${integ(id)}/resume`, {}),
    oauthAuthorize: (id) => request<{ data: { url: string } }>("POST", `${integ(id)}/oauth/authorize`, {}),
    syncs: (opts) => {
      const qs = opts?.integrationId ? `?integrationId=${encodeURIComponent(opts.integrationId)}` : "";
      return request<{ data: IntegrationSync[] }>("GET", `/api/admin/integrations/syncs${qs}`);
    },
    createSync: (input) =>
      request<{ data: IntegrationSync }>("POST", "/api/admin/integrations/syncs", input),
    updateSync: (id, patch) =>
      request<{ data: IntegrationSync }>(
        "PATCH",
        `/api/admin/integrations/syncs/${encodeURIComponent(id)}`,
        patch,
      ),
    deleteSync: (id) =>
      request<{ ok: boolean }>("DELETE", `/api/admin/integrations/syncs/${encodeURIComponent(id)}`),
    runSync: (id) =>
      request<{ data: { written: number; pages: number; complete: boolean } }>(
        "POST",
        `/api/admin/integrations/syncs/${encodeURIComponent(id)}/run`,
        {},
      ),
  };

  // Sync hooks. Admin-scoped over `/api/admin/sync-hooks`. Signing secrets only
  // ever travel inbound: `list` reports presence, never the value.
  const hook = (id: string) => `/api/admin/sync-hooks/${encodeURIComponent(id)}`;
  const syncHooks: SyncHooksClient = {
    list: () => request<{ data: SyncHook[] }>("GET", "/api/admin/sync-hooks"),
    create: (input) => request<{ data: SyncHook }>("POST", "/api/admin/sync-hooks", input),
    update: (id, patch) => request<{ data: SyncHook }>("PATCH", hook(id), patch),
    delete: (id) => request<{ ok: boolean }>("DELETE", hook(id)),
    test: (id) => request<SyncHookTestResult>("POST", `${hook(id)}/test`, {}),
  };

  // Payment providers. Admin-scoped over `/api/admin/payments`; the synced
  // business data is read through the ordinary collection surface.
  const pay = (id: string) => `/api/admin/payments/providers/${encodeURIComponent(id)}`;
  const payments: PaymentsClient = {
    catalog: () =>
      request<{ providers: PaymentCatalogEntry[]; recordKinds: string[] }>(
        "GET",
        "/api/admin/payments/catalog",
      ),
    list: () =>
      request<{ data: PaymentProviderConnection[]; stats: Record<string, number> }>(
        "GET",
        "/api/admin/payments/providers",
      ),
    connect: (input: PaymentProviderInput) =>
      request<{ data: PaymentProviderConnection; collections: PaymentCollectionsResult }>(
        "POST",
        "/api/admin/payments/providers",
        input,
      ),
    disconnect: (id: string) => request<{ ok: boolean }>("DELETE", pay(id)),
    rotateToken: (id: string) =>
      request<{ data: PaymentProviderConnection }>("POST", `${pay(id)}/rotate-token`, {}),
    sync: (id: string, opts?: { kinds?: string[]; maxPages?: number; resume?: boolean; async?: boolean }) =>
      request<PaymentSyncResult>("POST", `${pay(id)}/sync`, opts ?? {}),
    checkout: (input: PaymentCheckoutInput) =>
      request<{ data: PaymentCheckout }>("POST", "/api/admin/payments/checkout", input),
    refund: (input: PaymentRefundInput) =>
      request<{ data: PaymentRefund }>("POST", "/api/admin/payments/refund", input),
    events: (opts?: { providerId?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (opts?.providerId) qs.set("providerId", opts.providerId);
      if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
      const q = qs.toString();
      return request<{ data: PaymentEvent[] }>(
        "GET",
        `/api/admin/payments/events${q ? `?${q}` : ""}`,
      );
    },
    provisionCollections: () =>
      request<PaymentCollectionsResult>("POST", "/api/admin/payments/collections", {}),
  };

  // Embedded BI dashboards. Admin-scoped CRUD over `/api/admin/dashboards`;
  // `run` executes every panel, `share`/`revoke` toggle the public embed token.
  const dash = (id: string) => `/api/admin/dashboards/${encodeURIComponent(id)}`;
  const dashboards: DashboardsClient = {
    list: () => request<{ data: Dashboard[] }>("GET", "/api/admin/dashboards"),
    get: (id: string) => request<{ data: Dashboard }>("GET", dash(id)),
    create: (input: DashboardInput) =>
      request<{ data: Dashboard }>("POST", "/api/admin/dashboards", input),
    update: (id: string, patch: Partial<DashboardInput>) =>
      request<{ ok: boolean }>("PATCH", dash(id), patch),
    delete: (id: string) => request<{ ok: boolean }>("DELETE", dash(id)),
    run: (id: string) =>
      request<{ data: DashboardPanelResult[]; ms: number }>("POST", `${dash(id)}/run`, {}),
    share: (id: string, opts?: { roleId?: string | null }) =>
      request<DashboardShareResult>("POST", `${dash(id)}/share`, opts ?? {}),
    revoke: (id: string) => request<{ ok: boolean }>("DELETE", `${dash(id)}/share`),
    report: (id: string, input?: DashboardReportInput) =>
      request<DashboardReport>("POST", `${dash(id)}/report`, input ?? {}),
    // Bytes, not JSON — same raw path the document render uses.
    reportPdf: async (id: string, input?: Omit<DashboardReportInput, "email">) => {
      const res = await requestRaw(
        "POST",
        `${dash(id)}/report`,
        JSON.stringify({ ...(input ?? {}), download: true }),
        "application/json",
      );
      return new Uint8Array(await res.arrayBuffer());
    },
  };

  // Product analytics + crash reporting. `track*` post to the public ingest
  // endpoints (authenticated by the publishable `ingestKey` when set, else by
  // whatever session/API key the client already carries); everything else is
  // admin-scoped reporting over `/api/admin/analytics`.
  const ANON_KEY = "backlex.analytics.distinctId";
  let anonId: string | null = null;
  let identifiedUserId: string | null = null;
  /** A stable per-visitor id. Persisted so a returning browser keeps its
   *  history — which is what makes retention and funnels meaningful. */
  const currentDistinctId = (): string => {
    if (anonId) return anonId;
    try {
      const store = globalThis.localStorage;
      const saved = store?.getItem(ANON_KEY);
      if (saved) {
        anonId = saved;
        return anonId;
      }
      anonId = crypto.randomUUID();
      store?.setItem(ANON_KEY, anonId);
    } catch {
      // Private mode / no DOM — an in-memory id still groups one session.
      anonId ??= crypto.randomUUID();
    }
    return anonId;
  };
  const ingestHeaders = (): Record<string, string> =>
    opts.ingestKey ? { "x-backlex-ingest-key": opts.ingestKey } : {};
  const analyticsQuery = (q: object | undefined): string => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q ?? {})) {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  };
  const toTrackedError = (e: Error | TrackedError): TrackedError =>
    e instanceof Error
      ? { message: e.message, type: e.name, stack: e.stack ?? null }
      : e;
  const errPath = (id: string) =>
    `/api/admin/analytics/errors/${encodeURIComponent(id)}`;

  const analytics: AnalyticsClient = {
    distinctId: currentDistinctId,
    identify: (distinctId: string, o?: { userId?: string | null }) => {
      anonId = distinctId;
      identifiedUserId = o?.userId ?? null;
      try {
        globalThis.localStorage?.setItem(ANON_KEY, distinctId);
      } catch {
        // non-browser or storage denied — the in-memory id still applies
      }
    },
    trackBatch: (events: TrackedEvent[]) =>
      request<AnalyticsIngestResult>(
        "POST",
        "/api/analytics/events",
        {
          events: events.map((e) => ({
            ...e,
            distinctId: e.distinctId ?? currentDistinctId(),
            userId: e.userId ?? identifiedUserId ?? undefined,
          })),
        },
        ingestHeaders(),
      ),
    track: (name, props, extra) =>
      analytics.trackBatch([{ ...extra, name, props: props ?? null }]),
    trackErrorBatch: (errors: TrackedError[]) =>
      request<AnalyticsIngestResult & { groups: string[] }>(
        "POST",
        "/api/analytics/errors",
        {
          errors: errors.map((e) => ({
            ...e,
            distinctId: e.distinctId ?? currentDistinctId(),
            userId: e.userId ?? identifiedUserId ?? undefined,
          })),
        },
        ingestHeaders(),
      ),
    trackError: (error, extra) =>
      analytics.trackErrorBatch([{ ...toTrackedError(error), ...extra }]),
    captureErrors: (o) => {
      const w = globalThis as unknown as {
        addEventListener?: typeof addEventListener;
        removeEventListener?: typeof removeEventListener;
        location?: { href?: string };
      };
      if (typeof w.addEventListener !== "function") return () => {};
      const base = {
        platform: o?.platform ?? "browser",
        release: o?.release ?? null,
      };
      // Reporting must never throw inside a global error handler — that would
      // replace the app's original failure with the reporter's.
      const send = (payload: TrackedError) => {
        void analytics
          .trackError({ ...base, url: w.location?.href ?? null, ...payload })
          .catch(() => {});
      };
      const onError = (ev: Event) => {
        const e = ev as ErrorEvent;
        send(
          e.error instanceof Error
            ? toTrackedError(e.error)
            : { message: e.message || "Uncaught error" },
        );
      };
      const onRejection = (ev: Event) => {
        const reason = (ev as PromiseRejectionEvent).reason;
        send(
          reason instanceof Error
            ? toTrackedError(reason)
            : { message: `Unhandled rejection: ${String(reason)}` },
        );
      };
      w.addEventListener("error", onError);
      w.addEventListener("unhandledrejection", onRejection);
      return () => {
        w.removeEventListener?.("error", onError);
        w.removeEventListener?.("unhandledrejection", onRejection);
      };
    },
    overview: (range) =>
      request<{ data: AnalyticsOverview }>(
        "GET",
        `/api/admin/analytics/overview${analyticsQuery(range)}`,
      ),
    eventNames: () =>
      request<{ data: string[] }>("GET", "/api/admin/analytics/event-names"),
    funnel: (input) =>
      request<{ data: AnalyticsFunnelResult }>(
        "POST",
        "/api/admin/analytics/funnel",
        input,
      ),
    retention: (input) =>
      request<{ data: AnalyticsRetentionResult }>(
        "POST",
        "/api/admin/analytics/retention",
        input ?? {},
      ),
    events: (query) =>
      request<{ data: AnalyticsEventRow[] }>(
        "GET",
        `/api/admin/analytics/events${analyticsQuery(query)}`,
      ),
    errors: {
      list: (query) =>
        request<{ data: ErrorGroup[] }>(
          "GET",
          `/api/admin/analytics/errors${analyticsQuery(query)}`,
        ),
      get: (id: string) => request<{ data: ErrorGroupDetail }>("GET", errPath(id)),
      update: (id: string, patch: { status: "open" | "resolved" | "ignored" }) =>
        request<{ data: ErrorGroup }>("PATCH", errPath(id), patch),
      delete: (id: string) => request<{ ok: boolean }>("DELETE", errPath(id)),
    },
    ingestKey: {
      status: () =>
        request<{ data: { exists: boolean } }>(
          "GET",
          "/api/admin/analytics/ingest-key",
        ),
      mint: () =>
        request<{ data: { key: string } }>(
          "POST",
          "/api/admin/analytics/ingest-key",
          {},
        ),
      revoke: () =>
        request<{ ok: boolean }>("DELETE", "/api/admin/analytics/ingest-key"),
    },
  };

  // Public form builder. Admin-scoped over `/api/admin/forms`; the plaintext
  // token only ever appears in `create` / `rotateToken` responses.
  const formPath = (id: string) => `/api/admin/forms/${encodeURIComponent(id)}`;
  const forms: FormsClient = {
    list: () => request<{ data: PublicForm[] }>("GET", "/api/admin/forms"),
    get: (id: string) => request<{ data: PublicForm }>("GET", formPath(id)),
    eligibleFields: (collection: string) =>
      request<{ data: PublicFormEligibleField[] }>(
        "GET",
        `/api/admin/forms/eligible-fields/${encodeURIComponent(collection)}`,
      ),
    create: (input: PublicFormInput) =>
      request<{ data: { form: PublicForm } & PublicFormToken }>(
        "POST",
        "/api/admin/forms",
        input,
      ),
    update: (id: string, patch: Partial<PublicFormInput>) =>
      request<{ data: PublicForm }>("PATCH", formPath(id), patch),
    rotateToken: (id: string) =>
      request<{ data: PublicFormToken }>("POST", `${formPath(id)}/rotate-token`),
    delete: (id: string) => request<{ ok: boolean }>("DELETE", formPath(id)),
  };

  // Extension system. Admin-scoped over `/api/extensions`; `enabled` is open
  // to any signed-in user so UIs can discover mountable contributions.
  const extPath = (name: string) => `/api/extensions/${encodeURIComponent(name)}`;
  const extensions: ExtensionsClient = {
    list: () => request<{ data: Extension[] }>("GET", "/api/extensions"),
    enabled: () => request<{ data: Extension[] }>("GET", "/api/extensions/enabled"),
    install: (pkg: string, version?: string) =>
      request<{ data: Extension }>("POST", "/api/extensions/install", {
        package: pkg,
        ...(version ? { version } : {}),
      }),
    upload: (files: Record<string, string>) =>
      request<{ data: Extension }>("POST", "/api/extensions/upload", { files }),
    setEnabled: (name: string, enabled: boolean) =>
      request<{ data: Extension }>("PATCH", extPath(name), { enabled }),
    uninstall: (name: string) => request<{ ok: boolean }>("DELETE", extPath(name)),
    invokeHook: (name: string, hookId: string, input?: Record<string, unknown>) =>
      request<ExtensionInvokeResult>(
        "POST",
        `${extPath(name)}/hooks/${encodeURIComponent(hookId)}/invoke`,
        input ?? {},
      ),
  };

  // Usage metering. Admin-scoped over `/api/admin/usage`.
  const usage: UsageClient = {
    overview: (opts?: { days?: number }) =>
      request<{ data: UsageOverview }>(
        "GET",
        `/api/admin/usage/overview${opts?.days ? `?days=${Math.floor(opts.days)}` : ""}`,
      ),
    export: (opts?: { from?: string; to?: string }) => {
      const qs = new URLSearchParams();
      if (opts?.from) qs.set("from", opts.from);
      if (opts?.to) qs.set("to", opts.to);
      const suffix = qs.size > 0 ? `?${qs}` : "";
      return request<{ data: UsageExport }>("GET", `/api/admin/usage/export${suffix}`);
    },
    setLimits: (limits: UsageLimits) =>
      request<{ ok: boolean }>("PUT", "/api/admin/usage/limits", limits),
  };

  // Advisor. Admin-scoped over `/api/admin/advisor*`. `apply` deliberately
  // sends only the finding id — the server re-derives the statement.
  const advisor: AdvisorClient = {
    run: (opts?: { days?: number }) => {
      const qs = opts?.days ? `?days=${Math.floor(opts.days)}` : "";
      return request<AdvisorResult>("GET", `/api/admin/advisor${qs}`);
    },
    insights: (opts?: { days?: number; limit?: number }) => {
      const qs = new URLSearchParams();
      if (opts?.days) qs.set("days", String(Math.floor(opts.days)));
      if (opts?.limit) qs.set("limit", String(Math.floor(opts.limit)));
      const suffix = qs.size > 0 ? `?${qs}` : "";
      return request<AdvisorInsights>("GET", `/api/admin/advisor/insights${suffix}`);
    },
    apply: (id: string, opts?: { days?: number }) =>
      request<{ ok: true; applied: AdvisorAction }>(
        "POST",
        "/api/admin/advisor/apply",
        opts?.days ? { id, days: Math.floor(opts.days) } : { id },
      ),
  };

  // Backup / restore. Admin-scoped over `/api/admin/db/backups*`; `run` blocks
  // until the dump finishes, `restore` carries the confirm header the REST
  // endpoint requires (the restore itself is additive — never overwrites).
  const backups: BackupsClient = {
    list: () => request<{ data: BackupRecord[] }>("GET", "/api/admin/db/backups"),
    run: (opts?: { label?: string }) =>
      request<{ data: BackupRecord }>(
        "POST",
        "/api/admin/db/backups/now",
        opts?.label ? { label: opts.label } : {},
      ),
    restore: (id: string) =>
      request<{ data: BackupRestoreResult }>(
        "POST",
        `/api/admin/db/backups/${encodeURIComponent(id)}/restore`,
        undefined,
        { "x-backlex-confirm": "yes" },
      ),
    getConfig: () =>
      request<{ data: BackupScheduleConfig }>("GET", "/api/admin/db/backups/config"),
    setConfig: (patch: Partial<BackupScheduleConfig>) =>
      request<{ data: BackupScheduleConfig }>("PUT", "/api/admin/db/backups/config", patch),
  };

  // AI agents. Admin-scoped CRUD + thread management over `/api/agents`; `send`
  // runs one reason→act turn to completion, `run` is the new-thread shortcut.
  const agents: AgentsClient = {
    list: () => request<{ data: Agent[] }>("GET", "/api/agents"),
    get: (id: string) =>
      request<{ data: Agent }>("GET", `/api/agents/${encodeURIComponent(id)}`),
    create: (input: AgentInput) => request<{ data: Agent }>("POST", "/api/agents", input),
    update: (id: string, patch: Partial<AgentInput>) =>
      request<{ ok: boolean }>("PATCH", `/api/agents/${encodeURIComponent(id)}`, patch),
    delete: (id: string) =>
      request<{ ok: boolean }>("DELETE", `/api/agents/${encodeURIComponent(id)}`),
    threads: (agentId: string) =>
      request<{ data: AgentThread[] }>(
        "GET",
        `/api/agents/${encodeURIComponent(agentId)}/threads`,
      ),
    createThread: (agentId: string, title?: string) =>
      request<{ data: AgentThread }>(
        "POST",
        `/api/agents/${encodeURIComponent(agentId)}/threads`,
        title ? { title } : {},
      ),
    thread: (threadId: string) =>
      request<{
        data: {
          thread: AgentThread;
          messages: AgentMessage[];
          authors: AgentThreadAuthor[];
          agentIds?: string[];
          activeRuns?: AgentRun[];
        };
      }>("GET", `/api/agents/threads/${encodeURIComponent(threadId)}`),
    deleteThread: (threadId: string) =>
      request<{ ok: boolean }>(
        "DELETE",
        `/api/agents/threads/${encodeURIComponent(threadId)}`,
      ),
    send: ((
      threadId: string,
      message: string,
      opts?: { agentIds?: string[]; async?: boolean },
    ) =>
      request<{ data: AgentRunResult | AgentSendQueued }>(
        "POST",
        `/api/agents/threads/${encodeURIComponent(threadId)}/messages`,
        {
          message,
          ...(opts?.agentIds ? { agentIds: opts.agentIds } : {}),
          ...(opts?.async ? { async: true } : {}),
        },
      )) as AgentsClient["send"],
    run: async (agentId: string, message: string, title?: string) => {
      const { data: thread } = await agents.createThread(agentId, title);
      // The thread was opened against this agent, so it answers by default —
      // but pin it anyway so `run` means "this agent replies", full stop.
      const { data } = await agents.send(thread.id, message, { agentIds: [agentId] });
      return { data, threadId: thread.id };
    },
    rooms: () => request<{ data: AgentThread[] }>("GET", "/api/agents/threads"),
    createRoom: (input?: AgentRoomInput) =>
      request<{ data: AgentThread }>("POST", "/api/agents/threads", input ?? {}),
    updateRoom: (threadId: string, patch: Omit<AgentRoomInput, "agentIds">) =>
      request<{ ok: boolean }>(
        "PATCH",
        `/api/agents/threads/${encodeURIComponent(threadId)}`,
        patch,
      ),
    addRoomAgent: (threadId: string, agentId: string) =>
      request<{ ok: boolean }>(
        "POST",
        `/api/agents/threads/${encodeURIComponent(threadId)}/agents`,
        { agentId },
      ),
    removeRoomAgent: (threadId: string, agentId: string) =>
      request<{ ok: boolean }>(
        "DELETE",
        `/api/agents/threads/${encodeURIComponent(threadId)}/agents/${encodeURIComponent(agentId)}`,
      ),
    getRun: (runId: string) =>
      request<{ data: AgentRun }>(
        "GET",
        `/api/agents/runs/${encodeURIComponent(runId)}`,
      ),
    memory: (agentId: string, opts?: { threadId?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (opts?.threadId) qs.set("threadId", opts.threadId);
      if (opts?.limit != null) qs.set("limit", String(opts.limit));
      const suffix = qs.toString() ? `?${qs}` : "";
      return request<{ data: AgentMemory[]; meta?: { scope: AgentMemoryScope } }>(
        "GET",
        `/api/agents/${encodeURIComponent(agentId)}/memory${suffix}`,
      );
    },
    remember: (agentId: string, content: string, opts?: { threadId?: string }) =>
      request<{ data: AgentMemory | null; meta?: { deduped?: boolean } }>(
        "POST",
        `/api/agents/${encodeURIComponent(agentId)}/memory`,
        { content, ...(opts?.threadId ? { threadId: opts.threadId } : {}) },
      ),
    forget: (agentId: string, memoryId: string) =>
      request<{ ok: boolean }>(
        "DELETE",
        `/api/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(memoryId)}`,
      ),
  };

  // Permission tooling — the simulator dry-runs the resolver for any subject
  // and returns the full allow/deny trace. Admin-scoped, read-only.
  const permissions: PermissionsClient = {
    simulate: (input: PermissionSimulateInput) =>
      request<{ data: PermissionSimulation }>(
        "POST",
        "/api/permissions/simulate",
        input,
      ),
  };

  // Schema versions — migration diffing / schema branching over
  // `/api/admin/schema`. `import` stores an authored schema; `apply` reconciles
  // the live schema to a ref (destructive changes need confirmDestructive).
  const schemaBase = "/api/admin/schema";
  const schema: SchemaClient = {
    snapshots: () => request<{ data: SchemaSnapshotSummary[] }>("GET", `${schemaBase}/snapshots`),
    snapshot: (id: string) =>
      request<{ data: SchemaSnapshotRecord }>(
        "GET",
        `${schemaBase}/snapshots/${encodeURIComponent(id)}`,
      ),
    capture: (name: string, note?: string | null) =>
      request<{ data: SchemaSnapshotRecord }>("POST", `${schemaBase}/snapshots`, {
        name,
        note: note ?? null,
      }),
    import: (name: string, snapshot: SchemaSnapshotCollection[], note?: string | null) =>
      request<{ data: SchemaSnapshotRecord }>("POST", `${schemaBase}/snapshots/import`, {
        name,
        snapshot,
        note: note ?? null,
      }),
    deleteSnapshot: (id: string) =>
      request<{ ok: boolean }>("DELETE", `${schemaBase}/snapshots/${encodeURIComponent(id)}`),
    branches: () => request<{ data: SchemaBranch[] }>("GET", `${schemaBase}/branches`),
    branch: (id: string) =>
      request<{ data: SchemaBranch }>("GET", `${schemaBase}/branches/${encodeURIComponent(id)}`),
    createBranch: (name: string, opts?: { note?: string | null; fromSnapshotId?: string | null }) =>
      request<{ data: SchemaBranch }>("POST", `${schemaBase}/branches`, { name, ...opts }),
    setBranchHead: (
      id: string,
      opts: { data?: SchemaSnapshotCollection[]; fromSnapshotId?: string | null; name?: string },
    ) =>
      request<{ data: SchemaBranch }>(
        "PATCH",
        `${schemaBase}/branches/${encodeURIComponent(id)}/head`,
        opts,
      ),
    deleteBranch: (id: string) =>
      request<{ ok: boolean }>("DELETE", `${schemaBase}/branches/${encodeURIComponent(id)}`),
    diff: (from: SchemaRef, to: SchemaRef) =>
      request<{ data: { from: string; to: string; diff: SchemaDiff } }>(
        "POST",
        `${schemaBase}/diff`,
        { from, to },
      ),
    apply: (target: SchemaRef, opts?: { confirmDestructive?: boolean }) =>
      request<{ data: SchemaApplyResult }>("POST", `${schemaBase}/apply`, {
        target,
        confirmDestructive: opts?.confirmDestructive,
      }),
    cloneCollection: (slug: string, newSlug: string) =>
      request<{ data: Record<string, unknown> }>(
        "POST",
        `/api/collections/${encodeURIComponent(slug)}/clone`,
        { slug: newSlug },
      ),
  };

  // External-DB migration over `/api/admin/migrate` — saved sources +
  // durable server-side copy runs (docs/migrating-in.md).
  const migrateBase = "/api/admin/migrate";
  const migrate: MigrateClient = {
    sources: () => request<{ data: MigrateSource[] }>("GET", `${migrateBase}/sources`),
    createSource: (name: string, url: string) =>
      request<{ data: MigrateSource }>("POST", `${migrateBase}/sources`, { name, url }),
    deleteSource: (id: string) =>
      request<{ ok: boolean }>("DELETE", `${migrateBase}/sources/${encodeURIComponent(id)}`),
    testSource: (id: string) =>
      request<{ data: { ok: boolean; tables?: number; error?: string } }>(
        "POST",
        `${migrateBase}/sources/${encodeURIComponent(id)}/test`,
      ),
    sourceTables: (id: string) =>
      request<{ data: { name: string; approxRows: number | null }[] }>(
        "GET",
        `${migrateBase}/sources/${encodeURIComponent(id)}/tables`,
      ),
    plan: (id: string, tables?: string[]) =>
      request<{ data: unknown }>("POST", `${migrateBase}/sources/${encodeURIComponent(id)}/plan`, {
        tables,
      }),
    startRun: (sourceId: string, plan: unknown) =>
      request<{ data: MigrateRun }>("POST", `${migrateBase}/runs`, { sourceId, plan }),
    runs: () => request<{ data: MigrateRun[] }>("GET", `${migrateBase}/runs`),
    run: (id: string) =>
      request<{ data: MigrateRun }>("GET", `${migrateBase}/runs/${encodeURIComponent(id)}`),
    cancelRun: (id: string) =>
      request<{ data: MigrateRun }>("POST", `${migrateBase}/runs/${encodeURIComponent(id)}/cancel`),
    resumeRun: (id: string) =>
      request<{ data: MigrateRun }>("POST", `${migrateBase}/runs/${encodeURIComponent(id)}/resume`),
  };

  // Schema templates. Admin-scoped catalog + apply/extract over
  // `/api/admin/templates`; `apply`/`applyCustom` are idempotent and seed
  // groups, sample data and bundled roles/dashboards for new collections.
  const templates: TemplatesClient = {
    /** List the template catalog for the active workspace. */
    list: () => request<TemplateCatalog>("GET", "/api/admin/templates"),
    /** Seed a template's collections (and sample data) into the workspace. */
    apply: (templateId: string) =>
      request<{ data: ApplyTemplateResult }>("POST", "/api/admin/templates/apply", {
        templateId,
      }),
    /** Apply a custom template (the `extract()` shape). */
    applyCustom: (template: ExtractedTemplate) =>
      request<{ data: ApplyTemplateResult }>("POST", "/api/admin/templates/apply", {
        template,
      }),
    /** Remove every template-seeded sample row (seed-manifest scoped). */
    clearSamples: () =>
      request<{ data: ClearTemplateSamplesResult }>(
        "POST",
        "/api/admin/templates/clear-samples",
        {},
      ),
    /** Export the workspace schema as a reusable template. */
    extract: (opts?: { collections?: string[]; samples?: number }) =>
      request<{ data: ExtractedTemplate }>(
        "GET",
        (() => {
          const params = new URLSearchParams();
          if (opts?.collections?.length)
            params.set("collections", opts.collections.join(","));
          if (opts?.samples != null) params.set("samples", String(opts.samples));
          const qs = params.size ? `?${params.toString()}` : "";
          return `/api/admin/templates/extract${qs}`;
        })(),
      ),
  };

  // Workspace end-user provisioning (admin plane). The invitee accepts on an
  // app-mode client via `auth.acceptInvite`.
  const appUsers: AppUsersClient = {
    /** Invite an end-user (pending row + one-shot token; roles/link optional). */
    invite: (input: {
      email: string;
      name?: string;
      roleIds?: string[];
      link?: { collection: string; itemId: string };
    }) =>
      request<{ data: { id: string; email: string; token: string; expiresAt: number } }>(
        "POST",
        "/api/app-users/invite",
        input,
      ),
  };

  // Organizations. One namespace, two backends: an app-mode client talks to the
  // end-user surface under its workspace, an admin-mode client to the
  // control-plane one. Both are the same service behind different gates, so the
  // shapes coming back are identical.
  const orgBase = opts.workspace
    ? `/api/t/${encodeURIComponent(opts.workspace)}/orgs`
    : "/api/app-orgs";
  const orgPath = (idOrSlug: string, suffix = ""): string =>
    `${orgBase}/${encodeURIComponent(idOrSlug)}${suffix}`;

  const orgs: OrgsClient = {
    list: (o) =>
      request<{ data: Org[]; active?: { orgId: string | null; role: OrgRole | null } }>(
        "GET",
        `${orgBase}${o?.q ? `?q=${encodeURIComponent(o.q)}` : ""}`,
      ),
    get: (idOrSlug) => request<{ data: Org }>("GET", orgPath(idOrSlug)),
    create: (input) => request<{ data: Org }>("POST", orgBase, input),
    update: (idOrSlug, patch) =>
      request<{ data: Org }>("PATCH", orgPath(idOrSlug), patch),
    delete: (idOrSlug) => request<{ ok: boolean }>("DELETE", orgPath(idOrSlug)),

    members: (idOrSlug) =>
      request<{ data: OrgMember[] }>("GET", orgPath(idOrSlug, "/members")),
    addMember: (idOrSlug, input) =>
      request<{ data: OrgMember }>("POST", orgPath(idOrSlug, "/members"), input),
    updateMember: (idOrSlug, appUserId, patch) =>
      request<{ data: OrgMember }>(
        "PATCH",
        orgPath(idOrSlug, `/members/${encodeURIComponent(appUserId)}`),
        patch,
      ),
    removeMember: (idOrSlug, appUserId) =>
      request<{ ok: boolean }>(
        "DELETE",
        orgPath(idOrSlug, `/members/${encodeURIComponent(appUserId)}`),
      ),

    invites: (idOrSlug, o) =>
      request<{ data: OrgInvite[] }>(
        "GET",
        orgPath(idOrSlug, `/invites${o?.pending ? "?pending=true" : ""}`),
      ),
    invite: (idOrSlug, input) =>
      request<{
        data: { id: string; email: string; role: OrgRole; token: string; expiresAt: number };
      }>("POST", orgPath(idOrSlug, "/invites"), input),
    revokeInvite: (idOrSlug, inviteId) =>
      request<{ ok: boolean }>(
        "DELETE",
        orgPath(idOrSlug, `/invites/${encodeURIComponent(inviteId)}`),
      ),
    acceptInvite: (token) =>
      request<{ data: { org: Org; role: OrgRole } }>(
        "POST",
        `${orgBase}/invites/accept`,
        { token },
      ),

    setActive: (idOrSlug) =>
      request<{ data: Org | null }>("POST", `${orgBase}/set-active`, { orgId: idOrSlug }),
    leave: (idOrSlug) => request<{ ok: boolean }>("POST", orgPath(idOrSlug, "/leave")),

    use: (idOrSlug) => {
      activeOrg = idOrSlug;
    },
    active: () => activeOrg,
  };

  // Feature flags / remote config, evaluated for the current caller (targeting
  // rules + rollout already applied server-side).
  let flagsCache: Record<string, FlagState> | null = null;
  const fetchFlags = async (): Promise<Record<string, FlagState>> => {
    const res = await request<{ data: Record<string, FlagState> }>("GET", "/api/flags");
    flagsCache = res.data ?? {};
    return flagsCache;
  };
  const flags: FlagsClient = {
    /** Fetch + cache the evaluated flag map. */
    all: (): Promise<Record<string, FlagState>> => fetchFlags(),
    /** Resolved value for a flag (remote config payload), or `undefined`. Uses
     *  the cache if `all()` was already called this session; pass
     *  `{ refresh: true }` to force a re-fetch. */
    get: async (key: string, opts?: { refresh?: boolean }): Promise<unknown> => {
      const map = opts?.refresh || !flagsCache ? await fetchFlags() : flagsCache;
      return map[key]?.value;
    },
    /** Whether a flag is on for the caller. */
    isEnabled: async (key: string, opts?: { refresh?: boolean }): Promise<boolean> => {
      const map = opts?.refresh || !flagsCache ? await fetchFlags() : flagsCache;
      return Boolean(map[key]?.enabled);
    },
  };

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
    extensions,
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
