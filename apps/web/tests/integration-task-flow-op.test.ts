/**
 * The `integration.task` flow operation — a provider acting on one row, from a
 * flow.
 *
 * The task service already proves the once-only guard against the HTTP route.
 * What this suite is for is the two things a flow adds and the API does not:
 *
 *   - the step names a provider KIND, and a missing connection FAILS the run.
 *     The message step above it skips instead, and the difference is the whole
 *     reason this is a separate op — a chat notification nobody received is a
 *     notification, a shipment nobody booked is an order the next step marks as
 *     shipped.
 *   - a mistyped task or output is refused when the flow is SAVED. At run time
 *     it presents as a step that failed on a real order; at save time the
 *     author is still looking at it.
 *
 * The provider half is mocked for the same reason the task suite mocks it: the
 * first shipped task belongs to the carrier connector this engine work is for.
 * The two mocked functions are captured by value before mocking and restored
 * afterwards — an ES module namespace holds live bindings, so restoring from
 * the namespace would reinstall the mock and leak it into every sibling suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as realIntegrations from "@backlex/integrations";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const realTaskFor = realIntegrations.taskFor;
const realRunIntegrationTask = realIntegrations.runIntegrationTask;

/** The fake carrier task the mocked registry exposes on `google-sheets`. */
const FAKE_TASK = {
  id: "create_shipment",
  label: "Create shipment",
  settingFields: [
    { key: "service", label: "Service", options: [{ value: "standard", label: "Standard" }] },
  ],
  outputs: [{ key: "trackingNumber", label: "Tracking number" }],
  run: async () => ({ outputs: {} }),
};

let h: TestHarness;
let client: Database;
let ordersTable: string;
let calls = 0;

const post = (path: string, body: unknown) =>
  h.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const ok = async (method: string, path: string, body?: unknown) => {
  const res = await h.fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as any;
};

/** Create the flow, run it once against `payload`, and hand back the result. */
const runWithStep = async (
  name: string,
  step: Record<string, unknown>,
  payload: Record<string, unknown>,
) => {
  const made = await post("/api/flows", {
    name,
    trigger: "manual:",
    operations: [{ type: "integration.task", ...step }],
  });
  if (made.status !== 201) throw new Error(`flow save → ${made.status} ${await made.text()}`);
  const flowId = ((await made.json()) as any).data.id as string;
  const run = await post(`/api/flows/${flowId}/run`, payload);
  return (await run.json()) as { ok: boolean; error?: string };
};

const orderRow = (id: string) =>
  client.query(`select * from "${ordersTable}" where id = ?`).get(id) as Record<string, unknown>;

/** Seed a row with the id this suite wants to name in a template. */
const seedOrder = (id: string) => {
  const now = Date.now();
  client
    .query(`insert into "${ordersTable}" (id, tracking, created_at, updated_at) values (?, null, ?, ?)`)
    .run(id, now, now);
};

beforeAll(async () => {
  mock.module("@backlex/integrations", () => ({
    ...realIntegrations,
    // Two kinds declare it, and only one of them is connected below — that is
    // how the "nobody connected it" case reaches the RUN rather than being
    // caught as a mistyped task when the flow is saved.
    taskFor: (kind: string, taskId: string) =>
      (kind === "google-sheets" || kind === "airtable") && taskId === "create_shipment"
        ? FAKE_TASK
        : undefined,
    runIntegrationTask: async () => {
      calls += 1;
      return { outputs: { trackingNumber: `TRK-${calls}` } };
    },
  }));

  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);

  await ok("POST", "/api/collections", {
    slug: "orders",
    fields: [{ name: "tracking", type: "text" }],
  });
  ordersTable = (
    client.query("select physical_table as t from collections where slug = 'orders'").get() as {
      t: string;
    }
  ).t;

  const connected = await ok("POST", "/api/admin/integrations", {
    kind: "google-sheets",
    config: { clientId: "cid", clientSecret: "csecret" },
  });
  const row = client.query("select config from integrations where id = ?").get(connected.data.id) as {
    config: string;
  };
  client
    .query("update integrations set config = ? where id = ?")
    .run(JSON.stringify({ ...JSON.parse(row.config), _oauthAccessToken: "t" }), connected.data.id);
});

afterAll(() => {
  mock.module("@backlex/integrations", () => ({
    ...realIntegrations,
    taskFor: realTaskFor,
    runIntegrationTask: realRunIntegrationTask,
  }));
  h.cleanup();
});

beforeEach(() => {
  calls = 0;
  client.query(`delete from "${ordersTable}"`).run();
  client.query("delete from integration_task_runs").run();
});

const STEP = {
  kind: "google-sheets",
  task: "create_shipment",
  collection: "orders",
  itemId: "{{ data.id }}",
  settings: { service: "standard" },
  outputMapping: { trackingNumber: "tracking" },
};

