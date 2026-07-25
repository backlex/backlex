/**
 * AI agent framework — REST CRUD, thread lifecycle, and the native tool-calling
 * run loop.
 *
 * The harness never has an AI provider key, so we mock `mcp/ai-client` to script
 * the LLM turns. Each scripted turn is either a set of tool calls or a final
 * answer, mirroring `callClaudeTools`'s shape, so we drive the runner
 * deterministically (tool step → final answer) and assert the persisted
 * transcript + the error path without any network call. Bun applies
 * `mock.module` retroactively to already-imported bindings, so the runner's
 * `callClaudeTools` import picks up the stub. Native tool names are sanitized
 * (dots → underscores), so scripted tool calls use the underscore form.
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
// Capture the real module BEFORE mocking so the global afterAll can restore it.
// `bun test` shares one module registry across files in a process, so a leaked
// `mock.module` would otherwise break sibling suites (e.g. ai-ask's no-key path).
import * as realAiClient from "../src/server/mcp/ai-client";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const realCallClaude = realAiClient.callClaude;
const realCallClaudeTools = realAiClient.callClaudeTools;
const realExtractJson = realAiClient.extractJson;

/** One scripted model turn: tool calls to make, or plain text (final answer),
 *  or an Error to throw. */
type ScriptTurn =
  | { text?: string; toolCalls?: Array<{ name: string; args?: Record<string, unknown> }> }
  | Error;

/** Mutable script the mocked LLM plays back, one entry per `callClaudeTools` call. */
let script: ScriptTurn[] = [];
let callIdx = 0;
const resetScript = (s: ScriptTurn[]) => {
  script = s;
  callIdx = 0;
};

