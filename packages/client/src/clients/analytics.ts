import type { ClientCore } from "../core";

/** One tracked product event. `distinctId` defaults to the SDK's stable
 *  anonymous visitor id, so callers usually pass only a name and props. */
export interface TrackedEvent {
  name: string;
  distinctId?: string;
  userId?: string | null;
  sessionId?: string | null;
  props?: Record<string, unknown> | null;
  path?: string | null;
  referrer?: string | null;
  source?: string | null;
  release?: string | null;
  country?: string | null;
  /** Epoch ms. Defaults to now; the server clamps to −7d / +5min. */
  ts?: number;
}

/** One error occurrence to report. */
export interface TrackedError {
  message: string;
  type?: string | null;
  stack?: string | null;
  level?: "error" | "warning" | "fatal" | null;
  platform?: string | null;
  release?: string | null;
  url?: string | null;
  userId?: string | null;
  distinctId?: string | null;
  sessionId?: string | null;
  context?: Record<string, unknown> | null;
  ts?: number;
}

export interface AnalyticsIngestResult {
  accepted: number;
  /** Rows the server dropped as malformed, rather than failing the batch. */
  rejected: number;
}

/** One top-N row over a dimension. `users` is distinct visitors — a website
 *  report leads with people, `count` alone answers "how many hits". */
export interface AnalyticsBreakdownRow {
  value: string;
  count: number;
  users: number;
}

export interface AnalyticsOverview {
  totals: {
    events: number;
    /**
     * Distinct visitor ids in range. Read alongside `cookielessShare`: ids in
     * the cookieless lane rotate at UTC midnight, so for that share of traffic
     * one returning person contributes one id per day and this is inflated.
     * `durableUsers` and `visitorsPerDay` are always true.
     */
    users: number;
    sessions: number;
    /** Unique visitors among non-rotating ids. Correct over any range. */
    durableUsers: number;
    /** Mean distinct cookieless visitors per active day, or null when there
     *  was no cookieless traffic in range. */
    visitorsPerDay: number | null;
    /** Fraction of events in range carrying a rotating id, 0..1. */
    cookielessShare: number;
  };
  series: { day: string; events: number; users: number }[];
  topEvents: { name: string; count: number; users: number }[];
  topPaths: { path: string; count: number; users: number }[];
  topReferrers: { referrer: string; count: number; users: number }[];
  sources: { source: string; count: number; users: number }[];
  /** Website dimensions, derived server-side at ingest. */
  topCountries: AnalyticsBreakdownRow[];
  topDevices: AnalyticsBreakdownRow[];
  topCampaigns: AnalyticsBreakdownRow[];
}

/** A website registered for tag-based measurement. Its `id` ships in the
 *  public snippet, so treat it as naming a destination, not authenticating one. */
