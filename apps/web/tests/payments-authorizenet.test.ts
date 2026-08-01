/**
 * Authorize.net — the acquirer whose notification does not say enough.
 *
 * It signs like Stripe (HMAC over the raw body, result in a header) but three
 * things about it are new here, and each one is a way to get the ledger wrong:
 *
 * 1. **The signing key is plain text, and SHA-512.** Adyen's HMAC key is the
 *    HEX ENCODING of key bytes and must be decoded; Authorize.net's is used as
 *    its literal characters. Both are long printable hex-looking strings, so
 *    the two are indistinguishable by eye and confusing them produces a
 *    well-formed signature that matches nothing.
 *
 * 2. **There is no currency. Anywhere.** Not on a transaction, not on a
 *    notification, not in the XSD — a merchant account settles in exactly one,
 *    so the connection has to say which, and the amount is a major-unit decimal
 *    rather than the minor units the ledger stores.
 *
 * 3. **The notification carries no merchant reference.** `refId` is echoed on
 *    an API response and is not stored against the transaction, so the only
 *    thing that can carry a row id back is `order.invoiceNumber` — which is not
 *    in the webhook and has to be fetched with `getTransactionDetailsRequest`.
 *    Without that step a payment arrives with an amount and no idea what it
 *    paid for.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AUTHORIZENET_DEFAULT_CURRENCY,
  PAYMENT_ACK,
  PAYMENT_HAS_CATALOG,
  PAYMENT_PROVIDER_MODES,
  PAYMENT_SECRET_KEYS,
  authorizeNetTransactionId,
  fetchPaymentPage,
  hasObjectCatalog,
  isWebhookProvider,
  normalizePaymentEvent,
  parseAuthorizeNetJson,
  retrieveAuthorizeNetTransaction,
  verifyPaymentSignature,
} from "../../../packages/integrations/src/payments";
import {
  CHECKOUT_REFERENCE_MAX,
  PAYMENT_CHECKOUT_MODES,
  checkoutReferenceMax,
  createCheckout,
  toCheckoutReference,
} from "../../../packages/integrations/src/checkout";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * A Signature Key as the merchant interface hands it out. It LOOKS like hex —
 * that is exactly the trap — but Authorize.net uses these characters, not the
 * bytes they spell.
 */
const SIGNATURE_KEY =
  "9F1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F9";

const CONFIG = {
  apiLoginId: "5KP3u95bQpv",
  transactionKey: "346HZ32z3fP4hTG2",
  webhookSecret: SIGNATURE_KEY,
  environment: "sandbox",
  currency: "USD",
};

const hmacHex = async (
  message: string,
  keyBytes: Uint8Array,
  hash: "SHA-256" | "SHA-512" = "SHA-512",
) => {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.slice().buffer as ArrayBuffer,
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
};

/** Sign the way Authorize.net does: the key's CHARACTERS, SHA-512, hex out. */
const sign = (rawBody: string, key = SIGNATURE_KEY) =>
  hmacHex(rawBody, new TextEncoder().encode(key));

const verify = (rawBody: string, signature: string, secret = SIGNATURE_KEY) =>
  verifyPaymentSignature("authorizenet", {
    rawBody,
    headers: { "X-ANET-Signature": `sha512=${signature}` },
    secret,
  });

const notification = (
  eventType: string,
  payload: Record<string, unknown>,
  notificationId = "d0e8e7fe-c3e7-4add-a480-27bc5ce28a18",
) =>
  JSON.stringify({
    notificationId,
    eventType,
    eventDate: "2026-03-29T20:48:02.0080095Z",
    webhookId: "63d6fea2-aa13-4b1d-a204-f5fbc15942b7",
    payload: { entityName: "transaction", ...payload },
  });

const AUTHCAPTURE = {
  responseCode: 1,
  authCode: "LZ6I19",
  avsResponse: "Y",
  authAmount: 45.0,
  id: "60020981676",
};

const rowOf = (raw: string, opts: Parameters<typeof normalizePaymentEvent>[2] = {}) => {
  const out = normalizePaymentEvent("authorizenet", JSON.parse(raw), {
    accountCurrency: "USD",
    ...opts,
  });
  return { out, row: out.records[0]?.row as Record<string, unknown> | undefined };
};

// ── Capability tables ───────────────────────────────────────────────────────

