/**
 * n11 — putting a product ON SALE.
 *
 * The engine's own specs already prove the machinery, and `n11-provider`-shaped
 * concerns (the 15-day window, `orderByField`) belong to the source. What is
 * left to prove is the part that is n11's and cannot be inferred from the
 * descriptor — and every item below was settled from n11's own seller
 * documentation after three open-source integrators disagreed about it:
 *
 *   - **There is no brand field.** n11 sends the brand as attribute id 1
 *     ("Marka"), which is why this provider declares no `lookups` at all. One
 *     integrator sends `brandId`, another sends nothing; both are wrong.
 *   - **A verdict echoes `itemCode`, and `itemCode` holds the STOCK CODE** —
 *     not the barcode, which is optional here and routinely null. Get this
 *     wrong and every unit reads "pending" for ever.
 *   - The verdict envelope is `skus.content[]`, not `skus.items[]`.
 *   - `REJECT` on the create is an ANSWER, not a ticket: nothing was queued, so
 *     nothing may be polled.
 *   - The task's status and each SKU's status are two different things at two
 *     different levels.
 */
import { describe, expect, test } from "bun:test";
import {
  fetchListingAttributes,
  fetchListingCategories,
  INTEGRATION_LISTINGS,
  listingFor,
  pollListingBatch,
  publishListings,
} from "@backlex/integrations";

const CONFIG = { appKey: "key", appSecret: "secret" };

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

/** The settings every publish needs; n11 refuses a task without them. */
const SETTINGS = {
  shipmentTemplate: "Standart",
  preparingDay: "3",
  vatRate: "20",
  currencyType: "TL",
};

const publish = (products: any[], opts: { fetchImpl: any; settings?: Record<string, unknown> }) =>
  publishListings(
    "n11",
    { config: CONFIG, settings: { ...SETTINGS, ...(opts.settings ?? {}) }, products },
    opts.fetchImpl,
  );

/** One product with one sellable unit — what a workspace with no variant
 *  collection produces, and what every test here varies from. */
const PRODUCT = (over: { product?: any; variant?: any; attributes?: any[] } = {}) => ({
  rowId: "p1",
  groupId: "p1",
  categoryId: "1209218",
  fields: {
    title: "Bisiklet Yaka Çiçek Desenli Elbise",
    description: "<p>Pamuklu</p>",
    images: "https://cdn.example/a.jpg",
    ...(over.product ?? {}),
  },
  variants: [
    {
      rowId: "v1",
      reference: "AB-1-S",
      fields: {
        stockCode: "AB-1-S",
        quantity: 5,
        listPrice: 2200,
        salePrice: 2000,
        ...(over.variant ?? {}),
      },
      // Brand is an ATTRIBUTE at n11 — id 1, sent as a custom value.
      attributes: over.attributes ?? [
        { attributeId: "1", custom: "Mağaza7" },
        { attributeId: "429", valueId: "6397019" },
      ],
    },
  ],
});

describe("the shape n11 declares", () => {
  test("declares no lookups, because the brand is an attribute", () => {
    // The single most load-bearing fact about n11's listing: there is no brand
    // field on the SKU at all. A `lookups` entry here would put a brand search
    // in front of an operator that answers nothing they can send.
    expect(INTEGRATION_LISTINGS.n11!.lookups).toEqual([]);
  });

  test("the reference column is the stock code, and it is a declared variant column", () => {
    // `referenceColumn` is not part of the catalog the admin reads — it is an
    // engine-side fact — so this reads the provider itself.
    const block = listingFor("n11")!;
    expect(block.referenceColumn).toBe("stockCode");
    expect(block.variantColumns!.map((c) => c.value)).toContain("stockCode");
  });
});

