/**
 * Tasks — a provider acting on ONE row, and running exactly once.
 *
 * The first three capabilities are all safe to repeat; this one is not. A task
 * books a shipment, so the assertions that matter are about the guard:
 *
 *   - a second invocation returns the first run's answer, it does not act again
 *   - two concurrent invocations produce ONE provider call
 *   - `force` is the only way past that, and it is off by default
 *   - a provider failure is recorded and re-thrown, never reported as success
 *   - an artifact is stored BEFORE the row names its key
 *
 * And the exception the guard has to make: a task that declares itself
 * `repeatable` is a READ. Asking a carrier where a parcel is has no effect at
 * the carrier, so every one of the assertions above inverts for it — that is
 * what the second fake task is here to pin.
 *
 * No shipped provider declares a task yet — the first will be the carrier
 * connector this engine work is for — so the provider half is mocked. The two
 * mocked functions are captured by value before mocking and restored
 * afterwards: an ES module namespace holds live bindings, so restoring from the
 * namespace would reinstall the mock and leak it into every sibling suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as realIntegrations from "@backlex/integrations";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BASE = "/api/admin/integrations";

const realTaskFor = realIntegrations.taskFor;
const realRunIntegrationTask = realIntegrations.runIntegrationTask;

let h: TestHarness;
let client: Database;
let integrationId: string;
let shipmentsTable: string;

/** The fake carrier task the mocked registry exposes. */
const FAKE_TASK = {
  id: "create_shipment",
  label: "Create shipment",
  settingFields: [
    { key: "service", label: "Service", options: [{ value: "standard", label: "Standard" }] },
  ],
  outputs: [
    { key: "trackingNumber", label: "Tracking number" },
    { key: "labelKey", label: "Label", artifact: true },
  ],
  run: async () => ({ outputs: {} }),
};

/**
 * The read half — a carrier being asked where the parcel is.
 *
 * Declared `repeatable` because it changes nothing at the provider, which is
 * the only thing that entitles a task to run more than once.
 */
const FAKE_REPEATABLE_TASK = {
  id: "check_tracking",
  label: "Check tracking",
  repeatable: true,
  settingFields: [],
  outputs: [{ key: "shipmentStatus", label: "Shipment status" }],
  run: async () => ({ outputs: {} }),
};

/** What the mocked provider does on the next call, and how often it was asked. */
let calls = 0;
let behaviour: () => Promise<{ outputs: Record<string, unknown>; artifact?: unknown }> = async () => ({
  outputs: { trackingNumber: "TRK-1" },
});

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

const shipmentRows = () =>
  client.query(`select * from "${shipmentsTable}" order by id`).all() as Record<string, unknown>[];

const taskRuns = () =>
  client.query("select * from integration_task_runs").all() as Record<string, unknown>[];

beforeAll(async () => {
  mock.module("@backlex/integrations", () => ({
    ...realIntegrations,
    taskFor: (kind: string, taskId: string) => {
      if (kind !== "google-sheets") return undefined;
      if (taskId === "create_shipment") return FAKE_TASK;
      if (taskId === "check_tracking") return FAKE_REPEATABLE_TASK;
      return undefined;
    },
    runIntegrationTask: async () => {
      calls += 1;
      return behaviour();
    },
  }));

  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);

  await ok("POST", "/api/collections", {
    slug: "shipments",
    fields: [
      { name: "tracking", type: "text" },
      { name: "label", type: "text" },
      { name: "ship_status", type: "text" },
      // Nothing maps an output onto this one. It is here to be left alone —
      // see "a write-back leaves the columns it was not given". A collection
      // whose only columns are the ones the task writes cannot fail that.
      { name: "order_ref", type: "text" },
    ],
  });
  shipmentsTable = (
    client.query("select physical_table as t from collections where slug = 'shipments'").get() as {
      t: string;
    }
  ).t;

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
    taskFor: realTaskFor,
    runIntegrationTask: realRunIntegrationTask,
  }));
  h.cleanup();
});

