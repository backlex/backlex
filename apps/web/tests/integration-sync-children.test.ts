/**
 * Parent+child pulls — one external record landing in two collections.
 *
 * Every source before this pulled a flat record. A marketplace order is a
 * header plus its lines, and the assertions that matter are the ones a flat
 * mapping cannot make:
 *
 *   - lines land in their own collection, linked to the header
 *   - two orders whose lines both number from 1 do not collide
 *   - a re-pull updates the lines rather than duplicating them
 *   - a child group cannot be aimed at another workspace's collection
 *
 * `pullFromSource` is mocked because no shipped provider returns children yet —
 * the first one that will is the marketplace connector this engine work is for.
 * The real module is captured before mocking and restored afterwards, because
 * `bun test` shares one module registry across files and a leaked mock would
 * break the sibling integration specs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as realIntegrations from "@backlex/integrations";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BASE = "/api/admin/integrations";
const SYNCS = `${BASE}/syncs`;

let h: TestHarness;
let client: Database;
let integrationId: string;
let ordersTable: string;
let linesTable: string;

// Captured BEFORE any mocking. An ES module namespace is a set of live
// bindings, so `realIntegrations.pullFromSource` would itself resolve to the
// stub once `mock.module` is in force — restoring from the namespace would
// reinstall the mock and leak it into every sibling suite.
const realPullFromSource = realIntegrations.pullFromSource;

/** What the mocked source hands back on the next run. */
let nextPage: { records: unknown[]; cursor: string | null } = { records: [], cursor: null };

const req = async (method: string, path: string, body?: unknown) =>
  h.fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

const ok = async (method: string, path: string, body?: unknown) => {
  const res = await req(method, path, body);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as any;
};

const runInline = async (syncId: string) => {
  const { runSync } = await import("../src/server/services/integration-syncs");
  const { buildContext } = await import("../src/server/context");
  const ctx = await buildContext(h.env);
  const tenantId = (
    client.query("select tenant_id as t from integration_syncs where id = ?").get(syncId) as { t: string }
  ).t;
  return runSync(ctx, tenantId, syncId);
};

const physical = (slug: string) =>
  (client.query("select physical_table as t from collections where slug = ?").get(slug) as { t: string }).t;

const rowsOf = (table: string) =>
  client.query(`select * from "${table}" order by id`).all() as Record<string, unknown>[];

beforeAll(async () => {
  // Installed here rather than at module scope: `bun test` loads every spec
  // file before running any of them, so a top-level `mock.module` would be in
  // force while the sibling integration suites run and would stub out the real
  // pull they depend on.
  mock.module("@backlex/integrations", () => ({
    ...realIntegrations,
    pullFromSource: async () => nextPage,
  }));

  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);

  await ok("POST", "/api/collections", {
    slug: "orders",
    fields: [
      { name: "number", type: "text" },
      { name: "total", type: "number" },
    ],
  });
  await ok("POST", "/api/collections", {
    slug: "order_lines",
    fields: [
      { name: "order", type: "text" },
      { name: "sku", type: "text" },
      { name: "qty", type: "number" },
    ],
  });
  ordersTable = physical("orders");
  linesTable = physical("order_lines");

  const connected = await ok("POST", BASE, {
    kind: "google-sheets",
    config: { clientId: "cid", clientSecret: "csecret" },
  });
  integrationId = connected.data.id;
  const row = client.query("select config from integrations where id = ?").get(integrationId) as {
    config: string;
  };
  client
    .query("update integrations set config = ? where id = ?")
    .run(JSON.stringify({ ...JSON.parse(row.config), _oauthAccessToken: "t" }), integrationId);
});

afterAll(() => {
  mock.module("@backlex/integrations", () => ({
    ...realIntegrations,
    pullFromSource: realPullFromSource,
  }));
  h.cleanup();
});

const VALID = {
  collection: "orders",
  settings: { spreadsheetId: "s1", sheetName: "Sheet1" },
  mapping: { orderNumber: "number", grandTotal: "total" },
  childMappings: {
    items: {
      collection: "order_lines",
      parentField: "order",
      mapping: { sku: "sku", quantity: "qty" },
    },
  },
};

const makeSync = async (over: Record<string, unknown> = {}) =>
  (await ok("POST", SYNCS, { integrationId, ...VALID, ...over })).data;

beforeEach(() => {
  client.query("delete from integration_syncs").run();
  client.query(`delete from "${ordersTable}"`).run();
  client.query(`delete from "${linesTable}"`).run();
  nextPage = { records: [], cursor: null };
});

