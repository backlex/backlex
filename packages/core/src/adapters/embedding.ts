import type { EmbeddingModel } from "../embedding-models";

export interface EmbedRequest {
  model: EmbeddingModel;
  texts: string[];
  /** Why we're embedding: "index" (storing a new vector) counts against a
   *  managed plan's stored-vector cap; "query" (search) does not. Adapters that
   *  don't meter ignore it. Defaults to "query" when unset. */
  intent?: "index" | "query";
}

export interface EmbedResult {
  /** One vector per input text, same order. Length === EMBEDDING_MODELS[model].dimensions. */
  values: number[][];
  /** Echoed back so callers can store it next to the vector if they like. */
  model: EmbeddingModel;
}

export interface EmbeddingAdapter {
  embed(req: EmbedRequest): Promise<EmbedResult>;
}
