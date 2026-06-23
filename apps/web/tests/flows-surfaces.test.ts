import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Multi-surface parity for the Flow feature. REST + MCP already exist (see
 * mcp.test.ts / realtime-flows.test.ts); this pins the two surfaces added
 * alongside them — GraphQL (`flows`/`flow`/`createFlow`/…/`runFlow`) and the
 * SDK (`client.flows.*`) — to the same `/api/flows` semantics.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("flows — GraphQL surface", () => {
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

  test("createFlow → flow → flows → runFlow → deleteFlow round-trips", async () => {
    const created = await gql(
      `mutation($d:FlowInput!){ createFlow(data:$d){ id name trigger active operations } }`,
      { d: { name: "gql-flow", trigger: "manual:", operations: [{ type: "log", message: "x" }] } },
    );
    expect(created.errors).toBeUndefined();
    const id = created.data?.createFlow.id as string;
    expect(id).toBeTruthy();
    expect(created.data?.createFlow.active).toBe(true);

    const one = await gql(`query($id:ID!){ flow(id:$id){ id name } }`, { id });
    expect(one.data?.flow.name).toBe("gql-flow");

    const list = await gql(`{ flows { id name } }`);
    expect(list.data?.flows.some((f: any) => f.id === id)).toBe(true);

    const updated = await gql(
      `mutation($id:ID!,$d:FlowInput!){ updateFlow(id:$id, data:$d){ id name active } }`,
      { id, d: { name: "gql-flow-2", active: false } },
    );
    expect(updated.data?.updateFlow.name).toBe("gql-flow-2");
    expect(updated.data?.updateFlow.active).toBe(false);

    // A paused flow reports ok:false from runFlowById ("flow is paused").
    const runPaused = await gql(`mutation($id:ID!){ runFlow(id:$id){ ok error } }`, { id });
    expect(runPaused.data?.runFlow.ok).toBe(false);

    // Re-activate, then a manual run of a single log op succeeds.
    await gql(`mutation($id:ID!,$d:FlowInput!){ updateFlow(id:$id, data:$d){ id } }`, {
      id,
      d: { active: true },
    });
    const run = await gql(`mutation($id:ID!,$i:JSON){ runFlow(id:$id, input:$i){ ok error } }`, {
      id,
      i: { hello: "world" },
    });
    expect(run.errors).toBeUndefined();
    expect(run.data?.runFlow.ok).toBe(true);

    const del = await gql(`mutation($id:ID!){ deleteFlow(id:$id) }`, { id });
    expect(del.data?.deleteFlow).toBe(true);

    const gone = await gql(`query($id:ID!){ flow(id:$id){ id } }`, { id });
    expect(gone.data?.flow).toBeNull();
  });

  test("createFlow rejects an empty operations array", async () => {
    const res = await gql(`mutation($d:FlowInput!){ createFlow(data:$d){ id } }`, {
      d: { name: "bad", trigger: "manual:", operations: [] },
    });
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("runFlow on an unknown id is NOT_FOUND", async () => {
    const res = await gql(`mutation{ runFlow(id:"no-such-flow"){ ok } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});

describe("flows — SDK surface", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // url:"" so the SDK's `${url}${path}` collapses to the bare path the
    // harness fetch resolves against APP_URL; the cookie jar carries the
    // admin session seedAdmin established.
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });
  afterAll(() => h.cleanup());

  test("create → get → list → update → run → delete round-trips", async () => {
    const created = await client.flows.create({
      name: "sdk-flow",
      trigger: "manual:",
      operations: [{ type: "log", message: "x" }],
    });
    const id = created.data.id;
    expect(id).toBeTruthy();
    expect(created.data.name).toBe("sdk-flow");

    const one = await client.flows.get(id);
    expect(one.data.name).toBe("sdk-flow");

    const list = await client.flows.list();
    expect(list.data.some((f) => f.id === id)).toBe(true);

    const upd = await client.flows.update(id, { name: "sdk-flow-2" });
    expect(upd.ok).toBe(true);
    expect((await client.flows.get(id)).data.name).toBe("sdk-flow-2");

    const run = await client.flows.run(id, { ping: 1 });
    expect(run.ok).toBe(true);

    const del = await client.flows.delete(id);
    expect(del.ok).toBe(true);
  });
});
