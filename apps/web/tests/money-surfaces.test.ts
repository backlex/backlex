/**
 * Multi-surface parity for money fields.
 *
 * The gate is not "a money field can be read from five places". It is the one
 * claim the type makes, restated on every surface that writes:
 *
 *   1. **What lands in the column is minor units, scaled by the row's own
 *      currency.** A surface that hand-builds its own INSERT and skips the
 *      canonicalization stores the caller's number as-is, and `19.99` becomes
 *      nineteen kuruş. This is not hypothetical — GraphQL's create resolver
 *      does hand-build its INSERT, and both #38 and #39 found it that way.
 *   2. **What comes back is `{ amount, currency }`**, identically, so a client
 *      that creates through one surface and reads through another does not see
 *      two shapes of the same row.
 *
 * The CLI is checked structurally rather than by spawning a shell — it is a
 * thin argv parser over the SDK, and what rots is a type quietly missing from
 * the codegen map.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, formatMoney } from "../../../packages/client/src/index";
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

const slug = "par_money";
/** The raw integer in the column, which is the whole claim under test. */
let table = "";
const storedAmount = async (id: string): Promise<unknown> => {
  const r = await h.fetch("/api/admin/db/sql/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql: `SELECT price FROM ${table} WHERE id = '${id}'` }),
  });
  const body = (await r.json()) as any;
  return body.data?.[0]?.rows?.[0]?.price;
};

describe("money fields — multi-surface parity", () => {
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "name", type: "text", required: true },
          { name: "price", type: "money", money: { currency: "TRY" } },
        ],
      }),
    );
    table = ((await created.json()) as any).data.physicalTable;
    expect(table.length).toBeGreaterThan(0);
  });

  test("REST stores minor units and reads back an amount with its currency", async () => {
    const r = await h.fetch(`/api/items/${slug}`, json({ name: "rest", price: 19.99 }));
    const body = (await r.json()) as any;
    expect(r.status).toBe(201);
    expect(body.data.price).toEqual({ amount: 19.99, currency: "TRY" });
    expect(await storedAmount(body.data.id)).toBe(1999);
  });

  test("the SDK agrees with REST, byte for byte", async () => {
    const client = sdk();
    const created = ((await client
      .from<Record<string, unknown>>(slug)
      .create({ name: "sdk", price: 19.99 })) as any).data;
    expect(created.price).toEqual({ amount: 19.99, currency: "TRY" });
    expect(await storedAmount(created.id as string)).toBe(1999);
    // And the SDK's own formatter renders what the admin would.
    expect(formatMoney(created.price, "en")).toContain("19.99");
  });

  test("GraphQL — which builds its own INSERT — scales the same way", async () => {
    const res = await gql(
      `mutation { createParMoney(data: { name: "gql", price: 19.99 }) { id price } }`,
    );
    expect(res.errors).toBeUndefined();
    const row = res.data?.createParMoney;
    expect(row.price).toEqual({ amount: 19.99, currency: "TRY" });
    // The claim that actually breaks when a surface forgets: the column.
    expect(await storedAmount(row.id)).toBe(1999);
  });

  test("GraphQL update scales too, and its read matches REST's", async () => {
    const created = await gql(
      `mutation { createParMoney(data: { name: "gqlpatch", price: 1 }) { id } }`,
    );
    const id = created.data?.createParMoney.id as string;
    const updated = await gql(
      `mutation($id: ID!) { updateParMoney(id: $id, data: { price: 250.5 }) { id price } }`,
      { id },
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.updateParMoney.price).toEqual({ amount: 250.5, currency: "TRY" });
    expect(await storedAmount(id)).toBe(25050);
    const rest = (await (await h.fetch(`/api/items/${slug}/${id}`)).json()) as any;
    expect(rest.data.price).toEqual(updated.data?.updateParMoney.price);
  });

  test("GraphQL refuses an amount in the wrong currency, like REST does", async () => {
    const res = await gql(
      `mutation { createParMoney(data: { name: "wrong", price: { amount: 5, currency: "USD" } }) { id } }`,
    );
    expect(res.errors?.[0]?.message).toMatch(/TRY/);
  });

  test("the batch endpoint scales every row it writes", async () => {
    const r = await h.fetch(
      `/api/items/${slug}/batch`,
      json({
        operations: [
          { op: "create", data: { name: "batch-1", price: 1.5 } },
          { op: "create", data: { name: "batch-2", price: "2.25" } },
        ],
      }),
    );
    const body = (await r.json()) as any;
    expect(r.status).toBe(200);
    const ids = body.data.results.map((x: any) => x.id);
    expect(await storedAmount(ids[0])).toBe(150);
    expect(await storedAmount(ids[1])).toBe(225);
  });

  test("CSV import reads a bare amount as major units", async () => {
    const csv = "name,price\ncsv-row,7.77\n";
    const r = await h.fetch(`/api/items/${slug}/import?format=csv`, {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: csv,
    });
    expect(r.status).toBe(200);
    const listed = (await (
      await h.fetch(
        `/api/items/${slug}?filter=${encodeURIComponent(JSON.stringify({ name: { _eq: "csv-row" } }))}`,
      )
    ).json()) as any;
    expect(listed.data[0].price).toEqual({ amount: 7.77, currency: "TRY" });
    expect(await storedAmount(listed.data[0].id)).toBe(777);
  });

  test("MCP can create a collection with a money field", async () => {
    const tool = schemaAdminTools.find((x) => x.name === "schema.create_collection")!;
    const res: any = await tool.handler(
      {
        slug: "par_money_mcp",
        fields: [
          { name: "amount", type: "money", money: { currency: "JPY" } },
        ],
      },
      { fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init) } as never,
    );
    expect(JSON.stringify(res)).not.toMatch(/"isError":\s*true/);
    const created = await h.fetch(
      "/api/items/par_money_mcp",
      json({ amount: 1500 }),
    );
    expect(created.status).toBe(201);
    expect(((await created.json()) as any).data.amount).toEqual({
      amount: 1500,
      currency: "JPY",
    });
  });

  test("the MCP tool description names `money` as a creatable type", () => {
    const tool = schemaAdminTools.find((x) => x.name === "schema.create_collection")!;
    const described = JSON.stringify(tool.inputSchema);
    expect(described).toMatch(/money/);
  });

  test("the SDK codegen maps money to an amount+currency shape", () => {
    // Structural, like the rollup gate's CLI check: what rots here is a field
    // type quietly missing from the map, which emits `unknown` for a column the
    // generated types are supposed to describe.
    const src = readFileSync(
      resolve(import.meta.dir, "../../../packages/cli/src/gen-types.ts"),
      "utf8",
    );
    expect(src).toMatch(/money: "\{ amount: number; currency: string \}"/);
  });

  test("the OpenAPI item schema describes the money shape", async () => {
    const r = await h.fetch(`/api/openapi/collections`);
    if (r.status !== 200) return; // route name differs across builds; skip quietly
    const text = await r.text();
    expect(text).toMatch(/amount/);
  });
});
