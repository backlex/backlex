import { describe, expect, test } from "bun:test";
import { vectorizeAdapter, type VectorizeIndexMap } from "../src/server/adapters/vector.cf";

// Minimal in-memory stand-in for a Cloudflare VectorizeIndex. A vector `id` is
// the index-wide key (namespace is only a filter) — exactly the model the
// composite-key fix has to defend against.
function fakeIndex() {
  const store = new Map<string, { id: string; namespace?: string; metadata?: unknown }>();
  return {
    store,
    upsert: async (recs: Array<{ id: string; namespace?: string; metadata?: unknown }>) => {
      for (const r of recs) store.set(r.id, r);
      return { count: recs.length };
    },
    query: async (_v: number[], opts: { namespace?: string; topK?: number }) => {
      const ns = opts?.namespace;
      const matches = [...store.values()]
        .filter((v) => !ns || v.namespace === ns)
        .map((v) => ({ id: v.id, score: 1, metadata: v.metadata }));
      return { matches: matches.slice(0, opts?.topK ?? 10) };
    },
    deleteByIds: async (ids: string[]) => {
      for (const id of ids) store.delete(id);
      return { count: ids.length };
    },
  };
}

const vec = () => new Array(1024).fill(0); // bge-m3 dimension

describe("vectorizeAdapter composite keys", () => {
  test("two collections sharing a record id don't clobber, and delete is scoped", async () => {
    const idx = fakeIndex();
    const adapter = vectorizeAdapter({ "bge-m3": idx as unknown } as VectorizeIndexMap);

    await adapter.upsert("bge-m3", [{ id: "1", values: vec(), namespace: "users" }]);
    await adapter.upsert("bge-m3", [{ id: "1", values: vec(), namespace: "products" }]);

    // Both stored under distinct composite keys — no clobber.
    expect([...idx.store.keys()].sort()).toEqual(["products:1", "users:1"]);

    // Query is namespace-scoped and returns the ORIGINAL id (prefix stripped).
    const matches = await adapter.query("bge-m3", { values: vec(), namespace: "users" });
    expect(matches.map((m) => m.id)).toEqual(["1"]);

    // Delete only removes the targeted collection's vector.
    await adapter.delete("bge-m3", ["1"], "users");
    expect([...idx.store.keys()]).toEqual(["products:1"]);
  });
});
