import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { parseFacts, recencyScore } from "../src/server/services/agents/memory";

/**
 * Episodic/semantic memory split (#23) and its multi-surface parity.
 *
 * Distillation itself needs an LLM the harness has no key for, so what's pinned
 * here is everything around it: the fact store's semantics (dedupe, scope
 * rules, forgetting) and that REST / SDK / GraphQL / MCP all reach the same
 * ones. The extraction prompt's output parser and the recency ranking are
 * covered as pure functions.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

describe("agent memory — fact extraction parsing (pure)", () => {
  test("a bare JSON array parses", () => {
    expect(parseFacts('["The DB is Postgres.","Ayşe owns billing."]')).toEqual([
      "The DB is Postgres.",
      "Ayşe owns billing.",
    ]);
  });

  test("a fenced or chatty reply still yields its array", () => {
    expect(
      parseFacts('Sure! ```json\n["one thing"]\n``` hope that helps'),
    ).toEqual(["one thing"]);
  });

  test("non-string entries and blanks are dropped", () => {
    expect(parseFacts('["keep", 42, "", null, "  ", "also keep"]')).toEqual([
      "keep",
      "also keep",
    ]);
  });

  test("an empty array, prose, or malformed JSON all yield nothing", () => {
    expect(parseFacts("[]")).toEqual([]);
    expect(parseFacts("I could not find any durable facts.")).toEqual([]);
    expect(parseFacts('["unterminated')).toEqual([]);
  });

  test("a runaway reply is capped in both count and per-fact length", () => {
    const many = JSON.stringify(Array.from({ length: 40 }, (_, i) => `fact ${i}`));
    expect(parseFacts(many).length).toBe(12);
    expect(parseFacts(JSON.stringify(["x".repeat(400)]))).toEqual([]);
  });
});

describe("agent memory — recency ranking (pure)", () => {
  const now = Date.UTC(2026, 6, 27);
  const days = (n: number) => now - n * 86_400_000;

  test("something said now scores 1, and decays by half each half-life", () => {
    expect(recencyScore(now, now)).toBeCloseTo(1, 5);
    expect(recencyScore(days(14), now)).toBeCloseTo(0.5, 5);
    expect(recencyScore(days(28), now)).toBeCloseTo(0.25, 5);
  });

  test("newer always outranks older on the recency term alone", () => {
    expect(recencyScore(days(1), now)).toBeGreaterThan(recencyScore(days(30), now));
  });

  test("a record with no timestamp scores 0 rather than NaN-ing the blend", () => {
    expect(recencyScore(undefined, now)).toBe(0);
    expect(recencyScore(Number.NaN, now)).toBe(0);
  });
});

describe("agent memory — REST", () => {
  let h: TestHarness;
  let agentId: string;
  let threadId: string;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await h.fetch(
      "/api/agents",
      json({ name: "memo", tools: [], memory: true }),
    );
    agentId = ((await created.json()) as { data: { id: string } }).data.id;
    const thread = await h.fetch(`/api/agents/${agentId}/threads`, json({}));
    threadId = ((await thread.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("a new agent defaults to thread-scoped memory", async () => {
    const res = await h.fetch(`/api/agents/${agentId}`);
    const body = (await res.json()) as { data: { memoryScope: string } };
    expect(body.data.memoryScope).toBe("thread");
  });

  test("add → list → forget round-trips", async () => {
    const added = await h.fetch(
      `/api/agents/${agentId}/memory`,
      json({ content: "The production database is Postgres on Neon.", threadId }),
    );
    expect(added.status).toBe(201);
    const row = ((await added.json()) as { data: { id: string; scope: string } }).data;
    expect(row.scope).toBe("thread");

    const list = (await (
      await h.fetch(`/api/agents/${agentId}/memory`)
    ).json()) as { data: { id: string; content: string }[]; meta: { scope: string } };
    expect(list.meta.scope).toBe("thread");
    expect(list.data.some((r) => r.id === row.id)).toBe(true);

    const del = await h.fetch(`/api/agents/${agentId}/memory/${row.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const after = (await (
      await h.fetch(`/api/agents/${agentId}/memory`)
    ).json()) as { data: { id: string }[] };
    expect(after.data.some((r) => r.id === row.id)).toBe(false);
  });

  test("re-teaching a known fact is deduped, not an error", async () => {
    const body = { content: "Deploys go out on Thursdays.", threadId };
    const first = await h.fetch(`/api/agents/${agentId}/memory`, json(body));
    expect(first.status).toBe(201);

    const second = await h.fetch(`/api/agents/${agentId}/memory`, json(body));
    expect(second.status).toBe(200);
    const out = (await second.json()) as { data: null; meta: { deduped: boolean } };
    expect(out.data).toBeNull();
    expect(out.meta.deduped).toBe(true);
  });

  test("whitespace and case differences still count as the same fact", async () => {
    await h.fetch(
      `/api/agents/${agentId}/memory`,
      json({ content: "Invoices are numbered per year.", threadId }),
    );
    const again = await h.fetch(
      `/api/agents/${agentId}/memory`,
      json({ content: "invoices   are Numbered per year.", threadId }),
    );
    expect(((await again.json()) as { meta?: { deduped?: boolean } }).meta?.deduped).toBe(
      true,
    );
  });

  test("a thread-scoped agent refuses a fact with no home thread", async () => {
    const res = await h.fetch(
      `/api/agents/${agentId}/memory`,
      json({ content: "orphan fact" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("threadId");
  });

  test("switching the agent to agent scope drops the threadId requirement", async () => {
    await h.fetch(`/api/agents/${agentId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ memoryScope: "agent" }),
    });
    const res = await h.fetch(
      `/api/agents/${agentId}/memory`,
      json({ content: "The team standup is at 10:00." }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { scope: string } }).data.scope).toBe("agent");
    // Flipping back restores the requirement — scope is read live, not cached.
    await h.fetch(`/api/agents/${agentId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ memoryScope: "thread" }),
    });
    const refused = await h.fetch(
      `/api/agents/${agentId}/memory`,
      json({ content: "another orphan" }),
    );
    expect(refused.status).toBe(422);
  });

  test("an invalid memoryScope is rejected rather than coerced", async () => {
    const res = await h.fetch(`/api/agents/${agentId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ memoryScope: "global" }),
    });
    expect(res.status).toBe(422);
  });

  test("?threadId= narrows the list to one conversation's pool", async () => {
    const other = await h.fetch(`/api/agents/${agentId}/threads`, json({}));
    const otherId = ((await other.json()) as { data: { id: string } }).data.id;
    await h.fetch(
      `/api/agents/${agentId}/memory`,
      json({ content: "Only said in the second room.", threadId: otherId }),
    );
    const scoped = (await (
      await h.fetch(`/api/agents/${agentId}/memory?threadId=${otherId}`)
    ).json()) as { data: { content: string }[] };
    expect(scoped.data).toHaveLength(1);
    expect(scoped.data[0]?.content).toContain("second room");
  });

  test("forgetting an unknown id is NOT_FOUND, not a silent success", async () => {
    const res = await h.fetch(`/api/agents/${agentId}/memory/nope`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  test("memory endpoints on an unknown agent are NOT_FOUND", async () => {
    expect((await h.fetch("/api/agents/nope/memory")).status).toBe(404);
  });
});

describe("agent memory — SDK", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });
  afterAll(() => h.cleanup());

  test("remember → memory → forget round-trips", async () => {
    const agent = await client.agents.create({
      name: "sdk-memo",
      memory: true,
      memoryScope: "agent",
    });
    expect(agent.data.memoryScope).toBe("agent");

    const learned = await client.agents.remember(
      agent.data.id,
      "Support hours are 09:00–17:00 Istanbul time.",
    );
    expect(learned.data?.id).toBeTruthy();

    const facts = await client.agents.memory(agent.data.id);
    expect(facts.meta?.scope).toBe("agent");
    expect(facts.data.map((f) => f.content)).toContain(
      "Support hours are 09:00–17:00 Istanbul time.",
    );

    const dupe = await client.agents.remember(
      agent.data.id,
      "Support hours are 09:00–17:00 Istanbul time.",
    );
    expect(dupe.data).toBeNull();
    expect(dupe.meta?.deduped).toBe(true);

    const gone = await client.agents.forget(agent.data.id, learned.data!.id);
    expect(gone.ok).toBe(true);
    expect((await client.agents.memory(agent.data.id)).data).toHaveLength(0);
  });
});

describe("agent memory — GraphQL", () => {
  let h: TestHarness;
  let agentId: string;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await gql(
      `mutation($d:AgentInput!){ createAgent(data:$d){ id memoryScope } }`,
      { d: { name: "gql-memo", memory: true, memoryScope: "agent" } },
    );
    agentId = created.data?.createAgent.id as string;
    expect(created.data?.createAgent.memoryScope).toBe("agent");
  });
  afterAll(() => h.cleanup());

  test("rememberAgentFact → agentMemories → forgetAgentMemory round-trips", async () => {
    const learned = await gql(
      `mutation($a:ID!,$c:String!){ rememberAgentFact(agentId:$a, content:$c){ id content scope embedded hits } }`,
      { a: agentId, c: "The staging bucket is wiped nightly." },
    );
    expect(learned.errors).toBeUndefined();
    const memoryId = learned.data?.rememberAgentFact.id as string;
    expect(learned.data?.rememberAgentFact.scope).toBe("agent");
    // No embedding provider in the harness — the fact is still stored, and says so.
    expect(learned.data?.rememberAgentFact.embedded).toBe(false);
    expect(learned.data?.rememberAgentFact.hits).toBe(0);

    const list = await gql(`query($a:ID!){ agentMemories(agentId:$a){ id content } }`, {
      a: agentId,
    });
    expect(list.data?.agentMemories.some((m: any) => m.id === memoryId)).toBe(true);

    const dropped = await gql(
      `mutation($a:ID!,$m:ID!){ forgetAgentMemory(agentId:$a, memoryId:$m) }`,
      { a: agentId, m: memoryId },
    );
    expect(dropped.data?.forgetAgentMemory).toBe(true);
    const after = await gql(`query($a:ID!){ agentMemories(agentId:$a){ id } }`, {
      a: agentId,
    });
    expect(after.data?.agentMemories).toHaveLength(0);
  });

  test("an unknown agent id is NOT_FOUND on every memory field", async () => {
    const list = await gql(`query{ agentMemories(agentId:"nope"){ id } }`);
    expect(list.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    const add = await gql(
      `mutation{ rememberAgentFact(agentId:"nope", content:"x"){ id } }`,
    );
    expect(add.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    const del = await gql(
      `mutation{ forgetAgentMemory(agentId:"nope", memoryId:"x") }`,
    );
    expect(del.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  test("createAgent rejects an invalid memoryScope", async () => {
    const res = await gql(`mutation($d:AgentInput!){ createAgent(data:$d){ id } }`, {
      d: { name: "bad-scope", memoryScope: "global" },
    });
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });
});

describe("agent memory — MCP", () => {
  let h: TestHarness;
  let agentId: string;

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as {
      result?: { structuredContent?: any; isError?: boolean };
    };
    return body.result;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await h.fetch(
      "/api/agents",
      json({ name: "mcp-memo", memory: true, memoryScope: "agent" }),
    );
    agentId = ((await created.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("the memory tools are advertised with the right classifications", async () => {
    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    const tools = (
      (await res.json()) as {
        result: { tools: { name: string; kind: string; annotations: any }[] };
      }
    ).result.tools;
    const by = (id: string) => tools.find((t) => t.name.replaceAll("-", ".") === id);

    expect(by("agents.memory_list")?.kind).toBe("read");
    expect(by("agents.memory_list")?.annotations.readOnlyHint).toBe(true);
    expect(by("agents.memory_add")?.kind).toBe("write");
    // Forgetting is destructive — the heuristic would have called it a write,
    // so the explicit classification is what drives the client's warning.
    expect(by("agents.memory_forget")?.kind).toBe("destruct");
    expect(by("agents.memory_forget")?.annotations.destructiveHint).toBe(true);
  });

  test("memory_add → memory_list → memory_forget round-trips", async () => {
    const added = await callTool("agents.memory_add", {
      id: agentId,
      content: "Refunds above 500 need a manager.",
    });
    const memoryId = added?.structuredContent?.data?.id as string;
    expect(memoryId).toBeTruthy();

    const listed = await callTool("agents.memory_list", { id: agentId });
    expect(JSON.stringify(listed?.structuredContent)).toContain(
      "Refunds above 500 need a manager.",
    );

    await callTool("agents.memory_forget", { id: agentId, memoryId });
    const after = await callTool("agents.memory_list", { id: agentId });
    expect(after?.structuredContent?.data).toHaveLength(0);
  });

  test("memory_add without content is a validation error, not a blank fact", async () => {
    const out = await callTool("agents.memory_add", { id: agentId });
    expect(out?.isError).toBe(true);
  });
});
