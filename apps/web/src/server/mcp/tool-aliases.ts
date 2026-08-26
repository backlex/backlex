/**
 * Retired MCP tool ids, kept resolvable.
 *
 * REST and the SDK agree on a verb for each of these operations; MCP had
 * picked a different one, so the same call was `flows.run()` in the SDK,
 * `POST /api/flows/{id}/run` over REST, and `flows.invoke` over MCP. The MCP
 * tool list is the most *discoverable* of the three — it is enumerated in full,
 * with descriptions, wherever an agent is connected — so writing the SDK from
 * those names produced four `is not a function` failures in a row.
 *
 * Only two of those four were MCP's to fix, and reading the CLI is what settled
 * which: `flows run` and `documents save` are what every other surface calls
 * them, so `flows.invoke` and `documents.templates_save` were MCP alone. But
 * `approvals request` and `signatures send` are ALSO the CLI's subcommands and
 * the domain's own verbs — there the SDK is the odd one out, and the fix
 * belongs on that side (it gained `request` / `send` aliases beside `create`).
 * Renaming MCP to match the SDK there would have moved the divergence rather
 * than closed it.
 *
 * Renaming alone would be a breaking change, and not only for callers: a
 * per-key `mcpTools` allowlist stores the id it was granted, so a rename would
 * silently narrow every key that had named one of these. The old ids therefore
 * keep resolving — on `tools/call` and in an allowlist check — while
 * `tools/list` advertises only the canonical one, so the list does not double
 * and nobody learns the retired spelling from us.
 */

/** Retired id → the canonical id it now means. */
export const RETIRED_TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["flows.invoke", "flows.run"],
  ["documents.templates_save", "documents.save"],
]);

/**
 * Resolve a possibly-retired tool id to its canonical form.
 *
 * Applied after wire-name conversion, so it sees dotted ids, and applied to
 * allowlist entries too — a key granted `flows.invoke` still authorises
 * `flows.run`, because it is the same capability under a new spelling.
 */
export const resolveToolAlias = (name: string): string =>
  RETIRED_TOOL_ALIASES.get(name) ?? name;
