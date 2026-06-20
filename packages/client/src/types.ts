import type { Condition } from "@backlex/core";

export interface ListResponse<T> {
  data: T[];
  limit: number;
  offset: number;
  meta?: { filter_count?: number; total_count?: number };
}

export interface ItemResponse<T> {
  data: T;
}

export interface ListQuery {
  filter?: Condition;
  sort?: string | string[];
  fields?: string | string[];
  /** Inline single-hop relations (replaces the FK with the related object). */
  expand?: string | string[];
  limit?: number;
  offset?: number;
  meta?: "filter_count" | "total_count" | "*";
  /** Collapse `i18n_text` fields to one locale, or `"*"` for the full map. */
  locale?: string;
  /** Free-text search — `_contains` OR'd across readable text fields. */
  q?: string;
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

export interface ItemEvent<T = Record<string, unknown>> {
  event: "created" | "updated" | "deleted";
  data: T;
}

export type BatchOperation<T = Record<string, unknown>> =
  | { op: "create"; data: Partial<T> }
  | { op: "update"; id: string; data: Partial<T> }
  | { op: "delete"; id: string };

export interface BatchRowResult<T = Record<string, unknown>> {
  index: number;
  op: "create" | "update" | "delete";
  ok: boolean;
  id?: string;
  data?: T;
  error?: { code: string; message: string };
}

export interface BatchResponse<T = Record<string, unknown>> {
  data: {
    atomic: boolean;
    total: number;
    succeeded: number;
    failed: number;
    results: BatchRowResult<T>[];
  };
}

export interface DeviceToken {
  id: string;
  platform: "fcm" | "apns" | "web-push";
  token: string;
  deviceName: string | null;
  isActive: boolean;
  createdAt: string | number;
  lastSeenAt: string | number | null;
}

export interface PhoneNumber {
  id: string;
  phoneNumber: string;
  isActive: boolean;
  createdAt: string | number;
  lastSeenAt: string | number | null;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

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