export interface AnalyticsSite {
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

export interface AnalyticsSiteInput {
  name: string;
  domain: string;
  tz?: string;
  excludedPaths?: string[];
  ignoredIps?: string[];
  filterBots?: boolean;
  requireKnownOrigin?: boolean;
}

/** A saved analytics filter. `definition` is a predicate tree over a closed
 *  field allowlist; it is validated server-side on save AND on every read. */
export interface AnalyticsSegment {
  id: string;
  name: string;
  siteId: string | null;
  definition: unknown;
  createdAt: number;
  updatedAt: number;
}

/** Revenue, always grouped by currency. There is no FX source, so nothing is
 *  ever summed across currencies and no single total is offered. */
export interface AnalyticsRevenue {
  byCurrency: { currency: string; revenue: number; transactions: number; aov: number }[];
  byChannel: { channel: string; currency: string; revenue: number; transactions: number }[];
  byCampaign: { campaign: string; currency: string; revenue: number; transactions: number }[];
  topItems: { name: string; currency: string; quantity: number; revenue: number }[];
  truncated: boolean;
}

/** Where sessions came from. Attribution is last non-direct touch WITHIN a
 *  session — cookieless ids rotate daily, so cross-session attribution is not
 *  available for tag traffic. */
export interface AnalyticsChannels {
  channels: { channel: string; sessions: number; visitors: number }[];
  sourceMedium: { value: string; sessions: number; visitors: number }[];
  totalSessions: number;
}

/** Sessions derived at query time from the tag stream. A 30-minute gap between
 *  one visitor's hits ends a session; server-side SDK events are not visits. */
export interface AnalyticsSessions {
  sessions: number;
  pageviews: number;
  /** Share of sessions with exactly one pageview, 0..1. */
  bounceRate: number;
  /** Mean duration in ms. Bounces count as 0 rather than being dropped. */
  avgDurationMs: number;
  pagesPerSession: number;
  landingPages: AnalyticsBreakdownRow[];
  exitPages: AnalyticsBreakdownRow[];
}

/** The last 30 minutes. `truncated` is true when a row cap bit, which makes
 *  every figure below it a floor rather than a total. */
export interface AnalyticsRealtime {
  visitorsNow: number;
  events: number;
  byMinute: { minute: number; events: number; visitors: number }[];
  topPaths: AnalyticsBreakdownRow[];
  topReferrers: AnalyticsBreakdownRow[];
  topCountries: AnalyticsBreakdownRow[];
  truncated: boolean;
}

export interface AnalyticsFunnelResult {
  windowDays: number;
  steps: { name: string; count: number; conversion: number; dropOff: number }[];
}

export interface AnalyticsRetentionResult {
  maxOffset: number;
  cohorts: { day: string; size: number; values: number[] }[];
}

export interface AnalyticsEventRow {
  id: string;
  name: string;
  distinctId: string;
  userId: string | null;
  sessionId: string | null;
  props: Record<string, unknown> | null;
  path: string | null;
  /** `path` with the query removed — what page reports group by. */
  pathBase: string | null;
  referrer: string | null;
  source: string | null;
  release: string | null;
  country: string | null;
  /** Server-derived web dimensions, exposed on the raw-event debug view. */
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

export interface ErrorGroup {
  id: string;
  fingerprint: string;
  type: string;
  message: string;
  culprit: string | null;
  level: string;
  platform: string | null;
  release: string | null;
  status: "open" | "resolved" | "ignored" | string;
  events: number;
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

export interface ErrorOccurrence {
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

export interface ErrorGroupDetail {
  group: ErrorGroup;
  occurrences: ErrorOccurrence[];
  series: { day: string; count: number }[];
  users: number;
}

/** Inclusive epoch-ms reporting window. Defaults to the last 30 days. */
export interface AnalyticsRange {
  from?: number;
  to?: number;
}

/**
 * Product analytics + crash reporting. The two `track*` methods are the
 * append-only ingest side (usable from a browser with a publishable
 * `ingestKey`); everything else is admin-scoped reporting.
 */
export interface AnalyticsClient {
  /** The stable anonymous visitor id this client stamps on events that omit
   *  one. Persisted in `localStorage` in a browser, in memory elsewhere. */
  distinctId(): string;
  /** Pin the visitor id — call after sign-in to tie a known user to the
   *  anonymous history already recorded under the generated id. */
  identify(distinctId: string, opts?: { userId?: string | null }): void;
  /** Track one event. */
  track(
    name: string,
    props?: Record<string, unknown> | null,
    extra?: Omit<TrackedEvent, "name" | "props">,
  ): Promise<AnalyticsIngestResult>;
  /** Track many events in one request (offline queues, batching). */
  trackBatch(events: TrackedEvent[]): Promise<AnalyticsIngestResult>;
  /** Report one error. Accepts a real `Error` (message/stack/type are read off
   *  it) or an explicit payload. */
  trackError(
    error: Error | TrackedError,
    extra?: Partial<TrackedError>,
  ): Promise<AnalyticsIngestResult & { groups: string[] }>;
  /** Report many errors in one request. */
  trackErrorBatch(
    errors: TrackedError[],
  ): Promise<AnalyticsIngestResult & { groups: string[] }>;
  /**
   * Browser only: forward uncaught errors and unhandled promise rejections to
   * `trackError` automatically. Returns a function that removes the listeners.
   * A no-op returning a no-op outside a browser.
   */
  captureErrors(opts?: { release?: string; platform?: string }): () => void;
  /** Headline counters, daily series and top-N breakdowns (admin). */
  overview(range?: AnalyticsRange): Promise<{ data: AnalyticsOverview }>;
  /** Distinct event names ordered by volume (admin). */
  eventNames(): Promise<{ data: string[] }>;
  /** Ordered conversion funnel (admin). */
  funnel(
    input: AnalyticsRange & { steps: string[]; windowDays?: number },
  ): Promise<{ data: AnalyticsFunnelResult }>;
  /** Cohort retention grid (admin). */
  retention(
    input?: AnalyticsRange & { event?: string | null },
  ): Promise<{ data: AnalyticsRetentionResult }>;
  /** Raw recent events — the debug view behind the aggregates (admin). */
  events(
    query?: AnalyticsRange & { name?: string; distinctId?: string; limit?: number },
  ): Promise<{ data: AnalyticsEventRow[] }>;
  /** Crash-report triage (admin). */
  errors: {
    list(query?: {
      status?: "open" | "resolved" | "ignored";
      level?: "error" | "warning" | "fatal";
      since?: number;
      limit?: number;
    }): Promise<{ data: ErrorGroup[] }>;
    get(id: string): Promise<{ data: ErrorGroupDetail }>;
    update(
      id: string,
      patch: { status: "open" | "resolved" | "ignored" },
    ): Promise<{ data: ErrorGroup }>;
    delete(id: string): Promise<{ ok: boolean }>;
  };
  /** Publishable ingest-key management (admin). */
  /** Revenue by currency, channel and campaign. */
  revenue(input?: {
    from?: number;
    to?: number;
    siteId?: string;
    segmentId?: string;
  }): Promise<{ data: AnalyticsRevenue }>;
  /**
   * Record a purchase. Sugar over `track`, and the only reason it exists is to
   * put `amount` in MINOR units in the signature — a float here is the classic
   * way a currency total ends up 100x wrong.
   */
  trackPurchase(input: {
    amountMinor: number;
    currency: string;
    items?: { name: string; quantity?: number; price?: number }[];
    props?: Record<string, unknown>;
    path?: string;
  }): Promise<AnalyticsIngestResult>;
  /** Default Channel Groups and a source/medium breakdown. */
  channels(input?: {
    from?: number;
    to?: number;
    siteId?: string;
    segmentId?: string;
  }): Promise<{ data: AnalyticsChannels }>;
  /** Sessions, bounce rate, duration, landing and exit pages. */
  sessions(input?: {
    from?: number;
    to?: number;
    siteId?: string;
    segmentId?: string;
  }): Promise<{ data: AnalyticsSessions }>;
  /** Who is on the site right now — the last 30 minutes, by minute. */
  realtime(opts?: { siteId?: string }): Promise<{ data: AnalyticsRealtime }>;
  /** Saved filters, appliable to any report via its `segmentId`. */
  segments: {
    list(): Promise<{ data: AnalyticsSegment[] }>;
    create(input: {
      name: string;
      definition: unknown;
      siteId?: string | null;
    }): Promise<{ data: AnalyticsSegment }>;
    update(
      id: string,
      patch: { name?: string; definition?: unknown; siteId?: string | null },
    ): Promise<{ data: AnalyticsSegment }>;
    delete(id: string): Promise<{ ok: boolean }>;
  };
  /** Websites measured by the drop-in tag. */
  sites: {
    list(): Promise<{ data: AnalyticsSite[] }>;
    create(input: AnalyticsSiteInput): Promise<{ data: AnalyticsSite }>;
    update(
      id: string,
      patch: Partial<AnalyticsSiteInput>,
    ): Promise<{ data: AnalyticsSite }>;
    delete(id: string): Promise<{ ok: boolean }>;
  };
  ingestKey: {
    /** Whether a key exists. The plaintext is never recoverable. */
    status(): Promise<{ data: { exists: boolean } }>;
    /** Mint a fresh key, invalidating any previous one. Shown once. */
    mint(): Promise<{ data: { key: string } }>;
    revoke(): Promise<{ ok: boolean }>;
  };
}

/** Shared query string for the range-plus-site reports. */
const rangeQs = (input?: {
  from?: number;
  to?: number;
  siteId?: string;
  segmentId?: string;
}): string => {
  const qs = new URLSearchParams();
  if (input?.from !== undefined) qs.set("from", String(input.from));
  if (input?.to !== undefined) qs.set("to", String(input.to));
  if (input?.siteId) qs.set("siteId", input.siteId);
  if (input?.segmentId) qs.set("segmentId", input.segmentId);
  const tail = qs.toString();
  return tail ? `?${tail}` : "";
};

export const makeAnalytics = (core: ClientCore): AnalyticsClient => {
  // Product analytics + crash reporting. `track*` post to the public ingest
  // endpoints (authenticated by the publishable `ingestKey` when set, else by
  // whatever session/API key the client already carries); everything else is
  // admin-scoped reporting over `/api/admin/analytics`.
  const ANON_KEY = "backlex.analytics.distinctId";
  let anonId: string | null = null;
  let identifiedUserId: string | null = null;
  /** A stable per-visitor id. Persisted so a returning browser keeps its
   *  history — which is what makes retention and funnels meaningful. */
  const currentDistinctId = (): string => {
    if (anonId) return anonId;
    try {
      const store = globalThis.localStorage;
      const saved = store?.getItem(ANON_KEY);
      if (saved) {
        anonId = saved;
        return anonId;
      }
      anonId = crypto.randomUUID();
      store?.setItem(ANON_KEY, anonId);
    } catch {
      // Private mode / no DOM — an in-memory id still groups one session.
      anonId ??= crypto.randomUUID();
    }
    return anonId;
  };
  const ingestHeaders = (): Record<string, string> =>
    core.opts.ingestKey ? { "x-backlex-ingest-key": core.opts.ingestKey } : {};
  const analyticsQuery = (q: object | undefined): string => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q ?? {})) {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  };
  const toTrackedError = (e: Error | TrackedError): TrackedError =>
    e instanceof Error
      ? { message: e.message, type: e.name, stack: e.stack ?? null }
      : e;
  const errPath = (id: string) =>
    `/api/admin/analytics/errors/${encodeURIComponent(id)}`;

