import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Email over MCP — repairing a collection whose addresses were typed by people.
 *
 * The tool proxies the REST route through `fetchInternal`, so the caller's
 * identity, the workspace scoping and the permission check come from the one
 * implementation rather than being re-derived here.
 *
 * There is deliberately no `email.parse` tool, for the reason `phone` has none:
 * canonicalization is not a question an agent needs answered separately — every
 * write already performs it, and a tool that returned "what would this become"
 * would invite an agent to fold a value itself and then write the result, which
 * is one more place for the two answers to drift.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const emailNormalizeTool: McpTool = {
  name: "email.normalize",
  description:
    "Rewrite a collection's existing values of an `email` field into canonical form (trimmed, folded, " +
    "international domains encoded) — the repair path for rows that predate the column being an email " +
    "field (an adopted table, a restore, a column that used to be plain text). PAGED, not bounded by a " +
    "remaining count: walk in primary-key order by calling repeatedly and passing the returned `cursor` " +
    "back as `after`, until `cursor` is null. Values already canonical are left alone; unreadable ones " +
    "are REPORTED by row id rather than guessed at or blanked; and on a `unique` column a value that " +
    "would collide with another row is reported too and left untouched, because deciding which of two " +
    "rows is the real customer is not a question this pass may answer. So re-running is safe. Start " +
    "with `dryRun: true` — on a unique column that is the only way to see how many duplicates folding " +
    "is about to surface before writing anything. Requires `update` on the collection.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection slug." },
      field: { type: "string", description: "Name of the email field to normalize." },
      limit: {
        type: "number",
        description: "Rows to examine in this call (default 500, max 2000).",
      },
      after: {
        type: "string",
        description: "The `cursor` returned by the previous call. Omit for the first page.",
      },
      dryRun: {
        type: "boolean",
        description: "Report what would change without writing anything.",
      },
    },
    required: ["collection", "field"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = { field: args.field };
    if (args.limit !== undefined) body.limit = args.limit;
    if (args.after !== undefined) body.after = args.after;
    if (args.dryRun !== undefined) body.dryRun = args.dryRun;
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(
          `/api/email/normalize/${encodeURIComponent(String(args.collection))}`,
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

export const emailTools: McpTool[] = [emailNormalizeTool];
