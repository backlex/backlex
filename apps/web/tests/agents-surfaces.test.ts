import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Multi-surface parity for the AI Agent feature. REST is exercised in
 * agents.test.ts (with a mocked LLM); this pins the other surfaces — GraphQL
 * (`agents`/`agent`/`createAgent`/…/`runAgent`), the SDK (`client.agents.*`),
 * and MCP (`agents.list`/`agents.get`) — to the same `/api/agents` semantics.
 *
 * The reason→act run path needs an LLM, which the harness has no key for, so
 * these tests cover CRUD parity + that the run surface EXISTS and validates
 * its inputs (a missing-provider run surfaces an error, not a schema gap). The
 * actual loop is proven in agents.test.ts.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("agents — GraphQL surface", () => {
  let h: TestHarness;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("createAgent → agent → agents → updateAgent → deleteAgent round-trips", async () => {
    const created = await gql(
      `mutation($d:AgentInput!){ createAgent(data:$d){ id name tools maxSteps memory active } }`,
      { d: { name: "gql-agent", tools: ["schema.list_collections"], memory: true } },
    );
    expect(created.errors).toBeUndefined();
    const id = created.data?.createAgent.id as string;
    expect(id).toBeTruthy();
    expect(created.data?.createAgent.tools).toEqual(["schema.list_collections"]);
    expect(created.data?.createAgent.memory).toBe(true);

    const one = await gql(`query($id:ID!){ agent(id:$id){ id name } }`, { id });
    expect(one.data?.agent.name).toBe("gql-agent");

    const list = await gql(`{ agents { id name } }`);
    expect(list.data?.agents.some((a: any) => a.id === id)).toBe(true);

    const updated = await gql(
      `mutation($id:ID!,$d:AgentInput!){ updateAgent(id:$id, data:$d){ id name maxSteps } }`,
      { id, d: { name: "gql-agent-2", maxSteps: 5 } },
    );
    expect(updated.data?.updateAgent.name).toBe("gql-agent-2");
    expect(updated.data?.updateAgent.maxSteps).toBe(5);

    const del = await gql(`mutation($id:ID!){ deleteAgent(id:$id) }`, { id });
    expect(del.data?.deleteAgent).toBe(true);

    const gone = await gql(`query($id:ID!){ agent(id:$id){ id } }`, { id });
    expect(gone.data?.agent).toBeNull();
  });

  test("createAgent rejects an unknown tool name", async () => {
    const res = await gql(`mutation($d:AgentInput!){ createAgent(data:$d){ id } }`, {
      d: { name: "bad", tools: ["not.a.tool"] },
    });
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("runAgent on an unknown agent id is NOT_FOUND (mutation is wired)", async () => {
    const res = await gql(`mutation{ runAgent(agent:"nope", message:"hi"){ answer } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});

describe("agents — SDK surface", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });
  afterAll(() => h.cleanup());

  test("create → get → list → update → thread → delete round-trips", async () => {
    const created = await client.agents.create({
      name: "sdk-agent",
      tools: ["schema.list_collections"],
    });
    const id = created.data.id;
    expect(id).toBeTruthy();
    expect(created.data.name).toBe("sdk-agent");

    const one = await client.agents.get(id);
    expect(one.data.name).toBe("sdk-agent");

    const list = await client.agents.list();
    expect(list.data.some((a) => a.id === id)).toBe(true);

    const upd = await client.agents.update(id, { name: "sdk-agent-2" });
    expect(upd.ok).toBe(true);
    expect((await client.agents.get(id)).data.name).toBe("sdk-agent-2");

    const thread = await client.agents.createThread(id, "T");
    expect(thread.data.id).toBeTruthy();
    const threads = await client.agents.threads(id);
    expect(threads.data.some((t) => t.id === thread.data.id)).toBe(true);
    const detail = await client.agents.thread(thread.data.id);
    expect(detail.data.thread.id).toBe(thread.data.id);

    const del = await client.agents.delete(id);
    expect(del.ok).toBe(true);
  });
});

describe("agents — MCP surface", () => {
  let h: TestHarness;
  let agentId: string;

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as {
      result?: { structuredContent?: any; isError?: boolean };
      error?: { message: string };
    };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/agents", json({ name: "mcp-agent", tools: [] }));
    agentId = ((await res.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("agents.list and agents.get are registered and return the agent", async () => {
    // tools/list advertises the agents tools.
    const listRes = await h.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    const tools = ((await listRes.json()) as { result: { tools: { name: string }[] } }).result.tools;
    const names = tools.map((t) => t.name.replaceAll("-", "."));
    expect(names).toContain("agents.list");
    expect(names).toContain("agents.get");
    expect(names).toContain("agents.run");

    const list = await callTool("agents.list");
    expect(JSON.stringify(list?.structuredContent)).toContain("mcp-agent");

    const got = await callTool("agents.get", { id: agentId });
    expect(JSON.stringify(got?.structuredContent)).toContain(agentId);
  });
});
