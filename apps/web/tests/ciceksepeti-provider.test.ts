/**
 * Çiçeksepeti — the fourth marketplace, and the one whose pacing is the
 * interesting part.
 *
 * The engine's own specs prove the machinery. What is left to prove here is
 * Çiçeksepeti's own: that the order walk takes the five-second token its
 * documentation asks for, that a flat list of sub-orders becomes one record per
 * order, that a struck-through price is never sent without a sale price, and
 * that a status task finds its own sub-order ids.
 *
 * The pacing state is reset between tests on purpose. `GetOrders` is limited to
 * one request every five seconds and takes its token from the same bucket the
 * engine uses, so a suite that left the bucket empty would be five seconds
 * slower per pull — the kind of thing that gets a real limit quietly deleted.
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

const CONFIG = { apiKey: "key", sellerId: "150000123456", environment: "production" };

const DAY_MS = 86_400_000;

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** A fake Çiçeksepeti that records every call and answers as told. */
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
    "ciceksepeti",
    {
      config: { ...CONFIG, ...(opts.config ?? {}) },
      settings: opts.settings ?? {},
      cursor: opts.cursor ?? null,
      limit: 100,
    },
    opts.fetchImpl,
  );

const subOrder = (over: Record<string, unknown> = {}) => ({
  branchId: 150000123456,
  customerId: 123456,
  orderId: 123456789,
  orderItemId: 987654321,
  orderCreateDate: "02/01/2020",
  orderCreateTime: "17:54",
  orderModifyDate: "02/01/2020",
  orderModifyTime: "18:30",
  orderProductStatus: "Yeni",
  orderItemStatusId: 1,
  totalPrice: 149.9,
  tax: 27,
  receiverName: "Ahmet Aslan",
  receiverPhone: "5551112233",
  receiverAddress: "Bağdat Cad. No 1",
  receiverCity: "İstanbul",
  receiverDistrict: "Kadıköy",
  receiverRegion: "Caferağa",
  senderName: "Ayşe Yılmaz",
  senderCity: "İstanbul",
  cardMessage: "İyi ki doğdun",
  productId: 5544,
  productCode: "CS-5544",
  code: "TEDARIKCI-1",
  name: "Kırmızı Gül Buketi",
  quantity: 1,
  quantityUnit: "adet",
  ...over,
});

const orders = (items: unknown[]) => ({
  body: { orderListCount: items.length, supplierOrderListWithBranch: items },
});

beforeEach(() => {
  resetThrottleState();
});

