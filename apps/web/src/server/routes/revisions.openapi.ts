import { z } from "../lib/openapi";
import {
  apiRegistry,
  SECURITY,
  OkSchema,
  errorResponses,
} from "../lib/openapi";

const RevisionRow = z
  .object({
    id: z.string(),
    collection: z.string(),
    itemId: z.string(),
    tenantId: z.string().nullable(),
    userId: z.string().nullable(),
    snapshot: z.record(z.string(), z.unknown()),
    createdAt: z.unknown(),
  })
  .openapi("RevisionRow");

const tags = ["revisions"];

apiRegistry.registerPath({
  method: "get",
  path: "/api/revisions/{collection}/{itemId}",
  tags,
  summary: "List revisions for an item",
  description: "Returns every recorded snapshot of `(collection, itemId)`. Requires `read` permission on the target collection.",
  security: SECURITY,
  request: {
    params: z.object({
      collection: z.string().openapi({ description: "Collection slug (e.g. `posts`)." }),
      itemId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: z.array(RevisionRow) }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/revisions/{id}/revert",
  tags,
  summary: "Revert an item to a recorded revision",
  description:
    "Rewrites the live row in `c_<slug>` from the snapshot and records a new revision documenting the revert. Requires `update` permission on the target collection.",
  security: SECURITY,
  request: {
    params: z.object({
      id: z.string().openapi({ description: "Revision row id (NOT the item id)." }),
    }),
  },
  responses: {
    200: { description: "Reverted", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

export const _RevisionRow = RevisionRow;
