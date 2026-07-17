import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { getTrace, listTraces } from "../services/traces";
import { defaultHook } from "../lib/openapi-router";

const TraceSummary = z
  .object({
    traceId: z.string(),
    name: z.string(),
    rootStatus: z.number().int().nullable(),
    spanCount: z.number().int(),
    durationMs: z.number().int(),
    startedAt: z.number().int(),
    hasError: z.boolean(),
  })
  .openapi("TraceSummary");

const SpanRow = z
  .object({
    id: z.string(),
    traceId: z.string(),
    spanId: z.string(),
    parentSpanId: z.string().nullable(),
    name: z.string(),
    method: z.string().nullable(),
    path: z.string().nullable(),
    status: z.number().int().nullable(),
    userId: z.string().nullable(),
    durationMs: z.number().int().nullable(),
    attributes: z.record(z.string(), z.unknown()).nullable(),
    startedAt: z.number().int(),
  })
  .openapi("SpanRow");

/** Traces are cross-user infrastructure telemetry — admin only. */
const requireAdmin = (roles: string[]): void => {
  if (!roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required to view traces");
  }
};

export const tracesRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["traces"],
      summary: "List recent request traces",
      description:
        "Admin-only. Returns recent traces (spans grouped by `traceId`, " +
        "summarized by their root span), newest first. Filter by a `from` " +
        "epoch-ms lower bound, a `path` substring, and `minStatus` (e.g. `400` " +
        "for failing requests). `limit` caps the number of traces (max 200).",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        query: z.object({
          from: z.coerce.number().int().optional(),
          path: z.string().optional(),
          minStatus: z.coerce.number().int().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(TraceSummary) }) },
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
      const { traces } = await listTraces(
        { db: ctx.db, dialect: ctx.dialect },
        {
          tenantId: auth.tenantId ?? null,
          limit: Math.min(200, Math.max(1, q.limit ?? 50)),
          from: q.from,
          path: q.path,
          minStatus: q.minStatus,
        },
      );
      return c.json({ data: traces });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{traceId}",
      tags: ["traces"],
      summary: "Get one trace (waterfall)",
      description:
        "Admin-only. Returns every span sharing the given `traceId`, ordered " +
        "earliest-first for a waterfall view.",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ traceId: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ traceId: z.string(), spans: z.array(SpanRow) }),
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
      const { traceId } = c.req.valid("param");
      const { spans } = await getTrace(
        { db: ctx.db, dialect: ctx.dialect },
        traceId,
        auth.tenantId ?? null,
      );
      return c.json({ traceId, spans });
    },
  );
