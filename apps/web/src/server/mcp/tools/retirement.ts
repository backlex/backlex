import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Row retirement over MCP — taking a row out of play, and putting it back.
 *
 * Proxies the REST route through `fetchInternal`, so the caller's identity, the
 * workspace scoping and the permission check come from the one implementation
 * rather than being re-derived here.
 *
 * The description does more work than usual on purpose. An agent asked to "get
 * rid of the discontinued products" will otherwise reach for `collections-delete`
 * — which is exactly the wrong instrument, because the rows are referenced by
 * orders that must keep resolving. Saying what retirement IS (still readable,
 * no longer offered) is what points it here instead.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const retireItemTool: McpTool = {
  name: "items.retire",
  description:
    "Take one row out of play, or (with `restore`) put it back — by writing the collection's retirement " +
    "flag, the boolean declared with `retire` and spelled `active` in most schemas. " +
    "This is NOT a delete and NOT a hide: the row is still returned by reads, and every existing " +
    "reference to it still resolves — which is the point, because the orders and invoices that already " +
    "point at it must keep working. What changes is that it stops being offered for NEW work: it is " +
    "skipped by the admin's relation pickers, filtered out by `retired=exclude`, and a write pointing a " +
    "new relation at it is refused. Prefer this over deleting a row that other rows reference. " +
    "Requires `update` on the collection, covering the flag column.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection slug." },
      id: { type: "string", description: "Id of the row to retire." },
      restore: {
        type: "boolean",
        description: "Put the row back in play instead of taking it out.",
      },
    },
    required: ["collection", "id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const qs = args.restore === true ? "?restore=1" : "";
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(
          `/api/items/${encodeURIComponent(String(args.collection))}/${encodeURIComponent(
            String(args.id),
          )}/retire${qs}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
        ),
      ),
    );
  },
};

export const retirementTools: McpTool[] = [retireItemTool];
