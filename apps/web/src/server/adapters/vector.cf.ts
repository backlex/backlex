import { AppError } from "@backlex/core";
import type { VectorAdapter } from "@backlex/core/adapters";
import {
  EMBEDDING_MODELS,
  getEmbeddingModel,
  type EmbeddingModel,
} from "@backlex/core";
import type { Env } from "../env";
import { reportToCloud } from "../lib/cloud-report";

/**
 * One Vectorize index per embedding model. The map keys are model names
 * (`bge-m3`, `openai-3-small`); values are the bound `VectorizeIndex` from
 * Cloudflare. Models without a bound index error on use — never silently
 * fall through to a wrong-dimension store.
 */
export type VectorizeIndexMap = Partial<Record<EmbeddingModel, VectorizeIndex>>;

/**
 * A Vectorize vector `id` is unique across the WHOLE index — `namespace` is only
 * a query filter, not part of the key. With one index per project (namespace =
 * collection slug), two collections sharing a record id (e.g. adopted tables
 * with integer PKs) would otherwise clobber each other on upsert and cross-
 * delete. Key vectors by `<namespace>:<id>` so each collection's ids are
 * distinct within the index; strip the prefix back off on query.
 */
const vectorKey = (namespace: string | undefined, id: string): string =>
  namespace ? `${namespace}:${id}` : id;

const stripKey = (namespace: string | undefined, key: string): string =>
  namespace && key.startsWith(`${namespace}:`) ? key.slice(namespace.length + 1) : key;

const indexFor = (
  bindings: VectorizeIndexMap,
  model: EmbeddingModel,
): VectorizeIndex => {
  const idx = bindings[model];
  if (!idx) {
    const def = getEmbeddingModel(model);
    throw new AppError(
      "INTERNAL",
      `Vectorize index for model '${model}' is not bound. ` +
        `Add a [[vectorize]] block with binding="${def.vectorizeBinding}" ` +
        `(dimensions=${def.dimensions}) in wrangler.toml.`,
    );
  }
  return idx;
};

export const vectorizeAdapter = (
  bindings: VectorizeIndexMap,
  env?: Env,
): VectorAdapter => ({
  async upsert(model, records) {
    if (records.length === 0) return;
    const def = getEmbeddingModel(model);
    for (const r of records) {
      if (r.values.length !== def.dimensions) {
        throw new AppError(
          "VALIDATION",
          `Vector for model '${model}' must have ${def.dimensions} dimensions, got ${r.values.length}`,
        );
      }
    }
    const index = indexFor(bindings, model);
    await index.upsert(
      records.map((r) => ({
        id: vectorKey(r.namespace, r.id),
        values: r.values,
        namespace: r.namespace,
        metadata: r.metadata as
          | Record<string, VectorizeVectorMetadata>
          | undefined,
      })),
    );
  },
  async query(model, { values, topK = 10, namespace, filter }) {
    const def = getEmbeddingModel(model);
    if (values.length !== def.dimensions) {
      throw new AppError(
        "VALIDATION",
        `Query vector for model '${model}' must have ${def.dimensions} dimensions, got ${values.length}`,
      );
    }
    const index = indexFor(bindings, model);
    const res = await index.query(values, {
      topK,
      namespace,
      filter: filter as VectorizeVectorMetadataFilter | undefined,
      returnMetadata: "all",
    });
    // CF exposes no Vectorize query analytics, so self-report the query for
    // cloud cost visibility (no-op unless this is a managed cloud project).
    void reportToCloud(env, { kind: "vector_query", queries: 1 });
    return res.matches.map((m) => ({
      id: stripKey(namespace, m.id),
      score: m.score,
      metadata: m.metadata as Record<string, unknown> | undefined,
    }));
  },
  async delete(model, ids, namespace) {
    if (ids.length === 0) return;
    const index = indexFor(bindings, model);
    await index.deleteByIds(ids.map((id) => vectorKey(namespace, id)));
  },
});

/** Convenience used by docs/tests. Lists every model the registry knows. */
export const allModelNames = (): EmbeddingModel[] =>
  Object.keys(EMBEDDING_MODELS) as EmbeddingModel[];
