/**
 * eBay — the sixth marketplace, and the first reached over OAuth.
 *
 * Everything asserted here is something no other provider in this package does,
 * and all of it came out of eBay's own OpenAPI contracts (read through a real
 * browser: the portal answers 403 to anything automated).
 *
 *   - **The redirect is a RuName, not a URL.** eBay's authorization-code flow
 *     puts an opaque handle in `redirect_uri`, so the provider declares
 *     `redirectUriFrom` and the engine sends what the seller pasted.
 *   - **Listing is three calls** — inventory item, offer, publish — and the
 *     publish answers with the verdict, so nothing is polled and there is no
 *     batch id. This is the provider that made `ListingBatch.rejected` a lie
 *     and got it renamed to `settled`.
 *   - **`aspectEnabledForVariations`** is eBay saying which aspect two units
 *     may differ on. It is the first marketplace here to answer that directly.
 *   - **`Content-Language` is required on the write calls**, and it follows the
 *     marketplace rather than the seller's browser.
 *   - Its own spec types `Product.aspects` as a `string`; it is a map of name to
 *     an array of values.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  fetchListingAttributes,
  fetchListingCategories,
  listingFor,
  providerFor,
  publishListings,
  pullFromSource,
  resetThrottleState,
  runIntegrationTask,
} from "@backlex/integrations";

const CONFIG = {
  environment: "sandbox",
  marketplaceId: "EBAY_DE",
  clientId: "cid",
  clientSecret: "csecret",
  ruName: "Acme-Acme-abcde-xyz",
  _oauthAccessToken: "atoken",
};

const SETTINGS = {
  currency: "EUR",
  condition: "NEW",
  merchantLocationKey: "warehouse-1",
  fulfillmentPolicyId: "fp-1",
  paymentPolicyId: "pp-1",
  returnPolicyId: "rp-1",
};

beforeEach(() => resetThrottleState());

type Call = { url: URL; method: string; headers: Record<string, string>; body?: any };

const recorder = (responses: { status?: number; body?: unknown; headers?: Record<string, string> }[] = []) => {
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
    return new Response(next.body === undefined ? "{}" : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  };
  return { calls, fetchImpl };
};

const product = () => ({
  rowId: "p1",
  groupId: "p1",
  categoryId: "9355",
  fields: {
    title: "Cabin Case",
    description: "<p>A hard-shell cabin case.</p>",
    brand: "Northwind",
    images: "https://cdn.test/a.jpg\nhttps://cdn.test/b.jpg",
  },
  variants: [
    {
      rowId: "v1",
      reference: "SKU-1",
      fields: { sku: "SKU-1", price: 79.9, quantity: 12, ean: "4006381333931" },
      attributes: [{ attributeId: "Colour", valueId: "Black" }],
    },
  ],
});

describe("connecting", () => {
  test("the redirect is eBay's own handle, not this instance's callback URL", () => {
    const oauth = providerFor("ebay")!.oauth!;
    // eBay does not accept a URL here at all: the real callback is registered
    // against the RuName in eBay's portal, so the value has to be pasted.
    expect(oauth.redirectUriFrom).toBe("ruName");
    expect(oauth.authorizeUrl).toBe("https://auth.ebay.com/oauth2/authorize");
    expect(oauth.tokenUrl).toBe("https://api.ebay.com/identity/v1/oauth2/token");
    // eBay presents the client credentials as HTTP Basic and has no PKCE here.
    expect(oauth.tokenAuth).toBe("basic");
    expect(oauth.pkce ?? false).toBe(false);
  });

  test("a connection with no access token says so instead of calling", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(
      fetchListingCategories("ebay", { config: { ...CONFIG, _oauthAccessToken: "" }, connectionKey: "c1" }, fetchImpl),
    ).rejects.toThrow(/OAuth consent/i);
    expect(calls).toHaveLength(0);
  });
});

describe("orders", () => {
  test("the window bounds LAST MODIFIED, so a status change comes back", async () => {
    const { calls, fetchImpl } = recorder([{ body: { orders: [], total: 0 } }]);
    await pullFromSource(
      "ebay",
      { config: CONFIG, settings: { lookbackDays: "7" }, cursor: null, connectionKey: "c1" },
      fetchImpl,
    );
    const filter = calls[0]!.url.searchParams.get("filter")!;
    expect(filter).toStartWith("lastmodifieddate:[");
    expect(filter).toEndWith("..]");
    expect(calls[0]!.headers["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_DE");
    expect(calls[0]!.headers.Authorization).toBe("Bearer atoken");
  });

  test("lines arrive WITH the order — no second call per order", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          orders: [
            {
              orderId: "12-345-678",
              lastModifiedDate: "2026-08-13T10:00:00.000Z",
              orderFulfillmentStatus: "NOT_STARTED",
              buyer: { username: "kaeufer1" },
              pricingSummary: { total: { value: "79.90", currency: "EUR" } },
              fulfillmentStartInstructions: [
                {
                  shippingStep: {
                    shipTo: {
                      fullName: "Anna Muster",
                      contactAddress: { addressLine1: "Hauptstr. 1", city: "Berlin", postalCode: "10115", countryCode: "DE" },
                    },
                  },
                },
              ],
              lineItems: [{ lineItemId: "li-1", sku: "SKU-1", title: "Cabin Case", quantity: 1, lineItemCost: { value: "79.90", currency: "EUR" } }],
            },
          ],
        },
      },
    ]);
    const page = await pullFromSource(
      "ebay",
      { config: CONFIG, settings: {}, cursor: null, connectionKey: "c1" },
      fetchImpl,
    );

    expect(calls).toHaveLength(1);
    expect(page.records).toHaveLength(1);
    const rec = page.records[0]!;
    expect(rec.externalId).toBe("12-345-678");
    expect(rec.data.total).toBe(79.9);
    expect(rec.data.recipientName).toBe("Anna Muster");
    expect(rec.data.postalCode).toBe("10115");
    expect(rec.children!.lines).toHaveLength(1);
    expect(rec.children!.lines[0]!.externalId).toBe("li-1");
    // Nothing more to fetch, so the watermark may move.
    expect(page.complete).toBe(true);
  });

  test("a page that is not the last keeps the window and does NOT move the watermark", async () => {
    const { fetchImpl } = recorder([
      { body: { orders: [{ orderId: "a", lineItems: [] }], next: "https://api.ebay.com/…?offset=50" } },
    ]);
    const page = await pullFromSource(
      "ebay",
      { config: CONFIG, settings: {}, cursor: null, connectionKey: "c1" },
      fetchImpl,
    );
    expect(page.complete).toBe(false);
    // `<since>:<offset>` — the window start travels with the offset, so a
    // resumed walk cannot silently restart at "now".
    expect(page.cursor).toMatch(/^\d+:1$/);
    expect(page.resumeAt).toBeUndefined();
  });
});

describe("the taxonomy", () => {
  const tree = {
    rootCategoryNode: {
      category: { categoryId: "0", categoryName: "Root" },
      childCategoryTreeNodes: [
        {
          category: { categoryId: "11450", categoryName: "Kleidung" },
          childCategoryTreeNodes: [
            { category: { categoryId: "9355", categoryName: "Taschen" }, leafCategoryTreeNode: true },
          ],
        },
      ],
    },
  };

  test("eBay's nested tree is flattened with parent pointers", async () => {
    const { calls, fetchImpl } = recorder([{ body: { categoryTreeId: "77" } }, { body: tree }]);
    const cats = await fetchListingCategories("ebay", { config: CONFIG, connectionKey: "c1" }, fetchImpl);

    expect(calls[0]!.url.pathname).toEndWith("/get_default_category_tree_id");
    expect(calls[0]!.url.searchParams.get("marketplace_id")).toBe("EBAY_DE");
    expect(calls[1]!.url.pathname).toEndWith("/category_tree/77");
    // The root is not offered — it is not a category anybody lists against.
    expect(cats).toEqual([
      { id: "11450", name: "Kleidung", parentId: null, leaf: false },
      { id: "9355", name: "Taschen", parentId: "11450", leaf: true },
    ]);
  });

  test("aspects carry the one flag no other marketplace here reports", async () => {
    const { fetchImpl } = recorder([
      { body: { categoryTreeId: "77" } },
      {
        body: {
          aspects: [
            {
              localizedAspectName: "Farbe",
              aspectConstraint: {
                aspectRequired: true,
                aspectMode: "SELECTION_ONLY",
                aspectEnabledForVariations: true,
                itemToAspectCardinality: "SINGLE",
              },
              aspectValues: [{ localizedValue: "Schwarz" }, { localizedValue: "Blau" }],
            },
            {
              localizedAspectName: "Besonderheiten",
              aspectConstraint: {
                aspectRequired: false,
                aspectMode: "FREE_TEXT",
                aspectEnabledForVariations: false,
                itemToAspectCardinality: "MULTI",
              },
              aspectValues: [],
            },
          ],
        },
      },
    ]);
    const attrs = await fetchListingAttributes("ebay", { config: CONFIG, categoryId: "9355", connectionKey: "c1" }, fetchImpl);
    const byId = Object.fromEntries(attrs.map((a) => [a.id, a]));

    expect(byId.Farbe).toMatchObject({
      required: true,
      allowCustom: false,
      // Amazon cannot answer this; eBay says it outright.
      variant: true,
      multiple: false,
      values: [
        { id: "Schwarz", name: "Schwarz" },
        { id: "Blau", name: "Blau" },
      ],
    });
    expect(byId.Besonderheiten).toMatchObject({ required: false, allowCustom: true, variant: false, multiple: true });
    // Required first, same as everywhere else in this package.
    expect(attrs[0]!.id).toBe("Farbe");
  });
});

describe("publishing", () => {
  const ok = () => [
    { status: 204 },
    { body: { offerId: "of-1" } },
    { body: { listingId: "v1|1234|0" } },
  ];

  test("three calls: describe the item, offer it, publish the offer", async () => {
    const { calls, fetchImpl } = recorder(ok());
    const batch = await publishListings(
      "ebay",
      { config: CONFIG, settings: SETTINGS, products: [product()], connectionKey: "c1" },
      fetchImpl,
    );

    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "PUT /sell/inventory/v1/inventory_item/SKU-1",
      "POST /sell/inventory/v1/offer",
      "POST /sell/inventory/v1/offer/of-1/publish",
    ]);
    // Sandbox is a host, not a flag.
    expect(calls[0]!.url.hostname).toBe("api.sandbox.ebay.com");
    // Required on the write calls, and it follows the marketplace.
    expect(calls[0]!.headers["Content-Language"]).toBe("de-DE");

    const item = calls[0]!.body;
    expect(item.availability.shipToLocationAvailability.quantity).toBe(12);
    expect(item.condition).toBe("NEW");
    expect(item.product.imageUrls).toEqual(["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"]);
    expect(item.product.ean).toEqual(["4006381333931"]);
    // Its own spec says `string`; it is a map of name to an ARRAY of values.
    expect(item.product.aspects).toEqual({ Colour: ["Black"] });

    const offer = calls[1]!.body;
    expect(offer).toMatchObject({
      sku: "SKU-1",
      marketplaceId: "EBAY_DE",
      format: "FIXED_PRICE",
      categoryId: "9355",
      availableQuantity: 12,
      merchantLocationKey: "warehouse-1",
      listingPolicies: { fulfillmentPolicyId: "fp-1", paymentPolicyId: "pp-1", returnPolicyId: "rp-1" },
    });
    expect(offer.pricingSummary.price).toEqual({ value: "79.9", currency: "EUR" });

    expect(batch.settled).toEqual([{ reference: "SKU-1", status: "accepted", externalId: "v1|1234|0" }]);
    // The verdict is already in — there is nothing to poll.
    expect(batch.batchId).toBe("");
  });

  test("the publish IS the verdict, so a failure settles that unit and the batch goes on", async () => {
    const two = { ...product() };
    two.variants = [
      two.variants[0]!,
      { rowId: "v2", reference: "SKU-2", fields: { sku: "SKU-2", price: 9.9, quantity: 1 }, attributes: [] },
    ];
    const { fetchImpl } = recorder([
      // SKU-1 fails at the offer, with eBay's own sentence.
      { status: 204 },
      { status: 400, body: { errors: [{ errorId: 25002, message: "Invalid", longMessage: "A user error has occurred. Category 9355 is not valid." }] } },
      // SKU-2 goes all the way through.
      { status: 204 },
      { body: { offerId: "of-2" } },
      { body: { listingId: "v1|9999|0" } },
    ]);
    const batch = await publishListings(
      "ebay",
      { config: CONFIG, settings: SETTINGS, products: [two], connectionKey: "c1" },
      fetchImpl,
    );

    expect(batch.settled).toHaveLength(2);
    expect(batch.settled![0]).toMatchObject({ reference: "SKU-1", status: "rejected" });
    // `longMessage` is the one written for a person — "Invalid" alone tells a
    // seller nothing about which of forty fields it was.
    expect(batch.settled![0]!.errors![0]).toMatch(/Category 9355 is not valid/);
    expect(batch.settled![1]).toMatchObject({ reference: "SKU-2", status: "accepted", externalId: "v1|9999|0" });
  });

  test("a publish that returns no listing id is a failure, not a success", async () => {
    const { fetchImpl } = recorder([{ status: 204 }, { body: { offerId: "of-1" } }, { body: {} }]);
    const batch = await publishListings(
      "ebay",
      { config: CONFIG, settings: SETTINGS, products: [product()], connectionKey: "c1" },
      fetchImpl,
    );
    // Reporting it as accepted would put a green tick on a product nobody can
    // buy.
    expect(batch.settled![0]).toMatchObject({ status: "rejected" });
  });

  test("missing business policies stop the batch, not each unit", async () => {
    const { calls, fetchImpl } = recorder(ok());
    await expect(
      publishListings(
        "ebay",
        { config: CONFIG, settings: { ...SETTINGS, returnPolicyId: "" }, products: [product()], connectionKey: "c1" },
        fetchImpl,
      ),
    ).rejects.toThrow(/business policy/i);
    // They belong to the seller's account, so every unit would fail the same
    // way — reporting it a hundred times helps nobody.
    expect(calls).toHaveLength(0);
  });

  test("nothing is left outstanding, so a poll has nothing to say", async () => {
    expect(await listingFor("ebay")!.poll({} as never)).toEqual([]);
  });
});

describe("confirming a shipment", () => {
  test("the line ids are looked up from the order, because a row has none", async () => {
    const { calls, fetchImpl } = recorder([
      { body: { lineItems: [{ lineItemId: "li-1", quantity: 2 }, { lineItemId: "li-2", quantity: 1 }] } },
      { status: 201, headers: { location: "https://api.ebay.com/sell/fulfillment/v1/order/12-345/shipping_fulfillment/9911" } },
    ]);
    const res = await runIntegrationTask(
      "ebay",
      "ship_order",
      {
        config: CONFIG,
        settings: { orderIdField: "marketplace_order_id", carrierField: "carrier_code", trackingField: "tracking_number" },
        row: { marketplace_order_id: "12-345", carrier_code: "DHL", tracking_number: "JD014" },
        idempotencyKey: "k1",
        connectionKey: "c1",
      },
      fetchImpl,
    );

    expect(calls[0]!.url.pathname).toBe("/sell/fulfillment/v1/order/12-345");
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.body.lineItems).toEqual([
      { lineItemId: "li-1", quantity: 2 },
      { lineItemId: "li-2", quantity: 1 },
    ]);
    expect(calls[1]!.body.trackingNumber).toBe("JD014");
    // The id is only in the Location header; the body is empty on success.
    expect(res.outputs.fulfillmentId).toBe("9911");
    expect(res.outputs.confirmedLines).toBe(2);
  });

  test("an order with no lines is refused rather than confirmed empty", async () => {
    const { fetchImpl } = recorder([{ body: { lineItems: [] } }]);
    await expect(
      runIntegrationTask(
        "ebay",
        "ship_order",
        {
          config: CONFIG,
          settings: { orderIdField: "oid", carrierField: "c", trackingField: "t" },
          row: { oid: "12-345", c: "DHL", t: "JD014" },
          idempotencyKey: "k1",
          connectionKey: "c1",
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/no lines/i);
  });
});
