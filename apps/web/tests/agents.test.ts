/**
 * AI agent framework — REST CRUD, thread lifecycle, and the reason→act run loop.
 *
 * The harness never has an AI provider key, so we mock `mcp/ai-client` to script
 * the LLM turns. That lets us drive the runner deterministically (tool step →
 * final answer) and assert the persisted transcript + the error path, without
 * any network call. Bun applies `mock.module` retroactively to already-imported
 * bindings, so the runner's `callClaude` import picks up the stub.
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
// Capture the real module BEFORE mocking so the global afterAll can restore it.
// `bun test` shares one module registry across files in a process, so a leaked
// `mock.module` would otherwise break sibling suites (e.g. ai-ask's no-key path).
import * as realAiClient from "../src/server/mcp/ai-client";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const realCallClaude = realAiClient.callClaude;
const realExtractJson = realAiClient.extractJson;

/** Mutable script the mocked LLM plays back, one entry per `callClaude` call.
 *  Each entry is either a raw model reply string or an Error to throw. */
let script: Array<string | Error> = [];
let callIdx = 0;
const resetScript = (s: Array<string | Error>) => {
  script = s;
  callIdx = 0;
};

mock.module("../src/server/mcp/ai-client", () => ({
  callClaude: async () => {
    const next = script[callIdx++];
    if (next instanceof Error) throw next;
    return { text: next ?? '```json\n{"action":"final","args":{"answer":"ok"}}\n```', usage: { input_tokens: 1, output_tokens: 2 } };
  },
  // Mirror the real fenced-JSON extractor so the runner parses our scripted replies.
  extractJson: (text: string) => {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence?.[1] ?? text;
    return JSON.parse(candidate.trim());
  },
}));

// Restore the real implementations so the mock can't leak into later suites.
afterAll(() => {
  mock.module("../src/server/mcp/ai-client", () => ({
    callClaude: realCallClaude,
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

    // Script: 1) call the tool, 2) finish.
    resetScript([
      '```json\n{"thought":"I should list collections","action":"schema.list_collections","args":{}}\n```',
      '```json\n{"thought":"done","action":"final","args":{"answer":"You have some collections."}}\n```',
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
    resetScript(['```json\n{"action":"final","args":{"answer":"hi there"}}\n```']);
    const run = await h.fetch(`/api/agents/threads/${threadId}/messages`, json({ message: "hello" }));
    expect(run.status).toBe(200);
    expect(((await run.json()) as { data: { answer: string } }).data.answer).toBe("hi there");
  });

  test("empty message is rejected (422)", async () => {
    const thread = await h.fetch(`/api/agents/${agentId}/threads`, json({}));
    const threadId = ((await thread.json()) as { data: { id: string } }).data.id;
    const res = await h.fetch(`/api/agents/threads/${threadId}/messages`, json({ message: "  " }));
    expect(res.status).toBe(422);
  });
});