describe("reading the listing taxonomy", () => {
  test("the tree arrives nested and leaves flat, with `null` children meaning leaf", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: [
          {
            id: 1000,
            name: "Giyim",
            subCategories: [
              { id: 1001, name: "Elbise", subCategories: null },
              { id: 1002, name: "Etek", subCategories: [] },
            ],
          },
        ],
      },
    ]);

    const out = await fetchListingCategories("n11", { config: CONFIG }, fetchImpl);

    expect(calls[0]!.url.pathname).toBe("/cdn/categories");
    // n11 needs the credential here, unlike Trendyol's public tree.
    expect(calls[0]!.headers.appkey).toBe("key");
    expect(out).toEqual([
      { id: "1000", name: "Giyim", parentId: null, leaf: false },
      // Both spellings of "childless" become the same `leaf: true`, which is
      // the whole reason the flattening lives in the provider.
      { id: "1002", name: "Etek", parentId: "1000", leaf: true },
      { id: "1001", name: "Elbise", parentId: "1000", leaf: true },
    ]);
  });

  test("attribute flags are normalised, and a slicer counts as a variant", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          id: 1002571,
          categoryAttributes: [
            {
              attributeId: 1,
              attributeName: "Marka",
              isMandatory: true,
              isVariant: false,
              isSlicer: false,
              isCustomValue: true,
              attributeValues: [{ id: 8372688, value: "Abay" }],
            },
            {
              attributeId: 429,
              attributeName: "Renk",
              isMandatory: true,
              // n11 documents BOTH of these as wanting a shared productMainId,
              // so either one means "this tells two units apart".
              isVariant: false,
              isSlicer: true,
              isCustomValue: false,
              attributeValues: [],
            },
          ],
        },
      },
    ]);

    const out = await fetchListingAttributes("n11", { config: CONFIG, categoryId: "1002571" }, fetchImpl);

    expect(calls[0]!.url.pathname).toBe("/cdn/category/1002571/attribute");
    expect(out[0]).toEqual({
      id: "1",
      name: "Marka",
      required: true,
      allowCustom: true,
      variant: false,
      multiple: false,
      // n11 spells the label `value` where Trendyol spells it `name`.
      values: [{ id: "8372688", name: "Abay" }],
    });
    expect(out[1]!.variant).toBe(true);
  });

  test("a category id that is not a number never reaches a URL", async () => {
    const { calls, fetchImpl } = recorder();
    await expect(
      fetchListingAttributes("n11", { config: CONFIG, categoryId: "12/../categories" }, fetchImpl),
    ).rejects.toThrow(/numeric/);
    expect(calls).toHaveLength(0);
  });
});

describe("publishing a listing", () => {
  test("sends the SKU n11 documents, with the brand travelling as an attribute", async () => {
    const { calls, fetchImpl } = recorder([{ body: { id: 1092, type: "PRODUCT_CREATE", status: "IN_QUEUE" } }]);

    const out = await publish([PRODUCT()], { fetchImpl });

    expect(calls[0]!.url.pathname).toBe("/ms/product/tasks/product-create");
    const sku = calls[0]!.body.payload.skus[0];
    expect(calls[0]!.body.payload.integrator).toBe("backlex");
    expect(sku.stockCode).toBe("AB-1-S");
    expect(sku.categoryId).toBe(1209218);
    // Derived from the product row's key — what makes several stock codes one
    // product page, and what makes a re-run land on the same page.
    expect(sku.productMainId).toBe("p1");
    expect(sku.shipmentTemplate).toBe("Standart");
    expect(sku.vatRate).toBe(20);
    expect(sku.images).toEqual([{ url: "https://cdn.example/a.jpg", order: 0 }]);
    // No `brandId` anywhere — the brand is attribute 1, and n11's own examples
    // carry BOTH keys with nulls for the half that does not apply.
    expect(sku.brandId).toBeUndefined();
    expect(sku.attributes).toEqual([
      { id: 1, valueId: null, customValue: "Mağaza7" },
      { id: 429, valueId: 6397019, customValue: null },
    ]);
    expect(out.batchId).toBe("1092");
  });

  test("a unit with no stock code is refused here, not by n11", async () => {
    // n11 REJECTs a whole task for a bad data set and explains itself once for
    // the batch, so one bad row would take its healthy siblings down with it.
    const { calls, fetchImpl } = recorder([{ body: { id: 7, status: "IN_QUEUE" } }]);
    const product = PRODUCT({ variant: { stockCode: "" } });

    const out = await publish([product], { fetchImpl });

    expect(calls).toHaveLength(0);
    expect(out.batchId).toBe("");
    expect(out.settled![0]!.errors![0]).toMatch(/stock code/i);
  });

  test("a list price below the sale price is refused before the task is sent", async () => {
    const { calls, fetchImpl } = recorder();
    const product = PRODUCT({ variant: { listPrice: 100, salePrice: 200 } });

    const out = await publish([product], { fetchImpl });

    expect(calls).toHaveLength(0);
    expect(out.settled![0]!.errors![0]).toMatch(/list price/i);
  });

  test("an http image is dropped, and a product left with none is refused", async () => {
    // n11 requires https and drops an http URL silently at their end, which
    // reads as a product that listed without pictures.
    const { calls, fetchImpl } = recorder();
    const product = PRODUCT({ product: { images: "http://cdn.example/a.jpg" } });

    const out = await publish([product], { fetchImpl });

    expect(calls).toHaveLength(0);
    expect(out.settled![0]!.errors![0]).toMatch(/https/i);
  });

  test("REJECT is an answer, not a ticket — nothing is left to poll", async () => {
    const { fetchImpl } = recorder([
      { body: { id: 1092, type: "PRODUCT_CREATE", status: "REJECT", reasons: ["Kategori bulunamadı"] } },
    ]);

    const out = await publish([PRODUCT()], { fetchImpl });

    // A batch id here would leave the engine asking n11 for ever about a task
    // it refused to run.
    expect(out.batchId).toBe("");
    expect(out.settled).toEqual([
      { reference: "AB-1-S", status: "rejected", errors: ["Kategori bulunamadı"] },
    ]);
  });

  test("a 200 with no task id is an error, not a silent success", async () => {
    const { fetchImpl } = recorder([{ body: { status: "IN_QUEUE" } }]);
    // Treating it as success would strand every unit at `pending` for ever.
    await expect(publish([PRODUCT()], { fetchImpl })).rejects.toThrow(/no task id/i);
  });

  test("a missing shipment template is refused before anything is sent", async () => {
    const { calls, fetchImpl } = recorder();
    await expect(
      publish([PRODUCT()], { fetchImpl, settings: { shipmentTemplate: "" } }),
    ).rejects.toThrow(/shipment template/i);
    expect(calls).toHaveLength(0);
  });
});

