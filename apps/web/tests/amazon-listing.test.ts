/**
 * Amazon — putting a product ON SALE.
 *
 * The engine's own specs prove the machinery. What is Amazon's, and could not
 * be inferred from any other marketplace here, is all below — and this
 * provider shipped WITHOUT a listing precisely because these were unknown:
 *
 *   - **The attribute shapes are not in the operation reference.** They are in
 *     a JSON Schema fetched from a signed link named by the product type
 *     definition, so this provider is driven by that schema rather than by a
 *     remembered payload. An attribute one entry of which carries no plain
 *     `value` is not offered in the mapping form at all — offering one the
 *     publish could not express would read as configured and change nothing.
 *   - **The taxonomy is flat**: product types, no parent, every one a leaf.
 *   - **A PUT answers on the spot** — the only marketplace here that does —
 *     and `ACCEPTED` still is not a verdict. `INVALID` closes the unit;
 *     everything else is polled, and only `BUYABLE` means it is on sale.
 *   - **There is no batch.** The poll asks "what changed since the publish",
 *     so the batch id is a timestamp and the engine drops references this
 *     batch never sent.
 *   - The price sits at `purchasable_offer[].our_price[].schedule[].value_with_tax`,
 *     verified against Amazon's own sub-attribute reference. A price written
 *     into the wrong field is the failure that looks like success.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  fetchListingAttributes,
  fetchListingCategories,
  INTEGRATION_LISTINGS,
  listingFor,
  pollListingBatch,
  publishListings,
  resetThrottleState,
} from "@backlex/integrations";

const CONFIG = {
  region: "eu",
  marketplaceId: "A1PA6795UKMFR9",
  sellerId: "SELLER1",
  clientId: "cid",
  clientSecret: "csecret",
  refreshToken: "rtoken",
};

const SETTINGS = { currency: "EUR", conditionType: "new_new", languageTag: "de_DE" };

// The engine's bucket is module state, and this provider's operations are
// paced for real. Without this each spec waits out the previous one's tokens.
beforeEach(() => resetThrottleState());

type Call = { url: URL; method: string; headers: Record<string, string>; body?: any };

/** Every call this provider makes starts with an LWA token mint. */
const recorder = (responses: { status?: number; body?: unknown }[] = []) => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body && String(init.body).startsWith("{") ? JSON.parse(String(init.body)) : undefined,
    });
    if (u.hostname === "api.amazon.com") {
      return new Response(JSON.stringify({ access_token: "atoken" }), { status: 200 });
    }
    const next = responses[i++] ?? {};
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  };
  return { calls, fetchImpl };
};

/** A product type schema, cut down to the parts this provider reads. */
const SCHEMA = {
  required: ["item_name", "brand", "power_source"],
  properties: {
    item_name: {
      title: "Title",
      type: "array",
      items: { type: "object", properties: { value: { type: "string" }, marketplace_id: {}, language_tag: {} } },
    },
    brand: { type: "array", items: { type: "object", properties: { value: { type: "string" }, marketplace_id: {} } } },
    product_description: {
      type: "array",
      items: { type: "object", properties: { value: { type: "string" }, marketplace_id: {}, language_tag: {} } },
    },
    bullet_point: {
      type: "array",
      items: { type: "object", properties: { value: { type: "string" }, marketplace_id: {}, language_tag: {} } },
    },
    main_product_image_locator: {
      type: "array",
      items: { type: "object", properties: { value: { type: "string" }, marketplace_id: {} } },
    },
    condition_type: {
      type: "array",
      items: { type: "object", properties: { value: { type: "string" }, marketplace_id: {} } },
    },
    power_source: {
      title: "Power source",
      type: "array",
      maxItems: 1,
      items: {
        type: "object",
        properties: {
          value: { type: "string", enum: ["battery", "corded_electric"], enumNames: ["Battery", "Corded"] },
          marketplace_id: {},
        },
      },
    },
    special_feature: {
      title: "Special feature",
      type: "array",
      maxItems: 5,
      items: { type: "object", properties: { value: { type: "string" }, marketplace_id: {}, language_tag: {} } },
    },
    purchasable_offer: {
      type: "array",
      items: { type: "object", properties: { currency: {}, marketplace_id: {}, our_price: {} } },
    },
    fulfillment_availability: {
      type: "array",
      items: {
        type: "object",
        properties: { fulfillment_channel_code: { enum: ["DEFAULT", "AMAZON_NA"] }, quantity: {} },
      },
    },
    // Nested, with no plain `value` — the shape the mapping form must refuse.
    supplier_declared_dg_hz_regulation: {
      type: "array",
      items: { type: "object", properties: { hazmat: { type: "object" } } },
    },
  },
};

