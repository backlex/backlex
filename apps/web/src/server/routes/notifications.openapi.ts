import { z } from "../lib/openapi";
import {
  apiRegistry,
  SECURITY,
  OkSchema,
  errorResponses,
} from "../lib/openapi";

const NotificationInput = z
  .object({
    title: z.string().min(1),
    body: z.string().optional(),
    url: z.string().optional(),
    userId: z.string().nullable().optional().openapi({
      description: "Target user. Omit (or null) for a broadcast notification.",
    }),
  })
  .openapi("NotificationInput");

const NotificationRow = z
  .object({
    id: z.string(),
    userId: z.string().nullable(),
    title: z.string(),
    body: z.string().nullable(),
    url: z.string().nullable(),
    flowId: z.string().nullable(),
    readAt: z.unknown().nullable(),
    createdAt: z.unknown(),
  })
  .openapi("NotificationRow");

const tags = ["notifications"];

apiRegistry.registerPath({
  method: "get",
  path: "/api/notifications",
  tags,
  summary: "List notifications for the caller",
  description: "Returns rows targeted at the caller plus broadcasts. `?unread=1` filters to unread.",
  security: SECURITY,
  request: {
    query: z.object({
      unread: z.enum(["1"]).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: z.array(NotificationRow) }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/notifications/_unread-count",
  tags,
  summary: "Unread notification count",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: z.object({ count: z.number().int().nonnegative() }) }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/notifications",
  tags,
  summary: "Create a notification",
  description: "Admins may target any user. Non-admins may only notify themselves.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: NotificationInput } } } },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: z.object({ data: z.object({ id: z.string() }) }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/notifications/{id}/read",
  tags,
  summary: "Mark a notification read",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/notifications/_read-all",
  tags,
  summary: "Mark every notification read for the caller",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

export const _NotificationInput = NotificationInput;
export const _NotificationRow = NotificationRow;
