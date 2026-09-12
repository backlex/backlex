/**
 * Hepsiburada — the second marketplace, and the test that says what phase 4 was
 * for: whether a marketplace is one file now.
 *
 * The engine's own specs already prove the machinery — children are qualified
 * by their parent, a task runs once, a 429 stays out of the breaker. What is
 * left to prove is the part that is Hepsiburada's and cannot be read off the
 * descriptor:
 *
 * - the window does NOT advance between runs, because `begindate` filters on
 *   creation and a marching watermark would freeze every package at the status
 *   it was born with;
 * - a flat list of line items becomes one record per order;
 * - the two hosts are one connection;
 * - stock and price are two uploads, and "both" means both.
 */
import { describe, expect, test } from "bun:test";
import {
  destinationColumnsFor,
  INTEGRATION_TASKS,
  pullFromSource,
  pushToDestination,
  runIntegrationTask,
} from "@backlex/integrations";

const MERCHANT = "b2910839-83b9-4d45-adb6-86bad457edcb";

const CONFIG = {
  merchantId: MERCHANT,
  username: "user",
  password: "pass",
  environment: "production",
};

const DAY_MS = 86_400_000;

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** A fake Hepsiburada that records every call and answers as told. */
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
  limit?: number;
}) =>
  pullFromSource(
    "hepsiburada",
    {
      config: { ...CONFIG, ...(opts.config ?? {}) },
      settings: opts.settings ?? {},
      cursor: opts.cursor ?? null,
      limit: opts.limit ?? 100,
    },
    opts.fetchImpl,
  );

const PACKAGE = {
  id: "5ef25338-dffc-2c00-01d8-dc1706060606",
  packageNumber: "013105889",
  barcode: "6220131054891",
  status: "Packaged",
  orderDate: "2026-06-24T09:34:47",
  dueDate: "2026-06-26T15:00:00",
  cargoCompany: "Yurtiçi Kargo",
  customerName: "Ahmet Aslan",
  recipientName: "Ahmet Aslan",
  email: "ahmet@example.com",
  phoneNumber: "905079628210",
  totalPrice: { amount: 498.9, currency: "TRY" },
  shippingAddressDetail: "Serik caddesi bülbül sokak no 37",
  shippingDistrict: "MEHMET AKİF",
  shippingTown: "ÜMRANİYE",
  shippingCity: "İstanbul",
  shippingCountryCode: "TR",
  billingCity: "İstanbul",
  taxNumber: "1234567890",
  items: [
    {
      lineItemId: "5ef25338-dffc-2c00-01d8-dc1706060607",
      orderNumber: "041241341",
      hbSku: "HBV00000NE0YY",
      merchantSku: "TEE-001-S-BLK",
      productName: "Klasik Tişört",
      productBarcode: "8683772071724",
      quantity: 2,
      price: { amount: 249.45, currency: "TRY" },
      totalPrice: { amount: 498.9, currency: "TRY" },
      vatRate: 20,
    },
    { lineItemId: "5ef25338-dffc-2c00-01d8-dc1706060608", quantity: 1, productName: "Çanta" },
  ],
};

/** One line item, as the `orders` feed returns them: flat, one per line. */
const line = (over: Record<string, unknown> = {}) => ({
  id: "line-1",
  orderNumber: "041241341",
  orderDate: "2026-06-24T09:34:47",
  status: "Open",
  sku: "HBV00000NE0YY",
  merchantSKU: "TEE-001-S-BLK",
  name: "Klasik Tişört",
  quantity: 1,
  unitPrice: { amount: 14.95, currency: "TRY" },
  totalPrice: { amount: 14.95, currency: "TRY" },
  cargoCompanyModel: { name: "Yurtiçi Kargo", shortName: "YK", trackingUrl: "https://track/1" },
  shippingAddress: {
    name: "Ahmet Aslan",
    address: "Serik caddesi bülbül sokak no 37",
    district: "MEHMET AKİF",
    town: "ÜMRANİYE",
    city: "İstanbul",
    countryCode: "TR",
    phoneNumber: "905079628210",
  },
  invoice: { taxNumber: "1234567890", address: { name: "Ahmet Aslan", city: "İstanbul" } },
  ...over,
});

