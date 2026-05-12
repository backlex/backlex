import { Hono } from "hono";
import { z } from "zod";
import { EMBEDDING_MODEL_NAMES, type EmbeddingModel } from "@workeros/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

// Build the model enum from the registry so adding a model in
// embedding-models.ts is the only change required to expose it via the API.
const ModelEnum = z.enum(EMBEDDING_MODEL_NAMES as [EmbeddingModel, ...EmbeddingModel[]]);

const UpsertInput = z.object({
  model: ModelEnum,
  records: z
    .array(
      z.object({
        id: z.string().min(1),
        values: z.array(z.number()),
        namespace: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    )
    .min(1),
});

const QueryInput = z.object({
  model: ModelEnum,
  values: z.array(z.number()).min(1),
  topK: z.number().int().min(1).max(100).optional(),
  namespace: z.string().optional(),
  filter: z.record(z.unknown()).optional(),
});

const DeleteInput = z.object({
  model: ModelEnum,
  ids: z.array(z.string()).min(1),
  namespace: z.string().optional(),
});

const EmbedUpsertInput = z.object({
  model: ModelEnum,
  records: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        namespace: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(100),
});

const SearchInput = z.object({
  model: ModelEnum,
  text: z.string().min(1),
  topK: z.number().int().min(1).max(100).optional(),
  namespace: z.string().optional(),
  filter: z.record(z.unknown()).optional(),
});

export const vectorRoutes = new Hono<AppBindings>()
  // Raw vector endpoints — caller supplies pre-computed `values`.
  .post("/upsert", requireUser, async (c) => {
    const { vector } = c.get("ctx");
    const body = UpsertInput.parse(await c.req.json());
    await vector.upsert(body.model, body.records);
    return c.json({ ok: true, count: body.records.length, model: body.model });
  })
  .post("/query", async (c) => {
    const { vector } = c.get("ctx");
    const body = QueryInput.parse(await c.req.json());
    const matches = await vector.query(body.model, {
      values: body.values,
      topK: body.topK,
      namespace: body.namespace,
      filter: body.filter,
    });
    return c.json({ data: matches, model: body.model });
  })
  .post("/delete", requireUser, async (c) => {
    const { vector } = c.get("ctx");
    const body = DeleteInput.parse(await c.req.json());
    await vector.delete(body.model, body.ids, body.namespace);
    return c.json({ ok: true, model: body.model });
  })
  // Convenience endpoints — server runs the embedding model for you.
  .post("/embed-upsert", requireUser, async (c) => {
    const { vector, embedding } = c.get("ctx");
    const body = EmbedUpsertInput.parse(await c.req.json());
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
  })
  .post("/search", async (c) => {
    const { vector, embedding } = c.get("ctx");
    const body = SearchInput.parse(await c.req.json());
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
  });
