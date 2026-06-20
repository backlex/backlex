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
  type PhoneNumber,
  type Job,
  type JobStatus,
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
  BatchOperation,
  BatchResponse,
  DeviceToken,
  PhoneNumber,
  Job,
  JobStatus,
} from "./types";
export { BacklexError } from "./types";
export { QueryBuilder } from "./query";
export type { FilterBuilder, FieldKey, SortKey } from "./query";

import { QueryBuilder } from "./query";

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

interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
}
interface AuthResult {
  user: AuthUser;
  token?: string;
}
interface AuthSession {
  id: string;
  token: string;
  userId: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
  updatedAt: string;
}
interface PublicProvider {
  id: string;
  kind: "credential" | "magic-link" | "email-otp" | "passkey" | "social";
  label: string;
  enabled: boolean;
}
interface AuthSurface {
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

export const createClient = (opts: ClientOptions) => {
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

  const collection = <T extends Record<string, unknown>>(slug: string) => {
    const list = (q?: ListQuery): Promise<ListResponse<T>> =>
      request<ListResponse<T>>("GET", `/api/items/${slug}${buildSearch(q)}`);
    return {
      list,
      /** Fluent, type-safe query builder that compiles to `ListQuery`. */
      query: (): QueryBuilder<T> => new QueryBuilder<T>(list),
      /** Run a single-function aggregate (count/sum/avg/min/max), optionally grouped. */
      aggregate: (body: AggregateQuery): Promise<{ data: AggregateRow[] }> =>
        request<{ data: AggregateRow[] }>("POST", `/api/items/${slug}/aggregate`, body),
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
      /** Flip a versioned item to published (`_status`). */
      publish: (id: string): Promise<ItemResponse<T>> =>
        request<ItemResponse<T>>("POST", `/api/items/${slug}/${id}/publish`),
      /** Flip a versioned item back to draft. */
      unpublish: (id: string): Promise<ItemResponse<T>> =>
        request<ItemResponse<T>>("POST", `/api/items/${slug}/${id}/publish?unpublish=1`),
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

  const auth = {
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

  const storage = {
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
  };

  const messaging = {
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

  const jobs = {
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

  return {
    from: collection,
    subscribe,
    auth,
    storage,
    messaging,
    jobs,
    /** Raw escape hatch — issues a request with auth headers applied. */
    request,
  };
};

export type BacklexClient = ReturnType<typeof createClient>;
