-- Per-model embeddings tables. `vector.pg.ts` has been writing to these via
-- `EMBEDDING_MODELS[model].pgTable` since the per-model split, and both
-- schema.ts files declare them — but the pg migration chain only ever created
-- the legacy single `embeddings` table, so every Postgres deploy 500'd on the
-- first vector upsert ("relation does not exist"). Caught by
-- migration-parity.test.ts. Mirrors sqlite's 20260617120000_embedding_vectors
-- and the pg schema.ts definitions exactly.
--
-- HNSW notes: pgvector caps HNSW at 2000 dims, so the 3072-dim table gets no
-- ANN index here (see schema.ts for the manual IVFFlat recipe).

CREATE TABLE IF NOT EXISTS "embeddings_openai_1536" (
  "id" text PRIMARY KEY,
  "namespace" text NOT NULL DEFAULT 'default',
  "ref_id" text,
  "content" text,
  "embedding" vector(1536) NOT NULL,
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_openai_1536_namespace_idx" ON "embeddings_openai_1536" ("namespace");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_openai_1536_ref_idx" ON "embeddings_openai_1536" ("ref_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_openai_1536_hnsw_idx" ON "embeddings_openai_1536" USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "embeddings_openai_3072" (
  "id" text PRIMARY KEY,
  "namespace" text NOT NULL DEFAULT 'default',
  "ref_id" text,
  "content" text,
  "embedding" vector(3072) NOT NULL,
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_openai_3072_namespace_idx" ON "embeddings_openai_3072" ("namespace");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_openai_3072_ref_idx" ON "embeddings_openai_3072" ("ref_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "embeddings_self_host_bge_m3" (
  "id" text PRIMARY KEY,
  "namespace" text NOT NULL DEFAULT 'default',
  "ref_id" text,
  "content" text,
  "embedding" vector(1024) NOT NULL,
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_self_host_bge_m3_namespace_idx" ON "embeddings_self_host_bge_m3" ("namespace");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_self_host_bge_m3_ref_idx" ON "embeddings_self_host_bge_m3" ("ref_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_self_host_bge_m3_hnsw_idx" ON "embeddings_self_host_bge_m3" USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "embeddings_bge_m3" (
  "id" text PRIMARY KEY,
  "namespace" text NOT NULL DEFAULT 'default',
  "ref_id" text,
  "content" text,
  "embedding" vector(1024) NOT NULL,
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_bge_m3_namespace_idx" ON "embeddings_bge_m3" ("namespace");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_bge_m3_ref_idx" ON "embeddings_bge_m3" ("ref_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_bge_m3_hnsw_idx" ON "embeddings_bge_m3" USING hnsw (embedding vector_cosine_ops);
