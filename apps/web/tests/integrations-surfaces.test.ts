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
import { SYNC_DIRECTIONS } from "../src/server/services/integration-syncs";
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
      expect(["FORBIDDEN", "UNAUTHORIZED"]).toContain(String(res.errors?.[0]?.extensions?.code));
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
      "integrations.disable_webhook",
      "integrations.enable_webhook",
      "integrations.inbound_deliveries",
      "integrations.task_runs",
      "integrations.update_sync",
      "integrations.update_webhook_events",
      "integrations.listing_categories",
      "integrations.listing_attributes",
      "integrations.listing_lookup",
      "integrations.listing_maps",
      "integrations.map_listing_category",
      "integrations.listing_batches",
    ].sort());
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
    //
    // Derived from the service's own list rather than re-typed here. A literal
    // makes this a test you UPDATE when a direction is added, which is the
    // opposite of a gate — the whole point is to fail when a surface is left
    // behind, and a hand-kept copy fails when it is not.
    expect(direction.enum).toEqual([...SYNC_DIRECTIONS]);
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

/**
 * The inbound-webhook capability reaches every surface.
 *
 * The same failure mode `direction` had, one capability later: an endpoint that
 * exists only over REST leaves an SDK, GraphQL, MCP or CLI caller able to create
 * the sync and unable to turn on the thing that feeds it. MCP is the sharp one —
 * `additionalProperties: false` REJECTS an undeclared field, so a tool missing
 * `events` would make the event filter unreachable from an agent while looking
 * present everywhere else.
 */
