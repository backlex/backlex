/**
 * Allegro — Poland's largest marketplace, and the first European local here.
 *
 * Everything below came out of `developer.allegro.pl/swagger.yaml`, which is
 * 1.5 MB of OpenAPI served to anybody with no account and no bot wall — rare
 * enough in this package to be worth recording.
 *
 *   - **A vendor media type on every request.** `application/vnd.allegro.public.v1+json`.
 *     Allegro answers a plain `application/json` with 406, which reads like an
 *     outage rather than a header fault, so the provider says which it is.
 *   - **Orders mirror on `updatedAt`**, so a status change brings one back.
 *   - **The status write is optimistically concurrent** — it presents the
 *     revision the order was read at, which is why that value is pulled onto
 *     the row in the first place.
 *   - **There is no `listing` capability, and that is a decision.** Allegro
 *     will only give its taxonomy one level at a time, so enumerating ~23,000
 *     categories is thousands of round trips. The gap is in the engine's shape,
 *     not in this provider; the test at the bottom pins the absence so nobody
 *     "fixes" it by half-shipping a picker that only offers the top level.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { listingFor, providerFor, pullFromSource, resetThrottleState, runIntegrationTask } from "@backlex/integrations";

const CONFIG = {
  environment: "sandbox",
  clientId: "cid",
  clientSecret: "csecret",
  language: "en-US",
  _oauthAccessToken: "atoken",
};

beforeEach(() => resetThrottleState());

type Call = { url: URL; method: string; headers: Record<string, string>; body?: any };

const recorder = (responses: { status?: number; body?: unknown }[] = []) => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({
      url: new URL(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses[i++] ?? {};
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  };
  return { calls, fetchImpl };
};

const form = () => ({
  id: "8fd6b9e5-1111-2222-3333-444455556666",
  updatedAt: "2026-08-13T09:00:00.000Z",
  revision: "2b31a1c",
  status: "READY_FOR_PROCESSING",
  fulfillment: { status: "NEW" },
  buyer: { login: "kupujacy1", email: "k@example.test", firstName: "Jan", lastName: "Kowalski" },
  summary: { totalToPay: { amount: "129.99", currency: "PLN" } },
  delivery: {
    method: { name: "Kurier InPost" },
    address: {
      firstName: "Jan",
      lastName: "Kowalski",
      street: "Marszałkowska 1",
      city: "Warszawa",
      zipCode: "00-001",
      countryCode: "PL",
      phoneNumber: "+48123456789",
    },
  },
  lineItems: [
    {
      id: "li-1",
      offer: { id: "1234", name: "Walizka kabinowa", external: { id: "SKU-1" } },
      quantity: 2,
      price: { amount: "64.99", currency: "PLN" },
      boughtAt: "2026-08-13T08:00:00.000Z",
    },
  ],
});

describe("connecting", () => {
  test("OAuth, with an empty scope list on purpose", () => {
    const oauth = providerFor("allegro")!.oauth!;
    expect(oauth.authorizeUrl).toBe("https://allegro.pl/auth/oauth/authorize");
    expect(oauth.tokenAuth).toBe("basic");
    // Allegro scopes a token to what the APPLICATION was registered for, and
    // refuses an authorize that asks for more.
    expect(oauth.scopes).toEqual([]);
  });

  test("a connection with no access token says so instead of calling", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(
      pullFromSource(
        "allegro",
        { config: { ...CONFIG, _oauthAccessToken: "" }, settings: {}, cursor: null, connectionKey: "c1" },
        fetchImpl,
      ),
    ).rejects.toThrow(/OAuth consent/i);
    expect(calls).toHaveLength(0);
  });
});

describe("orders", () => {
  test("the vendor media type is sent, and the window bounds updatedAt", async () => {
    const { calls, fetchImpl } = recorder([{ body: { checkoutForms: [], totalCount: 0 } }]);
    await pullFromSource(
      "allegro",
      { config: CONFIG, settings: { lookbackDays: "7" }, cursor: null, connectionKey: "c1" },
      fetchImpl,
    );

    const call = calls[0]!;
    expect(call.url.hostname).toBe("api.allegro.pl.allegrosandbox.pl");
    // A plain application/json is a 406 here.
    expect(call.headers.Accept).toBe("application/vnd.allegro.public.v1+json");
    expect(call.headers["Accept-Language"]).toBe("en-US");
    expect(call.url.searchParams.get("updatedAt.gte")).toBeTruthy();
    expect(call.url.searchParams.get("limit")).toBe("100");
  });

  test("an order carries its revision, because the status write has to present it", async () => {
    const { fetchImpl } = recorder([{ body: { checkoutForms: [form()], totalCount: 1 } }]);
    const page = await pullFromSource(
      "allegro",
      { config: CONFIG, settings: {}, cursor: null, connectionKey: "c1" },
      fetchImpl,
    );

    const rec = page.records[0]!;
    expect(rec.data.revision).toBe("2b31a1c");
    expect(rec.data.total).toBe(129.99);
    expect(rec.data.recipientName).toBe("Jan Kowalski");
    expect(rec.data.postCode).toBe("00-001");
    // The seller's OWN code, not Allegro's offer id — it is what a workspace
    // matches its product on.
    expect(rec.children!.lines[0]!.data.sku).toBe("SKU-1");
    expect(rec.children!.lines[0]!.data.offerId).toBe("1234");
    expect(page.complete).toBe(true);
  });

  test("a page that is not the last keeps the window and holds the watermark", async () => {
    const { fetchImpl } = recorder([{ body: { checkoutForms: [form()], totalCount: 250 } }]);
    const page = await pullFromSource(
      "allegro",
      { config: CONFIG, settings: {}, cursor: null, connectionKey: "c1" },
      fetchImpl,
    );
    expect(page.complete).toBe(false);
    expect(page.cursor).toMatch(/^\d+:1$/);
    // Moving it now would skip every order on the pages not yet read.
    expect(page.resumeAt).toBeUndefined();
  });

  test("a 406 is reported as the header fault it is, not as an outage", async () => {
    const { fetchImpl } = recorder([{ status: 406, body: {} }]);
    await expect(
      pullFromSource("allegro", { config: CONFIG, settings: {}, cursor: null, connectionKey: "c1" }, fetchImpl),
    ).rejects.toThrow(/media type/i);
  });
});

describe("setting the seller status", () => {
  const settings = {
    orderIdField: "marketplace_order_id",
    revisionField: "marketplace_revision",
    status: "SENT",
    carrierField: "carrier_code",
    trackingField: "tracking_number",
  };
  const row = {
    marketplace_order_id: "8fd6b9e5",
    marketplace_revision: "2b31a1c",
    carrier_code: "INPOST",
    tracking_number: "600123456789",
  };

  test("the revision travels as a query parameter, which is what makes it safe", async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: {} }]);
    const res = await runIntegrationTask(
      "allegro",
      "set_fulfillment_status",
      { config: CONFIG, settings, row, idempotencyKey: "k1", connectionKey: "c1" },
      fetchImpl,
    );

    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url.pathname).toBe("/order/checkout-forms/8fd6b9e5/fulfillment");
    // Allegro refuses the write when the order moved since it was read.
    expect(call.url.searchParams.get("checkoutForm.revision")).toBe("2b31a1c");
    expect(call.body.status).toBe("SENT");
    expect(call.body.shipments).toEqual([{ carrierId: "INPOST", waybill: "600123456789" }]);
    expect(res.outputs.status).toBe("SENT");
  });

  test("a carrier without a waybill is not sent as half a shipment", async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: {} }]);
    await runIntegrationTask(
      "allegro",
      "set_fulfillment_status",
      { config: CONFIG, settings, row: { ...row, tracking_number: "" }, idempotencyKey: "k1", connectionKey: "c1" },
      fetchImpl,
    );
    // A waybill with no carrier is not a shipment Allegro can show a buyer, and
    // it rejects the pair half-filled.
    expect(calls[0]!.body.shipments).toBeUndefined();
    expect(calls[0]!.body.status).toBe("SENT");
  });

  test("no revision column means no revision sent — Allegro's own write-regardless", async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: {} }]);
    await runIntegrationTask(
      "allegro",
      "set_fulfillment_status",
      { config: CONFIG, settings: { ...settings, revisionField: "" }, row, idempotencyKey: "k1", connectionKey: "c1" },
      fetchImpl,
    );
    // Deliberately the operator's call rather than a silent default.
    expect(calls[0]!.url.searchParams.get("checkoutForm.revision")).toBeNull();
  });
});

describe("what is deliberately absent", () => {
  test("Allegro does not list, and the reason is its taxonomy rather than its API", () => {
    // `GET /sale/categories` returns the CHILDREN of one node and there is no
    // whole-tree endpoint, so `IntegrationListing.categories` — which hands
    // back the entire taxonomy for the engine to cache — cannot be answered
    // without thousands of round trips. Closing that means the shape learning
    // to be walked a level at a time, which is an extension to the engine and
    // the admin form, not a flag. Pinned so nobody half-ships a picker that
    // quietly offers only the top level.
    expect(listingFor("allegro")).toBeUndefined();
    expect(providerFor("allegro")!.capabilities).toEqual(["source", "task"]);
  });
});
