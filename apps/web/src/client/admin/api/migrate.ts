import { api } from "@/lib/api";
import type { Envelope } from "./types";

export interface ApiMigrateSource {
  id: string;
  name: string;
  kind: string;
  /** Redacted — scheme + host + database, credentials never leave the server. */
  urlMasked: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ApiMigratePlanField {
  column: string;
  name: string;
  type: string;
  required?: boolean;
  to?: string;
  choices?: string[];
}

export interface ApiMigratePlanTable {
  table: string;
  slug: string;
  include: boolean;
  reason?: string;
  pkColumn: string;
  pkType: "uuid" | "text" | "integer";
  createdAtColumn: string | null;
  updatedAtColumn: string | null;
  fields: ApiMigratePlanField[];
  warnings: string[];
  approxRows: number | null;
}

export interface ApiMigratePlan {
  version: 1;
  source: { kind: string };
  order: string[];
  tables: ApiMigratePlanTable[];
}

export type ApiMigrateRunStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface ApiMigrateRunTable {
  table: string;
  copied: number;
  failed: number;
  done: boolean;
  sourceCount?: number;
  targetTotal?: number;
}

export interface ApiMigrateRun {
  id: string;
  sourceId: string;
  status: ApiMigrateRunStatus;
  error: string | null;
  plan: ApiMigratePlan;
  state: { tables: Record<string, ApiMigrateRunTable> };
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const migrateApi = {
  sources: () => api<Envelope<ApiMigrateSource[]>>(`/api/admin/migrate/sources`),
  createSource: (name: string, url: string) =>
    api<Envelope<ApiMigrateSource>>(`/api/admin/migrate/sources`, {
      method: "POST",
      body: JSON.stringify({ name, url }),
    }),
  deleteSource: (id: string) =>
    api<{ ok: true }>(`/api/admin/migrate/sources/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  testSource: (id: string) =>
    api<Envelope<{ ok: boolean; tables?: number; error?: string }>>(
      `/api/admin/migrate/sources/${encodeURIComponent(id)}/test`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  sourceTables: (id: string) =>
    api<Envelope<{ name: string; approxRows: number | null }[]>>(
      `/api/admin/migrate/sources/${encodeURIComponent(id)}/tables`,
    ),
  plan: (id: string, tables?: string[]) =>
    api<Envelope<ApiMigratePlan>>(
      `/api/admin/migrate/sources/${encodeURIComponent(id)}/plan`,
      { method: "POST", body: JSON.stringify({ tables }) },
    ),
  runs: () => api<Envelope<ApiMigrateRun[]>>(`/api/admin/migrate/runs`),
  run: (id: string) =>
    api<Envelope<ApiMigrateRun>>(`/api/admin/migrate/runs/${encodeURIComponent(id)}`),
  startRun: (sourceId: string, plan: ApiMigratePlan) =>
    api<Envelope<ApiMigrateRun>>(`/api/admin/migrate/runs`, {
      method: "POST",
      body: JSON.stringify({ sourceId, plan }),
    }),
  cancelRun: (id: string) =>
    api<Envelope<ApiMigrateRun>>(`/api/admin/migrate/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  resumeRun: (id: string) =>
    api<Envelope<ApiMigrateRun>>(`/api/admin/migrate/runs/${encodeURIComponent(id)}/resume`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
};

// ── Product analytics + crash reporting (#22) ────────────────────────────────
