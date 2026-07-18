import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

interface ExtensionRow {
  id: string;
  name: string;
  version: string;
  source: string;
  npmPackage: string | null;
  enabled: boolean;
  manifest: {
    title?: string;
    description?: string;
    contributes?: {
      panels?: unknown[];
      fieldEditors?: unknown[];
      hooks?: { id: string; trigger: string; pattern?: string }[];
    };
  };
}

export const listExtensions: McpTool = {
  name: "extensions.list",
  description:
    "List installed extensions in the active workspace (admin-only). Each " +
    "entry shows name, version, enabled state and what it contributes " +
    "(panels, field editors, hooks). Use before `extensions.invoke_hook`.",
  adminOnly: true,
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/extensions`);
    const body = await readJson<{ data: ExtensionRow[] }>(res);
    const summary = body.data.map((e) => ({
      name: e.name,
      version: e.version,
      source: e.source,
      npmPackage: e.npmPackage,
      enabled: e.enabled,
      title: e.manifest.title ?? null,
      panels: e.manifest.contributes?.panels?.length ?? 0,
      fieldEditors: e.manifest.contributes?.fieldEditors?.length ?? 0,
      hooks: (e.manifest.contributes?.hooks ?? []).map((h) => ({
        id: h.id,
        trigger: h.trigger,
        pattern: h.pattern ?? null,
      })),
    }));
    return textResult({ extensions: summary });
  },
};

export const installExtension: McpTool = {
  name: "extensions.install",
  description:
    "Install (or upgrade) an extension from the npm registry (admin-only). " +
    "The package must ship a `backlex-extension.json` manifest. Returns the " +
    "installed extension row.",
  adminOnly: true,
  kind: "write",
  inputSchema: {
    type: "object",
    properties: {
      package: { type: "string", description: "npm package name (e.g. `backlex-ext-color`)." },
      version: { type: "string", description: "Exact version; omit for latest." },
    },
    required: ["package"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (typeof args.package !== "string" || args.package.length === 0) {
      throw new Error("VALIDATION: package is required");
    }
    const res = await ctx.fetchInternal(`/api/extensions/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        package: args.package,
        ...(typeof args.version === "string" ? { version: args.version } : {}),
      }),
    });
    const body = await readJson<{ data: ExtensionRow }>(res);
    return textResult(body);
  },
};

export const setExtensionEnabled: McpTool = {
  name: "extensions.set_enabled",
  description: "Enable or disable an installed extension by name (admin-only).",
  adminOnly: true,
  kind: "write",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Extension name." },
      enabled: { type: "boolean" },
    },
    required: ["name", "enabled"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (typeof args.name !== "string" || args.name.length === 0) {
      throw new Error("VALIDATION: name is required");
    }
    if (typeof args.enabled !== "boolean") {
      throw new Error("VALIDATION: enabled must be a boolean");
    }
    const res = await ctx.fetchInternal(
      `/api/extensions/${encodeURIComponent(args.name)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: args.enabled }),
      },
    );
    const body = await readJson<{ data: ExtensionRow }>(res);
    return textResult(body);
  },
};

export const uninstallExtension: McpTool = {
  name: "extensions.uninstall",
  description:
    "Uninstall an extension by name and delete its stored assets (admin-only).",
  adminOnly: true,
  kind: "destruct",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Extension name." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (typeof args.name !== "string" || args.name.length === 0) {
      throw new Error("VALIDATION: name is required");
    }
    const res = await ctx.fetchInternal(
      `/api/extensions/${encodeURIComponent(args.name)}`,
      { method: "DELETE" },
    );
    const body = await readJson<{ ok: boolean }>(res);
    return textResult(body);
  },
};

export const invokeExtensionHook: McpTool = {
  name: "extensions.invoke_hook",
  description:
    "Run an extension hook in the functions sandbox (admin-only). The " +
    "`input` object is passed as the hook's payload. Returns " +
    "`{ ok, value?, error?, logs, durationMs }`.",
  adminOnly: true,
  kind: "write",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Extension name." },
      hookId: { type: "string", description: "Hook id from the manifest." },
      input: { type: "object", description: "Payload object passed to the hook." },
    },
    required: ["name", "hookId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (typeof args.name !== "string" || args.name.length === 0) {
      throw new Error("VALIDATION: name is required");
    }
    if (typeof args.hookId !== "string" || args.hookId.length === 0) {
      throw new Error("VALIDATION: hookId is required");
    }
    const input =
      args.input && typeof args.input === "object"
        ? (args.input as Record<string, unknown>)
        : {};
    const res = await ctx.fetchInternal(
      `/api/extensions/${encodeURIComponent(args.name)}/hooks/${encodeURIComponent(args.hookId)}/invoke`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    // Same tri-shape contract as functions.invoke: 200/500 InvokeResult or an
    // error envelope. Surface verbatim; isError on either failure mode.
    let body: ({ ok?: boolean } & Record<string, unknown>) | null;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new Error(
        `extensions.invoke_hook: upstream returned non-JSON (status ${res.status})`,
      );
    }
    const isHookFailure =
      body !== null && typeof body === "object" && "ok" in body && body.ok === false;
    const isUpstreamError =
      !res.ok && !(body !== null && typeof body === "object" && "ok" in body);
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      structuredContent: body ?? undefined,
      isError: isHookFailure || isUpstreamError,
    };
  },
};

export const extensionsTools: McpTool[] = [
  listExtensions,
  installExtension,
  setExtensionEnabled,
  uninstallExtension,
  invokeExtensionHook,
];
