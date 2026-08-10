/**
 * Multi-surface parity for integrations. REST is the reference; this pins the
 * three surfaces added alongside it — GraphQL, the SDK (`client.integrations.*`)
 * and MCP (`integrations.*`) — to the same semantics, and asserts the guard
 * that matters most: no surface may hand back a decrypted credential.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { INTEGRATION_KINDS } from "@backlex/integrations";
import { createClient } from "../../../packages/client/src/index";
import { integrationsTools } from "../src/server/mcp/tools/integrations";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const SECRET = "https://hooks.slack.com/services/TOP-SECRET-VALUE";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("integrations — GraphQL surface", () => {
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

  test("catalog → connect → integrations → deliveries → resume → disconnect", async () => {
    const cat = await gql(`{ integrationCatalog { id label category capabilities } }`);
    expect(cat.errors).toBeUndefined();
    // Derived from the registry, not a literal: the point is that GraphQL
    // exposes the WHOLE catalog, and a hard-coded count only means "someone
    // added a provider" every time one is added.
    expect(cat.data?.integrationCatalog.length).toBe(INTEGRATION_KINDS.length);
    expect((cat.data?.integrationCatalog as { id: string }[]).map((p) => p.id).sort()).toEqual(
      [...INTEGRATION_KINDS].sort(),
    );

    const made = await gql(
      `mutation($k:String!,$c:JSON){ connectIntegration(kind:$k, config:$c){ id kind status consecutiveFailures } }`,
      { k: "slack", c: { webhookUrl: SECRET } },
    );
    expect(made.errors).toBeUndefined();
    const id = made.data?.connectIntegration.id as string;
    expect(made.data?.connectIntegration.status).toBe("connected");

    const listed = await gql(`{ integrations { id kind status config } }`);
    expect(listed.data?.integrations).toHaveLength(1);
    // The masked value must not contain the plaintext secret.
    expect(JSON.stringify(listed.data?.integrations)).not.toContain("TOP-SECRET-VALUE");

    const del = await gql(`query($i:String!){ integrationDeliveries(integrationId:$i){ id } }`, { i: id });
    expect(del.errors).toBeUndefined();
    expect(del.data?.integrationDeliveries).toEqual([]);

    const resumed = await gql(`mutation($i:String!){ resumeIntegration(id:$i){ id status } }`, { i: id });
    expect(resumed.data?.resumeIntegration.status).toBe("connected");

    const gone = await gql(`mutation($i:String!){ disconnectIntegration(id:$i) }`, { i: id });
    expect(gone.errors).toBeUndefined();
    const after = await gql(`{ integrations { id } }`);
    expect(after.data?.integrations).toEqual([]);
  });

  test("an unknown provider kind is a VALIDATION error, not a stored row", async () => {
    const bad = await gql(
      `mutation($k:String!){ connectIntegration(kind:$k){ id } }`,
      { k: "not-a-provider" },
    );
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION");
    const after = await gql(`{ integrations { id } }`);
    expect(after.data?.integrations).toEqual([]);
  });

  test("resuming an integration that does not exist is NOT_FOUND", async () => {
    const missing = await gql(`mutation{ resumeIntegration(id:"nope"){ id } }`);
    expect(missing.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});

describe("integrations — GraphQL is admin-gated", () => {
  let h: TestHarness;

  beforeAll(() => {
    h = makeHarness();
  });
  afterAll(() => h.cleanup());

  /** No `seedAdmin` here — these run with no session at all. */
  const anon = async (query: string) =>
    (await (await h.fetch("/api/graphql", json({ query }))).json()) as {
      data?: Record<string, any>;
      errors?: { extensions?: { code?: string } }[];
    };

  test("every integration field refuses an unauthenticated caller", async () => {
    const probes = [
      `{ integrationCatalog { id } }`,
      `{ integrations { id } }`,
      `{ integrationDeliveries(integrationId:"x"){ id } }`,
      `mutation{ connectIntegration(kind:"slack"){ id } }`,
      `mutation{ disconnectIntegration(id:"x") }`,
      `mutation{ resumeIntegration(id:"x"){ id } }`,
    ];
    for (const q of probes) {
      const res = await anon(q);
      // Fail closed: an error with an auth code, and never a data payload.
      expect(["FORBIDDEN", "UNAUTHORIZED"]).toContain(res.errors?.[0]?.extensions?.code);
    }
  });
});

