import { z } from "../lib/openapi";
import {
  apiRegistry,
  SECURITY,
  OkSchema,
  errorResponses,
} from "../lib/openapi";

const TestPublishInput = z
  .object({
    event: z.enum(["created", "updated", "deleted"]),
    data: z.record(z.string(), z.unknown()),
  })
  .openapi("RealtimeTestPublishInput");

const tags = ["realtime"];

apiRegistry.registerPath({
  method: "get",
  path: "/api/realtime/{channel}/subscribe",
  tags,
  summary: "Subscribe to a channel (SSE)",
  description:
    "Opens a long-lived **`text/event-stream`** response. Channels: `items:<slug>` (permission-filtered change feed), `collections` (admin-only schema events), `presence:<name>` (signed-in roster), or any free-form name (no auth/filter). Supports `Last-Event-ID` for replay.",
  security: SECURITY,
  request: {
    params: z.object({
      channel: z.string().openapi({
        description: "Channel name. Use the `items:`, `presence:` prefixes for the gated channels.",
      }),
    }),
  },
  responses: {
    200: {
      description: "SSE stream — each event carries a monotonic `id` for resume.",
      content: {
        "text/event-stream": {
          schema: z.string().openapi({
            description: "Server-Sent Events stream. The first frame is `event: ready`.",
          }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/realtime/{channel}/publish",
  tags,
  summary: "Publish to a free-form channel",
  description:
    "Free-form channels only — `items:*`, `collections`, and `presence:*` are managed by the API and reject client publish. Rate limited per `(channel, ip)`.",
  security: SECURITY,
  request: {
    params: z.object({ channel: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: z.unknown().openapi({ description: "Free-form payload — forwarded to every subscriber as-is." }) } },
    },
  },
  responses: {
    200: { description: "Published", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/realtime/{channel}/test-publish",
  tags,
  summary: "Admin-only synthetic event injector",
  description:
    "Fires a synthetic `ItemEventPayload` at an `items:*` channel to verify per-subscriber permission filtering. No webhook/flow side effects.",
  security: SECURITY,
  request: {
    params: z.object({ channel: z.string().openapi({ description: "Must start with `items:`." }) }),
    body: { required: true, content: { "application/json": { schema: TestPublishInput } } },
  },
  responses: {
    200: { description: "Injected", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

export const _TestPublishInput = TestPublishInput;
