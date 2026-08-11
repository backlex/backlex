/**
 * Trendyol — the first provider that reads orders in, writes stock and price
 * out, and notifies a status back.
 *
 * The engine's own specs already prove the machinery: children are qualified by
 * their parent, a task runs once, a 429 stays out of the breaker. What is left
 * to prove is the part that is Trendyol's and cannot be inferred from the
 * descriptor — the window arithmetic that decides which orders a run can even
 * see, the two token kinds sharing one cursor slot, and the three ways this
 * provider deliberately does NOT send a field.
 *
 * The pacing state is reset between tests on purpose. The order stream is
 * limited to one request every five seconds and takes its token from the same
 * bucket the engine uses, so a suite that left the bucket empty would not be
 * slow — it would be five seconds slower per pull, which is the kind of thing
 * that gets a real limit quietly deleted.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  destinationColumnsFor,
  INTEGRATION_TASKS,
  pullFromSource,
  pushToDestination,
  resetThrottleState,
  runIntegrationTask,
} from "@backlex/integrations";

const CONFIG = {
  sellerId: "12345",
  apiKey: "key",
  apiSecret: "secret",
  storeFrontCode: "TR",
  environment: "production",
};

const DAY_MS = 86_400_000;

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** A fake Trendyol that records every call and answers as told. */
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
    "trendyol",
    {
      config: { ...CONFIG, ...(opts.config ?? {}) },
      settings: opts.settings ?? {},
      cursor: opts.cursor ?? null,
      limit: 200,
    },
    opts.fetchImpl,
  );

const PACKAGE = {
  shipmentPackageId: 3330111111,
  orderNumber: "10654411111",
  status: "Created",
  orderDate: 1762253333685,
  lastModifiedDate: 1762865408581,
  packageTotalPrice: 498.9,
  currencyCode: "TRY",
  customerFirstName: "Ayşe",
  customerLastName: "Yılmaz",
  customerEmail: "ayse@example.com",
  shipmentAddress: {
    firstName: "Ayşe",
    lastName: "Yılmaz",
    address1: "Bağdat Cad. No 1",
    neighborhood: "Caferağa Mah.",
    district: "Kadıköy",
    city: "İstanbul",
    postalCode: "34710",
    countryCode: "TR",
    phone: "5551112233",
  },
  invoiceAddress: { taxNumber: "1234567890", taxOffice: "Kadıköy", city: "İstanbul" },
  lines: [
    {
      lineId: 4765111111,
      quantity: 2,
      productName: "Klasik Tişört",
      stockCode: "TEE-001-S-BLK",
      barcode: "8683772071724",
      lineUnitPrice: 249.45,
      lineTotalDiscount: 0,
      vatRate: 20,
      currencyCode: "TRY",
      orderLineItemStatusName: "Created",
    },
    { lineId: 4765111112, quantity: 1, productName: "Çanta", barcode: "868377207000", price: 18 },
  ],
};

beforeEach(() => {
  resetThrottleState();
});

