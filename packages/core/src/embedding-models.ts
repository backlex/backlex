/**
 * Single source of truth for every embedding model the system supports.
 *
 * Adding a model means: pick a key, fill in this row, then the embedding
 * router (apps/web/src/server/adapters/embedding.router.ts), the Vectorize
 * binding map (apps/web/src/server/adapters/vector.cf.ts) and the pgvector
 * table map (apps/web/src/server/adapters/vector.pg.ts) all pick it up
 * from here.
 *
 * Vectors from different models live in different vector spaces — they
 * cannot be compared. Each model gets its own Vectorize index and its own
 * Postgres table; cross-model search is intentionally impossible.
 */
export interface EmbeddingModelDef {
  /** Provider that turns text into vectors. */
  provider: "workers-ai" | "openai";
  /** Identifier passed to the provider — `@cf/...` for Workers AI,
   *  `text-embedding-...` for OpenAI. */
  providerModel: string;
  /** Output vector length. The Vectorize index and the pgvector column
   *  must be created with this exact dimension. */
  dimensions: number;
  /** Cloudflare Vectorize binding name on `Env`. The Worker bundle must
   *  declare a `[[vectorize]]` block in wrangler.toml with this binding. */
  vectorizeBinding: string;
  /** pgvector table name (Postgres dialect). One table per model so the
   *  HNSW index stays type-correct. */
  pgTable: string;
  /** Human label, only for admin UIs. */
  label: string;
}

export const EMBEDDING_MODELS = {
  "bge-m3": {
    provider: "workers-ai",
    providerModel: "@cf/baai/bge-m3",
    dimensions: 1024,
    vectorizeBinding: "VECTORIZE_BGE_M3",
    pgTable: "embeddings_bge_m3",
    label: "BGE-M3 (Workers AI, multilingual, 1024)",
  },
  "openai-3-small": {
    provider: "openai",
    providerModel: "text-embedding-3-small",
    dimensions: 1536,
    vectorizeBinding: "VECTORIZE_OPENAI",
    pgTable: "embeddings_openai_1536",
    label: "OpenAI text-embedding-3-small (1536)",
  },
  "openai-3-large": {
    provider: "openai",
    providerModel: "text-embedding-3-large",
    dimensions: 3072,
    vectorizeBinding: "VECTORIZE_OPENAI_LARGE",
    pgTable: "embeddings_openai_3072",
    label: "OpenAI text-embedding-3-large (3072)",
  },
} as const satisfies Record<string, EmbeddingModelDef>;

export type EmbeddingModel = keyof typeof EMBEDDING_MODELS;

export const EMBEDDING_MODEL_NAMES = Object.keys(
  EMBEDDING_MODELS,
) as EmbeddingModel[];

export const isEmbeddingModel = (v: unknown): v is EmbeddingModel =>
  typeof v === "string" && v in EMBEDDING_MODELS;

export const getEmbeddingModel = (m: EmbeddingModel): EmbeddingModelDef =>
  EMBEDDING_MODELS[m];