describe("integrations — SDK surface", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "http://localhost", fetch: h.fetch as typeof fetch });
  });
  afterAll(() => h.cleanup());

  test("catalog → connect → list → deliveries → resume → disconnect", async () => {
    const cat = await client.integrations.catalog();
    expect(cat.data.kinds).toContain("slack");
    expect(cat.data.providers.find((p) => p.id === "slack")?.category).toBe("chat");

    const made = await client.integrations.connect({
      kind: "slack",
      config: { webhookUrl: SECRET },
      events: ["posts.*"],
    });
    expect(made.data.kind).toBe("slack");
    expect(made.data.events).toEqual(["posts.*"]);

    const listed = await client.integrations.list();
    expect(listed.data).toHaveLength(1);
    expect(JSON.stringify(listed.data)).not.toContain("TOP-SECRET-VALUE");
    expect(listed.data[0]!.consecutiveFailures).toBe(0);

    expect((await client.integrations.deliveries(made.data.id)).data).toEqual([]);
    expect((await client.integrations.resume(made.data.id)).data.status).toBe("connected");
    expect((await client.integrations.disconnect(made.data.id)).ok).toBe(true);
    expect((await client.integrations.list()).data).toEqual([]);
  });
});

describe("integrations — MCP surface", () => {
  test("the tool group covers the whole REST surface", () => {
    expect(integrationsTools.map((t) => t.name).sort()).toEqual([
      "integrations.catalog",
      "integrations.connect",
      "integrations.create_sync",
      "integrations.delete_sync",
      "integrations.deliveries",
      "integrations.disconnect",
      "integrations.list",
      "integrations.oauth_authorize",
      "integrations.resume",
      "integrations.run_sync",
      "integrations.run_task",
      "integrations.syncs",
      "integrations.task_runs",
      "integrations.update_sync",
    ]);
  });

  test("every tool declares a closed input schema", () => {
    for (const tool of integrationsTools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});

/**
 * A push sync is creatable from every surface, not just REST.
 *
 * `direction` reached the REST route and the admin UI when destinations landed,
 * and stopped there — so an SDK, GraphQL, MCP or CLI caller asking for a
 * mirror-out silently got a PULL, which then failed on its first run with an
 * error about the wrong half of the provider. Pinned here because the failure
 * is invisible at the call site: the sync is created, it just faces the wrong
 * way.
 */
describe("integrations — direction reaches every surface", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;
  let integrationId: string;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "http://localhost", fetch: h.fetch as typeof fetch });
    await h.fetch(
      "/api/collections",
      json({ slug: "ledger", fields: [{ name: "customer", type: "text" }] }),
    );
    const made = await client.integrations.connect({
      kind: "quickbooks",
      config: { clientId: "cid", clientSecret: "csecret" },
    });
    integrationId = made.data.id;
  });
  afterAll(() => h.cleanup());

  const PUSH = {
    collection: "ledger",
    direction: "push" as const,
    settings: { entity: "Customer", environment: "production" },
    mapping: { customer: "displayName" },
  };

  test("the SDK asks for a push and gets one", async () => {
    const made = await client.integrations.createSync({ integrationId, ...PUSH });
    expect(made.data.direction).toBe("push");
  });

  test("GraphQL does too, and reports it back", async () => {
    const res = await gql(
      `mutation($d:IntegrationSyncInput!){ createIntegrationSync(data:$d){ id direction } }`,
      { d: { integrationId, ...PUSH } },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.createIntegrationSync.direction).toBe("push");
  });

  test("MCP declares it as a closed choice", () => {
    const tool = integrationsTools.find((t) => t.name === "integrations.create_sync");
    const direction = (tool?.inputSchema.properties as Record<string, any>).direction;
    // An enum rather than a free string: an agent guessing "outbound" would
    // otherwise create a pull and be told nothing.
    expect(direction.enum).toEqual(["pull", "push"]);
  });
});

