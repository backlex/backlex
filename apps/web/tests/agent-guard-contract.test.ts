/**
 * What bounds an agent's tool calls is a security claim, so the code and the
 * documentation have to say the same thing. They did not.
 *
 * `docs/agents.md` used to state that "the permission DSL, tenant scoping, and
 * per-key guards all apply" to every tool call an agent makes. The first two
 * hold — tool calls re-enter through `fetchInternal`, which re-resolves roles
 * from the database per sub-request. The third did not: `runner.ts` builds its
 * `ToolCtx` with `guards: { allowlist: null, readOnly: false }` and invokes
 * `mcpTool.handler(...)` directly, so `mcp/dispatch.ts`'s `checkToolCall` — the
 * only place a key's `mcpTools` allowlist and `mcpReadOnly` flag are enforced —
 * never runs.
 *
 * That is a defensible design: a turn authenticates as the starting USER (see
 * `services/agents/async-run.ts`), and a key's guards narrow what that KEY may
 * call directly over MCP. The agent's own admin-authored tool list is the
 * boundary. What was not defensible was the docs promising the other thing.
 *
 * These tests pin the arrangement from both ends. If someone later enforces key
 * guards inside the runner — a real option, and a bigger change than it looks,
 * since the async path would have to persist the guards on the job payload —
 * these fail and the documented caution has to be rewritten in the same commit.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolCall } from "../src/server/mcp/guards";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

describe("agent tool guards — code and docs agree", () => {
  test("the runner dispatches tools with guards deliberately unrestricted", () => {
    const runner = read("src/server/services/agents/runner.ts");
    // The literal, not a paraphrase: this is the line the docs describe.
    expect(runner).toContain("guards: { allowlist: null, readOnly: false }");
    // And it reaches the handler directly rather than through the dispatcher,
    // which is what makes the guards moot in the first place.
    expect(runner).toContain("mcpTool.handler(call.args, toolCtx)");
    expect(runner).not.toContain("checkToolCall");
  });

  test("the docs do NOT claim per-key guards bound an agent", () => {
    const doc = read("../../docs/agents.md");
    expect(doc).not.toContain("per-key guards all apply");
  });

  test("the docs say what actually bounds an agent, and name the consequence", () => {
    const doc = read("../../docs/agents.md");
    // The user/key distinction is the whole point — a reader who misses it
    // scopes an API key believing it constrains the agent.
    expect(doc).toContain("as the user who started it");
    expect(doc).toContain("mcpReadOnly");
    expect(doc).toContain("own tool allow-list");
    // The operational consequence, not just the mechanism.
    expect(doc).toContain("agents.run");
  });

  test("`agents.run` is a write tool, so a read-only key cannot start a turn", async () => {
    // The one guard that DOES still bite, and the reason the residual exposure
    // is an allowlist-scoped key rather than every key.
    const { agentsTools } = await import("../src/server/mcp/tools/agents");
    const run = agentsTools.find((t) => t.name === "agents.run");
    expect(run).toBeDefined();
    expect(run?.kind).toBe("write");

    const readOnly = { allowlist: null, roleAllowlist: null, readOnly: true };
    const verdict = checkToolCall("agents.run", "write", readOnly);
    expect(verdict.ok).toBe(false);
  });
});
