import { sql } from "drizzle-orm";
import type { PgDb } from "@workeros/db/pg";
import { schema } from "@workeros/db/pg";
import type { VectorAdapter } from "@workeros/core/adapters";

export const pgvectorAdapter = (db: PgDb): VectorAdapter => ({
  async upsert(records) {
    if (records.length === 0) return;
    await db.transaction(async (tx) => {
      for (const r of records) {
        await tx.execute(sql`
          INSERT INTO embeddings (id, namespace, ref_id, content, embedding, metadata)
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
  async query({ values, topK = 10, namespace = "default" }) {
    const rows = await db.execute<{ id: string; score: number; metadata: unknown }>(sql`
      SELECT id,
             1 - (embedding <=> ${`[${values.join(",")}]`}::vector) AS score,
             metadata
      FROM embeddings
      WHERE namespace = ${namespace}
      ORDER BY embedding <=> ${`[${values.join(",")}]`}::vector
      LIMIT ${topK}
    `);
    return rows.map((r) => ({
      id: r.id,
      score: Number(r.score),
      metadata: (r.metadata ?? undefined) as Record<string, unknown> | undefined,
    }));
  },
  async delete(ids, namespace = "default") {
    if (ids.length === 0) return;
    await db.execute(sql`
      DELETE FROM embeddings
      WHERE namespace = ${namespace} AND id = ANY(${ids})
    `);
  },
});

// Avoid "unused" warning when consumers don't import schema.
export const _schemaRef = schema;
