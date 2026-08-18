/**
 * Product analytics + crash reporting over GraphQL (#22).
 *
 * Static, admin-scoped surface mirroring REST `/api/admin/analytics` + MCP
 * `analytics.*` / `errors.*` + SDK `client.analytics.*` + CLI `backlex
 * analytics`. Every resolver calls the same `services/analytics` functions the
 * REST routes do, so there is exactly one place the SQL lives.
 *
 * Ingest is exposed here too (`trackEvents` / `trackErrors`) for server-side
 * callers that already speak GraphQL. It is admin-gated on this surface — the
 * publishable-ingest-key path is REST-only, since that's what browser and
 * mobile bundles use.
 */
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import {
  analyticsFunnel,
  analyticsOverview,
  analyticsRetention,
  deleteErrorGroup,
  getErrorGroup,
  listAnalyticsEvents,
  listErrorGroups,
  listEventNames,
  listSites,
  analyticsRealtime,
  analyticsChannels,
  analyticsRevenue,
  createSegment,
  deleteSegment,
  listSegments,
  resolveSegment,
  updateSegment,
  analyticsSessions,
  createSite,
  updateSite,
  deleteSite,
  type SiteInput,
  recordErrors,
  recordEvents,
  updateErrorGroup,
} from "../analytics";

/** Analytics is admin-only on every other surface — reuse the shared gate. */
const requireAnalyticsAdmin = requireFlowAdmin;

/** Default reporting window, matching the REST route. */
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 365;

const resolveRange = (args: { from?: number | null; to?: number | null }) => {
  const to = args.to ?? Date.now();
  const from = args.from ?? to - DEFAULT_RANGE_DAYS * 86_400_000;
  if (from > to) {
    throw new GraphQLError("`from` must be before `to`", {
      extensions: { code: "VALIDATION" },
    });
  }
  if (to - from > MAX_RANGE_DAYS * 86_400_000) {
    throw new GraphQLError(`Range is capped at ${MAX_RANGE_DAYS} days`, {
      extensions: { code: "VALIDATION" },
    });
  }
  return { from, to };
};

const dbOf = (gqlCtx: GqlCtx) => ({
  db: gqlCtx.ctx.db,
  dialect: gqlCtx.ctx.dialect,
});

const AnalyticsTotalsType = new GraphQLObjectType({
  name: "AnalyticsTotals",
  fields: {
    events: { type: new GraphQLNonNull(GraphQLInt) },
    users: {
      type: new GraphQLNonNull(GraphQLInt),
      description:
        "Distinct visitor ids in range. Inflated for the `cookielessShare` of traffic, whose ids rotate daily — see durableUsers / visitorsPerDay.",
    },
    sessions: { type: new GraphQLNonNull(GraphQLInt) },
    durableUsers: {
      type: new GraphQLNonNull(GraphQLInt),
      description: "Unique visitors among non-rotating ids. Correct over any range.",
    },
    visitorsPerDay: {
      type: GraphQLInt,
      description:
        "Mean distinct cookieless visitors per active day; null when there was none in range.",
    },
    cookielessShare: {
      type: new GraphQLNonNull(GraphQLFloat),
      description: "Fraction of events in range carrying a rotating id, 0..1.",
    },
  },
});

const AnalyticsSeriesPointType = new GraphQLObjectType({
  name: "AnalyticsSeriesPoint",
  fields: {
    day: { type: new GraphQLNonNull(GraphQLString) },
    events: { type: new GraphQLNonNull(GraphQLInt) },
    users: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const AnalyticsTopEventType = new GraphQLObjectType({
  name: "AnalyticsTopEvent",
  fields: {
    name: { type: new GraphQLNonNull(GraphQLString) },
    count: { type: new GraphQLNonNull(GraphQLInt) },
    users: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

/** One breakdown row (paths, referrers, sources, countries, devices,
 *  campaigns). `users` is distinct visitors — the figure a website report
 *  leads with; `count` alone answers "how many hits". */
const AnalyticsBreakdownType = new GraphQLObjectType({
  name: "AnalyticsBreakdown",
  fields: {
    value: { type: new GraphQLNonNull(GraphQLString) },
    count: { type: new GraphQLNonNull(GraphQLInt) },
    users: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const AnalyticsOverviewType = new GraphQLObjectType({
  name: "AnalyticsOverview",
  fields: {
    totals: { type: new GraphQLNonNull(AnalyticsTotalsType) },
    series: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(AnalyticsSeriesPointType)),
      ),
    },
    topEvents: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(AnalyticsTopEventType)),
      ),
    },
    topPaths: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(AnalyticsBreakdownType)),
      ),
    },
    topReferrers: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(AnalyticsBreakdownType)),
      ),
    },
    sources: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(AnalyticsBreakdownType)),
      ),
    },
    topCountries: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(AnalyticsBreakdownType)),
      ),
    },
    topDevices: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(AnalyticsBreakdownType)),
      ),
    },
    topCampaigns: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(AnalyticsBreakdownType)),
      ),
    },
  },
});