describe("mirroring the order feeds", () => {
  test("the default feed is packages, read over a rolling window, on the production host", async () => {
    const { calls, fetchImpl } = recorder([{ body: [PACKAGE] }]);
    const before = Date.now();
    await pull({ fetchImpl });
    const after = Date.now();

    const call = calls[0]!;
    expect(call.url.host).toBe("oms-external.hepsiburada.com");
    expect(call.url.pathname).toBe(`/packages/merchantid/${MERCHANT}`);

    const start = Date.parse(call.url.searchParams.get("begindate")!);
    const end = Date.parse(call.url.searchParams.get("enddate")!);
    expect(end - start).toBe(7 * DAY_MS);
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(after);

    expect(call.headers.Authorization).toBe(`Basic ${btoa("user:pass")}`);
    // Documented as required on every operation — a request without it is
    // refused even when the credentials are right.
    expect(call.headers["User-Agent"]).toBe(`${MERCHANT} - backlex`);
  });

  test("the test environment is the other pair of hosts, not a flag on one", async () => {
    const { calls, fetchImpl } = recorder([{ body: [] }]);
    await pull({ fetchImpl, config: { environment: "test" } });
    expect(calls[0]!.url.host).toBe("oms-external-sit.hepsiburada.com");
  });

  test("the packages feed is capped at the ten the docs allow, whatever the engine asks for", async () => {
    const { calls, fetchImpl } = recorder([{ body: [] }]);
    await pull({ fetchImpl, limit: 200 });
    expect(calls[0]!.url.searchParams.get("limit")).toBe("10");
  });

  test("a package becomes a record with its lines as children", async () => {
    const { fetchImpl } = recorder([{ body: [PACKAGE] }]);
    const page = await pull({ fetchImpl });

    const record = page.records[0]!;
    expect(record.externalId).toBe("013105889");
    expect(record.data.status).toBe("Packaged");
    expect(record.data.totalPrice).toBe(498.9);
    expect(record.data.currency).toBe("TRY");
    // il / ilçe / mahalle all survive, and under the names Hepsiburada uses:
    // `town` is the ilçe and `district` the mahalle, which is the opposite of
    // what the English words suggest.
    expect(record.data.shippingCity).toBe("İstanbul");
    expect(record.data.shippingTown).toBe("ÜMRANİYE");
    expect(record.data.shippingDistrict).toBe("MEHMET AKİF");
    expect(record.data.shippingCountryCode).toBe("TR");

    const lines = record.children!.lines!;
    expect(lines).toHaveLength(2);
    expect(lines[0]!.externalId).toBe("5ef25338-dffc-2c00-01d8-dc1706060607");
    expect(lines[0]!.data.quantity).toBe(2);
    expect(lines[0]!.data.unitPrice).toBe(249.45);
    expect(lines[0]!.data.merchantSku).toBe("TEE-001-S-BLK");
  });

  test("a line with no id is dropped rather than colliding on one key", async () => {
    const { fetchImpl } = recorder([
      { body: [{ ...PACKAGE, items: [{ quantity: 1 }, PACKAGE.items[0]] }] },
    ]);
    const page = await pull({ fetchImpl });
    expect(page.records[0]!.children!.lines).toHaveLength(1);
  });

  test("the run walks by offset and stops when the page comes up short", async () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ ...PACKAGE, packageNumber: `p${i}` }));
    const { calls, fetchImpl } = recorder([{ body: full }, { body: [PACKAGE] }]);

    const first = await pull({ fetchImpl });
    expect(first.cursor).toBe("10");
    // The window does not advance between runs, so there is deliberately no
    // resume marker: `begindate` filters on creation, and a run that started
    // where the last one finished would see every package exactly once — in
    // whatever status it was created with — and never learn that it shipped.
    expect(first.resumeToken).toBeUndefined();

    const second = await pull({ fetchImpl, cursor: first.cursor });
    expect(calls[1]!.url.searchParams.get("offset")).toBe("10");
    expect(second.cursor).toBeNull();
    expect(second.resumeToken).toBeUndefined();
  });

  test("an empty page ends the walk instead of asking again for ever", async () => {
    const { fetchImpl } = recorder([{ body: [] }]);
    expect((await pull({ fetchImpl })).cursor).toBeNull();
  });

  test("a nonsense cursor restarts the walk rather than skipping into nowhere", async () => {
    const { calls, fetchImpl } = recorder([{ body: [] }]);
    await pull({ fetchImpl, cursor: "not-a-number" });
    expect(calls[0]!.url.searchParams.get("offset")).toBe("0");
  });

  test("the orders feed groups a flat list of lines into one record per order", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          totalCount: 3,
          items: [
            line({ id: "line-1" }),
            line({ id: "line-2", name: "Çanta" }),
            line({ id: "line-3", orderNumber: "041241999" }),
          ],
        },
      },
    ]);
    const page = await pull({ fetchImpl, settings: { feed: "orders" } });

    expect(calls[0]!.url.pathname).toBe(`/orders/merchantid/${MERCHANT}`);
    expect(page.records).toHaveLength(2);

    const order = page.records.find((r) => r.externalId === "041241341")!;
    // The header is per-order data repeated on every line, so any line carries
    // it — but the LINES must all land, which is the point of the grouping.
    expect(order.data.shippingCity).toBe("İstanbul");
    expect(order.data.cargoCompany).toBe("Yurtiçi Kargo");
    expect(order.data.taxNumber).toBe("1234567890");
    expect(order.children!.lines).toHaveLength(2);
    expect(order.children!.lines!.map((l) => l.externalId)).toEqual(["line-1", "line-2"]);
    expect(order.children!.lines![0]!.data.merchantSku).toBe("TEE-001-S-BLK");
  });

  test("the paged feeds end on the total, not on a page shorter than asked for", async () => {
    // Three lines came back for a limit of 100 — a short page. The walk must
    // continue anyway, because `totalCount` says there are more and only the
    // packages feed publishes a cap this could be measured against.
    const { fetchImpl } = recorder([{ body: { totalCount: 40, items: [line()] } }]);
    const page = await pull({ fetchImpl, settings: { feed: "orders" } });
    expect(page.cursor).toBe("1");
  });

  test("the cancelled feed writes only what it actually says", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          totalCount: 1,
          items: [
            {
              lineItemId: "line-9",
              orderNumber: "041241341",
              sku: "HBV00000NE0YY",
              merchantSku: "TEE-001-S-BLK",
              quantity: 1,
              cancelDate: "2026-06-25T10:00:00",
              cancelledBy: "Customer",
              cancelReasonCode: "17",
            },
          ],
        },
      },
    ]);
    const page = await pull({ fetchImpl, settings: { feed: "cancelled" } });

    expect(calls[0]!.url.pathname).toBe(`/orders/merchantid/${MERCHANT}/cancelled`);
    const record = page.records[0]!;
    expect(record.data.status).toBe("Cancelled");
    expect(record.data.cancelledBy).toBe("Customer");
    // A cancelled line carries no address and no prices. Mapping them as null
    // anyway would write emptiness over the order the `orders` feed filled in.
    expect(record.data).not.toHaveProperty("shippingCity");
    expect(record.children!.lines![0]!.externalId).toBe("line-9");
  });

  test("rejected credentials name the three things that could be wrong", async () => {
    const { fetchImpl } = recorder([{ status: 401, body: "unauthorized" }]);
    await expect(pull({ fetchImpl })).rejects.toThrow(/username, password and merchant id/);
  });

  test("a merchant id that is not a GUID never reaches a URL", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(pull({ fetchImpl, config: { merchantId: "../../etc/passwd" } })).rejects.toThrow(/GUID/);
    expect(calls).toHaveLength(0);
  });
});

