import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const WebhookInput = z
  .object({
    name: z.string().min(1),
    url: z.string().url(),
    events: z.array(z.string().min(1)).min(1).openapi({
      description: "Event patterns this hook subscribes to (e.g. `items.posts.created`).",
    }),
    headers: z.record(z.string()).nullish().openapi({
      description: "Custom request headers sent on every delivery.",
    }),
    secret: z.string().optional().openapi({
      description: "Used to sign deliveries (`X-Workeros-Signature` HMAC-SHA256).",
    }),
    active: z.boolean().optional(),
  })
  .openapi("WebhookInput");

const WebhookRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    name: z.string(),
    url: z.string(),
    events: z.array(z.string()),
    headers: z.record(z.string()).nullable(),
    secret: z.string().nullable(),
    active: z.boolean(),
  })
  .openapi("WebhookRow");

const DeliveryRow = z
  .object({
    id: z.string(),
    webhookId: z.string(),
    event: z.string(),
    status: z.number().int().nullable(),
    error: z.string().nullable().optional(),
    payload: z.unknown().optional(),
    response: z.unknown().optional(),
    createdAt: z.unknown().optional(),
  })
  .openapi("WebhookDelivery");


apiRegistry.registerPath({
  method: "get",
  path: "/api/webhooks",
  tags: ["webhooks"],
  summary: "List webhooks",
  description: "Admin-only. Lists every webhook in the active workspace.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ data: z.array(WebhookRow) }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/webhooks",
  tags: ["webhooks"],
  summary: "Create webhook",
  description: "Admin-only.",
  security: SECURITY,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: WebhookInput } },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: {
        "application/json": { schema: z.object({ data: WebhookRow }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/webhooks/{id}",
  tags: ["webhooks"],
  summary: "Update webhook",
  description: "Admin-only. Partial update.",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: WebhookInput.partial() } },
    },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: OkSchema } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/webhooks/{id}",
  tags: ["webhooks"],
  summary: "Delete webhook",
  description: "Admin-only.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Deleted",
      content: { "application/json": { schema: OkSchema } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/webhooks/_deliveries",
  tags: ["webhooks"],
  summary: "List recent deliveries",
  description: "Admin-only. Optional `webhookId` filter; default limit 50.",
  security: SECURITY,
  request: {
    query: z.object({
      webhookId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ data: z.array(DeliveryRow) }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/webhooks/_deliveries/{id}/retry",
  tags: ["webhooks"],
  summary: "Retry delivery",
  description:
    "Admin-only. Replays a past delivery with the original headers + signature.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ data: DeliveryRow }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/webhooks/{id}/test",
  tags: ["webhooks"],
  summary: "Fire test delivery",
  description:
    "Admin-only. Sends a synthetic `webhook.test` event so the operator can confirm DNS/auth without waiting for a real event.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ data: DeliveryRow.nullable() }) },
      },
    },
    ...errorResponses,
  },
});
