import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const vectorSearch: McpTool = {
  name: "vector.search",
  description:
    "Embed the query text with the chosen model and run ANN (approximate " +
    "nearest neighbor) search. Returns matches with score + metadata. " +
    "Use this for semantic search over vectorize-enabled collections.",
  inputSchema: {
    type: "object",
    properties: {
      model: {
        type: "string",
        description:
          "Embedding model key — must be one of the registered models " +
          "(`bge-m3`, `openai-3-small`, `openai-3-large`, `self-host-bge-m3`).",
      },
      text: { type: "string", description: "Free-text query to embed." },
      topK: { type: "number", description: "Max matches to return (1-100, default 10)." },
      namespace: { type: "string", description: "Restrict to a vector namespace." },
      filter: {
        type: "object",
        description: "Metadata filter map (provider-specific shape).",
      },
    },
    required: ["model", "text"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const payload = {
      model: args.model,
      text: args.text,
      topK: typeof args.topK === "number" ? args.topK : undefined,
      namespace: typeof args.namespace === "string" ? args.namespace : undefined,
      filter:
        args.filter && typeof args.filter === "object" ? args.filter : undefined,
    };
    const res = await ctx.fetchInternal(`/api/vector/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const vectorUpsert: McpTool = {
  name: "vector.upsert",
  description:
    "Embed text records server-side and upsert them into the vector store. " +
    "Each record needs an id + text; the model decides the embedding space.",
  inputSchema: {
    type: "object",
    properties: {
      model: { type: "string" },
      records: {
        type: "array",
        description: "Array of `{ id, text, namespace?, metadata? }` records (max 100).",
      },
    },
    required: ["model", "records"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (!Array.isArray(args.records)) {
      throw new Error("VALIDATION: records must be an array");
    }
    const res = await ctx.fetchInternal(`/api/vector/embed-upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: args.model, records: args.records }),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const vectorTools: McpTool[] = [vectorSearch, vectorUpsert];
