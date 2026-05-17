import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, errorResponses } from "../lib/openapi";

const GraphQLRequest = z
  .object({
    query: z.string().openapi({ description: "GraphQL query/mutation/subscription document." }),
    variables: z.record(z.string(), z.unknown()).optional(),
    operationName: z.string().optional(),
  })
  .openapi("GraphQLRequest");

const GraphQLResponse = z
  .object({
    data: z.unknown().optional(),
    errors: z
      .array(
        z.object({
          message: z.string(),
          path: z.array(z.union([z.string(), z.number()])).optional(),
          locations: z
            .array(z.object({ line: z.number(), column: z.number() }))
            .optional(),
          extensions: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("GraphQLResponse");

apiRegistry.registerPath({
  method: "post",
  path: "/api/graphql",
  tags: ["graphql"],
  summary: "GraphQL endpoint",
  description:
    "Single GraphQL Yoga endpoint. The schema is generated per workspace from the active collection metadata at request time. Requires an active tenant.",
  security: SECURITY,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: GraphQLRequest } },
    },
  },
  responses: {
    200: {
      description: "OK — note that GraphQL returns 200 even when `errors` is populated.",
      content: { "application/json": { schema: GraphQLResponse } },
    },
    ...errorResponses,
  },
});