const FunnelStepType = new GraphQLObjectType({
  name: "AnalyticsFunnelStep",
  fields: {
    name: { type: new GraphQLNonNull(GraphQLString) },
    count: { type: new GraphQLNonNull(GraphQLInt) },
    conversion: { type: new GraphQLNonNull(GraphQLFloat) },
    dropOff: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const FunnelResultType = new GraphQLObjectType({
  name: "AnalyticsFunnel",
  fields: {
    windowDays: { type: new GraphQLNonNull(GraphQLInt) },
    steps: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(FunnelStepType))),
    },
  },
});

const RetentionCohortType = new GraphQLObjectType({
  name: "AnalyticsRetentionCohort",
  fields: {
    day: { type: new GraphQLNonNull(GraphQLString) },
    size: { type: new GraphQLNonNull(GraphQLInt) },
    values: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLInt))),
    },
  },
});

const RetentionResultType = new GraphQLObjectType({
  name: "AnalyticsRetention",
  fields: {
    maxOffset: { type: new GraphQLNonNull(GraphQLInt) },
    cohorts: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(RetentionCohortType)),
      ),
    },
  },
});

const AnalyticsEventType = new GraphQLObjectType({
  name: "AnalyticsEvent",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    distinctId: { type: new GraphQLNonNull(GraphQLString) },
    userId: { type: GraphQLString },
    sessionId: { type: GraphQLString },
    props: { type: JSONScalar },
    path: { type: GraphQLString },
    referrer: { type: GraphQLString },
    source: { type: GraphQLString },
    release: { type: GraphQLString },
    country: { type: GraphQLString },
    siteId: { type: GraphQLString },
    idScope: { type: GraphQLString },
    deviceType: { type: GraphQLString },
    browser: { type: GraphQLString },
    os: { type: GraphQLString },
    utmSource: { type: GraphQLString },
    utmMedium: { type: GraphQLString },
    utmCampaign: { type: GraphQLString },
    revenue: { type: GraphQLFloat },
    currency: { type: GraphQLString },
    ts: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const ErrorGroupType = new GraphQLObjectType({
  name: "ErrorGroup",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    fingerprint: { type: new GraphQLNonNull(GraphQLString) },
    type: { type: new GraphQLNonNull(GraphQLString) },
    message: { type: new GraphQLNonNull(GraphQLString) },
    culprit: { type: GraphQLString },
    level: { type: new GraphQLNonNull(GraphQLString) },
    platform: { type: GraphQLString },
    release: { type: GraphQLString },
    status: { type: new GraphQLNonNull(GraphQLString) },
    events: { type: new GraphQLNonNull(GraphQLInt) },
    firstSeen: { type: new GraphQLNonNull(GraphQLFloat) },
    lastSeen: { type: new GraphQLNonNull(GraphQLFloat) },
    resolvedAt: { type: GraphQLFloat },
    resolvedBy: { type: GraphQLString },
  },
});

const ErrorOccurrenceType = new GraphQLObjectType({
  name: "ErrorOccurrence",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    message: { type: new GraphQLNonNull(GraphQLString) },
    stack: { type: GraphQLString },
    level: { type: new GraphQLNonNull(GraphQLString) },
    platform: { type: GraphQLString },
    release: { type: GraphQLString },
    url: { type: GraphQLString },
    userId: { type: GraphQLString },
    distinctId: { type: GraphQLString },
    sessionId: { type: GraphQLString },
    context: { type: JSONScalar },
    ts: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const ErrorSeriesPointType = new GraphQLObjectType({
  name: "ErrorSeriesPoint",
  fields: {
    day: { type: new GraphQLNonNull(GraphQLString) },
    count: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const ErrorGroupDetailType = new GraphQLObjectType({
  name: "ErrorGroupDetail",
  fields: {
    group: { type: new GraphQLNonNull(ErrorGroupType) },
    occurrences: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(ErrorOccurrenceType)),
      ),
    },
    series: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(ErrorSeriesPointType)),
      ),
    },
    users: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const TrackEventInputType = new GraphQLInputObjectType({
  name: "TrackEventInput",
  fields: {
    name: { type: new GraphQLNonNull(GraphQLString) },
    distinctId: { type: new GraphQLNonNull(GraphQLString) },
    userId: { type: GraphQLString },
    sessionId: { type: GraphQLString },
    props: { type: JSONScalar },
    path: { type: GraphQLString },
    referrer: { type: GraphQLString },
    source: { type: GraphQLString },
    release: { type: GraphQLString },
    country: { type: GraphQLString },
    ts: { type: GraphQLFloat },
  },
});

const TrackErrorInputType = new GraphQLInputObjectType({
  name: "TrackErrorInput",
  fields: {
    message: { type: new GraphQLNonNull(GraphQLString) },
    type: { type: GraphQLString },
    stack: { type: GraphQLString },
    level: { type: GraphQLString },
    platform: { type: GraphQLString },
    release: { type: GraphQLString },
    url: { type: GraphQLString },
    userId: { type: GraphQLString },
    distinctId: { type: GraphQLString },
    sessionId: { type: GraphQLString },
    context: { type: JSONScalar },
    ts: { type: GraphQLFloat },
  },
});

const IngestResultType = new GraphQLObjectType({
  name: "AnalyticsIngestResult",
  fields: {
    accepted: { type: new GraphQLNonNull(GraphQLInt) },
    rejected: { type: new GraphQLNonNull(GraphQLInt) },
    groups: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
  },
});

/** Flatten the service's per-column breakdown shape into `{ value, count }`. */
/** Rename the historical key (`path` / `referrer` / `source`) to the generic
 *  `value` the GraphQL breakdown type exposes, keeping `users` intact. */
const breakdown = <K extends string>(
  rows: (Record<K, string> & { count: number; users: number })[],
  key: K,
) => rows.map((r) => ({ value: r[key], count: r.count, users: r.users }));

const SegmentType = new GraphQLObjectType({
  name: "AnalyticsSegment",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    siteId: { type: GraphQLString },
    definition: {
      type: JSONScalar,
      description:
        "A predicate tree over a closed field allowlist. Re-validated on every read.",
    },
    createdAt: { type: new GraphQLNonNull(GraphQLFloat) },
    updatedAt: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const MoneyRowFields = {
  currency: { type: new GraphQLNonNull(GraphQLString) },
  revenue: { type: new GraphQLNonNull(GraphQLFloat) },
  transactions: { type: new GraphQLNonNull(GraphQLInt) },
};

const RevenueCurrencyType = new GraphQLObjectType({
  name: "AnalyticsRevenueCurrency",
  fields: { ...MoneyRowFields, aov: { type: new GraphQLNonNull(GraphQLFloat) } },
});

const RevenueChannelType = new GraphQLObjectType({
  name: "AnalyticsRevenueChannel",
  fields: { ...MoneyRowFields, channel: { type: new GraphQLNonNull(GraphQLString) } },
});

const RevenueCampaignType = new GraphQLObjectType({
  name: "AnalyticsRevenueCampaign",
  fields: { ...MoneyRowFields, campaign: { type: new GraphQLNonNull(GraphQLString) } },
});

const RevenueItemType = new GraphQLObjectType({
  name: "AnalyticsRevenueItem",
  fields: {
    name: { type: new GraphQLNonNull(GraphQLString) },
    currency: { type: new GraphQLNonNull(GraphQLString) },
    quantity: { type: new GraphQLNonNull(GraphQLFloat) },
    revenue: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const RevenueType = new GraphQLObjectType({
  name: "AnalyticsRevenue",
  description:
    "Amounts are in the currency's minor units. Every row carries its currency and nothing is summed across them — there is no FX rate source.",
  fields: {
    byCurrency: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(RevenueCurrencyType))),
    },
    byChannel: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(RevenueChannelType))),
    },
    byCampaign: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(RevenueCampaignType))),
    },
    topItems: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(RevenueItemType))),
    },
    truncated: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const ChannelRowType = new GraphQLObjectType({
  name: "AnalyticsChannelRow",
  fields: {
    channel: { type: new GraphQLNonNull(GraphQLString) },
    sessions: { type: new GraphQLNonNull(GraphQLInt) },
    visitors: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const SourceMediumType = new GraphQLObjectType({
  name: "AnalyticsSourceMedium",
  fields: {
    value: { type: new GraphQLNonNull(GraphQLString) },
    sessions: { type: new GraphQLNonNull(GraphQLInt) },
    visitors: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const ChannelsType = new GraphQLObjectType({
  name: "AnalyticsChannels",
  fields: {
    channels: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ChannelRowType))),
    },
    sourceMedium: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SourceMediumType))),
    },
    totalSessions: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const SessionsType = new GraphQLObjectType({
  name: "AnalyticsSessions",
  fields: {
    sessions: { type: new GraphQLNonNull(GraphQLInt) },
    pageviews: { type: new GraphQLNonNull(GraphQLInt) },
    bounceRate: { type: new GraphQLNonNull(GraphQLFloat) },
    avgDurationMs: { type: new GraphQLNonNull(GraphQLInt) },
    pagesPerSession: { type: new GraphQLNonNull(GraphQLFloat) },
    landingPages: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AnalyticsBreakdownType))),
    },
    exitPages: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AnalyticsBreakdownType))),
    },
  },
});

