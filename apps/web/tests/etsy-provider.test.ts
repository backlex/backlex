/**
 * Etsy — orders in, stock and price out, a tracking number back.
 *
 * Every shape asserted here was read out of Etsy's published OpenAPI 3.0.2
 * (`etsy.com/openapi/generated/oas/3.0.0.json`, 76 paths, served to a plain
 * GET). The roadmap had Etsy filed under "waiting on account approval" from a
 * probe that got a 403 — a seller account is needed to make live calls, not to
 * know what a call looks like.
 *
 * Three of the assertions below are about things that are quietly wrong if you
 * reason from other marketplaces instead of from the spec:
 *
 *   - Etsy's timestamps are epoch SECONDS. Sending milliseconds asks for orders
 *     from the year 57000 and gets an empty list rather than an error.
 *   - money is `{amount, divisor}` on the way out and a plain decimal on the
 *     way back in.
 *   - the inventory PUT REPLACES the whole listing, so a row that names only a
 *     listing has to say whether it means every variation on it.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  INTEGRATION_KINDS,
  INTEGRATION_TASKS,
  resetThrottleState,
  runIntegrationTask,
  pullFromSource,
  pushToDestination,
} from "@backlex/integrations";

const CONFIG = {
  clientId: "keystring-1",
  clientSecret: "shh",
  shopId: "12345",
  _oauthAccessToken: "tok-1",
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const recorder = (responses: Array<{ status?: number; json: unknown }>) => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    const next = responses[i++] ?? { json: {} };
    return new Response(JSON.stringify(next.json), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const receipt = (over: Record<string, unknown> = {}) => ({
  receipt_id: 9001,
  status: "Paid",
  name: "Jane Doe",
  buyer_email: "jane@example.test",
  first_line: "10 Downing Street",
  city: "London",
  zip: "SW1A 2AA",
  country_iso: "GB",
  is_paid: true,
  is_shipped: false,
  // Minor units with an explicit divisor — not a fixed two decimals.
  grandtotal: { amount: 2599, divisor: 100, currency_code: "GBP" },
  created_timestamp: 1786000000,
  updated_timestamp: 1786000500,
  transactions: [
    {
      transaction_id: 5001,
      listing_id: 777,
      product_id: 888,
      sku: "MUG-BLUE",
      title: "Blue mug",
      quantity: 2,
      price: { amount: 1200, divisor: 100, currency_code: "GBP" },
    },
  ],
  ...over,
});

beforeEach(() => resetThrottleState());

describe("registration", () => {
  test("it is a marketplace with all three halves", () => {
    expect(INTEGRATION_KINDS).toContain("etsy");
    expect(INTEGRATION_TASKS.etsy?.map((t) => t.id)).toEqual(["submit_tracking"]);
  });

  test("submitting tracking does not repeat — it emails the buyer", () => {
    expect(INTEGRATION_TASKS.etsy?.some((t) => t.repeatable)).toBe(false);
  });
});

describe("reading orders", () => {
  const pull = (fetchImpl: typeof fetch, settings: Record<string, unknown> = {}, cursor: string | null = null) =>
    pullFromSource("etsy", { config: CONFIG, settings, cursor, limit: 200, connectionKey: "c1" }, fetchImpl);

  test("both credentials go on the request, and one is the client id", async () => {
    // Etsy wants a bearer token AND `x-api-key`, and the key is the app's
    // keystring — the same string as the OAuth client id.
    const { calls, fetchImpl } = recorder([{ json: { count: 1, results: [receipt()] } }]);
    await pull(fetchImpl);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-1");
    expect(calls[0]!.headers["x-api-key"]).toBe("keystring-1");
  });

  test("the window is sent in SECONDS", async () => {
    // Milliseconds would ask for orders from the year 57000 and come back
    // empty, with no error to notice.
    const { calls, fetchImpl } = recorder([{ json: { count: 0, results: [] } }]);
    await pull(fetchImpl);
    const since = Number(new URL(calls[0]!.url).searchParams.get("min_last_modified"));
    const now = Math.floor(Date.now() / 1000);
    expect(since).toBeLessThanOrEqual(now);
    expect(since).toBeGreaterThan(now - 40 * 86_400);
  });

  test("money comes back as a decimal, not minor units", async () => {
    const { fetchImpl } = recorder([{ json: { count: 1, results: [receipt()] } }]);
    const out = await pull(fetchImpl);
    expect(out.records[0]!.data.total).toBe(25.99);
    expect(out.records[0]!.data.currency).toBe("GBP");
  });

  test("transactions ride along as child rows — no second call", async () => {
    // Unlike bol.com, whose order list carries no address and forces an N+1.
    const { calls, fetchImpl } = recorder([{ json: { count: 1, results: [receipt()] } }]);
    const out = await pull(fetchImpl);
    expect(calls).toHaveLength(1);
    const lines = out.records[0]!.children!.lines!;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.data).toMatchObject({ sku: "MUG-BLUE", quantity: 2, price: 12 });
  });

  test("`unshipped` narrows to paid-but-not-shipped", async () => {
    const { calls, fetchImpl } = recorder([{ json: { count: 0, results: [] } }]);
    await pull(fetchImpl, { which: "unshipped" });
    const q = new URL(calls[0]!.url).searchParams;
    expect(q.get("was_paid")).toBe("true");
    expect(q.get("was_shipped")).toBe("false");
  });

  test("paging uses the reported count, not a short-page guess", async () => {
    // Etsy returns the total, so "is there more" is answerable exactly.
    const { fetchImpl } = recorder([{ json: { count: 120, results: [receipt()] } }]);
    const out = await pull(fetchImpl);
    expect(out.cursor).not.toBeNull();
    expect(out.cursor).toMatch(/:1$/);

    const last = recorder([{ json: { count: 1, results: [receipt()] } }]);
    const done = await pull(last.fetchImpl);
    // The engine's only end-of-run signal is `cursor === null` (see
    // `integration-syncs.ts`). This provider ALSO returns `complete` and
    // `resumeAt`, and `SourcePullPage` declares neither — so both are inert.
    expect(done.cursor).toBeNull();
    expect(done.cursor).toBeNull();
  });

  test("a bad shop id is refused before the call", async () => {
    const { calls, fetchImpl } = recorder([{ json: {} }]);
    await expect(
      pullFromSource(
        "etsy",
        { config: { ...CONFIG, shopId: "my-shop" }, settings: {}, cursor: null, limit: 200, connectionKey: "c1" },
        fetchImpl,
      ),
    ).rejects.toThrow(/numeric shop id/);
    expect(calls).toHaveLength(0);
  });

  test("an expired token says to reconnect, not just 401", async () => {
    const { fetchImpl } = recorder([{ status: 401, json: { error: "invalid_token" } }]);
    await expect(pull(fetchImpl)).rejects.toThrow(/reconnect the integration/);
  });
});

describe("writing stock and price", () => {
  const INVENTORY = {
    products: [
      {
        product_id: 888,
        sku: "MUG-BLUE",
        property_values: [],
        offerings: [{ quantity: 3, price: { amount: 1200, divisor: 100 }, is_enabled: true }],
      },
      {
        product_id: 999,
        sku: "MUG-RED",
        property_values: [],
        offerings: [{ quantity: 7, price: { amount: 1500, divisor: 100 }, is_enabled: true }],
      },
    ],
  };

  const push = (fetchImpl: typeof fetch, rows: Record<string, unknown>[], settings: Record<string, unknown> = {}) =>
    pushToDestination(
      "etsy",
      { config: CONFIG, settings, rows, columns: {}, syncKey: "s1", connectionKey: "c1" },
      fetchImpl,
    );

  test("it reads the current inventory before writing — the PUT replaces everything", async () => {
    // Writing a bare product would delete every other variation on the
    // listing. The endpoint looks like a patch and is not one.
    const { calls, fetchImpl } = recorder([{ json: INVENTORY }, { json: {} }]);
    await push(fetchImpl, [{ listingId: "777", productId: "888", quantity: 5 }]);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[1]!.method).toBe("PUT");
    const sent = JSON.parse(calls[1]!.body) as { products: any[] };
    expect(sent.products).toHaveLength(2);
  });

  test("only the addressed variation changes; the rest are rewritten as they were", async () => {
    const { calls, fetchImpl } = recorder([{ json: INVENTORY }, { json: {} }]);
    await push(fetchImpl, [{ listingId: "777", productId: "888", quantity: 5, price: 9.5 }]);
    const sent = JSON.parse(calls[1]!.body) as { products: any[] };
    expect(sent.products[0].offerings[0]).toMatchObject({ quantity: 5, price: 9.5 });
    // Untouched, and its price converted back from minor units rather than
    // written as 1500.
    expect(sent.products[1].offerings[0]).toMatchObject({ quantity: 7, price: 15 });
  });

  test("a row with no product id is SKIPPED by default, not applied to every variation", async () => {
    // The destructive reading has to be asked for.
    // Asserted on the wire: `pushToDestination` returns void, so what a row
    // did is only visible as the call it did or did not make.
    const { calls, fetchImpl } = recorder([{ json: INVENTORY }, { json: {} }]);
    await push(fetchImpl, [{ listingId: "777", quantity: 5 }]);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  test("`listing` mode writes every variation, having been asked to", async () => {
    const { calls, fetchImpl } = recorder([{ json: INVENTORY }, { json: {} }]);
    await push(fetchImpl, [{ listingId: "777", quantity: 5 }], { addresses: "listing" });
    const sent = JSON.parse(calls[1]!.body) as { products: any[] };
    expect(sent.products[0].offerings[0].quantity).toBe(5);
    expect(sent.products[1].offerings[0].quantity).toBe(5);
  });

  test("a row with nothing to write is skipped rather than round-tripped", async () => {
    // Not even the read: with nothing to write there is nothing to merge into.
    const { calls, fetchImpl } = recorder([{ json: INVENTORY }]);
    await push(fetchImpl, [{ listingId: "777", productId: "888" }]);
    expect(calls).toHaveLength(0);
  });
});

describe("submitting tracking", () => {
  const SETTINGS = {
    receiptIdField: "receiptId",
    trackingCodeField: "carrier_shipment_id",
    carrierNameField: "carrier",
  };
  const ROW = { receiptId: "9001", carrier_shipment_id: "TRK-1", carrier: "royal-mail" };

  const run = (fetchImpl: typeof fetch, settings = SETTINGS, row = ROW) =>
    runIntegrationTask("etsy", "submit_tracking", { config: CONFIG, settings, row, idempotencyKey: "k1" }, fetchImpl);

  test("it posts a form, not JSON", async () => {
    // The spec declares this body as `application/x-www-form-urlencoded`.
    const { calls, fetchImpl } = recorder([{ json: { is_shipped: true, status: "Completed" } }]);
    await run(fetchImpl);
    expect(calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0]!.url).toContain("/shops/12345/receipts/9001/tracking");
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("tracking_code")).toBe("TRK-1");
    expect(form.get("carrier_name")).toBe("royal-mail");
    expect(form.get("send_bcc")).toBe("true");
  });

  test("the buyer notification can be turned off", async () => {
    const { calls, fetchImpl } = recorder([{ json: { is_shipped: true } }]);
    await run(fetchImpl, { ...SETTINGS, notifyBuyer: "no" } as never);
    expect(new URLSearchParams(calls[0]!.body).get("send_bcc")).toBe("false");
  });

  test("it reports what Etsy said about the receipt", async () => {
    const { fetchImpl } = recorder([{ json: { is_shipped: true, status: "Completed" } }]);
    const res = await run(fetchImpl);
    expect(res.outputs).toMatchObject({
      receiptId: "9001",
      trackingCode: "TRK-1",
      carrierName: "royal-mail",
      shipmentStatus: "shipped",
    });
  });

  test("each missing row field names itself, before any call", async () => {
    for (const [key, expected] of [
      ["receiptIdField", /receipt id/],
      ["trackingCodeField", /tracking number/],
      ["carrierNameField", /carrier name/],
    ] as const) {
      const { calls, fetchImpl } = recorder([{ json: {} }]);
      const settings = { ...SETTINGS, [key]: "" };
      await expect(run(fetchImpl, settings as never)).rejects.toThrow(expected);
      expect(calls).toHaveLength(0);
    }
  });
});
