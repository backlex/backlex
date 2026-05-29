import {
  type ItemEvent,
  type ItemResponse,
  type ListQuery,
  type ListResponse,
  BacklexError,
} from "./types";

export type { ListQuery, ListResponse, ItemResponse, ItemEvent } from "./types";
export { BacklexError } from "./types";

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
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  if (q.offset !== undefined) params.set("offset", String(q.offset));
  if (q.meta) params.set("meta", q.meta);
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

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...authHeader(),
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

  const collection = <T extends Record<string, unknown>>(slug: string) => ({
    list: (q?: ListQuery): Promise<ListResponse<T>> =>
      request<ListResponse<T>>("GET", `/api/items/${slug}${buildSearch(q)}`),
    one: (id: string): Promise<ItemResponse<T>> =>
      request<ItemResponse<T>>("GET", `/api/items/${slug}/${id}`),
    create: (data: Partial<T>): Promise<ItemResponse<T>> =>
      request<ItemResponse<T>>("POST", `/api/items/${slug}`, data),
    update: (id: string, patch: Partial<T>): Promise<ItemResponse<T>> =>
      request<ItemResponse<T>>("PATCH", `/api/items/${slug}/${id}`, patch),
    delete: (id: string): Promise<{ ok: boolean }> =>
      request<{ ok: boolean }>("DELETE", `/api/items/${slug}/${id}`),
  });

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
    signOut: () => request<{ success: boolean }>("POST", `${authBase}/sign-out`).then((r) => {
      if (opts.workspace) appToken = null;
      return r;
    }),
    /** Current session, or `{ user: null }`. */
    getSession: () =>
      request<{ user: AuthUser | null } & Record<string, unknown>>("GET", `${authBase}/get-session`),
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
        headers: authHeader(),
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

  return {
    from: collection,
    subscribe,
    auth,
    storage,
    /** Raw escape hatch — issues a request with auth headers applied. */
    request,
  };
};

export type BacklexClient = ReturnType<typeof createClient>;
