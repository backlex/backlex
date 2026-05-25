import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const graphqlExecute: McpTool = {
  name: "graphql.execute",
  description:
    "Execute a GraphQL query or mutation against the workspace's auto-" +
    "generated schema. Use this when you need nested joins, field selection, " +
    "or relation traversal that a single `collections.list` call can't " +
    "express. The schema is built from collections + relations — call " +
    "`schema.list_collections` to discover available fields.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "GraphQL document (query or mutation)." },
      variables: {
        type: "object",
        description: "Optional variable map referenced by the query.",
      },
      operationName: {
        type: "string",
        description: "Pick a named operation when the document declares more than one.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const query = args.query;
    if (typeof query !== "string" || query.length === 0) {
      throw new Error("VALIDATION: query is required");
    }
    const payload: Record<string, unknown> = { query };
    if (args.variables && typeof args.variables === "object") {
      payload.variables = args.variables;
    }
    if (typeof args.operationName === "string") {
      payload.operationName = args.operationName;
    }
    const res = await ctx.fetchInternal(`/api/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    // GraphQL responses include `data` + optional `errors` regardless of
    // HTTP status; surface the body verbatim. isError fires when the GraphQL
    // layer reported execution errors so the caller can branch on it.
    const body = (await res.json().catch(() => null)) as
      | { data?: unknown; errors?: unknown[] }
      | null;
    if (!body) {
      throw new Error(`graphql.execute: upstream returned non-JSON (status ${res.status})`);
    }
    const hasErrors = Array.isArray(body.errors) && body.errors.length > 0;
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      structuredContent: body,
      isError: hasErrors,
    };
  },
};

export const graphqlTools: McpTool[] = [graphqlExecute];
