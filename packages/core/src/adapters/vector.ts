import type { EmbeddingModel } from "../embedding-models";

export interface VectorRecord {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
  namespace?: string;
}

export interface VectorQuery {
  values: number[];
  topK?: number;
  namespace?: string;
  filter?: Record<string, unknown>;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * Vectors from different embedding models live in disjoint vector spaces;
 * cross-model search returns nonsense. Every operation takes a `model` so
 * the adapter can route to the right index/table — and so callers can never
 * accidentally upsert a 1024-dim vector into a 1536-dim store.
 */
export interface VectorAdapter {
  upsert(model: EmbeddingModel, records: VectorRecord[]): Promise<void>;
  query(model: EmbeddingModel, q: VectorQuery): Promise<VectorMatch[]>;
  delete(
    model: EmbeddingModel,
    ids: string[],
    namespace?: string,
  ): Promise<void>;
}
