import { sql } from "drizzle-orm";
import type { PgDb } from "@workeros/db/pg";
import { schema } from "@workeros/db/pg";
import { AppError } from "@workeros/core";
import type { VectorAdapter } from "@workeros/core/adapters";
import { getEmbeddingModel, type EmbeddingModel } from "@workeros/core";

/**
 * One Postgres table per embedding model — table name comes from the model
 * registry (`EMBEDDING_MODELS[model].pgTable`). Storing different-dim vectors
 * in different tables keeps each HNSW index type-correct and lets pgvector's
 * `<=>` operator stay statically valid.
 */

const tableFor = (model: EmbeddingModel): string =>
  getEmbeddingModel(model).pgTable;

const assertDim = (
  model: EmbeddingModel,
  values: number[],
  what: "Vector" | "Query vector",
) => {
  const def = getEmbeddingModel(model);
  if (values.length !== def.dimensions) {
    throw new AppError(
      "VALIDATION",
      `${what} for model '${model}' must have ${def.dimensions} dimensions, got ${values.length}`,
    );
  }
};

export const pgvectorAdapter = (db: PgDb): VectorAdapter => ({
  async upsert(model, records) {
    if (records.length === 0) return;
    const table = tableFor(model);
    for (const r of records) assertDim(model, r.values, "Vector");
    await db.transaction(async (tx) => {
      for (const r of records) {
        await tx.execute(sql`
          INSERT INTO ${sql.identifier(table)} (id, namespace, ref_id, content, embedding, metadata)
          VALUES (
            ${r.id},
            ${r.namespace ?? "default"},
            ${(r.metadata?.refId as string) ?? null},
            ${(r.metadata?.content as string) ?? null},
            ${`[${r.values.join(",")}]`}::vector,
            ${r.metadata ? JSON.stringify(r.metadata) : null}::jsonb
          )
          ON CONFLICT (id) DO UPDATE SET
            embedding = EXCLUDED.embedding,
            metadata = EXCLUDED.metadata
        `);
      }
    });
  },
  async query(model, { values, topK = 10, namespace = "default" }) {
    assertDim(model, values, "Query vector");
    const table = tableFor(model);
    const lit = `[${values.join(",")}]`;
    const result = await db.execute<{
      id: string;
      score: number;
      metadata: unknown;
    }>(sql`
      SELECT id,
             1 - (embedding <=> ${lit}::vector) AS score,
             metadata
      FROM ${sql.identifier(table)}
      WHERE namespace = ${namespace}
      ORDER BY embedding <=> ${lit}::vector
      LIMIT ${topK}
    `);
    // postgres-js returns the row array directly; neon-http wraps it in
    // `{ rows: [...] }`. Normalize so the rest of the code is driver-agnostic.
    const rows: Array<{ id: string; score: number; metadata: unknown }> =
      Array.isArray(result)
        ? (result as Array<{ id: string; score: number; metadata: unknown }>)
        : ((result as { rows: Array<{ id: string; score: number; metadata: unknown }> }).rows ?? []);
    return rows.map((r) => ({
      id: r.id,
      score: Number(r.score),
      metadata: (r.metadata ?? undefined) as
        | Record<string, unknown>
        | undefined,
    }));
  },
  async delete(model, ids, namespace = "default") {
    if (ids.length === 0) return;
    const table = tableFor(model);
    await db.execute(sql`
      DELETE FROM ${sql.identifier(table)}
      WHERE namespace = ${namespace} AND id = ANY(${ids})
    `);
  },
});

// Avoid "unused" warning when consumers don't import schema.
export const _schemaRef = schema;
