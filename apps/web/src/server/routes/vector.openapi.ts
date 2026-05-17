import { z } from "../lib/openapi";
import { EMBEDDING_MODEL_NAMES, type EmbeddingModel } from "@workeros/core";
import { apiRegistry, SECURITY, errorResponses } from "../lib/openapi";

const ModelEnum = z
  .enum(EMBEDDING_MODEL_NAMES as [EmbeddingModel, ...EmbeddingModel[]])
  .openapi("EmbeddingModel");

const RawRecord = z
  .object({
    id: z.string().min(1),
    values: z.array(z.number()),
    namespace: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .openapi("VectorRecord");

const TextRecord = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    namespace: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .openapi("VectorTextRecord");

const UpsertInput = z
  .object({ model: ModelEnum, records: z.array(RawRecord).min(1) })
  .openapi("VectorUpsertInput");

const QueryInput = z
  .object({
    model: ModelEnum,
    values: z.array(z.number()).min(1),
    topK: z.number().int().min(1).max(100).optional(),
    namespace: z.string().optional(),
    filter: z.record(z.unknown()).optional(),
  })
  .openapi("VectorQueryInput");

const DeleteInput = z
  .object({
    model: ModelEnum,
    ids: z.array(z.string()).min(1),
    namespace: z.string().optional(),
  })
  .openapi("VectorDeleteInput");

const EmbedUpsertInput = z
  .object({ model: ModelEnum, records: z.array(TextRecord).min(1).max(100) })
  .openapi("VectorEmbedUpsertInput");

const SearchInput = z
  .object({
    model: ModelEnum,
    text: z.string().min(1),
    topK: z.number().int().min(1).max(100).optional(),
    namespace: z.string().optional(),
    filter: z.record(z.unknown()).optional(),
  })
  .openapi("VectorSearchInput");

const Match = z
  .object({
    id: z.string(),
    score: z.number().optional(),
    namespace: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    values: z.array(z.number()).optional(),
  })
  .openapi("VectorMatch");


apiRegistry.registerPath({
  method: "post",
  path: "/api/vector/upsert",
  tags: ["vector"],
  summary: "Upsert raw vectors",
  description: "Caller supplies pre-computed `values`.",
  security: SECURITY,
  request: {
    body: { required: true, content: { "application/json": { schema: UpsertInput } } },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            count: z.number().int().nonnegative(),
            model: ModelEnum,
          }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/vector/query",
  tags: ["vector"],
  summary: "Query by vector",
  description: "ANN search against pre-computed query vector.",
  security: SECURITY,
  request: {
    body: { required: true, content: { "application/json": { schema: QueryInput } } },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ data: z.array(Match), model: ModelEnum }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/vector/delete",
  tags: ["vector"],
  summary: "Delete vectors",
  description: "Removes records by id (optionally namespace-scoped).",
  security: SECURITY,
  request: {
    body: { required: true, content: { "application/json": { schema: DeleteInput } } },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), model: ModelEnum }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/vector/embed-upsert",
  tags: ["vector"],
  summary: "Embed and upsert text",
  description:
    "Server runs the embedding model on each record's `text` before upserting. Source text + model name are attached to metadata.",
  security: SECURITY,
  request: {
    body: { required: true, content: { "application/json": { schema: EmbedUpsertInput } } },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            count: z.number().int().nonnegative(),
            model: ModelEnum,
          }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/vector/search",
  tags: ["vector"],
  summary: "Embed and search",
  description: "Server embeds the query text, then runs ANN search.",
  security: SECURITY,
  request: {
    body: { required: true, content: { "application/json": { schema: SearchInput } } },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ data: z.array(Match), model: ModelEnum }),
        },
      },
    },
    ...errorResponses,
  },
});
