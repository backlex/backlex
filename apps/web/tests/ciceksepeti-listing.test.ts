/**
 * Çiçeksepeti — putting a product ON SALE.
 *
 * What is Çiçeksepeti's about this, and cannot be inferred from the descriptor:
 *
 *   - **Its documentation contradicts itself about the price and stock field
 *     names.** The parameter table says `StockQuantity` / `TotalPrice` /
 *     `FirstPrice`; its own request example sends `stockQuantity` /
 *     `salesPrice` / `listPrice`. The example wins, and not as a guess: the
 *     batch-status endpoint echoes the STORED record back under the example's
 *     names, so those are what the service keeps.
 *   - **`Warning` is a SUCCESS**, not a failure — "İşlem başarılı ancak
 *     gönderilen istek kontrol edilmeli". Reporting a live listing as refused
 *     is the expensive direction.
 *   - **A "Kişiselleştirilebilir Özellik" is dropped**, because it asks the
 *     BUYER for text at checkout and is refused on an ordinary product.
 *   - The tree carries `parentCategoryId` AND nests under `subCategories`.
 *   - Images are plain URL STRINGS here, where n11 wants `{url, order}` and
 *     Trendyol wants `{url}`.
 */
import { describe, expect, test } from "bun:test";
import {
  fetchListingAttributes,
  fetchListingCategories,
  listingFor,
  pollListingBatch,
  publishListings,
  resetThrottleState,
} from "@backlex/integrations";

const CONFIG = { apiKey: "key", sellerId: "9900", environment: "sandbox" };
const BASE = "https://sandbox-apis.ciceksepeti.com/api/v1";

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

const publish = (products: any[], opts: { fetchImpl: any; settings?: Record<string, unknown> }) => {
  // The create is paced at one request per five seconds and takes its token
  // from the engine's real bucket, so a suite that left it empty would sit out
  // five seconds per test for real.
  resetThrottleState();
  return publishListings(
    "ciceksepeti",
    {
      config: CONFIG,
      settings: { deliveryType: "2", deliveryMessageType: "5", ...(opts.settings ?? {}) },
      products,
    },
    opts.fetchImpl,
  );
};

const LONG = "Bu bir test ürünüdür ve açıklaması yeterince uzundur.";

const PRODUCT = (over: { product?: any; variant?: any; attributes?: any[] } = {}) => ({
  rowId: "p1",
  groupId: "p1",
  categoryId: "13349",
  fields: {
    productName: "Deneme test ürünü",
    description: LONG,
    images: "https://cdn.example/a.jpg",
    ...(over.product ?? {}),
  },
  variants: [
    {
      rowId: "v1",
      reference: "CSY-1",
      fields: {
        stockCode: "CSY-1",
        stockQuantity: 5,
        salesPrice: 10.4,
        listPrice: 15.4,
        ...(over.variant ?? {}),
      },
      attributes: over.attributes ?? [{ attributeId: "147", valueId: "2010420" }],
    },
  ],
});