const RealtimeMinuteType = new GraphQLObjectType({
  name: "AnalyticsRealtimeMinute",
  fields: {
    minute: { type: new GraphQLNonNull(GraphQLFloat) },
    events: { type: new GraphQLNonNull(GraphQLInt) },
    visitors: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const RealtimeType = new GraphQLObjectType({
  name: "AnalyticsRealtime",
  fields: {
    visitorsNow: { type: new GraphQLNonNull(GraphQLInt) },
    events: { type: new GraphQLNonNull(GraphQLInt) },
    byMinute: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(RealtimeMinuteType)),
      ),
    },
    topPaths: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AnalyticsBreakdownType))),
    },
    topReferrers: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AnalyticsBreakdownType))),
    },
    topCountries: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AnalyticsBreakdownType))),
    },
    truncated: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: "True when a row cap bit — the counts are a floor, not a total.",
    },
  },
});

const AnalyticsSiteType = new GraphQLObjectType({
  name: "AnalyticsSite",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    domain: { type: new GraphQLNonNull(GraphQLString) },
    tz: {
      type: new GraphQLNonNull(GraphQLString),
      description: "Reporting timezone. Unused in v1 — every report buckets in UTC.",
    },
    excludedPaths: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
    },
    ignoredIps: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
    },
    filterBots: { type: new GraphQLNonNull(GraphQLBoolean) },
    requireKnownOrigin: { type: new GraphQLNonNull(GraphQLBoolean) },
    createdAt: { type: new GraphQLNonNull(GraphQLFloat) },
    updatedAt: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

