/**
 * Admin analytics surface (#22) — reads over the tracked-event stream and the
 * crash-report groups, plus ingest-key management.
 *
 * Admin-only throughout: these are cross-user product metrics, the same
 * reasoning that gates `/api/admin/traces`. The write side lives in
 * `routes/analytics-ingest.ts`.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import {
  ERROR_STATUSES,
  MAX_FUNNEL_STEPS,
  analyticsFunnel,
  analyticsOverview,
  analyticsChannels,
  analyticsRealtime,
  analyticsRevenue,
  analyticsRetention,
  analyticsSessions,
  createSegment,
  createSite,
  deleteErrorGroup,
  deleteSegment,
  deleteSite,
  getErrorGroup,
  hasIngestKey,
  listAnalyticsEvents,
  listErrorGroups,
  listEventNames,
  listSegments,
  listSites,
  resolveSegment,
  mintIngestKey,
  revokeIngestKey,
  updateErrorGroup,
  updateSegment,
  updateSite,
} from "../services/analytics";

const TAGS = ["analytics"];

/** Product metrics span every user of the workspace — admin only. */
const requireAdmin = (roles: string[]): void => {
  if (!roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required to view analytics");
  }
};

/** Default reporting window when the caller doesn't pass one. */
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 365;

/** Resolve `from`/`to` query params into a clamped epoch-ms range. */
const resolveRange = (q: { from?: number; to?: number }) => {
  const to = q.to ?? Date.now();
  const from = q.from ?? to - DEFAULT_RANGE_DAYS * 86_400_000;
  if (from > to) {
    throw new AppError("VALIDATION", "`from` must be before `to`.");
  }
  const span = to - from;
  if (span > MAX_RANGE_DAYS * 86_400_000) {
    throw new AppError("VALIDATION", `Range is capped at ${MAX_RANGE_DAYS} days.`);
  }
  return { from, to };
};

