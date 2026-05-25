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

/** Tool-name suffixes that mutate state. Matched against the part AFTER the
 *  last `.` in the dot-cased tool name (`collections.insert` → `insert`).
 *  Read-only keys reject any call whose verb is in this set.
 *
 *  When adding a new write tool, update this list — or the read-only guard
 *  becomes a leak. The tests in `tests/mcp.test.ts` cover every namespace
 *  so a forgotten entry fails loudly. */
const WRITE_VERBS = new Set([
  "insert",
  "update",
  "delete",
  "create",
  "create_collection",
  "update_collection",
  "drop_collection",
  "drop",
  "upload",
  "bulk_insert",
  "bulk_update",
  "upsert",
  "grant",
  "revoke",
  "assign",
  "unassign",
  "invoke",
  "send",
  "mark_read",
  "test",
  "invite",
  "suspend",
  "activate",
  // Tier C additions
  "execute_sql",
  "switch",
  "set_roles",
  "providers_create",
  "providers_delete",
  "post",
  "revert",
  "patch_settings",
  "sign_url",
]);

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

export const isWriteTool = (toolName: string): boolean => {
  const dot = toolName.lastIndexOf(".");
  const verb = dot < 0 ? toolName : toolName.slice(dot + 1);
  return WRITE_VERBS.has(verb);
};

/** Decide whether a `tools/call` for `toolName` is permitted under the
 *  active guards. Returns `{ ok: true }` or `{ ok: false, code, message }`
 *  for the dispatcher to surface as a JSON-RPC error. */
export const checkToolCall = (
  toolName: string,
  guards: KeyGuards,
): { ok: true } | { ok: false; code: "FORBIDDEN"; message: string } => {
  if (!isToolAllowed(toolName, guards)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: `tool "${toolName}" is not in this API key's MCP allowlist`,
    };
  }
  if (guards.readOnly && isWriteTool(toolName)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: `tool "${toolName}" is a write operation; this API key is MCP read-only`,
    };
  }
  return { ok: true };
};
