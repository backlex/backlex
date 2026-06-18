/**
 * Single source of truth for a tool's kind (read / write / destruct). Drives
 * BOTH the `tools/list` descriptor annotations AND the read-only guard, so the
 * UI badge and the security check can never disagree.
 *
 * The name heuristic defaults to **write** — a fail-safe for the read-only
 * guard: an unclassified verb is treated as a mutation, so a newly-added tool is
 * blocked for read-only keys until it's reviewed. Genuine reads with unusual
 * verbs (aggregate, query, …) carry an explicit `kind: "read"` on the tool.
 */
import type { McpTool } from "./types";

export type ToolKind = "read" | "write" | "destruct";

const READ_VERBS = new Set(["list", "read", "search", "get", "describe"]);
const DESTRUCT_VERBS = new Set(["delete", "drop", "revoke", "suspend"]);

/** Heuristic kind from the leading verb token after the last dot
 *  (`schema.list_collections` → `list` → read). Unknown verbs → write. */
export const kindFromName = (name: string): ToolKind => {
  const dot = name.lastIndexOf(".");
  const tail = dot < 0 ? name : name.slice(dot + 1);
  const verb = tail.split("_")[0] ?? tail;
  if (DESTRUCT_VERBS.has(verb)) return "destruct";
  if (READ_VERBS.has(verb)) return "read";
  return "write";
};

/** Explicit `kind` on the tool wins; otherwise fall back to the heuristic. */
export const resolveKind = (tool: McpTool): ToolKind => tool.kind ?? kindFromName(tool.name);
