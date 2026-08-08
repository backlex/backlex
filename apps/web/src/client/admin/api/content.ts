import { api } from "@/lib/api";
import type { Envelope } from "./types";

export interface ApiI18nString {
  id: string;
  tenantId: string | null;
  key: string;
  locale: string;
  value: string;
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
