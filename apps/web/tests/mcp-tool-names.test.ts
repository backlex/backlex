/**
 * Tool-name wire-format guard. An OAuth-connected claude.ai custom connector
 * (and the Anthropic tool contract) validate every exposed tool name against
 * `^[a-zA-Z0-9_-]{1,64}$` — which rejects the dot our ids use. dispatch.ts
 * substitutes `.`→`-` on the tenant wire and back on tools/call. These tests
 * pin the two invariants that keep that substitution lossless, and would fire
 * the moment a new tool id breaks them.
 */
import { describe, expect, test } from "bun:test";
import { allTools } from "../src/server/mcp/tools";
import { fromWireToolName, toWireToolName } from "../src/server/mcp/wire-names";

const CLIENT_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const canonicalNames = new Set(allTools.map((t) => t.name));

describe("MCP tool-name wire format", () => {
  test("every canonical id survives → wire → back unchanged", () => {
    for (const t of allTools) {
      const wire = toWireToolName(t.name);
      expect(fromWireToolName(wire, canonicalNames)).toBe(t.name);
    }
  });

  test("no canonical id contains a hyphen (else the mapping is ambiguous)", () => {
    const offenders = allTools.filter((t) => t.name.includes("-")).map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  test("every wire name matches the strict client pattern", () => {
    const bad = allTools
      .map((t) => toWireToolName(t.name))
      .filter((n) => !CLIENT_PATTERN.test(n));
    expect(bad).toEqual([]);
  });

  test("wire substitution is collision-free (stays a bijection)", () => {
    const wire = allTools.map((t) => toWireToolName(t.name));
    expect(new Set(wire).size).toBe(allTools.length);
  });

  test("fromWireToolName accepts a canonical dotted name directly", () => {
    // Clients that never needed the substitution (Claude Desktop sanitizes
    // names itself) may call with the dotted id — it must resolve unchanged.
    const dotted = allTools[0]!.name;
    expect(fromWireToolName(dotted, canonicalNames)).toBe(dotted);
  });

  test("an unknown wire name is returned verbatim (drives a clear error)", () => {
    expect(fromWireToolName("does-not-exist", canonicalNames)).toBe("does-not-exist");
  });
});
