/**
 * Qdrant vector store (self-hosted or Qdrant Cloud), over its REST API.
 *
 * Like Vectorize, this is a PER-MODEL map: a Qdrant collection fixes its vector
 * size at creation, and embedding models have different dimensions (1536 vs
 * 3072 vs 1024), so one collection cannot hold two models' vectors. A model with
 * no configured collection throws rather than silently writing into the wrong
 * space — a cross-dimension upsert is rejected by Qdrant anyway, but a
 * same-dimension one would succeed and quietly poison search results.
 *
 * ## Why the point id is a hash, not the record id
 *
 * Qdrant has no native namespaces, and a point id is unique per COLLECTION. The
 * caller (`services/vectorize.ts`) tenant-scopes the namespace but passes the
 * bare record id, so in a shared multi-tenant collection two workspaces holding
 * a same-id row — trivial for an adopted table with integer keys — would
 * overwrite each other on upsert, and a delete-by-id would remove the other
 * workspace's vector.
 *
 * Qdrant also only accepts u64 or UUID point ids, so `"<namespace>:<id>"` is not
 * a legal id either. The point id is therefore a deterministic UUID derived from
 * `namespace + id`, with the real id carried in the payload and mapped back on
 * query. Same input always yields the same point, so upsert stays idempotent and
 * delete can recompute it.
 *
 * Namespaces are additionally kept as a payload field so queries can filter on
 * them; collection-per-namespace would multiply operator setup without adding
 * isolation the hashed id does not already give.
 */
import type { EmbeddingModel } from "@backlex/core";
import type {
  VectorAdapter,
  VectorMatch,
  VectorQuery,
  VectorRecord,
} from "@backlex/core";

export type QdrantCollectionMap = Partial<Record<EmbeddingModel, string>>;

export interface QdrantConfig {
  /** Base URL, e.g. `https://xyz.eu-central.aws.cloud.qdrant.io:6333`. */
  url: string;
  apiKey?: string;
  collections: QdrantCollectionMap;
  fetchImpl?: typeof fetch;
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/** Payload key holding the caller's real record id. */
const ID_FIELD = "_backlex_id";

/**
 * Deterministic UUID for `(namespace, id)`. Qdrant rejects arbitrary string
 * ids, so this both satisfies the id format and makes the pair globally unique
 * inside a shared collection. The NUL separator keeps `("a:b","c")` and
 * `("a","b:c")` distinct.
 */
const pointIdFor = async (namespace: string, id: string): Promise<string> => {
  const data = new TextEncoder().encode(`${namespace}\u0000${id}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const hex = Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  // Shape it as a v4 UUID so Qdrant's parser accepts it.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
};

export function qdrantVectorAdapter(config: QdrantConfig): VectorAdapter {
  const base = trimSlash(config.url);
  const doFetch = config.fetchImpl ?? fetch;

  const collectionFor = (model: EmbeddingModel): string => {
    const name = config.collections[model];
    if (!name) {
      throw new Error(
        `Qdrant has no collection configured for embedding model "${model}" — ` +
          `set QDRANT_COLLECTION_* for it (a collection's vector size is fixed, ` +
          `so each model needs its own).`,
      );
    }
    return name;
  };

  const call = async (path: string, init: RequestInit): Promise<any> => {
    const res = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { "api-key": config.apiKey } : {}),
        ...(init.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      // Surface Qdrant's own message — "wrong vector size" and "collection not
      // found" are the two an operator actually needs to see.
      const detail =
        (body as { status?: { error?: string } } | null)?.status?.error ??
        JSON.stringify(body)?.slice(0, 200) ??
        "";
      throw new Error(`Qdrant ${res.status}: ${detail}`);
    }
    return body;
  };

  return {
    async upsert(model, records) {
      if (records.length === 0) return;
      const collection = collectionFor(model);
      const points = await Promise.all(
        records.map(async (r: VectorRecord) => ({
          id: await pointIdFor(r.namespace ?? "", r.id),
          vector: r.values,
          payload: {
            ...(r.metadata ?? {}),
            // The real id lives here; the point id is a hash (see the header).
            [ID_FIELD]: r.id,
            // Kept as a payload field so `namespace` filtering is one index
            // lookup rather than a separate collection per namespace.
            ...(r.namespace ? { namespace: r.namespace } : {}),
          },
        })),
      );
      await call(`/collections/${encodeURIComponent(collection)}/points?wait=true`, {
        method: "PUT",
        body: JSON.stringify({ points }),
      });
    },

    async query(model, q: VectorQuery) {
      const collection = collectionFor(model);
      const must: unknown[] = [];
      if (q.namespace) must.push({ key: "namespace", match: { value: q.namespace } });
      for (const [key, value] of Object.entries(q.filter ?? {})) {
        must.push({ key, match: { value } });
      }
      const body = await call(`/collections/${encodeURIComponent(collection)}/points/search`, {
        method: "POST",
        body: JSON.stringify({
          vector: q.values,
          limit: q.topK ?? 10,
          with_payload: true,
          ...(must.length ? { filter: { must } } : {}),
        }),
      });
      const hits = (body?.result ?? []) as {
        id: string | number;
        score: number;
        payload?: Record<string, unknown>;
      }[];
      return hits.map((h): VectorMatch => {
        const payload = { ...(h.payload ?? {}) };
        // Hand back the caller's id, not our hashed point id. The bookkeeping
        // fields are stripped so metadata looks the way the caller stored it.
        const realId = typeof payload[ID_FIELD] === "string" ? (payload[ID_FIELD] as string) : String(h.id);
        delete payload[ID_FIELD];
        delete payload.namespace;
        return {
          id: realId,
          score: h.score,
          ...(Object.keys(payload).length ? { metadata: payload } : {}),
        };
      });
    },

    async delete(model, ids, namespace) {
      if (ids.length === 0) return;
      const collection = collectionFor(model);
      // Recompute the same hashed point ids. The namespace is load-bearing:
      // without it this would delete whichever workspace's point happened to
      // share the record id.
      const points = await Promise.all(ids.map((id) => pointIdFor(namespace ?? "", id)));
      await call(`/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
        method: "POST",
        body: JSON.stringify({ points }),
      });
    },
  };
}
