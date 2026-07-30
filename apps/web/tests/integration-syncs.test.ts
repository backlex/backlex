/**
 * Source syncs — scheduled pulls from an integration into a collection.
 *
 * A sync writes rows into ordinary business collections on a timer, driven by
 * settings an admin typed and a cursor a third party handed back. The
 * assertions that matter are about what it must NOT do:
 *
 *   - reach another workspace's sync, or another workspace's collection
 *   - overwrite a row a person created, or a row a different sync owns
 *   - report a clean run when rows were rejected, or advance past a failed page
 *   - accept a setting the provider never declared
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BASE = "/api/admin/integrations";
const SYNCS = `${BASE}/syncs`;

let h: TestHarness;
let client: Database;
let integrationId: string;

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

/** A Sheets response: first call is the header row, second the data rows. */
const sheetsFetch = (headerRow: string[], dataRows: unknown[][]) => {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const isHeader = url.includes("A1%3AZZ1") || url.includes("!A1:ZZ1");
    return new Response(JSON.stringify({ values: isHeader ? [headerRow] : dataRows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return Object.assign(fn, { calls });
};

/** The physical table name is `c_<tenant-prefix>_<slug>`, so it is read from
 *  the metadata row rather than guessed. */
let leadsTable: string;
const leadRows = () =>
  client.query(`select * from "${leadsTable}" order by id`).all() as Record<string, unknown>[];

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);

  await ok("POST", "/api/collections", {
    slug: "leads",
    fields: [
      { name: "name", type: "text" },
      { name: "email", type: "text" },
      { name: "score", type: "number" },
    ],
  });

  leadsTable = (
    client.query("select physical_table as t from collections where slug = 'leads'").get() as { t: string }
  ).t;

  const connected = await ok("POST", BASE, {
    kind: "google-sheets",
    config: { clientId: "cid", clientSecret: "csecret" },
  });
  integrationId = connected.data.id;
  // The pull needs a token; the OAuth flow is covered by its own spec, so put
  // one straight in the row rather than driving the redirect here.
  const row = client.query("select config from integrations where id = ?").get(integrationId) as {
    config: string;
  };
  const config = { ...JSON.parse(row.config), _oauthAccessToken: "sheets-token" };
  client.query("update integrations set config = ? where id = ?").run(JSON.stringify(config), integrationId);
});
afterAll(() => h.cleanup());

const VALID = {
  collection: "leads",
  settings: { spreadsheetId: "sheet-1", sheetName: "Sheet1" },
  mapping: { Name: "name", Email: "email" },
};

const makeSync = async (over: Record<string, unknown> = {}) =>
  (await ok("POST", SYNCS, { integrationId, ...VALID, ...over })).data;

beforeEach(() => {
  client.query("delete from integration_syncs").run();
  client.query(`delete from "${leadsTable}"`).run();
});

