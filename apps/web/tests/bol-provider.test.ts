/**
 * bol.com — the marketplace that is NOT a listing, and the reason that is a
 * finding rather than a gap.
 *
 * Creating an offer here is `{ean, condition, pricing, stock, fulfilment}`: no
 * category, no attributes, no title, no images. You are not putting a product on
 * sale — you are adding an OFFER against a product already in bol's own
 * catalogue. Destination-shaped, exactly the call Hepsiburada's `fastlisting`
 * got. The last test pins the absence so nobody "completes" it by inventing a
 * category picker bol has no endpoint for.
 *
 * The rest is what is bol's alone:
 *
 *   - **A vendor media type** on `Accept` and `Content-Type`.
 *   - **`Content-Length: 0` on the token mint.** Without it bol's edge answers
 *     411, which reads like an outage rather than a malformed request. Probed:
 *     with it, bad credentials answer `401 {"error":"invalid_client"}`.
 *   - **The order list has no address**, so the detail is a second call per
 *     order — an N+1, and a failing one degrades to the summary rather than
 *     losing the order.
 *   - **The window is a DATE**, not a timestamp: bol filters on the day an item
 *     last changed.
 *   - **Every write answers 202.** Accepted, not applied.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  INTEGRATION_LISTINGS,
  listingFor,
  providerFor,
  pullFromSource,
  pushToDestination,
  resetThrottleState,
  runIntegrationTask,
} from "@backlex/integrations";

const CONFIG = { clientId: "cid", clientSecret: "csecret" };

beforeEach(() => resetThrottleState());

type Call = { url: URL; method: string; headers: Record<string, string>; body?: any };

/** Every call starts with a client-credentials token mint. */
const recorder = (responses: { status?: number; body?: unknown }[] = []) => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (u.hostname === "login.bol.com") {
      return new Response(JSON.stringify({ access_token: "atoken" }), { status: 200 });
    }
    const next = responses[i++] ?? {};
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  };
  return { calls, fetchImpl };
};

describe("connecting", () => {
  test("client-credentials, with the length header bol's edge insists on", async () => {
    const { calls, fetchImpl } = recorder([{ body: { orders: [] } }]);
    await pullFromSource("bol", { config: CONFIG, settings: {}, cursor: null, limit: 200, connectionKey: "c1" }, fetchImpl);

    const mint = calls[0]!;
    expect(mint.url.href).toBe("https://login.bol.com/token?grant_type=client_credentials");
    expect(mint.method).toBe("POST");
    expect(mint.headers.Authorization).toBe(`Basic ${btoa("cid:csecret")}`);
    // Without it bol answers 411 Bad Request, which reads like an outage.
    expect(mint.headers["Content-Length"]).toBe("0");
    // No consent screen and nobody to redirect.
    expect(providerFor("bol")!.oauth).toBeUndefined();
  });

  test("a refused mint does not quote the response that carries the secret", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "invalid_client", client_secret: "csecret" }), { status: 401 });
    await expect(
      pullFromSource("bol", { config: CONFIG, settings: {}, cursor: null, limit: 200, connectionKey: "c1" }, fetchImpl),
    ).rejects.toThrow(/client id and secret/i);
    await expect(
      pullFromSource("bol", { config: CONFIG, settings: {}, cursor: null, limit: 200, connectionKey: "c1" }, fetchImpl),
    ).rejects.not.toThrow(/csecret/);
  });
});

