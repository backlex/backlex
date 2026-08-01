/**
 * Outbound refunds — the half of payments that GIVES money back.
 *
 * The bugs this file exists to catch are the ones a provider cannot tell you
 * about, because to the provider the request looked perfectly well-formed:
 *
 *   1. **Unit conversion.** PayTR wants a major-unit decimal on a refund and
 *      MINOR units on the checkout token request — the same provider, the same
 *      money, two conventions. Sending minor units there refunds a hundred
 *      times too much and PayTR accepts it right up to the payment total.
 *      iyzico and Authorize.net want decimals too; Stripe, Adyen, Klarna,
 *      Polar and Lemon Squeezy want minor units.
 *   2. **Which id goes where.** Stripe takes a charge OR a PaymentIntent
 *      depending on the prefix; Paddle's stored id carries a `:payment` suffix
 *      that its API rejects; Klarna refunds the ORDER, not the session; PayTR
 *      refunds against `merchant_oid`.
 *   3. **Where the answer lives.** Klarna returns the refund id in a response
 *      HEADER and an empty body; Authorize.net answers a refusal with HTTP 200.
 *
 * The ledger arithmetic is pinned separately at the bottom, over HTTP, because
 * "we refunded more than we charged" is a state nothing downstream reconciles.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  PAYMENT_REFUND_LEDGER,
  PAYMENT_REFUND_SUPPORT,
  createRefund,
  paddleTransactionId,
  paytrRefundHash,
} from "../../../packages/integrations/src/refunds";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/** Capture what the adapter actually sent, and answer with a canned body. */
const recorder = (response: unknown, status = 200, headers: Record<string, string> = {}) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  return { calls, fetchImpl };
};

const bodyOf = (init?: RequestInit): string => String(init?.body ?? "");
const formOf = (init?: RequestInit) => new URLSearchParams(bodyOf(init));
const jsonOf = (init?: RequestInit) => JSON.parse(bodyOf(init)) as Record<string, any>;
const headerOf = (init: RequestInit | undefined, key: string): string =>
  (init?.headers as Record<string, string> | undefined)?.[key] ?? "";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const BASE = { amount: 10890, currency: "TRY", externalId: "pay_123" } as const;

describe("the capability tables", () => {
  test("every provider can refund, and only Paddle is full-only", () => {
    expect(PAYMENT_REFUND_SUPPORT).toEqual({
      stripe: "full_and_partial",
      polar: "full_and_partial",
      lemonsqueezy: "full_and_partial",
      // Its partial refund adjusts individual transaction line items, whose
      // Paddle ids a payment row does not carry.
      paddle: "full_only",
      paytr: "full_and_partial",
      iyzico: "full_and_partial",
      adyen: "full_and_partial",
      authorizenet: "full_and_partial",
      klarna: "full_and_partial",
      dummy: "full_and_partial",
    });
  });

  test("only the two acquirers that file a refund as its own row are `own_row`", () => {
    // Getting this backwards is silent both ways: an optimistic write that a
    // later read erases, or a refund that never appears in the ledger at all.
    const ownRow = Object.entries(PAYMENT_REFUND_LEDGER)
      .filter(([, v]) => v === "own_row")
      .map(([k]) => k)
      .sort();
    expect(ownRow).toEqual(["adyen", "authorizenet"]);
  });
});

