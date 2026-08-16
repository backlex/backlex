import { api } from "@/lib/api";
import type { Envelope } from "./types";

export interface ApiFunction {
  id: string;
  tenantId: string | null;
  name: string;
  trigger: "http" | "event" | "cron";
  pattern: string | null;
  active: boolean;
  timeoutMs: number;
}

export interface ApiFlag {
  id: string;
  tenantId: string | null;
  key: string;
  enabled: boolean;
  value: unknown;
  rules: { condition?: unknown; rollout?: number } | null;
  description: string | null;
  createdAt: string | number;
  updatedAt: string | number;
}

export const flagsApi = {
  list: () => api<Envelope<ApiFlag[]>>("/api/admin/feature-flags"),
  upsert: (
    key: string,
    body: { enabled?: boolean; value?: unknown; rules?: { condition?: unknown; rollout?: number } | null; description?: string | null },
    scope: "tenant" | "global" = "tenant",
  ) =>
    api<Envelope<ApiFlag>>(
      `/api/admin/feature-flags/${encodeURIComponent(key)}${scope === "global" ? "?scope=global" : ""}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  remove: (key: string, scope: "tenant" | "global" = "tenant") =>
    api<{ ok: true }>(
      `/api/admin/feature-flags/${encodeURIComponent(key)}${scope === "global" ? "?scope=global" : ""}`,
      { method: "DELETE" },
    ),
};

export const functionsApi = {
  list: () => api<Envelope<ApiFunction[]>>(`/api/functions`),
};

// ── Integrations (connected third-party providers) ──────────────────────────
export interface ApiIntegration {
  id: string;
  kind: string;
  status: string;
  events: string[] | null;
  lastEventAt?: number | string | null;
  consecutiveFailures?: number;
  disabledReason?: string | null;
}

export const integrationsApi = {
  list: () => api<Envelope<ApiIntegration[]>>(`/api/admin/integrations`),
};

// ── Extensions (installable admin add-ons, #13) ─────────────────────────────
export interface ApiExtensionPanel {
  id: string;
  title: string;
  icon?: string;
  entry: string;
}

export interface ApiExtensionFieldEditor {
  /** Interface id persisted as `field.interface` when an admin picks it. */
  interface: string;
  title: string;
  /** Storage types this editor accepts; absent = any type. */
  types?: string[];
  entry: string;
}

/** Where a widget renders. Mirrors `WIDGET_MOUNTS` in services/extensions.ts. */
export type ApiExtensionWidgetMount = "item-detail" | "item-list" | "home";

export interface ApiExtensionWidget {
  id: string;
  title: string;
  icon?: string;
  mount: ApiExtensionWidgetMount;
  /** Collections it appears on; absent/empty = all. Ignored for `home`. */
  collections?: string[];
  entry: string;
}

export interface ApiExtensionHook {
  id: string;
  trigger: "event" | "manual";
  pattern?: string;
  entry: string;
  timeoutMs?: number;
}

export interface ApiExtensionManifest {
  name: string;
  version: string;
  title: string;
  description?: string;
  contributes: {
    panels?: ApiExtensionPanel[];
    fieldEditors?: ApiExtensionFieldEditor[];
    widgets?: ApiExtensionWidget[];
    hooks?: ApiExtensionHook[];
  };
  /** API allow-list for the iframe bridge, e.g. `"GET /api/items/posts"`,
   *  `"* /api/items/*"`. Enforced client- AND server-side. */
  permissions?: { api?: string[] };
}

export interface ApiExtension {
  id: string;
  name: string;
  version: string;
  source: "npm" | "upload";
  npmPackage: string | null;
  enabled: boolean;
  manifest: ApiExtensionManifest;
}

/** SandboxResult shape returned by the manual hook-invoke endpoint. */
export interface ApiExtensionHookResult {
  ok: boolean;
  logs: string[];
  error?: string;
  durationMs: number;
  value?: unknown;
}

export const extensionsApi = {
  list: () => api<Envelope<ApiExtension[]>>(`/api/extensions`),
  /** Enabled extensions only — readable by any signed-in user (drives the
   *  sidebar panels + field-editor injection, not just the admin page). */
  enabled: () => api<Envelope<ApiExtension[]>>(`/api/extensions/enabled`),
  install: (pkg: string, version?: string) =>
    api<Envelope<ApiExtension>>(`/api/extensions/install`, {
      method: "POST",
      body: JSON.stringify({ package: pkg, ...(version ? { version } : {}) }),
    }),
  upload: (files: Record<string, string>) =>
    api<Envelope<ApiExtension>>(`/api/extensions/upload`, {
      method: "POST",
      body: JSON.stringify({ files }),
    }),
  setEnabled: (name: string, enabled: boolean) =>
    api<Envelope<ApiExtension>>(`/api/extensions/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  uninstall: (name: string) =>
    api<{ ok: true }>(`/api/extensions/${encodeURIComponent(name)}`, { method: "DELETE" }),
  invokeHook: (name: string, hookId: string, body: unknown) =>
    api<ApiExtensionHookResult>(
      `/api/extensions/${encodeURIComponent(name)}/hooks/${encodeURIComponent(hookId)}/invoke`,
      { method: "POST", body: JSON.stringify(body ?? {}) },
    ),
};

export type ApiJobStatus =
  | "pending"
  | "active"
  | "succeeded"
  | "failed"
  | "dead_letter"
  | "cancelled";

/** How far a long-running job has got. `null` on the job means it has not
 *  reported — render that as "—", never as 0%. */
export interface ApiJobProgress {
  done: number;
  total: number | null;
  phase?: string;
  note?: string;
}

export interface ApiJob {
  id: string;
  tenantId: string | null;
  queue: string;
  type: string;
  payload: Record<string, unknown>;
  status: ApiJobStatus;
  priority: number;
  runAt: string | number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  result: unknown;
  progress: ApiJobProgress | null;
  createdAt: string | number;
  completedAt: string | number | null;
}

export const jobsApi = {
  list: (q?: { queue?: string; status?: ApiJobStatus; limit?: number }) => {
    const params = new URLSearchParams();
    if (q?.queue) params.set("queue", q.queue);
    if (q?.status) params.set("status", q.status);
    if (q?.limit != null) params.set("limit", String(q.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return api<{ jobs: ApiJob[] }>(`/api/jobs${suffix}`);
  },
  get: (id: string) => api<ApiJob>(`/api/jobs/${encodeURIComponent(id)}`),
  enqueue: (body: {
    type: "function" | "webhook.deliver";
    payload?: Record<string, unknown>;
    queue?: string;
    runAt?: string;
    maxAttempts?: number;
    priority?: number;
  }) => api<{ id: string }>(`/api/jobs`, { method: "POST", body: JSON.stringify(body) }),
  retry: (id: string) =>
    api<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  cancel: (id: string) =>
    api<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/** A blocking hook: runs before a write and decides whether it happens. */
export interface ApiSyncHook {
  id: string;
  name: string;
  url: string;
  events: string[];
  headers: Record<string, string> | null;
  timeoutMs: number;
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
  events: string[];
  onError: "allow" | "deny";
  secret?: string | null;
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

export const syncHooksApi = {
  list: () => api<Envelope<ApiSyncHook[]>>(`/api/admin/sync-hooks`),
  create: (body: SyncHookInput) =>
    api<Envelope<ApiSyncHook>>(`/api/admin/sync-hooks`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<SyncHookInput>) =>
    api<Envelope<ApiSyncHook>>(`/api/admin/sync-hooks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) => api<{ ok: true }>(`/api/admin/sync-hooks/${id}`, { method: "DELETE" }),
  test: (id: string) =>
    api<SyncHookTestResult>(`/api/admin/sync-hooks/${id}/test`, { method: "POST" }),
};

/* ── broadcast channels ── */

/** Who a channel rule lets through. Four answers, so this is one object rather
 *  than a nullable roles list beside a nullable condition. */
export interface ChannelAccess {
  access: "none" | "public" | "authenticated" | "roles";
  roles?: string[];
  /** Permission-DSL condition over the pattern's captures, not over a row. */
  condition?: unknown;
}

export interface ApiChannelRule {
  id: string;
  name: string;
  pattern: string;
  subscribe: ChannelAccess;
  publish: ChannelAccess;
  presence: boolean;
  replay: boolean;
  retentionHours: number;
  enabled: boolean;
}

export type ChannelRuleInput = Omit<ApiChannelRule, "id">;

export interface ChannelExplainResult {
  channel: string;
  managed: boolean;
  matched: { id: string; name: string; pattern: string } | null;
  params: Record<string, string>;
  canSubscribe: boolean;
  canPublish: boolean;
  reason: string;
}

export const channelsApi = {
  list: () => api<Envelope<ApiChannelRule[]>>(`/api/admin/realtime-channels`),
  create: (body: ChannelRuleInput) =>
    api<Envelope<ApiChannelRule>>(`/api/admin/realtime-channels`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Partial<ChannelRuleInput>) =>
    api<Envelope<ApiChannelRule>>(`/api/admin/realtime-channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/realtime-channels/${id}`, { method: "DELETE" }),
  /** Answers for the CALLING identity — which is what makes it a debugging
   *  aid rather than a second copy of the rule table. */
  explain: (channel: string) =>
    api<ChannelExplainResult>(`/api/realtime/${encodeURIComponent(channel)}/explain`),
};

/* ── CDC sinks ── */

export interface ApiCdcSink {
  id: string;
  name: string;
  collection: string;
  destination: "webhook" | "storage";
  /** Without the signing secret; `hasSecret` reports presence. */
  config: Record<string, unknown>;
  shape: string | null;
  fields: string | null;
  batchSize: number;
  enabled: boolean;
  /** Opaque — the changefeed's own cursor, advanced only after a batch is
   *  acknowledged. */
  cursor: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
}

export const cdcApi = {
  list: () => api<Envelope<ApiCdcSink[]>>(`/api/admin/cdc-sinks`),
  create: (body: Record<string, unknown>) =>
    api<Envelope<ApiCdcSink>>(`/api/admin/cdc-sinks`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Record<string, unknown>) =>
    api<Envelope<ApiCdcSink>>(`/api/admin/cdc-sinks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** One page, through the same code the cron runs. */
  run: (id: string) =>
    api<{ delivered: number; cursor: string | null; hasMore: boolean; error?: string }>(
      `/api/admin/cdc-sinks/${id}/run`,
      { method: "POST" },
    ),
  remove: (id: string) => api<{ ok: true }>(`/api/admin/cdc-sinks/${id}`, { method: "DELETE" }),
};
