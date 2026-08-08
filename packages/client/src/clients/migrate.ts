import type { ClientCore } from "../core";

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

export const makeMigrate = (core: ClientCore): MigrateClient => {
  // External-DB migration over `/api/admin/migrate` — saved sources +
  // durable server-side copy runs (docs/migrating-in.md).
  const migrateBase = "/api/admin/migrate";
  const migrate: MigrateClient = {
    sources: () => core.request<{ data: MigrateSource[] }>("GET", `${migrateBase}/sources`),
    createSource: (name: string, url: string) =>
      core.request<{ data: MigrateSource }>("POST", `${migrateBase}/sources`, { name, url }),
    deleteSource: (id: string) =>
      core.request<{ ok: boolean }>("DELETE", `${migrateBase}/sources/${encodeURIComponent(id)}`),
    testSource: (id: string) =>
      core.request<{ data: { ok: boolean; tables?: number; error?: string } }>(
        "POST",
        `${migrateBase}/sources/${encodeURIComponent(id)}/test`,
      ),
    sourceTables: (id: string) =>
      core.request<{ data: { name: string; approxRows: number | null }[] }>(
        "GET",
        `${migrateBase}/sources/${encodeURIComponent(id)}/tables`,
      ),
    plan: (id: string, tables?: string[]) =>
      core.request<{ data: unknown }>("POST", `${migrateBase}/sources/${encodeURIComponent(id)}/plan`, {
        tables,
      }),
    startRun: (sourceId: string, plan: unknown) =>
      core.request<{ data: MigrateRun }>("POST", `${migrateBase}/runs`, { sourceId, plan }),
    runs: () => core.request<{ data: MigrateRun[] }>("GET", `${migrateBase}/runs`),
    run: (id: string) =>
      core.request<{ data: MigrateRun }>("GET", `${migrateBase}/runs/${encodeURIComponent(id)}`),
    cancelRun: (id: string) =>
      core.request<{ data: MigrateRun }>("POST", `${migrateBase}/runs/${encodeURIComponent(id)}/cancel`),
    resumeRun: (id: string) =>
      core.request<{ data: MigrateRun }>("POST", `${migrateBase}/runs/${encodeURIComponent(id)}/resume`),
  };

  return migrate;
};
