import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { listApiKeys } from "../services/api-keys";
import {
  saveUsageLimits,
  usageExport,
  usageExportCsv,
  usageOverview,
} from "../services/usage";

const requireAdminMw: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  await next();
};

const UsageDayPoint = z
  .object({
    day: z.string().openapi({ description: "UTC day, YYYY-MM-DD." }),
    requests: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  })
  .openapi("UsageDayPoint");

const UsageKeyRow = z
  .object({
    id: z.string().openapi({
      description: "API key id; empty string = the session / no-key bucket.",
    }),
    name: z.string(),
    prefix: z.string().nullable(),
    revoked: z.boolean(),
    rateLimitPerMinute: z.number().int().nullable(),
    monthlyQuota: z.number().int().nullable(),
    monthRequests: z.number().int().nonnegative(),
    monthErrors: z.number().int().nonnegative(),
  })
  .openapi("UsageKeyRow");

const UsageLimitsShape = z
  .object({
    mode: z.enum(["off", "soft", "hard"]),
    maxRequestsPerMonth: z.number().int().nullable(),
    maxStorageBytes: z.number().int().nullable(),
    maxDbRows: z.number().int().nullable(),
  })
  .openapi("UsageLimits");

const UsageOverviewResponse = z
  .object({
    month: z.string().openapi({ description: "Current UTC month, YYYY-MM." }),
    days: z.number().int(),
    series: z.array(UsageDayPoint),
    keySeries: z.array(
      z
        .object({
          day: z.string(),
          apiKeyId: z.string().openapi({
            description: "API key id; empty string = the session / no-key bucket.",
          }),
          requests: z.number().int().nonnegative(),
          errors: z.number().int().nonnegative(),
        })
        .openapi("UsageKeyDayPoint"),
    ),
    monthTotals: z.object({
      requests: z.number().int().nonnegative(),
      errors: z.number().int().nonnegative(),
    }),
    byKey: z.array(UsageKeyRow),
    gauges: z.object({
      storageBytes: z.number().int().nullable(),
      dbRows: z.number().int().nullable(),
      measuredAt: z.number().int().nullable(),
    }),
    limits: UsageLimitsShape.openapi({
      description: "Effective limits — env overrides already applied.",
    }),
    settingsLimits: UsageLimitsShape.openapi({
      description: "Admin-editable setting values, before env overrides.",
    }),
    envPinned: z.array(
      z.enum(["mode", "maxRequestsPerMonth", "maxStorageBytes", "maxDbRows"]),
    ),
    over: z.array(z.enum(["requests", "storage", "rows"])),
  })
  .openapi("UsageOverviewResponse");

const DAY_PARAM = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

const UsageExportRowShape = z
  .object({
    day: z.string(),
    apiKeyId: z.string().openapi({
      description: "API key id; empty string = the session / no-key bucket.",
    }),
    keyName: z.string(),
    keyPrefix: z.string().nullable(),
    requests: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    storageBytes: z.number().int().nullable(),
    dbRows: z.number().int().nullable(),
  })
  .openapi("UsageExportRow");

const UsageExportResponse = z
  .object({
    from: z.string(),
    to: z.string(),
    rows: z.array(UsageExportRowShape),
  })
  .openapi("UsageExportResponse");

const LimitsInput = z
  .object({
    mode: z.enum(["off", "soft", "hard"]),
    maxRequestsPerMonth: z.number().int().min(1).nullable(),
    maxStorageBytes: z.number().int().min(1).nullable(),
    maxDbRows: z.number().int().min(1).nullable(),
  })
  .openapi("UsageLimitsInput");

const TAGS = ["usage"];

const requireTenant = (auth: { tenantId?: string | null }): string => {
  if (!auth.tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return auth.tenantId;
};

export const usageRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/overview",
      tags: TAGS,
      summary: "Workspace usage overview",
      description:
        "Per-day request/error series, per-API-key monthly totals, storage/row gauges, and the effective usage limits. Admin only.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        query: z.object({
          days: z.coerce.number().int().min(1).max(90).optional().openapi({
            description: "Series window in days (default 30, max 90).",
          }),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: UsageOverviewResponse }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c.get("auth"));
      const days = c.req.valid("query").days ?? 30;
      const keys = await listApiKeys(ctx, tenantId, null);
      const data = await usageOverview(ctx, tenantId, days, keys);
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/export",
      tags: TAGS,
      summary: "Export the usage ledger",
      description:
        "Raw `usage_counters` rows — one per (day, API key) — for downstream billing reconciliation. The in-memory counter buffer is flushed before reading. Defaults to the current UTC month-to-date; `format=csv` downloads an RFC 4180 file. Admin only.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        query: z.object({
          from: DAY_PARAM.openapi({
            description: "First UTC day, YYYY-MM-DD (default: first of the current month).",
          }),
          to: DAY_PARAM.openapi({
            description: "Last UTC day inclusive, YYYY-MM-DD (default: today).",
          }),
          format: z.enum(["json", "csv"]).optional().openapi({
            description: "Response shape (default json).",
          }),
        }),
      },
      responses: {
        200: {
          description: "Ledger rows",
          content: {
            "application/json": {
              schema: z.object({ data: UsageExportResponse }),
            },
            "text/csv": { schema: z.string() },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c.get("auth"));
      const { from, to, format } = c.req.valid("query");
      const keys = await listApiKeys(ctx, tenantId, null);
      const data = await usageExport(ctx, tenantId, { from, to }, keys);
      if (format === "csv") {
        return new Response(usageExportCsv(data.rows), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="usage-${data.from}--${data.to}.csv"`,
          },
        });
      }
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/limits",
      tags: TAGS,
      summary: "Set workspace usage limits",
      description:
        "Persists the admin-editable usage limits (`usageLimits` setting). Fields pinned by `USAGE_LIMIT_*` env vars still win at enforcement time. Admin only.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: LimitsInput } },
        },
      },
      responses: {
        200: {
          description: "Saved",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c.get("auth"));
      await saveUsageLimits(ctx, tenantId, c.req.valid("json"));
      return c.json({ ok: true });
    },
  );
