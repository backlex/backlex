import type { ClientCore } from "../core";

/** What this deployment can actually do, so an application can ask first. */
export interface VectorCapabilities {
  /** The configured store, or `"none"` when there is not one. */
  store: string;
  defaultModel: string | null;
  models: { key: string; dimensions?: number; available?: boolean }[];
}

/** One neighbour, best first. */
export interface VectorMatch {
  id: string;
  score?: number;
  namespace?: string;
  metadata?: Record<string, unknown>;
  values?: number[];
}

/** A vector with its own id. */
export interface VectorRecord {
  id: string;
  values: number[];
  namespace?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Semantic search (`/api/vector`).
 *
 * Two ways in: hand over vectors you computed yourself (`upsert` / `query`),
 * or hand over text and let the workspace's embedding model do it
 * (`embedUpsert` / `search`). The second needs an embedding provider
 * configured; the first does not.
 *
 * `filter` narrows by metadata as flat key/value equality, AND-ed — the one
 * contract every supported store implements the same way.
 *
 * Namespaces are scoped to the calling workspace by the server, so two
 * workspaces naming a namespace the same thing never see each other's vectors.
 */
export interface VectorClient {
  /**
   * What this deployment supports.
   *
   * **Degrades rather than throws** where no store is configured — it answers
   * `store: "none"`. That is deliberate: an application that opens a search box
   * should be able to ask whether search exists without the question itself
   * being the thing that breaks the page.
   */
  capabilities(): Promise<VectorCapabilities>;
  /** Store vectors you computed. */
  upsert(input: { model: string; records: VectorRecord[] }): Promise<{ ok: boolean }>;
  /** Nearest neighbours to a vector you computed. */
  query(input: {
    model: string;
    values: number[];
    topK?: number;
    namespace?: string;
    filter?: Record<string, unknown>;
  }): Promise<{ data: VectorMatch[] }>;
  /** Remove vectors by id. */
  delete(input: { model: string; ids: string[]; namespace?: string }): Promise<{ ok: boolean }>;
  /** Embed text server-side and store it. */
  embedUpsert(input: {
    model: string;
    records: { id: string; text: string; namespace?: string; metadata?: Record<string, unknown> }[];
  }): Promise<{ ok: boolean }>;
  /** Embed a query server-side and search with it. */
  search(input: {
    model: string;
    text: string;
    topK?: number;
    namespace?: string;
    filter?: Record<string, unknown>;
  }): Promise<{ data: VectorMatch[] }>;
}

export const makeVector = (core: ClientCore): VectorClient => {
  const base = "/api/vector";
  return {
    capabilities: () =>
      core
        .request<{ data: VectorCapabilities }>("GET", `${base}/capabilities`)
        .then((r) => r.data)
        .catch((err: unknown): VectorCapabilities => {
          // Degrade only where the answer really is "this deployment does not
          // offer vector search": the route is absent, or the feature is not
          // implemented here. Everything else — a refused session above all —
          // is re-thrown, because reporting "no vector store" for an expired
          // login would send an application to fix the wrong thing.
          const status = (err as { status?: number } | null)?.status;
          if (status === 404 || status === 501 || status === 503) {
            return { store: "none", defaultModel: null, models: [] };
          }
          throw err;
        }),
    upsert: (input) => core.request<{ ok: boolean }>("POST", `${base}/upsert`, input),
    query: (input) => core.request<{ data: VectorMatch[] }>("POST", `${base}/query`, input),
    delete: (input) => core.request<{ ok: boolean }>("POST", `${base}/delete`, input),
    embedUpsert: (input) => core.request<{ ok: boolean }>("POST", `${base}/embed-upsert`, input),
    search: (input) => core.request<{ data: VectorMatch[] }>("POST", `${base}/search`, input),
  };
};
