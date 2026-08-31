/**
 * What bounds an agent's tool calls is a security claim, so the code, the
 * documentation and the behaviour all have to say the same thing.
 *
 * A turn re-authenticates as the USER who started it, so the permission DSL and
 * tenant scoping have always applied. What did not was the **MCP guard** layer:
 * `runner.ts` built its `ToolCtx` with `guards: { allowlist: null, readOnly:
 * false }` and called `mcpTool.handler(...)` directly, so `checkToolCall` — the
 * only place a credential's `mcpTools` allowlist and `mcpReadOnly` flag are
 * enforced — never ran. The documented residual exposure was exact: *"an
 * allowlist-scoped key holding `["agents.run"]` driving an agent whose tool
 * list is broader"*.
 *
 * That is now closed. The caller's effective guards are resolved at the seam
 * where their credential still exists (the REST message route, which the MCP
 * `agents.run` tool also reaches through an identity-forwarding sub-fetch), and
 * they travel with the turn — onto the job payload for a background turn, since
 * by then the calling key is gone.
 *
 * The tests below pin it from three sides: the behaviour with a real restricted
 * key, a CONTROL with a permissive one (without which the restricted case could
 * be passing for any other reason), and the code/doc contract.
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Captured BEFORE the mock so the restore below hands back the real bindings by
// value — `bun test` shares one module registry across files in a process.
import * as realAiClient from "../src/server/mcp/ai-client";
import { checkToolCall } from "../src/server/mcp/guards";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const realCallClaude = realAiClient.callClaude;
const realCallClaudeTools = realAiClient.callClaudeTools;
const realExtractJson = realAiClient.extractJson;

type ScriptTurn = { text?: string; toolCalls?: Array<{ name: string; args?: Record<string, unknown> }> };
let script: ScriptTurn[] = [];
let callIdx = 0;
/** The system prompt of the most recent model call, so a test can assert what
 *  the model was actually told about its own restrictions. */
let lastSystem = "";
const resetScript = (s: ScriptTurn[]) => {
  script = s;
  callIdx = 0;
};

mock.module("../src/server/mcp/ai-client", () => ({
  callClaude: realCallClaude,
  extractJson: realExtractJson,
  callClaudeTools: async (_env: unknown, opts: { system?: string }) => {
    lastSystem = opts?.system ?? "";
    const turn = script[callIdx++] ?? { text: "ok" };
    return {
      text: turn.text ?? "",
      toolCalls: (turn.toolCalls ?? []).map((c, i) => ({
        id: `call-${callIdx}-${i}`,
        name: c.name,
        args: c.args ?? {},
      })),
      usage: { input_tokens: 1, output_tokens: 2 },
    };
  },
}));

afterAll(() => {
  mock.module("../src/server/mcp/ai-client", () => ({
    callClaude: realCallClaude,
    callClaudeTools: realCallClaudeTools,
    extractJson: realExtractJson,
  }));
});

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");
const APP_URL = "http://localhost:5173";
const JSON_HEADERS = { "content-type": "application/json" };

