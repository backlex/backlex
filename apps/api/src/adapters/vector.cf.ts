import type { VectorAdapter } from "@workeros/core/adapters";

export const vectorizeAdapter = (index: VectorizeIndex): VectorAdapter => ({
  async upsert(records) {
    if (records.length === 0) return;
    await index.upsert(
      records.map((r) => ({
        id: r.id,
        values: r.values,
        namespace: r.namespace,
        metadata: r.metadata,
      })),
    );
  },
  async query({ values, topK = 10, namespace, filter }) {
    const res = await index.query(values, { topK, namespace, filter, returnMetadata: "all" });
    return res.matches.map((m: any) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata,
    }));
  },
  async delete(ids) {
    if (ids.length === 0) return;
    await index.deleteByIds(ids);
  },
});
