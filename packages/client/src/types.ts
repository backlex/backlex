/**
 * @module
 *
 * Wire types for the backlex client — the request/response shapes for list,
 * item, query, search, aggregate, batch, device tokens, jobs, uploads, and
 * feature flags, plus the {@link BacklexError} thrown on a failed request.
 */
import type { Condition } from "./condition";

/** Response from `from(slug).list(...)` — a page of rows + paging metadata. */
export interface ListResponse<T> {
  data: T[];
  limit: number;
  /** Present in classic offset paging; omitted when paging by `cursor`. */
  offset?: number;
  /** `true` when a further page exists (server derives it from a +1
   *  over-fetch, so it costs no extra COUNT round-trip). */
  has_more?: boolean;
  /** Opaque keyset cursor for the next page — only when paging by `cursor`,
   *  `null` on the final page. Echo it back as {@link ListQuery.cursor}. */
  next_cursor?: string | null;
  meta?: { filter_count?: number; total_count?: number };
}

/** Response wrapping a single row (`one` / `create` / `update`). */
export interface ItemResponse<T> {
  data: T;
}

/** Query params for `from(slug).list(...)` — filter, sort, projection, paging. */
export interface ListQuery {
  filter?: Condition;
  sort?: string | string[];
  fields?: string | string[];
  /** Inline single-hop relations (replaces the FK with the related object). */
  expand?: string | string[];
  limit?: number;
  offset?: number;
  /** Keyset (seek) pagination. Pass `""` to start, then echo back each
   *  response's `next_cursor`. O(1) per page at any depth and stable under
   *  concurrent inserts — unlike `offset`. When set, `offset` is ignored. */
  cursor?: string;
  meta?: "filter_count" | "total_count" | "*";
  /** Collapse `i18n_text` fields to one locale, or `"*"` for the full map. */
  locale?: string;
  /** Free-text search — `_contains` OR'd across readable text fields. */
  q?: string;
  /** Versioned collections only. `published` (default for unprivileged callers)
   *  returns published items; `draft` / `all` require `publish`/`update`
   *  permission, otherwise they're ignored and published-only is enforced. */
  status?: "draft" | "published" | "all";
}

/** Per-call options for `from(slug).one(id, ...)`. Mirrors the single-item
 *  read endpoint, which accepts the same `expand`/`locale` query params as the
 *  list endpoint. */
export interface ItemQuery {
  /** Inline single-hop relations (replaces the FK with the related object). */
  expand?: string | string[];
  /** Collapse `i18n_text` fields to one locale, or `"*"` for the full map. */
  locale?: string;
}

/** Body for `from(slug).aggregate(...)`. A single function over one column. */
export interface AggregateQuery {
  agg: "count" | "sum" | "avg" | "min" | "max";
  /** Target column. Required for sum/avg/min/max; omit (or "*") for count. */
  field?: string;
  /** Group by a single column — returns one `{ label, value }` row per group. */
  groupBy?: string;
  filter?: Condition;
  limit?: number;
}

/** A row from `aggregate`: `{ value }` ungrouped, or `{ label, value }` grouped. */
export interface AggregateRow {
  value: number;
  label?: unknown;
}

/** Body for `from(slug).search(...)` — relevance search over a collection. */
export interface SearchQuery {
  /** The query string. */
  q: string;
  /** `fts` = keyword index, `vector` = semantic embeddings, `hybrid` = both
   *  fused with Reciprocal Rank Fusion. Defaults server-side to `hybrid` when
   *  both backends are enabled, else whichever single one is. */
  mode?: "fts" | "vector" | "hybrid";
  /** Max rows to return (1–100, default 20). */
  limit?: number;
  /** Collapse `i18n_text` fields to one locale, or `"*"` for the full map. */
  locale?: string;
}

/** Response from `from(slug).search(...)` — rows ordered best-first. */
export interface SearchResponse<T> {
  data: T[];
  /** The mode that actually ran (resolved from the request + collection caps). */
  mode: "fts" | "vector" | "hybrid";
  limit: number;
}