/** The definition response, whose only load-bearing field is the schema link. */
const definition = (link = "https://schema.eu-west-1.amazonaws.com/pt/LUGGAGE.json") => ({
  productType: "LUGGAGE",
  schema: { link: { resource: link, verb: "GET" }, checksum: "x" },
});

const product = (over: Record<string, unknown> = {}) => ({
  rowId: "p1",
  groupId: "p1",
  categoryId: "LUGGAGE",
  fields: {
    title: "Cabin Case",
    description: "A hard-shell cabin case.",
    brand: "Northwind",
    bulletPoints: "Fits the overhead locker\nFour wheels",
    images: "https://cdn.test/a.jpg\nhttps://cdn.test/b.jpg",
    ...over,
  },
  variants: [
    {
      rowId: "v1",
      reference: "SKU-1",
      fields: { sku: "SKU-1", price: 79.9, quantity: 12 },
      attributes: [{ attributeId: "power_source", valueId: "battery" }],
    },
  ],
});

describe("the descriptor", () => {
  test("Amazon lists, and the reference is the SKU it is addressed by", () => {
    expect(listingFor("amazon")).toBeTruthy();
    const l = INTEGRATION_LISTINGS.amazon!;
    // Unique among these marketplaces: the reference is not something Amazon
    // echoes back as a courtesy, it is the resource in the PUT path.
    expect(listingFor("amazon")!.referenceColumn).toBe("sku");
    expect(l.variantColumns?.some((c) => c.value === "sku")).toBe(true);
    // No brand registry: `brand` is a plain string attribute here, unlike
    // Trendyol's quarter-million-row lookup.
    expect(l.lookups ?? []).toEqual([]);
  });
});

describe("the taxonomy", () => {
  test("product types come back flat — no parent, every one a leaf", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          productTypes: [
            { name: "LUGGAGE", displayName: "Luggage", marketplaceIds: ["A1PA6795UKMFR9"] },
            { name: "SHOES", displayName: "Schuhe", marketplaceIds: ["A1PA6795UKMFR9"] },
          ],
          productTypeVersion: "v1",
        },
      },
    ]);
    const cats = await fetchListingCategories("amazon", { config: CONFIG, connectionKey: "c1" }, fetchImpl);

    expect(cats).toEqual([
      { id: "LUGGAGE", name: "Luggage", parentId: null, leaf: true },
      { id: "SHOES", name: "Schuhe", parentId: null, leaf: true },
    ]);
    const list = calls.find((c) => c.url.pathname.endsWith("/productTypes"))!;
    expect(list.url.hostname).toBe("sellingpartnerapi-eu.amazon.com");
    expect(list.url.searchParams.get("marketplaceIds")).toBe("A1PA6795UKMFR9");
    expect(list.headers["x-amz-access-token"]).toBe("atoken");
  });
});

