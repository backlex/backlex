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
import { createSync, type SyncController, type SyncOptions } from "./sync";

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
  const s = params.toString();
  return s ? `?${s}` : "";
};

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
  create(data: Partial<T>): Promise<ItemResponse<T>>;
  update(id: string, patch: Partial<T>): Promise<ItemResponse<T>>;
  delete(id: string): Promise<{ ok: boolean }>;
  createMany(rows: Partial<T>[], opts?: { atomic?: boolean }): Promise<BatchResponse<T>>;
  updateMany(
    updates: { id: string; data: Partial<T> }[],
    opts?: { atomic?: boolean },
  ): Promise<BatchResponse<T>>;
  deleteMany(ids: string[], opts?: { atomic?: boolean }): Promise<BatchResponse<T>>;
  batch(operations: BatchOperation<T>[], opts?: { atomic?: boolean }): Promise<BatchResponse<T>>;
  publish(id: string): Promise<ItemResponse<T>>;
  unpublish(id: string): Promise<ItemResponse<T>>;
  schedulePublish(id: string, at: Date | string | null): Promise<ItemResponse<T>>;
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
  /** Auth surface (sign-in/up, sessions, tokens). */
  auth: AuthClient;
  /** File storage + resumable uploads. */
  storage: StorageClient;
  /** Push + SMS device registration. */
  messaging: MessagingClient;
  /** Durable background job queue. */
  jobs: JobsClient;
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

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...authHeader(),
      ...tenantHeader(),
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
      create: (data: Partial<T>): Promise<ItemResponse<T>> =>
        request<ItemResponse<T>>("POST", `/api/items/${slug}`, data),
      update: (id: string, patch: Partial<T>): Promise<ItemResponse<T>> =>
        request<ItemResponse<T>>("PATCH", `/api/items/${slug}/${id}`, patch),
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
      /** Schedule a versioned item to auto-publish at `at` (the cron tick applies
       *  it when due). Pass `null` to cancel a pending schedule. Requires the
       *  `publish` permission. */
      schedulePublish: (id: string, at: Date | string | null): Promise<ItemResponse<T>> =>
        request<ItemResponse<T>>("POST", `/api/items/${slug}/${id}/publish`, {
          publishAt: at == null ? null : at instanceof Date ? at.toISOString() : at,
        }),
    };
  };

  const subscribe = <T = Record<string, unknown>>(
    channel: string,
    onEvent: (e: ItemEvent<T>) => void,
    onError?: (err: unknown) => void,
  ): (() => void) => {
    const url = `${opts.url}/api/realtime/${channel}/subscribe`;
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

  return {
    from: collection,
    subscribe,
    auth,
    storage,
    messaging,
    jobs,
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
