import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AppError,
  EMBEDDING_MODELS,
  EMBEDDING_MODEL_NAMES,
  type EmbeddingModel,
  VECTOR_STORES,
} from "@backlex/core";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { reportToCloud } from "../lib/cloud-report";
import { defaultHook } from "../lib/openapi-router";
import { vectorNamespace } from "../services/vectorize";

/**
 * Tenant-scope the caller-supplied namespace. In a single-worker multi-tenant
 * deployment every tenant shares one Vectorize index (one per model), keyed
 * `<namespace>:<id>` — so without this prefix two tenants naming the same
 * namespace would read/delete each other's vectors. Pinning the namespace to
 * the active workspace makes that impossible. (Cloud runs one worker+index per
 * tenant, so the prefix is a harmless no-op there.) A caller that supplies no
 * namespace still gets isolated under the bare tenant id.
 *
 * NOTE: existing self-host multi-tenant data embedded before this change lives
 * under the un-prefixed namespace and must be re-indexed (collection
 * `POST /:slug/vectorize`, or re-upsert for raw vectors) to be queryable again.
 *
 * The `<tenant>:<name>` join itself comes from `vectorNamespace` so this route
 * and the collection write/search paths cannot drift apart — they already had,
 * and the search path was the one that was wrong. What stays local is the two
 * things the write path has no use for: requiring an active tenant, and
 * falling back to the bare tenant id when the caller names no namespace.
 */
const scopeNs = (c: Context<AppBindings>, ns: string | undefined): string => {
  const tenantId = c.get("auth")?.tenantId ?? null;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return ns ? vectorNamespace(ns, tenantId) : tenantId;
};

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

const CapabilityModel = z
  .object({
    key: ModelEnum,
    label: z.string(),
    provider: z.enum(["workers-ai", "openai", "self-host"]),
    dimensions: z.number().int().positive(),
    /** Usable right now: provider configured + store can hold its vectors. */
    ready: z.boolean(),
  })
  .openapi("VectorCapabilityModel");

const Capabilities = z
  .object({
    store: z.enum(VECTOR_STORES),
    defaultModel: ModelEnum.nullable(),
    models: z.array(CapabilityModel),
  })
  .openapi("VectorCapabilities");

export const vectorRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  /**
   * What vector search can do on this deployment — which embedding models
   * are usable (provider configured + store ready) and which store holds
   * the vectors. The admin collection-settings model picker reads this so
   * it never offers a model that would fail at first embed.
   */
  .openapi(
    createRoute({
      method: "get",
      path: "/capabilities",
      tags,
      summary: "Vector search readiness",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: Capabilities }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const caps = c.get("ctx").vectorCaps;
      return c.json({
        data: {
          store: caps.store,
          defaultModel: caps.defaultModel,
          models: EMBEDDING_MODEL_NAMES.map((key) => ({
            key,
            label: EMBEDDING_MODELS[key].label,
            provider: EMBEDDING_MODELS[key].provider,
            dimensions: EMBEDDING_MODELS[key].dimensions,
            ready: caps.models[key],
          })),
        },
      });
    },
  )
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
      const records = body.records.map((r) => ({
        ...r,
        namespace: scopeNs(c, r.namespace),
      }));
      await vector.upsert(body.model, records);
      return c.json({ ok: true, count: records.length, model: body.model });
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
      middleware: [requireUser],
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
      const { vector, env } = c.get("ctx");
      const body = c.req.valid("json");
      const matches = await vector.query(body.model, {
        values: body.values,
        topK: body.topK,
        namespace: scopeNs(c, body.namespace),
        filter: body.filter,
      });
      // Self-report the Vectorize query for cloud cost visibility (CF has no
      // query analytics). waitUntil so it survives the response return.
      const report = reportToCloud(env, { kind: "vector_query", queries: 1 });
      if (report) c.executionCtx?.waitUntil?.(report);
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
      await vector.delete(body.model, body.ids, scopeNs(c, body.namespace));
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
        intent: "index",
      });
      const records = body.records.map((r, i) => ({
        id: r.id,
        values: values[i]!,
        namespace: scopeNs(c, r.namespace),
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
      middleware: [requireUser],
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
      const { vector, embedding, env } = c.get("ctx");
      const body = c.req.valid("json");
      const { values } = await embedding.embed({
        model: body.model,
        texts: [body.text],
        intent: "query",
      });
      const matches = await vector.query(body.model, {
        values: values[0]!,
        topK: body.topK,
        namespace: scopeNs(c, body.namespace),
        filter: body.filter,
      });
      // Self-report the Vectorize query for cloud cost visibility (CF has no
      // query analytics). waitUntil so it survives the response return.
      const report = reportToCloud(env, { kind: "vector_query", queries: 1 });
      if (report) c.executionCtx?.waitUntil?.(report);
      return c.json({ data: matches, model: body.model });
    },
  );
