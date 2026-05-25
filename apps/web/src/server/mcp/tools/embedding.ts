import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const upsertEmbeddings: McpTool = {
  name: "embedding.upsert",
  description:
    "Embed text records server-side and upsert them into the vector store. " +
    "Same surface as `vector.upsert` — listed under the `embedding.*` " +
    "namespace for discoverability. Use `vector.search` to query afterwards.",
  inputSchema: {
    type: "object",
    properties: {
      model: {
        type: "string",
        description: "Embedding model key (`bge-m3`, `openai-3-small`, `openai-3-large`, `self-host-bge-m3`).",
      },
      records: {
        type: "array",
        description: "Array of `{ id, text, namespace?, metadata? }` (max 100).",
      },
    },
    required: ["model", "records"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (!Array.isArray(args.records)) throw new Error("VALIDATION: records must be an array");
    const res = await ctx.fetchInternal(`/api/vector/embed-upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: args.model, records: args.records }),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const embeddingTools: McpTool[] = [upsertEmbeddings];
