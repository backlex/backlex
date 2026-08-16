import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Geo over MCP — placing an address, and repairing a collection whose rows have
 * addresses but no points.
 *
 * Every tool proxies the REST routes through `fetchInternal`, so the caller's
 * identity, the workspace scoping and the permission checks come from the one
 * implementation rather than being re-derived here.
 *
 * There is deliberately no `geo.near` tool: proximity is a FILTER, not a
 * separate query, and it already reaches an agent through `collections-list`'s
 * filter argument. A parallel tool would be a second, narrower way to ask the
 * same question, and the two would drift.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const geocodeTool: McpTool = {
  name: "geo.geocode",
  description:
    "Resolve a written address to a { lat, lng } point using the workspace's configured geocoding " +
    "provider. `data` is null when the provider found nothing — an unplaceable address is a normal " +
    "answer, not an error. `formatted` is the place the provider actually matched, which is how you " +
    "tell that 'Springfield' resolved to the wrong Springfield. Fails when no provider is configured.",
  inputSchema: {
    type: "object",
    properties: { address: { type: "string" } },
    required: ["address"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal("/api/geo/geocode", postJson({ address: args.address })),
      ),
    ),
};

export const reverseGeocodeTool: McpTool = {
  name: "geo.reverse",
  description:
    "Resolve a { lat, lng } point to the address it falls in. Not every provider supports this; " +
    "the call fails plainly when the configured one does not.",
  inputSchema: {
    type: "object",
    properties: { lat: { type: "number" }, lng: { type: "number" } },
    required: ["lat", "lng"],
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(
          "/api/geo/reverse",
          postJson({ lat: args.lat, lng: args.lng }),
        ),
      ),
    ),
};

export const geoBackfillTool: McpTool = {
  name: "geo.backfill",
  description:
    "Geocode the rows of a collection that have an address (the geo field's `geocodeFrom` columns) " +
    "and no point yet — the repair path for an imported or adopted table, since imports deliberately " +
    "do not geocode row by row. BOUNDED per call: `limit` defaults to 50, ceiling 500. Call it " +
    "repeatedly while `remaining > 0`. Only ever FILLS a missing point, never revises one, so it is " +
    "safe to re-run and a hand-corrected pin survives it. Requires `update` on the collection. " +
    "Set `async: true` to hand the WHOLE collection to the durable job queue instead of looping " +
    "yourself: it returns `{jobId}`, works through every batch, and re-checks your `update` " +
    "permission each time it runs. Not available when acting through an API key.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection slug." },
      field: { type: "string", description: "Name of the geo field to fill in." },
      limit: {
        type: "number",
        description: "Rows to attempt in this call (default 50, max 500).",
      },
      async: {
        type: "boolean",
        description:
          "Queue the whole backfill as a background job and return a `jobId` instead of one batch.",
      },
    },
    required: ["collection", "field"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = { field: args.field };
    if (args.limit !== undefined) body.limit = args.limit;
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(
          `/api/geo/backfill/${encodeURIComponent(String(args.collection))}${args.async ? "?async=1" : ""}`,
          postJson(body),
        ),
      ),
    );
  },
};

export const geoTools: McpTool[] = [geocodeTool, reverseGeocodeTool, geoBackfillTool];
