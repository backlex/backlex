import type { ClientCore } from "../core";

/** Workspace usage-limit knobs. `null` = unlimited for that dimension. */
export interface UsageLimits {
  mode: "off" | "soft" | "hard";
  maxRequestsPerMonth: number | null;
  maxStorageBytes: number | null;
  maxDbRows: number | null;
  /** Generations per month. Calls, not tokens — the two provider paths report
   *  different quantities, so a call is the only unit both can be held to. */
  maxAiCallsPerMonth: number | null;
}

/** Admin usage overview — mirrors `GET /api/admin/usage/overview`. */
export interface UsageOverview {
  /** Current UTC month, `YYYY-MM`. */
  month: string;
  days: number;
  series: { day: string; requests: number; errors: number }[];
  /** Per-key day points (only days with traffic). `apiKeyId: ""` = sessions. */
  keySeries: { day: string; apiKeyId: string; requests: number; errors: number }[];
  monthTotals: { requests: number; errors: number };
  byKey: {
    /** API key id; empty string = the session / no-key traffic bucket. */
    id: string;
    name: string;
    prefix: string | null;
    revoked: boolean;
    rateLimitPerMinute: number | null;
    monthlyQuota: number | null;
    monthRequests: number;
    monthErrors: number;
  }[];
  gauges: {
    storageBytes: number | null;
    dbRows: number | null;
    measuredAt: number | null;
  };
  /** Effective limits — `USAGE_LIMIT_*` env overrides already applied. */
  limits: UsageLimits;
  /** The admin-editable setting values, before env overrides. */
  settingsLimits: UsageLimits;
  /** Limit fields pinned by env (read-only — the platform plan wins). */
  envPinned: ("mode" | "maxRequestsPerMonth" | "maxStorageBytes" | "maxDbRows" | "maxAiCallsPerMonth")[];
  /** Dimensions currently over their effective limit. */
  over: ("requests" | "storage" | "rows")[];
}

/** One raw ledger row from `GET /api/admin/usage/export`. */
export interface UsageExportRow {
  day: string;
  /** API key id; empty string = the session / no-key traffic bucket. */
  apiKeyId: string;
  keyName: string;
  keyPrefix: string | null;
  requests: number;
  errors: number;
  storageBytes: number | null;
  dbRows: number | null;
}

export interface UsageExport {
  from: string;
  to: string;
  rows: UsageExportRow[];
}

export interface UsageClient {
  /** Usage overview: day series, per-key month totals, gauges, limits. */
  overview(opts?: { days?: number }): Promise<{ data: UsageOverview }>;
  /** Raw ledger export for billing reconciliation — one row per (day, key).
   *  Defaults to the current UTC month-to-date. */
  export(opts?: { from?: string; to?: string }): Promise<{ data: UsageExport }>;
  /** Persist the workspace's admin-editable usage limits. */
  setLimits(limits: UsageLimits): Promise<{ ok: boolean }>;
}

export const makeUsage = (core: ClientCore): UsageClient => {
  // Usage metering. Admin-scoped over `/api/admin/usage`.
  const usage: UsageClient = {
    overview: (opts?: { days?: number }) =>
      core.request<{ data: UsageOverview }>(
        "GET",
        `/api/admin/usage/overview${opts?.days ? `?days=${Math.floor(opts.days)}` : ""}`,
      ),
    export: (opts?: { from?: string; to?: string }) => {
      const qs = new URLSearchParams();
      if (opts?.from) qs.set("from", opts.from);
      if (opts?.to) qs.set("to", opts.to);
      const suffix = qs.size > 0 ? `?${qs}` : "";
      return core.request<{ data: UsageExport }>("GET", `/api/admin/usage/export${suffix}`);
    },
    setLimits: (limits: UsageLimits) =>
      core.request<{ ok: boolean }>("PUT", "/api/admin/usage/limits", limits),
  };

  return usage;
};
