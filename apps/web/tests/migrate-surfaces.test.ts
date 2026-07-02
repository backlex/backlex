/**
 * Multi-surface parity gate for external-DB migration: the same semantic
 * operations (sources list/create, plan, run lifecycle) must work through
 * REST, SDK (`client.migrate.*`), GraphQL, and MCP (`migrate.*`) — and all
 * of them funnel into services/migrate.ts (guards live once).
 * REST itself is exercised in depth by migrate-server.test.ts.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createClient, type BacklexClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { createPgSource, type SourceQuery } from "../../../packages/migrate/src";
import { __setMigrateConnectorFactory } from "../src/server/services/migrate";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("migrate surfaces (SDK / GraphQL / MCP parity)", () => {
  let h: TestHarness;
  let pg: PGlite;
  let client: BacklexClient;
  let restoreFactory: () => void;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string }[];
    };

  const mcpCall = async (name: string, args: Record<string, unknown> = {}) => {
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
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE gadgets (id bigint PRIMARY KEY, label varchar(60) NOT NULL);
      INSERT INTO gadgets (id, label) VALUES (1, 'sprocket'), (2, 'flange'), (3, 'grommet');
    `);
    const query: SourceQuery = async (text, params) =>
      (await pg.query(text, (params ?? []) as unknown[])).rows as Record<
        string,
        unknown
      >[];
    const prev = __setMigrateConnectorFactory(() => ({
      connector: createPgSource(query),
      close: async () => {},
    }));
    restoreFactory = () => __setMigrateConnectorFactory(prev);

    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });

  afterAll(async () => {
    restoreFactory();
    await pg?.close();
    h?.cleanup();
  });

  test("SDK: create source → tables → plan → start → cancel → resume", async () => {
    const created = await client.migrate.createSource(
      "sdk-src",
      "postgres://u:p@sdk.example.com/db",
    );
    expect(created.data.urlMasked).toBe("postgres://sdk.example.com/db");

    const sources = await client.migrate.sources();
    expect(sources.data.some((s) => s.name === "sdk-src")).toBe(true);

    const tested = await client.migrate.testSource(created.data.id);
    expect(tested.data.ok).toBe(true);

    const tables = await client.migrate.sourceTables(created.data.id);
    expect(tables.data.map((t) => t.name)).toEqual(["gadgets"]);

    const plan = await client.migrate.plan(created.data.id);
    expect((plan.data as any).order).toEqual(["gadgets"]);

    const run = await client.migrate.startRun(created.data.id, plan.data);
    expect(run.data.status).toBe("pending");

    const cancelled = await client.migrate.cancelRun(run.data.id);
    expect(cancelled.data.status).toBe("cancelled");
    const resumed = await client.migrate.resumeRun(run.data.id);
    expect(resumed.data.status).toBe("pending");
    await client.migrate.cancelRun(run.data.id); // leave no active run behind

    const runs = await client.migrate.runs();
    expect(runs.data[0]!.id).toBe(run.data.id);
    const one = await client.migrate.run(run.data.id);
    expect(one.data.state.tables.gadgets).toMatchObject({ copied: 0, done: false });
  });

  test("GraphQL: sources / plan / run lifecycle mirror the service", async () => {
    const created = await gql(
      `mutation($n:String!,$u:String!){ migrateCreateSource(name:$n, url:$u) }`,
      { n: "gql-src", u: "postgres://u:p@gql.example.com/db" },
    );
    expect(created.errors).toBeUndefined();
    const src = created.data!.migrateCreateSource;
    expect(src.urlMasked).toBe("postgres://gql.example.com/db");

    const listed = await gql(`{ migrateSources }`);
    expect(
      (listed.data!.migrateSources as any[]).some((s) => s.name === "gql-src"),
    ).toBe(true);

    const tables = await gql(
      `query($id:String!){ migrateSourceTables(sourceId:$id) }`,
      { id: src.id },
    );
    expect((tables.data!.migrateSourceTables as any[])[0].name).toBe("gadgets");

    const plan = await gql(
      `mutation($id:String!){ migratePlan(sourceId:$id) }`,
      { id: src.id },
    );
    expect((plan.data!.migratePlan as any).order).toEqual(["gadgets"]);

    const run = await gql(
      `mutation($id:String!,$p:JSON!){ migrateStartRun(sourceId:$id, plan:$p) }`,
      { id: src.id, p: plan.data!.migratePlan },
    );
    expect(run.errors).toBeUndefined();
    const runId = (run.data!.migrateStartRun as any).id;

    const got = await gql(`query($id:String!){ migrateRun(id:$id) }`, { id: runId });
    expect((got.data!.migrateRun as any).status).toBe("pending");

    const cancel = await gql(
      `mutation($id:String!){ migrateCancelRun(id:$id) }`,
      { id: runId },
    );
    expect((cancel.data!.migrateCancelRun as any).status).toBe("cancelled");

    const del = await gql(
      `mutation($id:String!){ migrateDeleteSource(id:$id) }`,
      { id: src.id },
    );
    expect((del.data!.migrateDeleteSource as any).ok).toBe(true);
  });

  test("MCP: migrate.* tools drive the same flow", async () => {
    const created = await mcpCall("migrate.create_source", {
      name: "mcp-src",
      url: "postgres://u:p@mcp.example.com/db",
    });
    expect(created!.isError).toBeFalsy();
    const src = created!.structuredContent.data;
    expect(src.urlMasked).toBe("postgres://mcp.example.com/db");

    const sources = await mcpCall("migrate.sources");
    expect(
      (sources!.structuredContent.data as any[]).some((s) => s.name === "mcp-src"),
    ).toBe(true);

    const tables = await mcpCall("migrate.source_tables", { id: src.id });
    expect(tables!.structuredContent.data[0].name).toBe("gadgets");

    const plan = await mcpCall("migrate.plan", { sourceId: src.id });
    expect(plan!.structuredContent.data.order).toEqual(["gadgets"]);

    const run = await mcpCall("migrate.start_run", {
      sourceId: src.id,
      plan: plan!.structuredContent.data,
    });
    expect(run!.isError).toBeFalsy();
    const runId = run!.structuredContent.data.id;

    const status = await mcpCall("migrate.run", { id: runId });
    expect(status!.structuredContent.data.status).toBe("pending");

    const cancelled = await mcpCall("migrate.cancel_run", { id: runId });
    expect(cancelled!.structuredContent.data.status).toBe("cancelled");

    const runs = await mcpCall("migrate.runs");
    expect((runs!.structuredContent.data as any[]).length).toBeGreaterThan(0);
  });

  test("SSRF guard reaches every surface (shared service, not re-implemented)", async () => {
    // SDK
    await expect(
      client.migrate.createSource("bad-sdk", "postgres://u:p@127.0.0.1/db"),
    ).rejects.toThrow();
    // GraphQL
    const viaGql = await gql(
      `mutation($n:String!,$u:String!){ migrateCreateSource(name:$n, url:$u) }`,
      { n: "bad-gql", u: "postgres://u:p@localhost/db" },
    );
    expect(viaGql.errors?.[0]?.message).toContain("private");
    // MCP
    const viaMcp = await mcpCall("migrate.create_source", {
      name: "bad-mcp",
      url: "postgres://u:p@169.254.169.254/db",
    });
    expect(viaMcp!.isError).toBe(true);
  });
});
