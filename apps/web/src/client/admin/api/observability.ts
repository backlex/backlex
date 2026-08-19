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
  pathBase: string | null;
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

export interface ApiAnalyticsSegment {
  id: string;
  name: string;
  siteId: string | null;
  definition: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ApiAnalyticsRevenue {
  byCurrency: { currency: string; revenue: number; transactions: number; aov: number }[];
  byChannel: { channel: string; currency: string; revenue: number; transactions: number }[];
  byCampaign: { campaign: string; currency: string; revenue: number; transactions: number }[];
  topItems: { name: string; currency: string; quantity: number; revenue: number }[];
  truncated: boolean;
}

export interface ApiAnalyticsChannels {
  channels: { channel: string; sessions: number; visitors: number }[];
  sourceMedium: { value: string; sessions: number; visitors: number }[];
  totalSessions: number;
}

export interface ApiAnalyticsSessions {
  sessions: number;
  pageviews: number;
  bounceRate: number;
  avgDurationMs: number;
  pagesPerSession: number;
  landingPages: ApiAnalyticsBreakdown[];
  exitPages: ApiAnalyticsBreakdown[];
}

export interface ApiAnalyticsRealtime {
  visitorsNow: number;
  events: number;
  byMinute: { minute: number; events: number; visitors: number }[];
  topPaths: ApiAnalyticsBreakdown[];
  topReferrers: ApiAnalyticsBreakdown[];
  topCountries: ApiAnalyticsBreakdown[];
  /** True when a row cap bit — the counts are a floor, not a total. */
  truncated: boolean;
}

/**
 * Tag manager — third-party tags fired by the script the site already loads.
 *
 * Separate from `analyticsApi` because it is a separate product surface with a
 * separate route family; the only thing the two share is the site, which is the
 * container.
 */
export interface ApiTagVocabulary {
  templates: {
    id: string;
    label: string;
    vendor: string;
    docUrl: string;
    consentCategories: string[];
    cspSource: "vendor" | "inferred";
    csp: Record<string, string[] | undefined>;
    params: {
      key: string;
      label: string;
      required: boolean;
      kind: "text" | "select" | "boolean";
      options?: { value: string; label: string }[];
      pattern?: string;
      formatDocumented: boolean;
      placeholder?: string;
      help?: string;
    }[];
  }[];
  triggerTypes: string[];
  scrollThresholds: number[];
  fields: string[];
  tagKinds: string[];
  variableKinds: string[];
  fireRules: string[];
}

export interface ApiTagDefinition {
  id: string;
  siteId: string;
  name: string;
  kind: string;
  templateId: string | null;
  params: Record<string, unknown> | null;
  triggerIds: string[];
  blockingTriggerIds: string[];
  consentCategory: string;
  fireRule: string;
  priority: number;
  enabled: boolean;
  updatedAt: number;
}

export interface ApiTagTrigger {
  id: string;
  siteId: string;
  name: string;
  type: string;
  config: Record<string, unknown> | null;
  condition: unknown;
  updatedAt: number;
}

export interface ApiTagVersion {
  id: string;
  siteId: string;
  version: number;
  note: string | null;
  hash: string;
  createdBy: string | null;
  createdAt: number;
}

export interface ApiTagDropped {
  kind: "tag" | "trigger" | "variable";
  id: string;
  name: string;
  reason: string;
}

export interface ApiTagInstall {
  snippet: string;
  csp: { script: string[]; img: string[]; connect: string[]; frame: string[]; hasInferred: boolean };
  scriptSrcElemCaveat: boolean;
}

const tm = (path: string) => `/api/admin/tag-manager${path}`;
const site = (id: string) => encodeURIComponent(id);

export const tagManagerApi = {
  vocabulary: () => api<Envelope<ApiTagVocabulary>>(tm("/vocabulary")),

  tags: (siteId: string) => api<Envelope<ApiTagDefinition[]>>(tm(`/sites/${site(siteId)}/tags`)),
  createTag: (siteId: string, body: unknown) =>
    api<Envelope<ApiTagDefinition>>(tm(`/sites/${site(siteId)}/tags`), {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateTag: (id: string, body: unknown) =>
    api<Envelope<ApiTagDefinition>>(tm(`/tags/${site(id)}`), {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteTag: (id: string) =>
    api<Envelope<{ id: string }>>(tm(`/tags/${site(id)}`), { method: "DELETE" }),

  triggers: (siteId: string) =>
    api<Envelope<ApiTagTrigger[]>>(tm(`/sites/${site(siteId)}/triggers`)),
  createTrigger: (siteId: string, body: unknown) =>
    api<Envelope<ApiTagTrigger>>(tm(`/sites/${site(siteId)}/triggers`), {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateTrigger: (id: string, body: unknown) =>
    api<Envelope<ApiTagTrigger>>(tm(`/triggers/${site(id)}`), {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteTrigger: (id: string) =>
    api<Envelope<{ id: string }>>(tm(`/triggers/${site(id)}`), { method: "DELETE" }),

  compile: (siteId: string) =>
    api<Envelope<{ artifact: { tags: unknown[] }; dropped: ApiTagDropped[] }>>(
      tm(`/sites/${site(siteId)}/compile`),
    ),
  publish: (siteId: string, note?: string) =>
    api<Envelope<{ version: ApiTagVersion; dropped: ApiTagDropped[] }>>(
      tm(`/sites/${site(siteId)}/publish`),
      { method: "POST", body: JSON.stringify({ note }) },
    ),
  versions: (siteId: string) =>
    api<Envelope<ApiTagVersion[]>>(tm(`/sites/${site(siteId)}/versions`)),
  rollback: (siteId: string, version: number) =>
    api<Envelope<ApiTagVersion>>(tm(`/sites/${site(siteId)}/rollback`), {
      method: "POST",
      body: JSON.stringify({ version }),
    }),
  install: (siteId: string) => api<Envelope<ApiTagInstall>>(tm(`/sites/${site(siteId)}/install`)),
};

export const analyticsApi = {
  segments: () => api<Envelope<ApiAnalyticsSegment[]>>("/api/admin/analytics/segments"),
  createSegment: (body: { name: string; definition: unknown; siteId?: string | null }) =>
    api<Envelope<ApiAnalyticsSegment>>("/api/admin/analytics/segments", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteSegment: (id: string) =>
    api<{ ok: boolean }>(`/api/admin/analytics/segments/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  revenue: (from: number, to: number, siteId?: string, segmentId?: string) =>
    api<Envelope<ApiAnalyticsRevenue>>(
      `/api/admin/analytics/revenue${analyticsQs({ from, to, siteId, segmentId })}`,
    ),
  channels: (from: number, to: number, siteId?: string, segmentId?: string) =>
    api<Envelope<ApiAnalyticsChannels>>(
      `/api/admin/analytics/channels${analyticsQs({ from, to, siteId, segmentId })}`,
    ),
  sessions: (from: number, to: number, siteId?: string, segmentId?: string) =>
    api<Envelope<ApiAnalyticsSessions>>(
      `/api/admin/analytics/sessions${analyticsQs({ from, to, siteId, segmentId })}`,
    ),
  realtime: (siteId?: string) =>
    api<Envelope<ApiAnalyticsRealtime>>(
      `/api/admin/analytics/realtime${analyticsQs({ siteId })}`,
    ),
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
  overview: (from: number, to: number, segmentId?: string) =>
    api<Envelope<ApiAnalyticsOverview>>(
      `/api/admin/analytics/overview${analyticsQs({ from, to, segmentId })}`,
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

/**
 * Cookie consent — the policy a site publishes.
 *
 * `undecidedBehaviour` and `trackerCategory` are optional on input and required
 * by the server the first time a policy is saved. That asymmetry is the point:
 * an admin editing the banner copy sends the whole form back and must not be
 * made to re-affirm a compliance decision they are not changing, while a first
 * save has no stored choice to carry forward and is refused with a message
 * explaining what each value means.
 */
export type ConsentCategory = "functional" | "analytics" | "marketing";
export type UndecidedBehaviour = "block" | "allow";
export type TrackerCategory = "none" | "analytics";
export type BannerPosition = "bottom" | "top" | "corner";

export interface ApiConsentPolicy {
  siteId: string;
  categoriesOffered: ConsentCategory[];
  undecidedBehaviour: UndecidedBehaviour;
  trackerCategory: TrackerCategory;
  wording: Record<string, Record<string, string>>;
  defaultLocale: string;
  policyUrl: string | null;
  position: BannerPosition;
  theme: Record<string, string>;
  cookieMaxAgeDays: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ApiConsentPolicyInput {
  categoriesOffered?: ConsentCategory[];
  undecidedBehaviour?: UndecidedBehaviour;
  trackerCategory?: TrackerCategory;
  wording?: Record<string, Record<string, string>>;
  defaultLocale?: string;
  policyUrl?: string | null;
  position?: BannerPosition;
  theme?: Record<string, string>;
  cookieMaxAgeDays?: number;
  enabled?: boolean;
}

export const consentApi = {
  policies: () => api<Envelope<ApiConsentPolicy[]>>("/api/admin/consent/policies"),
  policy: (siteId: string) =>
    api<Envelope<ApiConsentPolicy | null>>(
      `/api/admin/consent/policies/${encodeURIComponent(siteId)}`,
    ),
  savePolicy: (siteId: string, body: ApiConsentPolicyInput) =>
    api<Envelope<ApiConsentPolicy>>(
      `/api/admin/consent/policies/${encodeURIComponent(siteId)}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  deletePolicy: (siteId: string) =>
    api<{ ok: boolean }>(`/api/admin/consent/policies/${encodeURIComponent(siteId)}`, {
      method: "DELETE",
    }),
  suggestedWording: () =>
    api<Envelope<Record<string, Record<string, string>>>>(
      "/api/admin/consent/wording/suggested",
    ),
};