describe("mirroring orders", () => {
  test("a run re-reads a rolling window and authenticates as the seller", async () => {
    const { calls, fetchImpl } = recorder([orders([subOrder()])]);
    const before = Date.now();
    const result = await pull({ fetchImpl });
    const after = Date.now();

    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.href).toBe("https://apis.ciceksepeti.com/api/v1/Order/GetOrders");

    const start = Date.parse(call.body.startDate);
    const end = Date.parse(call.body.endDate);
    expect(end - start).toBe(7 * DAY_MS);
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(after);
    expect(call.body.page).toBe(0);

    expect(call.headers["x-api-key"]).toBe("key");
    // The seller id alone when integrating directly; "sellerId-integrator" when
    // working through one. Çiçeksepeti reads it to tell them apart.
    expect(call.headers["user-agent"]).toBe("150000123456");

    // The window does not advance between runs: Çiçeksepeti never says whether
    // its date filter bounds the order date or the modification date, and
    // re-reading is the only choice that is correct under both readings.
    expect(result.resumeToken).toBeUndefined();
  });

  test("an integrator is named in the user agent when there is one", async () => {
    const { calls, fetchImpl } = recorder([orders([])]);
    await pull({ fetchImpl, config: { integrator: "backlex" } });
    expect(calls[0]!.headers["user-agent"]).toBe("150000123456-backlex");
  });

  test("the sandbox is the other host, not a flag on one", async () => {
    const { calls, fetchImpl } = recorder([orders([])]);
    await pull({ fetchImpl, config: { environment: "sandbox" } });
    expect(calls[0]!.url.host).toBe("sandbox-apis.ciceksepeti.com");
  });

  test("sub-orders sharing an order become one record with two lines", async () => {
    const { fetchImpl } = recorder([
      orders([
        subOrder({ orderItemId: 987654321 }),
        subOrder({ orderItemId: 987654322, name: "Çikolata" }),
        subOrder({ orderId: 123456790, orderItemId: 987654323 }),
      ]),
    ]);
    const result = await pull({ fetchImpl });

    expect(result.records).toHaveLength(2);
    const order = result.records.find((r) => r.externalId === "123456789")!;
    expect(order.data.receiverName).toBe("Ahmet Aslan");
    // A flower marketplace: the card note is the product, not decoration.
    expect(order.data.cardMessage).toBe("İyi ki doğdun");
    // il / ilçe / mahalle survive — note that Çiçeksepeti's `Region` is the
    // mahalle and its `District` the ilçe.
    expect(order.data.receiverCity).toBe("İstanbul");
    expect(order.data.receiverDistrict).toBe("Kadıköy");
    expect(order.data.receiverNeighbourhood).toBe("Caferağa");
    // The date and the time arrive in two fields and land in one column.
    expect(order.data.orderCreateDate).toBe("02/01/2020 17:54");

    expect(order.children!.lines).toHaveLength(2);
    expect(order.children!.lines!.map((l) => l.externalId)).toEqual(["987654321", "987654322"]);
    expect(order.children!.lines![0]!.data.stockCode).toBe("TEDARIKCI-1");
  });

  test("a full page continues the walk and a short one ends it", async () => {
    const full = Array.from({ length: 100 }, (_, i) => subOrder({ orderId: i, orderItemId: i }));
    const { calls, fetchImpl } = recorder([orders(full), orders([subOrder()])]);

    const first = await pull({ fetchImpl });
    expect(first.cursor).toBe("1");

    const startedAt = Date.now();
    const second = await pull({ fetchImpl, cursor: first.cursor });
    // The five seconds are not incidental — Çiçeksepeti asks for them between
    // requests with a different body, and this is where that is enforced.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_000);
    expect(calls[1]!.body.page).toBe(1);
    expect(second.cursor).toBeNull();
  }, 20_000);

  test("a nonsense cursor restarts the walk rather than skipping into nowhere", async () => {
    const { calls, fetchImpl } = recorder([orders([])]);
    await pull({ fetchImpl, cursor: "not-a-page" });
    expect(calls[0]!.body.page).toBe(0);
  });

  test("rejected credentials say which panel page to go and look at", async () => {
    const { fetchImpl } = recorder([{ status: 401, body: { message: "unauthorized" } }]);
    await expect(pull({ fetchImpl })).rejects.toThrow(/Entegrasyon Bilgilerim/);
  });

  test("a seller id that could shape a header never reaches one", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(pull({ fetchImpl, config: { sellerId: "1\r\nX-Evil: 1" } })).rejects.toThrow(/seller id/);
    expect(calls).toHaveLength(0);
  });
});

// ── Stock and price ──────────────────────────────────────────────────────────

const push = (rows: Record<string, unknown>[], opts: { fetchImpl: any; updates?: string }) =>
  pushToDestination(
    "ciceksepeti",
    {
      config: CONFIG,
      settings: { updates: opts.updates ?? "both" },
      rows,
      columns: { stockCode: "text", stockQuantity: "number", salesPrice: "number", listPrice: "number" },
      syncKey: "sync-a",
    },
    opts.fetchImpl,
  );

const VARIANT = { stockCode: "TEDARIKCI-1", stockQuantity: 5, salesPrice: 49.99, listPrice: 50.5 };
const QUEUED = { body: { batchId: "cef33e24-2f49-4c7f-a745-a59f7d5ce90d" } };

