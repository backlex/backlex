import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Document generation over MCP. Every tool proxies the admin REST routes
 * through `fetchInternal`, so the caller's identity, the workspace scoping and
 * the workspace-override rule all come from the one implementation.
 *
 * `documents.render` is the odd one: the endpoint answers `application/pdf`,
 * which an MCP tool result cannot carry as text. It returns the METADATA and a
 * byte count rather than base64 — an agent asking for a contract wants to know
 * it rendered and where it went, not a megabyte of encoded bytes in its
 * context window. Use the flow op or the SDK when the bytes are the point.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const BASE = "/api/admin/documents";

export const listDocumentTemplatesTool: McpTool = {
  name: "documents.templates_list",
  description:
    "List the workspace's document templates — the HTML a contract, quote or invoice is rendered " +
    "from. `inherited: true` means an instance-wide default this workspace has not overridden; " +
    "saving one creates the override rather than changing what other workspaces render.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) =>
    textResult(await readJson<unknown>(await ctx.fetchInternal(`${BASE}/templates`))),
};

export const saveDocumentTemplateTool: McpTool = {
  name: "documents.templates_save",
  description:
    "Create or update a document template. `bodyHtml` is a COMPLETE html document, not a " +
    "fragment — a contract sets its own fonts, page size and print styles. Values are " +
    "interpolated with `{{ data.field }}` against the row, in the body, the running header/footer " +
    "and the filename alike. Required on create: `bodyHtml`.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      bodyHtml: { type: "string" },
      headerHtml: { type: "string" },
      footerHtml: { type: "string" },
      pageOptions: {
        type: "object",
        description:
          "format (A4 default), landscape, margin (CSS length like 20mm), printBackground (ON by default here, unlike a browser's print dialog).",
        additionalProperties: true,
      },
      filename: { type: "string" },
      variables: { type: "array", items: { type: "string" } },
    },
    required: ["key"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { key, ...body } = args as { key: string } & Record<string, unknown>;
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/templates/${encodeURIComponent(key)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
  },
};

export const deleteDocumentTemplateTool: McpTool = {
  name: "documents.templates_delete",
  description:
    "Delete this workspace's own document template. An inherited instance-wide default is not " +
    "deletable from inside a workspace and returns a 404.",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { key } = args as { key: string };
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/templates/${encodeURIComponent(key)}`, {
          method: "DELETE",
        }),
      ),
    );
  },
};

export const renderDocumentTool: McpTool = {
  name: "documents.render",
  description:
    "Render a document to PDF and report what came out — filename, byte size and which renderer " +
    "produced it. The BYTES are not returned: they would fill the context window with base64. " +
    "Use this to check a template renders; use the `document.render` flow op when the file has to " +
    "go somewhere. Exactly one of `templateKey` or `html`. Fails when no renderer is configured — " +
    "there is deliberately no fallback that would produce a document with broken glyphs.",
  inputSchema: {
    type: "object",
    properties: {
      templateKey: { type: "string" },
      html: { type: "string" },
      vars: {
        type: "object",
        description: "Usually `{ data: { …the row… } }`, matching `{{ data.x }}` in the template.",
        additionalProperties: true,
      },
      pageOptions: { type: "object", additionalProperties: true },
      filename: { type: "string" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`${BASE}/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      // The error body is JSON even though success is a PDF, so it is read
      // rather than reported as a bare status.
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(body.error?.message ?? `Render failed (${res.status})`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return textResult({
      ok: true,
      filename: res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? null,
      bytes: bytes.byteLength,
      renderer: res.headers.get("x-backlex-renderer"),
    });
  },
};

export const documentsTools: McpTool[] = [
  listDocumentTemplatesTool,
  saveDocumentTemplateTool,
  deleteDocumentTemplateTool,
  renderDocumentTool,
];
