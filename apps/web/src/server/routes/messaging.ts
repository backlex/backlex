import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { PushDispatchInput, dispatchPush, dispatchSms } from "../services/messaging";
import { defaultHook } from "../lib/openapi-router";

const SendSmsInput = z
  .object({
    userId: z.string().min(1).openapi({ description: "Recipient user id." }),
    body: z.string().min(1).max(1600),
  })
  .openapi("SendSmsInput");

// Not a second copy. The route used to declare its own, narrower version of
// this — `title`/`body` unconditionally required — which ran BEFORE
// `dispatchPush` and so decided the contract, while the file's own comment
// said validation lived in the service "so the GraphQL mutations stay in
// lockstep". They did not: `templateKey` was accepted over GraphQL and refused
// over REST.
const SendPushInput = PushDispatchInput.openapi("SendPushInput");

const DispatchResult = z.object({
  ok: z.boolean(),
  sent: z.number(),
  failed: z.number(),
});

const TAGS = ["messaging"];

/**
 * Direct messaging dispatch (push + SMS). Unlike `/api/notifications` this does
 * NOT drop an in-app row — it only fans out to the target user's registered
 * devices / phone numbers via the workspace transports. The abuse guard,
 * validation, and admin-or-self target gate all live in `services/messaging`
 * so the GraphQL mutations stay in lockstep.
 */
export const messagingRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
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
      const result = await dispatchSms(c, c.get("ctx"), c.get("auth"), c.req.valid("json"));
      return c.json(result);
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
      const result = await dispatchPush(c, c.get("ctx"), c.get("auth"), c.req.valid("json"));
      return c.json(result);
    },
  );