describe("attributes come from the schema behind the link", () => {
  test("the definition names a link, and the schema is fetched from it", async () => {
    const { calls, fetchImpl } = recorder([{ body: definition() }, { body: SCHEMA }]);
    await fetchListingAttributes("amazon", { config: CONFIG, categoryId: "LUGGAGE", connectionKey: "c1" }, fetchImpl);

    const schemaCall = calls.at(-1)!;
    expect(schemaCall.url.href).toBe("https://schema.eu-west-1.amazonaws.com/pt/LUGGAGE.json");
    // The seller's access token has no business travelling to a CDN, and the
    // link is already signed.
    expect(schemaCall.headers["x-amz-access-token"]).toBeUndefined();
  });

  test("a link pointing off Amazon's own hosts is refused", async () => {
    const { fetchImpl } = recorder([{ body: definition("https://evil.test/schema.json") }, { body: SCHEMA }]);
    await expect(
      fetchListingAttributes("amazon", { config: CONFIG, categoryId: "LUGGAGE", connectionKey: "c1" }, fetchImpl),
    ).rejects.toThrow(/evil\.test/);
  });

  test("flags, values and cardinality are read off the schema", async () => {
    const { fetchImpl } = recorder([{ body: definition() }, { body: SCHEMA }]);
    const attrs = await fetchListingAttributes(
      "amazon",
      { config: CONFIG, categoryId: "LUGGAGE", connectionKey: "c1" },
      fetchImpl,
    );
    const byId = Object.fromEntries(attrs.map((a) => [a.id, a]));

    expect(byId.power_source).toMatchObject({
      name: "Power source",
      required: true,
      allowCustom: false,
      multiple: false,
      values: [
        { id: "battery", name: "Battery" },
        { id: "corded_electric", name: "Corded" },
      ],
    });
    // No enum means free text; maxItems above one means the attribute repeats.
    expect(byId.special_feature).toMatchObject({ required: false, allowCustom: true, multiple: true, values: [] });
    // Required first, so the eight that decide acceptance are not buried under
    // two hundred optional ones.
    expect(attrs[0]!.required).toBe(true);
  });

  test("an attribute the publish could not express is not offered at all", async () => {
    const { fetchImpl } = recorder([{ body: definition() }, { body: SCHEMA }]);
    const attrs = await fetchListingAttributes(
      "amazon",
      { config: CONFIG, categoryId: "LUGGAGE", connectionKey: "c1" },
      fetchImpl,
    );
    const ids = attrs.map((a) => a.id);
    // Nested with no plain `value`: an operator who mapped it would see a
    // configured field that changed nothing.
    expect(ids).not.toContain("supplier_declared_dg_hz_regulation");
    // Filled from declared columns, so it is not asked for twice in two places
    // that could disagree.
    expect(ids).not.toContain("item_name");
    expect(ids).not.toContain("purchasable_offer");
  });
});