  const analytics: AnalyticsClient = {
    distinctId: currentDistinctId,
    identify: (distinctId: string, o?: { userId?: string | null }) => {
      anonId = distinctId;
      identifiedUserId = o?.userId ?? null;
      try {
        globalThis.localStorage?.setItem(ANON_KEY, distinctId);
      } catch {
        // non-browser or storage denied — the in-memory id still applies
      }
    },
    trackBatch: (events: TrackedEvent[]) =>
      core.request<AnalyticsIngestResult>(
        "POST",
        "/api/analytics/events",
        {
          events: events.map((e) => ({
            ...e,
            distinctId: e.distinctId ?? currentDistinctId(),
            userId: e.userId ?? identifiedUserId ?? undefined,
          })),
        },
        ingestHeaders(),
      ),
    track: (name, props, extra) =>
      analytics.trackBatch([{ ...extra, name, props: props ?? null }]),
    trackErrorBatch: (errors: TrackedError[]) =>
      core.request<AnalyticsIngestResult & { groups: string[] }>(
        "POST",
        "/api/analytics/errors",
        {
          errors: errors.map((e) => ({
            ...e,
            distinctId: e.distinctId ?? currentDistinctId(),
            userId: e.userId ?? identifiedUserId ?? undefined,
          })),
        },
        ingestHeaders(),
      ),
    trackError: (error, extra) =>
      analytics.trackErrorBatch([{ ...toTrackedError(error), ...extra }]),
    captureErrors: (o) => {
      const w = globalThis as unknown as {
        addEventListener?: typeof addEventListener;
        removeEventListener?: typeof removeEventListener;
        location?: { href?: string };
      };
      if (typeof w.addEventListener !== "function") return () => {};
      const base = {
        platform: o?.platform ?? "browser",
        release: o?.release ?? null,
      };
      // Reporting must never throw inside a global error handler — that would
      // replace the app's original failure with the reporter's.
      const send = (payload: TrackedError) => {
        void analytics
          .trackError({ ...base, url: w.location?.href ?? null, ...payload })
          .catch(() => {});
      };
      const onError = (ev: Event) => {
        const e = ev as ErrorEvent;
        send(
          e.error instanceof Error
            ? toTrackedError(e.error)
            : { message: e.message || "Uncaught error" },
        );
      };
      const onRejection = (ev: Event) => {
        const reason = (ev as PromiseRejectionEvent).reason;
        send(
          reason instanceof Error
            ? toTrackedError(reason)
            : { message: `Unhandled rejection: ${String(reason)}` },
        );
      };
      w.addEventListener("error", onError);
      w.addEventListener("unhandledrejection", onRejection);
      return () => {
        w.removeEventListener?.("error", onError);
        w.removeEventListener?.("unhandledrejection", onRejection);
      };
    },
    overview: (range) =>
      core.request<{ data: AnalyticsOverview }>(
        "GET",
        `/api/admin/analytics/overview${analyticsQuery(range)}`,
      ),
    eventNames: () =>
      core.request<{ data: string[] }>("GET", "/api/admin/analytics/event-names"),
    funnel: (input) =>
      core.request<{ data: AnalyticsFunnelResult }>(
        "POST",
        "/api/admin/analytics/funnel",
        input,
      ),
    retention: (input) =>
      core.request<{ data: AnalyticsRetentionResult }>(
        "POST",
        "/api/admin/analytics/retention",
        input ?? {},
      ),
    events: (query) =>
      core.request<{ data: AnalyticsEventRow[] }>(
        "GET",
        `/api/admin/analytics/events${analyticsQuery(query)}`,
      ),
    errors: {
      list: (query) =>
        core.request<{ data: ErrorGroup[] }>(
          "GET",
          `/api/admin/analytics/errors${analyticsQuery(query)}`,
        ),
      get: (id: string) => core.request<{ data: ErrorGroupDetail }>("GET", errPath(id)),
      update: (id: string, patch: { status: "open" | "resolved" | "ignored" }) =>
        core.request<{ data: ErrorGroup }>("PATCH", errPath(id), patch),
      delete: (id: string) => core.request<{ ok: boolean }>("DELETE", errPath(id)),
    },
    revenue: (input?: { from?: number; to?: number; siteId?: string; segmentId?: string }) =>
      core.request<{ data: AnalyticsRevenue }>(
        "GET",
        `/api/admin/analytics/revenue${rangeQs(input)}`,
      ),
    trackPurchase: (input) =>
      analytics.track(
        "purchase",
        {
          ...input.props,
          revenue: Math.trunc(input.amountMinor),
          currency: input.currency.toUpperCase(),
          ...(input.items ? { items: input.items } : {}),
        },
        input.path ? { path: input.path } : undefined,
      ),
    channels: (input?: { from?: number; to?: number; siteId?: string; segmentId?: string }) =>
      core.request<{ data: AnalyticsChannels }>(
        "GET",
        `/api/admin/analytics/channels${rangeQs(input)}`,
      ),
    sessions: (input?: { from?: number; to?: number; siteId?: string; segmentId?: string }) =>
      core.request<{ data: AnalyticsSessions }>(
        "GET",
        `/api/admin/analytics/sessions${rangeQs(input)}`,
      ),
    realtime: (opts?: { siteId?: string }) =>
      core.request<{ data: AnalyticsRealtime }>(
        "GET",
        `/api/admin/analytics/realtime${opts?.siteId ? `?siteId=${encodeURIComponent(opts.siteId)}` : ""}`,
      ),
    segments: {
      list: () =>
        core.request<{ data: AnalyticsSegment[] }>("GET", "/api/admin/analytics/segments"),
      create: (input) =>
        core.request<{ data: AnalyticsSegment }>(
          "POST",
          "/api/admin/analytics/segments",
          input,
        ),
      update: (id, patch) =>
        core.request<{ data: AnalyticsSegment }>(
          "PATCH",
          `/api/admin/analytics/segments/${encodeURIComponent(id)}`,
          patch,
        ),
      delete: (id) =>
        core.request<{ ok: boolean }>(
          "DELETE",
          `/api/admin/analytics/segments/${encodeURIComponent(id)}`,
        ),
    },
    sites: {
      list: () =>
        core.request<{ data: AnalyticsSite[] }>("GET", "/api/admin/analytics/sites"),
      create: (input: AnalyticsSiteInput) =>
        core.request<{ data: AnalyticsSite }>(
          "POST",
          "/api/admin/analytics/sites",
          input,
        ),
      update: (id: string, patch: Partial<AnalyticsSiteInput>) =>
        core.request<{ data: AnalyticsSite }>(
          "PATCH",
          `/api/admin/analytics/sites/${encodeURIComponent(id)}`,
          patch,
        ),
      delete: (id: string) =>
        core.request<{ ok: boolean }>(
          "DELETE",
          `/api/admin/analytics/sites/${encodeURIComponent(id)}`,
        ),
    },
    ingestKey: {
      status: () =>
        core.request<{ data: { exists: boolean } }>(
          "GET",
          "/api/admin/analytics/ingest-key",
        ),
      mint: () =>
        core.request<{ data: { key: string } }>(
          "POST",
          "/api/admin/analytics/ingest-key",
          {},
        ),
      revoke: () =>
        core.request<{ ok: boolean }>("DELETE", "/api/admin/analytics/ingest-key"),
    },
  };

  return analytics;
};
