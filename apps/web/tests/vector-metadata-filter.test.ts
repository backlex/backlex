/**
 * `VectorQuery.filter` must narrow the result on every store, or be refused.
 * Silently ignoring it is the one thing it may not do.
 *
 * Three of the five adapters honour it — Vectorize passes it through
 * (`vector.cf.ts`), Qdrant AND-s `match: { value }` per key, Pinecone maps each
 * key to `{ $eq: value }`. The two that did not were `vector.pg.ts` and
 * `vector.libsql.ts`: both destructured `{ values, topK, namespace }` and never
 * read `filter`, so a caller narrowing by metadata got the WHOLE namespace back
 * with no error. Those two are exactly the stores `docs/vector-search.md` calls
 * "works out of the box", and both `POST /api/vector/search` and the
 * `vector.search` MCP tool advertise the parameter.
 *
 * The contract pinned here is the one Qdrant and Pinecone already agree on and
 * the one every caller in this repo actually sends: **a flat map of metadata
 * key → exact value, all of which must match.** No operators, no nesting — a
 * filter language is a per-provider thing and inventing a fourth dialect here
 * would be worse than the omission.
 *
 * Both halves run against a real engine, not a mock: libSQL `:memory:` (so
 * `vector32()` / `vector_distance_cos()` execute) and pglite with the real
 * pgvector extension. The table DDL mirrors
 * `drizzle/pg/20260702130000_embeddings_per_model` and
 * `drizzle/sqlite/20260617120000_embedding_vectors`.
 */
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle as drizzlePg } from "drizzle-orm/pglite";
import type { VectorAdapter } from "@backlex/core/adapters";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import { libsqlVectorAdapter } from "../src/server/adapters/vector.libsql";
import { pgvectorAdapter } from "../src/server/adapters/vector.pg";

const DIM = 1024;
/** One-hot vectors give clean, orthogonal cosines so ranking never decides a
 *  test that is about filtering. */
const oneHot = (idx: number): number[] => {
  const v = new Array(DIM).fill(0);
  v[idx] = 1;
  return v;
};

/** Three rows in ONE namespace, differing only in metadata. Anything that
 *  ignores `filter` returns all three. */
const seed = async (adapter: VectorAdapter) => {
  await adapter.upsert("bge-m3", [
    { id: "a", values: oneHot(0), namespace: "ns", metadata: { collection: "posts", locale: "en" } },
    { id: "b", values: oneHot(1), namespace: "ns", metadata: { collection: "posts", locale: "tr" } },
    { id: "c", values: oneHot(2), namespace: "ns", metadata: { collection: "pages", locale: "en" } },
  ]);
};

/** The behaviour every store must share. Run once per adapter. */
const sharedContract = (label: string, get: () => VectorAdapter) => {
  describe(`${label} — metadata filter`, () => {
    const query = (filter?: Record<string, unknown>, namespace = "ns") =>
      get().query("bge-m3", { values: oneHot(0), topK: 10, namespace, filter });

    test("no filter returns the whole namespace", async () => {
      expect((await query()).map((h) => h.id).sort()).toEqual(["a", "b", "c"]);
    });

    test("one key narrows to the rows carrying that value", async () => {
      expect((await query({ collection: "posts" })).map((h) => h.id).sort()).toEqual(["a", "b"]);
    });

    test("two keys AND together", async () => {
      expect((await query({ collection: "posts", locale: "tr" })).map((h) => h.id)).toEqual(["b"]);
    });

    test("a value nothing carries returns nothing — never everything", async () => {
      // The failure mode this whole spec exists for: an ignored filter turns
      // "no such rows" into "all the rows", which reads as working.
      expect(await query({ collection: "nonexistent" })).toEqual([]);
    });

    test("an empty filter map is not a filter", async () => {
      expect((await query({})).map((h) => h.id).sort()).toEqual(["a", "b", "c"]);
    });

    test("the filter never widens past the namespace", async () => {
      // Namespace is the tenant boundary; a filter that matched across it
      // would be a cross-workspace read.
      expect(await query({ collection: "posts" }, "other-ns")).toEqual([]);
    });
  });
};

// ── libSQL / Turso (metadata is a JSON TEXT column) ──────────────────────────

let libsqlAdapter: VectorAdapter;

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  await client.execute(`CREATE TABLE embeddings_bge_m3 (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL DEFAULT 'default',
    ref_id TEXT,
    content TEXT,
    embedding F32_BLOB(${DIM}),
    metadata TEXT,
    created_at INTEGER NOT NULL
  )`);
  libsqlAdapter = libsqlVectorAdapter(drizzleLibsql({ client }) as unknown as SqliteDb);
  await seed(libsqlAdapter);
});

sharedContract("libsqlVectorAdapter", () => libsqlAdapter);

// ── Postgres / pgvector (metadata is jsonb) ──────────────────────────────────

let pg: PGlite;
let pgAdapter: VectorAdapter;

beforeAll(async () => {
  // `drizzle({ client })`, never positional — the beta-22 pglite driver
  // destructures its first argument, so `drizzle(pg)` silently runs against a
  // fresh empty database with no vector extension.
  pg = new PGlite({ extensions: { vector } });
  await pg.exec(`CREATE EXTENSION IF NOT EXISTS vector;`);
  await pg.exec(`CREATE TABLE embeddings_bge_m3 (
    id text PRIMARY KEY,
    namespace text NOT NULL DEFAULT 'default',
    ref_id text,
    content text,
    embedding vector(${DIM}) NOT NULL,
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );`);
  pgAdapter = pgvectorAdapter(drizzlePg({ client: pg }) as unknown as PgDb);
  await seed(pgAdapter);
});

afterAll(async () => {
  await pg?.close();
});

sharedContract("pgvectorAdapter", () => pgAdapter);
