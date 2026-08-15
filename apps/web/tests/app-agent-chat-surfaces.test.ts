import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BacklexError, createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * The SDK half of end-user agent chat — `client.agentChat.*` against
 * `/api/t/:slug/agents`.
 *
 * REST is pinned by `app-agents-public.test.ts`. What this file adds is that an
 * APPLICATION can reach the surface, which is the whole point of the feature:
 * wave 19's finding was that an AI agent could do more with a workspace than
 * the customer's own app could, and shipping an app-facing route with no client
 * would have re-created exactly that.
 *
 * The two properties worth pinning through the client rather than the route:
 *
 *   1. the guards survive the trip — an agent the operator did not open is
 *      absent, and another end user's thread is not readable;
 *   2. `agentChat` is app-mode only, and says so *before* sending anything. An
 *      admin-mode client has no workspace to address, and a method that
 *      silently built `/api/t/undefined/...` would fail as a 404 that reads
 *      like a missing agent.
 *
 * Turns are deliberately not run: that needs a live provider, and the gate is
 * what is under test, not the model. Every assertion below lands before any
 * generation would start.
 */

const JSON_HEADERS = { "content-type": "application/json" };

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** Admin-invite an end user and accept it, returning their session token. */
const makeEndUser = async (h: TestHarness, email: string) => {
  const invited = await h.fetch("/api/app-users/invite", json("POST", { email }));
  expect(invited.status).toBe(201);
  const { data } = (await invited.json()) as { data: { id: string; token: string } };
  const accepted = await h.app.request(
    "/api/t/default/auth/invite/accept",
    json("POST", { token: data.token, password: "agent-chat-pass-12345" }),
  );
  expect(accepted.status).toBe(200);
  return { id: data.id, token: ((await accepted.json()) as { token: string }).token };
};

const makeAgent = async (h: TestHarness, name: string, appAccess: boolean) => {
  const res = await h.fetch(
    "/api/agents",
    json("POST", { name, systemPrompt: "INTERNAL PROMPT — operators only", appAccess }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
};

describe("agent chat — SDK surface", () => {
  let h: TestHarness;
  let openAgent: string;
  let privateAgent: string;
  let alice: ReturnType<typeof createClient>;
  let bob: ReturnType<typeof createClient>;

  const appClient = (token: string) =>
    createClient({
      url: "",
      workspace: "default",
      token,
      fetch: ((input: string, init?: RequestInit) =>
        h.app.request(input, init)) as unknown as typeof fetch,
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    openAgent = await makeAgent(h, "Support bot", true);
    privateAgent = await makeAgent(h, "Ops runbook", false);
    alice = appClient((await makeEndUser(h, "alice@agentchat.test")).token);
    bob = appClient((await makeEndUser(h, "bob@agentchat.test")).token);
  });

  afterAll(() => h.cleanup());

  test("lists only the agents the operator opened, and none of their config", async () => {
    const { data } = await alice.agentChat.agents();
    expect(data.map((a) => a.id)).toEqual([openAgent]);
    // The typed shape says the prompt isn't there; this asserts the wire agrees,
    // because `core.request` casts and a cast checks nothing.
    expect(JSON.stringify(data)).not.toContain("INTERNAL PROMPT");
    expect(JSON.stringify(data)).not.toContain("systemPrompt");
  });

  test("a private agent cannot be started by naming its id", async () => {
    // 404, not 403 — the id of an agent the operator kept private is not
    // something an end user gets to confirm by guessing.
    await expect(alice.agentChat.start(privateAgent)).rejects.toMatchObject({ status: 404 });
  });

  test("start → threads → messages, all scoped to the caller", async () => {
    const started = await alice.agentChat.start(openAgent, "Where is my order");
    expect(started.data.agentId).toBe(openAgent);
    expect(started.data.title).toBe("Where is my order");

    const mine = await alice.agentChat.threads();
    expect(mine.data.map((t) => t.id)).toContain(started.data.id);

    // A fresh conversation has no transcript yet — an empty array, not a 404.
    const transcript = await alice.agentChat.messages(started.data.id);
    expect(transcript.data).toEqual([]);

    // Bob's client is the same code against the same workspace; only the
    // identity differs.
    expect((await bob.agentChat.threads()).data.map((t) => t.id)).not.toContain(
      started.data.id,
    );
    await expect(bob.agentChat.messages(started.data.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(bob.agentChat.send(started.data.id, "hello")).rejects.toMatchObject({
      status: 404,
    });
  });

  test("an empty message is refused before anything is generated", async () => {
    const started = await alice.agentChat.start(openAgent);
    await expect(alice.agentChat.send(started.data.id, "   ")).rejects.toBeInstanceOf(
      BacklexError,
    );
    await expect(alice.agentChat.send(started.data.id, "   ")).rejects.toMatchObject({
      status: 422,
    });
  });

  test("closing the agent closes the threads hanging off it", async () => {
    const started = await alice.agentChat.start(openAgent);
    expect((await alice.agentChat.messages(started.data.id)).data).toEqual([]);

    await h.fetch(`/api/agents/${openAgent}`, json("PATCH", { appAccess: false }));
    // A conversation must not outlive the decision that allowed it.
    await expect(alice.agentChat.messages(started.data.id)).rejects.toMatchObject({
      status: 404,
    });
    expect((await alice.agentChat.agents()).data).toEqual([]);

    await h.fetch(`/api/agents/${openAgent}`, json("PATCH", { appAccess: true }));
  });
});

describe("agent chat — app mode is required, and said so up front", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("an admin-mode client refuses rather than addressing a workspace it has not got", async () => {
    const admin = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
    // Constructing it must still work — every client assembles every module,
    // and an admin-mode caller that never touches `agentChat` must not pay for
    // its existence.
    expect(typeof admin.agentChat.agents).toBe("function");

    // The failure names the fix. Without this the path would interpolate to
    // `/api/t/undefined/agents` and come back a 404 that reads like a missing
    // agent, which is the wrong thing to go debugging.
    expect(() => admin.agentChat.agents()).toThrow(/workspace/);
    expect(() => admin.agentChat.send("t1", "hi")).toThrow(/createClient/);
  });
});