describe("pushing stock and price", () => {
  test("the columns on offer follow what the sync says it sends", () => {
    expect(destinationColumnsFor("ciceksepeti", { updates: "stock" })?.map((c) => c.value)).toEqual([
      "stockCode",
      "stockQuantity",
    ]);
    expect(destinationColumnsFor("ciceksepeti", { updates: "price" })?.map((c) => c.value)).toEqual([
      "stockCode",
      "salesPrice",
      "listPrice",
    ]);
    expect(destinationColumnsFor("ciceksepeti", { updates: "both" })).toHaveLength(4);
  });

  test("the update is a PUT whose batch is then asked about", async () => {
    const { calls, fetchImpl } = recorder([
      QUEUED,
      { body: { items: [{ status: "Success" }] } },
    ]);
    await push([VARIANT], { fetchImpl });

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.pathname).toBe("/api/v1/Products/price-and-stock");
    expect(calls[0]!.body.items[0]).toEqual({
      stockCode: "TEDARIKCI-1",
      stockQuantity: 5,
      salesPrice: 49.99,
      listPrice: 50.5,
    });
    expect(calls[1]!.url.pathname).toBe(
      "/api/v1/Products/batch-status/cef33e24-2f49-4c7f-a745-a59f7d5ce90d",
    );
  });

  test("a struck-through price is never sent without the sale price beside it", async () => {
    const { calls, fetchImpl } = recorder([QUEUED, { body: { items: [{ status: "Success" }] } }]);
    // Çiçeksepeti refuses the item, so there is nothing to send for that row —
    // and a batch with nothing sendable holds the watermark rather than
    // reporting a clean run over listings nothing reached.
    await expect(push([{ stockCode: "A", listPrice: 99 }], { fetchImpl, updates: "price" })).rejects.toThrow(
      /something to update/,
    );
    expect(calls).toHaveLength(0);
  });

  test("an unmapped struck-through price is left alone rather than invented", async () => {
    const { calls, fetchImpl } = recorder([QUEUED, { body: { items: [{ status: "Success" }] } }]);
    await push([{ stockCode: "A", salesPrice: 30 }], { fetchImpl, updates: "price" });
    // Defaulting it to the sale price would publish a nil discount the seller
    // never asked for — and Çiçeksepeti checks it against the last 30 days'
    // lowest price, which this side cannot know.
    expect(calls[0]!.body.items[0]).toEqual({ stockCode: "A", salesPrice: 30 });
  });

  test("a stock-only sync never sends a price the seller manages in the panel", async () => {
    const { calls, fetchImpl } = recorder([QUEUED, { body: { items: [{ status: "Success" }] } }]);
    await push([VARIANT], { fetchImpl, updates: "stock" });
    expect(calls[0]!.body.items[0]).toEqual({ stockCode: "TEDARIKCI-1", stockQuantity: 5 });
  });

  test("a negative stock is a mapping error, not an oversell to publish", async () => {
    const { calls, fetchImpl } = recorder([QUEUED, { body: { items: [{ status: "Success" }] } }]);
    await push([{ stockCode: "A", stockQuantity: -2 }], { fetchImpl, updates: "stock" });
    expect(calls[0]!.body.items[0].stockQuantity).toBe(0);
  });

  test("a batch addressing no listing never leaves the process", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(push([{ stockQuantity: 3 }], { fetchImpl })).rejects.toThrow(/variant code/);
    expect(calls).toHaveLength(0);
  });

  test("a warning is a success — it is about pricing law, not the request", async () => {
    const { fetchImpl } = recorder([
      QUEUED,
      { body: { items: [{ status: "Warning", failureReasons: [{ message: "son 30 günün en düşük fiyatı" }] }] } },
    ]);
    await push([VARIANT], { fetchImpl });
  });

  test("every item failed holds the watermark; one of many does not", async () => {
    const all = recorder([
      QUEUED,
      {
        body: {
          items: [
            { status: "Failed", failureReasons: [{ message: "Girmiş olduğunuz kod bulunmamaktadır" }] },
            { status: "Failed" },
          ],
        },
      },
    ]);
    await expect(push([VARIANT, { stockCode: "B", stockQuantity: 1 }], { fetchImpl: all.fetchImpl })).rejects.toThrow(
      /bulunmamaktadır/,
    );

    const some = recorder([QUEUED, { body: { items: [{ status: "Failed" }, { status: "Success" }] } }]);
    await push([VARIANT, { stockCode: "B", stockQuantity: 1 }], { fetchImpl: some.fetchImpl });
  });

  test("a batch still in the queue is not an answer", async () => {
    const { fetchImpl } = recorder([QUEUED, { body: { items: [{ status: "Pending" }, { status: "Failed" }] } }]);
    await push([VARIANT], { fetchImpl });
  });
});

// ── Tasks ────────────────────────────────────────────────────────────────────

