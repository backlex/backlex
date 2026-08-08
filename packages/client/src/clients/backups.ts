import type { ClientCore } from "../core";

/** One backup tracking row. `status` moves queued → running → done/failed. */
export interface BackupRecord {
  id: string;
  tenantId: string | null;
  /** `manual` (taken via API/UI) or `auto` (scheduled from the cron tick). */
  kind: string;
  label: string | null;
  storageKey: string;
  size: number;
  tableCount: number;
  status: string;
  createdBy: string | null;
  createdAt: unknown;
}

/** Per-workspace automatic-backup schedule. */
export interface BackupScheduleConfig {
  schedule: "off" | "daily" | "weekly";
  retain: number;
  /** Age-based retention on top of the count — auto backups older than this
   *  many days are pruned. `null` disables the age rule. */
  retainDays: number | null;
}

/** Result of an additive restore (`ON CONFLICT DO NOTHING`). */
export interface BackupRestoreResult {
  tableCount: number;
  rowCount: number;
  skipped: number;
}

/** Backup / restore (admin-scoped). Mirrors `/api/admin/db/backups*`. */
export interface BackupsClient {
  /** Backup tracking rows for the active workspace, newest first. */
  list(): Promise<{ data: BackupRecord[] }>;
  /** Run a manual backup now; resolves once the dump is done/failed. */
  run(opts?: { label?: string }): Promise<{ data: BackupRecord }>;
  /** Additively restore a backup — missing rows come back, existing rows are
   *  never overwritten or removed. Sends the confirm header for you. */
  restore(id: string): Promise<{ data: BackupRestoreResult }>;
  /** Get the automatic-backup schedule + retention count. */
  getConfig(): Promise<{ data: BackupScheduleConfig }>;
  /** Set the automatic-backup schedule and/or retention count. */
  setConfig(
    patch: Partial<BackupScheduleConfig>,
  ): Promise<{ data: BackupScheduleConfig }>;
}

export const makeBackups = (core: ClientCore): BackupsClient => {
  // Backup / restore. Admin-scoped over `/api/admin/db/backups*`; `run` blocks
  // until the dump finishes, `restore` carries the confirm header the REST
  // endpoint requires (the restore itself is additive — never overwrites).
  const backups: BackupsClient = {
    list: () => core.request<{ data: BackupRecord[] }>("GET", "/api/admin/db/backups"),
    run: (opts?: { label?: string }) =>
      core.request<{ data: BackupRecord }>(
        "POST",
        "/api/admin/db/backups/now",
        opts?.label ? { label: opts.label } : {},
      ),
    restore: (id: string) =>
      core.request<{ data: BackupRestoreResult }>(
        "POST",
        `/api/admin/db/backups/${encodeURIComponent(id)}/restore`,
        undefined,
        { "x-backlex-confirm": "yes" },
      ),
    getConfig: () =>
      core.request<{ data: BackupScheduleConfig }>("GET", "/api/admin/db/backups/config"),
    setConfig: (patch: Partial<BackupScheduleConfig>) =>
      core.request<{ data: BackupScheduleConfig }>("PUT", "/api/admin/db/backups/config", patch),
  };

  return backups;
};
