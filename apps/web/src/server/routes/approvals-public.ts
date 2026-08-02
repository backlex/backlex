import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, MAX_REASON } from "@backlex/core";
import type { AppBindings } from "../app";
import { PUBLIC_SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { rateLimitOk } from "../lib/rate-limit";
import { setMeterTenant } from "../lib/usage-meter";
import { requestMeta } from "../services/activity";
import {
  markViewed,
  recordDecision,
  resolveByToken,
  toDecisionView,
  type ResolvedApprover,
} from "../services/approvals";

/**
 * The approver's side — public, unauthenticated, mounted at `/api/public/approve`.
 * The link token is the entire grant, exactly like a signing link, so there is
 * no `requireUser` here and nothing on these routes takes an id: a caller who
 * has the token is the approver, and a caller who does not cannot address
 * anybody else's request.
 *
 * The `/api/public/` prefix inherits the framable CSP + XFO-strip in app.ts.
 */

const TAGS = ["approvals"];

/** An approver opens the link, reads, maybe re-reads on another device. */
const VIEW_MAX_PER_MINUTE = 60;
/** Deciding is a once-per-request act; the budget is for retries. */
const DECIDE_MAX_PER_MINUTE = 8;
const WINDOW_MS = 60_000;

const NOT_AVAILABLE = "This approval link is not valid";

const DecisionViewSchema = z
  .object({
    title: z.string(),
    message: z.string().nullable(),
    summary: z.array(z.unknown()),
    status: z.string(),
    policy: z.string(),
    ordered: z.boolean(),
    expiresAt: z.unknown().nullable(),
    you: z.object({
      email: z.string(),
      name: z.string().nullable(),
      role: z.string().nullable(),
      status: z.string(),
      position: z.number(),
      of: z.number(),
    }),
    decided: z.array(z.unknown()),
    /** Non-null when the page must explain why it cannot be acted on. */
    blocked: z.string().nullable(),
  })
  .openapi("ApprovalDecisionView");

const DecideBody = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().max(MAX_REASON).nullish(),
  })
  .openapi("ApprovalDecisionInput");

/**
 * Resolve the token or refuse identically for every failure.
 *
 * An unknown token, a deleted request and a cancelled one all answer 404 with
 * the same sentence: distinguishing them would turn this endpoint into an
 * oracle for whether a given token ever existed.
 */
const requireApprover = async (
  ctx: Parameters<typeof resolveByToken>[0],
  token: string,
): Promise<ResolvedApprover> => {
  const resolved = await resolveByToken(ctx, token);
  if (!resolved) throw new AppError("NOT_FOUND", NOT_AVAILABLE);
  return resolved;
};

export const approvalsPublicRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/{token}",
      tags: TAGS,
      summary: "Resolve an approval link",
      description:
        "PUBLIC — no auth. Returns what the approver needs to decide: the title, the frozen summary, their own position and whether it is their turn. Marks the link as viewed. Never exposes the other approvers' addresses.",
      security: PUBLIC_SECURITY,
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: DecisionViewSchema }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { token } = c.req.valid("param");
      const meta = requestMeta(c.req.raw);
      const ok = await rateLimitOk(
        ctx.env,
        `approve-view:${meta.ip ?? "unknown"}`,
        VIEW_MAX_PER_MINUTE,
        WINDOW_MS,
      );
      if (!ok) throw new AppError("RATE_LIMITED", "Too many requests — please wait a moment");

      const resolved = await requireApprover(ctx, token);
      // No authenticated identity on this path, so the request row is what
      // attributes the call to a workspace for usage metering.
      setMeterTenant(c, resolved.request.tenantId);
      if (resolved.request.status === "pending") await markViewed(ctx, resolved);
      return c.json({ data: toDecisionView(resolved) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{token}",
      tags: TAGS,
      summary: "Approve or reject",
      description:
        "PUBLIC — no auth. Records the decision, the reason, the IP and the user agent, then re-evaluates the policy. When the answer settles the request, the write-back runs, the outcome mail goes out and any waiting flow resumes — exactly once. A second call answers 409.",
      security: PUBLIC_SECURITY,
      request: {
        params: z.object({ token: z.string() }),
        body: { required: true, content: { "application/json": { schema: DecideBody } } },
      },
      responses: {
        200: {
          description: "Decided",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({ status: z.string(), outcome: z.string() }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { token } = c.req.valid("param");
      const body = c.req.valid("json");
      const meta = requestMeta(c.req.raw);
      const resolved = await requireApprover(ctx, token);
      setMeterTenant(c, resolved.request.tenantId);
      // Keyed on the approver, not the IP: two people deciding from one office
      // must not spend each other's budget, and one token is one approver.
      const ok = await rateLimitOk(
        ctx.env,
        `approve:${resolved.approver.id}`,
        DECIDE_MAX_PER_MINUTE,
        WINDOW_MS,
      );
      if (!ok) throw new AppError("RATE_LIMITED", "Too many attempts — please wait a moment");

      const result = await recordDecision(
        ctx,
        resolved,
        body.decision,
        { ...(body.reason ? { reason: body.reason } : {}) },
        meta,
      );
      return c.json({ data: { status: result.request.status, outcome: result.outcome } });
    },
  );