describe("pulling orders", () => {
  test("a first run reads the last fourteen days, authenticated as the seller", async () => {
    const { calls, fetchImpl } = recorder([{ body: { content: [PACKAGE], hasMore: false } }]);
    const before = Date.now();
    await pull({ fetchImpl });
    const after = Date.now();

    const call = calls[0]!;
    expect(call.url.pathname).toBe("/integration/order/sellers/12345/orders/stream");
    const start = Number(call.url.searchParams.get("lastModifiedStartDate"));
    const end = Number(call.url.searchParams.get("lastModifiedEndDate"));
    expect(end - start).toBe(14 * DAY_MS);
    // The window ends now, not in the future — an end past `now` would be a
    // window that can never be finished and a resume token that skips orders.
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(after);

    expect(call.headers.Authorization).toBe(`Basic ${btoa("key:secret")}`);
    // Trendyol refuses a request without this even when the credentials are
    // right, so it is not decoration.
    expect(call.headers["User-Agent"]).toBe("12345 - SelfIntegration");
    expect(call.headers.storeFrontCode).toBe("TR");
  });

  test("the first run's width is the operator's choice", async () => {
    const { calls, fetchImpl } = recorder([{ body: { content: [], hasMore: false } }]);
    await pull({ fetchImpl, settings: { lookbackDays: "1" } });
    const call = calls[0]!;
    const width =
      Number(call.url.searchParams.get("lastModifiedEndDate")) -
      Number(call.url.searchParams.get("lastModifiedStartDate"));
    expect(width).toBe(DAY_MS);
  });

  test("a package becomes a record with its lines as children", async () => {
    const { fetchImpl } = recorder([{ body: { content: [PACKAGE], hasMore: false } }]);
    const page = await pull({ fetchImpl });

    const record = page.records[0]!;
    expect(record.externalId).toBe("3330111111");
    expect(record.data.orderNumber).toBe("10654411111");
    expect(record.data.totalPrice).toBe(498.9);
    // il / ilçe / mahalle all survive. A courier needs the three of them, and
    // the carrier integration must not have to re-fetch the order to get them.
    expect(record.data.shipmentCity).toBe("İstanbul");
    expect(record.data.shipmentDistrict).toBe("Kadıköy");
    expect(record.data.shipmentNeighbourhood).toBe("Caferağa Mah.");
    expect(record.data.shipmentCountryCode).toBe("TR");
    expect(record.data.shipmentFullName).toBe("Ayşe Yılmaz");
    expect(record.data.invoiceTaxNumber).toBe("1234567890");

    const lines = record.children!.lines!;
    expect(lines).toHaveLength(2);
    expect(lines[0]!.externalId).toBe("4765111111");
    expect(lines[0]!.data.quantity).toBe(2);
    expect(lines[0]!.data.unitPrice).toBe(249.45);
    expect(lines[0]!.data.stockCode).toBe("TEE-001-S-BLK");
    // The stream endpoint publishes its envelope but not its line schema, so
    // the older field names are read as a fallback — a null price is a far
    // worse way to find out than a few extra characters here.
    expect(lines[1]!.data.unitPrice).toBe(18);
  });

  test("a line with no id is dropped rather than colliding on one key", async () => {
    const { fetchImpl } = recorder([
      { body: { content: [{ ...PACKAGE, lines: [{ quantity: 1 }, PACKAGE.lines[0]] }], hasMore: false } },
    ]);
    const page = await pull({ fetchImpl });
    expect(page.records[0]!.children!.lines).toHaveLength(1);
  });

  // The one slow test in this file, and deliberately so: the second page waits
  // out the interval Trendyol asks for, which is the behaviour being asserted.
  test("more pages continue THIS run; the last page starts the next one", async () => {
    const { calls, fetchImpl } = recorder([
      { body: { content: [PACKAGE], hasMore: true, nextCursor: "opaque-1" } },
      { body: { content: [], hasMore: false } },
    ]);

    const first = await pull({ fetchImpl });
    expect(first.cursor).toStartWith("c:");
    expect(first.cursor).toEndWith(":opaque-1");
    // A page cursor is not a resume marker: returning one as the other would
    // either loop forever or throw the window away.
    expect(first.resumeToken).toBeUndefined();

    const startedAt = Date.now();
    const second = await pull({ fetchImpl, cursor: first.cursor });
    // The five seconds are not incidental — the stream endpoint asks for them
    // between requests, and this is where that is actually enforced.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_000);
    expect(second.cursor).toBeNull();
    // The window travels WITH the page cursor, so the run that finishes on page
    // two still knows where the next one begins. Without it a backfill would
    // jump back to the most recent fortnight and never finish the middle.
    const windowEnd = Number(first.cursor!.slice(2).split(":")[0]);
    expect(second.resumeToken).toBe(`t:${windowEnd}`);

    // Trendyol refuses a stream whose filters change mid-walk, so the follow-on
    // request carries the cursor and nothing else.
    const followOn = calls[1]!;
    expect(followOn.url.searchParams.get("cursor")).toBe("opaque-1");
    expect(followOn.url.searchParams.get("lastModifiedStartDate")).toBeNull();
  }, 15_000);

  test("the next run starts where the last window ended", async () => {
    const end = Date.now() - 3 * DAY_MS;
    const { calls, fetchImpl } = recorder([{ body: { content: [], hasMore: false } }]);
    await pull({ fetchImpl, cursor: `t:${end}` });

    const call = calls[0]!;
    // The same instant on both sides, not one millisecond later: a package
    // modified exactly on the boundary read twice is free, skipped is not.
    expect(Number(call.url.searchParams.get("lastModifiedStartDate"))).toBe(end);
  });

  test("a backfill advances one window at a time instead of asking for everything", async () => {
    const start = Date.now() - 60 * DAY_MS;
    const { calls, fetchImpl } = recorder([{ body: { content: [], hasMore: false } }]);
    const page = await pull({ fetchImpl, cursor: `t:${start}` });

    const call = calls[0]!;
    expect(Number(call.url.searchParams.get("lastModifiedEndDate")) - start).toBe(14 * DAY_MS);
    // …and the run hands back that end, so the following run picks up the next
    // fortnight rather than re-reading this one.
    expect(page.resumeToken).toBe(`t:${start + 14 * DAY_MS}`);
  });

  test("a nonsense resume marker falls back to a fresh window rather than a bad one", async () => {
    const { calls, fetchImpl } = recorder([{ body: { content: [], hasMore: false } }]);
    await pull({ fetchImpl, cursor: "t:not-a-time" });
    const call = calls[0]!;
    const width =
      Number(call.url.searchParams.get("lastModifiedEndDate")) -
      Number(call.url.searchParams.get("lastModifiedStartDate"));
    expect(width).toBe(14 * DAY_MS);
  });

  test("rejected credentials say which page to go and look at", async () => {
    const { fetchImpl } = recorder([{ status: 401, body: { message: "unauthorized" } }]);
    await expect(pull({ fetchImpl })).rejects.toThrow(/Integration Details/);
  });

  test("a seller id that is not a number never reaches a URL", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(pull({ fetchImpl, config: { sellerId: "12345/../../etc" } })).rejects.toThrow(/numeric/);
    expect(calls).toHaveLength(0);
  });

  test("a market outside the published set is refused", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(pull({ fetchImpl, config: { storeFrontCode: "XX\r\nX" } })).rejects.toThrow(/market/);
    expect(calls).toHaveLength(0);
  });
});

