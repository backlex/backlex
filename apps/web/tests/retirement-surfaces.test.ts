/**
 * Multi-surface parity for row retirement.
 *
 * Three guarantees, and each has its own way of quietly not shipping:
 *
 *   1. **Every surface can narrow to the rows still in play.** REST composes
 *      `retiredFilter` into its WHERE; GraphQL hand-builds its own SQL and has
 *      been the surface missing the guard for rollups, sequences, geo points
 *      and money in turn. A GraphQL list that kept offering retired rows while
 *      REST filtered them is invisible until a customer's app shows a
 *      discontinued product.
 *   2. **Every surface refuses a NEW reference to a retired row.** That check
 *      lives in `validateRelations`, which every write path shares — this test
 *      is what says so rather than assuming it.
 *   3. **Every surface can retire and restore**, through the same service, so
 *      the row scope and the field allow-list cannot drift between them.
 *
 * The CLI is checked structurally rather than by spawning a shell — it is a
 * thin argv parser over the SDK, and what rots is a subcommand quietly
 * disappearing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../../../packages/client/src/index";
import { retirementTools } from "../src/server/mcp/tools/retirement";
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
  const tool = retirementTools.find((x) => x.name === name)!;
  return tool.handler(args, {
    fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init),
  } as never);
};

const parts = "parret_parts";
const builds = "parret_builds";

const newPart = async (name: string, active = true): Promise<string> =>
  (
    await (await h.fetch(`/api/items/${parts}`, json({ name, active }))).json()
  ).data.id as string;

/** Names of the parts a surface would OFFER, read back through REST. */
const liveNames = async (): Promise<string[]> => {
  const r = await h.fetch(`/api/items/${parts}?sort=name&limit=100&retired=exclude`);
  return ((await r.json()).data as Record<string, any>[]).map((x) => x.name);
};

