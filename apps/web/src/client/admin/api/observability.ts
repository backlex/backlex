import { api } from "@/lib/api";
import type { Envelope } from "./types";

export interface ApiMetrics {
  range: string;
  windowMs: number;
  bucketMs: number;
  series: { ts: number; requests: number; errors: number }[];
  totals: { requests: number; errors: number; errorRate: number; activeUsers: number; p95Ms?: number };
  counts: {
    collections: number;
    files: number;
    flows: number;
    functions: number;
    activeFlows: number;
    pausedFlows: number;
  };
  topCollections?: { slug: string; rows: number; bytes?: number; lastWrite: number | null; writes24h?: number }[];
  recent?: { t: number; action: string; collection?: string; itemId?: string | null; userId?: string | null; ms?: number | null; error?: boolean }[];
  recentErrors?: { code: string; resource: string; msg: string; count: number; last: number }[];
}

export interface ApiEntityMetrics {
  flows: Record<string, { runs: number; lastRun: number | null }>;
  functions: Record<string, { invocations: number; p95Ms: number; lastInvoke: number | null }>;
  webhooks: Record<string, { deliveries: number; lastDelivery: number | null }>;
}

export const metricsApi = {
  overview: (range = "1h") => api<Envelope<ApiMetrics>>(`/api/admin/metrics/overview?range=${range}`),
  entities: () => api<Envelope<ApiEntityMetrics>>(`/api/admin/metrics/entities`),
};

/** Advisor finding (`GET /api/admin/advisor`). */
export interface ApiAdvisorCheck {
  id: string;
  kind: "security" | "performance";
  level: "error" | "warn" | "info";
  /** Stable rule-family identifier — findings sharing it are grouped. */
  rule: string;
  /** Category label shown when several findings share the same `rule`. */
  groupTitle: string;
  title: string;
  body: string;
  fix: string;
  resource: string;
  /** Optional admin SPA route path to the relevant surface. */
  link?: string;
  /** Present when the advisor can apply the fix itself. */
  action?: ApiAdvisorAction;
  /** Observed numbers behind a traffic-derived finding. Its presence is what
   *  marks a finding as measured rather than inferred from the schema. */
  evidence?: {
    /** Requests observed in the window — spans seen, never extrapolated. */
    requests: number;
    windowDays: number;
    p95?: number;
    errorRate?: number;
    /** Share of the collection's list traffic touching the column, 0..1. */
    share?: number;
  };
}

/** A fix the server can carry out itself (`POST /api/admin/advisor/apply`). */
export interface ApiAdvisorAction {
  type: "create-index";
  table: string;
  indexName: string;
  columns: string[];
  /** Informational — the server re-derives it and never accepts one back. */
  sql: string;
}

/** Advisor run result (`GET /api/admin/advisor`). */
export interface ApiAdvisorResult {
  data: ApiAdvisorCheck[];
  /** 0–100 server-computed health score. */
  score: number;
  /** ISO timestamp — one honest value per run. */
  generatedAt: string;
  /** What the traffic-derived rules had to work with. `spanCount: 0` means no
   *  runtime rule could fire — not the same as "no problems found". */
  runtime: {
    windowDays: number;
    spanCount: number;
    sampleRate: number;
    truncated: boolean;
  };
}

/** One endpoint's latency + error profile (`GET /api/admin/advisor/insights`). */
export interface ApiAdvisorEndpointStat {
  /** `GET /api/items/posts/:id`. */
  route: string;
  method: string;
  path: string;
  requests: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  avgMs: number;
  serverErrors: number;
  clientErrors: number;
  errorRate: number;
}

export interface ApiAdvisorColumnUse {
  column: string;
  requests: number;
  /** Share of the collection's list requests touching this column, 0..1. */
  share: number;
}

export interface ApiAdvisorCollectionStat {
  collection: string;
  listRequests: number;
  p50: number;
  p95: number;
  filters: ApiAdvisorColumnUse[];
  sorts: ApiAdvisorColumnUse[];
}

export interface ApiAdvisorInsights {
  /** Slowest first (p95 desc, ties broken by traffic). */
  endpoints: ApiAdvisorEndpointStat[];
  /** Busiest first. */
  collections: ApiAdvisorCollectionStat[];
  window: {
    from: number;
    to: number;
    days: number;
    spanCount: number;
    /** Start of the oldest span seen. Well after `from` means span retention,
     *  not traffic, bounded the window. */
    oldestSpanAt: number | null;
    /** `TRACES_SAMPLE_RATE`. Below 1, the numbers describe a sample. */
    sampleRate: number;
    truncated: boolean;
  };
}

