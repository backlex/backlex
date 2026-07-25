/**
 * Agent chat rooms — the behaviour that only exists once a conversation can
 * host more than one agent:
 *
 *  - `@handle` routing, and the three modes for a message that names nobody;
 *  - the per-agent lock (`agent_runs`), which is what lets two agents answer
 *    the same message in parallel while stopping one agent running twice;
 *  - the async send contract (202 + run ids) and its status guard, which is
 *    what keeps a NON-idempotent turn from ever being replayed;
 *  - the detached-run token, whose whole point is that it grants no more than
 *    the user it was minted for currently has.
 *
 * Like `agents.test.ts`, the LLM is scripted — the harness has no provider key.
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import * as realAiClient from "../src/server/mcp/ai-client";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { parseMentions } from "../src/server/services/agents/mentions";
import { signAgentRunToken, verifyAgentRunToken } from "../src/server/lib/jwt";
import type { AgentRow } from "../src/server/services/agents/store";

const realCallClaude = realAiClient.callClaude;
const realCallClaudeTools = realAiClient.callClaudeTools;
const realExtractJson = realAiClient.extractJson;

/** Answers the runner gets, keyed by nothing — every turn returns one line. A
 *  room test cares about WHO ran, not what they said. */
let answer = "done";
/** Set to a number of ms to make each turn hang, so a run stays `running`. */
let stall = 0;