const runUrl = () => `${BASE}/${integrationId}/tasks/create_shipment`;

const BODY = {
  collection: "shipments",
  itemId: "ship-1",
  settings: { service: "standard" },
  outputMapping: { trackingNumber: "tracking", labelKey: "label" },
};

beforeEach(() => {
  client.query("delete from integration_task_runs").run();
  client.query(`delete from "${shipmentsTable}"`).run();
  const now = Date.now();
  client
    .query(
      `insert into "${shipmentsTable}" (id, tracking, label, ship_status, order_ref, created_at, updated_at) values ('ship-1', null, null, null, 'ORD-1001', ?, ?)`,
    )
    .run(now, now);
  calls = 0;
  behaviour = async () => ({ outputs: { trackingNumber: "TRK-1" } });
});

describe("running a task", () => {
  test("the provider's answer lands on the row", async () => {
    const res = await ok("POST", runUrl(), BODY);
    expect(res.data.status).toBe("succeeded");
    expect(res.data.outputs.trackingNumber).toBe("TRK-1");

    const rows = shipmentRows();
    expect(rows[0]!.tracking).toBe("TRK-1");
    expect(calls).toBe(1);
  });

  test("a write-back leaves the columns it was not given", async () => {
    // A task hands back the two or three fields it learned, never the row. The
    // write therefore has to be a PATCH: under a whole-row upsert every column
    // outside the mapping is "absent from the incoming row", and booking a
    // shipment would empty the fulfillment it was booked for — which order,
    // which location, which date — while reporting a clean success.
    await ok("POST", runUrl(), BODY);

    const row = shipmentRows()[0]!;
    expect(row.tracking).toBe("TRK-1");
    expect(row.order_ref).toBe("ORD-1001");
  });

  test("a second invocation returns the first answer WITHOUT acting again", async () => {
    // The whole reason this capability has a run table. A retry, a double
    // click, or a re-fired flow must not book a second shipment.
    await ok("POST", runUrl(), BODY);
    behaviour = async () => ({ outputs: { trackingNumber: "TRK-SECOND" } });
    const again = await ok("POST", runUrl(), BODY);

    expect(calls).toBe(1);
    expect(again.data.reused).toBe(true);
    expect(again.data.status).toBe("skipped");
    expect(again.data.outputs.trackingNumber).toBe("TRK-1");
    expect(shipmentRows()[0]!.tracking).toBe("TRK-1");
  });

  test("two concurrent invocations produce exactly one provider call", async () => {
    // The unique index is the guard, not a check the code performs: both
    // callers race to INSERT and only one can win.
    behaviour = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { outputs: { trackingNumber: "TRK-RACE" } };
    };
    const [a, b] = await Promise.all([req("POST", runUrl(), BODY), req("POST", runUrl(), BODY)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls).toBe(1);
    expect(taskRuns()).toHaveLength(1);
  });

  test("force is the only way to deliberately re-run one that succeeded", async () => {
    await ok("POST", runUrl(), BODY);
    behaviour = async () => ({ outputs: { trackingNumber: "TRK-2" } });
    const forced = await ok("POST", runUrl(), { ...BODY, force: true });

    expect(calls).toBe(2);
    expect(forced.data.reused).toBe(false);
    expect(shipmentRows()[0]!.tracking).toBe("TRK-2");
  });

  test("an artifact is stored and its key written to the declared output", async () => {
    behaviour = async () => ({
      outputs: { trackingNumber: "TRK-3" },
      artifact: {
        outputKey: "labelKey",
        filename: "label.pdf",
        contentType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-1.4 fake"),
      },
    });

    const res = await ok("POST", runUrl(), BODY);
    const key = res.data.artifactKey as string;
    expect(key).toBeTruthy();
    // Scoped under the workspace, and named from the run — never from the
    // filename a third party supplied.
    expect(key).toContain("integration-tasks/");
    expect(key.endsWith(".pdf")).toBe(true);
    expect(shipmentRows()[0]!.label).toBe(key);
  });

  test("a provider failure is recorded and re-thrown, never a silent success", async () => {
    behaviour = async () => {
      throw new Error("carrier refused the consignment");
    };
    const res = await req("POST", runUrl(), BODY);
    expect(res.ok).toBe(false);

    const runs = taskRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    expect(String(runs[0]!.error)).toContain("carrier refused");
    // Nothing was written to the row, because nothing came back.
    expect(shipmentRows()[0]!.tracking).toBeNull();
  });

  test("a failed run is retried rather than treated as already-done", async () => {
    behaviour = async () => {
      throw new Error("timeout");
    };
    await req("POST", runUrl(), BODY);
    behaviour = async () => ({ outputs: { trackingNumber: "TRK-RETRY" } });
    const res = await ok("POST", runUrl(), BODY);

    expect(res.data.status).toBe("succeeded");
    expect(shipmentRows()[0]!.tracking).toBe("TRK-RETRY");
    expect(taskRuns()).toHaveLength(1);
  });
});

