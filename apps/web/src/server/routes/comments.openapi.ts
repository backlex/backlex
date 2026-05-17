import { z } from "../lib/openapi";
import {
  apiRegistry,
  SECURITY,
  OkSchema,
  errorResponses,
} from "../lib/openapi";

const CommentInput = z
  .object({
    collection: z.string().min(1),
    itemId: z.string().min(1),
    body: z.string().min(1).max(4000),
  })
  .openapi("CommentInput");

const CommentRow = z
  .object({
    id: z.string(),
    collection: z.string(),
    itemId: z.string(),
    userId: z.string().nullable(),
    body: z.string(),
    createdAt: z.unknown(),
  })
  .openapi("CommentRow");

const tags = ["comments"];

apiRegistry.registerPath({
  method: "get",
  path: "/api/comments",
  tags,
  summary: "List comments on an item",
  description: "Requires `collection` + `itemId` query params. Any signed-in user can read.",
  security: SECURITY,
  request: {
    query: z.object({
      collection: z.string(),
      itemId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ data: z.array(CommentRow) }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/comments",
  tags,
  summary: "Create a comment",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: CommentInput } } } },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: z.object({ data: CommentRow }) } },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/comments/{id}",
  tags,
  summary: "Delete a comment",
  description: "Only the author or an admin may delete.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

export const _CommentInput = CommentInput;
export const _CommentRow = CommentRow;
