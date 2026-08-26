/**
 * MCP guards layered on top of the permissions DSL. Two independent restriction
 * sources, both narrowing (neither can ever *grant* anything the DSL denies):
 *
 *  - **Per-key** — an API key may carry an `mcpTools` allowlist and an
 *    `mcpReadOnly` flag. Scoped to the credential.
 *  - **Per-role** — a role may carry the same two fields. Scoped to the
 *    *person*, so minting a fresh key doesn't shed the restriction.
 *
 * The two compose by intersection: a call must satisfy the role guards **and**
 * the key guards.
 *
 * Within the role side, the rule is **null means "no opinion", not "allow
 * everything"**. That distinction is load-bearing: every signed-in user carries
 * the `authenticated` system role, which has no MCP policy — under the
 * permission DSL's "most permissive role wins" it would cancel every
 * restriction anyone else configured, and the whole feature would be dead code.
 * So:
 *
 *  - **Allowlist** — the union of the lists on roles that set one. When no role
 *    sets a list, there's no allowlist at all. Holding two restricted roles
 *    widens (union), which is the additive behaviour operators expect; holding
 *    a policy-free role changes nothing.
 *  - **Read-only** — sticks if ANY applicable role sets it. There is no "no
 *    opinion" value for a boolean that defaults to false, and a guard that a
 *    second role could lift wouldn't be a guard.
 *
 * Both directions only ever narrow — neither can grant something the permission
 * DSL denies. Admin roles are excluded upstream (see `loadRoleMcpGuards`): they
 * already mean "unrestricted", and a tool allowlist on one would be a footgun.
 *
 * Cookie / app-session callers carry no key fields; those guards become no-ops
 * while the role guards still apply. The REST surface is unaffected either way —
 * these restrictions live entirely in the MCP layer.
 */

import type { ToolKind } from "./kind";
import { RETIRED_TOOL_ALIASES } from "./tool-aliases";

export interface KeyGuards {
  /** The API key's own allowlist; `null` = the key adds no restriction. */
  allowlist: string[] | null;
  /** True when either the key or any applicable role forces read-only. */
  readOnly: boolean;
  /** Allowlist contributed by the caller's roles; `null` = the roles add no
   *  restriction. Kept separate from `allowlist` rather than pre-merged
   *  because glob patterns don't intersect as plain sets — a tool must match
   *  both lists independently. */
  roleAllowlist?: string[] | null;
}

export const guardsFromAuth = (auth: {
  apiKeyMcpTools?: string[] | null;
  apiKeyMcpReadOnly?: boolean;
}): KeyGuards => ({
  allowlist: auth.apiKeyMcpTools ?? null,
  readOnly: Boolean(auth.apiKeyMcpReadOnly),
});

/** What a role contributes to the effective guards. */
export interface RoleGuards {
  allowlist: string[] | null;
  readOnly: boolean;
}

/**
 * Collapse the caller's roles into one contribution. Roles that set no
 * allowlist are ignored rather than treated as "allow everything" — see the
 * module header for why that distinction decides whether the feature works at
 * all. An empty role set (an unauthenticated or role-less caller) contributes
 * nothing, and the key guards still apply.
 */
export const combineRoleGuards = (roles: RoleGuards[]): RoleGuards => {
  const opinionated = roles.filter((r) => r.allowlist !== null);
  const allowlist =
    opinionated.length === 0
      ? null
      : [...new Set(opinionated.flatMap((r) => r.allowlist ?? []))];
  return { allowlist, readOnly: roles.some((r) => r.readOnly) };
};

/** Fold a role contribution into the per-key guards. Both narrow, so read-only
 *  ORs and the allowlists stay separate (see {@link KeyGuards.roleAllowlist}). */
export const mergeGuards = (key: KeyGuards, role: RoleGuards): KeyGuards => ({
  allowlist: key.allowlist,
  roleAllowlist: role.allowlist,
  readOnly: key.readOnly || role.readOnly,
});

/**
 * Match one allowlist entry against a canonical (dotted) tool id.
 *
 * Entries are exact ids (`collections.read`) or namespace globs
 * (`collections.*`, or a bare `*` for everything). A glob only ever spans one
 * namespace segment boundary — `collections.*` matches `collections.read` but
 * not `collections_admin.read` — because the alternative (substring matching)
 * would silently widen an allowlist every time a new namespace shares a prefix.
 */
export const matchesPattern = (pattern: string, toolName: string): boolean => {
  if (pattern === toolName) return true;
  if (pattern === "*") return true;
  // An allowlist stores the id it was GRANTED, so a tool that has since been
  // renamed would silently narrow every key that named the old spelling — the
  // key keeps working for everything else and loses exactly one capability,
  // with nothing to say why. Retired ids therefore resolve here too: a key
  // granted `flows.invoke` still authorises `flows.run`, because it is the
  // same capability under a name we changed.
  if (RETIRED_TOOL_ALIASES.get(pattern) === toolName) return true;
  // "collections.*" → every id starting with "collections." (the trailing dot
  // is what keeps the glob inside its own namespace).
  if (pattern.endsWith(".*")) return toolName.startsWith(pattern.slice(0, -1));
  return false;
};

const listAllows = (list: string[] | null | undefined, name: string): boolean =>
  list == null ? true : list.some((p) => matchesPattern(p, name));

/** Filter a list of tool names against every active allowlist. Unrestricted
 *  → returns the input verbatim. */
export const filterByAllowlist = (
  names: string[],
  guards: KeyGuards,
): string[] => {
  if (!guards.allowlist && !guards.roleAllowlist) return names;
  return names.filter(
    (n) => listAllows(guards.allowlist, n) && listAllows(guards.roleAllowlist, n),
  );
};

export const isToolAllowed = (toolName: string, guards: KeyGuards): boolean =>
  listAllows(guards.allowlist, toolName) &&
  listAllows(guards.roleAllowlist, toolName);

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
    // Name which side refused, so the operator knows whether to edit the key or
    // the role — "not in the allowlist" alone sends people to the wrong screen.
    const source = !listAllows(guards.allowlist, toolName)
      ? "this API key's MCP allowlist"
      : "the MCP allowlist on this caller's roles";
    return {
      ok: false,
      code: "FORBIDDEN",
      message: `tool "${toolName}" is not in ${source}`,
    };
  }
  if (guards.readOnly && kind !== "read") {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: `tool "${toolName}" is a ${kind} operation; this caller is MCP read-only`,
    };
  }
  return { ok: true };
};
