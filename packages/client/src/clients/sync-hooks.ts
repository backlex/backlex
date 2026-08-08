import type { ClientCore } from "../core";

/** A blocking hook: runs before a write and decides whether it happens. */
export interface SyncHook {
  id: string;
  name: string;
  url: string;
  events: string[];
  headers: Record<string, string> | null;
  timeoutMs: number;
  /** `deny` blocks the write when the hook cannot answer; `allow` lets it through. */
  onError: "allow" | "deny";
  canMutate: boolean;
  priority: number;
  enabled: boolean;
  /** Presence only — the signing secret has no read-back path. */
  hasSecret: boolean;
  consecutiveFailures: number;
  lastFailureAt: number | string | null;
  disabledReason: string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
}

export interface SyncHookInput {
  name: string;
  url: string;
  /** `<collection>.beforeCreate|beforeUpdate|beforeDelete`, `<collection>.*`, `*.<phase>`, `*`. */
  events: string[];
  /** Required — there is no safe default. `allow` drops the guarantee the hook
   *  provides; `deny` turns the hook's outage into your callers'. */
  onError: "allow" | "deny";
  secret?: string;
  headers?: Record<string, string> | null;
  timeoutMs?: number;
  canMutate?: boolean;
  priority?: number;
  enabled?: boolean;
}

export interface SyncHookTestResult {
  ok: boolean;
  ms: number;
  error?: string;
  verdict?: { allow: boolean; reason?: string; data?: Record<string, unknown> };
}

export interface SyncHooksClient {
  list: () => Promise<{ data: SyncHook[] }>;
  create: (input: SyncHookInput) => Promise<{ data: SyncHook }>;
  /** Omit `secret` to keep the stored one — it cannot be read back. */
  update: (id: string, patch: Partial<SyncHookInput>) => Promise<{ data: SyncHook }>;
  delete: (id: string) => Promise<{ ok: boolean }>;
  /** One synthetic call; says whether a hook rejects deliberately or is down. */
  test: (id: string) => Promise<SyncHookTestResult>;
}

export const makeSyncHooks = (core: ClientCore): SyncHooksClient => {
  // Sync hooks. Admin-scoped over `/api/admin/sync-hooks`. Signing secrets only
  // ever travel inbound: `list` reports presence, never the value.
  const hook = (id: string) => `/api/admin/sync-hooks/${encodeURIComponent(id)}`;
  const syncHooks: SyncHooksClient = {
    list: () => core.request<{ data: SyncHook[] }>("GET", "/api/admin/sync-hooks"),
    create: (input) => core.request<{ data: SyncHook }>("POST", "/api/admin/sync-hooks", input),
    update: (id, patch) => core.request<{ data: SyncHook }>("PATCH", hook(id), patch),
    delete: (id) => core.request<{ ok: boolean }>("DELETE", hook(id)),
    test: (id) => core.request<SyncHookTestResult>("POST", `${hook(id)}/test`, {}),
  };

  return syncHooks;
};
