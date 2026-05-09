import type { Condition } from "@workeros/core";

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
  limit?: number;
  offset?: number;
  meta?: "filter_count" | "total_count" | "*";
}

export interface ItemEvent<T = Record<string, unknown>> {
  event: "created" | "updated" | "deleted";
  data: T;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export class WorkerosError extends Error {
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
