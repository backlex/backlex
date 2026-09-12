/**
 * Amazon Selling Partner API — the fifth marketplace, and the first outside
 * Türkiye. The three before it fitted one shape; this is the test of whether
 * that shape was Turkish or just marketplace-sized.
 *
 * What is left to prove is the part that is Amazon's alone: that a token is
 * minted before anything else happens, that the restricted token is asked for
 * and its refusal degrades rather than fails, that an order's lines are a
 * second request per order, and that a retry of the shipment confirmation
 * declares the SAME package rather than a second one.
 *
 * The pacing state is reset between tests on purpose. `getOrders` is limited to
 * one request a minute and takes its token from the same bucket the engine
 * uses, so a suite that left the bucket empty would stall for a minute — the
 * kind of thing that gets a real limit quietly deleted.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { INTEGRATION_TASKS, pullFromSource, resetThrottleState, runIntegrationTask } from "@backlex/integrations";

const CONFIG = {
  region: "eu",
  marketplaceId: "A33AVAJ2PDY3EV",
  sellerId: "A1B2C3D4E5F6G7",
  clientId: "amzn1.application-oa2-client.abc",
  clientSecret: "shhh",
  refreshToken: "Atzr|refresh",
};

const DAY_MS = 86_400_000;

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/**
 * A fake Amazon. Routed rather than sequential: the provider mints a token and
 * then a restricted token before it reads anything, so a positional list of
 * responses would be unreadable.
 */
const amazon = (opts: {
  orders?: unknown;
  items?: unknown;
  rdt?: { ok: boolean };
  token?: { ok: boolean };
  confirm?: { status?: number; body?: unknown };
  itemsStatus?: number;
} = {}) => {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const body = init?.body;
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof body === "string" && body.startsWith("{") ? JSON.parse(body) : body,
    });

    if (u.href === "https://api.amazon.com/auth/o2/token") {
      if (opts.token?.ok === false) return new Response("nope", { status: 400 });
      return new Response(JSON.stringify({ access_token: "Atza|access", expires_in: 3600 }));
    }
    if (u.pathname.endsWith("/restrictedDataToken")) {
      if (opts.rdt?.ok === false) return new Response(JSON.stringify({ errors: [{ message: "no role" }] }), { status: 403 });
      return new Response(JSON.stringify({ restrictedDataToken: "Atz.rdt|xyz", expiresIn: 3600 }));
    }
    if (u.pathname.endsWith("/orderItems")) {
      if (opts.itemsStatus) return new Response("boom", { status: opts.itemsStatus });
      return new Response(JSON.stringify(opts.items ?? { payload: { OrderItems: [ITEM] } }));
    }
    if (u.pathname.endsWith("/shipmentConfirmation")) {
      return new Response(JSON.stringify(opts.confirm?.body ?? {}), { status: opts.confirm?.status ?? 204 });
    }
    return new Response(JSON.stringify(opts.orders ?? { payload: { Orders: [] } }));
  };
  return { calls, fetchImpl };
};

const ORDER = {
  AmazonOrderId: "123-1234567-1234567",
  PurchaseDate: "2026-06-24T09:34:47Z",
  LastUpdateDate: "2026-06-25T10:00:00Z",
  OrderStatus: "Unshipped",
  FulfillmentChannel: "MFN",
  OrderTotal: { CurrencyCode: "TRY", Amount: "498.90" },
  NumberOfItemsShipped: 0,
  NumberOfItemsUnshipped: 2,
  IsPrime: true,
  BuyerInfo: { BuyerEmail: "buyer@marketplace.amazon.com", BuyerName: "Ahmet Aslan" },
  ShippingAddress: {
    Name: "Ahmet Aslan",
    AddressLine1: "Bağdat Cad. No 1",
    District: "Caferağa",
    City: "İstanbul",
    StateOrRegion: "Kadıköy",
    PostalCode: "34710",
    CountryCode: "TR",
    Phone: "5551112233",
  },
};

const ITEM = {
  OrderItemId: "58407439731080",
  ASIN: "B0TESTASIN",
  SellerSKU: "TEE-001-S-BLK",
  Title: "Klasik Tişört",
  QuantityOrdered: 2,
  QuantityShipped: 0,
  ItemPrice: { CurrencyCode: "TRY", Amount: "498.90" },
  ItemTax: { CurrencyCode: "TRY", Amount: "83.15" },
};