describe("reading the listing taxonomy", () => {
  test("the tree flattens, trusting parentCategoryId over the nesting", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          categories: [
            {
              id: 1,
              name: "Çiçek",
              parentCategoryId: null,
              subCategories: [{ id: 2, name: "Gül", parentCategoryId: 1, subCategories: [] }],
            },
          ],
        },
      },
    ]);

    const out = await fetchListingCategories("ciceksepeti", { config: CONFIG }, fetchImpl);

    expect(calls[0]!.url.toString()).toBe(`${BASE}/Categories`);
    expect(calls[0]!.headers["x-api-key"]).toBe("key");
    expect(out).toEqual([
      { id: "1", name: "Çiçek", parentId: null, leaf: false },
      { id: "2", name: "Gül", parentId: "1", leaf: true },
    ]);
  });

  test("a personalisable attribute is dropped, and a variant one is flagged", async () => {
    const { fetchImpl } = recorder([
      {
        body: {
          categoryAttributes: [
            {
              attributeId: 147,
              attributeName: "Renk",
              required: true,
              varianter: true,
              type: "Variant Özelliği",
              attributeValues: [{ id: 2010420, name: "Beyaz" }],
            },
            {
              attributeId: 2001498,
              attributeName: "Kart Notu",
              required: false,
              varianter: false,
              // Asks the BUYER for text at checkout — not something a seller
              // answers, and refused on an ordinary product.
              type: "Kişiselleştirilebilir Özellik",
              attributeValues: [],
            },
            {
              attributeId: 2000353,
              attributeName: "Materyal",
              required: false,
              varianter: false,
              type: "Ürün Özelliği",
              attributeValues: [{ id: 2010800, name: "Cam" }],
            },
          ],
        },
      },
    ]);

    const out = await fetchListingAttributes(
      "ciceksepeti",
      { config: CONFIG, categoryId: "13349" },
      fetchImpl,
    );

    expect(out.map((a) => a.id)).toEqual(["147", "2000353"]);
    expect(out[0]).toEqual({
      id: "147",
      name: "Renk",
      required: true,
      variant: true,
      // Every value comes from the category's own closed list here.
      allowCustom: false,
      multiple: false,
      values: [{ id: "2010420", name: "Beyaz" }],
    });
  });

  test("a category id that is not a number never reaches a URL", async () => {
    const { calls, fetchImpl } = recorder();
    await expect(
      fetchListingAttributes("ciceksepeti", { config: CONFIG, categoryId: "1/../Products" }, fetchImpl),
    ).rejects.toThrow(/numeric/);
    expect(calls).toHaveLength(0);
  });
});

describe("publishing a listing", () => {
  test("sends the field names the service actually stores, not the parameter table's", async () => {
    const { calls, fetchImpl } = recorder([{ body: { batchId: "b45e35a9-c1fe-4353-8900-fd9499eaf325" } }]);

    const out = await publish([PRODUCT()], { fetchImpl });

    expect(calls[0]!.url.toString()).toBe(`${BASE}/Products`);
    const p = calls[0]!.body.products[0];
    // The example's vocabulary, which the batch-status echo confirms — NOT the
    // table's StockQuantity / TotalPrice / FirstPrice.
    expect(p.stockQuantity).toBe(5);
    expect(p.salesPrice).toBe(10.4);
    expect(p.listPrice).toBe(15.4);
    expect(p.TotalPrice).toBeUndefined();
    expect(p.FirstPrice).toBeUndefined();
    // The product's own code groups its variants; the variant code is per-unit.
    expect(p.mainProductCode).toBe("p1");
    expect(p.stockCode).toBe("CSY-1");
    expect(p.categoryId).toBe(13349);
    // Plain strings here, unlike n11's {url, order} and Trendyol's {url}.
    expect(p.images).toEqual(["https://cdn.example/a.jpg"]);
    expect(p.attributes).toEqual([{ id: 147, valueId: 2010420, textLength: 0 }]);
    expect(out.batchId).toBe("b45e35a9-c1fe-4353-8900-fd9499eaf325");
  });

  test("an unmapped struck-through price is omitted rather than sent empty", async () => {
    const { calls, fetchImpl } = recorder([{ body: { batchId: "b1" } }]);

    await publish([PRODUCT({ variant: { listPrice: null } })], { fetchImpl });

    // Çiçeksepeti reads it as a legal claim about the last 30 days, so an empty
    // one is a claim not to make.
    expect("listPrice" in calls[0]!.body.products[0]).toBe(false);
  });

  test("a description whose length is only markup is refused", async () => {
    const { calls, fetchImpl } = recorder();
    // 30 characters of tags and four of text — long enough to pass a naive
    // length check and refused by Çiçeksepeti hours later.
    const product = PRODUCT({ product: { description: "<p><strong><em>kısa</em></strong></p>" } });

    const out = await publish([product], { fetchImpl });

    expect(calls).toHaveLength(0);
    expect(out.rejected![0]!.errors![0]).toMatch(/at least 30/);
  });

  test("a unit with no variant code is refused here, not by Çiçeksepeti", async () => {
    const { calls, fetchImpl } = recorder();
    const out = await publish([PRODUCT({ variant: { stockCode: "" } })], { fetchImpl });

    expect(calls).toHaveLength(0);
    expect(out.batchId).toBe("");
    expect(out.rejected![0]!.errors![0]).toMatch(/variant code/i);
  });

  test("a free-text answer to a closed-set attribute is refused with a reason", async () => {
    const { calls, fetchImpl } = recorder();
    const product = PRODUCT({ attributes: [{ attributeId: "147", custom: "Beyazımsı" }] });

    const out = await publish([product], { fetchImpl });

    expect(calls).toHaveLength(0);
    expect(out.rejected![0]!.errors![0]).toMatch(/own values/i);
  });

  test("a 200 with no batchId is an error, not a silent success", async () => {
    const { fetchImpl } = recorder([{ body: {} }]);
    await expect(publish([PRODUCT()], { fetchImpl })).rejects.toThrow(/no batchId/i);
  });
});