export const advisorApi = {
  list: (days?: number) =>
    api<ApiAdvisorResult>(
      `/api/admin/advisor${days ? `?days=${days}` : ""}`,
    ),
  insights: (days?: number) =>
    api<ApiAdvisorInsights>(
      `/api/admin/advisor/insights${days ? `?days=${days}` : ""}`,
    ),
  /** Apply a finding's fix. Only the id goes over the wire — the server
   *  re-runs the advisor and executes the statement it derives itself. */
  apply: (id: string, days?: number) =>
    api<{ ok: true; applied: ApiAdvisorAction }>(`/api/admin/advisor/apply`, {
      method: "POST",
      body: JSON.stringify(days ? { id, days } : { id }),
    }),
};

export interface ApiTraceSummary {
  traceId: string;
  name: string;
  rootStatus: number | null;
  spanCount: number;
  durationMs: number;
  startedAt: number;
  hasError: boolean;
}

export interface ApiSpan {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  method: string | null;
  path: string | null;
  status: number | null;
  userId: string | null;
  durationMs: number | null;
  attributes: Record<string, unknown> | null;
  startedAt: number;
}

export interface TracesListParams {
  path?: string;
  minStatus?: number;
  limit?: number;
  from?: number;
}

export const tracesApi = {
  list: (opts?: TracesListParams) => {
    const qs = new URLSearchParams();
    if (opts?.path) qs.set("path", opts.path);
    if (opts?.minStatus != null) qs.set("minStatus", String(opts.minStatus));
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    if (opts?.from != null) qs.set("from", String(opts.from));
    const tail = qs.toString();
    return api<Envelope<ApiTraceSummary[]>>(
      `/api/admin/traces${tail ? `?${tail}` : ""}`,
    );
  },
  get: (traceId: string) =>
    api<{ traceId: string; spans: ApiSpan[] }>(
      `/api/admin/traces/${encodeURIComponent(traceId)}`,
    ),
};

// ── Usage metering (#12) ─────────────────────────────────────────────────────

export interface ApiUsageLimits {
  mode: "off" | "soft" | "hard";
  maxRequestsPerMonth: number | null;
  maxStorageBytes: number | null;
  maxDbRows: number | null;
  maxAiCallsPerMonth: number | null;
}