const pull = (opts: {
  fetchImpl: any;
  cursor?: string | null;
  settings?: Record<string, unknown>;
  config?: Record<string, unknown>;
}) =>
  pullFromSource(
    "amazon",
    {
      config: { ...CONFIG, ...(opts.config ?? {}) },
      settings: opts.settings ?? {},
      cursor: opts.cursor ?? null,
      limit: 100,
    },
    opts.fetchImpl,
  );

beforeEach(() => {
  resetThrottleState();
});

describe("pulling orders", () => {
  test("a token comes first, then a restricted token, then the orders", async () => {
    const { calls, fetchImpl } = amazon({ orders: { payload: { Orders: [ORDER] } } });
    await pull({ fetchImpl });

    expect(calls[0]!.url.href).toBe("https://api.amazon.com/auth/o2/token");
    expect(String(calls[0]!.body)).toContain("grant_type=refresh_token");

    // Buyer name and shipping address are restricted, and reading them needs a
    // token minted for this exact path and these exact elements.
    expect(calls[1]!.url.pathname).toBe("/tokens/2021-03-01/restrictedDataToken");
    expect(calls[1]!.body.restrictedResources[0]).toEqual({
      method: "GET",
      path: "/orders/v0/orders",
      dataElements: ["buyerInfo", "shippingAddress"],
    });

    const orders = calls[2]!;
    expect(orders.url.host).toBe("sellingpartnerapi-eu.amazon.com");
    expect(orders.url.pathname).toBe("/orders/v0/orders");
    // The restricted token is what the order read carries — not the plain one.
    expect(orders.headers["x-amz-access-token"]).toBe("Atz.rdt|xyz");
  }, 20_000);

  test("the window filters on last update, which is what makes this a mirror", async () => {
    const { calls, fetchImpl } = amazon();
    const before = Date.now();
    await pull({ fetchImpl });
    const after = Date.now();

    const orders = calls[calls.length - 1]!;
    const start = Date.parse(orders.url.searchParams.get("LastUpdatedAfter")!);
    const end = Date.parse(orders.url.searchParams.get("LastUpdatedBefore")!);
    // Not CreatedAfter: an order shipped a week after it was placed has to come
    // back into the window on the day it changes.
    expect(orders.url.searchParams.get("CreatedAfter")).toBeNull();
    expect(end - start).toBe(7 * DAY_MS);
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(after);
    expect(orders.url.searchParams.get("MarketplaceIds")).toBe("A33AVAJ2PDY3EV");
  }, 20_000);

  test("the page is capped well below the API's hundred, because lines are N+1", async () => {
    const { calls, fetchImpl } = amazon();
    await pull({ fetchImpl });
    expect(calls[calls.length - 1]!.url.searchParams.get("MaxResultsPerPage")).toBe("25");
  }, 20_000);

  test("a refused restricted token degrades to a redacted order, not a failed sync", async () => {
    const redacted = { ...ORDER, BuyerInfo: undefined, ShippingAddress: undefined };
    const { calls, fetchImpl } = amazon({ rdt: { ok: false }, orders: { payload: { Orders: [redacted] } } });
    const result = await pull({ fetchImpl });

    // A seller whose application has no PII role gets exactly what turning the
    // setting off would have given them: the sync runs, the columns are empty.
    expect(calls[2]!.headers["x-amz-access-token"]).toBe("Atza|access");
    expect(result.records[0]!.data.shipmentCity).toBeNull();
    expect(result.records).toHaveLength(1);
  }, 20_000);

  test("leaving it redacted asks for no restricted token at all", async () => {
    const { calls, fetchImpl } = amazon();
    await pull({ fetchImpl, settings: { buyerInfo: "skip" } });
    expect(calls.map((c) => c.url.pathname)).not.toContain("/tokens/2021-03-01/restrictedDataToken");
  }, 20_000);

  test("an order becomes a record whose lines came from a second request", async () => {
    const { calls, fetchImpl } = amazon({ orders: { payload: { Orders: [ORDER] } } });
    const result = await pull({ fetchImpl });

    const itemsCall = calls.find((c) => c.url.pathname.endsWith("/orderItems"))!;
    expect(itemsCall.url.pathname).toBe("/orders/v0/orders/123-1234567-1234567/orderItems");

    const record = result.records[0]!;
    expect(record.externalId).toBe("123-1234567-1234567");
    expect(record.data.status).toBe("Unshipped");
    // Amazon sends every amount as a STRING inside an envelope; a price stored
    // as text cannot be summed.
    expect(record.data.totalPrice).toBe(498.9);
    expect(record.data.currency).toBe("TRY");
    expect(record.data.buyerName).toBe("Ahmet Aslan");
    // il / ilçe / mahalle survive, under the names Amazon gives them.
    expect(record.data.shipmentCity).toBe("İstanbul");
    expect(record.data.shipmentStateOrRegion).toBe("Kadıköy");
    expect(record.data.shipmentDistrict).toBe("Caferağa");
    expect(record.data.shipmentCountryCode).toBe("TR");

    const lines = record.children!.lines!;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.externalId).toBe("58407439731080");
    expect(lines[0]!.data.sellerSku).toBe("TEE-001-S-BLK");
    expect(lines[0]!.data.itemPrice).toBe(498.9);
    expect(lines[0]!.data.quantityOrdered).toBe(2);
  }, 20_000);

  test("an order with more lines than one page keeps reading them", async () => {
    let seen = 0;
    const { fetchImpl } = amazon();
    const routed = async (url: string, init?: RequestInit) => {
      if (url.includes("/orderItems")) {
        seen += 1;
        return new Response(
          JSON.stringify(
            seen === 1
              ? { payload: { OrderItems: [ITEM], NextToken: "more" } }
              : { payload: { OrderItems: [{ ...ITEM, OrderItemId: "58407439731081" }] } },
          ),
        );
      }
      return fetchImpl(url, init);
    };
    const result = await pull({
      fetchImpl: async (u: string, i?: RequestInit) =>
        u.includes("/orders/v0/orders?") || u.endsWith("/orders")
          ? new Response(JSON.stringify({ payload: { Orders: [ORDER] } }))
          : routed(u, i),
    });
    // Half an order's lines is worse than none.
    expect(result.records[0]!.children!.lines).toHaveLength(2);
  }, 20_000);

  test("more pages continue THIS run; the last page starts the next one", async () => {
    const { fetchImpl } = amazon({
      orders: { payload: { Orders: [], NextToken: "opaque-1" } },
    });
    const first = await pull({ fetchImpl });
    expect(first.cursor).toStartWith("c:");
    expect(first.cursor).toEndWith(":opaque-1");
    // A page cursor is not a resume marker: returning one as the other would
    // either loop forever or throw the window away.
    expect(first.resumeToken).toBeUndefined();

    const done = amazon({ orders: { payload: { Orders: [] } } });
    const second = await pull({ fetchImpl: done.fetchImpl, cursor: first.cursor });
    expect(second.cursor).toBeNull();
    const windowEnd = first.cursor!.slice(2).split(":")[0];
    expect(second.resumeToken).toBe(`t:${windowEnd}`);

    // Amazon refuses a page whose filters changed mid-walk, so the follow-on
    // request carries the token and no dates.
    const followOn = done.calls[done.calls.length - 1]!;
    expect(followOn.url.searchParams.get("NextToken")).toBe("opaque-1");
    expect(followOn.url.searchParams.get("LastUpdatedAfter")).toBeNull();
  }, 30_000);

  test("a backfill advances one window at a time instead of asking for everything", async () => {
    const start = Date.now() - 200 * DAY_MS;
    const { calls, fetchImpl } = amazon();
    const result = await pull({ fetchImpl, cursor: `t:${start}` });
    const orders = calls[calls.length - 1]!;
    expect(Date.parse(orders.url.searchParams.get("LastUpdatedBefore")!) - start).toBe(30 * DAY_MS);
    expect(result.resumeToken).toBe(`t:${start + 30 * DAY_MS}`);
  }, 20_000);

  test("a bad refresh token is named without quoting the exchange back", async () => {
    const { fetchImpl } = amazon({ token: { ok: false } });
    // That response can echo the request, and this is the one call in the file
    // whose body holds the client secret.
    await expect(pull({ fetchImpl })).rejects.toThrow(/client id, secret and refresh token/);
    await expect(pull({ fetchImpl })).rejects.not.toThrow(/shhh/);
  }, 20_000);

  test("a marketplace outside the published set never reaches a query", async () => {
    const { calls, fetchImpl } = amazon();
    await expect(pull({ fetchImpl, config: { marketplaceId: "NOPE" } })).rejects.toThrow(/marketplace/);
    expect(calls).toHaveLength(0);
  });

  test("a seller id that could shape a URL never reaches one", async () => {
    const { calls, fetchImpl } = amazon();
    await expect(pull({ fetchImpl, config: { sellerId: "../../etc" } })).rejects.toThrow(/merchant token/);
    expect(calls).toHaveLength(0);
  });
});