describe("a repeatable task is a read, so the guard steps aside", () => {
  const trackUrl = () => `${BASE}/${integrationId}/tasks/check_tracking`;
  const TRACK_BODY = {
    collection: "shipments",
    itemId: "ship-1",
    outputMapping: { shipmentStatus: "ship_status" },
  };

  test("asking twice asks the provider twice and keeps the NEWER answer", async () => {
    // The inversion of the guard's whole point. A parcel that has not left the
    // warehouse answers `pre_transit`, and freezing the row on that would make
    // the field useless the moment it became interesting.
    behaviour = async () => ({ outputs: { shipmentStatus: "pre_transit" } });
    const first = await ok("POST", trackUrl(), TRACK_BODY);
    expect(first.data.status).toBe("succeeded");
    expect(shipmentRows()[0]!.ship_status).toBe("pre_transit");

    behaviour = async () => ({ outputs: { shipmentStatus: "delivered" } });
    const second = await ok("POST", trackUrl(), TRACK_BODY);

    expect(calls).toBe(2);
    expect(second.data.reused).toBe(false);
    expect(second.data.status).toBe("succeeded");
    expect(shipmentRows()[0]!.ship_status).toBe("delivered");
  });

  test("it still leaves ONE run row, carrying the latest answer and the count", async () => {
    // Every poll is recorded rather than accumulating a row each time: what the
    // carrier last said and when is the useful fact, not a log of every ask.
    behaviour = async () => ({ outputs: { shipmentStatus: "in_transit" } });
    await ok("POST", trackUrl(), TRACK_BODY);
    behaviour = async () => ({ outputs: { shipmentStatus: "out_for_delivery" } });
    await ok("POST", trackUrl(), TRACK_BODY);

    const runs = taskRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");
    expect(runs[0]!.attempts).toBe(2);
    expect(JSON.parse(String(runs[0]!.outputs)).shipmentStatus).toBe("out_for_delivery");
  });

  test("two concurrent polls BOTH reach the provider", async () => {
    // The opposite of the booking assertion above, and deliberately so: losing
    // the insert race must not hand a poll somebody else's stale answer.
    behaviour = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { outputs: { shipmentStatus: "in_transit" } };
    };
    const [a, b] = await Promise.all([
      req("POST", trackUrl(), TRACK_BODY),
      req("POST", trackUrl(), TRACK_BODY),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls).toBe(2);
    expect(taskRuns()).toHaveLength(1);
  });

  test("the once-only task alongside it is unaffected", async () => {
    // The two live under the same (integration, collection, row) triple and are
    // told apart by task id alone, so this is what proves `repeatable` is a
    // property of the task and not of the run table.
    behaviour = async () => ({ outputs: { trackingNumber: "TRK-1" } });
    await ok("POST", runUrl(), BODY);
    behaviour = async () => ({ outputs: { trackingNumber: "TRK-SECOND" } });
    const booked = await ok("POST", runUrl(), BODY);
    expect(booked.data.reused).toBe(true);

    behaviour = async () => ({ outputs: { shipmentStatus: "delivered" } });
    await ok("POST", trackUrl(), TRACK_BODY);
    const polled = await ok("POST", trackUrl(), TRACK_BODY);
    expect(polled.data.reused).toBe(false);

    expect(taskRuns()).toHaveLength(2);
    expect(shipmentRows()[0]!.tracking).toBe("TRK-1");
    expect(shipmentRows()[0]!.ship_status).toBe("delivered");
  });

  test("a failed poll is recorded and the next one still runs", async () => {
    behaviour = async () => {
      throw new Error("carrier tracking unavailable");
    };
    const failed = await req("POST", trackUrl(), TRACK_BODY);
    expect(failed.ok).toBe(false);
    expect(taskRuns()[0]!.status).toBe("failed");

    behaviour = async () => ({ outputs: { shipmentStatus: "in_transit" } });
    const res = await ok("POST", trackUrl(), TRACK_BODY);
    expect(res.data.status).toBe("succeeded");
    expect(shipmentRows()[0]!.ship_status).toBe("in_transit");
  });

  test("it still refuses an output it never declared", async () => {
    // Repeatable relaxes the guard, not the contract.
    const res = await req("POST", trackUrl(), {
      ...TRACK_BODY,
      outputMapping: { trackingNumber: "tracking" },
    });
    expect(res.status).toBe(422);
    expect(calls).toBe(0);
  });
});

