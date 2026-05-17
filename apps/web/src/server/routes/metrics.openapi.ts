import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, errorResponses } from "../lib/openapi";

const MetricsRange = z
  .enum(["15m", "1h", "24h", "7d", "30d"])
  .openapi({ description: "Sliding window for the overview metrics." });

const MetricsBucket = z
  .object({
    ts: z.number().int().openapi({ description: "Unix seconds at the bucket start." }),
    requests: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  })
  .openapi("MetricsBucket");

const TopCollectionStat = z
  .object({
    slug: z.string(),
    rows: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    lastWrite: z.number().int().nullable(),
    writes24h: z.number().int().nonnegative(),
  })
  .openapi("TopCollectionStat");

const RecentLogRow = z
  .object({
    t: z.number().int(),
    action: z.string(),
    collection: z.string().optional(),
    itemId: z.string().optional(),
    userId: z.string().optional(),
    ms: z.number().int().optional(),
    error: z.boolean(),
  })
  .openapi("MetricsRecentLogRow");

const RecentErrorRow = z
  .object({
    code: z.string(),
    resource: z.string(),
    msg: z.string(),
    count: z.number().int().nonnegative(),
    last: z.number().int(),
  })
  .openapi("MetricsRecentErrorRow");

const OverviewResponse = z
  .object({
    range: z.string(),
    windowMs: z.number().int(),
    bucketMs: z.number().int(),
    series: z.array(MetricsBucket),
    totals: z.object({
      requests: z.number().int(),
      errors: z.number().int(),
      errorRate: z.number(),
      activeUsers: z.number().int(),
      p95Ms: z.number(),
    }),
    counts: z.record(z.string(), z.number().int()),
    topCollections: z.array(TopCollectionStat),
    recent: z.array(RecentLogRow),
    recentErrors: z.array(RecentErrorRow),
  })
  .openapi("MetricsOverviewResponse");

const EntitiesResponse = z
  .object({
    flows: z.record(
      z.string(),
      z.object({ runs: z.number().int(), lastRun: z.number().int().nullable() }),
    ),
    functions: z.record(
      z.string(),
      z.object({
        invocations: z.number().int(),
        p95Ms: z.number().int(),
        lastInvoke: z.number().int().nullable(),
      }),
    ),
    webhooks: z.record(
      z.string(),
      z.object({
        deliveries: z.number().int(),
        lastDelivery: z.number().int().nullable(),
      }),
    ),
  })
  .openapi("MetricsEntitiesResponse");

const tags = ["metrics"];

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/metrics/overview",
  tags,
  summary: "Overview metrics for the admin dashboard",
  description: "Bucketed request/error series + totals + per-collection stats. Derived from the `activity` table. Admin only.",
  security: SECURITY,
  request: { query: z.object({ range: MetricsRange.optional() }) },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: OverviewResponse }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/metrics/entities",
  tags,
  summary: "Per-entity activity stats (flows / functions / webhooks)",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: EntitiesResponse }) } },
    },
    ...errorResponses,
  },
});

export const _MetricsOverviewResponse = OverviewResponse;
export const _MetricsEntitiesResponse = EntitiesResponse;
