import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { applyAdvisorFix, runAdvisorChecks } from "../services/advisor";
import { loadRuntimeInsights } from "../services/advisor-insights";
import { requestMeta } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  await next();
};

const TAGS = ["advisor"];

const AdvisorActionSchema = z
  .object({
    type: z.literal("create-index"),
    table: z.string(),
    indexName: z.string(),
    columns: z.array(z.string()),
    sql: z.string(),
  })
  .openapi("AdvisorAction");

const AdvisorCheckSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["security", "performance"]),
    level: z.enum(["error", "warn", "info"]),
    rule: z.string(),
    groupTitle: z.string(),
    title: z.string(),
    body: z.string(),
    fix: z.string(),
    resource: z.string(),
    link: z.string().optional(),
    action: AdvisorActionSchema.optional(),
    evidence: z
      .object({
        requests: z.number(),
        windowDays: z.number(),
        p95: z.number().optional(),
        errorRate: z.number().optional(),
        share: z.number().optional(),
      })
      .optional(),
  })
  .openapi("AdvisorCheck");

const EndpointStatSchema = z
  .object({
    route: z.string(),
    method: z.string(),
    path: z.string(),
    requests: z.number(),
    p50: z.number(),
    p95: z.number(),
    p99: z.number(),
    maxMs: z.number(),
    avgMs: z.number(),
    serverErrors: z.number(),
    clientErrors: z.number(),
    errorRate: z.number(),
  })
  .openapi("AdvisorEndpointStat");

const ColumnUseSchema = z.object({
  column: z.string(),
  requests: z.number(),
  share: z.number(),
});

const CollectionStatSchema = z
  .object({
    collection: z.string(),
    listRequests: z.number(),
    p50: z.number(),
    p95: z.number(),
    filters: z.array(ColumnUseSchema),
    sorts: z.array(ColumnUseSchema),
  })
  .openapi("AdvisorCollectionStat");

/** Writes that landed outside their role's `write` conditions. Empty means no
 *  recorded write in the window would be refused by
 *  `PERMISSION_WRITE_CHECK=enforce` — the reading the `warn` default exists to
 *  produce, and only as strong as `window.sampleRate`. */
const PermissionWriteCheckStatSchema = z
  .object({
    collection: z.string(),
    action: z.string(),
    requests: z.number(),
    refused: z.boolean(),
  })
  .openapi("AdvisorPermissionWriteCheckStat");

const InsightsSchema = z
  .object({
    endpoints: z.array(EndpointStatSchema),
    collections: z.array(CollectionStatSchema),
    permissionWriteChecks: z.array(PermissionWriteCheckStatSchema),
    window: z.object({
      from: z.number(),
      to: z.number(),
      days: z.number(),
      spanCount: z.number(),
      oldestSpanAt: z.number().nullable(),
      sampleRate: z.number(),
      truncated: z.boolean(),
    }),
  })
  .openapi("AdvisorInsights");

/** Shared `?days=` window parameter. Clamped again server-side. */
const daysQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
});

/**
 * Advisor — automated security + performance lint over live workspace state.
 * Admin-only. Every finding is computed from real DB / env state in
 * `services/advisor.ts`; these routes just resolve the tenant scope and
 * delegate.
 */
export const advisorRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: TAGS,
      summary: "Run advisor checks",
      description:
        "Returns automated security + performance findings for the active workspace. Performance findings include traffic-derived rules computed from recorded spans over the last `days` (default 7). Admin-only.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: { query: daysQuery },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(AdvisorCheckSchema),
                score: z.number(),
                generatedAt: z.string(),
                runtime: z.object({
                  windowDays: z.number(),
                  spanCount: z.number(),
                  sampleRate: z.number(),
                  truncated: z.boolean(),
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
      const result = await runAdvisorChecks(
        {
          db: ctx.db,
          dialect: ctx.dialect,
          env: ctx.env,
          image: ctx.image,
          edgeImage: ctx.edgeImage,
        },
        auth.tenantId ?? null,
        { windowDays: c.req.valid("query").days },
      );
      return c.json(result);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/insights",
      tags: TAGS,
      summary: "Runtime query insights",
      description:
        "Per-endpoint latency percentiles and error rates, per-collection list traffic and which columns it filters / sorts on, and the writes that landed outside their role's write conditions — all aggregated from recorded spans. `window.sampleRate` below 1 means the numbers describe a sample (`TRACES_SAMPLE_RATE`); counts are spans seen and are never extrapolated. Admin-only.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        query: daysQuery.extend({
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: InsightsSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { days, limit } = c.req.valid("query");
      const insights = await loadRuntimeInsights(
        { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
        auth.tenantId ?? null,
        { days, limit },
      );
      return c.json(insights);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/apply",
      tags: TAGS,
      summary: "Apply an advisor fix",
      description:
        "Carries out the remediation attached to a finding — today that is always `CREATE INDEX IF NOT EXISTS` on a collection's physical table. The statement is NOT taken from the request: the advisor is re-run server-side, the finding is matched by `id`, and its own server-built SQL is executed. A finding with no `action` is rejected. Admin-only.",
      security: SECURITY,
      middleware: [requireUser, requireAdmin],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                id: z.string().min(1),
                /** Window the finding was produced under, so a traffic-derived
                 *  finding still resolves when the client used a custom range. */
                days: z.number().int().min(1).max(90).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.literal(true),
                applied: AdvisorActionSchema,
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
      const { id, days } = c.req.valid("json");
      const meta = requestMeta(c.req.raw, c.get("ctx").env);
      // The shared service re-derives the finding and executes its OWN
      // statement — the client only names which finding to fix.
      const { applied } = await applyAdvisorFix(
        // `image`/`edgeImage` ride along because apply RE-RUNS the checks and
        // matches by finding id — a ctx that resolves a different set of
        // findings than the GET did is how an id stops being found.
        {
          db: ctx.db,
          dialect: ctx.dialect,
          env: ctx.env,
          image: ctx.image,
          edgeImage: ctx.edgeImage,
        },
        auth.tenantId ?? null,
        { id, windowDays: days, userId: auth.userId, ...meta },
      );
      return c.json({ ok: true as const, applied });
    },
  );