describe("reading a listing's verdict", () => {
  /** `known` is the batch's own references; the engine drops a verdict for
   *  anything else, so a provider that reports a whole queue is safe. */
  const poll = (body: unknown, known: string[] = ["AB-1-S", "AB-1-M"]) =>
    pollListingBatch(
      "n11",
      { config: CONFIG, settings: SETTINGS, batchId: "1095", known },
      recorder([{ body }]).fetchImpl,
    );

  test("matches on itemCode, which holds the stock code", async () => {
    const out = await poll({
      taskId: 1095,
      status: "PROCESSED",
      skus: {
        content: [
          { itemCode: "AB-1-S", status: "SUCCESS", reasons: ["Başarıyla tamamlandı."] },
          { itemCode: "AB-1-M", status: "Fail", reasons: ["Zorunlu özellik eksik"] },
        ],
      },
    });

    expect(out).toEqual([
      // n11 mints no separate product id — the stock code IS the listing's id.
      { reference: "AB-1-S", status: "accepted", externalId: "AB-1-S" },
      { reference: "AB-1-M", status: "rejected", errors: ["Zorunlu özellik eksik"] },
    ]);
  });

  test("a task still in the queue leaves its units pending", async () => {
    const out = await poll({
      taskId: 1095,
      status: "IN_QUEUE",
      skus: { content: [{ itemCode: "AB-1-S", status: null }] },
    });

    expect(out).toEqual([{ reference: "AB-1-S", status: "pending" }]);
  });

  test("a finished task with no verdict on a unit closes it rather than polling for ever", async () => {
    const out = await poll({
      taskId: 1095,
      status: "PROCESSED",
      skus: { content: [{ itemCode: "AB-1-S", status: null }] },
    });

    expect(out[0]!.status).toBe("rejected");
  });

  test("a reason carried inside `sku` is read too", async () => {
    // `reasons` appears both on the row and inside `sku`, and which one is
    // filled varies — a reader that took only one would drop the explanation.
    const out = await poll({
      taskId: 1095,
      status: "PROCESSED",
      skus: { content: [{ itemCode: "AB-1-S", status: "Fail", sku: { reasons: ["Fiyat hatalı"] } }] },
    });

    expect(out[0]!.errors).toEqual(["Fiyat hatalı"]);
  });

  test("a task id that is not a number never reaches a request", async () => {
    const { calls, fetchImpl } = recorder();
    await expect(
      pollListingBatch("n11", { config: CONFIG, settings: SETTINGS, batchId: "abc", known: [] }, fetchImpl),
    ).rejects.toThrow(/task id/i);
    expect(calls).toHaveLength(0);
  });
});