/** Summary from `from(slug).importItems(...)` — per-row outcome of a bulk
 *  import. `errors` is capped to the first 50 failures server-side. */
export interface ImportSummary {
  inserted: number;
  failed: number;
  total: number;
  errors: { row: number; error: string }[];
}

/** A realtime event delivered to `subscribe(...)`. */
export interface ItemEvent<T = Record<string, unknown>> {
  event: "created" | "updated" | "deleted";
  data: T;
}

/** One operation in a `batch(...)` request. */
export type BatchOperation<T = Record<string, unknown>> =
  | { op: "create"; data: Partial<T> }
  | { op: "update"; id: string; data: Partial<T> }
  | { op: "delete"; id: string };

/** Per-row outcome inside a {@link BatchResponse}. */
export interface BatchRowResult<T = Record<string, unknown>> {
  index: number;
  op: "create" | "update" | "delete";
  ok: boolean;
  id?: string;
  data?: T;
  error?: { code: string; message: string };
}

/** Response from a bulk `createMany`/`updateMany`/`deleteMany`/`batch` call. */
export interface BatchResponse<T = Record<string, unknown>> {
  data: {
    atomic: boolean;
    total: number;
    succeeded: number;
    failed: number;
    results: BatchRowResult<T>[];
  };
}

/** Per-key outcome inside a {@link BulkUpdateResponse}. */
export interface BulkUpdateRowResult {
  id: string;
  ok: boolean;
  error?: { code: string; message: string };
}

/** Response from a `bulkUpdate(keys, data)` call — one shared patch over many
 *  ids, partial-success (a key the caller can't write is `NOT_FOUND`). */
export interface BulkUpdateResponse {
  data: {
    total: number;
    updated: number;
    failed: number;
    results: BulkUpdateRowResult[];
  };
}

/** A registered push device (from `messaging.listDevices()`). */
export interface DeviceToken {
  id: string;
  platform: "fcm" | "apns" | "web-push";
  token: string;
  deviceName: string | null;
  isActive: boolean;
  createdAt: string | number;
  lastSeenAt: string | number | null;
}

/** A registered SMS phone number (from `messaging.listPhones()`). */
export interface PhoneNumber {
  id: string;
  phoneNumber: string;
  isActive: boolean;
  createdAt: string | number;
  lastSeenAt: string | number | null;
}

/** Lifecycle state of a durable {@link Job}. */
export type JobStatus =
  | "pending"
  | "active"
  | "succeeded"
  | "failed"
  | "dead_letter"
  | "cancelled";

/** A durable background job row (from `jobs.get`/`jobs.list`). */
export interface Job {
  id: string;
  tenantId: string | null;
  queue: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  runAt: string | number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  result: unknown;
  createdAt: string | number;
  completedAt: string | number | null;
}

/** Status of a resumable {@link Upload} session. */
export type UploadStatus = "pending" | "completed" | "aborted";

/** A resumable (TUS) upload session, as returned by the management API. */
export interface Upload {
  id: string;
  key: string;
  size: number;
  offset: number;
  status: UploadStatus;
  contentType: string | null;
  folderId: string | null;
  parts: number;
  createdAt: string | number;
  updatedAt: string | number;
  expiresAt: string | number;
}

/** Result of a resumable upload — the final key and the TUS session location. */
export interface ResumableUploadResult {
  key: string;
  location: string;
}

/** One evaluated feature flag for the calling identity. */
export interface FlagState {
  enabled: boolean;
  value: unknown;
}

/** The error envelope returned by the API on a failed request. */
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

/** Thrown by every client method on a non-2xx response — carries the HTTP
 *  `status`, the API error `code`, the `message`, and any `details`. */
export class BacklexError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(status: number, body: { error?: ApiError } | undefined) {
    const e = body?.error;
    super(e?.message ?? `HTTP ${status}`);
    this.code = e?.code ?? "UNKNOWN";
    this.status = status;
    this.details = e?.details;
  }
}