describe("orders", () => {
  const summary = {
    orders: [
      {
        orderId: "2200000000",
        orderPlacedDateTime: "2026-08-13T09:00:00+02:00",
        orderItems: [
          {
            orderItemId: "oi-1",
            ean: "8718526018349",
            fulfilmentMethod: "FBR",
            fulfilmentStatus: "OPEN",
            quantity: 2,
            quantityShipped: 0,
            quantityCancelled: 0,
            cancellationRequest: false,
            latestChangedDateTime: "2026-08-13T09:05:00+02:00",
          },
        ],
      },
    ],
  };
  const detail = {
    orderId: "2200000000",
    pickupPoint: false,
    shipmentDetails: {
      firstName: "Jan",
      surname: "de Vries",
      streetName: "Kalverstraat",
      houseNumber: "1",
      zipCode: "1012 NX",
      city: "Amsterdam",
      countryCode: "NL",
      email: "jan@example.test",
    },
    orderItems: [
      {
        orderItemId: "oi-1",
        ean: "8718526018349",
        product: { title: "Koffer" },
        offer: { offerId: "off-1", reference: "SKU-1" },
        quantity: 2,
        unitPrice: 64.99,
        fulfilmentStatus: "OPEN",
      },
    ],
  };

  test("the window is a DATE, and the address costs a second call", async () => {
    const { calls, fetchImpl } = recorder([{ body: summary }, { body: detail }]);
    const page = await pullFromSource(
      "bol",
      { config: CONFIG, settings: { lookbackDays: "7", status: "OPEN" }, cursor: null, limit: 200, connectionKey: "c1" },
      fetchImpl,
    );

    const list = calls[1]!;
    expect(list.headers.Accept).toBe("application/vnd.retailer.v10+json");
    expect(list.url.searchParams.get("status")).toBe("OPEN");
    // bol filters on the DAY an item last changed — coarser than every other
    // marketplace here, so the value is a date rather than a timestamp.
    expect(list.url.searchParams.get("latest-change-date")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The N+1 that sets the page size: the list carries no address at all.
    expect(calls[2]!.url.pathname).toBe("/retailer/orders/2200000000");

    const rec = page.records[0]!;
    expect(rec.data.zipCode).toBe("1012 NX");
    expect(rec.data.city).toBe("Amsterdam");
    expect(rec.children!.lines![0]!.data.offerId).toBe("off-1");
    // bol identifies a product by EAN — there is no seller SKU on an order.
    expect(rec.children!.lines![0]!.data.ean).toBe("8718526018349");
    // The engine's only end-of-run signal is `cursor === null` (see
    // `integration-syncs.ts`). This provider ALSO returns `complete` and
    // `resumeAt`, and `SourcePullPage` declares neither — so both are inert.
    expect(page.cursor).toBeNull();
  });

  test("an order whose detail bol will not give still arrives", async () => {
    const { fetchImpl } = recorder([{ body: summary }, { status: 404, body: {} }]);
    const page = await pullFromSource(
      "bol",
      { config: CONFIG, settings: {}, cursor: null, limit: 200, connectionKey: "c1" },
      fetchImpl,
    );
    // Degrading to the summary beats losing the order: the ids, quantities and
    // statuses are still what a fulfilment flow acts on.
    expect(page.records).toHaveLength(1);
    expect(page.records[0]!.data.city).toBeNull();
    expect(page.records[0]!.children!.lines).toHaveLength(1);
  });
});

describe("pushing price and stock", () => {
  test("two endpoints, and the fulfilment party decides who manages the stock", async () => {
    const { calls, fetchImpl } = recorder([{ status: 202, body: { processStatusId: "p1" } }, { status: 202, body: {} }]);
    await pushToDestination(
      "bol",
      {
        config: CONFIG,
        settings: { fulfilmentParty: "retailer" },
        rows: [{ offerId: "off-1", price: 24.95, stock: 7 }],
        columns: {},
        syncKey: "sync-1",
        connectionKey: "c1",
      },
      fetchImpl,
    );

    const price = calls.find((c) => c.url.pathname.endsWith("/price"))!;
    expect(price.method).toBe("PUT");
    expect(price.headers["Content-Type"]).toBe("application/vnd.retailer.v10+json");
    // bol prices by quantity band; one band of one is what "the price of this
    // offer" means.
    expect(price.body).toEqual({ pricing: { bundlePrices: [{ quantity: 1, unitPrice: 24.95 }] } });

    const stock = calls.find((c) => c.url.pathname.endsWith("/stock"))!;
    expect(stock.headers["X-Fulfilment-Party"]).toBe("retailer");
    expect(stock.body).toEqual({ amount: 7, managedByRetailer: true });
  });

  test("a row with only one of the two makes only that call", async () => {
    const { calls, fetchImpl } = recorder([{ status: 202, body: {} }]);
    await pushToDestination(
      "bol",
      { config: CONFIG, settings: {}, rows: [{ offerId: "off-1", stock: 3 }], columns: {}, syncKey: "sync-1", connectionKey: "c1" },
      fetchImpl,
    );
    expect(calls.some((c) => c.url.pathname.endsWith("/price"))).toBe(false);
    expect(calls.some((c) => c.url.pathname.endsWith("/stock"))).toBe(true);
  });

  test("a row with no offer id is skipped rather than guessed at", async () => {
    const { calls, fetchImpl } = recorder([]);
    await pushToDestination(
      "bol",
      { config: CONFIG, settings: {}, rows: [{ price: 9.99, stock: 1 }], columns: {}, syncKey: "sync-1", connectionKey: "c1" },
      fetchImpl,
    );
    // The offer id is bol's, and there is nothing sensible to do without one.
    expect(calls.filter((c) => c.url.hostname === "api.bol.com")).toHaveLength(0);
  });

  test("a violation names the field, which bol's status line does not", async () => {
    const { fetchImpl } = recorder([
      {
        status: 400,
        body: { title: "Bad Request", detail: "no", violations: [{ name: "pricing.bundlePrices", reason: "must not be empty" }] },
      },
    ]);
    await expect(
      pushToDestination(
        "bol",
        { config: CONFIG, settings: {}, rows: [{ offerId: "off-1", price: 1 }], columns: {}, syncKey: "sync-1", connectionKey: "c1" },
        fetchImpl,
      ),
    ).rejects.toThrow(/pricing\.bundlePrices: must not be empty/);
  });
});

describe("reporting a shipment", () => {
  test("the reference is the idempotency key, so a retry is the same shipment", async () => {
    const { calls, fetchImpl } = recorder([{ status: 202, body: { processStatusId: "ps-9" } }]);
    const res = await runIntegrationTask(
      "bol",
      "ship_order",
      {
        config: CONFIG,
        settings: { orderItemIdsField: "item_ids", transporterField: "carrier", trackingField: "tracking" },
        row: { item_ids: "oi-1,oi-2", carrier: "TNT", tracking: "3STOTA123456" },
        idempotencyKey: "task-run-abc",
        connectionKey: "c1",
      },
      fetchImpl,
    );

    const post = calls.find((c) => c.url.pathname === "/retailer/shipments")!;
    expect(post.body.orderItems).toEqual([{ orderItemId: "oi-1" }, { orderItemId: "oi-2" }]);
    expect(post.body.transport).toEqual({ transporterCode: "TNT", trackAndTrace: "3STOTA123456" });
    // Stable across every retry of this triple, so a retry bol does see reads
    // as the same shipment rather than a second one.
    expect(post.body.shipmentReference).toBe("task-run-abc");
    expect(res.outputs.processStatusId).toBe("ps-9");
    expect(res.outputs.reportedItems).toBe(2);
  });

  test("a row naming no items is refused rather than reported empty", async () => {
    const { fetchImpl } = recorder([]);
    await expect(
      runIntegrationTask(
        "bol",
        "ship_order",
        {
          config: CONFIG,
          settings: { orderItemIdsField: "item_ids", transporterField: "c", trackingField: "t" },
          row: { item_ids: "", c: "TNT", t: "3S" },
          idempotencyKey: "k1",
          connectionKey: "c1",
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/no bol\.com order item ids/i);
  });
});

describe("what bol deliberately is not", () => {
  test("it does not list, because an offer is not a product", () => {
    // `POST /retailer/offers` takes `{ean, condition, pricing, stock,
    // fulfilment}` — no category, no attributes, no title, no images. There is
    // no taxonomy endpoint to build a mapping form out of, and inventing one
    // would promise a screen bol has no answer for.
    expect(listingFor("bol")).toBeUndefined();
    expect(INTEGRATION_LISTINGS.bol).toBeUndefined();
    expect(providerFor("bol")!.capabilities).toEqual(["source", "destination", "task"]);
  });
});
