/**
 * Otto — Germany's second marketplace, and the one that shows what Allegro was
 * missing.
 *
 * Both publish their whole contract openly. The difference that decided whether
 * each could LIST is the taxonomy: Allegro hands over one level at a time, Otto
 * hands over category groups with their categories, their attributes AND their
 * variation themes in a single paged walk.
 *
 * What is Otto's alone:
 *
 *   - **Attributes arrive with the category**, so one walk answers the whole
 *     mapping form — no per-attribute call (Hepsiburada) and no schema fetched
 *     from a CDN (Amazon).
 *   - **Two real levels**: a product names a CATEGORY, and the attributes belong
 *     to its GROUP, so a leaf has to resolve back up.
 *   - **`variationThemes` marks the varying attributes** — the second
 *     marketplace here able to answer that, after eBay.
 *   - **Required-ness is not guessed.** `relevance` is a free string whose only
 *     published example is `HIGH`; only the exact word `MANDATORY` marks an
 *     attribute required, and anything else stays optional — the direction that
 *     cannot block a form.
 *   - **No `oauth` block on purpose**: Otto mints a token from a partner
 *     username and password, so a Connect button would lead nowhere.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  fetchListingAttributes,
  fetchListingCategories,
  pollListingBatch,
  providerFor,
  publishListings,
  pullFromSource,
  resetThrottleState,
  runIntegrationTask,
  searchListingLookup,
} from "@backlex/integrations";

const CONFIG = { environment: "production", username: "partner", password: "s3cret" };
const SETTINGS = { currency: "EUR", vat: "FULL" };

beforeEach(() => resetThrottleState());

type Call = { url: URL; method: string; headers: Record<string, string>; body?: any };

/** Every call starts with a token mint against the partner credentials. */
const recorder = (responses: { status?: number; body?: unknown }[] = []) => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body && /^[[{]/.test(String(init.body)) ? JSON.parse(String(init.body)) : init?.body,
    });
    if (u.pathname.endsWith("/v1/token")) {
      return new Response(JSON.stringify({ access_token: "atoken" }), { status: 200 });
    }
    const next = responses[i++] ?? {};
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  };
  return { calls, fetchImpl };
};

const CATEGORIES = {
  categoryGroups: [
    {
      categoryGroup: "Koffer",
      categories: ["Kabinenkoffer", "Reisekoffer"],
      variationThemes: ["Farbe"],
      attributes: [
        {
          name: "Farbe",
          relevance: "MANDATORY",
          multiValue: false,
          allowedValues: ["Schwarz", "Blau"],
        },
        { name: "Material", relevance: "HIGH", multiValue: true, allowedValues: [] },
      ],
    },
  ],
};

const product = () => ({
  rowId: "p1",
  groupId: "grp-1",
  categoryId: "Kabinenkoffer",
  fields: {
    brandId: "brand-77",
    description: "Ein Hartschalenkoffer.",
    bulletPoints: "Passt in die Ablage\nVier Rollen",
    images: "https://cdn.test/a.jpg",
  },
  variants: [
    {
      rowId: "v1",
      reference: "SKU-1",
      fields: { sku: "SKU-1", ean: "4006381333931", price: 79.9, msrp: 99 },
      attributes: [{ attributeId: "Farbe", valueId: "Schwarz" }],
    },
  ],
});

describe("connecting", () => {
  test("there is no OAuth block, because there is nobody to redirect", () => {
    // Otto mints a token from a username and password. Declaring `oauth` would
    // put a Connect button in the dialog that goes nowhere — the same call UPS
    // and Amazon got.
    expect(providerFor("otto")!.oauth).toBeUndefined();
    expect(providerFor("otto")!.capabilities).toEqual(["source", "task", "listing"]);
  });

  test("a refused token does not quote the response that carries the password", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ error: "invalid_grant", password: "s3cret" }), { status: 401 });
    };
    await expect(
      pullFromSource("otto", { config: CONFIG, settings: {}, cursor: null, connectionKey: "c1" }, fetchImpl),
    ).rejects.toThrow(/username and password/i);
    // The one call in this provider whose body holds the partner's password —
    // so the failure names the fields rather than echoing the body.
    await expect(
      pullFromSource("otto", { config: CONFIG, settings: {}, cursor: null, connectionKey: "c1" }, fetchImpl),
    ).rejects.not.toThrow(/s3cret/);
  });
});