// ── Stock and price ──────────────────────────────────────────────────────────

const push = (rows: Record<string, unknown>[], opts: { fetchImpl: any; updates?: string }) =>
  pushToDestination(
    "hepsiburada",
    {
      config: CONFIG,
      settings: { updates: opts.updates ?? "both" },
      rows,
      columns: {
        hepsiburadaSku: "text",
        merchantSku: "text",
        availableStock: "number",
        price: "number",
      },
      syncKey: "sync-a",
    },
    opts.fetchImpl,
  );

const VARIANT = { hepsiburadaSku: "HBV00000NE0YY", merchantSku: "TEE-001", availableStock: 7, price: 249.45 };

describe("pushing stock and price", () => {
  test("the columns on offer follow what the sync says it sends", () => {
    expect(destinationColumnsFor("hepsiburada", { updates: "stock" })?.map((c) => c.value)).toEqual([
      "hepsiburadaSku",
      "merchantSku",
      "availableStock",
      "maximumPurchasableQuantity",
    ]);
    expect(destinationColumnsFor("hepsiburada", { updates: "price" })?.map((c) => c.value)).toEqual([
      "hepsiburadaSku",
      "merchantSku",
      "price",
    ]);
    expect(destinationColumnsFor("hepsiburada", { updates: "both" })).toHaveLength(5);
  });

  test("both means two uploads against the listing host, each verified", async () => {
    const { calls, fetchImpl } = recorder([
      { body: { id: "up-1" } },
      { body: { status: "Done", total: 1, errors: [] } },
      { body: { id: "up-2" } },
      { body: { status: "Done", total: 1, errors: [] } },
    ]);
    await push([VARIANT], { fetchImpl });

    expect(calls[0]!.url.host).toBe("listing-external.hepsiburada.com");
    expect(calls[0]!.url.pathname).toBe(`/listings/merchantid/${MERCHANT}/stock-uploads`);
    expect(calls[0]!.body).toEqual([
      { hepsiburadaSku: "HBV00000NE0YY", merchantSku: "TEE-001", availableStock: 7 },
    ]);
    expect(calls[1]!.url.pathname).toBe(`/listings/merchantid/${MERCHANT}/stock-uploads/id/up-1`);
    expect(calls[2]!.url.pathname).toBe(`/listings/merchantid/${MERCHANT}/price-uploads`);
    expect(calls[2]!.body).toEqual([
      { hepsiburadaSku: "HBV00000NE0YY", merchantSku: "TEE-001", price: 249.45 },
    ]);
  });

  test("a stock-only sync never sends a price the seller manages in the panel", async () => {
    const { calls, fetchImpl } = recorder([{ body: { id: "up-1" } }, { body: { total: 1, errors: [] } }]);
    await push([VARIANT], { fetchImpl, updates: "stock" });
    expect(calls.map((c) => c.url.pathname)).not.toContain(`/listings/merchantid/${MERCHANT}/price-uploads`);
  });

  test("either identifier addresses a listing; neither addresses nothing", async () => {
    const { calls, fetchImpl } = recorder([{ body: { id: "up-1" } }, { body: { total: 1, errors: [] } }]);
    await push([{ merchantSku: "TEE-001", availableStock: 3 }], { fetchImpl, updates: "stock" });
    expect(calls[0]!.body).toEqual([{ merchantSku: "TEE-001", availableStock: 3 }]);

    const bare = recorder([]);
    await expect(push([{ availableStock: 3 }], { fetchImpl: bare.fetchImpl })).rejects.toThrow(/SKU/);
    expect(bare.calls).toHaveLength(0);
  });

  test("a negative stock is a mapping error, not an oversell to publish", async () => {
    const { calls, fetchImpl } = recorder([{ body: { id: "up-1" } }, { body: { total: 1, errors: [] } }]);
    await push([{ merchantSku: "TEE-001", availableStock: -4 }], { fetchImpl, updates: "stock" });
    expect(calls[0]!.body[0].availableStock).toBe(0);
  });

  test("every item refused holds the watermark; one of many does not", async () => {
    const all = recorder([
      { body: { id: "up-1" } },
      { body: { status: "Done", total: 2, errors: [{ message: "listing not found" }, { message: "x" }] } },
    ]);
    await expect(
      push([VARIANT, { merchantSku: "B", availableStock: 1 }], { fetchImpl: all.fetchImpl, updates: "stock" }),
    ).rejects.toThrow(/refused every stock item/);

    // One archived listing among two would otherwise hold the watermark on its
    // row for ever and the sync would never reach the rows behind it.
    const some = recorder([
      { body: { id: "up-2" } },
      { body: { status: "Done", total: 2, errors: [{ message: "listing not found" }] } },
    ]);
    await push([VARIANT, { merchantSku: "B", availableStock: 1 }], {
      fetchImpl: some.fetchImpl,
      updates: "stock",
    });
  });

  test("an upload whose result cannot be read is not re-sent", async () => {
    const { fetchImpl } = recorder([{ body: { id: "up-1" } }, { status: 500, body: "nope" }]);
    await push([VARIANT], { fetchImpl, updates: "stock" });
  });
});