describe("pulling a record with children", () => {
  test("the header and its lines land in their own collections, linked", async () => {
    const sync = await makeSync();
    nextPage = {
      records: [
        {
          externalId: "ORD-1",
          data: { orderNumber: "ORD-1", grandTotal: 90 },
          children: {
            items: [
              { externalId: "1", data: { sku: "TEE-S", quantity: 2 } },
              { externalId: "2", data: { sku: "TOTE", quantity: 1 } },
            ],
          },
        },
      ],
      cursor: null,
    };

    const out = await runInline(sync.id);
    // Every row the run wrote, headers and lines alike — reporting only the
    // headers would tell an operator "1 row" for an import of three.
    expect(out.written).toBe(3);

    const orders = rowsOf(ordersTable);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.number).toBe("ORD-1");

    const lines = rowsOf(linesTable);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.sku).sort()).toEqual(["TEE-S", "TOTE"]);
    // The link is the parent's own namespaced id, not anything from the payload.
    for (const line of lines) expect(line.order).toBe(orders[0]!.id as string);
  });

  test("two orders numbering their lines from 1 do not collide", async () => {
    // This is the whole reason a child id is qualified by its parent: a provider
    // that numbers lines within an order would otherwise have every order's
    // first line share one primary key, and each order would overwrite the
    // previous one's lines.
    const sync = await makeSync();
    nextPage = {
      records: [
        {
          externalId: "ORD-1",
          data: { orderNumber: "ORD-1" },
          children: { items: [{ externalId: "1", data: { sku: "A", quantity: 1 } }] },
        },
        {
          externalId: "ORD-2",
          data: { orderNumber: "ORD-2" },
          children: { items: [{ externalId: "1", data: { sku: "B", quantity: 5 } }] },
        },
      ],
      cursor: null,
    };

    await runInline(sync.id);
    const lines = rowsOf(linesTable);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.sku).sort()).toEqual(["A", "B"]);
    expect(new Set(lines.map((l) => l.id)).size).toBe(2);
  });

  test("re-pulling the same order updates its lines instead of duplicating them", async () => {
    const sync = await makeSync();
    const page = (qty: number) => ({
      records: [
        {
          externalId: "ORD-1",
          data: { orderNumber: "ORD-1" },
          children: { items: [{ externalId: "1", data: { sku: "A", quantity: qty } }] },
        },
      ],
      cursor: null,
    });

    nextPage = page(1);
    await runInline(sync.id);
    nextPage = page(7);
    await runInline(sync.id);

    const lines = rowsOf(linesTable);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.qty).toBe(7);
  });

  test("a group the sync has no mapping for is ignored, not an error", async () => {
    // A provider may return more groups than the operator kept. Refusing those
    // would make adding a group to a provider a breaking change for every
    // existing sync.
    const sync = await makeSync();
    nextPage = {
      records: [
        {
          externalId: "ORD-1",
          data: { orderNumber: "ORD-1" },
          children: {
            items: [{ externalId: "1", data: { sku: "A", quantity: 1 } }],
            discounts: [{ externalId: "d1", data: { code: "SUMMER" } }],
          },
        },
      ],
      cursor: null,
    };

    await expect(runInline(sync.id)).resolves.toBeDefined();
    expect(rowsOf(linesTable)).toHaveLength(1);
  });

  test("a record with no children still imports its header", async () => {
    const sync = await makeSync();
    nextPage = {
      records: [{ externalId: "ORD-9", data: { orderNumber: "ORD-9" } }],
      cursor: null,
    };
    const out = await runInline(sync.id);
    expect(out.written).toBe(1);
    expect(rowsOf(ordersTable)).toHaveLength(1);
    expect(rowsOf(linesTable)).toHaveLength(0);
  });
});

describe("validating child mappings", () => {
  test("an unknown child field is refused at save time", async () => {
    // Dropped by ingestRows otherwise, and the run would report a clean import
    // having lost a column off every line.
    const res = await req("POST", SYNCS, {
      integrationId,
      ...VALID,
      childMappings: {
        items: { collection: "order_lines", parentField: "order", mapping: { sku: "nope" } },
      },
    });
    expect(res.status).toBe(422);
  });

  test("a child group naming an unknown collection is refused", async () => {
    // `loadCollection` resolves within the caller's tenant, so this is also what
    // stops a group being aimed at another workspace's table by slug.
    const res = await req("POST", SYNCS, {
      integrationId,
      ...VALID,
      childMappings: {
        items: { collection: "someone_elses_table", parentField: "order", mapping: { sku: "sku" } },
      },
    });
    expect([404, 422]).toContain(res.status);
  });

  test("a parentField that is not a writable field is refused", async () => {
    const res = await req("POST", SYNCS, {
      integrationId,
      ...VALID,
      childMappings: {
        items: { collection: "order_lines", parentField: "not_a_column", mapping: { sku: "sku" } },
      },
    });
    expect(res.status).toBe(422);
  });

  test("child mappings are refused on a push sync", async () => {
    // A push walks one collection's watermark; there is no second collection in
    // that direction, so accepting the field would store something inert.
    const bq = await ok("POST", BASE, {
      kind: "clickhouse",
      config: { url: "https://ch.test", username: "u", password: "p", database: "d" },
    });
    const res = await req("POST", SYNCS, {
      integrationId: bq.data.id,
      collection: "orders",
      direction: "push",
      settings: { table: "orders" },
      mapping: { number: "number" },
      childMappings: {
        items: { collection: "order_lines", parentField: "order", mapping: { sku: "sku" } },
      },
    });
    expect(res.status).toBe(422);
  });
});
