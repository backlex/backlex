/**
 * Pinecone vector store, over its data-plane REST API.
 *
 * Per-model like Vectorize and Qdrant, for the same reason: a Pinecone index
 * fixes its dimension at creation, so one index cannot hold two embedding
 * models' vectors. Config is a model → index HOST map, not index names —
 * Pinecone's data plane is addressed by the per-index host
 * (`https://<index>-<project>.svc.<region>.pinecone.io`) that its console and
 * `describe_index` return. Taking the host avoids a control-plane lookup on
 * every cold start.
 *
 * `namespace` maps onto Pinecone's native namespace, which is the one place
 * this differs from the Qdrant adapter: Pinecone namespaces are free and
 * first-class, so there is no reason to emulate them in metadata.
 */
import type { EmbeddingModel } from "@backlex/core";
import type {
  VectorAdapter,
  VectorMatch,
  VectorQuery,
  VectorRecord,
} from "@backlex/core";

export type PineconeHostMap = Partial<Record<EmbeddingModel, string>>;

export interface PineconeConfig {
  apiKey: string;
  /** model → index host. */
  hosts: PineconeHostMap;
  fetchImpl?: typeof fetch;
}

/** Accept a bare host or a full URL; always return an https origin. */
const asOrigin = (host: string): string => {
  const s = host.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
};

export function pineconeVectorAdapter(config: PineconeConfig): VectorAdapter {
  const doFetch = config.fetchImpl ?? fetch;

  const hostFor = (model: EmbeddingModel): string => {
    const host = config.hosts[model];
    if (!host) {
      throw new Error(
        `Pinecone has no index configured for embedding model "${model}" — ` +
          `set PINECONE_INDEX_* to that model's index host (an index's dimension ` +
          `is fixed, so each model needs its own).`,
      );
    }
    return asOrigin(host);
  };

  const call = async (host: string, path: string, body: unknown): Promise<any> => {
    const res = await doFetch(`${host}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Api-Key": config.apiKey,
        // Pinecone requires a data-plane API version header; omitting it makes
        // the request fail with an unhelpful 400.
        "X-Pinecone-API-Version": "2024-10",
      },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    if (!res.ok) {
      const detail =
        (parsed as { message?: string } | null)?.message ??
        JSON.stringify(parsed)?.slice(0, 200) ??
        "";
      throw new Error(`Pinecone ${res.status}: ${detail}`);
    }
    return parsed;
  };

  return {
    async upsert(model, records) {
      if (records.length === 0) return;
      const host = hostFor(model);
      // Pinecone namespaces live on the REQUEST, not the record, so a batch
      // spanning namespaces has to be split — mixing them would file every
      // vector under whichever namespace won.
      const byNamespace = new Map<string, VectorRecord[]>();
      for (const r of records) {
        const key = r.namespace ?? "";
        const list = byNamespace.get(key);
        if (list) list.push(r);
        else byNamespace.set(key, [r]);
      }
      for (const [namespace, batch] of byNamespace) {
        await call(host, "/vectors/upsert", {
          ...(namespace ? { namespace } : {}),
          vectors: batch.map((r) => ({
            id: r.id,
            values: r.values,
            ...(r.metadata ? { metadata: r.metadata } : {}),
          })),
        });
      }
    },

    async query(model, q: VectorQuery) {
      const host = hostFor(model);
      const parsed = await call(host, "/query", {
        vector: q.values,
        topK: q.topK ?? 10,
        includeMetadata: true,
        ...(q.namespace ? { namespace: q.namespace } : {}),
        // Pinecone's filter language uses `$eq` for equality; a bare value is
        // rejected.
        ...(q.filter && Object.keys(q.filter).length
          ? {
              filter: Object.fromEntries(
                Object.entries(q.filter).map(([k, v]) => [k, { $eq: v }]),
              ),
            }
          : {}),
      });
      const matches = (parsed?.matches ?? []) as {
        id: string;
        score: number;
        metadata?: Record<string, unknown>;
      }[];
      return matches.map(
        (m): VectorMatch => ({
          id: m.id,
          score: m.score,
          ...(m.metadata ? { metadata: m.metadata } : {}),
        }),
      );
    },

    async delete(model, ids, namespace) {
      if (ids.length === 0) return;
      await call(hostFor(model), "/vectors/delete", {
        ids,
        ...(namespace ? { namespace } : {}),
      });
    },
  };
}
