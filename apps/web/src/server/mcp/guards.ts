/**
 * Per-key MCP guards layered on top of the permissions DSL:
 *  - **Allowlist** — keys may carry a `mcpTools` JSON array that pins them
 *    to a subset of the server's tool catalog. `null` = no allowlist.
 *  - **Read-only** — keys with `mcpReadOnly=true` cannot call any tool
 *    classified as a write (any namespace verb that mutates state).
 *
 * Cookie / app-session callers don't carry these fields; the guards become
 * no-ops for them. The REST surface is unaffected either way — these
 * restrictions live entirely in the MCP layer.
 */

import type { ToolKind } from "./kind";

export interface KeyGuards {
  /** Active allowlist; `null` = unrestricted. */
  allowlist: string[] | null;
  /** When true, the read-only guard applies. */
  readOnly: boolean;
}

export const guardsFromAuth = (auth: {
  apiKeyMcpTools?: string[] | null;
  apiKeyMcpReadOnly?: boolean;
}): KeyGuards => ({
  allowlist: auth.apiKeyMcpTools ?? null,
  readOnly: Boolean(auth.apiKeyMcpReadOnly),
});

/** Filter a list of tool names against the active allowlist. Unrestricted
 *  → returns the input verbatim. */
export const filterByAllowlist = (
  names: string[],
  guards: KeyGuards,
): string[] => {
  if (!guards.allowlist) return names;
  const allowed = new Set(guards.allowlist);
  return names.filter((n) => allowed.has(n));
};

export const isToolAllowed = (toolName: string, guards: KeyGuards): boolean => {
  if (!guards.allowlist) return true;
  return guards.allowlist.includes(toolName);
};

/** Decide whether a `tools/call` for `toolName` (of the given `kind`) is
 *  permitted under the active guards. Returns `{ ok: true }` or
 *  `{ ok: false, code, message }` for the dispatcher to surface. `kind` is the
 *  tool's resolved classification (see `resolveKind`) — anything but `read`
 *  counts as a mutation under the read-only guard, so the gate tracks the tool's
 *  true behaviour rather than a separate name heuristic that could drift. */
export const checkToolCall = (
  toolName: string,
  kind: ToolKind,
  guards: KeyGuards,
): { ok: true } | { ok: false; code: "FORBIDDEN"; message: string } => {
  if (!isToolAllowed(toolName, guards)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: `tool "${toolName}" is not in this API key's MCP allowlist`,
    };
  }
  if (guards.readOnly && kind !== "read") {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: `tool "${toolName}" is a ${kind} operation; this API key is MCP read-only`,
    };
  }
  return { ok: true };
};
