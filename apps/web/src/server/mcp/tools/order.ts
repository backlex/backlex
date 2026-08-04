import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Manual ordering over MCP — moving a row in a hand-arranged list.
 *
 * Both tools proxy the REST routes through `fetchInternal`, so the caller's
 * identity, the workspace scoping and the permission check come from the one
 * implementation rather than being re-derived here.
 *
 * There is deliberately no `order.set` tool that writes a raw position. An agent
 * handed one would do what a person with a form does today — renumber the rows
 * around it, one at a time, getting one wrong — which is the problem the feature
 * exists to remove. `order.move` states the INTENT ("put this after that") and
 * lets the server work out the numbers.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const orderMoveTool: McpTool = {
  name: "order.move",
  description:
    "Move a row so it sits immediately before or after another row in the same hand-arranged list. " +
    "Give exactly one of `before` / `after` — the id of the row to land next to. Both rows must be in " +
    "the same list: moving a row between lists is a change to the scope column and is done with an " +
    "ordinary item update, which re-appends it to the end of the list it joined. Only the rows between " +
    "the old and the new place are renumbered. If the list still holds duplicate positions (any " +
    "collection whose `position` column defaulted to 0 does), it is first renumbered into the order it " +
    "currently reads in and the count comes back as `repaired`. Requires `update` on the collection.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection slug." },
      field: {
        type: "string",
        description:
          "Name of the order field being rearranged (a collection may carry more than one).",
      },
      id: { type: "string", description: "Id of the row to move." },
      before: { type: "string", description: "Put the row immediately before this row's id." },
      after: { type: "string", description: "Put the row immediately after this row's id." },
    },
    required: ["collection", "field", "id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = { field: args.field, id: args.id };
    if (args.before !== undefined) body.before = args.before;
    if (args.after !== undefined) body.after = args.after;
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(
          `/api/items/${encodeURIComponent(String(args.collection))}/reorder`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        ),
      ),
    );
  },
};

export const orderNormalizeTool: McpTool = {
  name: "order.normalize",
  description:
    "Renumber a collection's order fields into dense 1…N within each list, keeping the order the rows " +
    "currently read in (position, then when they were created). The repair path for a column that " +
    "predates being declared an order field — every schema template's `position` defaults to 0, so all " +
    "its rows are tied and the sort over them is arbitrary. Idempotent, and safe to run before a series " +
    "of moves. Omit `field` to normalize every order field on the collection. A single list larger than " +
    "10,000 rows is refused rather than silently rewritten. Requires `update` on the collection.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection slug." },
      field: {
        type: "string",
        description: "Order field to renumber. Omit to normalize all of them.",
      },
    },
    required: ["collection"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = {};
    if (args.field !== undefined) body.field = args.field;
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(
          `/api/items/${encodeURIComponent(String(args.collection))}/order/normalize`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        ),
      ),
    );
  },
};

export const orderTools: McpTool[] = [orderMoveTool, orderNormalizeTool];
