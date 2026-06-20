import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { enforceIpRateLimit } from "../lib/auth-rate-limit";
import { sendSmsToUsers } from "../services/sms";

const SendSmsInput = z
  .object({
    userId: z.string().min(1).openapi({ description: "Recipient user id." }),
    body: z.string().min(1).max(1600),
  })
  .openapi("SendSmsInput");

const TAGS = ["messaging"];

/**
 * Direct messaging dispatch (SMS today). Unlike `/api/notifications` this does
 * NOT drop an in-app row — it only fans out to the target user's registered
 * phone numbers via the workspace SMS transport. Admins may target any user;
 * non-admins may only message themselves. A user with no registered number is a
 * silent no-op.
 */
export const messagingRoutes = new OpenAPIHono<AppBindings>().openapi(
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
        content: {
          "application/json": {
            schema: z.object({ ok: z.boolean(), sent: z.number(), failed: z.number() }),
          },
        },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    await enforceIpRateLimit(c, "sms-send", 30);
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = c.req.valid("json");
    const isAdmin = auth.roles.includes("admin");
    if (!isAdmin && body.userId !== auth.userId) {
      throw new AppError("FORBIDDEN", "Non-admins can only message themselves");
    }
    const result = await sendSmsToUsers(ctx, auth.tenantId ?? null, {
      userIds: [body.userId],
      body: body.body,
    });
    return c.json({ ok: true, sent: result.sent, failed: result.failed });
  },
);