export interface ApiUsageOverview {
  month: string;
  days: number;
  series: { day: string; requests: number; errors: number }[];
  /** Per-key day points (only days with traffic). `apiKeyId: ""` = sessions. */
  keySeries: { day: string; apiKeyId: string; requests: number; errors: number }[];
  monthTotals: { requests: number; errors: number };
  byKey: {
    /** Empty id = the session / no-API-key traffic bucket. */
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
  limits: ApiUsageLimits;
  settingsLimits: ApiUsageLimits;
  envPinned: ("mode" | "maxRequestsPerMonth" | "maxStorageBytes" | "maxDbRows" | "maxAiCallsPerMonth")[];
  over: ("requests" | "storage" | "rows")[];
}

export const usageApi = {
  overview: (days?: number) =>
    api<Envelope<ApiUsageOverview>>(
      `/api/admin/usage/overview${days ? `?days=${days}` : ""}`,
    ),
  setLimits: (limits: ApiUsageLimits) =>
    api<{ ok: boolean }>(`/api/admin/usage/limits`, {
      method: "PUT",
      body: JSON.stringify(limits),
    }),
  setKeyLimits: (
    id: string,
    patch: { rateLimitPerMinute?: number | null; monthlyQuota?: number | null },
  ) =>
    api<{ ok: boolean }>(`/api/api-keys/${encodeURIComponent(id)}/limits`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
};

// ── External-DB migration (docs/migrating-in.md) ─────────────────────────────

/** One top-N row over a dimension. `users` is distinct visitors — the figure a
 *  website report leads with. */
export interface ApiAnalyticsBreakdown {
  value: string;
  count: number;
  users: number;
}

export interface ApiAnalyticsOverview {
  totals: {
    events: number;
    /** Distinct visitor ids in range. Inflated for `cookielessShare` of
     *  traffic, whose ids rotate at UTC midnight — the page shows
     *  `visitorsPerDay` instead when that share is non-zero. */
    users: number;
    sessions: number;
    /** Unique visitors among non-rotating ids; correct over any range. */
    durableUsers: number;
    /** Mean distinct cookieless visitors per active day, or null when none. */
    visitorsPerDay: number | null;
    /** Fraction of events carrying a rotating id, 0..1. */
    cookielessShare: number;
  };
  series: { day: string; events: number; users: number }[];
  topEvents: { name: string; count: number; users: number }[];
  topPaths: { path: string; count: number; users: number }[];
  topReferrers: { referrer: string; count: number; users: number }[];
  sources: { source: string; count: number; users: number }[];
  topCountries: ApiAnalyticsBreakdown[];
  topDevices: ApiAnalyticsBreakdown[];
  topCampaigns: ApiAnalyticsBreakdown[];
}

export interface ApiAnalyticsFunnel {
  windowDays: number;
  steps: { name: string; count: number; conversion: number; dropOff: number }[];
}

export interface ApiAnalyticsRetention {
  maxOffset: number;
  cohorts: { day: string; size: number; values: number[] }[];
}

export interface ApiAnalyticsEvent {
  id: string;
  name: string;
  distinctId: string;
  userId: string | null;
  sessionId: string | null;
  props: Record<string, unknown> | null;
  path: string | null;
  referrer: string | null;
  source: string | null;
  release: string | null;
  country: string | null;
  siteId: string | null;
  idScope: string | null;
  deviceType: string | null;
  browser: string | null;
  os: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  revenue: number | null;
  currency: string | null;
  ts: number;
}

export type ApiErrorStatus = "open" | "resolved" | "ignored";

export interface ApiErrorGroup {
  id: string;
  fingerprint: string;
  type: string;
  message: string;
  culprit: string | null;
  level: string;
  platform: string | null;
  release: string | null;
  status: ApiErrorStatus;
  events: number;
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

export interface ApiErrorOccurrence {
  id: string;
  message: string;
  stack: string | null;
  level: string;
  platform: string | null;
  release: string | null;
  url: string | null;
  userId: string | null;
  distinctId: string | null;
  sessionId: string | null;
  context: Record<string, unknown> | null;
  ts: number;
}

export interface ApiErrorGroupDetail {
  group: ApiErrorGroup;
  occurrences: ApiErrorOccurrence[];
  series: { day: string; count: number }[];
  users: number;
}

/** Build a query string, dropping empty values. */
const analyticsQs = (params: Record<string, string | number | undefined>): string => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const tail = qs.toString();
  return tail ? `?${tail}` : "";
};

export interface ApiAnalyticsSite {
  id: string;
  name: string;
  domain: string;
  tz: string;
  excludedPaths: string[];
  ignoredIps: string[];
  filterBots: boolean;
  requireKnownOrigin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ApiAnalyticsSiteInput {
  name: string;
  domain: string;
  excludedPaths?: string[];
  ignoredIps?: string[];
  filterBots?: boolean;
  requireKnownOrigin?: boolean;
}

export const analyticsApi = {
  sites: () => api<Envelope<ApiAnalyticsSite[]>>("/api/admin/analytics/sites"),
  createSite: (body: ApiAnalyticsSiteInput) =>
    api<Envelope<ApiAnalyticsSite>>("/api/admin/analytics/sites", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateSite: (id: string, body: Partial<ApiAnalyticsSiteInput>) =>
    api<Envelope<ApiAnalyticsSite>>(
      `/api/admin/analytics/sites/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  deleteSite: (id: string) =>
    api<{ ok: boolean }>(`/api/admin/analytics/sites/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  overview: (from: number, to: number) =>
    api<Envelope<ApiAnalyticsOverview>>(
      `/api/admin/analytics/overview${analyticsQs({ from, to })}`,
    ),
  eventNames: () => api<Envelope<string[]>>("/api/admin/analytics/event-names"),
  funnel: (body: { steps: string[]; windowDays?: number; from: number; to: number }) =>
    api<Envelope<ApiAnalyticsFunnel>>("/api/admin/analytics/funnel", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  retention: (body: { event?: string | null; from: number; to: number }) =>
    api<Envelope<ApiAnalyticsRetention>>("/api/admin/analytics/retention", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  events: (opts: {
    from?: number;
    to?: number;
    name?: string;
    distinctId?: string;
    limit?: number;
  }) => api<Envelope<ApiAnalyticsEvent[]>>(`/api/admin/analytics/events${analyticsQs(opts)}`),
  errors: (opts: { status?: string; level?: string; since?: number; limit?: number }) =>
    api<Envelope<ApiErrorGroup[]>>(`/api/admin/analytics/errors${analyticsQs(opts)}`),
  error: (id: string) =>
    api<Envelope<ApiErrorGroupDetail>>(
      `/api/admin/analytics/errors/${encodeURIComponent(id)}`,
    ),
  updateError: (id: string, status: ApiErrorStatus) =>
    api<Envelope<ApiErrorGroup>>(`/api/admin/analytics/errors/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  deleteError: (id: string) =>
    api<{ ok: boolean }>(`/api/admin/analytics/errors/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  ingestKeyStatus: () =>
    api<Envelope<{ exists: boolean }>>("/api/admin/analytics/ingest-key"),
  mintIngestKey: () =>
    api<Envelope<{ key: string }>>("/api/admin/analytics/ingest-key", { method: "POST" }),
  revokeIngestKey: () =>
    api<{ ok: boolean }>("/api/admin/analytics/ingest-key", { method: "DELETE" }),
};