describe("integrations — inbound webhooks reach every surface", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;
  const realFetch = globalThis.fetch;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "http://localhost", fetch: h.fetch as typeof fetch });
    // Turning an endpoint on asks the provider to start calling. A test suite
    // must not, so the provider's host is answered here instead of reached.
    globalThis.fetch = (async (url: any, init: any) =>
      String(url).startsWith("https://api.easypost.com/")
        ? new Response(JSON.stringify({ id: "hook_surfaces" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : realFetch(url, init)) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    h.cleanup();
  });

  test("the catalog describes each endpoint, from REST and the SDK alike", async () => {
    const cat = await client.integrations.catalog();
    // Derived from the registry: what matters is that the shape crosses the API
    // at all, since a form cannot render a `verify` function.
    expect(cat.data.webhooks.easypost?.landing).toBe("patch");
    expect(cat.data.webhooks.easypost?.selfRegistering).toBe(true);
    expect(cat.data.webhooks.trendyol?.auth).toBe("header");
    expect(cat.data.webhooks.trendyol?.events.length).toBeGreaterThan(5);
    // A provider that only ever answers a request we made has no endpoint.
    expect(cat.data.webhooks.slack).toBeUndefined();
  });

  test("the SDK declares every entry point", () => {
    for (const fn of ["enableWebhook", "updateWebhookEvents", "disableWebhook", "inboundDeliveries"]) {
      expect(typeof (client.integrations as unknown as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  test("GraphQL declares the mutations and the query", async () => {
    const res = (await (
      await h.fetch(
        "/api/graphql",
        json({ query: `{ __schema { mutationType { fields { name } } queryType { fields { name } } } }` }),
      )
    ).json()) as any;
    const mutations = res.data.__schema.mutationType.fields.map((f: any) => f.name);
    const queries = res.data.__schema.queryType.fields.map((f: any) => f.name);
    expect(mutations).toContain("enableIntegrationWebhook");
    expect(mutations).toContain("updateIntegrationWebhookEvents");
    expect(mutations).toContain("disableIntegrationWebhook");
    expect(queries).toContain("integrationInboundDeliveries");
  });

  test("GraphQL takes matchField on a sync, and reports the endpoint back", async () => {
    // The two fields a webhook adds to a sync. `matchField` is the one that is
    // useless if it only reaches REST: without it an inbound sync for a carrier
    // cannot be created from GraphQL at all.
    const res = await gql(`{ __type(name:"IntegrationSyncInput"){ inputFields { name } } }`);
    const fields = (res.data?.__type.inputFields as { name: string }[]).map((f) => f.name);
    expect(fields).toContain("matchField");

    const out = await gql(`{ __type(name:"IntegrationSync"){ fields { name } } }`);
    const readable = (out.data?.__type.fields as { name: string }[]).map((f) => f.name);
    expect(readable).toContain("matchField");
    expect(readable).toContain("webhook");
  });

  test("MCP declares the fields each call actually needs", () => {
    const enable = integrationsTools.find((t) => t.name === "integrations.enable_webhook");
    const props = enable?.inputSchema.properties as Record<string, any>;
    expect(props.syncId).toBeDefined();
    expect(props.events).toBeDefined();
    expect(enable?.inputSchema.required).toEqual(["syncId"]);

    // And `matchField` on create_sync, or an agent cannot set up a carrier
    // endpoint at all — the enable call refuses a patching provider without one.
    const create = integrationsTools.find((t) => t.name === "integrations.create_sync");
    expect((create?.inputSchema.properties as Record<string, any>).matchField).toBeDefined();
  });

  test("the secret does not appear on any read-back surface", async () => {
    // The one guard worth asserting across surfaces rather than per-surface: a
    // bearer credential the provider also holds must be returned once and never
    // again, and "never again" has to hold for every reader.
    const made = await client.integrations.connect({
      kind: "easypost",
      config: {
        apiKey: "EZTK_x",
        fromName: "W",
        fromStreet1: "1 St",
        fromCity: "C",
        fromZip: "1",
        fromCountry: "TR",
      },
    });
    await h.fetch(
      "/api/collections",
      json({
        slug: "parcels",
        fields: [
          { name: "shipment_id", type: "text" },
          { name: "state", type: "text" },
        ],
      }),
    );
    const sync = await client.integrations.createSync({
      integrationId: made.data.id,
      collection: "parcels",
      direction: "inbound",
      matchField: "shipment_id",
      mapping: { shipmentStatus: "state" },
    });

    const endpoint = await client.integrations.enableWebhook(sync.data.id);
    const secret = endpoint.data.secret;
    expect(secret).toBeTruthy();

    const overRest = await client.integrations.syncs();
    const overGraphql = await gql(`{ integrationSyncs { id webhook } }`);
    expect(JSON.stringify(overRest.data)).not.toContain(secret);
    expect(JSON.stringify(overGraphql.data)).not.toContain(secret);
    // …and the endpoint is still described on both, so the absence above is the
    // secret being withheld rather than the whole field being missing.
    expect(overRest.data[0]!.webhook?.path).toContain("/api/integrations/hooks/");
    expect(overGraphql.data?.integrationSyncs[0].webhook.registered).toBeDefined();
  });
});

/**
 * Listings across the surfaces.
 *
 * The taxonomy reads are the interesting half. They hang off the CONNECTION
 * rather than a sync on every surface, and they are the one part of this
 * feature that talks to the marketplace while an operator is still filling in
 * a form — so a surface that quietly required a sync first would make the whole
 * mapping flow impossible rather than merely inconvenient.
 */
describe("integrations — listings reach every surface", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;
  let integrationId: string;
  let syncId: string;
  const realFetch = globalThis.fetch;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string }[];
    };

  beforeAll(async () => {
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("trendyol.com/")) {
        const body = u.includes("/attributes")
          ? {
              categoryAttributes: [
                {
                  attribute: { id: 92, name: "Beden" },
                  attributeValues: [{ id: 5, name: "M" }],
                  required: true,
                  varianter: true,
                  allowCustom: false,
                  allowMultipleAttributeValues: false,
                },
              ],
            }
          : u.includes("/brands")
            ? [{ id: 1479, name: "Nike" }]
            : { categories: [{ id: 368, name: "Aksesuar", subCategories: [] }] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(url, init);
    }) as typeof fetch;

    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "http://localhost", fetch: h.fetch as typeof fetch });
    await h.fetch(
      "/api/collections",
      json({
        slug: "wares",
        fields: [
          { name: "title", type: "text" },
          { name: "kind", type: "text" },
          { name: "listing_status", type: "text" },
        ],
      }),
    );
    integrationId = (
      await (
        await h.fetch(
          "/api/admin/integrations",
          json({
            kind: "trendyol",
            config: {
              sellerId: "12345",
              apiKey: "k",
              apiSecret: "s",
              storeFrontCode: "TR",
              environment: "production",
            },
          }),
        )
      ).json()
    ).data.id;
    syncId = (
      await client.integrations.createSync({
        integrationId,
        collection: "wares",
        direction: "listing",
        settings: { vatRate: "20" },
        categoryField: "kind",
        mapping: { title: "title" },
        outputsMapping: { listingStatus: "listing_status" },
      })
    ).data.id;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    h.cleanup();
  });

  test("the SDK browses the taxonomy off the connection and maps a category", async () => {
    const cats = await client.integrations.listingCategories(integrationId);
    expect(cats.data[0]).toMatchObject({ id: "368", leaf: true, parentId: null });

    const attrs = await client.integrations.listingAttributes(integrationId, "368");
    expect(attrs.data[0]).toMatchObject({ id: "92", required: true, variant: true });

    const brands = await client.integrations.listingLookup(integrationId, {
      lookup: "brands",
      query: "nike",
    });
    expect(brands.data.items[0]).toEqual({ id: "1479", name: "Nike" });

    const mapped = await client.integrations.mapListingCategory(syncId, {
      localValue: "Saat",
      categoryId: "368",
      attributes: { "92": { field: "size" } },
    });
    expect(mapped.data).toMatchObject({ localValue: "Saat", categoryId: "368" });
    expect((await client.integrations.listingMaps(syncId)).data).toHaveLength(1);
    expect((await client.integrations.listingBatches(syncId)).data).toEqual([]);

    await client.integrations.unmapListingCategory(syncId, mapped.data.id);
    expect((await client.integrations.listingMaps(syncId)).data).toHaveLength(0);
  });

  test("GraphQL reaches the same four reads and both writes", async () => {
    const cats = await gql(
      `query($i:String!){ integrationListingCategories(integrationId:$i){ id name leaf } }`,
      { i: integrationId },
    );
    expect(cats.errors).toBeUndefined();
    expect(cats.data?.integrationListingCategories[0]).toMatchObject({ id: "368", leaf: true });

    const attrs = await gql(
      `query($i:String!,$c:String!){ integrationListingAttributes(integrationId:$i, categoryId:$c){ id required variant } }`,
      { i: integrationId, c: "368" },
    );
    expect(attrs.data?.integrationListingAttributes[0]).toMatchObject({ id: "92", variant: true });

    const mapped = await gql(
      `mutation($s:String!,$l:String!,$c:String!,$a:JSON){ mapIntegrationListingCategory(syncId:$s, localValue:$l, categoryId:$c, attributes:$a){ id localValue categoryId } }`,
      { s: syncId, l: "Kolye", c: "368", a: { "92": { valueId: "5" } } },
    );
    expect(mapped.errors).toBeUndefined();
    const mapId = mapped.data?.mapIntegrationListingCategory.id as string;

    const listed = await gql(`query($s:String!){ integrationListingMaps(syncId:$s){ id localValue } }`, {
      s: syncId,
    });
    expect(listed.data?.integrationListingMaps).toHaveLength(1);

    const batches = await gql(`query($s:String!){ integrationListingBatches(syncId:$s){ id status } }`, {
      s: syncId,
    });
    expect(batches.data?.integrationListingBatches).toEqual([]);

    await gql(
      `mutation($s:String!,$m:String!){ unmapIntegrationListingCategory(syncId:$s, mapId:$m) }`,
      { s: syncId, m: mapId },
    );
    expect(
      (await gql(`query($s:String!){ integrationListingMaps(syncId:$s){ id } }`, { s: syncId })).data
        ?.integrationListingMaps,
    ).toHaveLength(0);
  });

  test("GraphQL guards a binding whose value is not a string", async () => {
    // This surface hands the service RAW input where REST hands it zod-parsed
    // input, so a number here would reach the provider as `NaN` and be refused
    // with a reason nobody can act on.
    const res = await gql(
      `mutation($s:String!,$a:JSON){ mapIntegrationListingCategory(syncId:$s, localValue:"X", categoryId:"368", attributes:$a){ attributes } }`,
      { s: syncId, a: { "92": { valueId: 5 } } },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.mapIntegrationListingCategory.attributes).toEqual({});
  });

  test("MCP declares the six listing tools with closed schemas", () => {
    const names = integrationsTools.map((t) => t.name);
    for (const n of [
      "integrations.listing_categories",
      "integrations.listing_attributes",
      "integrations.listing_lookup",
      "integrations.listing_maps",
      "integrations.map_listing_category",
      "integrations.listing_batches",
    ]) {
      expect(names).toContain(n);
      const tool = integrationsTools.find((t) => t.name === n)!;
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});