describe("Authorize.net — capability tables", () => {
  test("signs its deliveries, and still has no catalog to reconcile against", () => {
    // Same split Adyen forced: `getTransactionListRequest` wants a settlement
    // BATCH id, so there is no cursor over the account to walk. Offering sync
    // would report a clean run that covered one arbitrary batch.
    expect(PAYMENT_PROVIDER_MODES.authorizenet).toBe("webhook");
    expect(isWebhookProvider("authorizenet")).toBe(true);
    expect(PAYMENT_HAS_CATALOG.authorizenet).toBe(false);
    expect(hasObjectCatalog("authorizenet")).toBe(false);
  });

  test("a reconcile attempt names the real obstacle rather than asking for a key", async () => {
    const out = await fetchPaymentPage({
      provider: "authorizenet",
      config: CONFIG,
      kind: "payment",
      fetchImpl: async () => {
        throw new Error("must not reach the network");
      },
    });
    expect(out.error).toBe("no_object_catalog");
    expect(out.records).toHaveLength(0);
  });

  test("takes the default ack, and masks only the halves worth hiding", () => {
    expect(PAYMENT_ACK.authorizenet).toBeNull();
    // `apiLoginId` is half a credential and the field an admin reads back most.
    expect(PAYMENT_SECRET_KEYS.authorizenet).toEqual(["transactionKey", "webhookSecret"]);
  });

  test("opens ad-hoc checkouts, but carries the shortest reference of any provider", () => {
    expect(PAYMENT_CHECKOUT_MODES.authorizenet).toBe("adhoc");
    // `order.invoiceNumber` stops at 20 characters and is the only merchant
    // identifier the gateway keeps. Every other provider takes 48.
    expect(CHECKOUT_REFERENCE_MAX.authorizenet).toBe(20);
    expect(checkoutReferenceMax("authorizenet")).toBe(20);
    expect(checkoutReferenceMax("stripe")).toBe(48);
    // A dash-stripped UUID is 32 hex characters; the provider's cap decides.
    const uuid = "7f3a29c4-1b2d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(toCheckoutReference(uuid, 20)).toBe("7f3a29c41b2d4e5f8a9b");
    expect(toCheckoutReference(uuid)).toHaveLength(32);
  });
});

// ── Signature ───────────────────────────────────────────────────────────────