// ── Tasks ────────────────────────────────────────────────────────────────────

const runTask = (opts: {
  fetchImpl: any;
  row?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  idempotencyKey?: string;
}) =>
  runIntegrationTask(
    "amazon",
    "confirm_shipment",
    {
      config: CONFIG,
      settings: {
        orderIdField: "marketplace_order_id",
        carrierCodeField: "carrier_code",
        trackingNumberField: "tracking_number",
        ...(opts.settings ?? {}),
      },
      row: opts.row ?? {
        id: "o1",
        marketplace_order_id: "123-1234567-1234567",
        carrier_code: "Yurtici",
        tracking_number: "176162533695",
      },
      idempotencyKey: opts.idempotencyKey ?? "run-1:abc",
    },
    opts.fetchImpl,
  );

describe("confirming a shipment", () => {
  test("there is one task, and it is not repeatable", () => {
    expect(INTEGRATION_TASKS.amazon?.map((t) => t.id)).toEqual(["confirm_shipment"]);
    // Confirming twice is telling a marketplace twice, and Amazon answers the
    // second one with an error the operator did not cause.
    expect(INTEGRATION_TASKS.amazon?.some((t) => t.repeatable)).toBe(false);
  });

  test("the task reads the order's lines and confirms every one of them", async () => {
    const { calls, fetchImpl } = amazon();
    const result = await runTask({ fetchImpl });

    const confirm = calls.find((c) => c.url.pathname.endsWith("/shipmentConfirmation"))!;
    expect(confirm.method).toBe("POST");
    expect(confirm.url.pathname).toBe("/orders/v0/orders/123-1234567-1234567/shipmentConfirmation");
    expect(confirm.body.marketplaceId).toBe("A33AVAJ2PDY3EV");
    expect(confirm.body.packageDetail.carrierCode).toBe("Yurtici");
    expect(confirm.body.packageDetail.trackingNumber).toBe("176162533695");
    // An id and a quantity per line — which is why the task looks them up
    // rather than asking an operator to keep a list in a column.
    expect(confirm.body.packageDetail.orderItems).toEqual([{ orderItemId: "58407439731080", quantity: 2 }]);
    expect(result.outputs.confirmedItems).toBe(1);
    expect(result.outputs.status).toBe("Shipped");
  }, 20_000);

  test("a retry declares the SAME package rather than a second one", async () => {
    const a = amazon();
    const b = amazon();
    await runTask({ fetchImpl: a.fetchImpl, idempotencyKey: "run-1:abc" });
    await runTask({ fetchImpl: b.fetchImpl, idempotencyKey: "run-1:abc" });

    const ref = (c: typeof a) =>
      c.calls.find((x) => x.url.pathname.endsWith("/shipmentConfirmation"))!.body.packageDetail
        .packageReferenceId;
    expect(ref(a)).toBe(ref(b));
    // Reduced to what Amazon accepts, and never empty.
    expect(ref(a)).toMatch(/^[A-Za-z0-9]{1,32}$/);
  }, 20_000);

  test("a missing tracking number is named before a paced request is spent", async () => {
    const { calls, fetchImpl } = amazon();
    await expect(
      runTask({ fetchImpl, row: { id: "o1", marketplace_order_id: "123-1234567-1234567", carrier_code: "X" } }),
    ).rejects.toThrow(/tracking number/);
    expect(calls).toHaveLength(0);
  });

  test("an order id that is not one never reaches a URL", async () => {
    const { calls, fetchImpl } = amazon();
    await expect(
      runTask({ fetchImpl, row: { id: "o1", marketplace_order_id: "123/../x", carrier_code: "X", tracking_number: "1" } }),
    ).rejects.toThrow(/123-1234567-1234567/);
    expect(calls).toHaveLength(0);
  });

  test("an order with no line to confirm says so", async () => {
    const { fetchImpl } = amazon({ items: { payload: { OrderItems: [] } } });
    await expect(runTask({ fetchImpl })).rejects.toThrow(/no line to confirm/);
  }, 20_000);

  test("a refusal names the roles rather than the status code alone", async () => {
    const { fetchImpl } = amazon({ itemsStatus: 403 });
    await expect(runTask({ fetchImpl })).rejects.toThrow(/authorized for this seller/);
  }, 20_000);
});