mock.module("../src/server/mcp/ai-client", () => ({
  callClaude: realCallClaude,
  extractJson: realExtractJson,
  callClaudeTools: async () => {
    const next = script[callIdx++];
    if (next instanceof Error) throw next;
    const turn = next ?? { text: "ok" };
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

// Restore the real implementations so the mock can't leak into later suites.
afterAll(() => {
  mock.module("../src/server/mcp/ai-client", () => ({
    callClaude: realCallClaude,
    callClaudeTools: realCallClaudeTools,
    extractJson: realExtractJson,
  }));
});

const json = (body: unknown) => ({
  method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("agents — CRUD + validation", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("create → list → get → patch → delete", async () => {
    const created = await h.fetch(
      "/api/agents",
      json({ name: "Support Bot", systemPrompt: "Be helpful.", tools: ["schema.list_collections"] }),
    );
    expect(created.status).toBe(201);
    const { data: agent } = (await created.json()) as { data: { id: string; name: string; tools: string[] } };
    expect(agent.name).toBe("Support Bot");
    expect(agent.tools).toEqual(["schema.list_collections"]);

    const list = await h.fetch("/api/agents");
    const { data: agents } = (await list.json()) as { data: unknown[] };
    expect(agents.length).toBe(1);

    const got = await h.fetch(`/api/agents/${agent.id}`);
    expect(got.status).toBe(200);

    const patched = await h.fetch(`/api/agents/${agent.id}`, {
      ...json({ maxSteps: 3 }),
      method: "PATCH",
    });
    expect(patched.status).toBe(200);
    const reget = (await (await h.fetch(`/api/agents/${agent.id}`)).json()) as { data: { maxSteps: number } };
    expect(reget.data.maxSteps).toBe(3);

    const del = await h.fetch(`/api/agents/${agent.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = (await (await h.fetch("/api/agents")).json()) as { data: unknown[] };
    expect(after.data.length).toBe(0);
  });

  test("unknown tool name is rejected at create time (422)", async () => {
    const res = await h.fetch("/api/agents", json({ name: "Bad", tools: ["not.a.real.tool"] }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("VALIDATION");
    expect(body.error?.message).toContain("not.a.real.tool");
  });

  test("name is required (422)", async () => {
    const res = await h.fetch("/api/agents", json({ systemPrompt: "x" }));
    expect(res.status).toBe(422);
  });

  test("memory flag round-trips and defaults to false", async () => {
    const off = await h.fetch("/api/agents", json({ name: "NoMem" }));
    expect(((await off.json()) as { data: { memory: boolean } }).data.memory).toBe(false);
    const on = await h.fetch("/api/agents", json({ name: "WithMem", memory: true }));
    expect(((await on.json()) as { data: { memory: boolean } }).data.memory).toBe(true);
  });
});

describe("agents — run loop", () => {
  let h: TestHarness;
  let agentId: string;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/agents",
      json({ name: "Runner", tools: ["schema.list_collections"], maxSteps: 5 }),
    );
    agentId = ((await res.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("tool step then final answer is persisted as a transcript", async () => {
    const thread = await h.fetch(`/api/agents/${agentId}/threads`, json({ title: "T1" }));
    expect(thread.status).toBe(201);
    const threadId = ((await thread.json()) as { data: { id: string } }).data.id;

    // Script: 1) call the tool, 2) finish. Native tool name is underscored.
    resetScript([
      { text: "I should list collections", toolCalls: [{ name: "schema_list_collections", args: {} }] },
      { text: "You have some collections." },
    ]);

    const run = await h.fetch(`/api/agents/threads/${threadId}/messages`, json({ message: "what collections exist?" }));
    expect(run.status).toBe(200);
    const { data } = (await run.json()) as {
      data: { answer: string; steps: unknown[]; stoppedReason: string };
    };
    expect(data.stoppedReason).toBe("final");
    expect(data.answer).toBe("You have some collections.");
    expect(data.steps.length).toBe(1);

    // Transcript persisted: user, assistant(tool), tool(observation), assistant(final).
    const detail = await h.fetch(`/api/agents/threads/${threadId}`);
    const body = (await detail.json()) as {
      data: { thread: { status: string }; messages: Array<{ role: string; toolName: string | null }> };
    };
    expect(body.data.thread.status).toBe("idle");
    expect(body.data.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(body.data.messages[1]?.toolName).toBe("schema.list_collections");
  });

  test("provider failure surfaces as 5xx and marks the thread errored", async () => {
    const thread = await h.fetch(`/api/agents/${agentId}/threads`, json({}));
    const threadId = ((await thread.json()) as { data: { id: string } }).data.id;
    resetScript([new Error("provider down")]);
    const run = await h.fetch(`/api/agents/threads/${threadId}/messages`, json({ message: "hi" }));
    expect(run.status).toBeGreaterThanOrEqual(500);
    const detail = (await (await h.fetch(`/api/agents/threads/${threadId}`)).json()) as {
      data: { thread: { status: string } };
    };
    expect(detail.data.thread.status).toBe("error");
  });

  test("memory-enabled agent still completes a turn (best-effort no-op without provider)", async () => {
    const res = await h.fetch(
      "/api/agents",
      json({ name: "MemRunner", tools: [], memory: true, maxSteps: 3 }),
    );
    const memAgentId = ((await res.json()) as { data: { id: string } }).data.id;
    const thread = await h.fetch(`/api/agents/${memAgentId}/threads`, json({}));
    const threadId = ((await thread.json()) as { data: { id: string } }).data.id;
    resetScript([{ text: "hi there" }]);
    const run = await h.fetch(`/api/agents/threads/${threadId}/messages`, json({ message: "hello" }));
    expect(run.status).toBe(200);
    expect(((await run.json()) as { data: { answer: string } }).data.answer).toBe("hi there");
  });

  test("effort round-trips and rejects an unknown level", async () => {
    const created = await h.fetch(
      "/api/agents",
      json({ name: `Effort ${Date.now()}`, tools: [], effort: "low" }),
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string; effort: string | null } })
      .data.id;

    const read = (await (await h.fetch(`/api/agents/${id}`)).json()) as {
      data: { effort: string | null };
    };
    expect(read.data.effort).toBe("low");

    // Explicit null clears it back to the provider default.
    expect(
      (await h.fetch(`/api/agents/${id}`, { ...json({ effort: null }), method: "PATCH" }))
        .status,
    ).toBe(200);
    expect(
      (
        (await (await h.fetch(`/api/agents/${id}`)).json()) as {
          data: { effort: string | null };
        }
      ).data.effort,
    ).toBeNull();

    const bad = await h.fetch(`/api/agents/${id}`, {
      ...json({ effort: "turbo" }),
      method: "PATCH",
    });
    expect(bad.status).toBe(422);
  });

  test("an untitled thread is named after its opening prompt", async () => {
    const thread = await h.fetch(`/api/agents/${agentId}/threads`, json({}));
    const threadId = ((await thread.json()) as { data: { id: string } }).data.id;
    const prompt =
      "Summarize the top products by revenue this month\nand say what changed versus last month";
    resetScript([{ text: "ok" }]);
    expect(
      (await h.fetch(`/api/agents/threads/${threadId}/messages`, json({ message: prompt }))).status,
    ).toBe(200);

    const list = (await (await h.fetch(`/api/agents/${agentId}/threads`)).json()) as {
      data: Array<{ id: string; title: string | null }>;
    };
    const row = list.data.find((x) => x.id === threadId);
    // Single line, clipped — never the raw uuid.
    expect(row?.title).toBe("Summarize the top products by revenue this month and say what c…");
    expect(row?.title).not.toContain("\n");

    // A second turn must not re-title the thread.
    resetScript([{ text: "ok" }]);
    await h.fetch(`/api/agents/threads/${threadId}/messages`, json({ message: "and last week?" }));
    const after = (await (await h.fetch(`/api/agents/${agentId}/threads`)).json()) as {
      data: Array<{ id: string; title: string | null }>;
    };
    expect(after.data.find((x) => x.id === threadId)?.title).toBe(row?.title);
  });

  test("an explicit title survives the first turn", async () => {
    const thread = await h.fetch(`/api/agents/${agentId}/threads`, json({ title: "Pinned" }));
    const threadId = ((await thread.json()) as { data: { id: string } }).data.id;
    resetScript([{ text: "ok" }]);
    await h.fetch(`/api/agents/threads/${threadId}/messages`, json({ message: "anything" }));
    const list = (await (await h.fetch(`/api/agents/${agentId}/threads`)).json()) as {
      data: Array<{ id: string; title: string | null }>;
    };
    expect(list.data.find((x) => x.id === threadId)?.title).toBe("Pinned");
  });

  test("empty message is rejected (422)", async () => {
    const thread = await h.fetch(`/api/agents/${agentId}/threads`, json({}));
    const threadId = ((await thread.json()) as { data: { id: string } }).data.id;
    const res = await h.fetch(`/api/agents/threads/${threadId}/messages`, json({ message: "  " }));
    expect(res.status).toBe(422);
  });
});
