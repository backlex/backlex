import type { ClientCore } from "../core";

/** Where a sink delivers.
 *
 *  - `webhook` — POST each batch to a URL, signed with Standard Webhooks when
 *    a secret is set.
 *  - `storage` — NDJSON objects in this workspace's own bucket, where the
 *    [S3 endpoint] can read them.
 */
export type CdcDestination = "webhook" | "storage";

export interface CdcSink {
  id: string;
  name: string;
  collection: string;
  destination: CdcDestination;
  /** The destination config WITHOUT its secret; `hasSecret` reports presence. */
  config: Record<string, unknown>;
  /** A flat filter naming the subset to replicate — the only narrowing knob,
   *  because a sink reads unconditionally. */
  shape: string | null;
  fields: string | null;
  batchSize: number;
  enabled: boolean;
  /** How far it has replicated. Opaque — it is the changefeed's own cursor,
   *  and it advances only after a batch is acknowledged. */
  cursor: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
}

export interface CdcSinkInput {
  name: string;
  collection: string;
  destination: CdcDestination;
  config: Record<string, unknown>;
  shape?: string | null;
  fields?: string | null;
  batchSize?: number;
  enabled?: boolean;
}

export interface CdcClient {
  list: () => Promise<{ data: CdcSink[] }>;
  create: (input: CdcSinkInput) => Promise<{ data: CdcSink }>;
  /** Omit `config.secret` to keep the stored one. `resetCursor` replays the
   *  collection from the beginning. */
  update: (
    id: string,
    patch: Partial<CdcSinkInput> & { resetCursor?: boolean },
  ) => Promise<{ data: CdcSink }>;
  /** Advance one page now, through the same code the cron tick runs. */
  run: (id: string) => Promise<{
    delivered: number;
    cursor: string | null;
    hasMore: boolean;
    error?: string;
  }>;
  delete: (id: string) => Promise<{ ok: boolean }>;
}

export const makeCdc = (core: ClientCore): CdcClient => {
  const base = "/api/admin/cdc-sinks";
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    list: () => core.request<{ data: CdcSink[] }>("GET", base),
    create: (input) => core.request<{ data: CdcSink }>("POST", base, input),
    update: (id, patch) => core.request<{ data: CdcSink }>("PATCH", one(id), patch),
    run: (id) =>
      core.request<{ delivered: number; cursor: string | null; hasMore: boolean; error?: string }>(
        "POST",
        `${one(id)}/run`,
        {},
      ),
    delete: (id) => core.request<{ ok: boolean }>("DELETE", one(id)),
  };
};
