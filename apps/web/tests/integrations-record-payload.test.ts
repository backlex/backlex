/**
 * The opt-in record payload.
 *
 * Most sinks want to know that something changed, not what it said. Handing
 * every connected chat channel the contents of every row is not a default
 * anyone would choose, so the record travels only to providers that declared
 * they need it — and the assertions here are almost all about the ones that
 * did not.
 *
 * There are two gates, deliberately: the record is scoped per integration
 * BEFORE the queue row is written, and re-checked before it reaches a provider.
 * The first stops row contents parking in the jobs table; the second covers a
 * job written by hand or before the rule existed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  PROVIDERS,
  RECORD_PAYLOAD_KINDS,
  deliverToIntegration,
} from "../../../packages/integrations/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BASE = "/api/admin/integrations";
const SECRET_VALUE = "SALARY-482000-CONFIDENTIAL";

let h: TestHarness;
let client: Database;
let TENANT = "";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
  await (
    await h.fetch(
      "/api/collections",
      json({
        slug: "staff",
        fields: [
          { name: "email", type: "text", interface: "email" },
          { name: "note", type: "text" },
        ],
      }),
    )
  ).json();
  TENANT = (client.query("select tenant_id as t from collections where slug = 'staff'").get() as {
    t: string;
  }).t;
});
afterAll(() => h.cleanup());

beforeEach(() => {
  client.query("delete from jobs").run();
  client.query("delete from integrations").run();
});

describe("the registry", () => {
  test("only HubSpot asks for the row today, and it says so", () => {
    expect([...RECORD_PAYLOAD_KINDS]).toEqual(["hubspot"]);
    expect(PROVIDERS.hubspot.recordPayload).toBe(true);
    // The ones an admin is most likely to have connected must not.
    for (const kind of ["slack", "discord", "posthog", "mixpanel", "google-chat"] as const) {
      expect(PROVIDERS[kind].recordPayload).toBeFalsy();
    }
  });

  test("the catalog tells the connect UI which ones receive row contents", async () => {
    const body = (await (await h.fetch(`${BASE}/catalog`)).json()) as any;
    const byId = Object.fromEntries(body.data.providers.map((p: any) => [p.id, p]));
    // An admin should know before connecting, not afterwards.
    expect(byId.hubspot.recordPayload).toBe(true);
    expect(byId.slack.recordPayload).toBe(false);
  });
});

describe("what reaches the queue", () => {
  /** The enqueue path, not the inline one: `dispatchIntegrations` only queues
   *  when it has a full Ctx and no fetch seam. */
  const dispatch = async (record: Record<string, unknown>) => {
    const { dispatchIntegrations } = await import("../src/server/services/integrations");
    const { buildContext } = await import("../src/server/context");
    const ctx = await buildContext(h.env);
    await dispatchIntegrations(h.env, ctx, TENANT, "items:staff", { event: "created", data: record });
  };

  const connect = async (kind: string, config: Record<string, unknown>) => {
    const { connectIntegration } = await import("../src/server/services/integrations");
    const { buildContext } = await import("../src/server/context");
    const ctx = await buildContext(h.env);
    const out = await connectIntegration(
      ctx,
      { tenantId: TENANT, kind, config, events: null },
      h.env.AUTH_SECRET,
    );
    return out.id;
  };

  const ROW = { id: "1", email: "person@example.test", note: SECRET_VALUE };

  const jobRows = () =>
    client.query("select payload from jobs where type = 'integration.deliver'").all() as {
      payload: string;
    }[];

  test("a chat sink's job row never contains the record", async () => {
    await connect("slack", { webhookUrl: "https://hooks.slack.com/services/x" });
    await dispatch(ROW);
    const rows = jobRows();
    expect(rows.length).toBeGreaterThan(0);
    // The jobs table is durable and readable by anyone with DB access; parking
    // row contents there for a provider that will never use them is the leak.
    for (const r of rows) expect(r.payload).not.toContain(SECRET_VALUE);
  });

  test("a provider that asked for the row gets it", async () => {
    await connect("hubspot", { accessToken: "pat-test" });
    await dispatch(ROW);
    const rows = jobRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.payload.includes(SECRET_VALUE))).toBe(true);
  });

  test("with both connected, only HubSpot's job carries it", async () => {
    const slackId = await connect("slack", { webhookUrl: "https://hooks.slack.com/services/x" });
    const hubspotId = await connect("hubspot", { accessToken: "pat-test" });
    await dispatch(ROW);

    const rows = jobRows();
    const forSlack = rows.filter((r) => r.payload.includes(slackId));
    const forHubspot = rows.filter((r) => r.payload.includes(hubspotId));
    expect(forSlack.length).toBeGreaterThan(0);
    expect(forHubspot.length).toBeGreaterThan(0);
    for (const r of forSlack) expect(r.payload).not.toContain(SECRET_VALUE);
    expect(forHubspot.some((r) => r.payload.includes(SECRET_VALUE))).toBe(true);
  });
});

