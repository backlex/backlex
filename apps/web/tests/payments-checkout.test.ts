/**
 * Outbound checkout — the half of payments that ASKS for money.
 *
 * Three things are worth pinning here, and they are the three that would ship
 * broken silently:
 *   1. the per-provider request shape (Stripe's form encoding, PayTR's hash
 *      field order, iyzico's major-unit conversion) — each provider answers a
 *      wrong request with a generic failure, so a formula error looks like an
 *      outage rather than a bug,
 *   2. the reference round-trip — the value that goes out with the checkout
 *      has to come back on the settlement, or a received payment can't be
 *      tied to the invoice it paid,
 *   3. the refusals — a catalog provider, a bad amount and a missing customer
 *      IP must each say what is wrong instead of failing at the provider.
 */
import { describe, expect, test } from "bun:test";
import {
  PAYMENT_CHECKOUT_MODES,
  createCheckout,
  signDummySettlement,
  toCheckoutReference,
  verifyDummyCheckout,
} from "../../../packages/integrations/src/checkout";
import {
  normalizePaymentEvent,
  verifyPaymentSignature,
} from "../../../packages/integrations/src/payments";

/** Capture what the adapter actually sent, and answer with a canned body. */
const recorder = (response: unknown, status = 200) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
};

const bodyOf = (init?: RequestInit): string => String(init?.body ?? "");
const formOf = (init?: RequestInit) => new URLSearchParams(bodyOf(init));
const jsonOf = (init?: RequestInit) => JSON.parse(bodyOf(init)) as Record<string, any>;

const BASE = {
  amount: 10890,
  currency: "TRY",
  reference: "inv1234abcd",
  successUrl: "https://shop.example/thanks",
  callbackUrl: "https://app.example/api/payments/webhook/pwh_x",
  customer: { email: "buyer@example.com", name: "Ada Lovelace" },
} as const;

describe("the capability table", () => {
  test("splits providers by whether an ad-hoc amount is possible", () => {
    expect(PAYMENT_CHECKOUT_MODES).toEqual({
      stripe: "adhoc",
      paytr: "adhoc",
      iyzico: "adhoc",
      adyen: "adhoc",
      authorizenet: "adhoc",
      dummy: "adhoc",
      polar: "catalog",
      lemonsqueezy: "catalog",
      paddle: "catalog",
    });
  });

  test("a catalog provider refuses explicitly rather than failing oddly", async () => {
    const res = await createCheckout("polar", { ...BASE, config: { apiKey: "k" } });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("catalog_only");
    // The message has to name the missing thing — "it didn't work" sends an
    // admin to check their API key, which is fine.
    expect(res.message).toContain("existing product price");
  });

  test("an unknown provider is distinguishable from an unsupported one", async () => {
    // Deliberately a name that will never be a provider. This used to be
    // "adyen", which quietly stopped testing anything the day Adyen shipped.
    const res = await createCheckout("not-a-psp", { ...BASE, config: {} });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("unknown_provider");
  });
});