describe("Authorize.net — X-ANET-Signature", () => {
  test("a genuine signature verifies", async () => {
    const body = notification("net.authorize.payment.authcapture.created", AUTHCAPTURE);
    expect(await verify(body, await sign(body))).toEqual({ ok: true });
  });

  test("the digest is compared case-insensitively, because they send it upper", async () => {
    const body = notification("net.authorize.payment.authcapture.created", AUTHCAPTURE);
    const upper = (await sign(body)).toUpperCase();
    expect(await verify(body, upper)).toEqual({ ok: true });
  });

  test("signing with the key's BYTES instead of its characters is refused", async () => {
    // The Adyen confusion, and the whole reason this test exists: that
    // provider's HMAC key IS hex and must be decoded first. Doing the same here
    // produces a perfectly well-formed signature that matches nothing, and both
    // key forms are printable so nothing about the value gives it away.
    const body = notification("net.authorize.payment.authcapture.created", AUTHCAPTURE);
    const decoded = new Uint8Array(SIGNATURE_KEY.length / 2);
    for (let i = 0; i < decoded.length; i++) {
      decoded[i] = Number.parseInt(SIGNATURE_KEY.slice(i * 2, i * 2 + 2), 16);
    }
    const wrong = await hmacHex(body, decoded);
    expect(await verify(body, wrong)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  test("SHA-256 is refused even when the digest is otherwise correct", async () => {
    // The algorithm is pinned rather than inferred from the value. Accepting
    // whatever the sender names is how a downgrade gets in.
    const body = notification("net.authorize.payment.authcapture.created", AUTHCAPTURE);
    const sha256 = await hmacHex(body, new TextEncoder().encode(SIGNATURE_KEY), "SHA-256");
    const verdict = await verifyPaymentSignature("authorizenet", {
      rawBody: body,
      headers: { "x-anet-signature": `sha256=${sha256}` },
      secret: SIGNATURE_KEY,
    });
    expect(verdict).toEqual({ ok: false, reason: "malformed_signature" });
  });

  test("an edited body no longer verifies", async () => {
    const body = notification("net.authorize.payment.authcapture.created", AUTHCAPTURE);
    const signature = await sign(body);
    const tampered = body.replace("45", "4500");
    expect(await verify(tampered, signature)).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  test("a missing or shapeless header is named for what it is", async () => {
    const body = notification("net.authorize.payment.authcapture.created", AUTHCAPTURE);
    expect(
      await verifyPaymentSignature("authorizenet", {
        rawBody: body,
        headers: {},
        secret: SIGNATURE_KEY,
      }),
    ).toEqual({ ok: false, reason: "missing_signature" });
    expect(
      await verifyPaymentSignature("authorizenet", {
        rawBody: body,
        headers: { "x-anet-signature": "no-separator-here" },
        secret: SIGNATURE_KEY,
      }),
    ).toEqual({ ok: false, reason: "malformed_signature" });
    expect(
      await verifyPaymentSignature("authorizenet", {
        rawBody: body,
        headers: { "x-anet-signature": "sha512=" },
        secret: SIGNATURE_KEY,
      }),
    ).toEqual({ ok: false, reason: "malformed_signature" });
  });

  test("no secret configured is refused before any comparison", async () => {
    const body = notification("net.authorize.payment.authcapture.created", AUTHCAPTURE);
    expect(
      await verifyPaymentSignature("authorizenet", {
        rawBody: body,
        headers: { "x-anet-signature": `sha512=${await sign(body)}` },
        secret: "",
      }),
    ).toEqual({ ok: false, reason: "missing_secret" });
  });
});

// ── Normalizing ─────────────────────────────────────────────────────────────

describe("Authorize.net — normalizing a notification", () => {
  test("an auth-capture is a succeeded payment, with the amount converted", () => {
    const { out, row } = rowOf(
      notification("net.authorize.payment.authcapture.created", AUTHCAPTURE),
    );
    // `notificationId` is unique per delivery and stable across their retries.
    expect(out.eventId).toBe("d0e8e7fe-c3e7-4add-a480-27bc5ce28a18");
    expect(row?.external_id).toBe("60020981676");
    expect(row?.status).toBe("succeeded");
    // 45.00 dollars → 4500 minor units. Written through verbatim it would be
    // 45 cents, which is the iyzico bug in the other direction.
    expect(row?.amount).toBe(4500);
    expect(row?.currency).toBe("USD");
    expect((row?.metadata as Record<string, unknown>).auth_code).toBe("LZ6I19");
  });

  test("the currency comes from the connection, since the API never states one", () => {
    const raw = notification("net.authorize.payment.authcapture.created", AUTHCAPTURE);
    const gbp = normalizePaymentEvent("authorizenet", JSON.parse(raw), {
      accountCurrency: "gbp",
    });
    const row = gbp.records[0]?.row as Record<string, unknown>;
    expect(row.currency).toBe("GBP");
    // Absent, USD — the only currency every Authorize.net account can settle in.
    const none = normalizePaymentEvent("authorizenet", JSON.parse(raw));
    expect((none.records[0]?.row as Record<string, unknown>).currency).toBe(
      AUTHORIZENET_DEFAULT_CURRENCY,
    );
  });

  test("the OPERATION is the second-to-last segment, not the last", () => {
    // `net.authorize.payment.refund.created` is a refund. Reading the tail as
    // the operation would make every payment event a "created" and collapse
    // refunds, voids and captures into one meaning.
    const refund = rowOf(
      notification("net.authorize.payment.refund.created", {
        ...AUTHCAPTURE,
        id: "60020999999",
        authAmount: 10.0,
      }),
    ).row;
    expect(refund?.status).toBe("refunded");
    const voided = rowOf(
      notification("net.authorize.payment.void.created", AUTHCAPTURE),
    ).row;
    expect(voided?.status).toBe("canceled");
  });

  test("an authorisation is pending until something captures it", () => {
    const { row } = rowOf(
      notification("net.authorize.payment.authorization.created", AUTHCAPTURE),
    );
    // The money is held, not taken. Recording it as succeeded would count an
    // uncaptured hold as revenue.
    expect(row?.status).toBe("pending");
  });

  test("a capture upserts onto the authorisation's own row", () => {
    // Authorize.net REUSES the transaction id when an authorisation is
    // captured or voided — unlike Adyen, which mints a modification reference —
    // so no `originalReference` bookkeeping is needed and the row id matches.
    const auth = rowOf(
      notification("net.authorize.payment.authorization.created", AUTHCAPTURE),
    ).row;
    const capture = rowOf(
      notification("net.authorize.payment.priorAuthCapture.created", AUTHCAPTURE),
    ).row;
    expect(capture?.id).toBe(auth?.id as string);
    expect(capture?.status).toBe("succeeded");
  });

  test("a refund is its own row, because its amount is not the payment's", () => {
    const { row } = rowOf(
      notification("net.authorize.payment.refund.created", {
        ...AUTHCAPTURE,
        id: "60020999999",
        authAmount: 10.0,
      }),
    );
    // Keyed on the refund's own transaction id. Filing it against the payment
    // would overwrite a $45 payment with the $10 that came back, because the
    // ledger's upsert REPLACES rather than merges.
    expect(row?.external_id).toBe("60020999999");
    expect(row?.amount).toBe(1000);
    expect(row?.amount_refunded).toBe(1000);
    expect(row?.status).toBe("refunded");
  });

  test("response codes decide the verdict, not the event name", () => {
    // 2 is declined; the event still says `authcapture.created`.
    const declined = rowOf(
      notification("net.authorize.payment.authcapture.created", {
        ...AUTHCAPTURE,
        responseCode: 2,
      }),
    ).row;
    expect(declined?.status).toBe("failed");
    expect(declined?.failure_reason).toBeTruthy();
    // 4 is held for review — approved by the gateway, not yet by the merchant.
    const held = rowOf(
      notification("net.authorize.payment.authcapture.created", {
        ...AUTHCAPTURE,
        responseCode: 4,
      }),
    ).row;
    expect(held?.status).toBe("pending");
    expect(held?.failure_reason).toBeNull();
  });

  test("a fraud review resolves the hold either way", () => {
    const held = rowOf(notification("net.authorize.payment.fraud.held", AUTHCAPTURE)).row;
    expect(held?.status).toBe("pending");
    const approved = rowOf(
      notification("net.authorize.payment.fraud.approved", AUTHCAPTURE),
    ).row;
    expect(approved?.status).toBe("succeeded");
    // A decline is a failure even though the held authorisation's response code
    // said approved, so it does not go through the shared status mapping.
    const declined = rowOf(
      notification("net.authorize.payment.fraud.declined", AUTHCAPTURE),
    ).row;
    expect(declined?.status).toBe("failed");
    expect(declined?.failure_reason).toBe("declined in fraud review");
  });

  test("a subscription event lands as a subscription, in major units too", () => {
    const out = normalizePaymentEvent(
      "authorizenet",
      JSON.parse(
        JSON.stringify({
          notificationId: "n2",
          eventType: "net.authorize.customer.subscription.created",
          payload: { entityName: "subscription", id: "100748", name: "Monthly", amount: 10.0, status: "active" },
        }),
      ),
      { accountCurrency: "USD" },
    );
    expect(out.records[0]?.kind).toBe("subscription");
    const row = out.records[0]?.row as Record<string, unknown>;
    expect(row.price_amount).toBe(1000);
    expect(row.product_name).toBe("Monthly");
  });

  test("a customer-profile event writes no row, having no email to write", () => {
    const out = normalizePaymentEvent(
      "authorizenet",
      {
        notificationId: "n3",
        eventType: "net.authorize.customer.created",
        payload: { entityName: "customerProfile", id: "1234" },
      },
      { accountCurrency: "USD" },
    );
    // Still recorded as an event by the consumer; just nothing to file.
    expect(out.records).toHaveLength(0);
    expect(out.eventId).toBe("n3");
  });

  test("an event type nobody has taught it writes nothing rather than guessing", () => {
    const { out } = rowOf(
      notification("net.authorize.payment.somethingNew.created", AUTHCAPTURE),
    );
    expect(out.records).toHaveLength(0);
  });
});

// ── The retrieved detail ────────────────────────────────────────────────────

describe("Authorize.net — the detail that completes a payment", () => {
  const DETAIL = {
    transId: "60020981676",
    submitTimeUTC: "2026-03-29T20:47:00Z",
    transactionStatus: "settledSuccessfully",
    responseCode: 1,
    order: { invoiceNumber: "7f3a29c41b2d4e5f8a9b", description: "Invoice #204" },
    payment: { creditCard: { cardType: "Visa", cardNumber: "XXXX1111" } },
  };

  test("the invoice number becomes the reference that ties money to a row", () => {
    const raw = notification("net.authorize.payment.authcapture.created", AUTHCAPTURE);
    const withoutDetail = rowOf(raw).row;
    // Nothing in the notification carries it. This is the gap the retrieve
    // exists to close — without it the payment is an orphan.
    expect(withoutDetail?.reference).toBeNull();

    const withDetail = rowOf(raw, { accountCurrency: "USD", detail: DETAIL }).row;
    expect(withDetail?.reference).toBe("7f3a29c41b2d4e5f8a9b");
    expect(withDetail?.method).toBe("Visa");
    expect(withDetail?.processed_at).toBe(Date.parse("2026-03-29T20:47:00Z"));
    const meta = withDetail?.metadata as Record<string, unknown>;
    expect(meta.transaction_status).toBe("settledSuccessfully");
    expect(meta.description).toBe("Invoice #204");
  });

  test("a refund's link back to what it refunded comes from the detail", () => {
    const { row } = rowOf(
      notification("net.authorize.payment.refund.created", {
        ...AUTHCAPTURE,
        id: "60020999999",
        authAmount: 10.0,
      }),
      { accountCurrency: "USD", detail: { ...DETAIL, refTransId: "60020981676" } },
    );
    expect((row?.metadata as Record<string, unknown>).original_reference).toBe("60020981676");
  });

  test("`merchantReferenceId` is used when no detail was fetched", () => {
    const { row } = rowOf(
      notification("net.authorize.payment.authcapture.created", {
        ...AUTHCAPTURE,
        merchantReferenceId: "inv0001",
      }),
    );
    expect(row?.reference).toBe("inv0001");
  });

  test("the consumer's fetch test matches the normalizer's write test", () => {
    // If these disagreed, detail would be fetched and thrown away — or worse, a
    // payment row would be written while nothing looked for its invoice number.
    expect(
      authorizeNetTransactionId(
        JSON.parse(notification("net.authorize.payment.authcapture.created", AUTHCAPTURE)),
      ),
    ).toBe("60020981676");
    expect(
      authorizeNetTransactionId({
        payload: { entityName: "subscription", id: "100748" },
      }),
    ).toBeNull();
    expect(authorizeNetTransactionId({})).toBeNull();
  });

  test("the response's leading BOM does not break the parse", () => {
    // Authorize.net prefixes its JSON with a UTF-8 BOM, which `JSON.parse`
    // rejects while naming a character that does not appear when printed.
    const parsed = parseAuthorizeNetJson('﻿{"messages":{"resultCode":"Ok"},"token":"abc"}');
    expect(parsed?.token).toBe("abc");
  });

  test("an error is reported with HTTP 200, so the status code is not the verdict", async () => {
    const out = await retrieveAuthorizeNetTransaction({
      config: CONFIG,
      transId: "60020981676",
      fetchImpl: async () =>
        new Response(
          `﻿${JSON.stringify({
            messages: {
              resultCode: "Error",
              message: [{ code: "E00007", text: "User authentication failed." }],
            },
          })}`,
          { status: 200 },
        ),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("rejected");
    expect(out.message).toBe("User authentication failed.");
  });

  test("a transport failure is `unreachable`, and missing keys never reach the network", async () => {
    const down = await retrieveAuthorizeNetTransaction({
      config: CONFIG,
      transId: "1",
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.reason).toBe("unreachable");

    let called = false;
    const nokeys = await retrieveAuthorizeNetTransaction({
      config: { environment: "sandbox" },
      transId: "1",
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
    });
    expect(called).toBe(false);
    expect(nokeys.ok).toBe(false);
    if (!nokeys.ok) expect(nokeys.reason).toBe("missing_secret");
  });

  test("sandbox and production are fixed hosts, chosen by the connection", async () => {
    const seen: string[] = [];
    const probe = async (environment: string) => {
      await retrieveAuthorizeNetTransaction({
        config: { ...CONFIG, environment },
        transId: "1",
        fetchImpl: async (url) => {
          seen.push(url);
          return new Response(JSON.stringify({ messages: { resultCode: "Ok" }, transaction: {} }));
        },
      });
    };
    await probe("sandbox");
    await probe("production");
    expect(seen).toEqual([
      "https://apitest.authorize.net/xml/v1/request.api",
      "https://api.authorize.net/xml/v1/request.api",
    ]);
  });
});

// ── Checkout ────────────────────────────────────────────────────────────────

describe("Authorize.net — Accept Hosted checkout", () => {
  const BASE = {
    config: CONFIG,
    amount: 4500,
    currency: "USD",
    reference: "7f3a29c41b2d4e5f8a9b",
    description: "Invoice #204",
    successUrl: "https://shop.example.com/thanks",
    cancelUrl: "https://shop.example.com/cancelled",
    hostedBaseUrl: "https://app.example.com",
    hostedProviderId: "3f2b7c10-0a1d-4e5f-9c8b-2d3e4f5a6b7c",
    nowMs: Date.UTC(2026, 2, 29, 20, 0, 0),
  };
  const okToken = (token = "FCfc6VbKGFztf8g4sI0B1bG35quHGGlnJx7G8zRpqV0=.89nE4Beh") =>
    new Response(`﻿${JSON.stringify({ messages: { resultCode: "Ok" }, token })}`);

  test("the reference travels as the invoice number, and the amount as a decimal", async () => {
    let sent: Record<string, unknown> = {};
    let seenUrl = "";
    const out = await createCheckout("authorizenet", {
      ...BASE,
      fetchImpl: async (url, init) => {
        seenUrl = url;
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return okToken();
      },
    });
    expect(seenUrl).toBe("https://apitest.authorize.net/xml/v1/request.api");
    const req = sent.getHostedPaymentPageRequest as Record<string, unknown>;
    const tx = req.transactionRequest as Record<string, unknown>;
    expect(tx.transactionType).toBe("authCaptureTransaction");
    // Minor units on our side, a major-unit decimal string on theirs.
    expect(tx.amount).toBe("45.00");
    // The one merchant identifier Authorize.net stores against a transaction.
    expect((tx.order as Record<string, unknown>).invoiceNumber).toBe("7f3a29c41b2d4e5f8a9b");
    expect(out.ok).toBe(true);
  });

  test("no customer details means no `billTo`, not a placeholder one", async () => {
    // Accept Hosted renders `billTo` INTO the payment form, so `splitName`'s
    // "Customer" fallback — harmless for iyzico, where the buyer name is a
    // required API field nobody sees — would prefill the shopper's billing name
    // with the word "Customer" for them to delete before paying.
    let sent: Record<string, unknown> = {};
    const capture = async (customer: Parameters<typeof createCheckout>[1]["customer"]) => {
      await createCheckout("authorizenet", {
        ...BASE,
        customer,
        fetchImpl: async (_url, init) => {
          sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return okToken();
        },
      });
      const req = sent.getHostedPaymentPageRequest as Record<string, unknown>;
      return req.transactionRequest as Record<string, unknown>;
    };

    expect((await capture(undefined)).billTo).toBeUndefined();
    // An email alone belongs on `customer`, and still buys no billing name.
    const emailOnly = await capture({ email: "buyer@example.com" });
    expect(emailOnly.billTo).toBeUndefined();
    expect(emailOnly.customer).toEqual({ email: "buyer@example.com" });
    // A real name is split and sent.
    expect((await capture({ name: "Ada Lovelace" })).billTo).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  test("the URL points at backlex's bridge, because there is no link to give out", async () => {
    const out = await createCheckout("authorizenet", {
      ...BASE,
      fetchImpl: async () => okToken("TOKEN/WITH+CHARS=.sfx"),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Accept Hosted returns a form TOKEN redeemed by POST. A GET link to
    // authorize.net would render nothing, so the link goes through a page here.
    // Keyed on the connection id, not the webhook token: this URL is read by
    // every customer asked to pay, and the webhook token is the shared secret
    // guarding the workspace's unauthenticated receive endpoint.
    expect(
      out.url.startsWith(
        "https://app.example.com/api/payments/authorizenet/3f2b7c10-0a1d-4e5f-9c8b-2d3e4f5a6b7c?",
      ),
    ).toBe(true);
    expect(out.url).not.toContain("wtok");
    // The token survives the round trip through the query string intact.
    expect(new URL(out.url).searchParams.get("t")).toBe("TOKEN/WITH+CHARS=.sfx");
    expect(out.externalId).toBe("TOKEN/WITH+CHARS=.sfx");
    // Their own 15-minute window, not a guess.
    expect(out.expiresAt).toBe(BASE.nowMs + 15 * 60_000);
  });

  test("a currency the account cannot settle in is refused before the network", async () => {
    let called = false;
    const out = await createCheckout("authorizenet", {
      ...BASE,
      currency: "EUR",
      fetchImpl: async () => {
        called = true;
        return okToken();
      },
    });
    expect(called).toBe(false);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // Authorize.net has no currency parameter at all, so charging in whatever
    // the account happens to use would be a silent mispricing.
    expect(out.reason).toBe("invalid_input");
    expect(out.message).toContain("USD");
  });

  test("a reference longer than the invoice number will hold is refused", async () => {
    let called = false;
    const out = await createCheckout("authorizenet", {
      ...BASE,
      // 32 hex characters — what a dash-stripped UUID gives, and what every
      // other provider accepts.
      reference: "7f3a29c41b2d4e5f8a9b0c1d2e3f4a5b",
      fetchImpl: async () => {
        called = true;
        return okToken();
      },
    });
    expect(called).toBe(false);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("invalid_input");
    expect(out.message).toContain("1–20");
    // The same value is fine on a provider that will carry it back.
    const stripeOk = await createCheckout("stripe", {
      ...BASE,
      reference: "7f3a29c41b2d4e5f8a9b0c1d2e3f4a5b",
      config: { apiKey: "sk_test" },
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/cs_1" })),
    });
    expect(stripeOk.ok).toBe(true);
  });

  test("an `Error` result code at HTTP 200 is a refusal, with their words", async () => {
    const out = await createCheckout("authorizenet", {
      ...BASE,
      fetchImpl: async () =>
        new Response(
          `﻿${JSON.stringify({
            messages: {
              resultCode: "Error",
              message: [{ code: "E00027", text: "The transaction was unsuccessful." }],
            },
          })}`,
          { status: 200 },
        ),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("rejected");
    expect(out.message).toBe("The transaction was unsuccessful.");
  });

  test("missing credentials and a missing host origin are caught before the network", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return okToken();
    };
    const noKeys = await createCheckout("authorizenet", {
      ...BASE,
      config: { environment: "sandbox", currency: "USD" },
      fetchImpl,
    });
    expect(noKeys.ok).toBe(false);
    if (!noKeys.ok) expect(noKeys.reason).toBe("missing_secret");

    const noHost = await createCheckout("authorizenet", {
      ...BASE,
      hostedBaseUrl: undefined,
      fetchImpl,
    });
    expect(noHost.ok).toBe(false);
    if (!noHost.ok) expect(noHost.reason).toBe("invalid_input");
    expect(called).toBe(false);
  });

  test("a transport failure is retryable, not a verdict", async () => {
    const out = await createCheckout("authorizenet", {
      ...BASE,
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("unreachable");
  });
});

// ── End to end ──────────────────────────────────────────────────────────────

describe("Authorize.net — end to end through the receive endpoint", () => {
  let h: TestHarness;
  let providerId = "";
  let webhookPath = "";
  let realFetch: typeof globalThis.fetch;
  /** What the stubbed `getTransactionDetailsRequest` answers with. */
  let detailResponse: () => Response = () =>
    new Response(
      JSON.stringify({
        messages: { resultCode: "Ok" },
        transaction: {
          transId: "60020981676",
          submitTimeUTC: "2026-03-29T20:47:00Z",
          transactionStatus: "settledSuccessfully",
          order: { invoiceNumber: "7f3a29c41b2d4e5f8a9b" },
          payment: { creditCard: { cardType: "Visa" } },
        },
      }),
    );

  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    // The receive path calls Authorize.net back for the invoice number. The
    // harness drives `app.fetch` directly, so only the OUTBOUND global is
    // stubbed and nothing about the request path changes.
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("authorize.net")) return detailResponse();
      throw new Error(`unexpected outbound fetch to ${url}`);
    }) as typeof globalThis.fetch;

    h = makeHarness();
    await seedAdmin(h);
    // Deliberately NOT the default currency. Authorize.net states none on a
    // payment, so if the connection's setting failed to reach the normalizer
    // every row here would quietly read USD and nothing would say so.
    const res = await h.fetch(
      "/api/admin/payments/providers",
      json({ provider: "authorizenet", config: { ...CONFIG, currency: "CAD" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; webhookPath: string } };
    providerId = body.data.id;
    webhookPath = body.data.webhookPath;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    h.cleanup();
  });

  const post = async (rawBody: string) =>
    h.fetch(webhookPath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anet-signature": `sha512=${await sign(rawBody)}`,
      },
      body: rawBody,
    });

  const transactions = async () =>
    (
      (await (await h.fetch("/api/items/payment_transactions")).json()) as {
        data: Record<string, unknown>[];
      }
    ).data;

  test("a signed capture lands with the invoice number fetched back onto it", async () => {
    const res = await post(notification("net.authorize.payment.authcapture.created", AUTHCAPTURE));
    expect(res.status).toBe(200);

    const row = (await transactions()).find((r) => r.external_id === "60020981676");
    expect(row).toBeTruthy();
    expect(row?.provider).toBe("authorizenet");
    expect(row?.amount).toBe(4500);
    // The connection's currency, carried all the way through the receive path.
    expect(row?.currency).toBe("CAD");
    expect(row?.status).toBe("succeeded");
    // The whole point: the money now names the row that asked for it, and that
    // value came from a second call rather than from the delivery.
    expect(row?.reference).toBe("7f3a29c41b2d4e5f8a9b");
    expect(row?.method).toBe("Visa");
  });

  test("a refund lands beside the payment without shrinking it", async () => {
    expect((await transactions()).find((r) => r.external_id === "60020981676")?.amount).toBe(4500);
    const res = await post(
      notification(
        "net.authorize.payment.refund.created",
        { ...AUTHCAPTURE, id: "60020999999", authAmount: 10.0 },
        "refund-notification-1",
      ),
    );
    expect(res.status).toBe(200);

    const rows = await transactions();
    // Checked against the REAL upsert, which replaces rather than merges.
    expect(rows.find((r) => r.external_id === "60020981676")?.amount).toBe(4500);
    const refund = rows.find((r) => r.external_id === "60020999999");
    expect(refund?.status).toBe("refunded");
    expect(refund?.amount).toBe(1000);
  });

  test("an unsigned delivery is refused", async () => {
    const raw = notification("net.authorize.payment.authcapture.created", AUTHCAPTURE);
    const res = await h.fetch(webhookPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    expect(res.status).toBe(400);
  });

  test("a retry of the same delivery is a no-op", async () => {
    const raw = notification("net.authorize.payment.authcapture.created", AUTHCAPTURE);
    expect((await post(raw)).status).toBe(200);
    expect((await transactions()).filter((r) => r.external_id === "60020981676")).toHaveLength(1);
  });

  test("the payment is still recorded when the detail lookup fails", async () => {
    // Best-effort on purpose: the HMAC already proved the delivery is real, so
    // refusing to record a verified payment to save an invoice number would
    // lose the money event entirely — and a bad credential would 500-loop every
    // delivery until Authorize.net disabled the endpoint.
    const previous = detailResponse;
    detailResponse = () => {
      throw new Error("authorize.net is down");
    };
    try {
      const res = await post(
        notification(
          "net.authorize.payment.authcapture.created",
          { ...AUTHCAPTURE, id: "60021111111" },
          "no-detail-notification",
        ),
      );
      expect(res.status).toBe(200);
    } finally {
      detailResponse = previous;
    }
    const row = (await transactions()).find((r) => r.external_id === "60021111111");
    expect(row?.amount).toBe(4500);
    expect(row?.status).toBe("succeeded");
    // The invoice number is what was lost, not the payment.
    expect(row?.reference).toBeNull();
  });

  test("sync explains that there is no catalog instead of reporting a clean run", async () => {
    const res = await h.fetch(`/api/admin/payments/providers/${providerId}/sync`, json({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { written: number; error?: string };
    expect(body.written).toBe(0);
    expect(body.error).toContain("no object catalog");
  });
});

// ── The hosted bridge ───────────────────────────────────────────────────────

describe("Authorize.net — the Accept Hosted bridge page", () => {
  let h: TestHarness;
  let providerId = "";
  let webhookToken = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/admin/payments/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "authorizenet", config: CONFIG }),
    });
    const body = (await res.json()) as { data: { id: string; webhookPath: string } };
    providerId = body.data.id;
    webhookToken = body.data.webhookPath.split("/").pop() ?? "";
  });
  afterAll(() => h.cleanup());

  test("it posts the token to Authorize.net, at the host the CONNECTION chose", async () => {
    const res = await h.fetch(`/api/payments/authorizenet/${providerId}?t=FORMTOKEN123`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The connection is on sandbox, so the sandbox redemption host — which is
    // `test.authorize.net`, NOT the `apitest` host the API lives on.
    expect(html).toContain('action="https://test.authorize.net/payment/payment"');
    expect(html).toContain('name="token" value="FORMTOKEN123"');
    // A real button behind the auto-submit, so a no-JS shopper is not stranded.
    expect(html).toContain("<button type=\"submit\">");
  });

  test("its CSP permits exactly the one script and the two Authorize.net origins", async () => {
    const res = await h.fetch(`/api/payments/authorizenet/${providerId}?t=FORMTOKEN123`);
    const csp = res.headers.get("content-security-policy") ?? "";
    // The app-wide policy is `form-action 'self'`, which would block the POST
    // outright and leave a page that does nothing when clicked.
    expect(csp).toContain("form-action https://accept.authorize.net https://test.authorize.net");
    expect(csp).toContain("default-src 'none'");
    // Named by hash rather than allowed by `'unsafe-inline'`.
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain("unsafe-inline'; script");
    // And the hash has to actually match the script the page ships, or the
    // auto-submit silently stops working.
    const html = await (await h.fetch(`/api/payments/authorizenet/${providerId}?t=X`)).text();
    const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
    let bin = "";
    for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
    expect(csp).toContain(`'sha256-${btoa(bin)}'`);
  });

  test("an unknown id and a missing form token are both refused", async () => {
    expect((await h.fetch(`/api/payments/authorizenet/nope?t=X`)).status).toBe(404);
    expect((await h.fetch(`/api/payments/authorizenet/${providerId}`)).status).toBe(400);
  });

  test("the webhook token is NOT a key to this page", async () => {
    // The bridge URL travels in a payment link and is read by every customer
    // asked to pay. Routing it on the webhook token would put the shared secret
    // guarding the workspace's unauthenticated receive endpoint in front of all
    // of them, so the token must not resolve here at all.
    expect(webhookToken).not.toBe("");
    expect((await h.fetch(`/api/payments/authorizenet/${webhookToken}?t=X`)).status).toBe(404);
  });

  test("the token is escaped rather than interpolated into the markup", async () => {
    const res = await h.fetch(
      `/api/payments/authorizenet/${providerId}?t=${encodeURIComponent('"><script>alert(1)</script>')}`,
    );
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});