describe("the taxonomy", () => {
  test("groups are branches and their categories are the leaves", async () => {
    const { calls, fetchImpl } = recorder([{ body: CATEGORIES }]);
    const cats = await fetchListingCategories("otto", { config: CONFIG, connectionKey: "c1" }, fetchImpl);

    expect(calls[0]!.url.pathname).toEndWith("/v1/token");
    expect(calls[1]!.url.pathname).toBe("/v5/products/categories");
    expect(cats).toEqual([
      { id: "Koffer", name: "Koffer", parentId: null, leaf: false },
      { id: "Kabinenkoffer", name: "Kabinenkoffer", parentId: "Koffer", leaf: true },
      { id: "Reisekoffer", name: "Reisekoffer", parentId: "Koffer", leaf: true },
    ]);
  });

  test("a leaf resolves back to the group that owns its attributes", async () => {
    const { calls, fetchImpl } = recorder([{ body: CATEGORIES }]);
    const attrs = await fetchListingAttributes(
      "otto",
      { config: CONFIG, categoryId: "Kabinenkoffer", connectionKey: "c1" },
      fetchImpl,
    );
    // One walk answered the whole form — no second call per attribute.
    expect(calls.filter((c) => c.url.pathname === "/v5/products/categories")).toHaveLength(1);

    const byId = Object.fromEntries(attrs.map((a) => [a.id, a]));
    expect(byId.Farbe).toMatchObject({
      required: true,
      allowCustom: false,
      // `variationThemes` says so — the second marketplace here that can.
      variant: true,
      multiple: false,
      values: [
        { id: "Schwarz", name: "Schwarz" },
        { id: "Blau", name: "Blau" },
      ],
    });
    // `relevance: "HIGH"` is not "MANDATORY", and the spec enumerates nothing —
    // so it stays optional rather than blocking a form on a guess.
    expect(byId.Material).toMatchObject({ required: false, allowCustom: true, multiple: true, variant: false });
  });

  test("an unknown category is refused rather than answered emptily", async () => {
    const { fetchImpl } = recorder([{ body: CATEGORIES }]);
    await expect(
      fetchListingAttributes("otto", { config: CONFIG, categoryId: "Gartenmöbel", connectionKey: "c1" }, fetchImpl),
    ).rejects.toThrow(/no category/i);
  });
});

describe("the brand registry", () => {
  test("a brand Otto marks unusable is not offered", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          brands: [
            { id: "b1", name: "Northwind", usable: true },
            { id: "b2", name: "Retired Co", usable: false },
          ],
        },
      },
    ]);
    const res = await searchListingLookup(
      "otto",
      { config: CONFIG, lookup: "brands", query: "north", cursor: null, connectionKey: "c1" },
      fetchImpl,
    );
    expect(calls[1]!.url.searchParams.get("brandName")).toBe("north");
    // Offering it would be offering a choice that fails at publish time.
    expect(res.items).toEqual([{ id: "b1", name: "Northwind" }]);
  });
});

describe("publishing", () => {
  test("variants of one product carry the same productReference", async () => {
    const two = product();
    two.variants = [
      two.variants[0]!,
      { rowId: "v2", reference: "SKU-2", fields: { sku: "SKU-2", ean: "4006381333948", price: 89.9 }, attributes: [] },
    ];
    const { calls, fetchImpl } = recorder([{ status: 202, body: { state: "IN_PROGRESS", total: 2 } }]);
    const batch = await publishListings(
      "otto",
      { config: CONFIG, settings: SETTINGS, products: [two], connectionKey: "c1" },
      fetchImpl,
    );

    const post = calls.find((c) => c.method === "POST" && c.url.pathname === "/v5/products")!;
    // Otto requires the caller to stamp the request so two updates of one SKU
    // arriving together can be ordered.
    expect(post.headers["X-Request-Timestamp"]).toBeTruthy();
    expect(post.body).toHaveLength(2);
    // The same job Trendyol's and n11's `productMainId` does.
    expect(post.body[0].productReference).toBe("grp-1");
    expect(post.body[1].productReference).toBe("grp-1");
    expect(post.body[0].productDescription).toMatchObject({ category: "Kabinenkoffer", brandId: "brand-77" });
    expect(post.body[0].productDescription.attributes).toEqual([{ name: "Farbe", values: ["Schwarz"] }]);
    expect(post.body[0].pricing.standardPrice).toEqual({ amount: 79.9, currency: "EUR" });
    expect(post.body[0].mediaAssets).toEqual([{ type: "IMAGE", location: "https://cdn.test/a.jpg" }]);
    // 202 with a progress document, not a ticket — so the batch id is the
    // moment it was sent and the status feed is asked what changed since.
    expect(batch.batchId).toMatch(/^\d+$/);
    expect(batch.settled ?? []).toEqual([]);
  });

  test("a unit missing one of the three required identifiers is refused here", async () => {
    const p = product();
    p.variants = [{ rowId: "v1", reference: "SKU-1", fields: { sku: "SKU-1", price: 10 }, attributes: [] }];
    const { calls, fetchImpl } = recorder([]);
    const batch = await publishListings(
      "otto",
      { config: CONFIG, settings: SETTINGS, products: [p], connectionKey: "c1" },
      fetchImpl,
    );
    // Otto would reject the batch wholesale, which tells an operator nothing
    // about which row was at fault.
    expect(batch.settled).toEqual([{ reference: "SKU-1", status: "rejected", errors: ["no EAN"] }]);
    expect(batch.batchId).toBe("");
    expect(calls.some((c) => c.url.pathname === "/v5/products")).toBe(false);
  });
});

