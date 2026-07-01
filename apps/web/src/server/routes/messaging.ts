import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { enforceIpRateLimit } from "../lib/auth-rate-limit";
import { sendSmsToUsers } from "../services/sms";
import { sendPushToUsers } from "../services/push";

const SendSmsInput = z
  .object({
    userId: z.string().min(1).openapi({ description: "Recipient user id." }),
    body: z.string().min(1).max(1600),
  })
  .openapi("SendSmsInput");

const SendPushInput = z
  .object({
    userId: z.string().min(1).openapi({ description: "Recipient user id." }),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(2000),
    url: z.string().url().optional().openapi({ description: "Optional deep-link URL." }),
    data: z.record(z.string(), z.string()).optional(),
  })
  .openapi("SendPushInput");

const DispatchResult = z.object({
  ok: z.boolean(),
  sent: z.number(),
  failed: z.number(),
});

const TAGS = ["messaging"];

/** Admins may target any user; non-admins may only message themselves. */
const assertMayTarget = (
  auth: { roles: string[]; userId: string | null },
  targetUserId: string,
): void => {
  if (!auth.roles.includes("admin") && targetUserId !== auth.userId) {
    throw new AppError("FORBIDDEN", "Non-admins can only message themselves");
  }
};

/**
 * Direct messaging dispatch (push + SMS). Unlike `/api/notifications` this does
 * NOT drop an in-app row — it only fans out to the target user's registered
 * devices / phone numbers via the workspace transports. Admins may target any
 * user; non-admins may only message themselves. A user with no registered
 * device/number is a silent no-op.
 */
export const messagingRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "post",
      path: "/sms",
      tags: TAGS,
      summary: "Send an SMS to a user's registered phone numbers",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: { required: true, content: { "application/json": { schema: SendSmsInput } } },
      },
      responses: {
        200: {
          description: "Dispatched",
          content: { "application/json": { schema: DispatchResult } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      await enforceIpRateLimit(c, "sms-send", 30);
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = c.req.valid("json");
      assertMayTarget(auth, body.userId);
      const result = await sendSmsToUsers(ctx, auth.tenantId ?? null, {
        userIds: [body.userId],
        body: body.body,
      });
      return c.json({ ok: true, sent: result.sent, failed: result.failed });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/push",
      tags: TAGS,
      summary: "Send a push notification to a user's registered devices",
      description:
        "Dispatch-only: no in-app notification row is created (use `/api/notifications` with `push: true` for that). Silent no-op when the user has no active devices.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: { required: true, content: { "application/json": { schema: SendPushInput } } },
      },
      responses: {
        200: {
          description: "Dispatched",
          content: { "application/json": { schema: DispatchResult } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      await enforceIpRateLimit(c, "push-send", 60);
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = c.req.valid("json");
      assertMayTarget(auth, body.userId);
      const result = await sendPushToUsers(ctx, auth.tenantId ?? null, {
        userIds: [body.userId],
        title: body.title,
        body: body.body,
        url: body.url,
        data: body.data,
      });
      return c.json({ ok: true, sent: result.sent, failed: result.failed });
    },
  );