// ── Tasks ────────────────────────────────────────────────────────────────────

const runTask = (
  task: string,
  opts: { fetchImpl: any; row?: Record<string, unknown>; settings?: Record<string, unknown> },
) =>
  runIntegrationTask(
    "hepsiburada",
    task,
    {
      config: CONFIG,
      settings: { packageNumberField: "package_number", ...(opts.settings ?? {}) },
      row: opts.row ?? { id: "o1", package_number: "013105889", tracking_number: "176162533695" },
      idempotencyKey: "run-1",
    },
    opts.fetchImpl,
  );

describe("notifying fulfilment", () => {
  test("each move is its own task, because the guard is keyed by task", () => {
    // A single set-status task would notify "in transit" and then refuse to
    // notify "delivered", handing back the first run's answer instead.
    expect(INTEGRATION_TASKS.hepsiburada?.map((t) => t.id)).toEqual([
      "mark_intransit",
      "mark_delivered",
      "mark_undelivered",
      "send_invoice_link",
      "get_label",
      "refresh_package",
    ]);
  });

  test("shipping carries the tracking number off the row", async () => {
    const { calls, fetchImpl } = recorder();
    const result = await runTask("mark_intransit", { fetchImpl, settings: { trackingNumberField: "tracking_number" } });

    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe(
      `/packages/merchantid/${MERCHANT}/packagenumber/013105889/intransit`,
    );
    expect(call.body.trackingNumber).toBe("176162533695");
    expect(typeof call.body.shippedDate).toBe("string");
    // Not sent at all rather than sent null: an omitted field is left alone.
    expect(call.body).not.toHaveProperty("trackingUrl");
    expect(result.outputs.status).toBe("InTransit");
    expect(typeof result.outputs.shippedAt).toBe("number");
  });

  test("a package number that is not one never reaches a URL", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(
      runTask("mark_intransit", {
        fetchImpl,
        row: { id: "o1", package_number: "013105889/../../x", tracking_number: "1" },
        settings: { trackingNumberField: "tracking_number" },
      }),
    ).rejects.toThrow(/package number/);
    expect(calls).toHaveLength(0);
  });

  test("a missing tracking number is named, not sent as empty", async () => {
    const { calls, fetchImpl } = recorder([]);
    await expect(
      runTask("mark_intransit", {
        fetchImpl,
        row: { id: "o1", package_number: "013105889" },
        settings: { trackingNumberField: "tracking_number" },
      }),
    ).rejects.toThrow(/tracking number/);
    expect(calls).toHaveLength(0);
  });

  test("the invoice link goes as a PUT, with the date it was sent", async () => {
    const { calls, fetchImpl } = recorder();
    await runTask("send_invoice_link", {
      fetchImpl,
      row: { id: "o1", package_number: "013105889", invoice_url: "https://inv/1.pdf" },
      settings: { invoiceLinkField: "invoice_url" },
    });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url.pathname).toBe(`/packages/merchantid/${MERCHANT}/packagenumber/013105889/invoice`);
    expect(calls[0]!.body.invoiceLink).toBe("https://inv/1.pdf");
  });

  test("the barcode is handed over verbatim rather than guessed at", async () => {
    const { calls, fetchImpl } = recorder([{ body: { format: "ZPL", data: ["^XA", "^XZ"] } }]);
    const result = await runTask("get_label", { fetchImpl, settings: { format: "ZPL" } });

    expect(calls[0]!.url.searchParams.get("format")).toBe("ZPL");
    expect(result.outputs.labelFormat).toBe("ZPL");
    // `BarcodeData.data` is documented as strings and its ENCODING is not part
    // of the contract, so it is stored as text instead of being called a PDF.
    expect(result.outputs.labelData).toBe("^XA\n^XZ");
    expect(result.outputs.labelCount).toBe(2);
  });

  test("no barcode is an error, not an empty column", async () => {
    const { fetchImpl } = recorder([{ body: { format: "ZPL", data: [] } }]);
    await expect(runTask("get_label", { fetchImpl })).rejects.toThrow(/no barcode/);
  });

  test("only the read is repeatable", () => {
    const tasks = INTEGRATION_TASKS.hepsiburada ?? [];
    expect(tasks.filter((t) => t.repeatable).map((t) => t.id)).toEqual(["refresh_package"]);
  });

  test("refreshing reads where the package is without changing it", async () => {
    const { calls, fetchImpl } = recorder([
      {
        body: {
          packageNumber: "013105889",
          status: "InTransit",
          trackingInfoCode: "176162533695",
          trackingInfoUrl: "https://track/1",
          cargoCompany: "Yurtiçi Kargo",
          barcode: "6220131054891",
          estimatedArrivalDate: "2026-06-27T10:00:00Z",
        },
      },
    ]);
    const result = await runTask("refresh_package", { fetchImpl });

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe(`/packages/merchantid/${MERCHANT}/packagenumber/013105889`);
    expect(result.outputs.status).toBe("InTransit");
    expect(result.outputs.trackingNumber).toBe("176162533695");
    expect(result.outputs.estimatedDeliveryAt).toBe(Date.parse("2026-06-27T10:00:00Z"));
  });
});
