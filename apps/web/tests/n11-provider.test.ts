/**
 * n11 — the third marketplace, and the one that settles whether a marketplace
 * is one file. It is: nothing here needed an engine change.
 *
 * What is left to prove is the part that is n11's and cannot be read off the
 * descriptor — that the date window is pointed at the modification date rather
 * than the creation date, that BOTH ends of it travel with the page, that a
 * package with no package number still lands, and that the approve task finds
 * its own line ids rather than asking an operator for them.
 */
import { describe, expect, test } from "bun:test";
import {
  destinationColumnsFor,
  INTEGRATION_TASKS,
  pullFromSource,
  pushToDestination,
  runIntegrationTask,
} from "@backlex/integrations";

const CONFIG = { appKey: "key", appSecret: "secret" };

const DAY_MS = 86_400_000;

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** A fake n11 that records every call and answers as told. */
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

const pull = (opts: {
  fetchImpl: any;
  cursor?: string | null;
  settings?: Record<string, unknown>;
  config?: Record<string, unknown>;
}) =>
  pullFromSource(
    "n11",
    {
      config: { ...CONFIG, ...(opts.config ?? {}) },
      settings: opts.settings ?? {},
      cursor: opts.cursor ?? null,
      limit: 100,
    },
    opts.fetchImpl,
  );

const PACKAGE = {
  id: "112999455244259",
  orderNumber: "203872347637",
  shipmentPackageStatus: "Created",
  lastModifiedDate: "2026-06-24T09:34:47",
  totalAmount: 498.9,
  customerId: 12345678,
  customerfullName: "n11 müşteri",
  customerEmail: "n11@n11.com",
  tcIdentityNumber: "11111111111",
  cargoProviderName: "MNG Kargo",
  shipmentCompanyId: 342,
  cargoTrackingNumber: "112999455244259",
  shipmentMethod: 1,
  shippingAddress: {
    address: "Reşitpaşa Mah İTÜ Teknokent",
    city: "İstanbul",
    district: "Sarıyer",
    neighborhood: "Reşitpaşa",
    fullName: "n11 müşteri",
    gsm: "5551112233",
    postalCode: "34000",
  },
  billingAddress: {
    address: "Reşitpaşa Mah İTÜ Teknokent",
    city: "İstanbul",
    district: "Sarıyer",
    fullName: "n11 müşteri",
    invoiceType: 1,
    countryCode: "TR",
  },
  lines: [
    {
      orderLineId: 426659152,
      productId: 123456789,
      productName: "Erkek Spor Ayakkabı Bordo 45",
      stockCode: "20242024",
      barcode: "8683772071724",
      quantity: 2,
      price: 249.45,
      sellerInvoiceAmount: 498.9,
      vatRate: 20,
      orderItemLineItemStatusName: "Created",
      variantAttributes: [
        { name: "Numara", value: "45" },
        { name: "Renk", value: "Bordo" },
      ],
    },
    { orderLineId: 426659151, quantity: 1, productName: "Çanta", orderItemLineItemStatusName: "Picking" },
  ],
};

const page = (content: unknown[], totalPages = 1) => ({ body: { content, totalPages, page: 0, size: 100 } });

