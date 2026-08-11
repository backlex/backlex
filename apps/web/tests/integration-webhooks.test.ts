/**
 * Inbound webhooks — a provider calling us, landing where a pull would.
 *
 * Both shipped providers are used for real here rather than mocked, because the
 * things worth pinning are the things a mock would define away: EasyPost's exact
 * `hmac-sha256-hex=` construction over the raw bytes, and Trendyol's
 * no-signature-at-all `x-api-key`. A fake provider would have verified whatever
 * this test signed.
 *
 * What the assertions are about, in order of how much they would cost to get
 * wrong:
 *
 *   - a delivery that cannot prove itself changes nothing and is refused 400
 *   - a retry is a DUPLICATE, not a second write — both providers retry, and
 *     Trendyol retries until it succeeds
 *   - a webhook and a poll of the same order converge on ONE row, because the
 *     delivery lands through the same sync's mapping and id namespace
 *   - a patch delivery writes the fields it carried and leaves the rest, which
 *     is the bug that already bit the task write-back once
 *   - the secret is returned once and never again
 *   - status codes are chosen for the PROVIDER: a ping is 200, because a 4xx
 *     would have Trendyol deactivate a working endpoint
 *
 * The registration call is stubbed at `globalThis.fetch`: enabling an endpoint
 * asks the provider to start calling, and a test suite must not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BASE = "/api/admin/integrations";
const realFetch = globalThis.fetch;

let h: TestHarness;
let client: Database;
let easypostId: string;
let trendyolId: string;
let fulfillmentsTable: string;
let ordersTable: string;

/** Registration calls the providers made, so the body can be asserted. */
let registrations: { url: string; body: any; method: string }[] = [];
/** What a stubbed registration answers. `fail` exercises "live but not told". */
let registerMode: "ok" | "fail" = "ok";

const stubProviders = () => {
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.startsWith("https://api.easypost.com/") || u.includes("trendyol.com/")) {
      registrations.push({
        url: u,
        method: String(init?.method ?? "GET"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (registerMode === "fail") {
        return new Response(JSON.stringify({ error: { message: "no" } }), { status: 401 });
      }
      // Both providers answer with the registration's own id, under `id`.
      return new Response(JSON.stringify({ id: u.includes("easypost") ? "hook_abc" : "78" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(url, init);
  }) as typeof fetch;
};

const req = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  h.fetch(path, {
    method,
    ...(body === undefined
      ? { ...(headers ? { headers } : {}) }
      : {
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
  });

const ok = async (method: string, path: string, body?: unknown) => {
  const res = await req(method, path, body);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as any;
};

const rows = (table: string) =>
  client.query(`select * from "${table}" order by id`).all() as Record<string, unknown>[];

const deliveryRows = () =>
  client.query("select * from integration_webhook_deliveries").all() as Record<string, unknown>[];

/** EasyPost's construction, verbatim: NFKD secret, raw body, prefixed hex. */
const easypostSignature = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret.normalize("NFKD")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  return `hmac-sha256-hex=${hex}`;
};

const trackerEvent = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "evt_1",
    object: "Event",
    description: "tracker.updated",
    result: {
      object: "Tracker",
      shipment_id: "shp_1",
      tracking_code: "1Z999",
      status: "in_transit",
      est_delivery_date: "2026-08-20T00:00:00Z",
      public_url: "https://track.easypost.com/1Z999",
      tracking_details: [{ status: "in_transit", message: "Departed facility", datetime: "2026-08-12T09:00:00Z" }],
      ...over,
    },
  });

const packageEnvelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    totalElements: 1,
    content: [
      {
        shipmentPackageId: 55501,
        orderNumber: "TY-9001",
        status: "SHIPPED",
        cargoTrackingNumber: "TRK-77",
        packageTotalPrice: 249.9,
        currencyCode: "TRY",
        lines: [{ lineId: 1, barcode: "BAR-1", productName: "Tee", quantity: 2, lineUnitPrice: 124.95 }],
        ...over,
      },
    ],
  });

beforeAll(async () => {
  stubProviders();
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);

  await ok("POST", "/api/collections", {
    slug: "fulfillments",
    fields: [
      { name: "carrier_shipment_id", type: "text" },
      { name: "shipment_status", type: "text" },
      { name: "tracking_number", type: "text" },
      { name: "tracking_url", type: "text" },
      // Nothing maps onto this one. It exists to be left alone: a patch that
      // planned a column for every field would blank it, which is exactly the
      // bug the task write-back shipped with once.
      { name: "order_ref", type: "text" },
    ],
  });
  await ok("POST", "/api/collections", {
    slug: "ty_orders",
    fields: [
      { name: "order_number", type: "text" },
      { name: "status", type: "text" },
      { name: "tracking", type: "text" },
    ],
  });
  const table = (slug: string) =>
    (client.query("select physical_table as t from collections where slug = ?").get(slug) as { t: string }).t;
  fulfillmentsTable = table("fulfillments");
  ordersTable = table("ty_orders");

  easypostId = (
    await ok("POST", BASE, {
      kind: "easypost",
      config: {
        apiKey: "EZTK_test",
        fromName: "Warehouse",
        fromStreet1: "1 Depot Rd",
        fromCity: "Istanbul",
        fromZip: "34000",
        fromCountry: "TR",
      },
    })
  ).data.id;
  trendyolId = (
    await ok("POST", BASE, {
      kind: "trendyol",
      config: {
        sellerId: "12345",
        apiKey: "k",
        apiSecret: "s",
        storeFrontCode: "TR",
        environment: "production",
      },
    })
  ).data.id;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  h.cleanup();
});