describe("the reference contract", () => {
  test("a row id survives as something every provider will carry", () => {
    // PayTR's `merchant_oid` accepts alphanumerics only, so a UUID has to lose
    // its dashes — and still has to stay unique.
    const a = toCheckoutReference("6f9619ff-8b86-d011-b42d-00c04fc964ff");
    expect(a).toBe("6f9619ff8b86d011b42d00c04fc964ff");
    expect(a).toMatch(/^[A-Za-z0-9]{1,48}$/);
  });

  test("a reference that no provider could carry is refused before the call", async () => {
    const { calls, fetchImpl } = recorder({});
    const res = await createCheckout("stripe", {
      ...BASE,
      reference: "invoices/2026-01",
      config: { apiKey: "sk_test" },
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("invalid_input");
    // Nothing was sent: a checkout carrying a reference the settlement can't
    // return is worse than no checkout, because the money still arrives.
    expect(calls).toHaveLength(0);
  });

  test("a non-integer amount never reaches the provider", async () => {
    const { calls, fetchImpl } = recorder({});
    for (const amount of [0, -5, 10.5, Number.NaN]) {
      const res = await createCheckout("stripe", {
        ...BASE,
        amount,
        config: { apiKey: "sk_test" },
        fetchImpl,
      });
      expect(res.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("Stripe", () => {
  test("sends form-encoded price_data and the client reference", async () => {
    const { calls, fetchImpl } = recorder({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
      expires_at: 1_800_000_000,
    });
    const res = await createCheckout("stripe", {
      ...BASE,
      currency: "USD",
      description: "Invoice INV-42",
      config: { apiKey: "sk_test_key" },
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.url).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
    expect(res.externalId).toBe("cs_test_123");
    expect(res.expiresAt).toBe(1_800_000_000_000);

    const call = calls[0]!;
    expect(call.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect((call.init?.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_key");
    const form = formOf(call.init);
    expect(form.get("mode")).toBe("payment");
    // Minor units go out verbatim — Stripe quotes the same unit the ledger
    // stores, so any conversion here would be a 100x bug.
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("10890");
    expect(form.get("line_items[0][price_data][currency]")).toBe("usd");
    expect(form.get("line_items[0][price_data][product_data][name]")).toBe("Invoice INV-42");
    expect(form.get("client_reference_id")).toBe("inv1234abcd");
    // Set on the intent too: a charge- or intent-shaped event never carries
    // the session's `client_reference_id`.
    expect(form.get("payment_intent_data[metadata][backlex_reference]")).toBe("inv1234abcd");
    expect(form.get("customer_email")).toBe("buyer@example.com");
  });

  test("an out-of-range expiry is dropped rather than sent as a 400", async () => {
    const { calls, fetchImpl } = recorder({ id: "cs_1", url: "https://x", expires_at: 1 });
    await createCheckout("stripe", {
      ...BASE,
      // Stripe's floor is 30 minutes; the default (24h) beats a rejection.
      expiresInSec: 60,
      config: { apiKey: "sk_test" },
      fetchImpl,
    });
    expect(formOf(calls[0]?.init).get("expires_at")).toBeNull();

    const ok = recorder({ id: "cs_2", url: "https://x" });
    await createCheckout("stripe", {
      ...BASE,
      expiresInSec: 3600,
      nowMs: 1_000_000_000_000,
      config: { apiKey: "sk_test" },
      fetchImpl: ok.fetchImpl,
    });
    expect(formOf(ok.calls[0]?.init).get("expires_at")).toBe(String(1_000_000_000 + 3600));
  });

  test("a Stripe error message is surfaced verbatim as a rejection", async () => {
    const { fetchImpl } = recorder({ error: { message: "Amount must be at least $0.50 usd" } }, 400);
    const res = await createCheckout("stripe", {
      ...BASE,
      config: { apiKey: "sk_test" },
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // `rejected`, not `unreachable`: the request arrived and was understood,
    // so retrying it is pointless.
    expect(res.reason).toBe("rejected");
    expect(res.message).toBe("Amount must be at least $0.50 usd");
  });
});

describe("PayTR", () => {
  const CONFIG = { merchantId: "123456", merchantKey: "mk_test", merchantSalt: "ms_test" };

  /** Rebuild PayTR's documented hash independently of the code under test — a
   *  shared helper would hide a wrong field order from both sides. */
  const expectedToken = async (fields: string[], salt: string, key: string) => {
    const k = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      k,
      new TextEncoder().encode(fields.join("") + salt),
    );
    let bin = "";
    for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
    return btoa(bin);
  };

  test("hashes the documented fields in the documented order", async () => {
    const { calls, fetchImpl } = recorder({ status: "success", token: "tok_abc" });
    const res = await createCheckout("paytr", {
      ...BASE,
      description: "Sipariş 42",
      customerIp: "203.0.113.9",
      config: CONFIG,
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.url).toBe("https://www.paytr.com/odeme/guvenli/tok_abc");

    const form = formOf(calls[0]?.init);
    // TRY is "TL" to PayTR and nothing else; sending "TRY" is rejected.
    expect(form.get("currency")).toBe("TL");
    expect(form.get("merchant_oid")).toBe("inv1234abcd");
    expect(form.get("payment_amount")).toBe("10890");
    expect(form.get("user_ip")).toBe("203.0.113.9");
    expect(form.get("merchant_notify_url")).toBe(BASE.callbackUrl);

    const want = await expectedToken(
      [
        "123456",
        "203.0.113.9",
        "inv1234abcd",
        "buyer@example.com",
        "10890",
        form.get("user_basket") ?? "",
        "0",
        "0",
        "TL",
        "0",
      ],
      "ms_test",
      "mk_test",
    );
    expect(form.get("paytr_token")).toBe(want);
  });

  test("the basket quotes MAJOR units even though the amount is minor", async () => {
    const { calls, fetchImpl } = recorder({ status: "success", token: "t" });
    await createCheckout("paytr", {
      ...BASE,
      description: "Widget",
      customerIp: "203.0.113.9",
      config: CONFIG,
      fetchImpl,
    });
    const basket = formOf(calls[0]?.init).get("user_basket") ?? "";
    expect(JSON.parse(atob(basket))).toEqual([["Widget", "108.90", 1]]);
  });

  test("refuses without the payer's IP instead of inventing one", async () => {
    const { calls, fetchImpl } = recorder({ status: "success", token: "t" });
    const res = await createCheckout("paytr", { ...BASE, config: CONFIG, fetchImpl });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // A placeholder IP produces a checkout that works in testing and gets the
    // merchant's real transactions declined for fraud.
    expect(res.reason).toBe("invalid_input");
    expect(res.message).toContain("IP");
    expect(calls).toHaveLength(0);
  });

  test("a PayTR refusal reports PayTR's own reason", async () => {
    const { fetchImpl } = recorder({ status: "failed", reason: "merchant_oid tekrar kullanılamaz" });
    const res = await createCheckout("paytr", {
      ...BASE,
      customerIp: "203.0.113.9",
      config: CONFIG,
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("rejected");
    expect(res.message).toContain("merchant_oid");
  });

  test("test mode is opt-in through the provider config", async () => {
    const { calls, fetchImpl } = recorder({ status: "success", token: "t" });
    await createCheckout("paytr", {
      ...BASE,
      customerIp: "203.0.113.9",
      config: { ...CONFIG, environment: "test" },
      fetchImpl,
    });
    expect(formOf(calls[0]?.init).get("test_mode")).toBe("1");
  });
});

describe("iyzico", () => {
  const CONFIG = { apiKey: "sandbox-key", secretKey: "sandbox-secret", environment: "sandbox" };

  test("quotes MAJOR units and carries the reference as conversationId", async () => {
    const { calls, fetchImpl } = recorder({
      status: "success",
      token: "tok_iyz",
      paymentPageUrl: "https://sandbox-cpp.iyzipay.com/?token=tok_iyz",
      tokenExpireTime: 1800,
    });
    const res = await createCheckout("iyzico", {
      ...BASE,
      nowMs: 1_000_000_000_000,
      config: CONFIG,
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.url).toBe("https://sandbox-cpp.iyzipay.com/?token=tok_iyz");
    expect(res.expiresAt).toBe(1_000_000_000_000 + 1_800_000);

    expect(calls[0]?.url).toBe(
      "https://sandbox-api.iyzipay.com/payment/iyzipos/checkoutform/initialize/auth/ecom",
    );
    const body = jsonOf(calls[0]?.init);
    // The ledger stores 10890 minor units; iyzico wants "108.90". Getting this
    // backwards is exactly the 100x bug the inbound path already had once.
    expect(body.price).toBe("108.90");
    expect(body.paidPrice).toBe("108.90");
    expect(body.conversationId).toBe("inv1234abcd");
    expect(body.callbackUrl).toBe(BASE.callbackUrl);
    expect(body.buyer.email).toBe("buyer@example.com");
    expect(body.buyer.name).toBe("Ada");
    expect(body.buyer.surname).toBe("Lovelace");
    // Authenticated with the same IYZWSv2 construction the retrieve call uses.
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toStartWith("IYZWSv2 ");
  });

  test("an embedded-form-only response is called out rather than passed off as a link", async () => {
    const { fetchImpl } = recorder({
      status: "success",
      token: "tok",
      checkoutFormContent: "<script>…</script>",
    });
    const res = await createCheckout("iyzico", { ...BASE, config: CONFIG, fetchImpl });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("rejected");
    expect(res.message).toContain("hosted checkout page");
  });

  test("iyzico's own error message survives", async () => {
    const { fetchImpl } = recorder({ status: "failure", errorMessage: "Geçersiz istek" });
    const res = await createCheckout("iyzico", { ...BASE, config: CONFIG, fetchImpl });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.message).toBe("Geçersiz istek");
  });
});

describe("the dummy provider", () => {
  const CONFIG = { secret: "s3cr3t" };

  test("signs its hosted link so the page can't be used to invent a payment", async () => {
    const res = await createCheckout("dummy", {
      ...BASE,
      config: CONFIG,
      hostedBaseUrl: "https://app.example/",
      hostedToken: "pwh_abc",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const url = new URL(res.url);
    expect(url.pathname).toBe("/api/payments/dummy/pwh_abc");
    expect(await verifyDummyCheckout("s3cr3t", url.searchParams)).toBe(true);

    // Bumping the amount without re-signing is exactly the attack the
    // signature exists for.
    const tampered = new URLSearchParams(url.searchParams);
    tampered.set("a", "1");
    expect(await verifyDummyCheckout("s3cr3t", tampered)).toBe(false);
    // As is a different workspace's secret.
    expect(await verifyDummyCheckout("other", url.searchParams)).toBe(false);
  });

  test("a checkout signature can't be replayed as a settlement signature", async () => {
    // One secret signs two things an attacker can see: the link it mints and
    // the settlement the hosted page posts back. Both are a hex HMAC over
    // text, so without domain separation a link's `sig` verifies as a
    // settlement signature for the identical bytes — and the checkout signing
    // string is `k=v&…`, which a settlement parser will happily read as a
    // form body. Together that turns a payment link into a licence to file a
    // succeeded payment for any amount and any reference.
    const res = await createCheckout("dummy", {
      ...BASE,
      // The description is interpolated from a row at run time by the flow op,
      // so its content is not the admin's to control.
      description: "Invoice&reference=VICTIM&status=success&amount=999999&currency=USD&at=1",
      config: CONFIG,
      hostedBaseUrl: "https://app.example",
      hostedToken: "pwh_abc",
    });
    if (!res.ok) throw new Error("unreachable");
    const params = new URL(res.url).searchParams;

    // Reconstruct the bytes the checkout signature covers, the way an attacker
    // would from the link they were handed.
    const replayed = ["r", "a", "c", "d", "s", "f"]
      .map((k) => `${k}=${params.get(k) ?? ""}`)
      .join("&");
    const verdict = await verifyPaymentSignature("dummy", {
      rawBody: replayed,
      headers: { "x-backlex-signature": params.get("sig") ?? "" },
      secret: "",
      config: CONFIG,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("signature_mismatch");
  });

  test("a genuine settlement signature still verifies", async () => {
    const body = new URLSearchParams({
      reference: "inv1234abcd",
      status: "success",
      amount: "10890",
      currency: "TRY",
      at: "1700000000000",
    }).toString();
    const verdict = await verifyPaymentSignature("dummy", {
      rawBody: body,
      headers: { "x-backlex-signature": await signDummySettlement("s3cr3t", body) },
      secret: "",
      config: CONFIG,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("the reference comes back", () => {
  test("Stripe returns it on the session and on the intent", () => {
    const session = normalizePaymentEvent("stripe", {
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          payment_intent: "pi_1",
          client_reference_id: "inv1234abcd",
          payment_status: "paid",
          amount_total: 10890,
          currency: "try",
          created: 1_700_000_000,
        },
      },
    });
    const row = session.records[0]?.row as Record<string, unknown>;
    expect(row.reference).toBe("inv1234abcd");
    // Keyed on the INTENT, so the session event and `payment_intent.succeeded`
    // upsert over each other instead of filing two payments for one charge.
    expect(row.external_id).toBe("pi_1");
    expect(row.status).toBe("succeeded");

    const intent = normalizePaymentEvent("stripe", {
      id: "evt_2",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_1",
          amount_received: 10890,
          currency: "try",
          status: "succeeded",
          created: 1_700_000_000,
          metadata: { backlex_reference: "inv1234abcd" },
        },
      },
    });
    expect((intent.records[0]?.row as Record<string, unknown>).reference).toBe("inv1234abcd");
  });

  test("PayTR's merchant_oid and iyzico's conversationId are the reference", () => {
    const paytr = normalizePaymentEvent("paytr", {
      merchant_oid: "inv1234abcd",
      status: "success",
      total_amount: "10890",
      currency: "TL",
    });
    expect((paytr.records[0]?.row as Record<string, unknown>).reference).toBe("inv1234abcd");

    const iyzico = normalizePaymentEvent("iyzico", {
      status: "success",
      paymentStatus: "SUCCESS",
      paymentId: "PAY-1",
      conversationId: "inv1234abcd",
      paidPrice: "108.90",
      currency: "TRY",
    });
    expect((iyzico.records[0]?.row as Record<string, unknown>).reference).toBe("inv1234abcd");
  });

  test("a dummy settlement normalizes like a real one, and is never livemode", () => {
    const out = normalizePaymentEvent("dummy", {
      reference: "inv1234abcd",
      status: "success",
      amount: "10890",
      currency: "TRY",
      at: 1_700_000_000_000,
    });
    expect(out.livemode).toBe(false);
    const row = out.records[0]?.row as Record<string, unknown>;
    expect(row.reference).toBe("inv1234abcd");
    expect(row.amount).toBe(10890);
    expect(row.status).toBe("succeeded");
  });
});
