import {
  type ItemEvent,
  type ItemResponse,
  type ListQuery,
  type ListResponse,
  WorkerosError,
} from "./types";

export type { ListQuery, ListResponse, ItemResponse, ItemEvent } from "./types";
export { WorkerosError } from "./types";

export interface ClientOptions {
  url: string;
  /** Static API key (`pak_...`) for server-to-server calls. Browser apps
   *  should rely on the cookie session and omit this. */
  apiKey?: string;
  /** Optional fetch override (testing / Node polyfill). */
  fetch?: typeof fetch;
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

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
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
      throw new WorkerosError(res.status, errBody);
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

  const auth = {
    signUp: (input: { email: string; password: string; name?: string }) =>
      request<{ user: { id: string; email: string }; token?: string }>(
        "POST",
        "/api/auth/sign-up/email",
        input,
      ),
    signIn: (input: { email: string; password: string }) =>
      request<{ user: { id: string; email: string }; token?: string }>(
        "POST",
        "/api/auth/sign-in/email",
        input,
      ),
    signOut: () => request<{ success: boolean }>("POST", "/api/auth/sign-out"),
    session: () =>
      request<{ user: { id: string; email: string } | null }>(
        "GET",
        "/api/auth/get-session",
      ),
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
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
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
        throw new WorkerosError(res.status, errBody);
      }
      return res.json();
    },
    download: async (key: string): Promise<Response> => {
      const headers: Record<string, string> = opts.apiKey
        ? { authorization: `Bearer ${opts.apiKey}` }
        : {};
      const res = await f(`${opts.url}/api/storage/${encodeURIComponent(key)}`, {
        credentials: "include",
        headers,
      });
      if (!res.ok) {
        throw new WorkerosError(res.status, undefined);
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

export type WorkerosClient = ReturnType<typeof createClient>;