beforeEach(() => {
  registrations = [];
  registerMode = "ok";
  client.query("delete from integration_webhook_deliveries").run();
  client.query("delete from integration_syncs").run();
  client.query(`delete from "${fulfillmentsTable}"`).run();
  client.query(`delete from "${ordersTable}"`).run();
});

/**
 * The fulfillment a carrier delivery is about, created the way a person or a
 * booking task would create it.
 *
 * Through the API rather than by INSERT, deliberately: the row has to carry the
 * workspace the same way every other row does, and a hand-written insert with no
 * `tenant_id` is a row the match lookup is right not to find.
 */
const seedFulfillment = async () =>
  ok("POST", "/api/items/fulfillments", {
    carrier_shipment_id: "shp_1",
    shipment_status: "pre_transit",
    order_ref: "ORD-1001",
  });

/** An inbound-only sync for the carrier, plus its endpoint. */
const carrierEndpoint = async (over: Record<string, unknown> = {}) => {
  const sync = await ok("POST", `${BASE}/syncs`, {
    integrationId: easypostId,
    collection: "fulfillments",
    direction: "inbound",
    matchField: "carrier_shipment_id",
    mapping: {
      shipmentStatus: "shipment_status",
      trackingCode: "tracking_number",
      trackingUrl: "tracking_url",
    },
    ...over,
  });
  const endpoint = await ok("POST", `${BASE}/syncs/${sync.data.id}/webhook`, {});
  return { syncId: sync.data.id as string, endpoint: endpoint.data };
};

/** A polling marketplace sync that ALSO receives deliveries. */
const marketplaceEndpoint = async (events?: string[]) => {
  const sync = await ok("POST", `${BASE}/syncs`, {
    integrationId: trendyolId,
    collection: "ty_orders",
    direction: "pull",
    settings: { lookbackDays: "1" },
    intervalMinutes: 15,
    mapping: { orderNumber: "order_number", status: "status", cargoTrackingNumber: "tracking" },
  });
  const endpoint = await ok("POST", `${BASE}/syncs/${sync.data.id}/webhook`, events ? { events } : {});
  return { syncId: sync.data.id as string, endpoint: endpoint.data };
};

