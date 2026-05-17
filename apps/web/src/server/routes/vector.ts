import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { EMBEDDING_MODEL_NAMES, type EmbeddingModel } from "@workeros/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";

// Build the model enum from the registry so adding a model in
// embedding-models.ts is the only change required to expose it via the API.
const ModelEnum = z
  .enum(EMBEDDING_MODEL_NAMES as [EmbeddingModel, ...EmbeddingModel[]])
  .openapi("EmbeddingModel");

const RawRecord = z
  .object({
    id: z.string().min(1),
    values: z.array(z.number()),
    namespace: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("VectorRecord");

const TextRecord = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    namespace: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("VectorTextRecord");

const UpsertInput = z
  .object({
    model: ModelEnum,
    records: z.array(RawRecord).min(1),
  })
  .openapi("VectorUpsertInput");

const QueryInput = z
  .object({
    model: ModelEnum,
    values: z.array(z.number()).min(1),
    topK: z.number().int().min(1).max(100).optional(),
    namespace: z.string().optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
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
  .object({
    model: ModelEnum,
    records: z.array(TextRecord).min(1).max(100),
  })
  .openapi("VectorEmbedUpsertInput");

const SearchInput = z
  .object({
    model: ModelEnum,
    text: z.string().min(1),
    topK: z.number().int().min(1).max(100).optional(),
    namespace: z.string().optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("VectorSearchInput");

const Match = z
  .object({
    id: z.string(),
    score: z.number().optional(),
    namespace: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    values: z.array(z.number()).optional(),
  })
  .openapi("VectorMatch");

const tags = ["vector"];

export const vectorRoutes = new OpenAPIHono<AppBindings>()
  // Raw vector endpoints — caller supplies pre-computed `values`.
  .openapi(
    createRoute({
      method: "post",
      path: "/upsert",
      tags,
      summary: "Upsert raw vectors",
      description: "Caller supplies pre-computed `values`.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: { required: true, content: { "application/json": { schema: UpsertInput } } },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean(),
                count: z.number().int().nonnegative(),
                model: ModelEnum,
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { vector } = c.get("ctx");
      const body = c.req.valid("json");
      await vector.upsert(body.model, body.records);
      return c.json({ ok: true, count: body.records.length, model: body.model });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/query",
      tags,
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
    }),
    async (c) => {
      const { vector } = c.get("ctx");
      const body = c.req.valid("json");
      const matches = await vector.query(body.model, {
        values: body.values,
        topK: body.topK,
        namespace: body.namespace,
        filter: body.filter,
      });
      return c.json({ data: matches, model: body.model });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/delete",
      tags,
      summary: "Delete vectors",
      description: "Removes records by id (optionally namespace-scoped).",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: { required: true, content: { "application/json": { schema: DeleteInput } } },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean(), model: ModelEnum }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { vector } = c.get("ctx");
      const body = c.req.valid("json");
      await vector.delete(body.model, body.ids, body.namespace);
      return c.json({ ok: true, model: body.model });
    },
  )
  // Convenience endpoints — server runs the embedding model for you.
  .openapi(
    createRoute({
      method: "post",
      path: "/embed-upsert",
      tags,
      summary: "Embed and upsert text",
      description:
        "Server runs the embedding model on each record's `text` before upserting. Source text + model name are attached to metadata.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: { required: true, content: { "application/json": { schema: EmbedUpsertInput } } },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean(),
                count: z.number().int().nonnegative(),
                model: ModelEnum,
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { vector, embedding } = c.get("ctx");
      const body = c.req.valid("json");
      const { values } = await embedding.embed({
        model: body.model,
        texts: body.records.map((r) => r.text),
      });
      const records = body.records.map((r, i) => ({
        id: r.id,
        values: values[i]!,
        namespace: r.namespace,
        // Auto-attach the source text + a model marker so downstream
        // consumers can audit which model produced this row.
        metadata: { ...(r.metadata ?? {}), content: r.text, model: body.model },
      }));
      await vector.upsert(body.model, records);
      return c.json({ ok: true, count: records.length, model: body.model });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/search",
      tags,
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
    }),
    async (c) => {
      const { vector, embedding } = c.get("ctx");
      const body = c.req.valid("json");
      const { values } = await embedding.embed({
        model: body.model,
        texts: [body.text],
      });
      const matches = await vector.query(body.model, {
        values: values[0]!,
        topK: body.topK,
        namespace: body.namespace,
        filter: body.filter,
      });
      return c.json({ data: matches, model: body.model });
    },
  );