mock.module("../src/server/mcp/ai-client", () => ({
  callClaude: async () => ({ text: "none" }),
  extractJson: realExtractJson,
  callClaudeTools: async () => {
    if (stall) await new Promise((r) => setTimeout(r, stall));
    return {
      text: answer,
      toolCalls: [],
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

const json = (body: unknown) => ({
  method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const makeAgent = async (h: TestHarness, name: string, extra: object = {}) => {
  const res = await h.fetch("/api/agents", json({ name, tools: [], ...extra }));
  const body = (await res.json()) as { data: { id: string; handle: string } };
  return body.data;
};

const makeRoom = async (h: TestHarness, agentIds: string[], extra: object = {}) => {
  const res = await h.fetch("/api/agents/threads", json({ agentIds, ...extra }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  return body.data;
};

const say = async (h: TestHarness, roomId: string, message: string, extra: object = {}) =>
  h.fetch(`/api/agents/threads/${roomId}/messages`, json({ message, ...extra }));

describe("rooms — mention parsing", () => {
  const agent = (id: string, handle: string, active = true): AgentRow =>
    ({ id, handle, active, name: handle }) as AgentRow;
  const roster = [agent("a", "sales"), agent("b", "data-buddy"), agent("c", "paused", false)];

  test("resolves handles, in order, deduped", () => {
    expect(parseMentions("@data-buddy and @sales, then @sales again", roster)).toEqual(["b", "a"]);
  });

  test("strips trailing punctuation but not handle characters", () => {
    expect(parseMentions("hey @sales!", roster)).toEqual(["a"]);
    expect(parseMentions("(@data-buddy)", roster)).toEqual(["b"]);
  });

  test("an @ mid-word is not a mention, so emails don't fire", () => {
    expect(parseMentions("mail me at me@sales", roster)).toEqual([]);
  });

  test("unknown handles and inactive agents are ignored", () => {
    expect(parseMentions("@nobody @paused", roster)).toEqual([]);
  });
});

describe("rooms — routing", () => {
  let h: TestHarness;
  let alpha: { id: string; handle: string };
  let beta: { id: string; handle: string };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    alpha = await makeAgent(h, "Alpha");
    beta = await makeAgent(h, "Beta");
  });
  afterAll(() => h.cleanup());

  test("a handle is derived from the name and is unique per workspace", async () => {
    expect(alpha.handle).toBe("alpha");
    const twin = await makeAgent(h, "alpha");
    expect(twin.handle).not.toBe("alpha");
  });

  test("mention routing: an unaddressed message wakes nobody", async () => {
    const room = await makeRoom(h, [alpha.id, beta.id]);
    const res = await say(h, room.id, "just talking to the team");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { runs: unknown[]; messageId: string } };
    expect(body.data.runs).toEqual([]);
    // The message is still recorded — a room is usable human-to-human.
    expect(body.data.messageId).toBeTruthy();
  });

  test("a mention runs exactly that agent", async () => {
    const room = await makeRoom(h, [alpha.id, beta.id]);
    const res = await say(h, room.id, `@${beta.handle} what's up?`);
    const body = (await res.json()) as { data: { runs: { agentId: string }[] } };
    expect(body.data.runs.map((r) => r.agentId)).toEqual([beta.id]);
  });

  test("two mentions run two turns — the old thread-level lock would 409", async () => {
    const room = await makeRoom(h, [alpha.id, beta.id]);
    const res = await say(h, room.id, `@${alpha.handle} @${beta.handle} both of you`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { runs: { agentId: string }[]; turns: unknown[] };
    };
    expect(body.data.runs.map((r) => r.agentId).sort()).toEqual([alpha.id, beta.id].sort());
    expect(body.data.turns.length).toBe(2);
  });

  test("default routing answers with the room's default agent", async () => {
    const room = await makeRoom(h, [alpha.id, beta.id], {
      routing: "default",
      defaultAgentId: alpha.id,
    });
    const res = await say(h, room.id, "no mention here");
    const body = (await res.json()) as { data: { runs: { agentId: string }[] } };
    expect(body.data.runs.map((r) => r.agentId)).toEqual([alpha.id]);
  });

  test("default routing with no default chosen answers when there's only one agent", async () => {
    // The UI can't produce this (the create dialog picks one), but the API can —
    // and a room that silently answers nobody is the worst possible outcome.
    const room = await makeRoom(h, [alpha.id], { routing: "default" });
    const res = await say(h, room.id, "who's there?");
    const body = (await res.json()) as { data: { runs: { agentId: string }[] } };
    expect(body.data.runs.map((r) => r.agentId)).toEqual([alpha.id]);
  });

  test("default routing with no default and several agents stays silent", async () => {
    const room = await makeRoom(h, [alpha.id, beta.id], { routing: "default" });
    const res = await say(h, room.id, "who's there?");
    const body = (await res.json()) as { data: { runs: unknown[] } };
    // Ambiguous — guessing which of two agents was meant would be worse.
    expect(body.data.runs).toEqual([]);
  });

  test("an agent's own answer never triggers a mention — no agent-to-agent chain", async () => {
    const room = await makeRoom(h, [alpha.id, beta.id]);
    answer = `sure, @${beta.handle} should take this`;
    const res = await say(h, room.id, `@${alpha.handle} hello`);
    answer = "done";
    const body = (await res.json()) as { data: { runs: { agentId: string }[] } };
    // Only alpha ran, even though its answer mentions beta.
    expect(body.data.runs.map((r) => r.agentId)).toEqual([alpha.id]);
    const detail = (await (
      await h.fetch(`/api/agents/threads/${room.id}`)
    ).json()) as { data: { messages: { role: string; agentId?: string | null }[] } };
    const assistants = detail.data.messages.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    expect(assistants[0]?.agentId).toBe(alpha.id);
  });

  test("assistant rows are attributed, so a transcript can render bylines", async () => {
    const room = await makeRoom(h, [alpha.id, beta.id]);
    await say(h, room.id, `@${alpha.handle} one`);
    await say(h, room.id, `@${beta.handle} two`);
    const detail = (await (
      await h.fetch(`/api/agents/threads/${room.id}`)
    ).json()) as { data: { messages: { role: string; agentId?: string | null }[] } };
    const byAgent = detail.data.messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.agentId);
    expect(byAgent).toEqual([alpha.id, beta.id]);
  });

  test("naming an agent that isn't in the room is rejected", async () => {
    const room = await makeRoom(h, [alpha.id]);
    const res = await say(h, room.id, "hi", { agentIds: [beta.id] });
    expect(res.status).toBe(422);
  });
});

describe("rooms — membership + settings", () => {
  let h: TestHarness;
  let alpha: { id: string; handle: string };
  let beta: { id: string; handle: string };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    alpha = await makeAgent(h, "Alpha");
    beta = await makeAgent(h, "Beta");
  });
  afterAll(() => h.cleanup());

  test("add / remove an agent, and the room list carries participants", async () => {
    const room = await makeRoom(h, [alpha.id]);
    await h.fetch(`/api/agents/threads/${room.id}/agents`, json({ agentId: beta.id }));
    // Idempotent — a second add is not an error and doesn't duplicate.
    await h.fetch(`/api/agents/threads/${room.id}/agents`, json({ agentId: beta.id }));
    let list = (await (await h.fetch("/api/agents/threads")).json()) as {
      data: { id: string; agentIds: string[] }[];
    };
    expect(list.data.find((r) => r.id === room.id)?.agentIds.sort()).toEqual(
      [alpha.id, beta.id].sort(),
    );

    await h.fetch(`/api/agents/threads/${room.id}/agents/${beta.id}`, { method: "DELETE" });
    list = (await (await h.fetch("/api/agents/threads")).json()) as {
      data: { id: string; agentIds: string[] }[];
    };
    expect(list.data.find((r) => r.id === room.id)?.agentIds).toEqual([alpha.id]);
  });

  test("routing mode is validated", async () => {
    const room = await makeRoom(h, [alpha.id]);
    const bad = await h.fetch(`/api/agents/threads/${room.id}`, {
      ...json({ routing: "telepathy" }),
      method: "PATCH",
    });
    expect(bad.status).toBe(422);
  });

  test("a thread opened against one agent still answers every message", async () => {
    // The pre-rooms shape, which `POST /agents/:id/threads` and every non-admin
    // surface still use. It must keep working without a mention.
    const created = await h.fetch(`/api/agents/${alpha.id}/threads`, json({}));
    const { data: thread } = (await created.json()) as { data: { id: string } };
    const res = await say(h, thread.id, "no mention");
    const body = (await res.json()) as { data: { answer: string; runs: { agentId: string }[] } };
    expect(body.data.runs.map((r) => r.agentId)).toEqual([alpha.id]);
    expect(body.data.answer).toBe("done");
  });
});

describe("rooms — the per-agent lock", () => {
  let h: TestHarness;
  let alpha: { id: string; handle: string };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    alpha = await makeAgent(h, "Alpha");
  });
  afterAll(() => {
    stall = 0;
    h.cleanup();
  });

  test("the same agent can't run twice at once (409), and recovers after", async () => {
    const room = await makeRoom(h, [alpha.id]);
    stall = 150;
    const first = say(h, room.id, `@${alpha.handle} slow one`);
    // Give the first turn time to claim its run before the second arrives.
    await new Promise((r) => setTimeout(r, 40));
    const second = await say(h, room.id, `@${alpha.handle} quick one`);
    expect(second.status).toBe(409);

    await first;
    stall = 0;
    // Lock released — the next message runs normally.
    const third = await say(h, room.id, `@${alpha.handle} after`);
    expect(third.status).toBe(200);
  });
});

describe("rooms — async sends", () => {
  let h: TestHarness;
  let alpha: { id: string; handle: string };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    alpha = await makeAgent(h, "Alpha");
  });
  afterAll(() => h.cleanup());

  test("returns 202 with run ids and no answer, then the run completes", async () => {
    const room = await makeRoom(h, [alpha.id]);
    const res = await say(h, room.id, `@${alpha.handle} go`, { async: true });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      data: { runs: { runId: string; agentId: string }[]; messageId: string };
    };
    expect(body.data.runs.length).toBe(1);
    const runId = body.data.runs[0]!.runId;

    // The turn runs in the background; poll the run until it settles.
    let status = "";
    for (let i = 0; i < 40 && status !== "done" && status !== "error"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const run = (await (await h.fetch(`/api/agents/runs/${runId}`)).json()) as {
        data: { status: string };
      };
      status = run.data.status;
    }
    expect(status).toBe("done");

    const detail = (await (
      await h.fetch(`/api/agents/threads/${room.id}`)
    ).json()) as { data: { messages: { role: string; content: string }[] } };
    expect(detail.data.messages.some((m) => m.role === "assistant" && m.content === "done")).toBe(
      true,
    );
  });

  test("a queued turn is never replayed once it has started", async () => {
    // The guard that makes a NON-idempotent turn safe to enqueue: the worker
    // only ever runs a run it finds `queued`. Anything else is failed, not redone.
    const { runQueuedAgentTurn } = await import("../src/server/services/agents/async-run");
    const room = await makeRoom(h, [alpha.id]);
    const res = await say(h, room.id, `@${alpha.handle} once`, { async: true });
    const body = (await res.json()) as { data: { runs: { runId: string }[] } };
    const runId = body.data.runs[0]!.runId;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const run = (await (await h.fetch(`/api/agents/runs/${runId}`)).json()) as {
        data: { status: string };
      };
      if (run.data.status === "done") break;
    }
    const before = (await (
      await h.fetch(`/api/agents/threads/${room.id}`)
    ).json()) as { data: { messages: unknown[] } };

    // Replaying the same payload (what a scheduled tick would do for a job whose
    // isolate died) must refuse rather than run the turn a second time.
    const me = (await (await h.fetch("/api/me")).json()) as {
      data: { id: string; tenantId?: string | null };
    };
    const ctx = await buildContext(h.env);
    const out = await runQueuedAgentTurn(ctx, h.app as never, {
      runId,
      threadId: room.id,
      agentId: alpha.id,
      message: "once",
      runAs: { userId: me.data.id, tenantId: me.data.tenantId ?? "" },
      origin: "http://localhost",
    });
    expect(out.ok).toBe(false);
    const after = (await (
      await h.fetch(`/api/agents/threads/${room.id}`)
    ).json()) as { data: { messages: unknown[] } };
    expect(after.data.messages.length).toBe(before.data.messages.length);
  });
});

describe("rooms — the detached run token", () => {
  test("round-trips, and is rejected once expired or tampered with", async () => {
    const secret = "test-secret";
    const token = await signAgentRunToken(secret, { sub: "u1", tid: "t1", rid: "r1" });
    const claims = await verifyAgentRunToken(secret, token);
    expect(claims?.sub).toBe("u1");
    expect(claims?.tid).toBe("t1");

    expect(await verifyAgentRunToken("other-secret", token)).toBeNull();
    const expired = await signAgentRunToken(secret, { sub: "u1", tid: "t1", rid: "r1" }, -1);
    expect(await verifyAgentRunToken(secret, expired)).toBeNull();
  });

  test("carries no roles — authorisation has to come from the DB", async () => {
    // The reason a detached turn can't outlive its caller's access: nothing in
    // the token says what the user may do, so every sub-request re-resolves it.
    const token = await signAgentRunToken("s", { sub: "u1", tid: "t1", rid: "r1" });
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(payload.roles).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "rid", "sub", "tid", "typ"]);
  });
});
