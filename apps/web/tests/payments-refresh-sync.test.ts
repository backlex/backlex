/**
 * The refresh sync — syncing a provider that has no catalog, using ours.
 *
 * Klarna and Authorize.net report a payment once, at settlement, and expose no
 * listing to page through. Everything afterwards — a refund raised in the
 * provider's own dashboard, a capture that settles overnight, an ACH debit that
 * comes back days later — produces no delivery and appears in no catalog.
 *
 * But there IS a catalog: `payment_transactions`, and it is ours. These tests
 * are mostly about the two ways that sweep could destroy money rather than
 * repair it — blanking a column the refetch didn't restate, and overwriting a
 * real payment because a lookup came back empty.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  PAYMENT_CAN_REFETCH,
  canRefetchPayment,
  hasObjectCatalog,
  paymentSyncMode,
  refetchPayment,
} from "../../../packages/integrations/src/payments";

const KLARNA_CONFIG = {
  username: "PK12345_0a0a0a0a",
  password: "klarna-api-password",
  region: "europe",
  environment: "playground",
  purchaseCountry: "DE",
};
const KLARNA_HOST = "https://api.playground.klarna.com";
const ORDER_ID = "7849fd84-47dc-4919-a7ce-b2c1d0e9f8a7";

const ANET_CONFIG = {
  apiLoginId: "5KP3u95bQpv",
  transactionKey: "346HZ32z3fP4hTG2",
  webhookSecret: "sigkey",
  environment: "sandbox",
  currency: "USD",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const spyFetch = (respond: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return Object.assign(fn, { calls });
};

describe("the capability table", () => {
  test("refetchability is a different question from having a catalog", () => {
    // Klarna and Authorize.net have no listing to walk and CAN be asked about
    // one payment. That combination is the whole feature.
    expect(hasObjectCatalog("klarna")).toBe(false);
    expect(canRefetchPayment("klarna")).toBe(true);
    expect(hasObjectCatalog("authorizenet")).toBe(false);
    expect(canRefetchPayment("authorizenet")).toBe(true);
  });

  test("the catalog providers are not ALSO refetchable — one job, one mechanism", () => {
    for (const p of ["stripe", "polar", "lemonsqueezy", "paddle"]) {
      expect(hasObjectCatalog(p)).toBe(true);
      expect(canRefetchPayment(p)).toBe(false);
      expect(paymentSyncMode(p)).toBe("catalog");
    }
  });

  test("iyzico stays out even though its endpoint exists", () => {
    // `POST /payment/detail` takes the paymentId we store, so the temptation is
    // real. Its refunds live per item transaction in
    // `itemTransactions[].refundHistory`, and the ledger upsert REPLACES the
    // row — a mapping written on a guess would zero `amount_refunded` on every
    // single pass. Do not flip this without a verified refund mapping.
    expect(PAYMENT_CAN_REFETCH.iyzico).toBe(false);
    expect(paymentSyncMode("iyzico")).toBeNull();
  });

  test("the providers with no read endpoint at all report no sync mode", () => {
    // Adyen's history comes out as scheduled report files; PayTR's callback is
    // the entire surface. Neither can be swept.
    expect(paymentSyncMode("adyen")).toBeNull();
    expect(paymentSyncMode("paytr")).toBeNull();
    expect(paymentSyncMode("klarna")).toBe("refresh");
    expect(paymentSyncMode("authorizenet")).toBe("refresh");
  });
});

describe("refetching one payment", () => {
  test("a provider that cannot be refetched says so rather than failing oddly", async () => {
    const fetchImpl = spyFetch(() => json({}));
    expect(await refetchPayment("adyen", { config: {}, externalId: "x", fetchImpl })).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test("Klarna's order read restates every money column the row carries", async () => {
    // This is the property that qualifies a provider for refresh at all. The
    // upsert replaces the row, so a refetch that left `amount_refunded` out
    // would blank a real refund on the next sweep.
    const fetchImpl = spyFetch(() =>
      json({
        order_id: ORDER_ID,
        status: "CAPTURED",
        fraud_status: "ACCEPTED",
        order_amount: 10890,
        captured_amount: 10890,
        refunded_amount: 2500,
        purchase_currency: "EUR",
        merchant_reference1: "inv42",
      }),
    );
    const out = await refetchPayment("klarna", {
      config: KLARNA_CONFIG,
      externalId: ORDER_ID,
      fetchImpl,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(fetchImpl.calls[0]!.url).toBe(`${KLARNA_HOST}/ordermanagement/v1/orders/${ORDER_ID}`);
    const row = out.records[0]!.row as Record<string, unknown>;
    expect(row.amount).toBe(10890);
    // The refund nobody ever pushed — the entire point of the sweep.
    expect(row.amount_refunded).toBe(2500);
    expect(row.currency).toBe("EUR");
    expect(row.status).toBe("succeeded");
    expect(row.reference).toBe("inv42");
  });

  test("a refresh does not invent a session it never saw", async () => {
    // The settlement path records `session_id` in metadata. A refresh has no
    // session behind it, so writing an empty one would replace a real value
    // with a blank on every pass.
    const fetchImpl = spyFetch(() =>
      json({ order_id: ORDER_ID, status: "CAPTURED", order_amount: 100, purchase_currency: "EUR" }),
    );
    const out = await refetchPayment("klarna", { config: KLARNA_CONFIG, externalId: ORDER_ID, fetchImpl });
    if (!out.ok) throw new Error("unreachable");
    const meta = (out.records[0]!.row as Record<string, unknown>).metadata as Record<string, unknown>;
    expect(meta.session_id).toBeUndefined();
    expect(meta.session_status).toBeUndefined();
  });

  test("a forgotten payment is `not_found`, which is not `unreachable`", async () => {
    // The distinction decides whether the caller retries for ever and whether
    // it blanks the row. Both wrong answers destroy something.
    const gone = spyFetch(() => json({ error_code: "NO_SUCH_ORDER" }, 404));
    expect(await refetchPayment("klarna", { config: KLARNA_CONFIG, externalId: ORDER_ID, fetchImpl: gone })).toEqual({
      ok: false,
      reason: "not_found",
    });
    const down = spyFetch(() => new Response("nope", { status: 503 }));
    expect(await refetchPayment("klarna", { config: KLARNA_CONFIG, externalId: ORDER_ID, fetchImpl: down })).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  test("an id that is not a plain id never reaches an outbound call", async () => {
    const fetchImpl = spyFetch(() => json({}));
    expect(
      await refetchPayment("klarna", { config: KLARNA_CONFIG, externalId: "a/b?c", fetchImpl }),
    ).toEqual({ ok: false, reason: "rejected" });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  test("Authorize.net's detail carries a status its notification never does", async () => {
    // `capturedPendingSettlement` becoming `settledSuccessfully` overnight is
    // invisible to a webhook-only integration — Authorize.net sends nothing.
    const detail = (transactionStatus: string) =>
      spyFetch(() =>
        json({
          messages: { resultCode: "Ok" },
          transaction: {
            transId: "60123456789",
            transactionStatus,
            transactionType: "authCaptureTransaction",
            authAmount: "108.90",
            submitTimeUTC: "2026-08-01T12:00:00Z",
            order: { invoiceNumber: "inv42" },
            payment: { creditCard: { cardType: "Visa" } },
          },
        }),
      );
    const settled = await refetchPayment("authorizenet", {
      config: ANET_CONFIG,
      externalId: "60123456789",
      accountCurrency: "USD",
      fetchImpl: detail("settledSuccessfully"),
    });
    if (!settled.ok) throw new Error("unreachable");
    const row = settled.records[0]!.row as Record<string, unknown>;
    expect(row.status).toBe("succeeded");
    // Same field the webhook path writes. Reading `settleAmount` here instead
    // would make the recorded figure flip every time a refresh ran.
    expect(row.amount).toBe(10890);
    expect(row.reference).toBe("inv42");
    expect(row.method).toBe("Visa");
  });

  test("an ACH debit that came back is a failure, not a refund", async () => {
    // Nobody chose to give the money back, so calling it `refunded` would put
    // it in the same bucket as a deliberate refund in every report.
    const out = await refetchPayment("authorizenet", {
      config: ANET_CONFIG,
      externalId: "60123456789",
      accountCurrency: "USD",
      fetchImpl: spyFetch(() =>
        json({
          messages: { resultCode: "Ok" },
          transaction: {
            transId: "60123456789",
            transactionStatus: "returnedItem",
            authAmount: "50.00",
          },
        }),
      ),
    });
    if (!out.ok) throw new Error("unreachable");
    const row = out.records[0]!.row as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect(row.amount_refunded).toBe(0);
  });

  test("a refund transaction keeps the refunded amount on its OWN row", async () => {
    // Same rule the webhook path follows: a refund is a separate transaction,
    // so its amount is never subtracted from the payment it refunded.
    const out = await refetchPayment("authorizenet", {
      config: ANET_CONFIG,
      externalId: "60999",
      accountCurrency: "USD",
      fetchImpl: spyFetch(() =>
        json({
          messages: { resultCode: "Ok" },
          transaction: {
            transId: "60999",
            transactionStatus: "refundSettledSuccessfully",
            authAmount: "10.00",
            refTransId: "60123456789",
          },
        }),
      ),
    });
    if (!out.ok) throw new Error("unreachable");
    const row = out.records[0]!.row as Record<string, unknown>;
    expect(row.status).toBe("refunded");
    expect(row.amount).toBe(1000);
    expect(row.amount_refunded).toBe(1000);
    expect((row.metadata as Record<string, unknown>).original_reference).toBe("60123456789");
  });

  test("a refresh does not fabricate an event_type it never saw", async () => {
    // The webhook path writes `metadata.event_type` from the notification. A
    // refresh genuinely does not know which notification created the row, and
    // the upsert replaces metadata — so it states `transaction_type`, which
    // Authorize.net actually reports, and leaves the invented field out.
    const out = await refetchPayment("authorizenet", {
      config: ANET_CONFIG,
      externalId: "60123456789",
      accountCurrency: "USD",
      fetchImpl: spyFetch(() =>
        json({
          messages: { resultCode: "Ok" },
          transaction: {
            transId: "60123456789",
            transactionStatus: "settledSuccessfully",
            transactionType: "authCaptureTransaction",
            authAmount: "1.00",
          },
        }),
      ),
    });
    if (!out.ok) throw new Error("unreachable");
    const meta = (out.records[0]!.row as Record<string, unknown>).metadata as Record<string, unknown>;
    expect(meta.event_type).toBeUndefined();
    expect(meta.transaction_type).toBe("authCaptureTransaction");
    expect(meta.transaction_status).toBe("settledSuccessfully");
  });
});

// End to end: a real connection, a real row in the ledger, a real sweep.
describe("the sweep, against the ledger", () => {
  let h: TestHarness;
  let client: Database;
  let realFetch: typeof globalThis.fetch;
  let providerId = "";
  let webhookPath = "";

  const paymentsTable = () =>
    (
      client.query("select physical_table as t from collections where slug = 'payment_transactions'").get() as
        | { t: string }
        | undefined
    )?.t;

  const paymentRows = () => {
    const table = paymentsTable();
    return table
      ? (client.query(`select * from "${table}" order by id`).all() as Record<string, unknown>[])
      : [];
  };

  /** Settle a real payment through the ordinary receive path, so the row under
   *  test was created the way a real one is. */
  const settle = async (orderId: string, over: Record<string, unknown> = {}) => {
    const sessionId = `1111aaaa-bbbb-cccc-dddd-${orderId.slice(-12)}`;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("/hpp/v1/sessions/")) {
        return json({ session_id: sessionId, status: "COMPLETED", order_id: orderId, updated_at: "t1" });
      }
      if (url.includes("/ordermanagement/v1/orders/")) {
        return json({
          order_id: orderId,
          status: "CAPTURED",
          fraud_status: "ACCEPTED",
          order_amount: 10890,
          captured_amount: 10890,
          refunded_amount: 0,
          purchase_currency: "EUR",
          merchant_reference1: "inv42",
          ...over,
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const res = await h.fetch(webhookPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: { session_id: sessionId, status: "COMPLETED", updated_at: "t1" } }),
    });
    expect(res.status).toBe(200);
    globalThis.fetch = realFetch;
  };

  const sync = () =>
    h.fetch(`/api/admin/payments/providers/${providerId}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resume: false }),
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    realFetch = globalThis.fetch;
    const res = await h.fetch("/api/admin/payments/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "klarna", config: KLARNA_CONFIG }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    providerId = body.data.id;
    webhookPath = body.data.webhookPath;
    client = new Database(h.env.SQLITE_PATH as string);
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    h.cleanup();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("the catalog offers a sync for Klarna, and names which kind", async () => {
    const cat = (await (await h.fetch("/api/admin/payments/catalog")).json()) as any;
    const klarna = cat.providers.find((p: any) => p.provider === "klarna");
    // It used to be hidden, because "no catalog" meant "no sync".
    expect(klarna.reconcilable).toBe(true);
    expect(klarna.syncMode).toBe("refresh");
    const adyen = cat.providers.find((p: any) => p.provider === "adyen");
    expect(adyen.reconcilable).toBe(false);
    expect(adyen.syncMode).toBeNull();
    const stripe = cat.providers.find((p: any) => p.provider === "stripe");
    expect(stripe.syncMode).toBe("catalog");
  });

  test("a sync with nothing recorded yet is not an error", async () => {
    const res = await sync();
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.error).toBeUndefined();
  });

  test("a refund raised after settlement is picked up by the sweep", async () => {
    await settle(ORDER_ID);
    let row = paymentRows().find((r) => r.external_id === ORDER_ID);
    expect(Number(row!.amount_refunded)).toBe(0);

    // The refund happens in Klarna's Merchant Portal. Nothing is pushed —
    // that is the whole gap this closes.
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("/ordermanagement/v1/orders/")) {
        return json({
          order_id: ORDER_ID,
          status: "CAPTURED",
          fraud_status: "ACCEPTED",
          order_amount: 10890,
          captured_amount: 10890,
          refunded_amount: 2500,
          purchase_currency: "EUR",
          merchant_reference1: "inv42",
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const res = await sync();
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.refreshed.checked).toBe(1);

    row = paymentRows().find((r) => r.external_id === ORDER_ID);
    expect(Number(row!.amount_refunded)).toBe(2500);
    // The rest of the row must survive the rewrite intact.
    expect(Number(row!.amount)).toBe(10890);
    expect(row!.reference).toBe("inv42");
  });

  test("a payment the provider has forgotten is left standing, never blanked", async () => {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("/ordermanagement/v1/orders/")) return json({ error_code: "NO_SUCH_ORDER" }, 404);
      return realFetch(input, init);
    }) as typeof fetch;

    const res = await sync();
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.refreshed.missing).toBe(1);
    expect(body.written).toBe(0);

    // Overwriting a real payment because a lookup came back empty would be the
    // worst thing this feature could do.
    const row = paymentRows().find((r) => r.external_id === ORDER_ID);
    expect(Number(row!.amount)).toBe(10890);
    expect(row!.status).toBe("succeeded");
  });

  test("a dead credential stops the run instead of failing every row in turn", async () => {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("klarna.com")) throw new Error("ECONNRESET");
      return realFetch(input, init);
    }) as typeof fetch;

    const body = (await (await sync()).json()) as any;
    expect(body.error).toContain("unreachable");
    // And the row is untouched — an outage is not evidence about a payment.
    const row = paymentRows().find((r) => r.external_id === ORDER_ID);
    expect(Number(row!.amount)).toBe(10890);
  });

  test("a settled-then-failed row is skipped, because nothing more happens to it", async () => {
    // A refused payment is over. Re-reading it every six hours for 90 days is
    // API traffic with no possible outcome.
    const table = paymentsTable()!;
    client.query(`update "${table}" set status = 'failed' where external_id = ?`).run(ORDER_ID);
    let called = 0;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("klarna.com")) {
        called++;
        return json({ order_id: ORDER_ID, status: "CAPTURED", order_amount: 1, purchase_currency: "EUR" });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const body = (await (await sync()).json()) as any;
    expect(body.refreshed.checked).toBe(0);
    expect(called).toBe(0);
  });
});
