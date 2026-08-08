import type { ClientCore } from "../core";

/** Validated `backlex-extension.json` of an installed extension. */
export interface ExtensionManifest {
  name: string;
  version: string;
  title: string;
  description?: string;
  contributes: {
    panels?: { id: string; title: string; icon?: string; entry: string }[];
    fieldEditors?: {
      interface: string;
      title: string;
      types?: string[];
      entry: string;
    }[];
    hooks?: {
      id: string;
      trigger: "event" | "manual";
      pattern?: string;
      entry: string;
      timeoutMs?: number;
    }[];
  };
  permissions?: { api?: string[] };
}

/** One installed extension row. */
export interface Extension {
  id: string;
  name: string;
  version: string;
  source: "npm" | "upload" | string;
  npmPackage: string | null;
  manifest: ExtensionManifest;
  enabled: boolean;
}

/** Result of running an extension hook in the functions sandbox. */
export interface ExtensionInvokeResult {
  ok: boolean;
  logs: unknown[];
  error?: string;
  durationMs: number;
  value?: unknown;
}

/** Extension system (admin-scoped). Mirrors `/api/extensions`. */
export interface ExtensionsClient {
  /** List every installed extension in the active workspace. */
  list(): Promise<{ data: Extension[] }>;
  /** Enabled extensions only — what the admin SPA mounts. Any signed-in user. */
  enabled(): Promise<{ data: Extension[] }>;
  /** Install (or upgrade) an extension from the npm registry. */
  install(pkg: string, version?: string): Promise<{ data: Extension }>;
  /** Install from a `path → content` file map (local development). */
  upload(files: Record<string, string>): Promise<{ data: Extension }>;
  /** Enable or disable an installed extension. */
  setEnabled(name: string, enabled: boolean): Promise<{ data: Extension }>;
  /** Uninstall an extension and delete its stored assets. */
  uninstall(name: string): Promise<{ ok: boolean }>;
  /** Run one of the extension's hooks with an arbitrary input payload. */
  invokeHook(
    name: string,
    hookId: string,
    input?: Record<string, unknown>,
  ): Promise<ExtensionInvokeResult>;
}

export const makeExtensions = (core: ClientCore): ExtensionsClient => {
  // Extension system. Admin-scoped over `/api/extensions`; `enabled` is open
  // to any signed-in user so UIs can discover mountable contributions.
  const extPath = (name: string) => `/api/extensions/${encodeURIComponent(name)}`;
  const extensions: ExtensionsClient = {
    list: () => core.request<{ data: Extension[] }>("GET", "/api/extensions"),
    enabled: () => core.request<{ data: Extension[] }>("GET", "/api/extensions/enabled"),
    install: (pkg: string, version?: string) =>
      core.request<{ data: Extension }>("POST", "/api/extensions/install", {
        package: pkg,
        ...(version ? { version } : {}),
      }),
    upload: (files: Record<string, string>) =>
      core.request<{ data: Extension }>("POST", "/api/extensions/upload", { files }),
    setEnabled: (name: string, enabled: boolean) =>
      core.request<{ data: Extension }>("PATCH", extPath(name), { enabled }),
    uninstall: (name: string) => core.request<{ ok: boolean }>("DELETE", extPath(name)),
    invokeHook: (name: string, hookId: string, input?: Record<string, unknown>) =>
      core.request<ExtensionInvokeResult>(
        "POST",
        `${extPath(name)}/hooks/${encodeURIComponent(hookId)}/invoke`,
        input ?? {},
      ),
  };

  return extensions;
};