describe("what reaches the provider", () => {
  const capture = () => {
    const bodies: string[] = [];
    const fn = async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    };
    return Object.assign(fn, { bodies });
  };

  const EVENT = {
    event: "staff.created",
    text: "staff: record created #1",
    payload: { collection: "staff", event: "created", id: "1" },
    record: { id: "1", email: "person@example.test", note: SECRET_VALUE },
  };

  test("the second gate strips a record that should not have travelled", async () => {
    // The queue handler rebuilds the message from a stored payload, so a job
    // written by hand — or before this rule existed — must not be able to hand
    // a record to a provider that never asked for one. `deliverOne` re-checks.
    const { messageFor } = await import("../src/server/services/integrations");
    const forSlack = messageFor("slack", EVENT);
    expect("record" in forSlack).toBe(false);
    // Absent, not emptied: a provider reading it defensively must not mistake
    // `{}` for a row that happened to have no fields.
    expect(JSON.stringify(forSlack)).not.toContain(SECRET_VALUE);

    const forHubspot = messageFor("hubspot", EVENT);
    expect(forHubspot.record).toEqual(EVENT.record);
  });

  test("a chat provider ignores an attached record even without the gate", async () => {
    // Defence in depth: the gate is the guarantee, but no chat sink reads it.
    const f = capture();
    await deliverToIntegration("slack", { webhookUrl: "https://hooks.slack.com/services/x" }, EVENT, f);
    for (const b of f.bodies) expect(b).not.toContain(SECRET_VALUE);
  });

  test("HubSpot upserts on the address, so a retry updates rather than duplicates", async () => {
    const f = capture();
    await deliverToIntegration("hubspot", { accessToken: "pat-test" }, EVENT, f);
    const body = JSON.parse(f.bodies[0]!) as {
      inputs: { idProperty: string; id: string; properties: Record<string, unknown> }[];
    };
    // The queue retries; without the id property this creates a second contact.
    expect(body.inputs[0]!.idProperty).toBe("email");
    expect(body.inputs[0]!.id).toBe("person@example.test");
    expect(body.inputs[0]!.properties.email).toBe("person@example.test");
  });

  test("an event with no record is a no-op, not a failure", async () => {
    // A delete carries no row. Failing here would trip the breaker on every
    // delete and eventually pause a perfectly healthy integration.
    const f = capture();
    const { record: _none, ...withoutRecord } = EVENT;
    const out = await deliverToIntegration("hubspot", { accessToken: "pat-test" }, withoutRecord, f);
    expect(out.ok).toBe(true);
    expect(f.bodies).toHaveLength(0);
  });

  test("a record with no address is a no-op too", async () => {
    const f = capture();
    const out = await deliverToIntegration(
      "hubspot",
      { accessToken: "pat-test" },
      { ...EVENT, record: { id: "1", note: "no address here" } },
      f,
    );
    expect(out.ok).toBe(true);
    expect(f.bodies).toHaveLength(0);
  });

  test("nested values are dropped rather than stringified into a CRM field", async () => {
    const f = capture();
    await deliverToIntegration(
      "hubspot",
      { accessToken: "pat-test" },
      { ...EVENT, record: { id: "1", email: "p@example.test", company: { name: "Acme" } } },
      f,
    );
    const body = JSON.parse(f.bodies[0]!) as { inputs: { properties: Record<string, unknown> }[] };
    // `[object Object]` in a customer-facing field is worse than a blank one.
    expect(body.inputs[0]!.properties.company).toBeUndefined();
  });
});

describe("the new analytics and chat sinks", () => {
  const capture = () => {
    const calls: { url: string; body: string }[] = [];
    const fn = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    };
    return Object.assign(fn, { calls });
  };

  const EVENT = {
    event: "staff.created",
    text: "staff: record created #1",
    payload: { collection: "staff", event: "created", id: "1" },
  };

  test("Mixpanel and Amplitude honour the data-residency choice", async () => {
    const f = capture();
    await deliverToIntegration("mixpanel", { projectToken: "t", region: "eu" }, EVENT, f);
    await deliverToIntegration("amplitude", { apiKey: "k", region: "eu" }, EVENT, f);
    // Sending EU data to a US endpoint is a compliance problem, not a latency
    // one, so this is not a detail that may quietly default.
    expect(f.calls[0]!.url).toStartWith("https://api-eu.mixpanel.com");
    expect(f.calls[1]!.url).toStartWith("https://api.eu.amplitude.com");
  });

  test("Amplitude routes a short id to device_id, which has no length rule", async () => {
    const f = capture();
    await deliverToIntegration("amplitude", { apiKey: "k", region: "us" }, EVENT, f);
    const body = JSON.parse(f.calls[0]!.body) as { events: Record<string, unknown>[] };
    // Amplitude silently rejects a `user_id` shorter than five characters.
    expect(body.events[0]!.device_id).toBe("1");
    expect(body.events[0]!.user_id).toBeUndefined();
  });

  test("Google Chat refuses a webhook URL that is not Google's", async () => {
    const f = capture();
    // The credential is IN the URL, so posting to an attacker-chosen host
    // hands it over.
    const out = await deliverToIntegration(
      "google-chat",
      { webhookUrl: "https://attacker.test/v1/spaces/x?key=k&token=t" },
      EVENT,
      f,
    );
    expect(out.ok).toBe(false);
    expect(f.calls).toHaveLength(0);

    const good = await deliverToIntegration(
      "google-chat",
      { webhookUrl: "https://chat.googleapis.com/v1/spaces/x?key=k&token=t" },
      EVENT,
      f,
    );
    expect(good.ok).toBe(true);
  });

  test("none of the three receive the record", async () => {
    const f = capture();
    const withRecord = { ...EVENT, record: { id: "1", note: SECRET_VALUE } };
    for (const kind of ["mixpanel", "amplitude", "google-chat"] as const) {
      await deliverToIntegration(
        kind,
        {
          projectToken: "t",
          apiKey: "k",
          region: "us",
          webhookUrl: "https://chat.googleapis.com/v1/spaces/x?key=k",
        },
        withRecord,
        f,
      );
    }
    for (const c of f.calls) expect(c.body).not.toContain(SECRET_VALUE);
  });
});