const RangeQuery = z.object({
  /** Apply a saved filter. An unknown or no-longer-valid id filters nothing. */
  segmentId: z.string().optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

/** A top-N row over one dimension. Carries `users` as well as `count` because
 *  a website report leads with people, not hits. */
const Breakdown = z.object({
  value: z.string(),
  count: z.number().int(),
  users: z.number().int(),
});

const Overview = z
  .object({
    totals: z.object({
      events: z.number().int(),
      users: z.number().int(),
      sessions: z.number().int(),
      durableUsers: z.number().int(),
      /** Null when no cookieless traffic fell in the range. */
      visitorsPerDay: z.number().int().nullable(),
      cookielessShare: z.number(),
    }),
    series: z.array(
      z.object({
        day: z.string(),
        events: z.number().int(),
        users: z.number().int(),
      }),
    ),
    topEvents: z.array(
      z.object({
        name: z.string(),
        count: z.number().int(),
        users: z.number().int(),
      }),
    ),
    topPaths: z.array(
      z.object({
        path: z.string(),
        count: z.number().int(),
        users: z.number().int(),
      }),
    ),
    topReferrers: z.array(
      z.object({
        referrer: z.string(),
        count: z.number().int(),
        users: z.number().int(),
      }),
    ),
    sources: z.array(
      z.object({
        source: z.string(),
        count: z.number().int(),
        users: z.number().int(),
      }),
    ),
    topCountries: z.array(Breakdown),
    topDevices: z.array(Breakdown),
    topCampaigns: z.array(Breakdown),
  })
  .openapi("AnalyticsOverview");

const FunnelResult = z
  .object({
    windowDays: z.number().int(),
    steps: z.array(
      z.object({
        name: z.string(),
        count: z.number().int(),
        conversion: z.number(),
        dropOff: z.number(),
      }),
    ),
  })
  .openapi("AnalyticsFunnel");

const RetentionResult = z
  .object({
    maxOffset: z.number().int(),
    cohorts: z.array(
      z.object({
        day: z.string(),
        size: z.number().int(),
        values: z.array(z.number().int()),
      }),
    ),
  })
  .openapi("AnalyticsRetention");

const Segment = z
  .object({
    id: z.string(),
    name: z.string(),
    siteId: z.string().nullable(),
    definition: z.unknown(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .openapi("AnalyticsSegment");

const SegmentInput = z.object({
  name: z.string().min(1).max(120),
  siteId: z.string().max(64).nullish(),
  /** Validated by `parseSegment`, not by zod — the shape is recursive and the
   *  field allowlist is the actual check. */
  definition: z.unknown(),
});

const MoneyRow = z.object({
  currency: z.string(),
  revenue: z.number().int(),
  transactions: z.number().int(),
});

const Revenue = z
  .object({
    byCurrency: z.array(MoneyRow.extend({ aov: z.number().int() })),
    byChannel: z.array(MoneyRow.extend({ channel: z.string() })),
    byCampaign: z.array(MoneyRow.extend({ campaign: z.string() })),
    topItems: z.array(
      z.object({
        name: z.string(),
        currency: z.string(),
        quantity: z.number(),
        revenue: z.number(),
      }),
    ),
    truncated: z.boolean(),
  })
  .openapi("AnalyticsRevenue");

const Channels = z
  .object({
    channels: z.array(
      z.object({
        channel: z.string(),
        sessions: z.number().int(),
        visitors: z.number().int(),
      }),
    ),
    sourceMedium: z.array(
      z.object({
        value: z.string(),
        sessions: z.number().int(),
        visitors: z.number().int(),
      }),
    ),
    totalSessions: z.number().int(),
  })
  .openapi("AnalyticsChannels");

const Sessions = z
  .object({
    sessions: z.number().int(),
    pageviews: z.number().int(),
    bounceRate: z.number(),
    avgDurationMs: z.number().int(),
    pagesPerSession: z.number(),
    landingPages: z.array(Breakdown),
    exitPages: z.array(Breakdown),
  })
  .openapi("AnalyticsSessions");

const Realtime = z
  .object({
    visitorsNow: z.number().int(),
    events: z.number().int(),
    byMinute: z.array(
      z.object({
        minute: z.number().int(),
        events: z.number().int(),
        visitors: z.number().int(),
      }),
    ),
    topPaths: z.array(Breakdown),
    topReferrers: z.array(Breakdown),
    topCountries: z.array(Breakdown),
    truncated: z.boolean(),
  })
  .openapi("AnalyticsRealtime");

const Site = z
  .object({
    id: z.string(),
    name: z.string(),
    domain: z.string(),
    tz: z.string(),
    excludedPaths: z.array(z.string()),
    ignoredIps: z.array(z.string()),
    filterBots: z.boolean(),
    requireKnownOrigin: z.boolean(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .openapi("AnalyticsSite");

const SiteInputSchema = z.object({
  name: z.string().min(1).max(120),
  domain: z.string().min(1).max(255),
  tz: z.string().max(60).optional(),
  excludedPaths: z.array(z.string().max(200)).max(50).optional(),
  ignoredIps: z.array(z.string().max(64)).max(50).optional(),
  filterBots: z.boolean().optional(),
  requireKnownOrigin: z.boolean().optional(),
});

const AnalyticsEvent = z
  .object({
    id: z.string(),
    name: z.string(),
    distinctId: z.string(),
    userId: z.string().nullable(),
    sessionId: z.string().nullable(),
    props: z.record(z.string(), z.unknown()).nullable(),
    path: z.string().nullable(),
    referrer: z.string().nullable(),
    source: z.string().nullable(),
    release: z.string().nullable(),
    country: z.string().nullable(),
    siteId: z.string().nullable(),
    idScope: z.string().nullable(),
    deviceType: z.string().nullable(),
    browser: z.string().nullable(),
    os: z.string().nullable(),
    utmSource: z.string().nullable(),
    utmMedium: z.string().nullable(),
    utmCampaign: z.string().nullable(),
    revenue: z.number().int().nullable(),
    currency: z.string().nullable(),
    ts: z.number().int(),
  })
  .openapi("AnalyticsEvent");

const ErrorGroup = z
  .object({
    id: z.string(),
    fingerprint: z.string(),
    type: z.string(),
    message: z.string(),
    culprit: z.string().nullable(),
    level: z.string(),
    platform: z.string().nullable(),
    release: z.string().nullable(),
    status: z.string(),
    events: z.number().int(),
    firstSeen: z.number().int(),
    lastSeen: z.number().int(),
    resolvedAt: z.number().int().nullable(),
    resolvedBy: z.string().nullable(),
  })
  .openapi("ErrorGroup");

const ErrorOccurrence = z
  .object({
    id: z.string(),
    message: z.string(),
    stack: z.string().nullable(),
    level: z.string(),
    platform: z.string().nullable(),
    release: z.string().nullable(),
    url: z.string().nullable(),
    userId: z.string().nullable(),
    distinctId: z.string().nullable(),
    sessionId: z.string().nullable(),
    context: z.record(z.string(), z.unknown()).nullable(),
    ts: z.number().int(),
  })
  .openapi("ErrorOccurrence");

export const analyticsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/overview",
      tags: TAGS,
      summary: "Product analytics overview",
      description:
        "Admin-only. Headline counters (events, unique visitors, sessions), a " +
        "zero-filled daily series, and top-N breakdowns by event name, path, " +
        "referrer and source. `from`/`to` are epoch-ms; the default window is " +
        `the last ${DEFAULT_RANGE_DAYS} days and the maximum span is ${MAX_RANGE_DAYS} days. ` +
        "Unique visitors are counted by `distinctId`, so anonymous traffic is " +
        "included and a visitor who later signs in still counts once.",
      security: SECURITY,
      middleware: [requireUser],
      request: { query: RangeQuery },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: Overview }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const q = c.req.valid("query");
      const { from, to } = resolveRange(q);
      const segment = await resolveSegment(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        q.segmentId,
      );
      const data = await analyticsOverview(
        { db: ctx.db, dialect: ctx.dialect },
        { tenantId: auth.tenantId ?? null, from, to, segment },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/event-names",
      tags: TAGS,
      summary: "List tracked event names",
      description:
        "Admin-only. Distinct event names ordered by volume — what the funnel " +
        "builder offers as selectable steps.",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(z.string()) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const data = await listEventNames(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/funnel",
      tags: TAGS,
      summary: "Run a conversion funnel",
      description:
        "Admin-only. Counts how many visitors completed each step in order. A " +
        "visitor counts at step N only if they fired it strictly after their " +
        "first step N−1 and within `windowDays` of their own step-1 time — the " +
        "standard 'converted within X days of entering' definition, not a fixed " +
        `calendar window. Between 2 and ${MAX_FUNNEL_STEPS} steps.`,
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                steps: z.array(z.string().min(1)).min(2).max(MAX_FUNNEL_STEPS),
                windowDays: z.number().int().min(1).max(365).optional(),
                from: z.number().int().optional(),
                to: z.number().int().optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: FunnelResult }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const body = c.req.valid("json");
      const { from, to } = resolveRange(body);
      const data = await analyticsFunnel(
        { db: ctx.db, dialect: ctx.dialect },
        {
          tenantId: auth.tenantId ?? null,
          from,
          to,
          steps: body.steps,
          windowDays: body.windowDays,
        },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/retention",
      tags: TAGS,
      summary: "Run a cohort retention grid",
      description:
        "Admin-only. Groups visitors into daily cohorts by their **first-ever** " +
        "active day (not merely their first day inside the range, so a returning " +
        "long-time user isn't miscounted as new) and reports how many were active " +
        "each day after. Pass `event` to define activity as one specific event. " +
        "Offsets are capped at 30 days.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                event: z.string().nullish(),
                from: z.number().int().optional(),
                to: z.number().int().optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: RetentionResult }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const body = c.req.valid("json");
      const { from, to } = resolveRange(body);
      const data = await analyticsRetention(
        { db: ctx.db, dialect: ctx.dialect },
        { tenantId: auth.tenantId ?? null, from, to, event: body.event ?? null },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/events",
      tags: TAGS,
      summary: "List raw tracked events",
      description:
        "Admin-only. The newest raw events behind the aggregates — the debug view " +
        "for checking that an SDK is sending what you expect. Filter by event " +
        "`name` and/or `distinctId`.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        query: RangeQuery.extend({
          name: z.string().optional(),
          distinctId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(AnalyticsEvent) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const q = c.req.valid("query");
      const data = await listAnalyticsEvents(
        { db: ctx.db, dialect: ctx.dialect },
        {
          tenantId: auth.tenantId ?? null,
          limit: q.limit ?? 100,
          from: q.from,
          to: q.to,
          name: q.name ?? null,
          distinctId: q.distinctId ?? null,
        },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/errors",
      tags: TAGS,
      summary: "List error groups",
      description:
        "Admin-only. Deduplicated crash groups, most recently seen first. Filter " +
        `by \`status\` (${ERROR_STATUSES.join(" / ")}), \`level\` and a \`since\` ` +
        "epoch-ms lower bound on last-seen.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        query: z.object({
          status: z.enum(ERROR_STATUSES).optional(),
          level: z.enum(["error", "warning", "fatal"]).optional(),
          since: z.coerce.number().int().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(ErrorGroup) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const q = c.req.valid("query");
      const data = await listErrorGroups(
        { db: ctx.db, dialect: ctx.dialect },
        {
          tenantId: auth.tenantId ?? null,
          limit: q.limit ?? 50,
          status: q.status ?? null,
          level: q.level ?? null,
          since: q.since,
        },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/errors/{id}",
      tags: TAGS,
      summary: "Get one error group",
      description:
        "Admin-only. The group plus its most recent captured occurrences (stack " +
        "and context), a per-day occurrence series and the number of distinct " +
        "visitors affected. The series and visitor count are computed over the " +
        "occurrences still within retention; the group's own `events` counter " +
        "survives pruning and remains the lifetime total.",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  group: ErrorGroup,
                  occurrences: z.array(ErrorOccurrence),
                  series: z.array(
                    z.object({ day: z.string(), count: z.number().int() }),
                  ),
                  users: z.number().int(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const { id } = c.req.valid("param");
      const data = await getErrorGroup(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        id,
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/errors/{id}",
      tags: TAGS,
      summary: "Triage an error group",
      description:
        "Admin-only. Set the group's status. `resolved` stamps who resolved it and " +
        "when, but a later occurrence reopens the group — a regression is news. " +
        "`ignored` is sticky: new occurrences still increment the counter but never " +
        "reopen it.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ status: z.enum(ERROR_STATUSES) }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: ErrorGroup }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const data = await updateErrorGroup(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        id,
        { status: body.status },
        auth.userId ?? null,
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/errors/{id}",
      tags: TAGS,
      summary: "Delete an error group",
      description:
        "Admin-only. Removes the group and every captured occurrence. If the bug " +
        "recurs it comes back as a fresh group with the same fingerprint.",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const { id } = c.req.valid("param");
      await deleteErrorGroup(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        id,
      );
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/segments",
      tags: TAGS,
      summary: "Saved analytics filters",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(Segment) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const data = await listSegments(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/segments",
      tags: TAGS,
      summary: "Save an analytics filter",
      description:
        "The definition is a predicate tree over a CLOSED field allowlist. It is " +
        "validated here and re-validated on every read — a stored blob is never " +
        "trusted, and every value is bound rather than spliced into SQL.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: { required: true, content: { "application/json": { schema: SegmentInput } } },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: Segment }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const data = await createSegment(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        c.req.valid("json"),
        auth.userId ?? null,
      );
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/segments/{id}",
      tags: TAGS,
      summary: "Update a saved filter",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: SegmentInput.partial() } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: Segment }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const { id } = c.req.valid("param");
      const data = await updateSegment(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        id,
        c.req.valid("json"),
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/segments/{id}",
      tags: TAGS,
      summary: "Remove a saved filter",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const { id } = c.req.valid("param");
      await deleteSegment(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        id,
      );
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/revenue",
      tags: TAGS,
      summary: "Revenue by currency, channel and campaign",
      description:
        "Admin-only. Amounts are in the currency's MINOR units and every row carries " +
        "its currency — nothing is ever summed across currencies, because this repo " +
        "has no FX rate source and a mixed total would not be a quantity. Item " +
        "breakdowns read `props.items`.",
      security: SECURITY,
      middleware: [requireUser],
      request: { query: RangeQuery.extend({ siteId: z.string().optional() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: Revenue }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const q = c.req.valid("query");
      const { from, to } = resolveRange(q);
      const segment = await resolveSegment(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        q.segmentId,
      );
      const data = await analyticsRevenue(
        { db: ctx.db, dialect: ctx.dialect },
        { tenantId: auth.tenantId ?? null, from, to, siteId: q.siteId ?? null, segment },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/channels",
      tags: TAGS,
      summary: "Where sessions came from",
      description:
        "Admin-only. GA4's Default Channel Groups plus a `source / medium` breakdown. " +
        "Attribution is LAST NON-DIRECT TOUCH WITHIN A SESSION — cookieless visitor " +
        "ids rotate daily, so a campaign that brought someone in on an earlier day " +
        "cannot be joined to this visit. Classification is derived at query time, so " +
        "the whole history reclassifies when the rules change.",
      security: SECURITY,
      middleware: [requireUser],
      request: { query: RangeQuery.extend({ siteId: z.string().optional() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: Channels }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const q = c.req.valid("query");
      const { from, to } = resolveRange(q);
      const segment = await resolveSegment(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        q.segmentId,
      );
      const data = await analyticsChannels(
        { db: ctx.db, dialect: ctx.dialect },
        { tenantId: auth.tenantId ?? null, from, to, siteId: q.siteId ?? null, segment },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/sessions",
      tags: TAGS,
      summary: "Sessions, bounce rate, duration, landing and exit pages",
      description:
        "Admin-only. Derived at query time from the event stream — a 30-minute gap " +
        "between one visitor's hits ends a session. Covers tag traffic only: a " +
        "server-side SDK event is not a visit. Optionally scoped to one site.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        query: RangeQuery.extend({ siteId: z.string().optional() }),
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: Sessions }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const q = c.req.valid("query");
      const { from, to } = resolveRange(q);
      const segment = await resolveSegment(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        q.segmentId,
      );
      const data = await analyticsSessions(
        { db: ctx.db, dialect: ctx.dialect },
        { tenantId: auth.tenantId ?? null, from, to, siteId: q.siteId ?? null, segment },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/realtime",
      tags: TAGS,
      summary: "Who is on the site right now",
      description:
        "Admin-only. The last 30 minutes, bucketed by minute and zero-filled, with " +
        "the top paths, referrers and countries inside that window. Bounded by a " +
        "row cap: `truncated` is true when the figures are a floor rather than a " +
        "total. Optionally scoped to one registered site.",
      security: SECURITY,
      middleware: [requireUser],
      request: { query: z.object({ siteId: z.string().optional() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: Realtime }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const { siteId } = c.req.valid("query");
      const data = await analyticsRealtime(
        { db: ctx.db, dialect: ctx.dialect },
        { tenantId: auth.tenantId ?? null, siteId: siteId ?? null },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/sites",
      tags: TAGS,
      summary: "List registered websites",
      description:
        "Admin-only. Each site is a measurement destination for the web tag; its " +
        "id ships in the public snippet.",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(Site) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const data = await listSites(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/sites",
      tags: TAGS,
      summary: "Register a website",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: SiteInputSchema } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: Site }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const data = await createSite(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        c.req.valid("json"),
      );
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/sites/{id}",
      tags: TAGS,
      summary: "Update a website's settings",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: SiteInputSchema.partial() } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: Site }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const { id } = c.req.valid("param");
      const data = await updateSite(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        id,
        c.req.valid("json"),
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/sites/{id}",
      tags: TAGS,
      summary: "Remove a website",
      description:
        "The snippet stops being accepted immediately. Events already recorded " +
        "keep their `site_id` and are pruned on the normal retention schedule.",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const { id } = c.req.valid("param");
      await deleteSite(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        id,
      );
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/ingest-key",
      tags: TAGS,
      summary: "Whether an ingest key exists",
      description:
        "Admin-only. Reports presence only — the plaintext key is shown once at " +
        "mint time and never stored, so it can't be read back.",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.object({ exists: z.boolean() }) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const exists = await hasIngestKey(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
      );
      return c.json({ data: { exists } });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/ingest-key",
      tags: TAGS,
      summary: "Mint (or rotate) the ingest key",
      description:
        "Admin-only. Returns a fresh publishable `alk_…` key **once** and " +
        "invalidates any previous one. Safe to embed in client bundles: it grants " +
        "append-only ingest and cannot read data back. Cross-origin callers still " +
        "need their origin on the workspace's allowed-origins list.",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": {
              schema: z.object({ data: z.object({ key: z.string() }) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const data = await mintIngestKey(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
      );
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/ingest-key",
      tags: TAGS,
      summary: "Revoke the ingest key",
      description:
        "Admin-only. Any client still sending the revoked key starts getting 401s. " +
        "Idempotent.",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "Revoked",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      await revokeIngestKey(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
      );
      return c.json({ ok: true });
    },
  );
