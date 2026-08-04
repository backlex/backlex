import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Slugs over MCP — filling in the URL handles a collection is missing.
 *
 * Proxies the REST route through `fetchInternal`, so the caller's identity, the
 * workspace scoping and the permission check come from the one implementation
 * rather than being re-derived here.
 *
 * There is deliberately no tool that WRITES a slug directly: an agent that
 * wants to set one uses `collections-update` like it would for any other
 * column, and the server folds it on the way in. What an agent cannot do
 * through ordinary writes — and what this exposes — is fill in the rows it
 * would otherwise have to enumerate and patch one at a time.
 *
 * `apply` defaults to false. A slug is a public URL, and this writes them onto
 * rows the caller never named, so an agent has to look at the report and then
 * ask for it again.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const slugBackfillTool: McpTool = {
  name: "slug.backfill",
  description:
    "Fold a URL slug out of each row's source column for every row in a collection whose slug field is " +
    "empty, taking the next free suffix when the obvious answer is taken. The repair path for a column " +
    "that predates being declared a slug field — every slug in the schema-template catalog is optional " +
    "and nothing ever generated one, so a workspace can hold years of rows with no handle at all. Rows " +
    "that ALREADY have a slug are never touched, because that slug may be a published URL. Text with no " +
    "Latin letters to fold is reported as `unfoldable` rather than given an invented token. Runs as a " +
    "DRY RUN unless `apply` is true — read the report first. Bounded at 1000 rows per field per call; " +
    "re-run while `filled` is non-zero. Idempotent. Requires `update` on the collection covering the " +
    "slug column.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection slug." },
      field: {
        type: "string",
        description: "Slug field to fill. Omit to do every slug field on the collection.",
      },
      apply: {
        type: "boolean",
        description:
          "Write the values. Omit or pass false to get the report without changing anything.",
      },
    },
    required: ["collection"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = {};
    if (args.field !== undefined) body.field = args.field;
    if (args.apply === true) body.apply = true;
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(
          `/api/items/${encodeURIComponent(String(args.collection))}/slugs/backfill`,
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

export const slugTools: McpTool[] = [slugBackfillTool];