describe("pulling shipment packages", () => {
  test("a first run reads the last fifteen days BY MODIFICATION, with the header pair", async () => {
    const { calls, fetchImpl } = recorder([page([PACKAGE])]);
    const before = Date.now();
    await pull({ fetchImpl });
    const after = Date.now();

    const call = calls[0]!;
    expect(call.url.pathname).toBe("/rest/delivery/v1/shipmentPackages");
    const start = Number(call.url.searchParams.get("startDate"));
    const end = Number(call.url.searchParams.get("endDate"));
    expect(end - start).toBe(15 * DAY_MS);
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(after);

    // The whole reason this source can mirror rather than snapshot. Without it
    // the window bounds order CREATION and a package would be seen once, in the
    // status it was born with, and never again.
    expect(call.url.searchParams.get("orderByField")).toBe("true");
    expect(call.url.searchParams.get("sender")).toBe("SELLER");
    // Deliberately no status filter: n11 takes one status per request, so
    // filtering to mirror every status would be seven walks instead of one.
    expect(call.url.searchParams.get("status")).toBeNull();

    // n11 documents authorization as "none" and reads the pair from headers.
    expect(call.headers.appkey).toBe("key");
    expect(call.headers.appsecret).toBe("secret");
    expect(call.headers.Authorization).toBeUndefined();
  });

  test("the first run's width is the operator's choice", async () => {
    const { calls, fetchImpl } = recorder([page([])]);
    await pull({ fetchImpl, settings: { lookbackDays: "1" } });
    const call = calls[0]!;
    const width = Number(call.url.searchParams.get("endDate")) - Number(call.url.searchParams.get("startDate"));
    expect(width).toBe(DAY_MS);
  });

  test("a package becomes a record with its lines as children", async () => {
    const { fetchImpl } = recorder([page([PACKAGE])]);
    const result = await pull({ fetchImpl });

    const record = result.records[0]!;
    expect(record.externalId).toBe("112999455244259");
    expect(record.data.orderNumber).toBe("203872347637");
    expect(record.data.status).toBe("Created");
    expect(record.data.cargoProviderName).toBe("MNG Kargo");
    // n11's own spelling of the field, kept rather than corrected.
    expect(record.data.customerFullName).toBe("n11 müşteri");
    // il / ilçe / mahalle all survive — a courier needs the three of them.
    expect(record.data.shipmentCity).toBe("İstanbul");
    expect(record.data.shipmentDistrict).toBe("Sarıyer");
    expect(record.data.shipmentNeighbourhood).toBe("Reşitpaşa");

    const lines = record.children!.lines!;
    expect(lines).toHaveLength(2);
    expect(lines[0]!.externalId).toBe("426659152");
    expect(lines[0]!.data.stockCode).toBe("20242024");
    expect(lines[0]!.data.unitPrice).toBe(249.45);
    // The variant pairs are joined into the one string a column can hold —
    // which is what a picking list actually wants to print.
    expect(lines[0]!.data.variants).toBe("Numara: 45, Renk: Bordo");
    expect(lines[1]!.data.variants).toBeNull();
  });

  test("a location-delivery package with no package number still lands, under a prefix", async () => {
    const { fetchImpl } = recorder([
      page([{ ...PACKAGE, id: null, orderNumber: "203872347637", deliveryAddressType: "PUP" }]),
    ]);
    const result = await pull({ fetchImpl });
    // Prefixed because package numbers and order numbers are both long digit
    // strings: two different things sharing an id namespace is how one row
    // silently overwrites another.
    expect(result.records[0]!.externalId).toBe("order-203872347637");
  });

  test("more pages continue THIS run, carrying BOTH ends of the window", async () => {
    const { calls, fetchImpl } = recorder([page([PACKAGE], 2), page([PACKAGE], 2)]);

    const first = await pull({ fetchImpl, settings: { lookbackDays: "1" } });
    expect(first.cursor).toStartWith("c:");
    // A page cursor is not a resume marker: returning one as the other would
    // either loop forever or throw the window away.
    expect(first.resumeToken).toBeUndefined();

    const opened = calls[0]!;
    const second = await pull({ fetchImpl, cursor: first.cursor });
    const followOn = calls[1]!;

    // The follow-on request pages the SAME result set. Widening the range on
    // page two would page a different one — and the first request's start came
    // from `lookbackDays`, which nothing downstream can rediscover.
    expect(followOn.url.searchParams.get("startDate")).toBe(opened.url.searchParams.get("startDate"));
    expect(followOn.url.searchParams.get("endDate")).toBe(opened.url.searchParams.get("endDate"));
    expect(followOn.url.searchParams.get("page")).toBe("1");
    expect(second.cursor).toBeNull();
    expect(second.resumeToken).toBe(`t:${opened.url.searchParams.get("endDate")}`);
  });

  test("an empty page ends the window even when the count disagrees", async () => {
    const { fetchImpl } = recorder([page([], 9)]);
    const result = await pull({ fetchImpl });
    expect(result.cursor).toBeNull();
    expect(result.resumeToken).toStartWith("t:");
  });

  test("the next run starts where the last window ended", async () => {
    const end = Date.now() - 3 * DAY_MS;
    const { calls, fetchImpl } = recorder([page([])]);
    await pull({ fetchImpl, cursor: `t:${end}` });
    // The same instant on both sides, not one millisecond later: a package
    // modified exactly on the boundary read twice is free, skipped is not.
    expect(Number(calls[0]!.url.searchParams.get("startDate"))).toBe(end);
  });

  test("a backfill advances one window at a time instead of asking for everything", async () => {
    const start = Date.now() - 90 * DAY_MS;
    const { calls, fetchImpl } = recorder([page([])]);
    const result = await pull({ fetchImpl, cursor: `t:${start}` });
    // n11 silently narrows a range wider than fifteen days to the last fifteen
    // before the end, so a backfill that asked for ninety would be answered
    // with a fortnight and would never learn it had been ignored.
    expect(Number(calls[0]!.url.searchParams.get("endDate")) - start).toBe(15 * DAY_MS);
    expect(result.resumeToken).toBe(`t:${start + 15 * DAY_MS}`);
  });

  test("a malformed cursor restarts the window rather than paging a bad one", async () => {
    const { calls, fetchImpl } = recorder([page([])]);
    await pull({ fetchImpl, cursor: "c:not-a-time:also-not" });
    const call = calls[0]!;
    expect(call.url.searchParams.get("page")).toBe("0");
    const width = Number(call.url.searchParams.get("endDate")) - Number(call.url.searchParams.get("startDate"));
    expect(width).toBe(15 * DAY_MS);
  });

  test("rejected credentials say where to find the right ones", async () => {
    const { fetchImpl } = recorder([{ status: 401, body: { message: "unauthorized" } }]);
    await expect(pull({ fetchImpl })).rejects.toThrow(/app key and secret/);
  });

  test("a credential that could shape a header is refused before one is built", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(pull({ fetchImpl, config: { appKey: "key\r\nX-Evil: 1" } })).rejects.toThrow(/ASCII/);
    expect(calls).toHaveLength(0);
  });
});

