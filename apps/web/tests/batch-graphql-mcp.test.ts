import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("batch via GraphQL + MCP", () => {
  let h: TestHarness;
  const slug = "gqlbatch"; // → GraphQL `batchGqlbatch`, list `gqlbatch`

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };
  const count = async () => {
    const r = await h.fetch(`/api/items/${slug}?meta=filter_count&limit=1`);
    return ((await r.json()) as { meta?: { filter_count?: number } }).meta?.filter_count ?? 0;
  };
  const createOne = async (title: string): Promise<string> => {
    const r = await h.fetch(`/api/items/${slug}`, json({ title }));
    return ((await r.json()) as { data: { id: string } }).data.id;
  };
  const nOf = async (id: string): Promise<unknown> => {
    const r = await h.fetch(`/api/items/${slug}/${id}?fields=id,n`);
    return ((await r.json()) as { data: { n: unknown } }).data.n;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [{ name: "title", type: "text", required: true }, { name: "n", type: "integer" }],
      }),
    );
  });
  afterAll(() => h.cleanup());

  test("GraphQL batch mutation creates rows", async () => {
    const res = await gql(
      `mutation($ops:[JSON!]!){ batchGqlbatch(operations:$ops){ atomic total succeeded failed results } }`,
      { ops: [{ op: "create", data: { title: "g1" } }, { op: "create", data: { title: "g2" } }] },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.batchGqlbatch.succeeded).toBe(2);
    expect(res.data?.batchGqlbatch.atomic).toBe(false);
    expect(res.data?.batchGqlbatch.results).toHaveLength(2);
  });

  test("GraphQL atomic batch rolls back on failure", async () => {
    const before = await count();
    const res = await gql(
      `mutation($ops:[JSON!]!){ batchGqlbatch(operations:$ops, atomic:true){ succeeded } }`,
      { ops: [{ op: "create", data: { title: "ok" } }, { op: "create", data: { n: 1 } }] },
    );
    expect(res.errors?.length).toBeGreaterThan(0);
    expect(await count()).toBe(before); // nothing committed
  });

  test("GraphQL batch rejects an invalid op kind", async () => {
    const res = await gql(`mutation($ops:[JSON!]!){ batchGqlbatch(operations:$ops){ total } }`, {
      ops: [{ op: "frobnicate", data: {} }],
    });
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("GraphQL bulkUpdate mutation sets a shared field on many ids", async () => {
    const ids = [await createOne("bu-g1"), await createOne("bu-g2")];
    const res = await gql(
      `mutation($keys:[String!]!,$data:JSON!){ bulkUpdateGqlbatch(keys:$keys, data:$data){ total updated failed results } }`,
      { keys: ids, data: { n: 42 } },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.bulkUpdateGqlbatch.total).toBe(2);
    expect(res.data?.bulkUpdateGqlbatch.updated).toBe(2);
    expect(await nOf(ids[0]!)).toBe(42);
    expect(await nOf(ids[1]!)).toBe(42);
  });

  // ── MCP ──────────────────────────────────────────────────────────────────
  let rpcId = 1;
  const callTool = async (name: string, args: unknown) => {
    const res = await h.fetch(
      "/mcp",
      json({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
    );
    return (await res.json()) as {
      result?: { structuredContent?: any; isError?: boolean };
      error?: { message: string };
    };
  };

  test("MCP collections.batch runs a mixed atomic batch", async () => {
    const r = await callTool("collections.batch", {
      collection: slug,
      atomic: true,
      operations: [{ op: "create", data: { title: "mcp1" } }, { op: "create", data: { title: "mcp2" } }],
    });
    expect(r.error).toBeUndefined();
    expect(r.result?.isError).toBeFalsy();
    expect(r.result?.structuredContent?.succeeded).toBe(2);
    expect(r.result?.structuredContent?.atomic).toBe(true);
  });

  test("MCP collections.bulk_update_shared patches a selection", async () => {
    const ids = [await createOne("bu-m1"), await createOne("bu-m2")];
    const r = await callTool("collections.bulk_update_shared", {
      collection: slug,
      keys: ids,
      data: { n: 7 },
    });
    expect(r.error).toBeUndefined();
    expect(r.result?.isError).toBeFalsy();
    expect(r.result?.structuredContent?.updated).toBe(2);
    expect(await nOf(ids[0]!)).toBe(7);
  });

  test("MCP messaging.send_push delivers (in-app row even with no devices)", async () => {
    const r = await callTool("messaging.send_push", {
      userId: "some-user",
      title: "Hello",
      body: "from MCP",
    });
    expect(r.error).toBeUndefined();
    expect(r.result?.isError).toBeFalsy();
    expect(r.result?.structuredContent?.data?.id).toBeTruthy();
  });
});
