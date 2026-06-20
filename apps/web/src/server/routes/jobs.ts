import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { enforceIpRateLimit } from "../lib/auth-rate-limit";
import { findByName } from "../services/functions";
import {
  cancelJob,
  enqueueJob,
  getJob,
  listJobs,
  purgeJob,
  retryJob,
  type JobStatus,
} from "../services/jobs";

const JOB_TYPES = ["function", "webhook.deliver"] as const;
const JOB_STATUSES = [
  "pending",
  "active",
  "succeeded",
  "failed",
  "dead_letter",
  "cancelled",
] as const;

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};

const adminGate = [requireUser, requireAdminMiddleware];

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const EnqueueInput = z
  .object({
    type: z.enum(JOB_TYPES).openapi({ description: "Handler that runs the job." }),
    payload: z.record(z.string(), z.unknown()).optional().openapi({
      description: "Handler input. For `function`, `{ name, input }`.",
    }),
    queue: z.string().min(1).max(64).optional(),
    runAt: z.string().datetime().optional().openapi({
      description: "ISO timestamp to delay execution until (default: now).",
    }),
    maxAttempts: z.number().int().min(1).max(50).optional(),
    priority: z.number().int().optional(),
  })
  .openapi("EnqueueJobInput");

const JobSchema = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    queue: z.string(),
    type: z.string(),
    payload: z.unknown(),
    status: z.string(),
    priority: z.number(),
    runAt: z.unknown(),
    attempts: z.number(),
    maxAttempts: z.number(),
    lastError: z.string().nullable(),
    result: z.unknown(),
    createdAt: z.unknown(),
    completedAt: z.unknown().nullable(),
  })
  .openapi("Job");

const tags = ["jobs"];

export const jobsRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Enqueue a durable job",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { required: true, content: { "application/json": { schema: EnqueueInput } } },
      },
      responses: {
        200: {
          description: "Enqueued",
          content: { "application/json": { schema: z.object({ id: z.string() }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      await enforceIpRateLimit(c, "job-enqueue", 60);
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      if (body.type === "function") {
        const name = typeof body.payload?.name === "string" ? body.payload.name : "";
        if (!name) throw new AppError("VALIDATION", "function job requires payload.name");
        const fn = await findByName(ctx, tenantId, name);
        if (!fn) throw new AppError("VALIDATION", `function '${name}' not found`);
      }
      const { id } = await enqueueJob(ctx, {
        type: body.type,
        payload: body.payload ?? {},
        queue: body.queue,
        tenantId,
        runAt: body.runAt ? new Date(body.runAt) : undefined,
        maxAttempts: body.maxAttempts,
        priority: body.priority,
      });
      return c.json({ id });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List jobs",
      security: SECURITY,
      middleware: adminGate,
      request: {
        query: z.object({
          queue: z.string().optional(),
          status: z.enum(JOB_STATUSES).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
      responses: {
        200: {
          description: "Jobs",
          content: { "application/json": { schema: z.object({ jobs: z.array(JobSchema) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const q = c.req.valid("query");
      const jobs = await listJobs(ctx, {
        tenantId,
        queue: q.queue,
        status: q.status as JobStatus | undefined,
        limit: q.limit,
      });
      return c.json({ jobs });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags,
      summary: "Get a job",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "Job", content: { "application/json": { schema: JobSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const job = await getJob(ctx, c.req.valid("param").id, tenantId);
      if (!job) throw new AppError("NOT_FOUND", "Job not found");
      return c.json(job);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/retry",
      tags,
      summary: "Requeue a failed or dead-lettered job",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "Requeued", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const ok = await retryJob(ctx, c.req.valid("param").id, tenantId);
      if (!ok) throw new AppError("VALIDATION", "Only failed, dead-lettered or cancelled jobs can be retried");
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/cancel",
      tags,
      summary: "Cancel a pending job",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "Cancelled", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const ok = await cancelJob(ctx, c.req.valid("param").id, tenantId);
      if (!ok) throw new AppError("VALIDATION", "Only pending jobs can be cancelled");
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete a job",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const ok = await purgeJob(ctx, c.req.valid("param").id, tenantId);
      if (!ok) throw new AppError("NOT_FOUND", "Job not found");
      return c.json({ ok: true });
    },
  );
