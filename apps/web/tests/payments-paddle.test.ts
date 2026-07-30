/**
 * Paddle — a merchant-of-record provider.
 *
 * The reason to support Paddle at all is that it is the seller of record, so it
 * determines and remits tax. That removes the need for a separate tax engine,
 * and it also means the amounts are what Paddle collected. Two details bite if
 * you assume Stripe's shapes: money arrives as a STRING of minor units, and the
 * signature separator is `;` with a `ts:body` payload rather than Stripe's `,`
 * and `ts.body`.
 */
import { describe, expect, test } from "bun:test";
import {
  PAYMENT_PROVIDER_MODES,
  PAYMENT_SECRET_KEYS,
  fetchPaymentPage,
  isCallbackProvider,
  normalizePaymentEvent,
  verifyPaymentSignature,
} from "../../../packages/integrations/src/payments";

const SECRET = "pdl_ntfset_testsecret";
const NOW_MS = 1_760_000_000_000;
const TS = Math.floor(NOW_MS / 1000);

const sign = async (rawBody: string, ts = TS) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}:${rawBody}`));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
};

const verify = async (rawBody: string, header: string) =>
  verifyPaymentSignature("paddle", {
    rawBody,
    headers: { "paddle-signature": header },
    secret: SECRET,
    nowMs: NOW_MS,
  });

const EVENT = JSON.stringify({
  event_id: "evt_01",
  event_type: "transaction.completed",
  data: {
    id: "txn_01",
    status: "completed",
    customer_id: "ctm_01",
    subscription_id: "sub_01",
    currency_code: "USD",
    invoice_number: "INV-9",
    billed_at: "2026-01-15T10:00:00Z",
    created_at: "2026-01-15T09:59:00Z",
    // Paddle sends money as STRINGS of minor units.
    details: { totals: { total: "11988", tax: "1998", subtotal: "9990" } },
  },
});

describe("registration", () => {
  test("Paddle is a webhook-mode provider with both secrets marked", () => {
    expect(PAYMENT_PROVIDER_MODES.paddle).toBe("webhook");
    expect(isCallbackProvider("paddle")).toBe(false);
    expect(PAYMENT_SECRET_KEYS.paddle).toEqual(["apiKey", "webhookSecret"]);
  });
});

describe("signature verification", () => {
  test("a correctly signed event verifies", async () => {
    const h = `ts=${TS};h1=${await sign(EVENT)}`;
    expect(await verify(EVENT, h)).toEqual({ ok: true });
  });

  test("a tampered body is rejected", async () => {
    const h = `ts=${TS};h1=${await sign(EVENT)}`;
    const tampered = EVENT.replace('"11988"', '"1"');
    expect((await verify(tampered, h)).ok).toBe(false);
  });

  test("the timestamp is inside the signed payload, not just a header", async () => {
    // Signing only the body would let an attacker move an old event forward.
    const h = `ts=${TS + 1};h1=${await sign(EVENT, TS)}`;
    expect(await verify(EVENT, h)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  test("a stale event is refused by the replay window", async () => {
    const oldTs = TS - 3600;
    const h = `ts=${oldTs};h1=${await sign(EVENT, oldTs)}`;
    // Correctly signed, but an hour old — a captured event must not replay.
    expect(await verify(EVENT, h)).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  test("missing and malformed headers are distinguished", async () => {
    expect(await verify(EVENT, "")).toEqual({ ok: false, reason: "missing_signature" });
    expect(await verify(EVENT, "garbage")).toEqual({ ok: false, reason: "malformed_signature" });
    expect(await verify(EVENT, `ts=${TS}`)).toEqual({ ok: false, reason: "malformed_signature" });
    expect(await verify(EVENT, `ts=notanumber;h1=abc`)).toEqual({
      ok: false,
      reason: "malformed_signature",
    });
  });

  test("several h1 candidates are accepted during secret rotation", async () => {
    const good = await sign(EVENT);
    expect((await verify(EVENT, `ts=${TS};h1=deadbeef;h1=${good}`)).ok).toBe(true);
  });
});

describe("normalization", () => {
  const parse = (raw: string) => normalizePaymentEvent("paddle", JSON.parse(raw));

  test("a transaction yields BOTH an invoice and a payment row", () => {
    const out = parse(EVENT);
    expect(out.eventId).toBe("evt_01");
    expect(out.records.map((r) => r.kind).sort()).toEqual(["invoice", "payment"]);
  });

  test("string minor units are coerced to numbers, not stored as text", () => {
    const invoice = parse(EVENT).records.find((r) => r.kind === "invoice")!.row;
    // Storing "11988" would break every aggregate over the column.
    expect(invoice.amount_due).toBe(11988);
    expect(invoice.tax).toBe(1998);
    expect(typeof invoice.amount_due).toBe("number");
  });

  test("tax is kept separate — it is what the MoR remits, not vendor revenue", () => {
    const invoice = parse(EVENT).records.find((r) => r.kind === "invoice")!.row;
    expect(invoice.tax).toBe(1998);
    expect(invoice.currency).toBe("USD");
  });

  test("the payment row does not collide with the invoice row's id", () => {
    const rows = parse(EVENT).records;
    const ids = rows.map((r) => r.row.id);
    // One Paddle transaction backs two records; sharing an id would make the
    // second upsert overwrite the first.
    expect(new Set(ids).size).toBe(2);
  });

  test("a completed transaction reads as a succeeded payment", () => {
    const payment = parse(EVENT).records.find((r) => r.kind === "payment")!.row;
    expect(payment.status).toBe("succeeded");
    expect(payment.invoice).toBeTruthy();
  });

  test("customer and subscription events map to their own kinds", () => {
    const cust = normalizePaymentEvent("paddle", {
      event_id: "evt_2",
      event_type: "customer.created",
      data: { id: "ctm_01", email: "a@x.test", name: "A", created_at: "2026-01-01T00:00:00Z" },
    });
    expect(cust.records[0]!.kind).toBe("customer");
    expect(cust.records[0]!.row.email).toBe("a@x.test");

    const sub = normalizePaymentEvent("paddle", {
      event_id: "evt_3",
      event_type: "subscription.updated",
      data: {
        id: "sub_01",
        status: "active",
        customer_id: "ctm_01",
        currency_code: "USD",
        current_billing_period: { starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-02-01T00:00:00Z" },
        items: [{ quantity: 2, price: { name: "Pro", unit_price: { amount: "4999", currency_code: "USD" }, billing_cycle: { interval: "month" } } }],
      },
    });
    const row = sub.records[0]!.row;
    expect(sub.records[0]!.kind).toBe("subscription");
    expect(row.price_amount).toBe(4999);
    expect(row.billing_interval).toBe("month");
    expect(row.quantity).toBe(2);
  });

  test("an event type we do not map yields no rows rather than a junk one", () => {
    const out = normalizePaymentEvent("paddle", {
      event_id: "evt_x",
      event_type: "report.created",
      data: { id: "rep_01" },
    });
    expect(out.records).toEqual([]);
    expect(out.eventId).toBe("evt_x");
  });
});

describe("reconcile", () => {
  const page = (data: unknown[], hasMore = false) =>
    (async () =>
      new Response(JSON.stringify({ data, meta: { pagination: { has_more: hasMore } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

  test("a reconciled row is identical to the webhook row", async () => {
    const txn = JSON.parse(EVENT).data;
    const out = await fetchPaymentPage({
      provider: "paddle",
      config: { apiKey: "pdl_test" },
      kind: "invoice",
      fetchImpl: page([txn]),
    });
    const fromEvent = normalizePaymentEvent("paddle", JSON.parse(EVENT)).records.find(
      (r) => r.kind === "invoice",
    )!;
    // Two shapes for one object is how sync drift starts — the reconcile path
    // reuses the event normalizer precisely so this holds.
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toEqual(fromEvent);
  });

  test("sandbox config hits the sandbox host", async () => {
    let requested = "";
    const spy = (async (url: string) => {
      requested = String(url);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchPaymentPage({
      provider: "paddle",
      config: { apiKey: "pdl_test", environment: "sandbox" },
      kind: "customer",
      fetchImpl: spy,
    });
    expect(requested.startsWith("https://sandbox-api.paddle.com/customers")).toBe(true);
  });

  test("the cursor is an id, never the absolute next URL Paddle returns", async () => {
    const out = await fetchPaymentPage({
      provider: "paddle",
      config: { apiKey: "pdl_test" },
      kind: "customer",
      fetchImpl: page([{ id: "ctm_01" }, { id: "ctm_02" }], true),
    });
    // Storing Paddle's absolute `next` URL would let a stale cursor replay an
    // old page forever after a host or version change.
    expect(out.nextCursor).toBe("ctm_02");
  });

  test("the last page ends the walk", async () => {
    const out = await fetchPaymentPage({
      provider: "paddle",
      config: { apiKey: "pdl_test" },
      kind: "customer",
      fetchImpl: page([{ id: "ctm_01" }], false),
    });
    expect(out.nextCursor).toBeNull();
  });

  test("a provider error is surfaced, not swallowed as an empty page", async () => {
    const dead = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const out = await fetchPaymentPage({
      provider: "paddle",
      config: { apiKey: "pdl_test" },
      kind: "customer",
      fetchImpl: dead,
    });
    // An empty page with no error would look like "sync finished".
    expect(out.error).toBe("paddle 403");
  });

  test("a missing API key is refused before any request", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const out = await fetchPaymentPage({
      provider: "paddle",
      config: {},
      kind: "customer",
      fetchImpl: spy,
    });
    expect(out.error).toBe("missing_api_key");
    expect(called).toBe(false);
  });
});