const siteArgs = {
  name: { type: GraphQLString },
  domain: { type: GraphQLString },
  tz: { type: GraphQLString },
  excludedPaths: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
  ignoredIps: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
  filterBots: { type: GraphQLBoolean },
  requireKnownOrigin: { type: GraphQLBoolean },
};

export const analyticsQueryFields: Record<
  string,
  GraphQLFieldConfig<unknown, GqlCtx>
> = {
  analyticsOverview: {
    type: new GraphQLNonNull(AnalyticsOverviewType),
    description:
      "Headline counters, the zero-filled daily series and top-N breakdowns (admin-only).",
    args: { from: { type: GraphQLFloat }, to: { type: GraphQLFloat } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAnalyticsAdmin(gqlCtx);
      const { from, to } = resolveRange(args as { from?: number; to?: number });
      const o = await analyticsOverview(dbOf(gqlCtx), { tenantId, from, to });
      return {
        ...o,
        topPaths: breakdown(o.topPaths, "path"),
        topReferrers: breakdown(o.topReferrers, "referrer"),
        sources: breakdown(o.sources, "source"),
      };
    },
  },
  analyticsSegments: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SegmentType))),
    description: "Saved analytics filters (admin-only).",
    resolve: async (_src, _args, gqlCtx) =>
      listSegments(dbOf(gqlCtx), requireAnalyticsAdmin(gqlCtx)),
  },
  analyticsRevenue: {
    type: new GraphQLNonNull(RevenueType),
    description:
      "Revenue by currency, channel and campaign, plus the top items (admin-only).",
    args: {
      from: { type: GraphQLFloat },
      to: { type: GraphQLFloat },
      siteId: { type: GraphQLString },
      segmentId: { type: GraphQLString },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAnalyticsAdmin(gqlCtx);
      const a = args as { from?: number; to?: number; siteId?: string; segmentId?: string };
      const { from, to } = resolveRange(a);
      const segment = await resolveSegment(dbOf(gqlCtx), tenantId, a.segmentId);
      return analyticsRevenue(dbOf(gqlCtx), {
        tenantId,
        from,
        to,
        siteId: a.siteId ?? null,
        segment,
      });
    },
  },
  analyticsChannels: {
    type: new GraphQLNonNull(ChannelsType),
    description:
      "GA4 Default Channel Groups and a source/medium breakdown. Attribution is last non-direct touch within a session — cookieless ids rotate daily, so cross-session attribution is unavailable (admin-only).",
    args: {
      from: { type: GraphQLFloat },
      to: { type: GraphQLFloat },
      siteId: { type: GraphQLString },
      segmentId: { type: GraphQLString },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAnalyticsAdmin(gqlCtx);
      const a = args as { from?: number; to?: number; siteId?: string; segmentId?: string };
      const { from, to } = resolveRange(a);
      const segment = await resolveSegment(dbOf(gqlCtx), tenantId, a.segmentId);
      return analyticsChannels(dbOf(gqlCtx), {
        tenantId,
        from,
        to,
        siteId: a.siteId ?? null,
        segment,
      });
    },
  },
  analyticsSessions: {
    type: new GraphQLNonNull(SessionsType),
    description:
      "Sessions, bounce rate, average duration, pages per session, and landing / exit pages — derived at query time from tag traffic (admin-only).",
    args: {
      from: { type: GraphQLFloat },
      to: { type: GraphQLFloat },
      siteId: { type: GraphQLString },
      segmentId: { type: GraphQLString },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAnalyticsAdmin(gqlCtx);
      const a = args as { from?: number; to?: number; siteId?: string; segmentId?: string };
      const { from, to } = resolveRange(a);
      const segment = await resolveSegment(dbOf(gqlCtx), tenantId, a.segmentId);
      return analyticsSessions(dbOf(gqlCtx), {
        tenantId,
        from,
        to,
        siteId: a.siteId ?? null,
        segment,
      });
    },
  },
  analyticsRealtime: {
    type: new GraphQLNonNull(RealtimeType),
    description:
      "The last 30 minutes bucketed by minute, with the top paths, referrers and countries inside that window (admin-only).",
    args: { siteId: { type: GraphQLString } },
    resolve: async (_src, args, gqlCtx) =>
      analyticsRealtime(dbOf(gqlCtx), {
        tenantId: requireAnalyticsAdmin(gqlCtx),
        siteId: (args as { siteId?: string }).siteId ?? null,
      }),
  },
  analyticsSites: {
    type: new GraphQLNonNull(
      new GraphQLList(new GraphQLNonNull(AnalyticsSiteType)),
    ),
    description:
      "Websites registered for tag-based measurement (admin-only). A site's id ships in the public snippet.",
    resolve: async (_src, _args, gqlCtx) =>
      listSites(dbOf(gqlCtx), requireAnalyticsAdmin(gqlCtx)),
  },
  analyticsEventNames: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
    description: "Distinct tracked event names ordered by volume (admin-only).",
    resolve: async (_src, _args, gqlCtx) =>
      listEventNames(dbOf(gqlCtx), requireAnalyticsAdmin(gqlCtx)),
  },
  analyticsFunnel: {
    type: new GraphQLNonNull(FunnelResultType),
    description:
      "Ordered conversion funnel — each step counted only when it follows the previous one within `windowDays` of the visitor's own entry (admin-only).",
    args: {
      steps: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
      },
      windowDays: { type: GraphQLInt },
      from: { type: GraphQLFloat },
      to: { type: GraphQLFloat },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAnalyticsAdmin(gqlCtx);
      const a = args as {
        steps: string[];
        windowDays?: number;
        from?: number;
        to?: number;
      };
      const { from, to } = resolveRange(a);
      return analyticsFunnel(dbOf(gqlCtx), {
        tenantId,
        from,
        to,
        steps: a.steps,
        windowDays: a.windowDays,
      });
    },
  },
  analyticsRetention: {
    type: new GraphQLNonNull(RetentionResultType),
    description:
      "Cohort retention keyed on each visitor's first-ever active day (admin-only).",
    args: {
      event: { type: GraphQLString },
      from: { type: GraphQLFloat },
      to: { type: GraphQLFloat },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAnalyticsAdmin(gqlCtx);
      const a = args as { event?: string | null; from?: number; to?: number };
      const { from, to } = resolveRange(a);
      return analyticsRetention(dbOf(gqlCtx), {
        tenantId,
        from,
        to,
        event: a.event ?? null,
      });
    },
  },
  analyticsEvents: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AnalyticsEventType))),
    description: "Recent raw tracked events — the debug view (admin-only).",
    args: {
      name: { type: GraphQLString },
      distinctId: { type: GraphQLString },
      limit: { type: GraphQLInt },
      from: { type: GraphQLFloat },
      to: { type: GraphQLFloat },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAnalyticsAdmin(gqlCtx);
      const a = args as {
        name?: string;
        distinctId?: string;
        limit?: number;
        from?: number;
        to?: number;
      };
      return listAnalyticsEvents(dbOf(gqlCtx), {
        tenantId,
        limit: a.limit ?? 100,
        from: a.from,
        to: a.to,
        name: a.name ?? null,
        distinctId: a.distinctId ?? null,
      });
    },
  },
  errorGroups: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ErrorGroupType))),
    description: "Deduplicated crash groups, most recently seen first (admin-only).",
    args: {
      status: { type: GraphQLString },
      level: { type: GraphQLString },
      since: { type: GraphQLFloat },
      limit: { type: GraphQLInt },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAnalyticsAdmin(gqlCtx);
      const a = args as {
        status?: string;
        level?: string;
        since?: number;
        limit?: number;
      };
      return listErrorGroups(dbOf(gqlCtx), {
        tenantId,
        limit: a.limit ?? 50,
        status: a.status ?? null,
        level: a.level ?? null,
        since: a.since,
      });
    },
  },
  errorGroup: {
    type: ErrorGroupDetailType,
    description:
      "One crash group with its recent occurrences, daily series and affected-visitor count (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAnalyticsAdmin(gqlCtx);
      return getErrorGroup(dbOf(gqlCtx), tenantId, (args as { id: string }).id);
    },
  },
};