// ── Stock and price ──────────────────────────────────────────────────────────

const push = (rows: Record<string, unknown>[], opts: { fetchImpl: any; updates?: string }) =>
  pushToDestination(
    "n11",
    {
      config: CONFIG,
      settings: { updates: opts.updates ?? "both" },
      rows,
      columns: { stockCode: "text", quantity: "number", salePrice: "number", listPrice: "number" },
      syncKey: "sync-a",
    },
    opts.fetchImpl,
  );

const VARIANT = { stockCode: "20242024", quantity: 7, salePrice: 249.456, listPrice: 299 };
const QUEUED = { body: { id: 1092, type: "SKU_UPDATE", status: "IN_QUEUE" } };
const PROCESSED = { body: { taskId: 1092, skus: { content: [{ itemCode: "20242024", status: "SUCCESS" }] } } };

describe("pushing stock and price", () => {
  test("the columns on offer follow what the sync says it sends", () => {
    expect(destinationColumnsFor("n11", { updates: "stock" })?.map((c) => c.value)).toEqual([
      "stockCode",
      "quantity",
    ]);
    expect(destinationColumnsFor("n11", { updates: "price" })?.map((c) => c.value)).toEqual([
      "stockCode",
      "salePrice",
      "listPrice",
      "currencyType",
    ]);
    expect(destinationColumnsFor("n11", { updates: "both" })).toHaveLength(5);
  });

  test("prices go as a pair, rounded to the two decimals n11 will accept", async () => {
    const { calls, fetchImpl } = recorder([QUEUED, PROCESSED]);
    await push([VARIANT], { fetchImpl });

    const sku = calls[0]!.body.payload.skus[0];
    // Anything else REJECTs the whole task, which would be a batch of rows that
    // silently did not update.
    expect(sku.salePrice).toBe(249.46);
    expect(sku.listPrice).toBe(299);
    expect(sku.quantity).toBe(7);
    expect(calls[0]!.body.payload.integrator).toBe("backlex");
  });

  test("a list price below the sale price is lifted rather than rejected", async () => {
    const { calls, fetchImpl } = recorder([QUEUED, PROCESSED]);
    await push([{ stockCode: "A", salePrice: 300, listPrice: 100 }], { fetchImpl, updates: "price" });
    expect(calls[0]!.body.payload.skus[0].listPrice).toBe(300);
  });

  test("an unmapped list price still sends the pair n11 insists on", async () => {
    const { calls, fetchImpl } = recorder([QUEUED, PROCESSED]);
    await push([{ stockCode: "A", salePrice: 300 }], { fetchImpl, updates: "price" });
    expect(calls[0]!.body.payload.skus[0]).toEqual({ stockCode: "A", salePrice: 300, listPrice: 300 });
  });

  test("a stock-only sync never sends a price the seller manages in the panel", async () => {
    const { calls, fetchImpl } = recorder([QUEUED, PROCESSED]);
    await push([VARIANT], { fetchImpl, updates: "stock" });
    expect(calls[0]!.body.payload.skus[0]).toEqual({ stockCode: "20242024", quantity: 7 });
  });

  test("a negative stock is a mapping error, not an oversell to publish", async () => {
    const { calls, fetchImpl } = recorder([QUEUED, PROCESSED]);
    await push([{ stockCode: "A", quantity: -4 }], { fetchImpl, updates: "stock" });
    expect(calls[0]!.body.payload.skus[0].quantity).toBe(0);
  });

  test("a batch addressing no listing never leaves the process", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(push([{ quantity: 3 }], { fetchImpl })).rejects.toThrow(/stock code/);
    expect(calls).toHaveLength(0);
  });

  test("an up-front REJECT is an answer, not a queue to poll", async () => {
    const { calls, fetchImpl } = recorder([
      { body: { id: 1, status: "REJECT", reasons: ["Veri seti yüklenmedi"] } },
    ]);
    await expect(push([VARIANT], { fetchImpl })).rejects.toThrow(/Veri seti yüklenmedi/);
    // No point asking what became of a task that was never taken.
    expect(calls).toHaveLength(1);
  });

  test("every SKU refused holds the watermark; one of many does not", async () => {
    const all = recorder([
      QUEUED,
      { body: { skus: { content: [{ status: "Fail", reasons: ["Ürün bulunamadı"] }, { status: "Fail" }] } } },
    ]);
    await expect(push([VARIANT, { stockCode: "B", quantity: 1 }], { fetchImpl: all.fetchImpl })).rejects.toThrow(
      /refused every SKU/,
    );

    // One delisted SKU among two would otherwise hold the watermark on its row
    // for ever and the sync would never reach the rows behind it.
    const some = recorder([
      QUEUED,
      { body: { skus: { content: [{ status: "Fail" }, { status: "SUCCESS" }] } } },
    ]);
    await push([VARIANT, { stockCode: "B", quantity: 1 }], { fetchImpl: some.fetchImpl });
  });

  test("a task whose result cannot be read is not re-sent", async () => {
    const { fetchImpl } = recorder([QUEUED, { status: 500, body: "nope" }]);
    await push([VARIANT], { fetchImpl });
  });
});

