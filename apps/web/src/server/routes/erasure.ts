import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import {
  ERASURE_LIMITS,
  ERASURE_MODES,
  ERASURE_SURFACES,
  getErasureRequest,
  listErasureRequests,
  previewErasure,
  runErasure,
} from "../services/erasure";
import { logActivity } from "../services/activity";
import { SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) throw new AppError("FORBIDDEN", "Admin role required");
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const SubjectSchema = z
  .object({
    type: z.enum(["app_user", "email", "consent_id"]).openapi({
      description:
        "`app_user` resolves an end-user id; `email` matches an address across collections; " +
        "`consent_id` is the opaque token a cookie banner minted in the visitor's own browser, " +
        "and reaches ONLY their consent records — a consent record carries no email and no " +
        "account, so an `email` or `app_user` request will not find one.",
    }),
    value: z.string().min(1),
  })
  .openapi("ErasureSubject");

const RequestView = z
  .object({
    id: z.string(),
    subjectType: z.string(),
    /** A short salted digest. The subject itself is never stored or returned. */
    subjectRef: z.string(),
    mode: z.string(),
    status: z.string(),
    plan: z.record(z.string(), z.unknown()).nullable(),
    report: z.record(z.string(), z.unknown()).nullable(),
    error: z.string().nullable(),
    reference: z.string().nullable(),
    requestedBy: z.string().nullable(),
    previewedAt: z.union([z.number(), z.date()]).nullable(),
    completedAt: z.union([z.number(), z.date()]).nullable(),
    createdAt: z.union([z.number(), z.date()]).nullable(),
    limits: z.array(z.string()),
  })
  .openapi("ErasureRequest");

const tags = ["erasure"];

/**
 * Data-subject erasure. Admin-only, and two-step by design: preview produces a
 * plan of counts, `run` carries it out and cannot be undone.
 *
 * The subject is supplied on BOTH calls. That is not an oversight — the request
 * row stores only a salted hash, so there is no stored address to act on, and
 * re-supplying it is what proves the second call means the same person.
 */
export const erasureRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List erasure requests",
      description:
        "Admin-only. Requests never contain the subject's address or id — only a short salted digest, " +
        "because a record of who was erased outlives every row it removed.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.array(RequestView) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await listErasureRequests(c.get("ctx"), requireTenant(c)) }),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/surfaces",
      tags,
      summary: "What erasure reaches, and what it cannot",
      description:
        "The surfaces a run walks, and the limits it cannot cross. The limits are part of the contract: " +
        "a tool that ignored them while reporting success would say a legal obligation is discharged when " +
        "it is not.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  surfaces: z.array(z.string()),
                  modes: z.array(z.string()),
                  limits: z.array(z.string()),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    (c) =>
      c.json({
        data: { surfaces: [...ERASURE_SURFACES], modes: [...ERASURE_MODES], limits: [...ERASURE_LIMITS] },
      }),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/preview",
      tags,
      summary: "Preview an erasure",
      description:
        "Admin-only. Finds everything that belongs to the subject and reports per-surface counts. Destroys " +
        "nothing. Run this first — the execute endpoint refuses a request that was never previewed.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                subject: SubjectSchema,
                mode: z.enum(["anonymize", "delete"]).openapi({
                  description:
                    "`anonymize` keeps rows with identifying fields scrubbed — often the only lawful " +
                    "option, since an invoice usually cannot be deleted. `delete` removes them.",
                }),
                reference: z.string().max(200).optional().openapi({
                  description: "Your own ticket or case id. Stored as-is; keep it free of personal data.",
                }),
              }),
            },
          },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: RequestView }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const data = await previewErasure(c.get("ctx"), tenantId, c.get("auth").userId ?? null, body);
      await logActivity(c, {
        action: "create",
        collection: "system_erasure_requests",
        itemId: data.id,
        // The subject is deliberately absent: the activity log is one of the
        // surfaces an erasure clears, and logging the address here would put it
        // back on every future request.
        payload: { mode: data.mode, subjectType: data.subjectType },
      });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/run",
      tags,
      summary: "Carry out an erasure",
      description:
        "Admin-only and IRREVERSIBLE. Re-locates the subject rather than acting on the stored plan, since " +
        "the preview may be days old. The subject must be supplied again and must match the one previewed — " +
        "the request row holds only a hash, so there is no stored address to act on.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                subject: SubjectSchema,
                confirm: z.literal(true).openapi({
                  description: "Must be `true`. Present so this cannot be triggered by an empty body.",
                }),
              }),
            },
          },
        },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: RequestView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const { subject } = c.req.valid("json");
      const data = await runErasure(c.get("ctx"), tenantId, id, subject);
      await logActivity(c, {
        action: "delete",
        collection: "system_erasure_requests",
        itemId: id,
        payload: { mode: data.mode, report: data.report },
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags,
      summary: "One erasure request",
      description: "Admin-only. Carries the plan, the report of what was actually removed, and the limits.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: RequestView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const data = await getErasureRequest(c.get("ctx"), requireTenant(c), c.req.valid("param").id);
      if (!data) throw new AppError("NOT_FOUND", "Erasure request not found");
      return c.json({ data });
    },
  );
