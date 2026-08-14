import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * End-user agent chat — the app-plane surface at `/api/t/:slug/agents`.
 *
 * Every other AI route in the product is `requireAdmin`, which made AI the one
 * backlex primitive a customer's own users could never touch. Opening it is
 * only defensible because of three independent guards, and this file exists to
 * pin those rather than the happy path:
 *
 *   1. an agent is reachable only when the operator opted it in;
 *   2. a thread belongs to the end user who started it, and to nobody else;
 *   3. an operator's configuration — system prompt, model, tool list — is not
 *      readable from this surface.
 *
 * The turns themselves are not exercised: running one needs a live provider,
 * and what is worth testing here is the gate, not the model.
 */

const JSON_HEADERS = { "content-type": "application/json" };

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

type Bearer = (path: string, init?: RequestInit) => Promise<Response>;

const bearerFor = (h: TestHarness, token: string): Bearer =>
  (path, init = {}) =>
    h.app.request(path, {
      ...init,
      headers: { ...JSON_HEADERS, ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });

/** Admin-invite an end user and accept it, returning their session token. */
const makeEndUser = async (h: TestHarness, email: string) => {
  const invited = await h.fetch("/api/app-users/invite", json("POST", { email }));
  expect(invited.status).toBe(201);
  const { data } = (await invited.json()) as { data: { id: string; token: string } };
  const accepted = await h.app.request(
    "/api/t/default/auth/invite/accept",
    json("POST", { token: data.token, password: "agent-pass-12345" }),
  );
  expect(accepted.status).toBe(200);
  const session = (await accepted.json()) as { token: string };
  return { id: data.id, token: session.token };
};

const makeAgent = async (h: TestHarness, name: string, appAccess: boolean) => {
  const res = await h.fetch(
    "/api/agents",
    json("POST", {
      name,
      systemPrompt: "INTERNAL PROMPT — operators only",
      appAccess,
    }),
  );
  expect(res.status).toBe(201);
  const { data } = (await res.json()) as { data: { id: string } };
  return data.id;
};

describe("app-plane agent chat", () => {
  let h: TestHarness;
  let openAgent: string;
  let privateAgent: string;
  let alice: Bearer;
  let bob: Bearer;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    openAgent = await makeAgent(h, "Support bot", true);
    privateAgent = await makeAgent(h, "Ops runbook", false);
    alice = bearerFor(h, (await makeEndUser(h, "alice@agents.test")).token);
    bob = bearerFor(h, (await makeEndUser(h, "bob@agents.test")).token);
  });

  afterAll(() => h.cleanup());

  test("an anonymous caller gets nothing", async () => {
    const res = await h.app.request("/api/t/default/agents");
    expect(res.status).toBe(401);
  });

  test("only the opted-in agent is listed", async () => {
    const res = await alice("/api/t/default/agents");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string; name: string }[] };
    expect(data.map((a) => a.id)).toEqual([openAgent]);
  });

  test("the operator's configuration is not on this surface", async () => {
    const res = await alice("/api/t/default/agents");
    const body = await res.text();
    // The system prompt is what an attacker wants before trying to talk around
    // it; the model and tool list describe the workspace's internals. The
    // assertion is on the raw body so a nested field cannot slip through.
    expect(body).not.toContain("INTERNAL PROMPT");
    expect(body).not.toContain("systemPrompt");
    expect(body).not.toContain("tools");
  });

  test("a private agent cannot be started by naming its id", async () => {
    const res = await alice(
      "/api/t/default/agents/threads",
      json("POST", { agentId: privateAgent }),
    );
    // 404 rather than 403: whether a private agent exists is not something an
    // end user gets to learn by guessing.
    expect(res.status).toBe(404);
  });

  test("a thread on an open agent starts, and lists for its owner", async () => {
    const created = await alice(
      "/api/t/default/agents/threads",
      json("POST", { agentId: openAgent, title: "Where is my order" }),
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const mine = await alice("/api/t/default/agents/threads");
    const list = (await mine.json()) as { data: { id: string }[] };
    expect(list.data.map((t) => t.id)).toContain(data.id);
  });

  test("another end user cannot see it, read it, or write to it", async () => {
    const created = await alice(
      "/api/t/default/agents/threads",
      json("POST", { agentId: openAgent }),
    );
    const { data } = (await created.json()) as { data: { id: string } };

    const bobsList = await bob("/api/t/default/agents/threads");
    const list = (await bobsList.json()) as { data: { id: string }[] };
    expect(list.data.map((t) => t.id)).not.toContain(data.id);

    const read = await bob(`/api/t/default/agents/threads/${data.id}/messages`);
    expect(read.status).toBe(404);

    const write = await bob(
      `/api/t/default/agents/threads/${data.id}/messages`,
      json("POST", { message: "hello" }),
    );
    expect(write.status).toBe(404);
  });

  test("closing the agent closes the threads that hang off it", async () => {
    const created = await alice(
      "/api/t/default/agents/threads",
      json("POST", { agentId: openAgent }),
    );
    const { data } = (await created.json()) as { data: { id: string } };
    expect((await alice(`/api/t/default/agents/threads/${data.id}/messages`)).status).toBe(
      200,
    );

    // The operator revokes end-user access.
    const patched = await h.fetch(
      `/api/agents/${openAgent}`,
      json("PATCH", { appAccess: false }),
    );
    expect(patched.status).toBe(200);

    // A thread must not outlive the decision that allowed it.
    expect((await alice(`/api/t/default/agents/threads/${data.id}/messages`)).status).toBe(
      404,
    );
    expect((await alice("/api/t/default/agents")).status).toBe(200);
    const after = (await (await alice("/api/t/default/agents")).json()) as {
      data: unknown[];
    };
    expect(after.data).toEqual([]);

    // Put it back for any test that follows.
    await h.fetch(`/api/agents/${openAgent}`, json("PATCH", { appAccess: true }));
  });

  test("a message is required", async () => {
    const created = await alice(
      "/api/t/default/agents/threads",
      json("POST", { agentId: openAgent }),
    );
    const { data } = (await created.json()) as { data: { id: string } };
    const res = await alice(
      `/api/t/default/agents/threads/${data.id}/messages`,
      json("POST", { message: "   " }),
    );
    expect(res.status).toBe(422);
  });

  test("a token for one workspace is refused against another's path", async () => {
    const res = await alice("/api/t/no-such-workspace/agents");
    expect(res.status).toBe(404);
  });
});

describe("agents are private until an operator says otherwise", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => h.cleanup());

  test("a newly created agent is not exposed", async () => {
    // The default is the whole safety property: a workspace's existing agents
    // were built when only operators could reach them, so shipping this route
    // must not have exposed any of them.
    const res = await h.fetch("/api/agents", json("POST", { name: "Fresh" }));
    const { data } = (await res.json()) as { data: { appAccess: boolean } };
    expect(data.appAccess).toBe(false);
  });
});