// ── Tasks ────────────────────────────────────────────────────────────────────

const runTask = (opts: { fetchImpl: any; row?: Record<string, unknown> }) =>
  runIntegrationTask(
    "n11",
    "approve_package",
    {
      config: CONFIG,
      settings: { packageIdField: "shipment_package_id" },
      row: opts.row ?? { id: "o1", shipment_package_id: "112999455244259" },
      idempotencyKey: "run-1",
    },
    opts.fetchImpl,
  );

describe("approving a package", () => {
  test("there is one task, because n11 accepts one transition", () => {
    // `UpdateOrder` documents Picking and says the rest will follow. A single
    // set-status task with a value setting would offer four values the API
    // refuses; when the others arrive they arrive as more tasks.
    expect(INTEGRATION_TASKS.n11?.map((t) => t.id)).toEqual(["approve_package"]);
  });

  test("the task finds its own line ids, and only the ones still waiting", async () => {
    const { calls, fetchImpl } = recorder([
      page([PACKAGE]),
      { body: { content: [{ lineId: 426659152, status: "SUCCESS" }] } },
    ]);
    const result = await runTask({ fetchImpl });

    // The row is a package; n11 approves lines, and they live in the child
    // collection rather than on the row.
    expect(calls[0]!.url.searchParams.get("packageIds")).toBe("112999455244259");

    const update = calls[1]!;
    expect(update.method).toBe("PUT");
    expect(update.url.pathname).toBe("/rest/order/v1/update");
    expect(update.body).toEqual({ lines: [{ lineId: 426659152 }], status: "Picking" });
    expect(result.outputs.status).toBe("Picking");
    expect(result.outputs.approvedLines).toBe(1);
  });

  test("a package with nothing left to approve says so", async () => {
    const picked = { ...PACKAGE, lines: [{ orderLineId: 1, orderItemLineItemStatusName: "Picking" }] };
    const { fetchImpl } = recorder([page([picked])]);
    await expect(runTask({ fetchImpl })).rejects.toThrow(/waiting to be approved/);
  });

  test("every line refused is not a partial success to report as done", async () => {
    const { fetchImpl } = recorder([
      page([PACKAGE]),
      { body: { content: [{ lineId: 426659152, status: "FAIL", reasons: "Statü uygun değil" }] } },
    ]);
    await expect(runTask({ fetchImpl })).rejects.toThrow(/Statü uygun değil/);
  });

  test("a package the seller does not have is named, not silently skipped", async () => {
    const { fetchImpl } = recorder([page([])]);
    await expect(runTask({ fetchImpl })).rejects.toThrow(/no package/);
  });

  test("a package id that is not one never reaches a query", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(runTask({ fetchImpl, row: { id: "o1", shipment_package_id: "12/../x" } })).rejects.toThrow(
      /numeric/,
    );
    expect(calls).toHaveLength(0);
  });
});