describe("publishing", () => {
  const publish = (responses: { status?: number; body?: unknown }[]) =>
    recorder([{ body: definition() }, { body: SCHEMA }, ...responses]);

  test("one PUT per unit, addressed by the SKU, with the schema's envelopes", async () => {
    const { calls, fetchImpl } = publish([{ body: { sku: "SKU-1", status: "ACCEPTED", submissionId: "s1" } }]);
    await publishListings(
      "amazon",
      { config: CONFIG, settings: SETTINGS, products: [product()], connectionKey: "c1" },
      fetchImpl,
    );

    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url.pathname).toBe("/listings/2021-08-01/items/SELLER1/SKU-1");
    expect(put.url.searchParams.get("marketplaceIds")).toBe("A1PA6795UKMFR9");
    expect(put.body.productType).toBe("LUGGAGE");
    expect(put.body.requirements).toBe("LISTING");

    const a = put.body.attributes;
    // `language_tag` only where the schema declares it — `brand` does not.
    expect(a.item_name).toEqual([{ value: "Cabin Case", marketplace_id: "A1PA6795UKMFR9", language_tag: "de_DE" }]);
    expect(a.brand).toEqual([{ value: "Northwind", marketplace_id: "A1PA6795UKMFR9" }]);
    // One entry per bullet, not one entry holding both.
    expect(a.bullet_point).toHaveLength(2);
    expect(a.bullet_point[0].value).toBe("Fits the overhead locker");
    expect(a.main_product_image_locator[0].value).toBe("https://cdn.test/a.jpg");
    expect(a.condition_type[0].value).toBe("new_new");
    expect(a.power_source).toEqual([{ value: "battery", marketplace_id: "A1PA6795UKMFR9" }]);
  });

  test("the price goes where Amazon documents it, not beside it", async () => {
    const { calls, fetchImpl } = publish([{ body: { sku: "SKU-1", status: "ACCEPTED", submissionId: "s1" } }]);
    await publishListings(
      "amazon",
      { config: CONFIG, settings: SETTINGS, products: [product()], connectionKey: "c1" },
      fetchImpl,
    );
    const a = calls.find((c) => c.method === "PUT")!.body.attributes;

    expect(a.purchasable_offer).toEqual([
      {
        marketplace_id: "A1PA6795UKMFR9",
        currency: "EUR",
        our_price: [{ schedule: [{ value_with_tax: 79.9 }] }],
      },
    ]);
    // The channel selector is read off the schema rather than assumed.
    expect(a.fulfillment_availability).toEqual([{ fulfillment_channel_code: "DEFAULT", quantity: 12 }]);
  });

  test("a currency that is not ISO 4217 is refused before anything is sent", async () => {
    const { calls, fetchImpl } = publish([]);
    await expect(
      publishListings(
        "amazon",
        { config: CONFIG, settings: { ...SETTINGS, currency: "" }, products: [product()], connectionKey: "c1" },
        fetchImpl,
      ),
    ).rejects.toThrow(/currency/i);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("INVALID closes the unit; nothing about it is polled", async () => {
    const { fetchImpl } = publish([
      {
        body: {
          sku: "SKU-1",
          status: "INVALID",
          submissionId: "s1",
          issues: [
            { code: "4000001", message: "Brand is not registered", severity: "ERROR" },
            { code: "8000", message: "Consider adding a bullet", severity: "WARNING" },
          ],
        },
      },
    ]);
    const batch = await publishListings(
      "amazon",
      { config: CONFIG, settings: SETTINGS, products: [product()], connectionKey: "c1" },
      fetchImpl,
    );

    expect(batch.rejected).toEqual([
      { reference: "SKU-1", status: "rejected", errors: ["Brand is not registered"] },
    ]);
    // Nothing queued, so there is no batch to poll — the same reading n11's
    // REJECT gets.
    expect(batch.batchId).toBe("");
  });

  test("the schema is fetched once per product type, not once per unit", async () => {
    const two = {
      ...product(),
      variants: [
        { rowId: "v1", reference: "SKU-1", fields: { sku: "SKU-1", price: 10, quantity: 1 }, attributes: [] },
        { rowId: "v2", reference: "SKU-2", fields: { sku: "SKU-2", price: 20, quantity: 2 }, attributes: [] },
      ],
    };
    const { calls, fetchImpl } = publish([
      { body: { sku: "SKU-1", status: "ACCEPTED" } },
      { body: { sku: "SKU-2", status: "ACCEPTED" } },
    ]);
    await publishListings(
      "amazon",
      { config: CONFIG, settings: SETTINGS, products: [two], connectionKey: "c1" },
      fetchImpl,
    );

    expect(calls.filter((c) => c.url.pathname.includes("/definitions/"))).toHaveLength(1);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });
});

describe("polling", () => {
  /**
   * `known` is what the batch actually sent. The engine filters on it, which is
   * what makes "ask for everything updated since the publish" a safe way to
   * poll a marketplace that has no batch of its own.
   */
  const poll = (body: unknown, known: string[] = ["SKU-LIVE", "SKU-BAD", "SKU-WAIT"]) => {
    const { calls, fetchImpl } = recorder([{ body }]);
    return {
      calls,
      run: () =>
        pollListingBatch(
          "amazon",
          { config: CONFIG, settings: SETTINGS, batchId: "1786500000000", known, connectionKey: "c1" },
          fetchImpl,
        ),
    };
  };

  test("it asks what changed since the publish, because there is no batch", async () => {
    const { calls, run } = poll({ items: [] });
    await run();
    const search = calls.at(-1)!;
    expect(search.url.pathname).toBe("/listings/2021-08-01/items/SELLER1");
    expect(search.url.searchParams.get("includedData")).toBe("summaries,issues");
    // A second before the publish: Amazon stamps the row itself, and a
    // boundary that excluded the unit just sent reports it pending for ever.
    expect(Date.parse(search.url.searchParams.get("lastUpdatedAfter")!)).toBe(1786499999000);
  });

  test("a verdict for a unit this batch never sent is dropped", async () => {
    // The whole reason the timestamp works as a batch id: the search answers
    // about every listing touched since, including other batches'.
    const { run } = poll(
      { items: [{ sku: "SOMEONE-ELSES", summaries: [{ status: ["BUYABLE"] }], issues: [] }] },
      ["SKU-1"],
    );
    expect(await run()).toEqual([]);
  });

  test("only BUYABLE is accepted; an ERROR is a rejection; the rest stay pending", async () => {
    const { run } = poll({
      items: [
        { sku: "SKU-LIVE", summaries: [{ status: ["BUYABLE", "DISCOVERABLE"] }], issues: [] },
        { sku: "SKU-BAD", summaries: [{ status: [] }], issues: [{ message: "Image too small", severity: "ERROR" }] },
        // Exists, no errors, still not for sale — the case that makes
        // "no issues" the wrong test for success.
        { sku: "SKU-WAIT", summaries: [{ status: ["DISCOVERABLE"] }], issues: [{ message: "hint", severity: "INFO" }] },
      ],
    });

    expect(await run()).toEqual([
      { reference: "SKU-LIVE", status: "accepted", externalId: "SKU-LIVE" },
      { reference: "SKU-BAD", status: "rejected", errors: ["Image too small"] },
      { reference: "SKU-WAIT", status: "pending" },
    ]);
  });
});
