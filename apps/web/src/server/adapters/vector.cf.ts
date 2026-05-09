import type { VectorAdapter } from "@workeros/core/adapters";

export const vectorizeAdapter = (index: VectorizeIndex): VectorAdapter => ({
  async upsert(records) {
    if (records.length === 0) return;
    await index.upsert(
      records.map((r) => ({
        id: r.id,
        values: r.values,
        namespace: r.namespace,
        metadata: r.metadata as Record<string, VectorizeVectorMetadata> | undefined,
      })),
    );
  },
  async query({ values, topK = 10, namespace, filter }) {
    const res = await index.query(values, {
      topK,
      namespace,
      filter: filter as VectorizeVectorMetadataFilter | undefined,
      returnMetadata: "all",
    });
    return res.matches.map((m) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata as Record<string, unknown> | undefined,
    }));
  },
  async delete(ids) {
    if (ids.length === 0) return;
    await index.deleteByIds(ids);
  },
});
