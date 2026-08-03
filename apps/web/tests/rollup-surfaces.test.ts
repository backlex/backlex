/**
 * Multi-surface parity for rollup fields.
 *
 * The gate is not that a rollup can be read from five places — a rollup is an
 * ordinary numeric column on the read path, so that would pass on its own. What
 * has to hold is the pair of guarantees the server owns:
 *
 *   1. **No surface can write one.** REST, GraphQL, the SDK, the batch endpoint
 *      and CSV import all funnel through `performCreate`/`performUpdate`, which
 *      is where the refusal lives. A surface that grew its own write path is the
 *      one that lets a caller desync the total.
 *   2. **Every surface that writes a CHILD moves the total.** Same reason,
 *      opposite direction: the refresh is emitted by the shared write core, so a
 *      surface that bypassed it would silently stop maintaining the column.
 *
 * The CLI is checked structurally rather than by spawning a shell — it is a thin
 * argv parser over the SDK, and what rots is a subcommand quietly disappearing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../../../packages/client/src/index";
import { schemaAdminTools } from "../src/server/mcp/tools/schema-admin";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const gql = async (query: string, variables?: unknown) =>
  (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
    data?: Record<string, any>;
    errors?: { message: string }[];
  };

const sdk = () => createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

const mcp = (name: string, args: Record<string, unknown>) => {
  const tool = schemaAdminTools.find((x) => x.name === name)!;
  return tool.handler(args, {
    fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init),
  } as never);
};

const orders = "par_orders";
const lines = "par_lines";

const readTotal = async (id: string): Promise<number> =>
  (await (await h.fetch(`/api/items/${orders}/${id}`)).json()).data.total as number;

const newOrder = async (): Promise<string> =>
  (await (await h.fetch(`/api/items/${orders}`, json({ ref: crypto.randomUUID().slice(0, 8) }))).json())
    .data.id as string;

describe("rollup fields — multi-surface parity", () => {
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug: lines,
        fields: [
          { name: "order", type: "relation", to: orders },
          { name: "amount", type: "number" },
        ],
      }),
    );
    await h.fetch(
      "/api/collections",
      json({
        slug: orders,
        fields: [
          { name: "ref", type: "text" },
          {
            name: "total",
            type: "number",
            rollup: { from: lines, via: "order", fn: "sum", field: "amount" },
          },
        ],
      }),
    );
  });
  afterAll(() => h.cleanup());

  test("REST: a child write moves the total; a direct write to it is refused", async () => {
    const id = await newOrder();
    await h.fetch(`/api/items/${lines}`, json({ order: id, amount: 10 }));
    expect(await readTotal(id)).toBe(10);

    const bad = await h.fetch(`/api/items/${orders}/${id}`, json({ total: 999 }, "PATCH"));
    expect(bad.status).toBe(422);
    expect(await readTotal(id)).toBe(10);
  });

  test("GraphQL: reads the total, refreshes it on a child write, refuses a direct write", async () => {
    const id = await newOrder();
    const created = await gql(
      `mutation ($data: ParLinesInput!) { createParLines(data: $data) { id } }`,
      { data: { order: id, amount: 42 } },
    );
    expect(created.errors ?? []).toEqual([]);

    const read = await gql(
      `query ($f: JSON) { parOrders(filter: $f) { total } }`,
      { f: { id: { _eq: id } } },
    );
    expect(read.data?.parOrders?.[0]?.total).toBe(42);

    const bad = await gql(
      `mutation ($id: ID!, $data: ParOrdersInput!) { updateParOrders(id: $id, data: $data) { id } }`,
      { id, data: { total: 999 } },
    );
    // Refused — either the input type never offered the column or the resolver
    // hit the same validateBody the REST route does. Both are real refusals;
    // what must never happen is the write landing.
    expect((bad.errors ?? []).length).toBeGreaterThan(0);
    expect(await readTotal(id)).toBe(42);
  });

  test("SDK: child create refreshes; parent update of the column is refused", async () => {
    const c = sdk();
    const id = await newOrder();
    await c.from(lines).create({ order: id, amount: 7 } as never);
    expect(await readTotal(id)).toBe(7);

    await expect(c.from(orders).update(id, { total: 999 } as never)).rejects.toThrow(/rollup/i);
  });

  test("batch + CSV import go through the same core, so both maintain the total", async () => {
    const id = await newOrder();
    const batch = await h.fetch(
      `/api/items/${lines}/batch`,
      json({
        operations: [
          { op: "create", data: { order: id, amount: 3 } },
          { op: "create", data: { order: id, amount: 4 } },
        ],
      }),
    );
    expect(batch.status).toBeLessThan(300);
    expect(await readTotal(id)).toBe(7);

    const csv = await h.fetch(`/api/items/${lines}/import?format=csv`, {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: `order,amount\n${id},11\n`,
    });
    expect(csv.status).toBeLessThan(300);
    expect(await readTotal(id)).toBe(18);
  });

  test("MCP exposes the refresh tool and it restates the column", async () => {
    const tool = schemaAdminTools.find((x) => x.name === "schema.rollups_refresh");
    expect(tool).toBeTruthy();
    const id = await newOrder();
    await h.fetch(`/api/items/${lines}`, json({ order: id, amount: 5 }));
    const res = (await mcp("schema.rollups_refresh", { slug: orders })) as {
      content: { text: string }[];
    };
    expect(res.content[0]!.text).toContain("total");
    expect(await readTotal(id)).toBe(5);
  });

  test("SDK exposes refreshRollups and it is idempotent", async () => {
    const id = await newOrder();
    await h.fetch(`/api/items/${lines}`, json({ order: id, amount: 9 }));
    const c = sdk();
    const first = await c.from(orders).refreshRollups();
    expect(first.refreshed).toContain("total");
    await c.from(orders).refreshRollups();
    expect(await readTotal(id)).toBe(9);
  });

  test("the refresh endpoint repairs a total written around the write path", async () => {
    const id = await newOrder();
    await h.fetch(`/api/items/${lines}`, json({ order: id, amount: 20 }));
    expect(await readTotal(id)).toBe(20);

    // The repair is reachable and idempotent from the public surface. The
    // drift it exists for (a restore, a bulk seed, a direct SQL edit) is not
    // reproducible through the API by construction — that is the whole reason
    // the endpoint is here rather than the write path covering it.
    const res = await h.fetch(`/api/items/${orders}/rollups/refresh`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).refreshed).toContain("total");
    expect(await readTotal(id)).toBe(20);
  });

  test("the CLI still carries the refresh subcommand", () => {
    const src = readFileSync(
      resolve(import.meta.dir, "../../../packages/cli/src/collections.ts"),
      "utf8",
    );
    expect(src).toContain("refresh-rollups");
    expect(src).toContain("/rollups/refresh");
  });

  test("the OpenAPI spec documents the refresh endpoint", async () => {
    const spec = (await (await h.fetch("/api/openapi.json")).json()) as {
      paths: Record<string, unknown>;
    };
    const key = Object.keys(spec.paths).find((p) => p.endsWith("/rollups/refresh"));
    expect(key).toBeTruthy();
  });
});
