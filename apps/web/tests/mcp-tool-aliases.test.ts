/**
 * The same operation had a different verb on each surface.
 *
 * Writing a capability sweep from the MCP tool list — the most *discoverable*
 * surface, since it is enumerated in full wherever an agent is connected —
 * produced four `is not a function` failures against the SDK in a row:
 * `flows.invoke`, `approvals.request`, `signatures.send`,
 * `documents.templates_save`. The MCP names are arguably the better English,
 * which is what makes the divergence easy to trust and hard to notice.
 *
 * Reading the CLI is what decided the direction, and it splits the four in two:
 *
 *   flows      REST `…/run`  SDK `run`     CLI `flows run`         MCP `invoke` ← MCP alone
 *   documents  REST `PUT`    SDK `save`    CLI `documents save`    MCP `templates_save` ← MCP alone
 *   approvals  REST `POST`   SDK `create`  CLI `approvals request` MCP `request` ← SDK alone
 *   signatures REST `POST`   SDK `create`  CLI `signatures send`   MCP `send`    ← SDK alone
 *
 * So MCP moved on the first two and the SDK gained aliases on the last two.
 * Renaming MCP to `create` everywhere would have moved the divergence rather
 * than closing it, and would have argued with both the CLI and the domain.
 *
 * The half that matters most here is the compatibility half: a per-key
 * `mcpTools` allowlist stores the id it was GRANTED, so a rename silently
 * narrows every key that named the old spelling — the key keeps working for
 * everything else and loses exactly one capability, with nothing to say why.
 */
import { describe, expect, test } from "bun:test";
import { RETIRED_TOOL_ALIASES, resolveToolAlias } from "../src/server/mcp/tool-aliases";
import { matchesPattern } from "../src/server/mcp/guards";
import { allTools } from "../src/server/mcp/tools";

const names = (): Set<string> => new Set(allTools.map((t) => t.name));

describe("MCP tool ids match what the other surfaces call the same operation", () => {
  test("the canonical verbs are the ones exposed", () => {
    const n = names();
    expect(n.has("flows.run")).toBe(true);
    expect(n.has("documents.save")).toBe(true);
    // …and the two where MCP agrees with the CLI are untouched.
    expect(n.has("approvals.request")).toBe(true);
    expect(n.has("signatures.send")).toBe(true);
  });

  test("a retired id is no longer advertised", () => {
    // `tools/list` must not teach the old spelling, or the list doubles and
    // an agent learns a name we are trying to retire.
    const n = names();
    for (const retired of RETIRED_TOOL_ALIASES.keys()) {
      expect(n.has(retired)).toBe(false);
    }
  });

  test("every retired id still resolves to a tool that exists", () => {
    const n = names();
    for (const [retired, canonical] of RETIRED_TOOL_ALIASES) {
      expect(resolveToolAlias(retired)).toBe(canonical);
      expect(n.has(canonical)).toBe(true);
    }
  });

  test("an unknown name is passed through untouched", () => {
    // So the caller sees their own name in the "unknown tool" error rather
    // than something we rewrote it into.
    expect(resolveToolAlias("collections.read")).toBe("collections.read");
    expect(resolveToolAlias("not.a.tool")).toBe("not.a.tool");
  });

  test("a key granted the retired id keeps the capability", () => {
    // This is the regression that a plain rename would have shipped.
    expect(matchesPattern("flows.invoke", "flows.run")).toBe(true);
    expect(matchesPattern("documents.templates_save", "documents.save")).toBe(true);
    // The alias does not widen anything else.
    expect(matchesPattern("flows.invoke", "flows.delete")).toBe(false);
    expect(matchesPattern("flows.invoke", "collections.read")).toBe(false);
  });

  test("namespace globs are unaffected", () => {
    expect(matchesPattern("flows.*", "flows.run")).toBe(true);
    expect(matchesPattern("flows.*", "flows_admin.run")).toBe(false);
    expect(matchesPattern("*", "anything.at.all")).toBe(true);
  });
});