describe("creating a sync", () => {
  test("a sync is bound to the caller's workspace", async () => {
    const sync = await makeSync();
    const row = client
      .query("select tenant_id as tenantId from integration_syncs where id = ?")
      .get(sync.id) as { tenantId: string | null };
    expect(row.tenantId).not.toBeNull();
  });

  test("a provider that cannot pull is refused", async () => {
    const slack = await ok("POST", BASE, {
      kind: "slack",
      config: { webhookUrl: "https://hooks.slack.test/x" },
    });
    const res = await req("POST", SYNCS, { integrationId: slack.data.id, ...VALID });
    expect(res.status).toBe(400);
  });

  test("a setting the provider never declared is refused, not passed along", async () => {
    // Settings reach the provider and end up in URLs, so an unrecognised key is
    // an error rather than something to forward on the chance it is read.
    const res = await req("POST", SYNCS, {
      integrationId,
      ...VALID,
      settings: { ...VALID.settings, apiHost: "https://attacker.test" },
    });
    expect(res.status).toBe(422);
  });

  test("a required setting cannot be omitted", async () => {
    const res = await req("POST", SYNCS, { integrationId, ...VALID, settings: { sheetName: "Sheet1" } });
    expect(res.status).toBe(422);
  });

  test("a mapping target that is not a field is refused", async () => {
    // Left to `ingestRows` this would be silently dropped and the run would
    // report success while losing a column every time.
    const res = await req("POST", SYNCS, {
      integrationId,
      ...VALID,
      mapping: { Name: "name", Phone: "phone_number_that_does_not_exist" },
    });
    expect(res.status).toBe(422);
  });

  test("an empty mapping is refused", async () => {
    const res = await req("POST", SYNCS, { integrationId, ...VALID, mapping: {} });
    expect(res.status).toBe(422);
  });

  test("an unknown collection is refused", async () => {
    const res = await req("POST", SYNCS, { integrationId, ...VALID, collection: "not_a_collection" });
    expect([404, 422]).toContain(res.status);
  });

  test("a choice setting only accepts a value from its own list", async () => {
    // Providers interpolate these into query strings and URL paths. Each one
    // re-checks its own value, but the closed list is declared once and the
    // form must not be able to submit past it.
    client.query("delete from integrations where kind = 'quickbooks'").run();
    const qb = await ok("POST", BASE, {
      kind: "quickbooks",
      config: { clientId: "cid", clientSecret: "sec" },
    });
    const res = await req("POST", SYNCS, {
      integrationId: qb.data.id,
      collection: "leads",
      settings: { entity: "Customer'; drop table x --", environment: "production" },
      mapping: { Id: "name" },
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("must be one of");
  });

  test("an out-of-range interval is refused rather than clamped", async () => {
    // Clamping would let a caller build a schedule on a number nobody agreed to.
    expect((await req("POST", SYNCS, { integrationId, ...VALID, intervalMinutes: 99_999 })).status).toBe(422);
  });
});

describe("cross-workspace access", () => {
  test("another workspace's sync cannot be read, updated, deleted or run", async () => {
    const foreignId = crypto.randomUUID();
    client
      .query(
        `insert into integration_syncs (id, integration_id, tenant_id, collection, settings, mapping,
          interval_minutes, enabled, last_row_count, consecutive_failures, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        foreignId, integrationId, "some-other-tenant", "leads", "{}", "{}", 60, 1, 0, 0,
        Date.now(), Date.now(),
      );

    const list = await ok("GET", SYNCS);
    expect(list.data.some((s: { id: string }) => s.id === foreignId)).toBe(false);

    expect((await req("PATCH", `${SYNCS}/${foreignId}`, { enabled: false })).status).toBe(404);
    expect((await req("POST", `${SYNCS}/${foreignId}/run`)).status).toBe(404);

    // DELETE is a no-op rather than an error, but it must not remove the row.
    await req("DELETE", `${SYNCS}/${foreignId}`);
    const still = client
      .query("select count(*) as n from integration_syncs where id = ?")
      .get(foreignId) as { n: number };
    expect(still.n).toBe(1);
    client.query("delete from integration_syncs where id = ?").run(foreignId);
  });

  test("every endpoint refuses an unauthenticated caller", async () => {
    const anon = makeHarness();
    try {
      for (const [method, path] of [
        ["GET", SYNCS],
        ["POST", SYNCS],
        ["PATCH", `${SYNCS}/x`],
        ["DELETE", `${SYNCS}/x`],
        ["POST", `${SYNCS}/x/run`],
      ] as const) {
        const res = await anon.fetch(path, {
          method,
          ...(method === "GET" || method === "DELETE"
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify({}) }),
        });
        expect([401, 403], `${method} ${path}`).toContain(res.status);
      }
    } finally {
      anon.cleanup();
    }
  });
});

describe("running a sync", () => {
  const runInline = async (syncId: string, fetchImpl: unknown) => {
    const { runSync } = await import("../src/server/services/integration-syncs");
    const { buildContext } = await import("../src/server/context");
    const ctx = await buildContext(h.env);
    const tenantId = (
      client.query("select tenant_id as t from integration_syncs where id = ?").get(syncId) as {
        t: string;
      }
    ).t;
    return runSync(ctx, tenantId, syncId, fetchImpl as never);
  };

  test("mapped columns land, unmapped ones are dropped", async () => {
    const sync = await makeSync();
    const out = await runInline(
      sync.id,
      sheetsFetch(["Name", "Email", "Secret"], [["Ada", "ada@example.test", "not-mapped"]]),
    );
    expect(out.written).toBe(1);

    const rows = leadRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Ada");
    expect(rows[0]!.email).toBe("ada@example.test");
    // "Secret" has no mapping, so it has nowhere to land — and must not be
    // guessed into a same-named column.
    expect(Object.values(rows[0]!)).not.toContain("not-mapped");
  });

  test("the primary key is namespaced, so a re-pull updates in place", async () => {
    const sync = await makeSync();
    await runInline(sync.id, sheetsFetch(["Name", "Email"], [["Ada", "ada@example.test"]]));
    const first = leadRows();
    expect(String(first[0]!.id)).toStartWith("google-sheets_");

    await runInline(sync.id, sheetsFetch(["Name", "Email"], [["Ada Lovelace", "ada@example.test"]]));
    const second = leadRows();
    expect(second).toHaveLength(1);
    expect(second[0]!.name).toBe("Ada Lovelace");
    expect(second[0]!.id).toBe(first[0]!.id);
  });

  test("a row a person created is never overwritten", async () => {
    // Sheets numbers its rows from 2, so an external id of "2" is guaranteed —
    // without the namespace it would land on any collection row keyed "2".
    // Written straight to the table so the id can be forced; the API assigns
    // its own, and the id is the whole point of this test.
    client
      .query(`insert into "${leadsTable}" (id, tenant_id, name, email, created_at, updated_at)
              values ('2', (select tenant_id from integrations limit 1), 'Hand-entered',
                      'human@example.test', ?, ?)`)
      .run(Date.now(), Date.now());
    const sync = await makeSync();
    await runInline(sync.id, sheetsFetch(["Name", "Email"], [["Ada", "ada@example.test"]]));

    const human = client
      .query(`select * from "${leadsTable}" where id = '2'`)
      .get() as { name: string };
    expect(human.name).toBe("Hand-entered");
    expect(leadRows()).toHaveLength(2);
  });

  test("two syncs into one collection do not collide", async () => {
    // Both sheets number their rows from 2. Namespacing only by provider would
    // make the second sync silently overwrite the first.
    const a = await makeSync({ settings: { spreadsheetId: "sheet-a", sheetName: "Sheet1" } });
    const b = await makeSync({ settings: { spreadsheetId: "sheet-b", sheetName: "Sheet1" } });
    await runInline(a.id, sheetsFetch(["Name", "Email"], [["From A", "a@example.test"]]));
    await runInline(b.id, sheetsFetch(["Name", "Email"], [["From B", "b@example.test"]]));

    const names = leadRows().map((r) => r.name).sort();
    expect(names).toEqual(["From A", "From B"]);
  });

  test("a short page completes the run and clears the cursor", async () => {
    const sync = await makeSync();
    const out = await runInline(sync.id, sheetsFetch(["Name"], [["Ada"]]));
    expect(out.complete).toBe(true);
    const row = client.query("select cursor from integration_syncs where id = ?").get(sync.id) as {
      cursor: string | null;
    };
    expect(row.cursor).toBeNull();
  });

  test("a failed page leaves the cursor alone so the rows are re-read", async () => {
    const sync = await makeSync();
    const failing = async () => new Response("nope", { status: 500 });
    await expect(runInline(sync.id, failing)).rejects.toThrow();
    const row = client
      .query("select cursor, last_error as lastError, consecutive_failures as failures from integration_syncs where id = ?")
      .get(sync.id) as { cursor: string | null; lastError: string; failures: number };
    // Advancing here would skip a page of rows with nothing to show for it.
    expect(row.cursor).toBeNull();
    expect(row.failures).toBe(1);
    expect(row.lastError).toContain("500");
  });

  test("five consecutive failures pause the sync with a reason", async () => {
    const sync = await makeSync();
    const failing = async () => new Response("nope", { status: 500 });
    for (let i = 0; i < 5; i++) {
      await expect(runInline(sync.id, failing)).rejects.toThrow();
    }
    const row = client
      .query("select enabled, disabled_reason as reason from integration_syncs where id = ?")
      .get(sync.id) as { enabled: number; reason: string };
    expect(row.enabled).toBe(0);
    expect(row.reason).toContain("consecutive failed runs");
  });

  test("a successful run clears the failure state", async () => {
    const sync = await makeSync();
    await expect(runInline(sync.id, async () => new Response("nope", { status: 500 }))).rejects.toThrow();
    await runInline(sync.id, sheetsFetch(["Name"], [["Ada"]]));
    const row = client
      .query("select consecutive_failures as failures, last_error as lastError, last_row_count as n from integration_syncs where id = ?")
      .get(sync.id) as { failures: number; lastError: string | null; n: number };
    expect(row.failures).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.n).toBe(1);
  });

  test("an empty sheet is a clean no-op, not a failure", async () => {
    const sync = await makeSync();
    const out = await runInline(sync.id, sheetsFetch([], []));
    expect(out.written).toBe(0);
    expect(out.complete).toBe(true);
  });

  test("a revoked OAuth grant reports re-authorization rather than retrying", async () => {
    const sync = await makeSync();
    const row = client.query("select config from integrations where id = ?").get(integrationId) as {
      config: string;
    };
    const stripped = { ...JSON.parse(row.config) };
    delete stripped._oauthAccessToken;
    client
      .query("update integrations set config = ? where id = ?")
      .run(JSON.stringify(stripped), integrationId);
    try {
      await expect(runInline(sync.id, sheetsFetch(["Name"], [["Ada"]]))).rejects.toThrow(
        /re-authorizing/,
      );
    } finally {
      client.query("update integrations set config = ? where id = ?").run(row.config, integrationId);
    }
  });
});

describe("updating a sync", () => {
  test("changing the settings resets the cursor", async () => {
    const sync = await makeSync();
    client.query("update integration_syncs set cursor = '500' where id = ?").run(sync.id);
    await ok("PATCH", `${SYNCS}/${sync.id}`, {
      settings: { spreadsheetId: "a-different-sheet", sheetName: "Sheet1" },
    });
    const row = client.query("select cursor from integration_syncs where id = ?").get(sync.id) as {
      cursor: string | null;
    };
    // A row offset from one spreadsheet points at unrelated rows in another.
    expect(row.cursor).toBeNull();
  });

  test("re-enabling clears the breaker so it does not trip again instantly", async () => {
    const sync = await makeSync();
    client
      .query(
        "update integration_syncs set enabled = 0, consecutive_failures = 5, disabled_reason = 'x' where id = ?",
      )
      .run(sync.id);
    const res = await ok("PATCH", `${SYNCS}/${sync.id}`, { enabled: true });
    expect(res.data.enabled).toBe(true);
    expect(res.data.consecutiveFailures).toBe(0);
    expect(res.data.disabledReason).toBeNull();
  });

  test("the resume cursor is reported as a flag, never as its value", async () => {
    const sync = await makeSync();
    client.query("update integration_syncs set cursor = 'opaque-provider-token' where id = ?").run(sync.id);
    const list = await ok("GET", SYNCS);
    // The provider's token means nothing to a UI and is not ours to publish.
    expect(JSON.stringify(list)).not.toContain("opaque-provider-token");
    expect(list.data[0].resuming).toBe(true);
  });
});

describe("scheduling", () => {
  const enqueue = async () => {
    const { enqueueDueSyncs } = await import("../src/server/services/integration-syncs");
    const { buildContext } = await import("../src/server/context");
    return enqueueDueSyncs(await buildContext(h.env));
  };

  beforeEach(() => {
    client.query("delete from jobs").run();
  });

  test("a never-run sync is due", async () => {
    await makeSync();
    expect(await enqueue()).toBe(1);
    const job = client.query("select type, tenant_id as tenantId from jobs").get() as {
      type: string;
      tenantId: string | null;
    };
    expect(job.type).toBe("integration.sync");
    // runSync scopes every query by this; a job without it has nothing to
    // scope by and would fall through to another workspace's rows.
    expect(job.tenantId).not.toBeNull();
  });

  test("a manual-only sync is never enqueued", async () => {
    await makeSync({ intervalMinutes: 0 });
    expect(await enqueue()).toBe(0);
  });

  test("a disabled sync is never enqueued", async () => {
    await makeSync({ enabled: false });
    expect(await enqueue()).toBe(0);
  });

  test("a sync that ran recently waits out its interval", async () => {
    const sync = await makeSync({ intervalMinutes: 60 });
    client.query("update integration_syncs set last_run_at = ? where id = ?").run(Date.now(), sync.id);
    expect(await enqueue()).toBe(0);
  });

  test("a hand-enqueued job cannot reach another workspace's sync", async () => {
    // `enqueueJob` takes the tenant from the session, not the body, so the
    // only way across would be the handler falling back to "no tenant". It
    // must refuse instead — this is the fail-open shape that matters here.
    const sync = await makeSync();
    const { runSync } = await import("../src/server/services/integration-syncs");
    const { buildContext } = await import("../src/server/context");
    const ctx = await buildContext(h.env);
    await expect(runSync(ctx, "some-other-tenant", sync.id)).rejects.toThrow(/not found/i);
  });

  test("a run left mid-cursor is due immediately", async () => {
    const sync = await makeSync({ intervalMinutes: 1440 });
    client
      .query("update integration_syncs set last_run_at = ?, cursor = '500' where id = ?")
      .run(Date.now(), sync.id);
    // It has more pages waiting; sitting out a whole day would stall an import.
    expect(await enqueue()).toBe(1);
  });
});

// Every surface reaches the same service, so the two properties that make a
// sync safe have to survive the trip: it stays inside the caller's workspace,
// and the provider's resume token stays out of the response.
describe("multi-surface parity", () => {
  const gql = async (query: string, variables?: unknown) =>
    (await (
      await h.fetch("/api/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      })
    ).json()) as { data?: Record<string, any>; errors?: { extensions?: { code?: string } }[] };

  test("GraphQL creates, lists, runs and deletes", async () => {
    const made = await gql(
      `mutation($d:IntegrationSyncInput!){ createIntegrationSync(data:$d){ id collection intervalMinutes } }`,
      { d: { integrationId, collection: "leads", settings: VALID.settings, mapping: VALID.mapping } },
    );
    expect(made.errors).toBeUndefined();
    const id = made.data?.createIntegrationSync.id as string;

    const listed = await gql(`{ integrationSyncs { id resuming } }`);
    expect(listed.data?.integrationSyncs).toHaveLength(1);

    const patched = await gql(
      `mutation($i:String!,$d:IntegrationSyncInput!){ updateIntegrationSync(id:$i,data:$d){ intervalMinutes } }`,
      { i: id, d: { intervalMinutes: 15 } },
    );
    expect(patched.data?.updateIntegrationSync.intervalMinutes).toBe(15);

    expect((await gql(`mutation($i:String!){ deleteIntegrationSync(id:$i) }`, { i: id })).errors).toBeUndefined();
  });

  test("GraphQL refuses a mapping target that is not a field", async () => {
    const res = await gql(
      `mutation($d:IntegrationSyncInput!){ createIntegrationSync(data:$d){ id } }`,
      {
        d: {
          integrationId,
          collection: "leads",
          settings: VALID.settings,
          mapping: { Name: "nope_not_a_field" },
        },
      },
    );
    expect(res.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("every GraphQL sync field refuses an unauthenticated caller", async () => {
    const anon = makeHarness();
    try {
      const probes: { query: string; variables?: unknown }[] = [
        { query: `{ integrationSyncs { id } }` },
        {
          query: `mutation($d:IntegrationSyncInput!){ createIntegrationSync(data:$d){ id } }`,
          variables: { d: { integrationId: "x", collection: "leads", mapping: { A: "name" } } },
        },
        {
          query: `mutation($d:IntegrationSyncInput!){ updateIntegrationSync(id:"x", data:$d){ id } }`,
          variables: { d: { enabled: false } },
        },
        { query: `mutation{ deleteIntegrationSync(id:"x") }` },
        { query: `mutation{ runIntegrationSync(id:"x"){ written } }` },
      ];
      for (const probe of probes) {
        const res = (await (
          await anon.fetch("/api/graphql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(probe),
          })
        ).json()) as { errors?: { extensions?: { code?: string } }[] };
        expect(["FORBIDDEN", "UNAUTHORIZED"], probe.query).toContain(res.errors?.[0]?.extensions?.code);
      }
    } finally {
      anon.cleanup();
    }
  });

  test("the SDK round-trips a sync", async () => {
    const { createClient } = await import("../../../packages/client/src/index");
    const client = createClient({ url: "http://localhost", fetch: h.fetch as typeof fetch });
    const made = await client.integrations.createSync({
      integrationId,
      collection: "leads",
      settings: VALID.settings,
      mapping: VALID.mapping,
    });
    expect(made.data.collection).toBe("leads");
    expect((await client.integrations.syncs()).data).toHaveLength(1);
    expect((await client.integrations.updateSync(made.data.id, { enabled: false })).data.enabled).toBe(false);
    expect((await client.integrations.deleteSync(made.data.id)).ok).toBe(true);
  });

  test("the MCP tool group covers the whole sync surface", async () => {
    const { integrationsTools } = await import("../src/server/mcp/tools/integrations");
    const names = integrationsTools.map((t) => t.name);
    for (const n of [
      "integrations.syncs",
      "integrations.create_sync",
      "integrations.update_sync",
      "integrations.delete_sync",
      "integrations.run_sync",
    ]) {
      expect(names).toContain(n);
    }
    const create = integrationsTools.find((t) => t.name === "integrations.create_sync")!;
    const schema = create.inputSchema as { required?: string[]; additionalProperties?: boolean };
    // Without a mapping the sync writes rows that are nothing but ids, so an
    // agent must not be able to omit it.
    expect(schema.required).toContain("mapping");
    expect(schema.additionalProperties).toBe(false);
  });
});
