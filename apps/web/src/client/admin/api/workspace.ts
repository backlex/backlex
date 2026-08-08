import { api } from "@/lib/api";
import type { Envelope } from "./types";

/** Resolved (public) workspace branding view returned by
 *  `GET /api/workspace-config` — workspace's own row merged onto `_global`
 *  for text/color/theme fields. `logoUrl` / `faviconUrl` already include the
 *  cache-busting query param when set. */
export interface ApiWorkspaceConfigResolved {
  workspaceName: string | null;
  description: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  defaultTheme: "light" | "dark" | "system" | null;
}

/** Raw workspace branding row as returned by `/api/workspace-config/raw` —
 *  the workspace's own values (no `_global` fallback) so the admin form edits
 *  this workspace specifically. */
export interface ApiWorkspaceConfigRaw {
  tenantId: string;
  workspaceName: string | null;
  description: string | null;
  /** Logical file keys (no `tenants/<id>/` prefix). Build the preview URL as
   *  `/api/storage/<encoded-key>`. */
  logoFileKey: string | null;
  faviconFileKey: string | null;
  /** Raw OKLCH string or null (= use the design-system default). */
  primaryColor: string | null;
  /** "light" | "dark" | "system" | null (= leave to user). */
  defaultTheme: string | null;
  updatedAt: number | string | null;
}

export interface ApiRuntime {
  adapter: "bun" | "workers" | "vercel";
  dialect: "pg" | "sqlite";
  bindings: { type: string; name: string; target: string; status: string }[];
  envVars: { key: string; set: boolean; secret: boolean; source: string }[];
  version: string;
  commit: string;
  released: string;
  wrangler: string;
}

export const workspaceConfigApi = {
  /** Public resolved view — used by `main.tsx` boot-time branding injection. */
  getResolved: () =>
    api<Envelope<ApiWorkspaceConfigResolved>>(`/api/workspace-config`),
  /** Admin form: workspace's own row, no `_global` fallback applied. */
  getRaw: () => api<Envelope<ApiWorkspaceConfigRaw>>(`/api/workspace-config/raw`),
  put: (body: {
    workspaceName?: string | null;
    description?: string | null;
    logoFileKey?: string | null;
    faviconFileKey?: string | null;
    primaryColor?: string | null;
    defaultTheme?: "light" | "dark" | "system" | "" | null;
  }) =>
    api<{ ok: true }>(`/api/workspace-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};

/** One entry of the server's AI provider registry (`services/ai-providers.ts`).
 *  Descriptive only — `envKey` is the NAME of an env var, never its value. */
export interface ApiAiProvider {
  id: string;
  label: string;
  secretKey: string;
  secretLabel: string;
  envKey: string;
  transport: "gateway" | "direct";
  defaultModel: string;
  hint: string;
  docsUrl: string;
}

/** One selectable model from the server's catalog. */
export interface ApiAiModel {
  id: string;
  label: string;
  namespace: string;
  hint: string;
  tier: "flagship" | "balanced" | "fast";
}

export interface ApiAiConfig {
  tenantId: string;
  /** `inherit` or a registry provider id. */
  provider: string;
  config: Record<string, unknown>;
  /** Per-provider "is a key stored" flag, keyed by `ApiAiProvider.secretKey`.
   *  Never the key itself. */
  secretsSet: Record<string, boolean>;
  updatedAt: number | string | null;
  env: { cloud: boolean; hasGatewayKey: boolean; hasAnthropicKey: boolean };
  providerIds: readonly string[];
  providers: readonly ApiAiProvider[];
  models: readonly ApiAiModel[];
  /** Model ids each provider id can actually run — drives the picker filter. */
  modelsByProvider: Record<string, readonly string[]>;
}

export const aiConfigApi = {
  get: () => api<Envelope<ApiAiConfig>>(`/api/admin/ai-config`),
  put: (body: {
    provider: string;
    config?: Record<string, unknown>;
    secrets?: Record<string, string | null>;
  }) =>
    api<{ ok: true }>(`/api/admin/ai-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  test: () =>
    api<{ ok: true; reply: string }>(`/api/admin/ai-config/test`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
};

export const settingsApi = {
  load: () => api<Envelope<Record<string, unknown>>>(`/api/admin/settings`),
  patch: (body: Record<string, unknown>) =>
    api<{ ok: true }>(`/api/admin/settings`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  runtime: () => api<Envelope<ApiRuntime>>(`/api/admin/settings/runtime`),
};
