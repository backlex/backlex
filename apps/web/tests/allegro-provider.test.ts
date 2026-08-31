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
 *   - **It will only give its taxonomy one level at a time**, and that is what
 *     made the sixth shape learn to walk. Enumerating ~23,000 categories would
 *     be thousands of round trips, so `IntegrationListing` gained
 *     `categoryChildren` and the picker gained a drill-down. Allegro is the
 *     first provider to declare it, and asking it for the whole tree is an
 *     error rather than an empty picker.
 *   - **Its parameters endpoint was invisible to a naive scan of the published
 *     swagger**, and a live probe settled it: the path answers Allegro's own
 *     `401` where a path that does not exist answers a differently shaped
 *     `404`. Probe before believing an absence.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  fetchListingAttributes,
  fetchListingCategories,
  fetchListingCategoryChildren,
  INTEGRATION_LISTINGS,
  providerFor,
  publishListings,
  pullFromSource,
  resetThrottleState,
  runIntegrationTask,
} from "@backlex/integrations";

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
        { config: { ...CONFIG, _oauthAccessToken: "" }, settings: {}, cursor: null, limit: 200, connectionKey: "c1" },
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
      { config: CONFIG, settings: { lookbackDays: "7" }, cursor: null, limit: 200, connectionKey: "c1" },
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
      { config: CONFIG, settings: {}, cursor: null, limit: 200, connectionKey: "c1" },
      fetchImpl,
    );

    const rec = page.records[0]!;
    expect(rec.data.revision).toBe("2b31a1c");
    expect(rec.data.total).toBe(129.99);
    expect(rec.data.recipientName).toBe("Jan Kowalski");
    expect(rec.data.postCode).toBe("00-001");
    // The seller's OWN code, not Allegro's offer id — it is what a workspace
    // matches its product on.
    expect(rec.children!.lines![0]!.data.sku).toBe("SKU-1");
    expect(rec.children!.lines![0]!.data.offerId).toBe("1234");
    // The engine's only end-of-run signal is `cursor === null` (see
    // `integration-syncs.ts`). This provider ALSO returns `complete` and
    // `resumeAt`, and `SourcePullPage` declares neither — so both are inert.
    expect(page.cursor).toBeNull();
  });

  test("a page that is not the last keeps the window and holds the watermark", async () => {
    const { fetchImpl } = recorder([{ body: { checkoutForms: [form()], totalCount: 250 } }]);
    const page = await pullFromSource(
      "allegro",
      { config: CONFIG, settings: {}, cursor: null, limit: 200, connectionKey: "c1" },
      fetchImpl,
    );
    expect(page.cursor).not.toBeNull();
    expect(page.cursor).toMatch(/^\d+:1$/);
    // Moving it now would skip every order on the pages not yet read.
    expect(page.resumeToken).toBeUndefined();
  });

  test("a 406 is reported as the header fault it is, not as an outage", async () => {
    const { fetchImpl } = recorder([{ status: 406, body: {} }]);
    await expect(
      pullFromSource("allegro", { config: CONFIG, settings: {}, cursor: null, limit: 200, connectionKey: "c1" }, fetchImpl),
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

describe("the taxonomy it will not hand over", () => {
  test("it answers a LEVEL, not a tree — the reason the shape learned to walk", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          categories: [
            { id: "3", name: "Elektronika", leaf: false },
            { id: "9", name: "Smartfony", leaf: true },
          ],
        },
      },
    ]);
    const kids = await fetchListingCategoryChildren(
      "allegro",
      { config: CONFIG, parentId: "1", connectionKey: "c1" },
      fetchImpl,
    );

    expect(calls[0]!.url.pathname).toBe("/sale/categories");
    expect(calls[0]!.url.searchParams.get("parent.id")).toBe("1");
    // The parent comes from the WALK, not the payload: Allegro reports it only
    // sometimes, and the caller already knows which level it asked for.
    expect(kids).toEqual([
      { id: "3", name: "Elektronika", parentId: "1", leaf: false },
      { id: "9", name: "Smartfony", parentId: "1", leaf: true },
    ]);
  });

  test("no parent means the roots", async () => {
    const { calls, fetchImpl } = recorder([{ body: { categories: [{ id: "1", name: "Dom", leaf: false }] } }]);
    const roots = await fetchListingCategoryChildren(
      "allegro",
      { config: CONFIG, parentId: null, connectionKey: "c1" },
      fetchImpl,
    );
    expect(calls[0]!.url.searchParams.get("parent.id")).toBeNull();
    expect(roots[0]!.parentId).toBeNull();
  });

  test("asking it for the whole tree is an error, not an empty picker", async () => {
    const { fetchImpl } = recorder([]);
    // The caller has picked the wrong control; an empty list would read as
    // "this marketplace has no categories".
    await expect(
      fetchListingCategories("allegro", { config: CONFIG, connectionKey: "c1" }, fetchImpl),
    ).rejects.toThrow(/one level at a time/i);
  });

  test("the catalog says which control to draw, before any request is made", () => {
    expect(INTEGRATION_LISTINGS.allegro!.browse).toBe("levels");
    // Every other marketplace hands the tree over at once.
    expect(INTEGRATION_LISTINGS.trendyol!.browse).toBe("all");
  });
});

