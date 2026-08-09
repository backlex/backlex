import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * S3 credentials over MCP.
 *
 * The one thing every description has to carry is that `s3.create_credential`
 * returns a secret that is shown once. An agent that discards it has cost the
 * operator a credential they cannot recover — there is no read-back path, by
 * design.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const BASE = "/api/admin/s3-credentials";

export const listS3CredentialsTool: McpTool = {
  name: "s3.list_credentials",
  description:
    "List this workspace's S3-endpoint credentials. Secrets are never included. Use these with any " +
    "S3 tool (rclone, aws-cli, mc) pointed at `<instance>/s3`; the bucket name is the workspace slug.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_a, ctx) => textResult(await readJson<unknown>(await ctx.fetchInternal(BASE))),
};

export const createS3CredentialTool: McpTool = {
  name: "s3.create_credential",
  description:
    "Mint an S3 credential. The `secretAccessKey` in the response is shown ONCE and cannot be " +
    "read back — surface it to the user immediately. `prefix` scopes the credential to keys under " +
    "one path; `readOnly` refuses every mutating verb, which is what a backup tool should hold.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      prefix: { type: "string" },
      readOnly: { type: "boolean" },
      expiresAt: { type: "number", description: "Epoch ms." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(BASE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args),
        }),
      ),
    ),
};

export const updateS3CredentialTool: McpTool = {
  name: "s3.update_credential",
  description:
    "Update an S3 credential. Disabling one takes effect on the next request — there is no session " +
    "to expire, so this is how a leaked credential is stopped.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      prefix: { type: "string" },
      readOnly: { type: "boolean" },
      enabled: { type: "boolean" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id, ...patch } = args as Record<string, unknown>;
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/${encodeURIComponent(String(id))}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        }),
      ),
    );
  },
};

export const deleteS3CredentialTool: McpTool = {
  name: "s3.delete_credential",
  description: "Delete an S3 credential. Anything using it stops working immediately.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/${encodeURIComponent(String(args.id))}`, {
          method: "DELETE",
        }),
      ),
    ),
};

export const s3Tools: McpTool[] = [
  listS3CredentialsTool,
  createS3CredentialTool,
  updateS3CredentialTool,
  deleteS3CredentialTool,
];
