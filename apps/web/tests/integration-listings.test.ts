/**
 * The listing runner — publishing products and landing the verdict.
 *
 * The provider specs already prove what Trendyol's wire looks like. What is
 * left, and what this file is for, is the part between a collection and that
 * wire: which rows become units, where a unit's reference comes from, and above
 * all where an answer that arrives an hour later is written.
 *
 * The failure this suite exists to catch is the quiet one. A publish that finds
 * no mapping, a unit with no reference, a verdict echoed for something we never
 * sent — none of those throw, and all three would leave an operator looking at
 * a run that says it did nothing and a marketplace that says it did something.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resetThrottleState } from "@backlex/integrations";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  pollListingBatchRow,
  runListingSync,
  upsertListingMap,
} from "../src/server/services/integration-listings";

const BASE = "/api/admin/integrations";
const realFetch = globalThis.fetch;

let h: TestHarness;
let client: Database;
/** The workspace the harness signed the admin into — the routes scope by the
 *  session's tenant, so a service call must scope itself the same way. */
let tenantId: string;
let ctx: any;
let trendyolId: string;
let productsTable: string;
let variantsTable: string;

/** What the stubbed Trendyol answers, in order, and what it was asked. */
let calls: { url: string; method: string; body: any }[] = [];
let responses: { status?: number; body?: unknown }[] = [];

