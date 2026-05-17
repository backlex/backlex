import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, errorResponses } from "../lib/openapi";

const ActivityRow = z
  .object({
    id: z.string(),
    userId: z.string().nullable(),
    tenantId: z.string().nullable(),
    action: z.string(),
    collection: z.string().nullable(),
    itemId: z.string().nullable(),
    payload: z.unknown().nullable(),
    durationMs: z.number().int().nullable(),
    createdAt: z.unknown(),
  })
  .openapi("ActivityRow");

apiRegistry.registerPath({
  method: "get",
  path: "/api/activity",
  tags: ["activity"],
  summary: "List activity log entries",
  description:
    "Admins see every entry; non-admins see only their own. Filter by `collection` and/or `itemId`. Paginate with `limit` (max 200) and `offset`.",
  security: SECURITY,
  request: {
    query: z.object({
      collection: z.string().optional(),
      itemId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(ActivityRow),
            limit: z.number().int(),
            offset: z.number().int(),
          }),
        },
      },
    },
    ...errorResponses,
  },
});

export const _ActivityRow = ActivityRow;