// ── Stock and price ──────────────────────────────────────────────────────────

const push = (
  rows: Record<string, unknown>[],
  opts: { fetchImpl: any; updates?: string },
) =>
  pushToDestination(
    "trendyol",
    {
      config: CONFIG,
      settings: { updates: opts.updates ?? "both" },
      rows,
      columns: { barcode: "text", quantity: "number", salePrice: "number", listPrice: "number" },
      syncKey: "sync-a",
    },
    opts.fetchImpl,
  );

const VARIANT = { barcode: "868377207", quantity: 7, salePrice: 249.45, listPrice: 299 };

describe("pushing stock and price", () => {
  test("the columns on offer follow what the sync says it sends", () => {
    // Offering a price column on a stock-only sync is a trap the operator only
    // finds out about when the value is silently dropped.
    expect(destinationColumnsFor("trendyol", { updates: "stock" })?.map((c) => c.value)).toEqual([
      "barcode",
      "quantity",
    ]);
    expect(destinationColumnsFor("trendyol", { updates: "price" })?.map((c) => c.value)).toEqual([
      "barcode",
      "salePrice",
      "listPrice",
    ]);
    expect(destinationColumnsFor("trendyol", { updates: "both" })).toHaveLength(4);
  });

  test("a stock-only sync sends no price, and a price-only sync no stock", async () => {
    const stock = recorder();
    await push([VARIANT], { fetchImpl: stock.fetchImpl, updates: "stock" });
    // An omitted field means "leave it alone" at Trendyol, which is the whole
    // point: a stock sync must not overwrite a price set in the seller panel.
    expect(stock.calls[0]!.body.items[0]).toEqual({ barcode: "868377207", quantity: 7 });

    const price = recorder();
    await push([VARIANT], { fetchImpl: price.fetchImpl, updates: "price" });
    expect(price.calls[0]!.body.items[0]).toEqual({
      barcode: "868377207",
      salePrice: 249.45,
      listPrice: 299,
    });
  });

  test("an unmapped list price falls back to the sale price", async () => {
    const { calls, fetchImpl } = recorder();
    await push([{ barcode: "b1", salePrice: 100 }], { fetchImpl, updates: "price" });
    // Trendyol refuses a list price below the sale price, so the alternative to
    // this is a batch rejected for a column nobody filled in.
    expect(calls[0]!.body.items[0]).toEqual({ barcode: "b1", salePrice: 100, listPrice: 100 });
  });

  test("a row with no barcode is skipped, and a batch of them is a mapping error", async () => {
    const some = recorder();
    await push([{ barcode: "", quantity: 1 }, VARIANT], { fetchImpl: some.fetchImpl });
    expect(some.calls[0]!.body.items).toHaveLength(1);

    const none = recorder();
    // Every row refused is not data, it is a mis-mapped column — and reporting
    // a clean run would advance the watermark over rows nothing received.
    await expect(push([{ quantity: 1 }], { fetchImpl: none.fetchImpl })).rejects.toThrow(/barcode/);
  });

  test("a row that would change nothing is not sent", async () => {
    const { fetchImpl } = recorder();
    await expect(push([{ barcode: "b1" }], { fetchImpl })).rejects.toThrow(/barcode/);
  });

  test("a batch Trendyol refused entirely fails the run", async () => {
    const { calls, fetchImpl } = recorder([
      { body: { batchRequestId: "batch-1" } },
      {
        body: {
          status: "COMPLETED",
          itemCount: 1,
          failedItemCount: 1,
          items: [{ status: "FAILED", failureReasons: ["Barcode not found"] }],
        },
      },
    ]);
    await expect(push([VARIANT], { fetchImpl })).rejects.toThrow(/Barcode not found/);
    expect(calls[1]!.url.pathname).toContain("/batch-requests/batch-1");
  });

  test("one bad item among many does not hold the watermark", async () => {
    // The asymmetry is deliberate: an archived listing among two hundred would
    // otherwise wedge the sync on its own row forever.
    const { fetchImpl } = recorder([
      { body: { batchRequestId: "batch-2" } },
      { body: { status: "COMPLETED", itemCount: 2, failedItemCount: 1, items: [] } },
    ]);
    await push([VARIANT, { ...VARIANT, barcode: "b2" }], { fetchImpl });
  });

  test("a batch still in the queue is not an answer", async () => {
    const { fetchImpl } = recorder([
      { body: { batchRequestId: "batch-3" } },
      { body: { status: "PROCESSING" } },
    ]);
    await push([VARIANT], { fetchImpl });
  });
});

