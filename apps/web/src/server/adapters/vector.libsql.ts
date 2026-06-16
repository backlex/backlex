import { sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { VectorAdapter } from "@backlex/core/adapters";
import { getEmbeddingModel, type EmbeddingModel } from "@backlex/core";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { LibsqlDb } from "@backlex/db/sqlite/libsql";

/**
 * Native vector search on the libSQL / Turso transport.
 *
 * Unlike Bun SQLite and D1 — which have no vector primitives and route vectors
 * to Cloudflare Vectorize — the libSQL engine ships built-in vector functions.
 * Embeddings live in an `F32_BLOB(<dim>)` column on the same per-model metadata
 * table (one table per embedding model so dimensions never mix), written with
 * `vector32()` and scored with `vector_distance_cos()`.
 *
 * Search is **exact** (brute-force over the namespace), not approximate: it
 * scans every row whose `namespace` matches and orders by cosine distance. This
 * is correct for every dimension (including openai-3-large's 3072, which exceeds
 * Vectorize's 1536 cap) and respects the namespace filter precisely. The libSQL
 * ANN index (`libsql_vector_idx` + `vector_top_k`) is a future optimization —
 * it returns global top-k that then has to be over-fetched and re-filtered per
 * namespace, so it's deferred until the brute-force scan is a measured problem.
 */

/**
 * SQLite table name per model. These intentionally match the PG table names
 * (`getEmbeddingModel(model).pgTable`) one-for-one, but we keep an explicit map
 * so a future PG rename can't silently retarget the SQLite writes.
 */
const SQLITE_TABLE = {
  "bge-m3": "embeddings_bge_m3",
  "openai-3-small": "embeddings_openai_1536",
  "openai-3-large": "embeddings_openai_3072",
  "self-host-bge-m3": "embeddings_self_host_bge_m3",
} as const satisfies Record<EmbeddingModel, string>;

const tableFor = (model: EmbeddingModel): string => SQLITE_TABLE[model];

/**
 * Each table's primary key is `id` alone, so two collections (namespaces)
 * sharing a record id would clobber each other on upsert. Key rows by
 * `<namespace>:<id>` (mirrors the pgvector + Vectorize adapters); strip the
 * prefix back off on query. The original id is also kept in `ref_id`.
 */
const vectorKey = (namespace: string, id: string): string => `${namespace}:${id}`;
const stripKey = (namespace: string, key: string): string =>
  key.startsWith(`${namespace}:`) ? key.slice(namespace.length + 1) : key;

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

/** libSQL's `vector32()` takes the JSON-array text form, e.g. `[1,2,3]`. */
const vectorLit = (values: number[]): string => `[${values.join(",")}]`;

export const libsqlVectorAdapter = (sqliteDb: SqliteDb): VectorAdapter => {
  // The adapter is only constructed on the libSQL path (see context.ts), so the
  // async libSQL driver methods (run/all) are present — narrow once here.
  const db = sqliteDb as unknown as LibsqlDb;
  return {
    async upsert(model, records) {
      if (records.length === 0) return;
      const table = tableFor(model);
      for (const r of records) assertDim(model, r.values, "Vector");
      for (const r of records) {
        const namespace = r.namespace ?? "default";
        await db.run(sql`
          INSERT INTO ${sql.identifier(table)}
            (id, namespace, ref_id, content, embedding, metadata, created_at)
          VALUES (
            ${vectorKey(namespace, r.id)},
            ${namespace},
            ${(r.metadata?.refId as string) ?? r.id},
            ${(r.metadata?.content as string) ?? null},
            vector32(${vectorLit(r.values)}),
            ${r.metadata ? JSON.stringify(r.metadata) : null},
            ${Date.now()}
          )
          ON CONFLICT(id) DO UPDATE SET
            embedding = excluded.embedding,
            metadata = excluded.metadata
        `);
      }
    },
    async query(model, { values, topK = 10, namespace = "default" }) {
      assertDim(model, values, "Query vector");
      const table = tableFor(model);
      const lit = vectorLit(values);
      const rows = await db.all<{
        id: string;
        score: number;
        metadata: string | null;
      }>(sql`
        SELECT id,
               1 - vector_distance_cos(embedding, vector32(${lit})) AS score,
               metadata
        FROM ${sql.identifier(table)}
        WHERE namespace = ${namespace} AND embedding IS NOT NULL
        ORDER BY vector_distance_cos(embedding, vector32(${lit})) ASC
        LIMIT ${topK}
      `);
      return rows.map((r) => ({
        id: stripKey(namespace, r.id),
        score: Number(r.score),
        metadata: (r.metadata ? JSON.parse(r.metadata) : undefined) as
          | Record<string, unknown>
          | undefined,
      }));
    },
    async delete(model, ids, namespace = "default") {
      if (ids.length === 0) return;
      const table = tableFor(model);
      const keys = ids.map((id) => vectorKey(namespace, id));
      await db.run(sql`
        DELETE FROM ${sql.identifier(table)}
        WHERE namespace = ${namespace}
          AND id IN (${sql.join(
            keys.map((k) => sql`${k}`),
            sql`, `,
          )})
      `);
    },
  };
};
