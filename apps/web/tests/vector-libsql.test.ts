import { beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { libsqlVectorAdapter } from "../src/server/adapters/vector.libsql";
import type { SqliteDb } from "@backlex/db/sqlite";

// Exercises the libSQL / Turso native-vector path end-to-end against a real
// in-memory libSQL engine (`:memory:`), so `vector32()` / `vector_distance_cos()`
// actually run — not a fake. Mirrors the one-table-per-model layout the adapter
// writes to. bge-m3 = 1024 dims.

const DIM = 1024;
/** One-hot 1024-vector with `1` at `idx` — gives clean, orthogonal cosines. */
const oneHot = (idx: number): number[] => {
  const v = new Array(DIM).fill(0);
  v[idx] = 1;
  return v;
};

const makeAdapter = async () => {
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
  const db = drizzle({ client }) as unknown as SqliteDb;
  return libsqlVectorAdapter(db);
};

describe("libsqlVectorAdapter (native Turso vectors)", () => {
  let adapter: Awaited<ReturnType<typeof makeAdapter>>;
  beforeEach(async () => {
    adapter = await makeAdapter();
  });

  test("query ranks by cosine similarity and respects topK", async () => {
    await adapter.upsert("bge-m3", [
      { id: "a", values: oneHot(0), namespace: "docs", metadata: { tag: "a" } },
      { id: "b", values: oneHot(1), namespace: "docs" },
      { id: "c", values: oneHot(2), namespace: "docs" },
    ]);

    const matches = await adapter.query("bge-m3", {
      values: oneHot(0),
      namespace: "docs",
      topK: 2,
    });

    expect(matches).toHaveLength(2);
    expect(matches[0]?.id).toBe("a"); // exact match, score ~1
    expect(matches[0]?.score).toBeCloseTo(1, 5);
    expect(matches[0]?.metadata).toEqual({ tag: "a" });
    // orthogonal vectors → cosine similarity 0
    expect(matches[1]?.score).toBeCloseTo(0, 5);
  });

  test("namespaces are isolated and ids are returned un-prefixed", async () => {
    // Same record id in two collections must not clobber.
    await adapter.upsert("bge-m3", [{ id: "1", values: oneHot(0), namespace: "users" }]);
    await adapter.upsert("bge-m3", [{ id: "1", values: oneHot(0), namespace: "products" }]);

    const users = await adapter.query("bge-m3", { values: oneHot(0), namespace: "users" });
    expect(users.map((m) => m.id)).toEqual(["1"]);

    // Delete only the users-scoped vector; products' copy survives.
    await adapter.delete("bge-m3", ["1"], "users");
    expect(await adapter.query("bge-m3", { values: oneHot(0), namespace: "users" })).toHaveLength(0);
    expect(
      await adapter.query("bge-m3", { values: oneHot(0), namespace: "products" }),
    ).toHaveLength(1);
  });

  test("upsert overwrites the embedding for an existing id", async () => {
    await adapter.upsert("bge-m3", [{ id: "x", values: oneHot(0), namespace: "docs" }]);
    // Re-embed the same id far away from the original query vector.
    await adapter.upsert("bge-m3", [{ id: "x", values: oneHot(5), namespace: "docs" }]);

    const near0 = await adapter.query("bge-m3", { values: oneHot(0), namespace: "docs" });
    expect(near0[0]?.score).toBeCloseTo(0, 5); // no longer matches oneHot(0)
    const near5 = await adapter.query("bge-m3", { values: oneHot(5), namespace: "docs" });
    expect(near5[0]?.score).toBeCloseTo(1, 5);
  });

  test("rejects vectors of the wrong dimension", async () => {
    await expect(
      adapter.upsert("bge-m3", [{ id: "bad", values: [1, 2, 3], namespace: "docs" }]),
    ).rejects.toThrow(/1024 dimensions/);
  });
});
