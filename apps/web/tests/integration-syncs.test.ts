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

// Pushing a collection out to a warehouse. The correctness question here is
// entirely about the watermark: a plain `updated_at >` skips every row sharing
// the last timestamp, `>=` re-sends one forever, and advancing before the push
// resolves loses a batch on the first network blip.
// A provider with a real incremental marker ends its run with a token that says
// where the NEXT one starts. Discarding it turns an incremental sync into a full
// re-read every time — which still "works", and is why it needs a test.
describe("a source that resumes incrementally", () => {
  const runInline = async (syncId: string, fetchImpl: unknown) => {
    const { runSync } = await import("../src/server/services/integration-syncs");
    const { buildContext } = await import("../src/server/context");
    const ctx = await buildContext(h.env);
    const tid = (
      client.query("select tenant_id as t from integration_syncs where id = ?").get(syncId) as { t: string }
    ).t;
    return runSync(ctx, tid, syncId, fetchImpl as never);
  };

  test("the resume token is stored as the cursor once the run completes", async () => {
    client.query("delete from integrations where kind = 'google-calendar'").run();
    const cal = await ok("POST", BASE, {
      kind: "google-calendar",
      config: { clientId: "cid", clientSecret: "sec" },
    });
    const row = client.query("select config from integrations where id = ?").get(cal.data.id) as {
      config: string;
    };
    client
      .query("update integrations set config = ? where id = ?")
      .run(JSON.stringify({ ...JSON.parse(row.config), _oauthAccessToken: "tok" }), cal.data.id);

    const sync = (await ok("POST", SYNCS, {
      integrationId: cal.data.id,
      collection: "leads",
      settings: { calendarId: "primary" },
      mapping: { summary: "name" },
    })).data;

    const out = await runInline(sync.id, async () =>
      new Response(JSON.stringify({ items: [{ id: "e1", summary: "Standup" }], nextSyncToken: "st-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(out.complete).toBe(true);

    const stored = client.query("select cursor from integration_syncs where id = ?").get(sync.id) as {
      cursor: string | null;
    };
    // A page-walk source stores null here and starts over; this one carries the
    // token so the next run sees only what changed — including cancellations.
    expect(stored.cursor).toBe("s:st-1");
  });
});

describe("push: mirroring a collection out", () => {
  let chId = "";

  const connectClickhouse = async () => {
    client.query("delete from integrations where kind = 'clickhouse'").run();
    const res = await ok("POST", BASE, {
      kind: "clickhouse",
      config: { url: "https://ch.test:8443", username: "default", password: "pw", database: "default" },
    });
    return res.data.id as string;
  };

  /** Collect what each push actually sent. */
  const captureFetch = (fail = false) => {
    const batches: Record<string, unknown>[][] = [];
    const fn = async (_url: string, init?: RequestInit) => {
      const rows = String(init?.body ?? "")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      batches.push(rows);
      return fail
        ? new Response("Code: 60. Unknown table", { status: 404 })
        : new Response("", { status: 200 });
    };
    return Object.assign(fn, { batches });
  };

  const runInline = async (syncId: string, fetchImpl: unknown) => {
    const { runSync } = await import("../src/server/services/integration-syncs");
    const { buildContext } = await import("../src/server/context");
    const ctx = await buildContext(h.env);
    const tid = (
      client.query("select tenant_id as t from integration_syncs where id = ?").get(syncId) as { t: string }
    ).t;
    return runSync(ctx, tid, syncId, fetchImpl as never);
  };

  beforeEach(async () => {
    chId = await connectClickhouse();
    const tid = (client.query("select tenant_id as t from integrations where id = ?").get(chId) as {
      t: string;
    }).t;
    // Rebind the seed helper's placeholder to the real tenant.
    (globalThis as any).__leadTenant = tid;
  });

  const seed = (rows: { id: string; name: string; updatedAt: number }[]) => {
    const tid = (globalThis as any).__leadTenant as string;
    for (const r of rows) {
      client
        .query(`insert into "${leadsTable}" (id, tenant_id, name, email, created_at, updated_at)
                values (?,?,?,?,?,?)`)
        .run(r.id, tid, r.name, `${r.id}@example.test`, r.updatedAt, r.updatedAt);
    }
  };

  const makePush = async () =>
    (await ok("POST", SYNCS, {
      integrationId: chId,
      collection: "leads",
      direction: "push",
      settings: { table: "leads" },
      mapping: { name: "customer_name", email: "customer_email" },
    })).data;

  test("a source-only provider cannot be a destination, and vice versa", async () => {
    // Google Sheets pulls; ClickHouse receives. Asking either to do the other
    // fails at creation rather than on the first run.
    const res = await req("POST", SYNCS, {
      integrationId,
      collection: "leads",
      direction: "push",
      settings: { table: "leads" },
      mapping: { name: "customer_name" },
    });
    expect(res.status).toBe(400);

    const other = await req("POST", SYNCS, {
      integrationId: chId,
      collection: "leads",
      direction: "pull",
      settings: { spreadsheetId: "x", sheetName: "Sheet1" },
      mapping: { Name: "name" },
    });
    expect(other.status).toBe(400);
  });

  test("mapped columns are renamed and the primary key always travels", async () => {
    seed([{ id: "a", name: "Ada", updatedAt: 1000 }]);
    const sync = await makePush();
    const f = captureFetch();
    const out = await runInline(sync.id, f);

    expect(out.written).toBe(1);
    const row = f.batches[0]![0]!;
    expect(row.customer_name).toBe("Ada");
    expect(row.customer_email).toBe("a@example.test");
    // Without the key a re-sent batch is a duplicate rather than an upsert.
    expect(row.id).toBe("a");
    // An unmapped column has nowhere to go and must not be invented.
    expect(row.name).toBeUndefined();
  });

  test("a row arriving on the watermark's own timestamp is still sent", async () => {
    // The classic watermark bug, and it only shows up on the SECOND run. After
    // sending up to `5000|b`, a plain `updated_at > 5000` skips anything else
    // stamped 5000 — forever, because the watermark never moves past it. The
    // tie is broken by the primary key.
    seed([
      { id: "a", name: "A", updatedAt: 5000 },
      { id: "b", name: "B", updatedAt: 5000 },
    ]);
    const sync = await makePush();
    await runInline(sync.id, captureFetch());

    seed([{ id: "c", name: "C", updatedAt: 5000 }]);
    const f = captureFetch();
    await runInline(sync.id, f);
    expect(f.batches.flat().map((r) => r.id)).toEqual(["c"]);
  });

  test("a row already sent at that timestamp is not sent again", async () => {
    // The other half of the same comparison: `>=` would re-send `b` on every
    // run for as long as nothing newer arrives.
    seed([
      { id: "a", name: "A", updatedAt: 5000 },
      { id: "b", name: "B", updatedAt: 5000 },
    ]);
    const sync = await makePush();
    await runInline(sync.id, captureFetch());
    const f = captureFetch();
    expect((await runInline(sync.id, f)).written).toBe(0);
  });

  test("a second run sends only what changed, and never re-sends the last row", async () => {
    seed([{ id: "a", name: "A", updatedAt: 1000 }]);
    const sync = await makePush();
    await runInline(sync.id, captureFetch());

    const f2 = captureFetch();
    const out2 = await runInline(sync.id, f2);
    // `>=` on the watermark would re-send row `a` on every run, forever.
    expect(out2.written).toBe(0);

    seed([{ id: "b", name: "B", updatedAt: 2000 }]);
    const f3 = captureFetch();
    await runInline(sync.id, f3);
    expect(f3.batches.flat().map((r) => r.id)).toEqual(["b"]);
  });

  test("a failed push holds the watermark so the batch is retried", async () => {
    seed([{ id: "a", name: "A", updatedAt: 1000 }]);
    const sync = await makePush();
    await expect(runInline(sync.id, captureFetch(true))).rejects.toThrow(/ClickHouse responded 404/);

    const row = client
      .query("select cursor, consecutive_failures as f from integration_syncs where id = ?")
      .get(sync.id) as { cursor: string | null; f: number };
    // Advancing before the push resolves loses the batch with nothing to show.
    expect(row.cursor).toBeNull();
    expect(row.f).toBe(1);

    const f = captureFetch();
    await runInline(sync.id, f);
    expect(f.batches.flat().map((r) => r.id)).toEqual(["a"]);
  });

  test("the provider's error body is carried through, because it names the problem", async () => {
    seed([{ id: "a", name: "A", updatedAt: 1000 }]);
    const sync = await makePush();
    await expect(runInline(sync.id, captureFetch(true))).rejects.toThrow(/Unknown table/);
  });

  test("another workspace's rows are never mirrored out", async () => {
    seed([{ id: "mine", name: "Mine", updatedAt: 1000 }]);
    client
      .query(`insert into "${leadsTable}" (id, tenant_id, name, email, created_at, updated_at)
              values (?,?,?,?,?,?)`)
      .run("theirs", "some-other-tenant", "Theirs", "t@example.test", 1000, 1000);

    const sync = await makePush();
    const f = captureFetch();
    await runInline(sync.id, f);
    expect(f.batches.flat().map((r) => r.id)).toEqual(["mine"]);
  });

  test("a table name that is not a plain identifier is refused", async () => {
    seed([{ id: "a", name: "A", updatedAt: 1000 }]);
    const sync = (await ok("POST", SYNCS, {
      integrationId: chId,
      collection: "leads",
      direction: "push",
      settings: { table: "leads" },
      mapping: { name: "customer_name" },
    })).data;
    // It is interpolated into the INSERT, and the settings form is not the only
    // way a value can arrive.
    client
      .query("update integration_syncs set settings = ? where id = ?")
      .run(JSON.stringify({ table: "leads` (x) SELECT 1 --" }), sync.id);
    await expect(runInline(sync.id, captureFetch())).rejects.toThrow(/not a plain identifier/);
  });

  test("a push mapping may read a computed field, which a pull may not write", async () => {
    // Direction changes which side of the mapping has to be writable.
    const res = await req("POST", SYNCS, {
      integrationId: chId,
      collection: "leads",
      direction: "push",
      settings: { table: "leads" },
      mapping: { not_a_field: "x" },
    });
    expect(res.status).toBe(422);
  });
});

/**
 * A destination with a CLOSED column set.
 *
 * A warehouse's columns are whatever the operator's DDL declared, so the target
 * side of a push mapping is free text and the server has nothing to check it
 * against. Google Calendar is the first destination that writes into a
 * structured object instead — an event has a `summary` and a `start`, not
 * arbitrary columns — and there a typo'd target used to be accepted, dropped by
 * the provider, and the run would report a clean success having written nothing
 * into that field.
 */
describe("push: a destination with a closed column set", () => {
  let calId = "";

  beforeEach(async () => {
    client.query("delete from integrations where kind = 'google-calendar'").run();
    const res = await ok("POST", BASE, {
      kind: "google-calendar",
      config: { clientId: "cid", clientSecret: "csecret" },
    });
    calId = res.data.id as string;
  });

  const create = (mapping: Record<string, string>) =>
    req("POST", SYNCS, {
      integrationId: calId,
      collection: "leads",
      direction: "push",
      settings: { calendarId: "primary" },
      mapping,
    });

  test("accepts a mapping onto the columns the provider declared", async () => {
    expect((await create({ name: "summary", email: "attendees" })).status).toBe(201);
  });

  test("refuses a column the provider has no place to put", async () => {
    const res = await create({ name: "summry" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    // The message lists the real ones — the operator should not have to guess
    // the spelling from a rejection.
    expect(body.error.message).toContain("summary");
  });

  test("the catalog publishes those columns so the form can offer them", async () => {
    const cat = await ok("GET", `${BASE}/catalog`);
    expect(cat.data.destinationColumns["google-calendar"].map((c: any) => c.value)).toContain("start");
    // A warehouse declares none, which the UI reads as "free text".
    expect(cat.data.destinationColumns.clickhouse).toBeUndefined();
  });

  test("the closed set applies to a later edit too, not just creation", async () => {
    const created = await ok("POST", SYNCS, {
      integrationId: calId,
      collection: "leads",
      direction: "push",
      settings: { calendarId: "primary" },
      mapping: { name: "summary" },
    });
    const res = await req("PATCH", `${SYNCS}/${created.data.id}`, { mapping: { name: "nope" } });
    expect(res.status).toBe(422);
  });
});

/**
 * A connection authorized before the direction existed.
 *
 * Google Calendar was source-only first, so every connection made back then
 * holds `calendar.readonly`. The provider's refusal for a write on that grant
 * is a 403 at the far end of a scheduled job — which reaches an operator as a
 * sync that paused itself hours later, with nothing saying re-authorizing is
 * the fix.
 */
describe("push: a grant that predates the capability", () => {
  const connectWithScope = async (scope: string | null) => {
    client.query("delete from integrations where kind = 'google-calendar'").run();
    const res = await ok("POST", BASE, {
      kind: "google-calendar",
      config: { clientId: "cid", clientSecret: "csecret" },
    });
    const id = res.data.id as string;
    const row = client.query("select config from integrations where id = ?").get(id) as {
      config: string;
    };
    const config = { ...JSON.parse(row.config), _oauthAccessToken: "tok" };
    if (scope === null) delete config._oauthScope;
    else config._oauthScope = scope;
    client.query("update integrations set config = ? where id = ?").run(JSON.stringify(config), id);
    return id;
  };

  const create = (id: string) =>
    req("POST", SYNCS, {
      integrationId: id,
      collection: "leads",
      direction: "push",
      settings: { calendarId: "primary" },
      mapping: { name: "summary" },
    });

  test("a read-only grant is refused at save time, saying what to do", async () => {
    const res = await create(await connectWithScope("https://www.googleapis.com/auth/calendar.readonly"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/reconnect/i);
  });

  test("a grant that includes write is accepted", async () => {
    const scope =
      "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events";
    expect((await create(await connectWithScope(scope))).status).toBe(201);
  });

  test("silence is not denial", async () => {
    // A provider that returns no scope list leaves the field empty. Refusing on
    // that would block connections that can do the work; the far end's 403
    // stays the backstop.
    expect((await create(await connectWithScope(null))).status).toBe(201);
  });

  test("the same connection can still be used as a SOURCE", async () => {
    // The narrower grant is exactly what a pull needs — only the new direction
    // is affected.
    const id = await connectWithScope("https://www.googleapis.com/auth/calendar.readonly");
    const res = await req("POST", SYNCS, {
      integrationId: id,
      collection: "leads",
      direction: "pull",
      settings: { calendarId: "primary" },
      mapping: { summary: "name" },
    });
    expect(res.status).toBe(201);
  });
});

/**
 * A destination whose columns depend on a SETTING.
 *
 * Google Calendar's targets are fixed for the provider: an event has a
 * `summary` whichever calendar it lands in. An accounting destination is not
 * like that — QuickBooks writes a customer or an invoice depending on the
 * record type, and the two share nothing. Mapping `dueDate` on a customer sync
 * is the same silent drop the closed column set exists to prevent, so the check
 * has to narrow by the settings rather than by the provider alone.
 */
describe("push: a closed column set that narrows by settings", () => {
  let qboId = "";

  beforeEach(async () => {
    client.query("delete from integrations where kind = 'quickbooks'").run();
    const res = await ok("POST", BASE, {
      kind: "quickbooks",
      config: { clientId: "cid", clientSecret: "csecret" },
    });
    qboId = res.data.id as string;
  });

  const create = (entity: string, mapping: Record<string, string>) =>
    req("POST", SYNCS, {
      integrationId: qboId,
      collection: "leads",
      direction: "push",
      settings: { entity, environment: "production" },
      mapping,
    });

  test("a column of the chosen record type is accepted", async () => {
    expect((await create("Customer", { name: "displayName", email: "email" })).status).toBe(201);
  });

  test("a column belonging to the OTHER record type is refused", async () => {
    const res = await create("Customer", { name: "displayName", score: "amount" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    // The listed alternatives are the customer's, not the union — a list that
    // included `amount` would say the mapping should have worked.
    expect(body.error.message).toContain("displayName");
    expect(body.error.message).not.toContain("dueDate");
  });

  test("changing the record type re-checks the mapping that is already stored", async () => {
    const created = await ok("POST", SYNCS, {
      integrationId: qboId,
      collection: "leads",
      direction: "push",
      settings: { entity: "Customer", environment: "production" },
      mapping: { name: "displayName" },
    });
    // Without this the sync would keep a mapping naming a column an invoice
    // does not have, and nothing would notice until the provider dropped it.
    const res = await req("PATCH", `${SYNCS}/${created.data.id}`, {
      settings: { entity: "Invoice", environment: "production" },
    });
    expect(res.status).toBe(422);
  });

  test("the catalog ships the FULL list, so the form can re-narrow it locally", async () => {
    const cat = await ok("GET", `${BASE}/catalog`);
    const columns = cat.data.destinationColumns.quickbooks as { value: string; when?: unknown }[];
    // Both record types' columns, each carrying the condition that gates it —
    // otherwise switching the record type would need another round trip.
    expect(columns.map((c) => c.value)).toContain("dueDate");
    expect(columns.find((c) => c.value === "dueDate")?.when).toEqual({ entity: ["Invoice"] });
  });
});

/**
 * A grant split across several scopes.
 *
 * Xero does not have one "write" permission: contacts and transactions are
 * separate grants, and a connection made when Xero was source-only holds
 * neither. Requiring both is what makes the save-time check name exactly those
 * connections.
 */
describe("push: a provider that needs more than one grant", () => {
  const connectWithScope = async (scope: string) => {
    client.query("delete from integrations where kind = 'xero'").run();
    const res = await ok("POST", BASE, {
      kind: "xero",
      config: { clientId: "cid", clientSecret: "csecret" },
    });
    const id = res.data.id as string;
    const row = client.query("select config from integrations where id = ?").get(id) as {
      config: string;
    };
    const config = { ...JSON.parse(row.config), _oauthAccessToken: "tok", _oauthScope: scope };
    client.query("update integrations set config = ? where id = ?").run(JSON.stringify(config), id);
    return id;
  };

  const create = (id: string) =>
    req("POST", SYNCS, {
      integrationId: id,
      collection: "leads",
      direction: "push",
      settings: { endpoint: "Contacts" },
      mapping: { name: "name" },
    });

  test("the read-only grant every existing connection holds is refused", async () => {
    const res = await create(
      await connectWithScope("offline_access accounting.contacts.read accounting.transactions.read"),
    );
    expect(res.status).toBe(400);
  });

  test("one of the two is still not enough", async () => {
    // The message says reconnect, and reconnecting grants both — so a partial
    // grant must not be mistaken for a complete one.
    const res = await create(await connectWithScope("offline_access accounting.contacts"));
    expect(res.status).toBe(400);
  });

  test("both grants together are accepted", async () => {
    const res = await create(
      await connectWithScope("offline_access accounting.contacts accounting.transactions"),
    );
    expect(res.status).toBe(201);
  });
});
