/**
 * Team agent chat — author attribution on the transcript, and the gate +
 * presence protocol on the `agent:thread:<id>` channel.
 *
 * The channel matters as much as the data here: it carries the questions, the
 * tool observations, and the answer, and it used to fall through to the
 * free-form (unauthenticated) branch of the realtime gate.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
// Same stub-the-model pattern as agents.test.ts — capture the real module first
// so the mock can't leak into sibling suites sharing the module registry.
import * as realAiClient from "../src/server/mcp/ai-client";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const realCallClaude = realAiClient.callClaude;
const realCallClaudeTools = realAiClient.callClaudeTools;
const realExtractJson = realAiClient.extractJson;

let script: Array<{ text?: string }> = [];
let callIdx = 0;
const resetScript = (s: Array<{ text?: string }>) => {
  script = s;
  callIdx = 0;
};

mock.module("../src/server/mcp/ai-client", () => ({
  callClaude: realCallClaude,
  extractJson: realExtractJson,
  callClaudeTools: async () => ({
    text: script[callIdx++]?.text ?? "ok",
    toolCalls: [],
    usage: { input_tokens: 1, output_tokens: 2 },
  }),
}));

afterAll(() => {
  mock.module("../src/server/mcp/ai-client", () => ({
    callClaude: realCallClaude,
    callClaudeTools: realCallClaudeTools,
    extractJson: realExtractJson,
  }));
});

describe("team agent chat", () => {
  let h: TestHarness;
  let adminCookie = "";
  let adminId = "";
  let agentId = "";
  let threadId = "";

  const request = (path: string, init: RequestInit = {}, cookie?: string) => {
    const headers = new Headers(init.headers ?? {});
    headers.set("Origin", "http://localhost:5173");
    if (cookie) headers.set("Cookie", cookie);
    return h.app.fetch(new Request(`http://localhost:5173${path}`, { ...init, headers }));
  };

  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    adminCookie = Object.entries(h.cookies())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const session = await h.fetch("/api/auth/get-session");
    adminId = ((await session.json()) as { user?: { id?: string } }).user?.id ?? "";
    expect(adminId).not.toBe("");

    const agent = await h.fetch("/api/agents", json({ name: "TeamBot", tools: [] }));
    agentId = ((await agent.json()) as { data: { id: string } }).data.id;
    const thread = await h.fetch(`/api/agents/${agentId}/threads`, json({}));
    threadId = ((await thread.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("a user message records its author, and the transcript ships the people", async () => {
    resetScript([{ text: "done" }]);
    expect(
      (await h.fetch(`/api/agents/threads/${threadId}/messages`, json({ message: "who am i?" })))
        .status,
    ).toBe(200);

    const detail = (await (await h.fetch(`/api/agents/threads/${threadId}`)).json()) as {
      data: {
        messages: Array<{ role: string; userId: string | null }>;
        authors: Array<{ id: string; email: string | null }>;
      };
    };
    const user = detail.data.messages.find((m) => m.role === "user");
    expect(user?.userId).toBe(adminId);
    // Assistant rows stay unattributed — they're the agent's, not a person's.
    expect(detail.data.messages.find((m) => m.role === "assistant")?.userId ?? null).toBeNull();
    expect(detail.data.authors.some((a) => a.id === adminId && !!a.email)).toBe(true);
  });

  test("a teammate's later message doesn't rename the conversation", async () => {
    // A thread from before titles existed has none stored; the next turn must
    // still name it after how the conversation STARTED, not after that turn.
    const legacy = await h.fetch(`/api/agents/${agentId}/threads`, json({}));
    const legacyId = ((await legacy.json()) as { data: { id: string } }).data.id;
    resetScript([{ text: "a" }, { text: "b" }]);
    await h.fetch(`/api/agents/threads/${legacyId}/messages`, json({ message: "first question" }));
    const raw = new Database(h.env.SQLITE_PATH!, { readwrite: true });
    raw.run("UPDATE agent_threads SET title = NULL WHERE id = ?", [legacyId]);
    raw.close();
    await h.fetch(`/api/agents/threads/${legacyId}/messages`, json({ message: "follow-up" }));

    const list = (await (await h.fetch(`/api/agents/${agentId}/threads`)).json()) as {
      data: Array<{ id: string; title: string | null }>;
    };
    expect(list.data.find((x) => x.id === legacyId)?.title).toBe("first question");
  });

  test("the thread channel requires a session", async () => {
    const res = await request(
      `/api/realtime/${encodeURIComponent(`agent:thread:${threadId}`)}/subscribe`,
    );
    expect(res.status).toBe(401);
  });

  test("a non-admin can't listen in on an agent thread", async () => {
    const su = await request(
      "/api/auth/sign-up/email",
      json({
        email: `bystander-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        name: "Bystander",
      }),
    );
    expect(su.ok).toBe(true);
    const cookies = (su.headers.getSetCookie?.() ?? []).map((sc) => sc.split(";")[0]!).join("; ");
    const res = await request(
      `/api/realtime/${encodeURIComponent(`agent:thread:${threadId}`)}/subscribe`,
      {},
      cookies,
    );
    expect(res.status).toBe(403);
  });

  test("an unknown thread id is a 404, not an open channel", async () => {
    const res = await request(
      `/api/realtime/${encodeURIComponent("agent:thread:does-not-exist")}/subscribe`,
      {},
      adminCookie,
    );
    expect(res.status).toBe(404);
  });

  test("only presence frames may be published, and identity is server-stamped", async () => {
    const publish = (body: unknown) =>
      request(
        `/api/realtime/${encodeURIComponent(`agent:thread:${threadId}`)}/publish`,
        json(body),
        adminCookie,
      );

    // A forged turn event must not be forwardable.
    expect((await publish({ event: "agent.final", data: { answer: "trust me" } })).status).toBe(422);
    expect((await publish({ t: "shout" })).status).toBe(422);
    // Client-supplied identity is rejected by the strict schema.
    expect((await publish({ t: "hello", user: { id: "someone-else" } })).status).toBe(422);
    expect((await publish({ t: "hello" })).status).toBe(200);
  });
});