const stubTrendyol = () => {
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("trendyol.com/")) {
      calls.push({
        url: u,
        method: String(init?.method ?? "GET"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const next = responses.shift() ?? {};
      return new Response(JSON.stringify(next.body ?? {}), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(url, init);
  }) as typeof fetch;
};

const req = (method: string, path: string, body?: unknown) =>
  h.fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

const ok = async (method: string, path: string, body?: unknown) => {
  const res = await req(method, path, body);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as any;
};

const rows = (table: string) =>
  client.query(`select * from "${table}" order by id`).all() as Record<string, unknown>[];

const batchRows = () =>
  client.query("select * from integration_listing_batches").all() as Record<string, unknown>[];

/** A listing sync over `products`, with `product_variants` as the units. */
const makeSync = async (over: Record<string, unknown> = {}) =>
  (
    await ok("POST", `${BASE}/syncs`, {
      integrationId: trendyolId,
      collection: "products",
      direction: "listing",
      settings: { vatRate: "20" },
      categoryField: "category",
      mapping: { title: "title", body: "description", ty_brand_id: "brandId", photo: "images" },
      outputsMapping: {
        listingId: "marketplace_listing_id",
        listingStatus: "listing_status",
        listingError: "listing_error",
      },
      childMappings: {
        variants: {
          collection: "product_variants",
          parentField: "product",
          mapping: {
            barcode: "barcode",
            sku: "stockCode",
            stock: "quantity",
            price: "salePrice",
            list_price: "listPrice",
          },
        },
      },
      ...over,
    })
  ).data;

beforeAll(async () => {
  stubTrendyol();
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);

  await ok("POST", "/api/collections", {
    slug: "products",
    fields: [
      { name: "title", type: "text" },
      { name: "body", type: "text" },
      { name: "category", type: "text" },
      { name: "ty_brand_id", type: "number" },
      { name: "photo", type: "text" },
      { name: "colour", type: "text" },
    ],
  });
  await ok("POST", "/api/collections", {
    slug: "product_variants",
    fields: [
      { name: "product", type: "text" },
      { name: "barcode", type: "text" },
      { name: "sku", type: "text" },
      { name: "stock", type: "number" },
      { name: "price", type: "number" },
      { name: "list_price", type: "number" },
      { name: "size", type: "text" },
      { name: "marketplace_listing_id", type: "text" },
      { name: "listing_status", type: "text" },
      { name: "listing_error", type: "text" },
      // Nothing maps onto this. It exists to be left alone: a verdict written
      // as an upsert would plan a column for every field and blank it, which is
      // the bug the task write-back once shipped with.
      { name: "warehouse_note", type: "text" },
    ],
  });
  const table = (slug: string) =>
    (client.query("select physical_table as t from collections where slug = ?").get(slug) as { t: string }).t;
  productsTable = table("products");
  variantsTable = table("product_variants");

  const { buildContext } = await import("../src/server/context");
  ctx = await buildContext(h.env);
  tenantId = (client.query("select tenant_id as t from collections where slug = 'products'").get() as { t: string }).t;

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
  client.close();
});

beforeEach(() => {
  calls = [];
  responses = [];
  // Trendyol is paced at 10rps; a suite that left the bucket empty would sit
  // out real seconds between tests.
  resetThrottleState();
  client.run(`delete from "${variantsTable}"`);
  client.run(`delete from "${productsTable}"`);
  client.run("delete from integration_listing_batches");
  client.run("delete from integration_listing_maps");
  client.run("delete from integration_syncs");
});

const seedProduct = (id: string, over: Record<string, unknown> = {}) => {
  const cols = {
    title: "Tee",
    body: "<p>Cotton</p>",
    category: "Tişört",
    ty_brand_id: 1479,
    photo: "https://cdn.example/a.jpg",
    colour: "Kırmızı",
    tenant_id: tenantId,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over,
  };
  const keys = Object.keys(cols);
  client.run(
    `insert into "${productsTable}" (id, ${keys.map((k) => `"${k}"`).join(",")}) values (?, ${keys.map(() => "?").join(",")})`,
    [id, ...keys.map((k) => (cols as any)[k])],
  );
};

const seedVariant = (id: string, product: string, over: Record<string, unknown> = {}) => {
  const cols = {
    product,
    barcode: `BAR-${id}`,
    sku: `SKU-${id}`,
    stock: 5,
    price: 99,
    list_price: 129,
    size: "M",
    warehouse_note: "aisle 4",
    tenant_id: tenantId,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over,
  };
  const keys = Object.keys(cols);
  client.run(
    `insert into "${variantsTable}" (id, ${keys.map((k) => `"${k}"`).join(",")}) values (?, ${keys.map(() => "?").join(",")})`,
    [id, ...keys.map((k) => (cols as any)[k])],
  );
};

describe("deciding what to publish", () => {
  test("a product whose category is unmapped is skipped and COUNTED", async () => {
    const sync = await makeSync();
    seedProduct("p1");
    seedVariant("v1", "p1");

    const out = await runListingSync(ctx, tenantId, sync.id);

    // Nothing was sent, and the reason is reportable rather than a silent zero.
    expect(calls).toHaveLength(0);
    expect(out).toMatchObject({ sent: 0, unmapped: 1, batchId: null });
  });

  test("a product's fields and its variants' merge, one unit per variant", async () => {
    const sync = await makeSync();
    await upsertListingMap(ctx, tenantId, {
      syncId: sync.id,
      localValue: "Tişört",
      categoryId: "1238",
      attributes: { "92": { field: "size" }, "47": { field: "colour" } },
    });
    seedProduct("p1");
    seedVariant("v1", "p1", { barcode: "BAR-1", size: "M" });
    seedVariant("v2", "p1", { barcode: "BAR-2", size: "L" });
    responses.push({ body: { batchRequestId: "batch-1" } });

    const out = await runListingSync(ctx, tenantId, sync.id);

    expect(out).toMatchObject({ sent: 2, rejected: 0, unmapped: 0, batchId: "batch-1" });
    const items = calls[0]!.body.items;
    expect(items).toHaveLength(2);
    // Both units carry the product's fields and share its group id, which is
    // what makes two barcodes one product page.
    expect(items.map((i: any) => i.productMainId)).toEqual(["p1", "p1"]);
    expect(items[0]).toMatchObject({ title: "Tee", brandId: 1479, categoryId: 1238, barcode: "BAR-1" });
    // The varianter attribute is read off the VARIANT: reading it off the
    // product would give both units "M" and collapse them into one.
    expect(items[0].attributes).toContainEqual({ attributeId: 92, customAttributeValue: "M" });
    expect(items[1].attributes).toContainEqual({ attributeId: 92, customAttributeValue: "L" });
    // A non-varianter attribute the variant does not have falls back to the
    // product, so it is the same on both.
    expect(items[0].attributes).toContainEqual({ attributeId: 47, customAttributeValue: "Kırmızı" });
  });

  test("a unit with no reference is left for next time rather than sent blind", async () => {
    const sync = await makeSync();
    await upsertListingMap(ctx, tenantId, { syncId: sync.id, localValue: "Tişört", categoryId: "1238" });
    seedProduct("p1");
    seedVariant("v1", "p1", { barcode: null });
    seedVariant("v2", "p1", { barcode: "BAR-2" });
    responses.push({ body: { batchRequestId: "batch-1" } });

    const out = await runListingSync(ctx, tenantId, sync.id);

    // Sending it would list the product and then have nowhere to put the
    // answer, which is worse than not listing it.
    expect(calls[0]!.body.items).toHaveLength(1);
    expect(out.sent).toBe(1);
  });

  test("what was sent is recorded against the row that asked, with its collection", async () => {
    const sync = await makeSync();
    await upsertListingMap(ctx, tenantId, { syncId: sync.id, localValue: "Tişört", categoryId: "1238" });
    seedProduct("p1");
    seedVariant("v1", "p1", { barcode: "BAR-1" });
    responses.push({ body: { batchRequestId: "batch-1" } });

    await runListingSync(ctx, tenantId, sync.id);

    const [batch] = batchRows();
    expect(batch).toMatchObject({ batch_id: "batch-1", status: "open", pending_count: 1 });
    // The collection travels WITH the batch: a verdict lands hours later, and
    // re-deriving it would follow the sync wherever it was repointed.
    expect(JSON.parse(String(batch!.sent))).toEqual({
      "BAR-1": { rowId: "v1", collection: "product_variants" },
    });
  });
});

describe("landing the verdict", () => {
  const publishOne = async () => {
    const sync = await makeSync();
    await upsertListingMap(ctx, tenantId, { syncId: sync.id, localValue: "Tişört", categoryId: "1238" });
    seedProduct("p1");
    seedVariant("v1", "p1", { barcode: "BAR-1" });
    responses.push({ body: { batchRequestId: "batch-1" } });
    await runListingSync(ctx, tenantId, sync.id);
    return String(batchRows()[0]!.id);
  };

  test("an accepted unit gets its id and status, and nothing else is touched", async () => {
    const id = await publishOne();
    responses.push({
      body: {
        status: "COMPLETED",
        items: [{ requestItem: { barcode: "BAR-1" }, status: "SUCCESS" }],
      },
    });

    const out = await pollListingBatchRow(ctx, tenantId, id);

    expect(out).toMatchObject({ applied: 1, pending: 0, closed: true });
    const [variant] = rows(variantsTable);
    expect(variant).toMatchObject({
      listing_status: "accepted",
      marketplace_listing_id: "BAR-1",
      // A `patch`, not an upsert: an upsert plans a column for every field, so
      // recording the approval would have blanked this one.
      warehouse_note: "aisle 4",
      sku: "SKU-v1",
    });
    expect(batchRows()[0]).toMatchObject({ status: "settled", pending_count: 0 });
  });

  test("a rejection carries the marketplace's own words to the row", async () => {
    const id = await publishOne();
    responses.push({
      body: {
        status: "COMPLETED",
        items: [
          {
            requestItem: { barcode: "BAR-1" },
            status: "FAILED",
            failureReasons: ["Marka bulunamadı", "Görsel çözünürlüğü düşük"],
          },
        ],
      },
    });

    await pollListingBatchRow(ctx, tenantId, id);

    const [variant] = rows(variantsTable);
    expect(variant!.listing_status).toBe("rejected");
    // Verbatim and joined, never parsed: the operator is the one who has to act
    // on it, and a summarised reason is one they cannot search their panel for.
    expect(String(variant!.listing_error)).toContain("Marka bulunamadı");
    expect(String(variant!.listing_error)).toContain("Görsel çözünürlüğü düşük");
  });

  test("a batch still in the queue stays open and writes nothing", async () => {
    const id = await publishOne();
    responses.push({
      body: { status: "IN_PROGRESS", items: [{ requestItem: { barcode: "BAR-1" }, status: "IN_PROGRESS" }] },
    });

    const out = await pollListingBatchRow(ctx, tenantId, id);

    expect(out).toMatchObject({ applied: 0, pending: 1, closed: false });
    expect(rows(variantsTable)[0]!.listing_status).toBeNull();
    expect(batchRows()[0]!.status).toBe("open");
  });

  test("a verdict for something this batch never sent is dropped", async () => {
    const id = await publishOne();
    responses.push({
      body: {
        status: "COMPLETED",
        items: [{ requestItem: { barcode: "SOMEONE-ELSE" }, status: "SUCCESS" }],
      },
    });

    const out = await pollListingBatchRow(ctx, tenantId, id);

    // The engine filters on what the batch carried, so one sync's poll can
    // never write another sync's rows.
    expect(out.applied).toBe(0);
    expect(rows(variantsTable)[0]!.listing_status).toBeNull();
  });

  test("a settled batch is not asked about again", async () => {
    const id = await publishOne();
    responses.push({
      body: { status: "COMPLETED", items: [{ requestItem: { barcode: "BAR-1" }, status: "SUCCESS" }] },
    });
    await pollListingBatchRow(ctx, tenantId, id);
    const after = calls.length;

    const out = await pollListingBatchRow(ctx, tenantId, id);

    expect(out.closed).toBe(true);
    expect(calls).toHaveLength(after);
  });
});

describe("what the form refuses", () => {
  test("a listing sync without an output mapping is refused", async () => {
    // Without one, a batch would be published and every verdict discarded.
    const res = await req("POST", `${BASE}/syncs`, {
      integrationId: trendyolId,
      collection: "products",
      direction: "listing",
      settings: { vatRate: "20" },
      categoryField: "category",
      mapping: { title: "title" },
      outputsMapping: {},
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("output mapping");
  });

  test("a category field the collection does not have is refused", async () => {
    const res = await req("POST", `${BASE}/syncs`, {
      integrationId: trendyolId,
      collection: "products",
      direction: "listing",
      settings: { vatRate: "20" },
      categoryField: "kategori",
      mapping: { title: "title" },
      outputsMapping: { listingStatus: "listing_status" },
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("kategori");
  });

  test("an output the provider never declares is refused", async () => {
    const res = await req("POST", `${BASE}/syncs`, {
      integrationId: trendyolId,
      collection: "products",
      direction: "listing",
      settings: { vatRate: "20" },
      categoryField: "category",
      mapping: { title: "title" },
      outputsMapping: { approvalRating: "listing_status" },
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("approvalRating");
  });

  test("a listing sync defaults to manual", async () => {
    const sync = await makeSync();
    // A publish is an outward, hard-to-undo act at a live marketplace. Turning
    // it into a schedule is the operator's decision, not the default.
    expect(sync.intervalMinutes).toBe(0);
  });
});
