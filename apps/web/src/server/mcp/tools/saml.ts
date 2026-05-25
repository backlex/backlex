import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const requireId = (args: Record<string, unknown>): string => {
  const id = args.id;
  if (typeof id !== "string" || id.length === 0)
    throw new Error("VALIDATION: id is required");
  return id;
};

export const listSamlProviders: McpTool = {
  name: "saml.providers_list",
  description:
    "List the SAML 2.0 identity providers configured for the active " +
    "workspace's end-user auth surface. Admin-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/saml/providers`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const createSamlProvider: McpTool = {
  name: "saml.providers_create",
  description:
    "Register a new SAML provider for the workspace. Supply either inline " +
    "`entityId` + `singleSignOnUrl` + `x509Cert`, or a `metadataUrl` / " +
    "`metadataXml` to import. Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Display label for the IdP button." },
      entityId: { type: "string" },
      singleSignOnUrl: { type: "string" },
      x509Cert: { type: "string", description: "PEM-encoded certificate." },
      metadataUrl: { type: "string" },
      metadataXml: { type: "string" },
      attributeMapping: {
        type: "object",
        description: "SAML assertion attribute → user field map (e.g. `{ email: 'mail' }`).",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/saml/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const deleteSamlProvider: McpTool = {
  name: "saml.providers_delete",
  description: "Remove a SAML provider by id. Sessions issued via it stay valid until expiry.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireId(args);
    const res = await ctx.fetchInternal(
      `/api/admin/saml/providers/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const samlTools: McpTool[] = [
  listSamlProviders,
  createSamlProvider,
  deleteSamlProvider,
];