describe("polling", () => {
  const poll = (body: unknown, known = ["SKU-1", "SKU-2", "SKU-3"]) => {
    const { calls, fetchImpl } = recorder([{ body }]);
    return {
      calls,
      run: () =>
        pollListingBatch(
          "otto",
          { config: CONFIG, settings: SETTINGS, batchId: "1786500000000", known, connectionKey: "c1" },
          fetchImpl,
        ),
    };
  };

  test("ONLINE is the only acceptance; an error closes the other way", async () => {
    const { calls, run } = poll({
      marketPlaceStatus: [
        { sku: "SKU-1", moin: "MOIN-1", status: "ONLINE", errors: [] },
        { sku: "SKU-2", status: "ERROR", errors: [{ message: "Bild zu klein" }] },
        { sku: "SKU-3", status: "IN_PROGRESS", errors: [] },
      ],
    });
    const out = await run();

    expect(Date.parse(calls[1]!.url.searchParams.get("fromDate")!)).toBe(1786499999000);
    expect(out).toEqual([
      // The MOIN only exists once the article does.
      { reference: "SKU-1", status: "accepted", externalId: "MOIN-1" },
      { reference: "SKU-2", status: "rejected", errors: ["Bild zu klein"] },
      { reference: "SKU-3", status: "pending" },
    ]);
  });
});

describe("reporting a shipment", () => {
  test("it reports POSITIONS, and the row already names them", async () => {
    const { calls, fetchImpl } = recorder([{ status: 201, body: {} }]);
    const res = await runIntegrationTask(
      "otto",
      "ship_positions",
      {
        config: CONFIG,
        settings: {
          carrierField: "carrier_code",
          trackingField: "tracking_number",
          positionIdsField: "position_ids",
          fromCountry: "DE",
          fromPostCode: "20095",
          fromCity: "Hamburg",
        },
        row: { carrier_code: "DHL", tracking_number: "JD014", position_ids: "pos-1,pos-2" },
        idempotencyKey: "k1",
        connectionKey: "c1",
      },
      fetchImpl,
    );

    const post = calls.find((c) => c.url.pathname === "/v1/shipments")!;
    expect(post.body.trackingKey).toEqual({ carrier: "DHL", trackingNumber: "JD014" });
    // Unlike eBay's, the ids are not looked up — the sync wrote them onto the
    // row when it brought the order in.
    expect(post.body.positionItems).toEqual([{ positionItemId: "pos-1" }, { positionItemId: "pos-2" }]);
    expect(post.body.shipFromAddress.city).toBe("Hamburg");
    expect(res.outputs.shippedPositions).toBe(2);
  });

  test("a row naming no positions is refused rather than reported empty", async () => {
    const { fetchImpl } = recorder([]);
    await expect(
      runIntegrationTask(
        "otto",
        "ship_positions",
        {
          config: CONFIG,
          settings: { carrierField: "c", trackingField: "t", positionIdsField: "p" },
          row: { c: "DHL", t: "JD014", p: "" },
          idempotencyKey: "k1",
          connectionKey: "c1",
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/no Otto position ids/i);
  });
});

describe("orders", () => {
  test("the window bounds last-modified and the opaque cursor travels with it", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          resources: [
            {
              salesOrderId: "so-1",
              orderNumber: "on-1",
              orderDate: "2026-08-13T08:00:00.000Z",
              deliveryAddress: { firstName: "Anna", lastName: "Muster", city: "Hamburg", zipCode: "20095", countryCode: "DE" },
              positionItems: [
                {
                  positionItemId: "pos-1",
                  fulfillmentStatus: "PROCESSABLE",
                  product: { sku: "SKU-1", ean: "4006381333931", title: "Kabinenkoffer" },
                  itemValueGrossPrice: { amount: 79.9, currency: "EUR" },
                },
              ],
            },
          ],
          links: [{ rel: "next", href: "https://api.otto.market/v4/orders?nextcursor=abc123" }],
        },
      },
    ]);
    const page = await pullFromSource(
      "otto",
      { config: CONFIG, settings: { lookbackDays: "7" }, cursor: null, connectionKey: "c1" },
      fetchImpl,
    );

    expect(calls[1]!.url.searchParams.get("fromDate")).toBeTruthy();
    expect(page.records[0]!.data.zipCode).toBe("20095");
    expect(page.records[0]!.children!.lines[0]!.data.sku).toBe("SKU-1");
    expect(page.complete).toBe(false);
    // `<since>|<opaque cursor>` — Otto pages by a token, not an offset, so the
    // window has to be carried beside it.
    expect(page.cursor).toMatch(/^\d+\|abc123$/);
    expect(page.resumeAt).toBeUndefined();
  });
});