// ── Tasks ────────────────────────────────────────────────────────────────────

const runTask = (
  task: string,
  opts: { fetchImpl: any; row?: Record<string, unknown>; settings?: Record<string, unknown> },
) =>
  runIntegrationTask(
    "trendyol",
    task,
    {
      config: CONFIG,
      settings: { packageIdField: "shipment_package_id", ...(opts.settings ?? {}) },
      row: opts.row ?? { id: "o1", shipment_package_id: "3330111111" },
      idempotencyKey: "run-1",
    },
    opts.fetchImpl,
  );

describe("notifying a package's status", () => {
  test("the two notifications are two tasks, not one with a setting", () => {
    // The once-only guard is keyed by (integration, task, row), so a single
    // set-status task would mark a package Picking and then refuse to mark it
    // Invoiced — reporting the first run's answer instead of notifying.
    expect(INTEGRATION_TASKS.trendyol?.map((t) => t.id)).toEqual(["mark_picking", "mark_invoiced"]);
  });

  test("picking is one PUT against the package", async () => {
    const { calls, fetchImpl } = recorder();
    const result = await runTask("mark_picking", { fetchImpl });

    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url.pathname).toBe("/integration/order/sellers/12345/shipment-packages/3330111111");
    expect(call.body).toEqual({ status: "Picking" });
    expect(result.outputs.status).toBe("Picking");
    expect(typeof result.outputs.notifiedAt).toBe("number");
  });

  test("invoicing carries the number off the row", async () => {
    const { calls, fetchImpl } = recorder();
    const result = await runTask("mark_invoiced", {
      fetchImpl,
      row: { id: "o1", shipment_package_id: "3330111111", invoice_number: "GIB2026000000123" },
      settings: { invoiceNumberField: "invoice_number" },
    });

    expect(calls[0]!.body).toEqual({
      status: "Invoiced",
      params: { invoiceNumber: "GIB2026000000123" },
    });
    expect(result.outputs.invoiceNumber).toBe("GIB2026000000123");
  });

  test("a row with no invoice number is refused before Trendyol is told anything", async () => {
    const { calls, fetchImpl } = recorder();
    expect(
      runTask("mark_invoiced", { fetchImpl, settings: { invoiceNumberField: "invoice_number" } }),
    ).rejects.toThrow(/invoice number/);
    expect(calls).toHaveLength(0);
  });

  test("a package id that is not a number never reaches a URL", async () => {
    const { calls, fetchImpl } = recorder();
    expect(
      runTask("mark_picking", { fetchImpl, row: { id: "o1", shipment_package_id: "1/../../orders" } }),
    ).rejects.toThrow(/numeric/);
    expect(calls).toHaveLength(0);
  });

  test("a task aimed at a field the row does not have says which field", async () => {
    const { fetchImpl } = recorder();
    expect(
      runTask("mark_picking", { fetchImpl, settings: { packageIdField: "package_no" } }),
    ).rejects.toThrow(/package_no/);
  });

  test("a refusal from Trendyol is re-thrown, never reported as notified", async () => {
    const { fetchImpl } = recorder([{ status: 400, body: { errors: [{ message: "invalid status" }] } }]);
    await expect(runTask("mark_picking", { fetchImpl })).rejects.toThrow(/invalid status/);
  });
});