describe("what a task refuses", () => {
  test("an output the task never declared", async () => {
    const res = await req("POST", runUrl(), {
      ...BODY,
      outputMapping: { madeUp: "tracking" },
    });
    expect(res.status).toBe(422);
  });

  test("a target that is not a writable field", async () => {
    // Dropped by ingestRows otherwise, and the run would report a booked
    // shipment whose tracking number reached nobody.
    const res = await req("POST", runUrl(), {
      ...BODY,
      outputMapping: { trackingNumber: "not_a_column" },
    });
    expect(res.status).toBe(422);
  });

  test("a setting the task never declared", async () => {
    // Settings reach a provider and end up in URLs, so an unrecognised key is
    // an error rather than something to forward on the chance it is read.
    const res = await req("POST", runUrl(), {
      ...BODY,
      settings: { service: "standard", apiHost: "https://attacker.test" },
    });
    expect(res.status).toBe(422);
  });

  test("a value outside a setting's closed set", async () => {
    const res = await req("POST", runUrl(), { ...BODY, settings: { service: "overnight" } });
    expect(res.status).toBe(422);
  });

  test("a row that does not exist", async () => {
    const res = await req("POST", runUrl(), { ...BODY, itemId: "nope" });
    expect(res.status).toBe(404);
    expect(calls).toBe(0);
  });

  test("an unknown task id", async () => {
    const res = await req("POST", `${BASE}/${integrationId}/tasks/not_a_task`, BODY);
    expect([400, 404]).toContain(res.status);
    expect(calls).toBe(0);
  });
});

describe("task runs are visible", () => {
  test("a row's runs are listed with their outputs", async () => {
    await ok("POST", runUrl(), BODY);
    const res = await ok("GET", `${BASE}/task-runs?collection=shipments&itemId=ship-1`);
    expect(res.data).toHaveLength(1);
    expect(res.data[0].task).toBe("create_shipment");
    expect(res.data[0].status).toBe("succeeded");
    expect(res.data[0].outputs.trackingNumber).toBe("TRK-1");
  });

  test("the endpoint is admin-gated", async () => {
    const anon = makeHarness();
    try {
      const res = await anon.fetch(`${BASE}/task-runs?collection=shipments&itemId=ship-1`);
      expect([401, 403]).toContain(res.status);
    } finally {
      anon.cleanup();
    }
  });
});