const post = (path: string, body: string, headers: Record<string, string>) =>
  h.fetch(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

describe("turning the endpoint on", () => {
  test("mints a URL and secret, and tells the provider", async () => {
    await seedFulfillment();
    const { endpoint } = await carrierEndpoint();

    expect(endpoint.url).toContain("/api/integrations/hooks/");
    expect(endpoint.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(endpoint.registered).toBe(true);

    // The provider was handed the URL and the secret, not an id of ours.
    const call = registrations.find((r) => r.url.endsWith("/webhooks"));
    expect(call?.body.webhook.url).toBe(endpoint.url);
    expect(call?.body.webhook.webhook_secret).toBe(endpoint.secret);
  });

  test("the secret is returned once and never again", async () => {
    await seedFulfillment();
    const { syncId, endpoint } = await carrierEndpoint();
    const list = await ok("GET", `${BASE}/syncs`);
    const found = list.data.find((s: any) => s.id === syncId);

    // The endpoint is described — path, events, whether the provider knows —
    // and the credential is not in it.
    expect(found.webhook.path).toBe(new URL(endpoint.url).pathname);
    expect(found.webhook.registered).toBe(true);
    expect(JSON.stringify(found)).not.toContain(endpoint.secret);
  });

  test("it is stored encrypted, not in the clear", async () => {
    await seedFulfillment();
    const { endpoint } = await carrierEndpoint();
    const row = client.query("select webhook_secret as s from integration_syncs").get() as { s: string };
    expect(row.s).not.toBe(endpoint.secret);
    expect(row.s.length).toBeGreaterThan(endpoint.secret.length);
  });

  test("a failed registration leaves the endpoint live and says so", async () => {
    // The URL and secret are real; one API call failed. Rolling back would throw
    // away a secret the operator has already been shown.
    registerMode = "fail";
    await seedFulfillment();
    const { endpoint } = await carrierEndpoint();
    expect(endpoint.secret).toBeTruthy();
    expect(endpoint.registered).toBe(false);
    expect(endpoint.registrationError).toBeTruthy();
  });

  test("a carrier endpoint is refused without a match field", async () => {
    // Its deliveries are about rows somebody else created. Without the column to
    // find them in, every delivery would be understood and applied to nothing.
    const res = await req("POST", `${BASE}/syncs`, {
      integrationId: easypostId,
      collection: "fulfillments",
      direction: "inbound",
      mapping: { shipmentStatus: "shipment_status" },
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("match");
  });

  test("a marketplace endpoint refuses a match field", async () => {
    // Its deliveries ARE the record and are addressed by the namespaced id. A
    // match field there would invite writing to the wrong row.
    const res = await req("POST", `${BASE}/syncs`, {
      integrationId: trendyolId,
      collection: "ty_orders",
      direction: "pull",
      settings: { lookbackDays: "1" },
      matchField: "order_number",
      mapping: { orderNumber: "order_number" },
    });
    expect(res.status).toBe(422);
  });

  test("rotating keeps the URL and changes the secret", async () => {
    await seedFulfillment();
    const { syncId, endpoint } = await carrierEndpoint();
    const rotated = await ok("POST", `${BASE}/syncs/${syncId}/webhook`, {});

    expect(rotated.data.url).toBe(endpoint.url);
    expect(rotated.data.secret).not.toBe(endpoint.secret);

    // The old secret stops working the moment the new one is minted.
    const body = trackerEvent();
    const stale = await post(new URL(endpoint.url).pathname, body, {
      "x-hmac-signature": await easypostSignature(endpoint.secret, body),
    });
    expect(stale.status).toBe(400);
  });

  test("an inbound sync has nothing to run", async () => {
    const { syncId } = await carrierEndpoint();
    const res = await req("POST", `${BASE}/syncs/${syncId}/run`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("nothing to run");
  });
});

describe("a signed carrier delivery", () => {
  test("patches the row the shipment id names, and leaves the rest", async () => {
    await seedFulfillment();
    const { endpoint } = await carrierEndpoint();
    const body = trackerEvent();
    const res = await post(new URL(endpoint.url).pathname, body, {
      "x-hmac-signature": await easypostSignature(endpoint.secret, body),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("applied");

    const row = rows(fulfillmentsTable)[0]!;
    expect(row.shipment_status).toBe("in_transit");
    expect(row.tracking_number).toBe("1Z999");
    // The column nothing mapped. A patch plans only the columns present; an
    // upsert here would have blanked it.
    expect(row.order_ref).toBe("ORD-1001");
    // And no second row was minted beside it.
    expect(rows(fulfillmentsTable)).toHaveLength(1);
  });

  test("an unsigned delivery changes nothing and is refused", async () => {
    await seedFulfillment();
    const { endpoint } = await carrierEndpoint();
    const res = await post(new URL(endpoint.url).pathname, trackerEvent(), {});

    expect(res.status).toBe(400);
    expect(rows(fulfillmentsTable)[0]!.shipment_status).toBe("pre_transit");
    // Recorded, because "somebody is posting to this endpoint and failing" is
    // exactly what an operator needs to see.
    expect(deliveryRows()[0]!.status).toBe("rejected");
  });

  test("a signature over different bytes is refused", async () => {
    // The signature covers the body it was computed over. Re-serializing on the
    // way in would break this, which is why the route reads the raw text.
    await seedFulfillment();
    const { endpoint } = await carrierEndpoint();
    const res = await post(new URL(endpoint.url).pathname, trackerEvent({ status: "delivered" }), {
      "x-hmac-signature": await easypostSignature(endpoint.secret, trackerEvent()),
    });
    expect(res.status).toBe(400);
    expect(rows(fulfillmentsTable)[0]!.shipment_status).toBe("pre_transit");
  });

  test("a retry is a duplicate, not a second write", async () => {
    await seedFulfillment();
    const { endpoint } = await carrierEndpoint();
    const body = trackerEvent();
    const headers = { "x-hmac-signature": await easypostSignature(endpoint.secret, body) };
    const path = new URL(endpoint.url).pathname;

    expect((await (await post(path, body, headers)).json()).status).toBe("applied");
    const again = await post(path, body, headers);

    expect(again.status).toBe(200);
    expect((await again.json()).status).toBe("duplicate");
    // One delivery row, not two: the guard is the unique index on the id.
    expect(deliveryRows()).toHaveLength(1);
  });

  test("a tracker for a parcel we did not book is understood, and matches nothing", async () => {
    await seedFulfillment();
    const { endpoint } = await carrierEndpoint();
    const body = trackerEvent({ shipment_id: "shp_someone_else" });
    const res = await post(new URL(endpoint.url).pathname, body, {
      "x-hmac-signature": await easypostSignature(endpoint.secret, body),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("unmatched");
    expect(rows(fulfillmentsTable)[0]!.shipment_status).toBe("pre_transit");
    // Visible in the log with the id it looked for — the whole answer to "why
    // isn't my tracking updating".
    const logged = deliveryRows()[0]!;
    expect(logged.status).toBe("unmatched");
    expect(String(logged.error)).toContain("shp_someone_else");
  });

  test("an event kind we do not read is accepted, not refused", async () => {
    // A 4xx would have a provider disable an endpoint that is working, and a
    // 5xx would have it retry a body it will never send differently.
    await seedFulfillment();
    const { endpoint } = await carrierEndpoint();
    const body = JSON.stringify({ id: "evt_2", description: "batch.created", result: {} });
    const res = await post(new URL(endpoint.url).pathname, body, {
      "x-hmac-signature": await easypostSignature(endpoint.secret, body),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ignored");
  });

  test("turning the endpoint off stops it resolving", async () => {
    await seedFulfillment();
    const { syncId, endpoint } = await carrierEndpoint();
    await ok("DELETE", `${BASE}/syncs/${syncId}/webhook`);

    const body = trackerEvent();
    const res = await post(new URL(endpoint.url).pathname, body, {
      "x-hmac-signature": await easypostSignature(endpoint.secret, body),
    });
    expect(res.status).toBe(404);
  });

  test("a disabled sync tells the provider to stop", async () => {
    await seedFulfillment();
    const { syncId, endpoint } = await carrierEndpoint();
    await ok("PATCH", `${BASE}/syncs/${syncId}`, { enabled: false });

    const body = trackerEvent();
    const res = await post(new URL(endpoint.url).pathname, body, {
      "x-hmac-signature": await easypostSignature(endpoint.secret, body),
    });
    // 4xx on purpose: a 5xx would have the provider queue an hour of deliveries
    // to replay the moment the sync is switched back on.
    expect(res.status).toBe(403);
    expect(rows(fulfillmentsTable)[0]!.shipment_status).toBe("pre_transit");
  });
});

describe("a marketplace delivery", () => {
  test("lands the order and its lines through the sync's own mapping", async () => {
    const { endpoint } = await marketplaceEndpoint();
    const res = await post(new URL(endpoint.url).pathname, packageEnvelope(), {
      "x-api-key": endpoint.secret,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("applied");

    const order = rows(ordersTable)[0]!;
    expect(order.order_number).toBe("TY-9001");
    expect(order.status).toBe("SHIPPED");
    expect(order.tracking).toBe("TRK-77");
  });

  test("the id is the one a poll would have written, so the two converge", async () => {
    // The point of hanging the endpoint on the sync row. A webhook with its own
    // identity would mint a second, emptier copy of every order the poll has.
    const { syncId, endpoint } = await marketplaceEndpoint();
    await post(new URL(endpoint.url).pathname, packageEnvelope(), { "x-api-key": endpoint.secret });

    const order = rows(ordersTable)[0]!;
    expect(order.id).toBe(`trendyol_${syncId.slice(0, 8)}_55501`);
  });

  test("a second delivery for the same package updates it in place", async () => {
    const { endpoint } = await marketplaceEndpoint();
    const path = new URL(endpoint.url).pathname;
    await post(path, packageEnvelope(), { "x-api-key": endpoint.secret });
    await post(path, packageEnvelope({ status: "DELIVERED" }), { "x-api-key": endpoint.secret });

    const all = rows(ordersTable);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("DELIVERED");
  });

  test("the wrong key is refused, and a missing one too", async () => {
    const { endpoint } = await marketplaceEndpoint();
    const path = new URL(endpoint.url).pathname;

    expect((await post(path, packageEnvelope(), { "x-api-key": "nope" })).status).toBe(400);
    expect((await post(path, packageEnvelope(), {})).status).toBe(400);
    expect(rows(ordersTable)).toHaveLength(0);
  });

  test("HTTP Basic carries the secret too", async () => {
    // The other authentication type a seller may have configured by hand. Only
    // the password is checked: Trendyol lets the seller choose the username.
    const { endpoint } = await marketplaceEndpoint();
    const res = await post(new URL(endpoint.url).pathname, packageEnvelope(), {
      authorization: `Basic ${btoa(`anyone:${endpoint.secret}`)}`,
    });
    expect(res.status).toBe(200);
  });

  test("an event the endpoint is not subscribed to is filtered", async () => {
    const { endpoint } = await marketplaceEndpoint(["CREATED"]);
    const res = await post(new URL(endpoint.url).pathname, packageEnvelope({ status: "DELIVERED" }), {
      "x-api-key": endpoint.secret,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("filtered");
    expect(rows(ordersTable)).toHaveLength(0);
  });

  test("the subscription's events are what the provider was told", async () => {
    await marketplaceEndpoint(["CREATED", "SHIPPED"]);
    const call = registrations.find((r) => r.url.includes("/webhook/sellers/"));
    expect(call?.body.subscribedStatuses).toEqual(["CREATED", "SHIPPED"]);
    expect(call?.body.authenticationType).toBe("API_KEY");
  });

  test("an event the provider does not send is refused at the form", async () => {
    const { syncId } = await marketplaceEndpoint();
    const res = await req("PATCH", `${BASE}/syncs/${syncId}/webhook`, { events: ["NOPE"] });
    expect(res.status).toBe(422);
  });

  test("a ping is accepted and recorded, not refused", async () => {
    const { endpoint } = await marketplaceEndpoint();
    const res = await post(new URL(endpoint.url).pathname, JSON.stringify({ ping: true }), {
      "x-api-key": endpoint.secret,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ignored");
    expect(deliveryRows()[0]!.status).toBe("ignored");
  });
});

describe("the delivery log", () => {
  test("records what arrived, with the verdict and the rows written", async () => {
    const { syncId, endpoint } = await marketplaceEndpoint();
    await post(new URL(endpoint.url).pathname, packageEnvelope(), { "x-api-key": endpoint.secret });

    const list = await ok("GET", `${BASE}/syncs/${syncId}/deliveries`);
    expect(list.data).toHaveLength(1);
    expect(list.data[0].status).toBe("applied");
    expect(list.data[0].event).toBe("SHIPPED");
    expect(list.data[0].rowsWritten).toBeGreaterThan(0);
  });

  test("one workspace cannot read another's deliveries", async () => {
    const { syncId, endpoint } = await marketplaceEndpoint();
    await post(new URL(endpoint.url).pathname, packageEnvelope(), { "x-api-key": endpoint.secret });
    // The log is tenant-scoped, so a sync id from elsewhere reads as empty
    // rather than as somebody else's traffic.
    client.query("update integration_webhook_deliveries set tenant_id = 'other'").run();
    const list = await ok("GET", `${BASE}/syncs/${syncId}/deliveries`);
    expect(list.data).toHaveLength(0);
  });
});

describe("the catalog", () => {
  test("describes each provider's endpoint without exposing its functions", async () => {
    const catalog = await ok("GET", `${BASE}/catalog`);

    expect(catalog.data.webhooks.easypost).toMatchObject({
      auth: "hmac",
      header: "X-Hmac-Signature",
      landing: "patch",
      selfRegistering: true,
    });
    expect(catalog.data.webhooks.trendyol).toMatchObject({ auth: "header", landing: "upsert" });
    // A provider that only answers requests we make has no endpoint to offer.
    expect(catalog.data.webhooks.slack).toBeUndefined();
    // `capabilities` is what the connect UI branches on, so the two must agree.
    const easypost = catalog.data.providers.find((p: any) => p.id === "easypost");
    expect(easypost.capabilities).toContain("webhook");
  });
});

describe("guessing a token", () => {
  test("a token that resolves to nothing is a 404, whatever it looks like", async () => {
    for (const token of ["short", "../../etc", "0".repeat(64)]) {
      const res = await post(`/api/integrations/hooks/${encodeURIComponent(token)}`, "{}", {});
      expect(res.status).toBe(404);
    }
  });
});
