import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import {
  APPROVAL_POLICIES,
  APPROVAL_STATUSES,
  AppError,
  MAX_APPROVERS,
  MAX_EXPIRY_HOURS,
  MAX_REASON,
  SYSTEM_ROLES,
  type ApprovalPolicy,
} from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import {
  cancelRequest,
  createApprovalRequest,
  getApprovalRequest,
  listApprovalRequests,
} from "../services/approvals";

/**
 * Approval requests, from the operator's side.
 *
 * Admin-only, for the same reason signature requests are: raising one commits
 * the workspace to mailing named people a bearer link, and settling one can
 * patch a row and resume arbitrary flow operations. The approver's side needs
 * no account at all and lives in `routes/approvals-public.ts`.
 */

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

const tags = ["approvals"];

const tenantOf = (c: { get: (k: string) => any }): string | null =>
  (c.get("auth")?.tenantId as string | undefined) ?? null;

const ApproverView = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    role: z.string().nullable(),
    order: z.number(),
    status: z.string(),
    sentAt: z.unknown().nullable(),
    viewedAt: z.unknown().nullable(),
    decidedAt: z.unknown().nullable(),
    reason: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
  })
  .openapi("Approver");

const RequestView = z
  .object({
    id: z.string(),
    title: z.string(),
    message: z.string().nullable(),
    subject: z.object({ collection: z.string(), id: z.string() }).nullable(),
    summary: z.array(z.unknown()),
    policy: z.string(),
    quorum: z.number(),
    ordered: z.boolean(),
    status: z.string(),
    expiresAt: z.unknown().nullable(),
    settledAt: z.unknown().nullable(),
    outcomeReason: z.string().nullable(),
    writeBack: z.unknown().nullable(),
    createdBy: z.string().nullable(),
    createdAt: z.unknown().nullable(),
    updatedAt: z.unknown().nullable(),
    approvers: z.array(ApproverView),
  })
  .openapi("ApprovalRequest");

const CreateInput = z
  .object({
    title: z.string().min(1).max(300),
    message: z.string().max(2000).nullish(),
    approvers: z
      .array(
        z.object({
          email: z.string().min(3).max(320),
          name: z.string().max(120).nullish(),
          role: z.string().max(80).nullish(),
        }),
      )
      .min(1)
      .max(MAX_APPROVERS),
    policy: z.enum(APPROVAL_POLICIES as unknown as [string, ...string[]]).optional(),
    quorum: z.number().int().min(1).max(MAX_APPROVERS).optional(),
    ordered: z.boolean().optional(),
    expiresInHours: z.number().int().min(1).max(MAX_EXPIRY_HOURS).optional(),
    subject: z.object({ collection: z.string().min(1), id: z.string().min(1) }).nullish(),
    summary: z
      .array(z.object({ label: z.string().max(120), value: z.string().max(2000) }))
      .max(40)
      .optional(),
    writeBack: z
      .object({
        collection: z.string().min(1).optional(),
        id: z.string().min(1).optional(),
        field: z.string().min(1),
        approvedValue: z.unknown().optional(),
        rejectedValue: z.unknown().optional(),
      })
      .nullish(),
    notifyEmails: z.array(z.string().max(320)).max(10).optional(),
    send: z.boolean().optional(),
  })
  .openapi("CreateApprovalRequestInput");

const CreateResult = z
  .object({
    request: RequestView,
    /** Returned exactly once — only the hashes are stored, so nothing can
     *  reproduce these afterwards. */
    links: z.array(z.object({ approverId: z.string(), email: z.string(), url: z.string() })),
    sent: z.boolean(),
  })
  .openapi("CreateApprovalRequestResult");

export const approvalsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List approval requests",
      description:
        "Admin-only. Pending requests sort first, then by how soon they expire — the order an operator chasing answers actually wants.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        query: z.object({
          status: z.enum(APPROVAL_STATUSES as unknown as [string, ...string[]]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.array(RequestView) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const data = await listApprovalRequests(c.get("ctx"), tenantOf(c), {
        ...(q.status ? { status: q.status } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Ask people to approve something",
      description:
        "Admin-only. Mints one link per approver and (unless `send:false`) emails whoever may decide now. The plaintext links come back on this response and nowhere else.",
      security: SECURITY,
      middleware: adminGate,
      request: { body: { required: true, content: { "application/json": { schema: CreateInput } } } },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: CreateResult }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const auth = c.get("auth");
      const data = await createApprovalRequest(
        c.get("ctx"),
        tenantOf(c),
        {
          title: body.title,
          ...(body.message ? { message: body.message } : {}),
          approvers: body.approvers.map((a) => ({
            email: a.email,
            ...(a.name ? { name: a.name } : {}),
            ...(a.role ? { role: a.role } : {}),
          })),
          ...(body.policy ? { policy: body.policy as ApprovalPolicy } : {}),
          ...(body.quorum !== undefined ? { quorum: body.quorum } : {}),
          ...(body.ordered !== undefined ? { ordered: body.ordered } : {}),
          ...(body.expiresInHours !== undefined ? { expiresInHours: body.expiresInHours } : {}),
          ...(body.subject ? { subject: body.subject } : {}),
          ...(body.summary ? { summary: body.summary } : {}),
          ...(body.writeBack ? { writeBack: body.writeBack } : {}),
          ...(body.notifyEmails ? { notifyEmails: body.notifyEmails } : {}),
          ...(body.send !== undefined ? { send: body.send } : {}),
        },
        auth?.userId ?? null,
      );
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags,
      summary: "Read one approval request",
      description:
        "Admin-only. Carries the full decision trail — who was asked, who answered, when, from where and why. Never carries the links or the parked flow continuation.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: RequestView }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      return c.json({ data: await getApprovalRequest(c.get("ctx"), id, tenantOf(c)) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/cancel",
      tags,
      summary: "Withdraw an approval request",
      description:
        "Admin-only. Closes the request and kills every outstanding link. A cancelled request runs NEITHER flow branch — the operator who withdrew it did not ask for the approved path or the rejected one.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z
                .object({ reason: z.string().max(MAX_REASON).nullish() })
                .openapi("CancelApprovalInput"),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Cancelled",
          content: { "application/json": { schema: z.object({ data: RequestView }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      // A bodyless POST omits content-type, so the validator never runs and
      // `valid("json")` is undefined rather than `{}`.
      const body = (c.req.valid("json") ?? {}) as { reason?: string | null };
      return c.json({
        data: await cancelRequest(c.get("ctx"), id, tenantOf(c), body.reason ?? null),
      });
    },
  );