describe("an agent is bounded by the guards of whoever started it", () => {
  let h: TestHarness;
  let agentId = "";
  /** `mcpTools: null` = the permissive legacy shape. The control. */
  let openKey = "";
  /** May start a turn and nothing else — the documented residual exposure. */
  let runOnlyKey = "";
  /** May start a turn AND reach the agent's inner tool. */
  let runPlusSchemaKey = "";

  const mintKey = async (name: string, mcpTools: string[] | null): Promise<string> => {
    const res = await h.fetch("/api/api-keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: `${name}-${Date.now()}`, mcpTools }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { secret: string } }).data.secret;
  };

  /** Drive `agents.run` over MCP with a bare Bearer key (no cookie), which is
   *  the path the exposure was described on. */
  const runAgentAsKey = async (secret: string, message: string) => {
    const res = await h.app.fetch(
      new Request(`${APP_URL}/mcp`, {
        method: "POST",
        headers: { ...JSON_HEADERS, authorization: `Bearer ${secret}`, origin: APP_URL },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          // Tenant-mount wire names are hyphenated.
          params: { name: "agents-run", arguments: { agent: agentId, message } },
        }),
      }),
    );
    const body = (await res.json()) as {
      result?: { content: { text: string }[]; isError?: boolean };
    };
    const text = body.result?.content?.[0]?.text ?? "";
    return { isError: Boolean(body.result?.isError), text };
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await h.fetch("/api/agents", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "GuardProbe",
        tools: ["schema.list_collections"],
        maxSteps: 3,
      }),
    });
    expect(created.status).toBe(201);
    agentId = ((await created.json()) as { data: { id: string } }).data.id;
    openKey = await mintKey("open", null);
    runOnlyKey = await mintKey("run-only", ["agents.*"]);
    runPlusSchemaKey = await mintKey("run-plus-schema", ["agents.*", "schema.*"]);
  });
  afterAll(() => h.cleanup());

  test("CONTROL: a permissive key's agent reaches the inner tool", async () => {
    // Without this passing, the restricted case below proves nothing — the tool
    // could be failing for any reason at all.
    resetScript([
      { toolCalls: [{ name: "schema_list_collections" }] },
      { text: "done" },
    ]);
    const { text } = await runAgentAsKey(openKey, "list the collections");
    const turn = JSON.parse(text) as { steps: { tool: string; observation: string; isError: boolean }[] };
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0]?.tool).toBe("schema.list_collections");
    expect(turn.steps[0]?.isError).toBe(false);
  });

  test("a key scoped to `agents.*` cannot reach a tool outside its allowlist THROUGH an agent", async () => {
    // The exact exposure the previous arrangement documented as residual.
    resetScript([
      { toolCalls: [{ name: "schema_list_collections" }] },
      { text: "done" },
    ]);
    const { text } = await runAgentAsKey(runOnlyKey, "list the collections");
    const turn = JSON.parse(text) as { steps: { observation: string; isError: boolean }[] };
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0]?.isError).toBe(true);
    // Narrowed out of the catalog, so the model is never offered it — and the
    // call it makes anyway resolves to nothing and does not run. The CONTROL
    // above is what makes this meaningful: same agent, same script, same tool,
    // and the only difference is the key's allowlist.
    expect(turn.steps[0]?.observation).toContain("Unknown tool");
  });

  test("a narrowed agent is told it was narrowed, rather than answering toollessly", async () => {
    // The silent shape is the dangerous one: an agent whose whole toolset was
    // filtered away answers from the model's own knowledge and reads exactly
    // like an agent that chose not to look anything up.
    resetScript([{ text: "I could not check that." }]);
    await runAgentAsKey(runOnlyKey, "list the collections");
    expect(lastSystem).toContain("not available to the person who asked");
    expect(lastSystem).toContain("permission limit");
  });

  test("an unnarrowed agent is told nothing of the sort", async () => {
    resetScript([{ text: "done" }]);
    await runAgentAsKey(openKey, "hello");
    expect(lastSystem).not.toContain("not available to the person who asked");
  });

  test("widening the key's allowlist lets the same agent through again", async () => {
    // Proves the refusal above tracks the ALLOWLIST and is not just "agents
    // can't call tools any more".
    resetScript([
      { toolCalls: [{ name: "schema_list_collections" }] },
      { text: "done" },
    ]);
    const { text } = await runAgentAsKey(runPlusSchemaKey, "list the collections");
    const turn = JSON.parse(text) as { steps: { tool: string; isError: boolean }[] };
    expect(turn.steps[0]?.tool).toBe("schema.list_collections");
    expect(turn.steps[0]?.isError).toBe(false);
  });
});

describe("the guards survive the job queue", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("an `agent.turn` payload with no guards is refused, not run unguarded", async () => {
    // A background turn re-enters on a run token that carries no key, so the
    // payload is the ONLY place the caller's restriction still exists. Defaulting
    // a missing one to unrestricted would reopen the hole for every turn queued
    // across a deploy.
    const { runQueuedAgentTurn } = await import("../src/server/services/agents/async-run");
    // No context is needed: the payload guard refuses before `ctx` is touched,
    // which is exactly the ordering this test is pinning.
    const verdict = await runQueuedAgentTurn(undefined as never, h.app as never, {
      runId: "r1",
      threadId: "t1",
      agentId: "a1",
      message: "hi",
      runAs: { userId: "u1", tenantId: "tn1" },
      origin: APP_URL,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("invalid agent.turn payload");
  });
});

describe("code and docs agree about what bounds an agent", () => {
  test("the runner gates every tool call instead of bypassing the dispatcher", () => {
    const runner = read("src/server/services/agents/runner.ts");
    // The gate itself, and the fact that the guards are the CALLER's rather
    // than a literal invented here.
    expect(runner).toContain("checkToolCall");
    expect(runner).toContain("input.auth.guards");
    expect(runner).not.toContain("guards: { allowlist: null, readOnly: false }");
  });

  test("the guards are resolved once and shared, so two surfaces cannot drift", () => {
    // The original defect was the agent path enforcing something different from
    // the MCP path. One resolver is what stops that recurring.
    const dispatch = read("src/server/mcp/dispatch.ts");
    const restRoute = read("src/server/routes/agents.ts");
    const graphql = read("src/server/services/graphql/agents.ts");
    for (const src of [dispatch, restRoute, graphql]) {
      expect(src).toContain("resolveCallerMcpGuards");
    }
  });

  test("the async payload declares the guards it carries", () => {
    const asyncRun = read("src/server/services/agents/async-run.ts");
    expect(asyncRun).toContain("guards: KeyGuards");
  });

  test("the docs state which guards apply and which do not", () => {
    const doc = read("../../docs/agents.md");
    expect(doc).toContain("as the user who started it");
    expect(doc).toContain("The caller's MCP guards");
    expect(doc).toContain("agent's own tool allowlist");
    // The consequence, spelled out — a reader who misses this scopes a key
    // believing it does not constrain the agent.
    expect(doc).toContain("intersected");
    // The operational consequence, not just the mechanism.
    expect(doc).toContain("agents.run");
  });

  test("`agents.run` is a write tool, so a read-only credential cannot start a turn", async () => {
    // Still true, and still the reason a read-only key was never the exposure.
    const { agentsTools } = await import("../src/server/mcp/tools/agents");
    const run = agentsTools.find((t) => t.name === "agents.run");
    expect(run?.kind).toBe("write");
    const readOnly = { allowlist: null, roleAllowlist: null, readOnly: true };
    expect(checkToolCall("agents.run", "write", readOnly).ok).toBe(false);
  });
});