export const analyticsMutationFields: Record<
  string,
  GraphQLFieldConfig<unknown, GqlCtx>
> = {
  trackEvents: {
    type: new GraphQLNonNull(IngestResultType),
    description:
      "Append a batch of tracked product events (admin-only on this surface; browser and mobile clients use the REST ingest endpoint with a publishable key).",
    args: {
      events: {
        type: new GraphQLNonNull(
          new GraphQLList(new GraphQLNonNull(TrackEventInputType)),
        ),
      },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAnalyticsAdmin(gqlCtx);
      const a = args as { events: Parameters<typeof recordEvents>[2] };
      return recordEvents(dbOf(gqlCtx), tenantId, a.events);
    },
  },
  trackErrors: {
    type: new GraphQLNonNull(IngestResultType),
    description:
      "Append a batch of error occurrences, folding them into their fingerprinted groups (admin-only on this surface).",
    args: {
      errors: {
        type: new GraphQLNonNull(
          new GraphQLList(new GraphQLNonNull(TrackErrorInputType)),
        ),
      },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAnalyticsAdmin(gqlCtx);
      const a = args as { errors: Parameters<typeof recordErrors>[2] };
      return recordErrors(dbOf(gqlCtx), tenantId, a.errors);
    },
  },
  createAnalyticsSegment: {
    type: new GraphQLNonNull(SegmentType),
    description: "Save an analytics filter (admin-only).",
    args: {
      name: { type: new GraphQLNonNull(GraphQLString) },
      siteId: { type: GraphQLString },
      definition: { type: new GraphQLNonNull(JSONScalar) },
    },
    resolve: async (_src, args, gqlCtx) =>
      createSegment(
        dbOf(gqlCtx),
        requireAnalyticsAdmin(gqlCtx),
        args as never,
        gqlCtx.auth.userId ?? null,
      ),
  },
  updateAnalyticsSegment: {
    type: new GraphQLNonNull(SegmentType),
    description: "Update a saved analytics filter (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      name: { type: GraphQLString },
      siteId: { type: GraphQLString },
      definition: { type: JSONScalar },
    },
    resolve: async (_src, args, gqlCtx) => {
      const { id, ...patch } = args as { id: string } & Record<string, unknown>;
      return updateSegment(dbOf(gqlCtx), requireAnalyticsAdmin(gqlCtx), id, patch);
    },
  },
  deleteAnalyticsSegment: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Remove a saved analytics filter (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      await deleteSegment(
        dbOf(gqlCtx),
        requireAnalyticsAdmin(gqlCtx),
        (args as { id: string }).id,
      );
      return true;
    },
  },
  createAnalyticsSite: {
    type: new GraphQLNonNull(AnalyticsSiteType),
    description: "Register a website for tag-based measurement (admin-only).",
    args: {
      name: { type: new GraphQLNonNull(GraphQLString) },
      domain: { type: new GraphQLNonNull(GraphQLString) },
      tz: siteArgs.tz,
      excludedPaths: siteArgs.excludedPaths,
      ignoredIps: siteArgs.ignoredIps,
      filterBots: siteArgs.filterBots,
      requireKnownOrigin: siteArgs.requireKnownOrigin,
    },
    resolve: async (_src, args, gqlCtx) =>
      createSite(dbOf(gqlCtx), requireAnalyticsAdmin(gqlCtx), args as SiteInput),
  },
  updateAnalyticsSite: {
    type: new GraphQLNonNull(AnalyticsSiteType),
    description: "Update a registered website's settings (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) }, ...siteArgs },
    resolve: async (_src, args, gqlCtx) => {
      const { id, ...patch } = args as { id: string } & SiteInput;
      return updateSite(dbOf(gqlCtx), requireAnalyticsAdmin(gqlCtx), id, patch);
    },
  },
  deleteAnalyticsSite: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Remove a registered website (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      await deleteSite(
        dbOf(gqlCtx),
        requireAnalyticsAdmin(gqlCtx),
        (args as { id: string }).id,
      );
      return true;
    },
  },
  updateErrorGroup: {
    type: new GraphQLNonNull(ErrorGroupType),
    description:
      "Set a crash group's status to open / resolved / ignored (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      status: { type: new GraphQLNonNull(GraphQLString) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAnalyticsAdmin(gqlCtx);
      const a = args as { id: string; status: string };
      return updateErrorGroup(
        dbOf(gqlCtx),
        tenantId,
        a.id,
        { status: a.status },
        gqlCtx.auth.userId ?? null,
      );
    },
  },
  deleteErrorGroup: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Delete a crash group and every captured occurrence (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireAnalyticsAdmin(gqlCtx);
      await deleteErrorGroup(dbOf(gqlCtx), tenantId, (args as { id: string }).id);
      return true;
    },
  },
};