const runTask = (
  task: string,
  opts: { fetchImpl: any; row?: Record<string, unknown>; settings?: Record<string, unknown> },
) =>
  runIntegrationTask(
    "ciceksepeti",
    task,
    {
      config: CONFIG,
      settings: { orderIdField: "marketplace_order_id", ...(opts.settings ?? {}) },
      row: opts.row ?? {
        id: "o1",
        marketplace_order_id: "123456789",
        tracking_number: "1700000004567",
        tracking_url: "https://track/1",
      },
      idempotencyKey: "run-1",
    },
    opts.fetchImpl,
  );

describe("moving an order through its statuses", () => {
  test("each transition is its own task, because the guard is keyed by task", () => {
    expect(INTEGRATION_TASKS.ciceksepeti?.map((t) => t.id)).toEqual([
      "mark_preparing",
      "mark_ready_to_ship",
      "mark_shipped",
      "mark_in_vehicle",
      "mark_delivered",
    ]);
    // None of them is a read, so none is repeatable — every one of these tells
    // the marketplace to email and text the customer.
    expect(INTEGRATION_TASKS.ciceksepeti?.some((t) => t.repeatable)).toBe(false);
  });

  test("a task finds its own sub-order ids and moves all of them", async () => {
    const { calls, fetchImpl } = recorder([
      orders([subOrder({ orderItemId: 987654321 }), subOrder({ orderItemId: 987654322 })]),
      { body: [{ orderItemId: 987654321, isSuccess: true }, { orderItemId: 987654322, isSuccess: true }] },
    ]);
    const result = await runTask("mark_preparing", { fetchImpl });

    // The row is an order; Çiçeksepeti moves sub-orders, and they live in the
    // child collection rather than on the row.
    expect(calls[0]!.body.orderNo).toBe(123456789);

    const update = calls[1]!;
    expect(update.method).toBe("PUT");
    expect(update.url.pathname).toBe("/api/v1/Order/statusupdatewithsupplierintegration");
    expect(update.body.orderItems).toEqual([
      { orderItemId: 987654321, orderItemStatusId: 2 },
      { orderItemId: 987654322, orderItemStatusId: 2 },
    ]);
    expect(result.outputs.statusId).toBe(2);
    expect(result.outputs.updatedItems).toBe(2);
  }, 20_000);

  test("shipping carries the courier and the tracking the customer is told about", async () => {
    const { calls, fetchImpl } = recorder([
      orders([subOrder()]),
      { body: [{ orderItemId: 987654321, isSuccess: true }] },
    ]);
    await runTask("mark_shipped", {
      fetchImpl,
      settings: {
        cargoCompany: "2",
        trackingNumberField: "tracking_number",
        trackingUrlField: "tracking_url",
      },
    });

    const item = calls[1]!.body.orderItems[0];
    expect(item.orderItemStatusId).toBe(5);
    expect(item.cargoBusinessId).toBe(2);
    expect(item.shipmentNumber).toBe("1700000004567");
    expect(item.shipmentTrackingUrl).toBe("https://track/1");
  }, 20_000);

  test("shipping without a courier is refused before the order is even read", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(
      runTask("mark_shipped", { fetchImpl, settings: { trackingNumberField: "tracking_number" } }),
    ).rejects.toThrow(/carrier/);
    // The order lookup costs a five-second token, so a step that cannot
    // possibly succeed must not spend one.
    expect(calls.length).toBeLessThanOrEqual(1);
  }, 20_000);

  test("every sub-order refused is not a partial success to report as done", async () => {
    const { fetchImpl } = recorder([
      orders([subOrder()]),
      { body: [{ orderItemId: 987654321, isSuccess: false, message: "Order not available for this status!" }] },
    ]);
    await expect(runTask("mark_preparing", { fetchImpl })).rejects.toThrow(/not available for this status/);
  }, 20_000);

  test("an order the seller does not have is named, not silently skipped", async () => {
    const { fetchImpl } = recorder([orders([])]);
    await expect(runTask("mark_preparing", { fetchImpl })).rejects.toThrow(/no order/);
  }, 20_000);

  test("an order id that is not one never reaches a query", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(
      runTask("mark_preparing", { fetchImpl, row: { id: "o1", marketplace_order_id: "12/../x" } }),
    ).rejects.toThrow(/numeric/);
    expect(calls).toHaveLength(0);
  });
});