describe("reading a listing's verdict", () => {
  const poll = (body: unknown, known: string[] = ["CSY-1"]) =>
    pollListingBatch(
      "ciceksepeti",
      { config: CONFIG, settings: {}, batchId: "b45e35a9-c1fe-4353-8900-fd9499eaf325", known },
      recorder([{ body }]).fetchImpl,
    );

  test("matches on the stockCode inside `data`", async () => {
    const out = await poll({
      items: [{ data: { stockCode: "CSY-1", salesPrice: 51.99 }, status: "Success" }],
    });

    expect(out).toEqual([{ reference: "CSY-1", status: "accepted", externalId: "CSY-1" }]);
  });

  test("Warning is accepted, because the product listed", async () => {
    // "İşlem başarılı ancak gönderilen istek kontrol edilmeli" — usually about
    // pricing law. Reporting a live listing as refused is the expensive way to
    // be wrong.
    const out = await poll({
      items: [{ data: { stockCode: "CSY-1" }, status: "Warning" }],
    });

    expect(out[0]!.status).toBe("accepted");
  });

  test("Failed carries the message Çiçeksepeti gave", async () => {
    const out = await poll({
      items: [
        {
          data: { stockCode: "CSY-1" },
          status: "Failed",
          failureReasons: [{ message: "Girmiş olduğunuz kod bulunmamaktadır", code: 4000 }],
        },
      ],
    });

    expect(out[0]).toEqual({
      reference: "CSY-1",
      status: "rejected",
      errors: ["Girmiş olduğunuz kod bulunmamaktadır"],
    });
  });

  test("Pending and Processing both leave the unit open", async () => {
    // Creation takes up to 24 hours, so this is the normal answer for most of a
    // batch's life.
    for (const status of ["Pending", "Processing"]) {
      const out = await poll({ items: [{ data: { stockCode: "CSY-1" }, status }] });
      expect(out[0]!.status).toBe("pending");
    }
  });

  test("a batch id that is not a batch id never reaches a URL", async () => {
    const { calls, fetchImpl } = recorder();
    await expect(
      pollListingBatch(
        "ciceksepeti",
        { config: CONFIG, settings: {}, batchId: "../../Orders", known: [] },
        fetchImpl,
      ),
    ).rejects.toThrow(/batch id/i);
    expect(calls).toHaveLength(0);
  });
});

describe("the shape Çiçeksepeti declares", () => {
  test("the reference column is the variant code and is a declared variant column", () => {
    const block = listingFor("ciceksepeti")!;
    expect(block.referenceColumn).toBe("stockCode");
    expect(block.variantColumns!.map((c) => c.value)).toContain("stockCode");
  });
});
