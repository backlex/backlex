/**
 * Helpers for attaching MCP `resource_link` content (2025-06-18) to a tool
 * result. A link points at one of the server's readable resources so the client
 * can pull it as a follow-up — e.g. after `schema.create_collection`, the agent
 * gets a link to inspect the new collection's schema + sample rows.
 */
import type { ToolContent, ToolResult } from "../types";

/** A link to `backlex://collection/<slug>` (the per-collection resource). */
export const collectionLink = (slug: string): ToolContent => ({
  type: "resource_link",
  uri: `backlex://collection/${slug}`,
  name: slug,
  description: `Open the "${slug}" collection — full field schema + a sample of its rows.`,
  mimeType: "application/json",
});

/** Append resource links after a result's existing content (keeps the text /
 *  structuredContent at index 0 so callers that read content[0] are unaffected). */
export const withLinks = (result: ToolResult, ...links: ToolContent[]): ToolResult => ({
  ...result,
  content: [...result.content, ...links],
});