describe("integrations — child mappings reach every surface", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;
  let integrationId: string;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "http://localhost", fetch: h.fetch as typeof fetch });
    await h.fetch(
      "/api/collections",
      json({ slug: "orders", fields: [{ name: "number", type: "text" }] }),
    );
    await h.fetch(
      "/api/collections",
      json({
        slug: "order_lines",
        fields: [
          { name: "order", type: "text" },
          { name: "sku", type: "text" },
        ],
      }),
    );
    const made = await client.integrations.connect({
      kind: "google-sheets",
      config: { clientId: "cid", clientSecret: "csecret" },
    });
    integrationId = made.data.id;
  });
  afterAll(() => h.cleanup());

  const PULL = {
    collection: "orders",
    settings: { spreadsheetId: "s1", sheetName: "Sheet1" },
    mapping: { Number: "number" },
    childMappings: {
      items: { collection: "order_lines", parentField: "order", mapping: { SKU: "sku" } },
    },
  };

  test("the SDK round-trips a child group", async () => {
    const made = await client.integrations.createSync({ integrationId, ...PULL });
    expect(made.data.childMappings.items?.collection).toBe("order_lines");
    expect(made.data.childMappings.items?.parentField).toBe("order");
  });

  test("GraphQL does too", async () => {
    const res = await gql(
      `mutation($d:IntegrationSyncInput!){ createIntegrationSync(data:$d){ id childMappings } }`,
      { d: { integrationId, ...PULL } },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.createIntegrationSync.childMappings.items.collection).toBe("order_lines");
  });

  test("MCP declares the field, so an agent can actually send it", () => {
    // `additionalProperties: false` on this tool means an undeclared field is
    // REJECTED, not ignored — leaving it out of the schema would make the
    // capability unreachable from MCP while looking present everywhere else.
    const tool = integrationsTools.find((t) => t.name === "integrations.create_sync");
    const props = tool?.inputSchema.properties as Record<string, any>;
    expect(props.childMappings).toBeDefined();
    expect(props.childMappings.additionalProperties.required).toEqual([
      "collection",
      "parentField",
      "mapping",
    ]);
  });
});

describe("integrations — the task capability reaches every surface", () => {
  // The provider half needs no mock here: these assert that each surface
  // DECLARES the capability, which is the half that silently rots. MCP is the
  // sharp one — `additionalProperties: false` rejects an undeclared field, so a
  // tool missing `force` would make the escape hatch unreachable from an agent
  // while looking present everywhere else.
  test("MCP exposes run_task and task_runs with the fields the REST body takes", () => {
    const run = integrationsTools.find((t) => t.name === "integrations.run_task");
    expect(run).toBeDefined();
    const props = run?.inputSchema.properties as Record<string, any>;
    for (const key of ["integrationId", "task", "collection", "itemId", "outputMapping", "force"]) {
      expect(props[key]).toBeDefined();
    }
    expect(run?.inputSchema.required).toEqual(["integrationId", "task", "collection", "itemId"]);

    const runs = integrationsTools.find((t) => t.name === "integrations.task_runs");
    expect(runs).toBeDefined();
  });

  test("the SDK declares both entry points", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);
      const client = createClient({ url: "http://localhost", fetch: h.fetch as typeof fetch });
      expect(typeof client.integrations.runTask).toBe("function");
      expect(typeof client.integrations.taskRuns).toBe("function");
    } finally {
      h.cleanup();
    }
  });

  test("GraphQL declares the mutation and the query", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);
      const res = (await (
        await h.fetch(
          "/api/graphql",
          json({
            query: `{ __schema { mutationType { fields { name } } queryType { fields { name } } } }`,
          }),
        )
      ).json()) as any;
      const mutations = res.data.__schema.mutationType.fields.map((f: any) => f.name);
      const queries = res.data.__schema.queryType.fields.map((f: any) => f.name);
      expect(mutations).toContain("runIntegrationTask");
      expect(queries).toContain("integrationTaskRuns");
    } finally {
      h.cleanup();
    }
  });
});
