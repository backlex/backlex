/**
 * MCP tool-name wire format.
 *
 * Our tool ids use dot separators (`collections.aggregate`,
 * `schema.list_collections`). But an OAuth-connected claude.ai custom
 * connector — and the underlying Anthropic tool contract — validate every
 * exposed tool name against `^[a-zA-Z0-9_-]{1,64}$`, which does NOT allow a
 * dot. So a raw `tools/list` is rejected wholesale by the client
 * (`FrontendRemoteMcpToolDefinition.name: String should match pattern …`),
 * even though the server response is well-formed.
 *
 * Fix: present a hyphen-substituted name ON THE WIRE and translate calls back.
 * The mapping is bijective because no tool id contains a hyphen — substituting
 * `.`→`-` (not `.`→`_`, since ids already use `_`) round-trips exactly.
 * `mcp-tool-names.test.ts` guards both invariants (every id matches the
 * pattern after conversion, and no id contains a hyphen).
 *
 * The substitution lives ONLY at the JSON-RPC edge (tools/list output +
 * tools/call input). Everything internal — the permission DSL, per-key
 * allowlists (`mcpTools`), activity logging (`mcp.<tool>`), the Ask-AI
 * planner, the admin Tools tab — keeps the canonical dotted id untouched.
 */

/** Canonical dotted id → wire name a strict client will accept. */
export const toWireToolName = (canonical: string): string =>
  canonical.replaceAll(".", "-");

/**
 * Wire name (from a `tools/call`) → canonical dotted id. Resolved against the
 * known id set so an unknown name is returned verbatim (yielding the client's
 * own name in the "unknown tool" error). Accepts a canonical dotted id
 * directly too, so clients that never needed the substitution (Claude Desktop
 * historically sanitizes names itself) keep working unchanged.
 */
export const fromWireToolName = (
  wire: string,
  knownCanonicalNames: ReadonlySet<string>,
): string => {
  if (knownCanonicalNames.has(wire)) return wire;
  const dotted = wire.replaceAll("-", ".");
  return knownCanonicalNames.has(dotted) ? dotted : wire;
};
