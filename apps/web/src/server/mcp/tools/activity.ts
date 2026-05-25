import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const searchActivity: McpTool = {
  name: "activity.search",
  description:
    "Search the workspace audit log. Filters by action, collection, " +
    "itemId, userId, and a date range; sorted newest-first. Use this to " +
    "answer 'who changed X' or 'what happened around T' questions.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "e.g. `create`, `update`, `delete`, `invoke`, `mcp.tool`." },
      collection: { type: "string" },
      itemId: { type: "string" },
      userId: { type: "string" },
      since: { type: "string", description: "ISO-8601 timestamp lower bound." },
      until: { type: "string", description: "ISO-8601 timestamp upper bound." },
      limit: { type: "number" },
      offset: { type: "number" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const qs = new URLSearchParams();
    for (const k of ["action", "collection", "itemId", "userId", "since", "until"]) {
      const v = args[k];
      if (typeof v === "string" && v.length > 0) qs.set(k, v);
    }
    if (typeof args.limit === "number") qs.set("limit", String(args.limit));
    if (typeof args.offset === "number") qs.set("offset", String(args.offset));
    const path = `/api/activity` + (qs.toString() ? `?${qs.toString()}` : "");
    const res = await ctx.fetchInternal(path);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const activityTools: McpTool[] = [searchActivity];