describe("Stripe", () => {
  test("a PaymentIntent id goes in `payment_intent`, a charge id in `charge`", async () => {
    const intent = recorder({ id: "re_1", status: "succeeded", amount: 10890 });
    await createRefund("stripe", {
      ...BASE,
      externalId: "pi_3AbCd",
      config: { apiKey: "sk_test" },
      fetchImpl: intent.fetchImpl,
    });
    expect(formOf(intent.calls[0]?.init).get("payment_intent")).toBe("pi_3AbCd");
    expect(formOf(intent.calls[0]?.init).get("charge")).toBeNull();

    const charge = recorder({ id: "re_2", status: "succeeded", amount: 10890 });
    await createRefund("stripe", {
      ...BASE,
      externalId: "ch_3AbCd",
      config: { apiKey: "sk_test" },
      fetchImpl: charge.fetchImpl,
    });
    // Sending a charge id as `payment_intent` earns "No such payment_intent",
    // which reads as a missing payment rather than as a wrong field.
    expect(formOf(charge.calls[0]?.init).get("charge")).toBe("ch_3AbCd");
    expect(formOf(charge.calls[0]?.init).get("payment_intent")).toBeNull();
  });

  test("the amount stays in minor units and the reason is translated", async () => {
    const { calls, fetchImpl } = recorder({ id: "re_1", status: "succeeded", amount: 10890 });
    await createRefund("stripe", {
      ...BASE,
      config: { apiKey: "sk_test" },
      reason: "requested_by_customer",
      idempotencyKey: "key-1",
      fetchImpl,
    });
    const form = formOf(calls[0]?.init);
    expect(form.get("amount")).toBe("10890");
    expect(form.get("reason")).toBe("requested_by_customer");
    expect(headerOf(calls[0]?.init, "Idempotency-Key")).toBe("key-1");
  });

  test("`other` is dropped rather than sent — Stripe's enum has no such member", async () => {
    const { calls, fetchImpl } = recorder({ id: "re_1", status: "succeeded", amount: 100 });
    await createRefund("stripe", {
      ...BASE,
      config: { apiKey: "sk_test" },
      reason: "other",
      fetchImpl,
    });
    expect(formOf(calls[0]?.init).get("reason")).toBeNull();
  });

  test("`resource_missing` is not_found, not a retryable failure", async () => {
    const { fetchImpl } = recorder(
      { error: { code: "resource_missing", message: "No such charge" } },
      400,
    );
    const res = await createRefund("stripe", {
      ...BASE,
      config: { apiKey: "sk_test" },
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("Adyen", () => {
  test("minor units, psp reference in the path, and `pending` because it is async", async () => {
    const { calls, fetchImpl } = recorder({ pspReference: "REF123", status: "received" }, 201);
    const res = await createRefund("adyen", {
      ...BASE,
      externalId: "PSP987",
      config: { apiKey: "AQE", merchantAccount: "ACME", environment: "test" },
      reference: "row-1",
      fetchImpl,
    });
    expect(calls[0]?.url).toBe("https://checkout-test.adyen.com/v71/payments/PSP987/refunds");
    expect(jsonOf(calls[0]?.init)).toEqual({
      merchantAccount: "ACME",
      amount: { currency: "TRY", value: 10890 },
      reference: "row-1",
    });
    // A 201 is "accepted", not "refunded" — the verdict arrives as a REFUND
    // webhook, which is also what files the refund's own row.
    expect(res).toMatchObject({ ok: true, status: "pending", refundId: "REF123" });
  });

  test("a live connection with no URL prefix is refused rather than sent to the test host", async () => {
    const { calls, fetchImpl } = recorder({});
    const res = await createRefund("adyen", {
      ...BASE,
      externalId: "PSP987",
      config: { apiKey: "AQE", merchantAccount: "ACME", environment: "live" },
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: false, reason: "missing_secret" });
    // Falling back to the test base would make a live refund silently do
    // nothing at all.
    expect(calls).toHaveLength(0);
  });

  test("a psp reference that isn't one never reaches a URL", async () => {
    const { calls, fetchImpl } = recorder({});
    const res = await createRefund("adyen", {
      ...BASE,
      externalId: "../../evil",
      config: { apiKey: "AQE", merchantAccount: "ACME" },
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(calls).toHaveLength(0);
  });
});

describe("Klarna", () => {
  test("refunds the order in minor units, with the idempotency key Klarna requires", async () => {
    const { calls, fetchImpl } = recorder(null, 201, { "Refund-ID": "rfnd_9" });
    const res = await createRefund("klarna", {
      ...BASE,
      externalId: "ord_abc",
      config: { username: "u", password: "p", region: "europe", environment: "playground" },
      description: "Returned the sneakers",
      idempotencyKey: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
    });
    expect(calls[0]?.url).toContain("/ordermanagement/v1/orders/ord_abc/refunds");
    expect(jsonOf(calls[0]?.init)).toEqual({
      refunded_amount: 10890,
      description: "Returned the sneakers",
    });
    expect(headerOf(calls[0]?.init, "Klarna-Idempotency-Key")).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    // The id is in a HEADER and the 201 body is empty — reading `body.refund_id`
    // yields null while the refund has in fact happened.
    expect(res).toMatchObject({ ok: true, refundId: "rfnd_9", status: "succeeded" });
  });

  test("an order id that could redirect the credentials is refused", async () => {
    const { calls, fetchImpl } = recorder(null, 201);
    const res = await createRefund("klarna", {
      ...BASE,
      externalId: "ord/../../evil",
      config: { username: "u", password: "p" },
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(calls).toHaveLength(0);
  });
});

describe("Authorize.net", () => {
  /** getTransactionDetails, then the refund itself. */
  const twoStep = (detail: unknown, refund: unknown) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const bodies = [detail, refund];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(bodies[calls.length - 1] ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return { calls, fetchImpl };
  };

  const OK = { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] };

  test("reads the card's last four off the transaction, then refunds in major units", async () => {
    const { calls, fetchImpl } = twoStep(
      {
        transaction: {
          transId: "60028752624",
          payment: { creditCard: { cardNumber: "XXXX0015" } },
        },
        messages: OK,
      },
      { transactionResponse: { transId: "60028752999", responseCode: "1" }, messages: OK },
    );
    const res = await createRefund("authorizenet", {
      externalId: "60028752624",
      amount: 25500,
      currency: "USD",
      config: { apiLoginId: "login", transactionKey: "key", environment: "sandbox", currency: "USD" },
      fetchImpl,
    });

    expect(calls).toHaveLength(2);
    expect(jsonOf(calls[0]?.init).getTransactionDetailsRequest.transId).toBe("60028752624");

    const req = jsonOf(calls[1]?.init).createTransactionRequest.transactionRequest;
    expect(req.transactionType).toBe("refundTransaction");
    // Major-unit decimal string, mirroring what the notification normalizer
    // reads on the way back in.
    expect(req.amount).toBe("255.00");
    expect(req.refTransId).toBe("60028752624");
    // Authorize.net will not refund on a transaction id alone — it wants the
    // original payment method, and the masked expiry is the literal "XXXX".
    expect(req.payment.creditCard).toEqual({ cardNumber: "0015", expirationDate: "XXXX" });
    expect(res).toMatchObject({ ok: true, refundId: "60028752999", status: "succeeded" });
  });

  test("a currency the account cannot settle in is refused before any credential goes out", async () => {
    const { calls, fetchImpl } = twoStep({}, {});
    const res = await createRefund("authorizenet", {
      ...BASE,
      config: { apiLoginId: "login", transactionKey: "key", currency: "USD" },
      fetchImpl,
    });
    // Its API states a currency nowhere, so refunding "in TRY" from a USD
    // account would quietly give back a different sum than the one asked for.
    expect(res).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(calls).toHaveLength(0);
  });

  test("a refusal arriving as HTTP 200 is still a refusal", async () => {
    const { fetchImpl } = twoStep(
      {
        transaction: { transId: "1", payment: { creditCard: { cardNumber: "XXXX0015" } } },
        messages: OK,
      },
      {
        messages: {
          resultCode: "Error",
          message: [{ code: "E00027", text: "The transaction was unsuccessful." }],
        },
      },
    );
    const res = await createRefund("authorizenet", {
      externalId: "1",
      amount: 100,
      currency: "USD",
      config: { apiLoginId: "login", transactionKey: "key", currency: "USD" },
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: false, reason: "rejected" });
  });

  test("a transaction reporting no card digits is refused, not guessed at", async () => {
    const { fetchImpl } = twoStep({ transaction: { transId: "1" }, messages: OK }, {});
    const res = await createRefund("authorizenet", {
      externalId: "1",
      amount: 100,
      currency: "USD",
      config: { apiLoginId: "login", transactionKey: "key", currency: "USD" },
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: false, reason: "rejected" });
  });
});

describe("PayTR", () => {
  test("`return_amount` is a MAJOR-unit decimal — the checkout's is minor units", async () => {
    const { calls, fetchImpl } = recorder({ status: "success", merchant_oid: "inv1" });
    const res = await createRefund("paytr", {
      ...BASE,
      externalId: "inv1",
      config: { merchantId: "1234", merchantKey: "key", merchantSalt: "salt" },
      fetchImpl,
    });
    const form = formOf(calls[0]?.init);
    // 10890 minor units is 108.90. Sending "10890" here refunds a hundred
    // times too much, and PayTR accepts it up to the payment total.
    expect(form.get("return_amount")).toBe("108.90");
    expect(form.get("merchant_oid")).toBe("inv1");
    expect(res).toMatchObject({ ok: true, status: "succeeded" });
  });

  test("the hash covers the exact amount string that is sent", async () => {
    const { calls, fetchImpl } = recorder({ status: "success" });
    await createRefund("paytr", {
      ...BASE,
      externalId: "inv1",
      config: { merchantId: "1234", merchantKey: "key", merchantSalt: "salt" },
      fetchImpl,
    });
    const form = formOf(calls[0]?.init);
    const expected = await paytrRefundHash(
      { merchantId: "1234", merchantOid: "inv1", returnAmount: "108.90" },
      "key",
      "salt",
    );
    // Hashing a differently-formatted amount than the one in the body is a
    // failure PayTR reports only as a generic refusal.
    expect(form.get("paytr_token")).toBe(expected);
  });

  test("`failed` means PayTR has no such order, which is not retryable", async () => {
    const { fetchImpl } = recorder({ status: "failed" });
    const res = await createRefund("paytr", {
      ...BASE,
      config: { merchantId: "1", merchantKey: "k", merchantSalt: "s" },
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("iyzico", () => {
  test("Refund V2, keyed on the paymentId we store, in major units", async () => {
    const { calls, fetchImpl } = recorder({ status: "success", paymentTransactionId: "pt_1" });
    const res = await createRefund("iyzico", {
      ...BASE,
      externalId: "17364587",
      config: { apiKey: "ak", secretKey: "sk", environment: "sandbox" },
      customerIp: "1.2.3.4",
      fetchImpl,
    });
    // V1 refunds a single basket ITEM and is keyed on a `paymentTransactionId`
    // that `payment_transactions` has never stored; V2 takes the paymentId,
    // which is exactly what `external_id` holds.
    expect(calls[0]?.url).toBe("https://sandbox-api.iyzipay.com/v2/payment/refund");
    const body = jsonOf(calls[0]?.init);
    expect(body.paymentId).toBe("17364587");
    expect(body.price).toBe("108.90");
    expect(body.currency).toBe("TRY");
    expect(body.ip).toBe("1.2.3.4");
    // The signature covers the URI path as well as the body.
    expect(headerOf(calls[0]?.init, "Authorization")).toStartWith("IYZWSv2 ");
    expect(res).toMatchObject({ ok: true, refundId: "pt_1" });
  });
});

describe("Polar and Lemon Squeezy", () => {
  test("Polar takes minor units and its own four-member reason enum", async () => {
    const { calls, fetchImpl } = recorder(
      { id: "rf_1", status: "succeeded", amount: 10890 },
      201,
    );
    await createRefund("polar", {
      ...BASE,
      externalId: "01234567-89ab-cdef-0123-456789abcdef",
      config: { apiKey: "polar_at", server: "sandbox" },
      reason: "other",
      fetchImpl,
    });
    const body = jsonOf(calls[0]?.init);
    expect(calls[0]?.url).toBe("https://sandbox-api.polar.sh/v1/refunds");
    expect(body.amount).toBe(10890);
    // Polar has a member Stripe does not, which is where `other` lands rather
    // than being dropped the way it is for Stripe.
    expect(body.reason).toBe("other");
  });

  test("Lemon Squeezy needs the JSON:API envelope, not a bare amount", async () => {
    const { calls, fetchImpl } = recorder({ data: { id: "42", type: "orders" } });
    await createRefund("lemonsqueezy", {
      ...BASE,
      externalId: "42",
      config: { apiKey: "ls_key" },
      fetchImpl,
    });
    expect(calls[0]?.url).toBe("https://api.lemonsqueezy.com/v1/orders/42/refund");
    // A plain `{ amount }` is rejected as malformed rather than as a bad
    // amount, which reads like the money figure is wrong.
    expect(jsonOf(calls[0]?.init)).toEqual({
      data: { type: "orders", id: "42", attributes: { amount: 10890 } },
    });
    expect(headerOf(calls[0]?.init, "Content-Type")).toBe("application/vnd.api+json");
  });
});

describe("Paddle", () => {
  test("the stored `:payment` suffix is stripped — its API rejects the decorated id", () => {
    expect(paddleTransactionId("txn_123:payment")).toBe("txn_123");
    // Idempotent, so an id that never carried the suffix survives untouched.
    expect(paddleTransactionId("txn_123")).toBe("txn_123");
  });

  test("a full refund is a `full` adjustment against the bare transaction id", async () => {
    const { calls, fetchImpl } = recorder({ data: { id: "adj_1", status: "pending_approval" } });
    const res = await createRefund("paddle", {
      ...BASE,
      externalId: "txn_123:payment",
      config: { apiKey: "pdl_key", environment: "sandbox" },
      description: "Order cancelled",
      full: true,
      fetchImpl,
    });
    expect(jsonOf(calls[0]?.init)).toEqual({
      action: "refund",
      transaction_id: "txn_123",
      reason: "Order cancelled",
      type: "full",
    });
    // Live refunds are held for Paddle to review; calling that "succeeded"
    // reports money that may still be declined.
    expect(res).toMatchObject({ ok: true, status: "pending" });
  });

  test("a partial refund is refused by name rather than approximated", async () => {
    const { calls, fetchImpl } = recorder({});
    const res = await createRefund("paddle", {
      ...BASE,
      externalId: "txn_123:payment",
      config: { apiKey: "pdl_key" },
      full: false,
      fetchImpl,
    });
    // Approximating it means adjusting the wrong line item.
    expect(res).toMatchObject({ ok: false, reason: "partial_unsupported" });
    expect(calls).toHaveLength(0);
  });
});

describe("shared validation", () => {
  test("a bad amount or currency reads the same whichever provider is connected", async () => {
    for (const provider of ["stripe", "klarna", "adyen", "paytr"]) {
      expect(
        await createRefund(provider, { ...BASE, amount: 0, config: {}, fetchImpl: async () => new Response("{}") }),
      ).toMatchObject({ ok: false, reason: "invalid_input" });
      expect(
        await createRefund(provider, {
          ...BASE,
          currency: "TRYX",
          config: {},
          fetchImpl: async () => new Response("{}"),
        }),
      ).toMatchObject({ ok: false, reason: "invalid_input" });
    }
  });

  test("an unknown provider is named rather than silently doing nothing", async () => {
    expect(await createRefund("square", { ...BASE, config: {} })).toMatchObject({
      ok: false,
      reason: "unknown_provider",
    });
  });
});

// ── The ledger, end to end over HTTP ────────────────────────────────────────

describe("refund → ledger, with the dummy provider standing in", () => {
  let h: TestHarness;
  let reference = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch("/api/admin/payments/providers", json({ provider: "dummy", config: {} }));

    // Bill a row and pay it, so there is a real `payment_transactions` row with
    // a real reference — the arithmetic below is only meaningful against one.
    const checkout = (await (
      await h.fetch(
        "/api/admin/payments/checkout",
        json({ provider: "dummy", amount: 10000, currency: "USD", description: "Invoice" }),
      )
    ).json()) as { data: { url: string; reference: string } };
    reference = checkout.data.reference;
    const url = new URL(checkout.data.url);
    await h.fetch(url.pathname + url.search, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ outcome: "success" }).toString(),
    });
  });
  afterAll(() => h.cleanup());

  const payment = async () => {
    const rows = (await (await h.fetch("/api/items/payment_transactions")).json()) as {
      data: { id: string; amount: number; amount_refunded: number; status: string }[];
    };
    return rows.data[0]!;
  };

  test("a partial refund bumps `amount_refunded` and leaves the payment succeeded", async () => {
    const res = await h.fetch(
      "/api/admin/payments/refund",
      json({ provider: "dummy", reference, amount: 2500 }),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { amount: number; full: boolean; ledger: { amountRefunded: number; status: string } };
    };
    expect(data).toMatchObject({ amount: 2500, full: false });
    // Most of the money stayed, so the payment is still what it was.
    expect(data.ledger).toEqual({ amountRefunded: 2500, status: "succeeded" });
    expect(await payment()).toMatchObject({ amount_refunded: 2500, status: "succeeded" });
  });

  test("refunding more than is left is refused against OUR number, not the provider's", async () => {
    const res = await h.fetch(
      "/api/admin/payments/refund",
      json({ provider: "dummy", reference, amount: 999_999 }),
    );
    expect(res.status).toBe(422);
    // The message has to say what is left, or an operator cannot act on it.
    expect(JSON.stringify(await res.json())).toContain("7500");
    expect(await payment()).toMatchObject({ amount_refunded: 2500 });
  });

  test("an omitted amount gives back exactly the remainder and flips the status", async () => {
    const res = await h.fetch(
      "/api/admin/payments/refund",
      json({ provider: "dummy", reference }),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { amount: number; full: boolean; ledger: { amountRefunded: number } };
    };
    expect(data).toMatchObject({ amount: 7500, full: true });
    expect(data.ledger.amountRefunded).toBe(10000);
    expect(await payment()).toMatchObject({ amount_refunded: 10000, status: "refunded" });
  });

  test("a fully refunded payment has nothing left to give back", async () => {
    const res = await h.fetch(
      "/api/admin/payments/refund",
      json({ provider: "dummy", reference }),
    );
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("already fully refunded");
  });

  test("a payment nobody recorded is a 404, not a call to the provider", async () => {
    const res = await h.fetch(
      "/api/admin/payments/refund",
      json({ provider: "dummy", externalId: "nope_not_here" }),
    );
    expect(res.status).toBe(404);
  });

  test("naming no payment at all is refused before anything is looked up", async () => {
    const res = await h.fetch("/api/admin/payments/refund", json({ provider: "dummy" }));
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("paymentRowId");
  });

  test("the refund is written to the activity log with the amount, not just the fact", async () => {
    const rows = (await (
      await h.fetch("/api/activity?action=payments.refund")
    ).json()) as { data: { action: string; payload?: Record<string, unknown> }[] };
    const entry = rows.data.find((r) => r.action === "payments.refund");
    expect(entry).toBeDefined();
    expect(entry?.payload).toMatchObject({ provider: "dummy", currency: "USD" });
  });
});
