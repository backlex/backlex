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
  /** Cross-turn semantic memory (best-effort; needs an embedding provider). */
  memory: boolean;
  active: boolean;
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
  extensions: ExtensionsClient;
  /** Embedded BI dashboards. */
  dashboards: DashboardsClient;
  forms: FormsClient;
  /** Usage metering — per-day/per-key counters + workspace limits. */
  usage: UsageClient;
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
      headers: { ...authHeader(), ...tenantHeader(), "Tus-Resumable": "1.0.0" },
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
        headers: { ...authHeader(), ...tenantHeader() },
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
    extensions,
    dashboards,
    forms,
    usage,
    backups,
    agents,
    permissions,
    templates,
    appUsers,
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
  type SyncStore,
  type SyncOptions,
  type QueuedOp,
} from "./sync";

export { verifyWebhook, type VerifyWebhookOptions } from "./webhook";

export {
  createTokenVerifier,
  type AccessTokenClaims,
  type TokenVerifier,
  type TokenVerifierOptions,
} from "./token";