describe("integration.task as a flow step", () => {
  test("books the shipment and writes the answer onto the row", async () => {
    seedOrder("o1");

    const out = await runWithStep("ship", STEP, { id: "o1" });

    expect(out.ok).toBe(true);
    expect(calls).toBe(1);
    expect(orderRow("o1").tracking).toBe("TRK-1");
  });

  test("a second run reads the first answer back rather than booking again", async () => {
    seedOrder("o2");
    await runWithStep("ship-a", STEP, { id: "o2" });
    // A different flow, deliberately: the guard is keyed by (integration, task,
    // row), so two automations that both reach for the same shipment must not
    // each book one.
    const again = await runWithStep("ship-b", STEP, { id: "o2" });

    expect(again.ok).toBe(true);
    expect(calls).toBe(1);
    expect(orderRow("o2").tracking).toBe("TRK-1");
  });

  test("`force` is what re-books a shipment cancelled at the provider", async () => {
    seedOrder("o3");
    await runWithStep("ship-once", STEP, { id: "o3" });
    const again = await runWithStep("ship-again", { ...STEP, force: true }, { id: "o3" });

    expect(again.ok).toBe(true);
    expect(calls).toBe(2);
    expect(orderRow("o3").tracking).toBe("TRK-2");
  });

  test("a provider nobody connected FAILS the run — it is not skipped", async () => {
    seedOrder("o4");
    // `airtable` declares the task but has no connection in this workspace. The
    // message step treats that as a skip; a task must not, or the steps after
    // it carry on as though a shipment exists.
    const out = await runWithStep("ship-nowhere", { ...STEP, kind: "airtable" }, { id: "o4" });

    expect(out.ok).toBe(false);
    expect(out.error).toContain("airtable");
    expect(calls).toBe(0);
  });

  test("a row template that renders empty says so, rather than 'not found'", async () => {
    const out = await runWithStep("ship-nothing", STEP, { notAnId: "o5" });

    expect(out.ok).toBe(false);
    // Naming the template is the point: "row not found" reads as a deleted row
    // rather than a step aimed at a key the trigger payload never had.
    expect(out.error).toContain("{{ data.id }}");
    expect(calls).toBe(0);
  });

  test("an output with nowhere to land still runs — it just isn't written", async () => {
    seedOrder("o6");
    const out = await runWithStep("ship-unmapped", { ...STEP, outputMapping: {} }, { id: "o6" });

    expect(out.ok).toBe(true);
    expect(calls).toBe(1);
    expect(orderRow("o6").tracking).toBeNull();
  });
});

describe("a task step is checked when the flow is SAVED", () => {
  let n = 0;
  const save = (operations: unknown[]) =>
    post("/api/flows", { name: `check-${(n += 1)}`, trigger: "manual:", operations });
  const step = (patch: Record<string, unknown>) => ({ type: "integration.task", ...STEP, ...patch });

  test("a task the provider does not declare", async () => {
    const res = await save([step({ task: "creat_shipment" })]);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("creat_shipment");
  });

  test("an output key the task does not declare", async () => {
    const res = await save([step({ outputMapping: { trackingNo: "tracking" } })]);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("trackingNo");
  });

  test("a setting the task does not declare", async () => {
    const res = await save([step({ settings: { serviceLevel: "standard" } })]);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("serviceLevel");
  });

  test("a setting outside the task's own option set", async () => {
    const res = await save([step({ settings: { service: "overnight" } })]);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("standard");
  });

  test("the check reaches a step nested in a branch", async () => {
    const res = await save([
      {
        type: "condition",
        filter: { status: { _eq: "paid" } },
        then: [step({ task: "nope" })],
      },
    ]);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("nope");
  });

  test("a kind built from a template is left to the run", async () => {
    // There is nothing to look up until the run renders it, so refusing here
    // would refuse a legitimate flow.
    const res = await save([step({ kind: "{{ data.provider }}" })]);
    expect(res.status).toBe(201);
  });

  test("GraphQL gets the same refusal, on a payload nothing parsed first", async () => {
    // Only the REST route runs operations through zod, so this is the surface
    // where a `kind` that is not a string reaches the check as-is. It has to
    // come back as a refusal naming the step, not a TypeError.
    const res = await post("/api/graphql", {
      query: "mutation ($data: FlowInput!) { createFlow(data: $data) { id } }",
      variables: {
        data: {
          name: "gql-bad-kind",
          trigger: "manual:",
          operations: [{ ...step({}), kind: 42 }],
        },
      },
    });
    const body = (await res.json()) as any;
    expect(body.data?.createFlow ?? null).toBeNull();
    expect(JSON.stringify(body.errors)).toContain("named as text");
  });

  test("GraphQL refuses a task the provider does not declare", async () => {
    const res = await post("/api/graphql", {
      query: "mutation ($data: FlowInput!) { createFlow(data: $data) { id } }",
      variables: {
        data: {
          name: "gql-bad-task",
          trigger: "manual:",
          operations: [step({ task: "no_such_task" })],
        },
      },
    });
    const body = (await res.json()) as any;
    expect(body.data?.createFlow ?? null).toBeNull();
    expect(JSON.stringify(body.errors)).toContain("no_such_task");
  });
});