describe("what a category demands", () => {
  test("a dictionary parameter is closed unless Allegro allows a custom value", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          parameters: [
            {
              id: "11323",
              name: "Stan",
              type: "dictionary",
              required: true,
              restrictions: { multipleChoices: false },
              options: { customValuesEnabled: false },
              dictionary: [
                { id: "11323_1", value: "Nowy" },
                { id: "11323_2", value: "Używany" },
              ],
            },
            { id: "225693", name: "Waga", type: "float", required: false, unit: "kg" },
            {
              id: "9999",
              name: "Kolor",
              type: "dictionary",
              required: false,
              restrictions: { multipleChoices: true },
              options: { customValuesEnabled: true },
              dictionary: [{ id: "9999_1", value: "Czarny" }],
            },
          ],
        },
      },
    ]);
    const attrs = await fetchListingAttributes(
      "allegro",
      { config: CONFIG, categoryId: "9", connectionKey: "c1" },
      fetchImpl,
    );

    // The path the published swagger hid and a live probe proved: it answers
    // Allegro's own 401 where a path that does not exist answers a 404.
    expect(calls[0]!.url.pathname).toBe("/sale/categories/9/parameters");
    const byId = Object.fromEntries(attrs.map((a) => [a.id, a]));
    expect(byId["11323"]).toMatchObject({
      name: "Stan",
      required: true,
      allowCustom: false,
      multiple: false,
      // Allegro models variants as separate offers sharing a product, so no
      // parameter is marked as the varying one.
      variant: false,
      values: [
        { id: "11323_1", name: "Nowy" },
        { id: "11323_2", name: "Używany" },
      ],
    });
    // The three non-dictionary types are values the seller types.
    expect(byId["225693"]).toMatchObject({ name: "Waga (kg)", allowCustom: true, values: [] });
    expect(byId["9999"]).toMatchObject({ allowCustom: true, multiple: true });
  });
});

describe("publishing", () => {
  test("Allegro answers each create itself, so nothing is left to poll", async () => {
    const { calls, fetchImpl } = recorder([{ status: 201, body: { id: "offer-1" } }]);
    const batch = await publishListings(
      "allegro",
      {
        config: CONFIG,
        settings: { currency: "PLN" },
        products: [
          {
            rowId: "p1",
            groupId: "p1",
            categoryId: "9",
            fields: { title: "Walizka", description: "Twarda skorupa.", images: "https://cdn.test/a.jpg" },
            variants: [
              {
                rowId: "v1",
                reference: "SKU-1",
                fields: { sku: "SKU-1", price: 129.99, quantity: 3, ean: "4006381333931" },
                attributes: [{ attributeId: "11323", valueId: "11323_1" }],
              },
            ],
          },
        ],
        connectionKey: "c1",
      },
      fetchImpl,
    );

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url.pathname).toBe("/sale/product-offers");
    expect(post.headers["Content-Type"]).toBe("application/vnd.allegro.public.v1+json");
    // Ours, and the only thing tying Allegro's answer back to the row.
    expect(post.body.external).toEqual({ id: "SKU-1" });
    expect(post.body.sellingMode.price).toEqual({ amount: "129.99", currency: "PLN" });
    expect(post.body.productSet[0].product.parameters).toEqual([{ id: "11323", valuesIds: ["11323_1"] }]);
    // A bare sentence is refused by the description section, which wants a
    // block element.
    expect(post.body.description.sections[0].items[0].content).toBe("<p>Twarda skorupa.</p>");

    expect(batch.settled).toEqual([{ reference: "SKU-1", status: "accepted", externalId: "offer-1" }]);
    expect(batch.batchId).toBe("");
  });
});