describe("row retirement — multi-surface parity", () => {
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug: parts,
        fields: [
          { name: "name", type: "text" },
          { name: "active", type: "boolean", default: true, retire: {} },
        ],
      }),
    );
    await h.fetch(
      "/api/collections",
      json({
        slug: builds,
        fields: [
          { name: "name", type: "text" },
          { name: "part", type: "relation", to: parts },
        ],
      }),
    );
  });
  afterAll(() => h.cleanup());

  test("REST: narrows, retires, restores", async () => {
    const live = await newPart("r-live");
    const gone = await newPart("r-gone", false);
    expect(await liveNames()).toEqual(["r-live"]);

    expect((await h.fetch(`/api/items/${parts}/${live}/retire`, json({}))).status).toBe(200);
    expect(await liveNames()).toEqual([]);
    expect(
      (await h.fetch(`/api/items/${parts}/${gone}/retire?restore=1`, json({}))).status,
    ).toBe(200);
    expect(await liveNames()).toEqual(["r-gone"]);
  });

  test("GraphQL: the list narrows — the gate", async () => {
    // This resolver hand-builds its WHERE. Without `retiredFilter` composed in
    // here, a GraphQL consumer would keep being offered every retired row while
    // the identical REST query filtered them out.
    const all = await gql(
      `query { parretParts(sort: "name", limit: 100) { name } }`,
    );
    expect(all.errors ?? []).toEqual([]);
    const allNames = (all.data!.parretParts as any[]).map((x) => x.name);
    expect(allNames).toContain("r-live");

    const live = await gql(
      `query { parretParts(sort: "name", limit: 100, retired: "exclude") { name } }`,
    );
    expect(live.errors ?? []).toEqual([]);
    expect((live.data!.parretParts as any[]).map((x) => x.name)).toEqual(["r-gone"]);

    const only = await gql(
      `query { parretParts(sort: "name", limit: 100, retired: "only") { name } }`,
    );
    expect((only.data!.parretParts as any[]).map((x) => x.name)).toEqual(["r-live"]);
  });

  test("GraphQL: an unrecognised scope is refused, not silently widened", async () => {
    const r = await gql(`query { parretParts(retired: "excluded") { name } }`);
    expect((r.errors ?? []).length).toBeGreaterThan(0);
  });

  test("GraphQL: retireItem writes the same column the REST verb does", async () => {
    const id = await newPart("g-part");
    const off = await gql(
      `mutation ($c: String!, $id: ID!) { retireItem(collection: $c, id: $id) { field retired } }`,
      { c: parts, id },
    );
    expect(off.errors ?? []).toEqual([]);
    expect(off.data?.retireItem).toEqual({ field: "active", retired: true });
    // Asserted through REST so the check is about the COLUMN, not about what
    // the mutation chose to echo back.
    expect(await liveNames()).not.toContain("g-part");

    const on = await gql(
      `mutation ($c: String!, $id: ID!) {
         retireItem(collection: $c, id: $id, restore: true) { retired }
       }`,
      { c: parts, id },
    );
    expect(on.data?.retireItem?.retired).toBe(false);
    expect(await liveNames()).toContain("g-part");
  });

  test("GraphQL: a create pointing at a retired row is refused too", async () => {
    const id = await newPart("g-gone", false);
    const r = await gql(
      `mutation ($data: ParretBuildsInput!) { createParretBuilds(data: $data) { id } }`,
      { data: { name: "b1", part: id } },
    );
    expect((r.errors ?? []).map((e) => e.message).join(" ")).toContain("retired");
  });

  test("the batch endpoint refuses one too", async () => {
    const id = await newPart("batch-gone", false);
    const r = await h.fetch(
      `/api/items/${builds}/batch`,
      json({ operations: [{ op: "create", data: { name: "b2", part: id } }] }),
    );
    const body = (await r.json()) as any;
    expect(JSON.stringify(body)).toContain("retired");
  });

  test("SDK: retire, restore, and the `retired` list option", async () => {
    const c = sdk();
    const id = await newPart("sdk-part");
    const off = await c.from(parts).retire(id);
    expect(off.field).toBe("active");
    expect(off.retired).toBe(true);

    const live = await c.from(parts).list({ retired: "exclude", sort: "name", limit: 100 });
    expect((live.data as any[]).map((x) => x.name)).not.toContain("sdk-part");

    const on = await c.from(parts).retire(id, { restore: true });
    expect(on.retired).toBe(false);
    const back = await c.from(parts).list({ retired: "exclude", sort: "name", limit: 100 });
    expect((back.data as any[]).map((x) => x.name)).toContain("sdk-part");
  });

  test("MCP: items.retire reaches the same route", async () => {
    const id = await newPart("mcp-part");
    const off = (await mcp("items.retire", { collection: parts, id })) as {
      structuredContent: any;
    };
    expect(off.structuredContent.retired).toBe(true);
    expect(await liveNames()).not.toContain("mcp-part");

    const on = (await mcp("items.retire", { collection: parts, id, restore: true })) as {
      structuredContent: any;
    };
    expect(on.structuredContent.retired).toBe(false);
  });

  test("MCP exposes exactly the one retirement tool", async () => {
    // A second, raw "set the flag" tool would just be `collections-update` with
    // a worse name, and an agent given both would have to guess which is meant.
    expect(retirementTools.map((t) => t.name).sort()).toEqual(["items.retire"]);
  });

  test("the CLI still carries the subcommand and the list flag", () => {
    const items = readFileSync(
      resolve(import.meta.dir, "../../../packages/cli/src/items.ts"),
      "utf8",
    );
    expect(items).toContain('case "retire"');
    expect(items).toContain(".retire(");
    const client = readFileSync(
      resolve(import.meta.dir, "../../../packages/cli/src/client.ts"),
      "utf8",
    );
    expect(client).toContain('"--retired"');
  });

  test("the OpenAPI spec documents the endpoint and the query param", async () => {
    const spec = (await (await h.fetch("/api/openapi.json")).json()) as {
      paths: Record<string, any>;
    };
    const keys = Object.keys(spec.paths);
    expect(keys.some((p) => p.endsWith("/retire"))).toBe(true);
    const listPath = spec.paths["/api/items/{slug}"];
    const params = (listPath?.get?.parameters ?? []) as { name: string }[];
    expect(params.some((p) => p.name === "retired")).toBe(true);
  });
});
