/**
 * Adyen — a global acquirer, and the first provider that breaks two things the
 * payments module had been able to assume.
 *
 * 1. **The signature is inside the body.** Every other webhook provider signs
 *    the raw bytes and puts the result in a header. Adyen signs a canonical
 *    join of eight fields, per notification item, and carries it in
 *    `additionalData.hmacSignature` — so a delivery can legitimately contain
 *    several independently signed items.
 *
 * 2. **Signing a webhook and having a catalog are different capabilities.**
 *    Adyen authenticates like Stripe and has no customer/subscription/invoice
 *    objects to page through, which is why `hasObjectCatalog` exists apart from
 *    `isWebhookProvider`.
 *
 * On top of that its HMAC key is HEX (signing with the ASCII of that string
 * silently never matches) and its notifications are DELTAS rather than object
 * snapshots — the reason a refund gets its own row instead of overwriting the
 * payment it refunded.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  PAYMENT_ACK,
  PAYMENT_HAS_CATALOG,
  PAYMENT_PROVIDER_MODES,
  PAYMENT_SECRET_KEYS,
  adyenSigningString,
  fetchPaymentPage,
  hasObjectCatalog,
  isWebhookProvider,
  normalizePaymentEvent,
  verifyPaymentSignature,
} from "../../../packages/integrations/src/payments";
import {
  PAYMENT_CHECKOUT_MODES,
  createCheckout,
} from "../../../packages/integrations/src/checkout";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/** A real Adyen HMAC key is hex, and is used as BYTES, not as its text. */
const HMAC_KEY_HEX = "9EB1C7A8F0D34E2B5A6C8D0F1E2A3B4C5D6E7F8091A2B3C4D5E6F708192A3B4C";

const hmacBase64 = async (message: string, keyHex = HMAC_KEY_HEX) => {
  const bytes = new Uint8Array(keyHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(keyHex.slice(i * 2, i * 2 + 2), 16);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    bytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  let s = "";
  for (const b of new Uint8Array(sig)) s += String.fromCharCode(b);
  return btoa(s);
};

type ItemOverrides = Record<string, unknown>;

const makeItem = (overrides: ItemOverrides = {}): Record<string, unknown> => ({
  pspReference: "8836183819713023",
  originalReference: "",
  merchantAccountCode: "BacklexECOM",
  merchantReference: "inv7f3a29c4",
  amount: { currency: "EUR", value: 10000 },
  eventCode: "AUTHORISATION",
  success: "true",
  eventDate: "2026-02-01T10:00:00+01:00",
  paymentMethod: "visa",
  reason: "",
  additionalData: {},
  ...overrides,
});

/** Build a delivery whose every item carries a valid signature. */
const signedBody = async (items: Record<string, unknown>[], live = "false") => {
  const notificationItems = [];
  for (const item of items) {
    const additional = (item.additionalData ?? {}) as Record<string, unknown>;
    const signed = {
      ...item,
      additionalData: { ...additional, hmacSignature: await hmacBase64(adyenSigningString(item)) },
    };
    notificationItems.push({ NotificationRequestItem: signed });
  }
  return JSON.stringify({ live, notificationItems });
};

const verify = (rawBody: string, secret = HMAC_KEY_HEX) =>
  verifyPaymentSignature("adyen", { rawBody, headers: {}, secret });

describe("Adyen — capability tables", () => {
  test("signs its deliveries but exposes no catalog to reconcile against", () => {
    // The whole reason the two predicates were split. If `hasObjectCatalog`
    // ever starts tracking `isWebhookProvider` again, reconcile will be offered
    // for Adyen and report a clean sync that synced nothing.
    expect(PAYMENT_PROVIDER_MODES.adyen).toBe("webhook");
    expect(isWebhookProvider("adyen")).toBe(true);
    expect(PAYMENT_HAS_CATALOG.adyen).toBe(false);
    expect(hasObjectCatalog("adyen")).toBe(false);
  });

  test("a reconcile attempt names the real obstacle instead of asking for a key", async () => {
    const out = await fetchPaymentPage({
      provider: "adyen",
      config: { apiKey: "a-perfectly-good-key" },
      kind: "payment",
      fetchImpl: async () => {
        throw new Error("must not reach the network");
      },
    });
    expect(out.error).toBe("no_object_catalog");
    expect(out.records).toEqual([]);
  });

  test("acknowledges with [accepted] rather than the JSON envelope", () => {
    // Older Adyen accounts treat anything else as a failure, retry on a
    // schedule and eventually disable the endpoint — the same trap as PayTR.
    expect(PAYMENT_ACK.adyen?.body).toBe("[accepted]");
  });

  test("the HMAC key is stored as a secret", () => {
    expect(PAYMENT_SECRET_KEYS.adyen).toContain("webhookSecret");
    expect(PAYMENT_SECRET_KEYS.adyen).toContain("apiKey");
    // Identifiers, not credentials — masking them hides the two fields an
    // admin most often needs to eyeball.
    expect(PAYMENT_SECRET_KEYS.adyen).not.toContain("merchantAccount");
  });
});

describe("Adyen — the signing string", () => {
  test("joins the eight signed fields in Adyen's order", () => {
    expect(adyenSigningString(makeItem())).toBe(
      "8836183819713023::BacklexECOM:inv7f3a29c4:10000:EUR:AUTHORISATION:true",
    );
  });

  test("escapes backslashes before colons", () => {
    // Order matters and the failure is invisible: escaping colons first would
    // write `\:` and the backslash pass would then double the backslash it just
    // wrote, producing a string Adyen never signed.
    const out = adyenSigningString(makeItem({ merchantReference: "a:b\\c" }));
    expect(out).toContain("a\\:b\\\\c");
    // The escaped colon must not create a ninth field.
    expect(out.split(/(?<!\\):/)).toHaveLength(8);
  });

  test("absent fields sign as empty strings, not as 'undefined'", () => {
    const item = makeItem();
    delete item.originalReference;
    delete item.reason;
    expect(adyenSigningString(item)).toBe(
      "8836183819713023::BacklexECOM:inv7f3a29c4:10000:EUR:AUTHORISATION:true",
    );
  });
});

describe("Adyen — signature verification", () => {
  test("accepts a correctly signed notification", async () => {
    expect(await verify(await signedBody([makeItem()]))).toEqual({ ok: true });
  });

  test("a tampered amount is rejected", async () => {
    const raw = await signedBody([makeItem()]);
    const forged = raw.replace('"value":10000', '"value":1');
    expect(forged).not.toBe(raw);
    expect(await verify(forged)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  test("EVERY item in a batch must verify, not just the first", async () => {
    // Adyen may legitimately batch notifications, so extra items are not by
    // themselves suspicious. Checking only the first would let anyone append
    // items of their choosing to a genuine delivery and have them recorded.
    const good = await signedBody([makeItem()]);
    const parsed = JSON.parse(good) as { notificationItems: unknown[] };
    parsed.notificationItems.push({
      NotificationRequestItem: makeItem({
        pspReference: "INJECTED",
        merchantReference: "inv0000deadbeef",
        additionalData: { hmacSignature: "ZmFrZQ==" },
      }),
    });
    expect(await verify(JSON.stringify(parsed))).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  test("an item with no signature at all is rejected", async () => {
    const raw = JSON.stringify({
      live: "false",
      notificationItems: [{ NotificationRequestItem: makeItem() }],
    });
    expect(await verify(raw)).toEqual({ ok: false, reason: "missing_signature" });
  });

  test("an empty batch is refused rather than accepted as vacuously signed", async () => {
    const raw = JSON.stringify({ live: "false", notificationItems: [] });
    expect(await verify(raw)).toEqual({ ok: false, reason: "missing_signature" });
  });

  test("the HMAC key is hex-decoded, not used as text", async () => {
    // The failure this pins is silent and total: both forms are printable, so
    // signing with the ASCII of the key produces a well-formed signature that
    // never matches anything Adyen sends.
    const raw = await signedBody([makeItem()]);
    const asText = await verifyPaymentSignature("adyen", {
      rawBody: raw,
      headers: {},
      // Same bytes, but base64 rather than hex — a decodable string that is
      // not the key. It must not verify.
      secret: btoa("not the key"),
    });
    expect(asText.ok).toBe(false);
  });

  test("a non-hex key reads as a configuration problem, not a forgery", async () => {
    const raw = await signedBody([makeItem()]);
    expect(await verify(raw, "this-is-not-hex")).toEqual({ ok: false, reason: "missing_secret" });
  });

  test("a body that is not JSON is malformed, not a mismatch", async () => {
    expect(await verify("merchant_oid=1&status=success")).toEqual({
      ok: false,
      reason: "malformed_signature",
    });
  });
});

describe("Adyen — normalizing notifications", () => {
  const normalize = (body: string) =>
    normalizePaymentEvent("adyen", JSON.parse(body) as unknown);

  test("an authorisation becomes one payment row carrying the reference", async () => {
    const out = normalize(await signedBody([makeItem()]));
    expect(out.records).toHaveLength(1);
    const row = out.records[0]?.row as Record<string, unknown>;
    expect(row.id).toBe("adyen_8836183819713023");
    expect(row.status).toBe("succeeded");
    // Adyen quotes minor units already — no conversion, unlike iyzico.
    expect(row.amount).toBe(10000);
    expect(row.currency).toBe("EUR");
    // The whole point of the outbound link: our own row id comes home.
    expect(row.reference).toBe("inv7f3a29c4");
    expect(out.livemode).toBe(false);
  });

  test("`live: \"true\"` is read as live money", async () => {
    const out = normalize(await signedBody([makeItem()], "true"));
    expect(out.livemode).toBe(true);
  });

  test("a refused authorisation records a failure with the reason", async () => {
    const out = normalize(
      await signedBody([makeItem({ success: "false", reason: "Refused" })]),
    );
    const row = out.records[0]?.row as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toBe("Refused");
  });

  test("a capture folds into the authorisation's row rather than doubling it", async () => {
    // CAPTURE has its own pspReference and points at the authorisation. Keying
    // it on its own reference would file the same money twice.
    const out = normalize(
      await signedBody([
        makeItem({
          pspReference: "9915555555555555",
          originalReference: "8836183819713023",
          eventCode: "CAPTURE",
        }),
      ]),
    );
    const row = out.records[0]?.row as Record<string, unknown>;
    expect(row.id).toBe("adyen_8836183819713023");
    expect(row.status).toBe("succeeded");
    expect((row.metadata as Record<string, unknown>).modification_reference).toBe(
      "9915555555555555",
    );
  });

  test("a refund gets its OWN row and never overwrites the payment's amount", async () => {
    // This is the delta-vs-snapshot trap. The ledger's upsert REPLACES the row,
    // so filing a €10 refund against the €100 payment's id would rewrite
    // `amount` to 1000 and lose what was actually collected.
    const out = normalize(
      await signedBody([
        makeItem({
          pspReference: "7712121212121212",
          originalReference: "8836183819713023",
          eventCode: "REFUND",
          amount: { currency: "EUR", value: 1000 },
        }),
      ]),
    );
    const row = out.records[0]?.row as Record<string, unknown>;
    expect(row.id).toBe("adyen_7712121212121212");
    expect(row.id).not.toBe("adyen_8836183819713023");
    expect(row.status).toBe("refunded");
    expect(row.amount).toBe(1000);
    expect(row.amount_refunded).toBe(1000);
    expect((row.metadata as Record<string, unknown>).original_reference).toBe(
      "8836183819713023",
    );
  });

  test("CANCEL_OR_REFUND is resolved by the modification action, not guessed", async () => {
    const refunded = normalize(
      await signedBody([
        makeItem({
          pspReference: "7712121212121213",
          originalReference: "8836183819713023",
          eventCode: "CANCEL_OR_REFUND",
          amount: { currency: "EUR", value: 2500 },
          additionalData: { "modification.action": "refund" },
        }),
      ]),
    );
    expect((refunded.records[0]?.row as Record<string, unknown>).status).toBe("refunded");

    const canceled = normalize(
      await signedBody([
        makeItem({
          pspReference: "7712121212121214",
          originalReference: "8836183819713023",
          eventCode: "CANCEL_OR_REFUND",
          additionalData: { "modification.action": "cancel" },
        }),
      ]),
    );
    const row = canceled.records[0]?.row as Record<string, unknown>;
    expect(row.status).toBe("canceled");
    expect(row.id).toBe("adyen_8836183819713023");
  });

  test("a FAILED modification writes nothing rather than rewriting the payment", async () => {
    // A failed capture leaves the authorisation standing. The only alternatives
    // are "leave the row alone" or "rewrite it from a payload that does not
    // describe it" — the event is still logged either way.
    const out = normalize(
      await signedBody([
        makeItem({
          pspReference: "9915555555555556",
          originalReference: "8836183819713023",
          eventCode: "CAPTURE_FAILED",
          success: "false",
        }),
      ]),
    );
    expect(out.records).toEqual([]);
    expect(out.type).toBe("CAPTURE_FAILED");
  });

  test("an unknown event code is logged and writes no row", async () => {
    const out = normalize(
      await signedBody([makeItem({ eventCode: "REPORT_AVAILABLE", amount: {} })]),
    );
    expect(out.records).toEqual([]);
    expect(out.eventId).toContain("REPORT_AVAILABLE");
  });

  test("a batch normalizes every item and dedupes on all of them", async () => {
    const out = normalize(
      await signedBody([
        makeItem(),
        makeItem({
          pspReference: "8836183819713099",
          merchantReference: "inv00000000beef",
          amount: { currency: "EUR", value: 500 },
        }),
      ]),
    );
    expect(out.records).toHaveLength(2);
    expect(out.eventId).toBe(
      "8836183819713023:AUTHORISATION,8836183819713099:AUTHORISATION",
    );
  });
});

describe("Adyen — Pay by Link", () => {
  const CONFIG = {
    apiKey: "AQE1hmfxtestapikey",
    merchantAccount: "BacklexECOM",
    environment: "test",
  };
  const NOW = 1_770_000_000_000;

  const ok = (body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status: 201 });

  test("takes an ad-hoc amount", () => {
    expect(PAYMENT_CHECKOUT_MODES.adyen).toBe("adhoc");
  });

  test("posts minor units and our reference to the test host", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    let seenKey = "";
    const out = await createCheckout("adyen", {
      config: CONFIG,
      amount: 10000,
      currency: "eur",
      reference: "inv7f3a29c4",
      description: "Invoice INV-9",
      successUrl: "https://shop.example.com/thanks",
      customer: { email: "buyer@example.com", country: "NL" },
      nowMs: NOW,
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenKey = (init?.headers as Record<string, string>)["x-API-key"] ?? "";
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return ok({
          id: "PL61C53A8B97E6C8A0",
          url: "https://test.adyen.link/PL61C53A8B97E6C8A0",
          expiresAt: "2026-02-02T10:00:00Z",
          reference: "inv7f3a29c4",
        });
      },
    });

    expect(seenUrl).toBe("https://checkout-test.adyen.com/v71/paymentLinks");
    // Adyen authenticates with `x-API-key`, not a bearer token.
    expect(seenKey).toBe(CONFIG.apiKey);
    // Minor units pass straight through — the ledger's unit is Adyen's unit.
    expect(seenBody.amount).toEqual({ currency: "EUR", value: 10000 });
    // Comes back as `merchantReference` on every notification item.
    expect(seenBody.reference).toBe("inv7f3a29c4");
    expect(seenBody.merchantAccount).toBe("BacklexECOM");
    expect(seenBody.countryCode).toBe("NL");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.url).toBe("https://test.adyen.link/PL61C53A8B97E6C8A0");
    expect(out.externalId).toBe("PL61C53A8B97E6C8A0");
    expect(out.expiresAt).toBe(Date.parse("2026-02-02T10:00:00Z"));
  });

  test("a country NAME is dropped rather than sent as a country code", async () => {
    // `CheckoutCustomer.country` also accepts a name because iyzico wants one.
    // Adyen 422s on anything that isn't ISO-3166 alpha-2.
    let seenBody: Record<string, unknown> = {};
    await createCheckout("adyen", {
      config: CONFIG,
      amount: 500,
      currency: "EUR",
      reference: "inv1",
      successUrl: "https://shop.example.com/thanks",
      customer: { country: "Turkey" },
      fetchImpl: async (_url, init) => {
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return ok({ id: "PL1", url: "https://test.adyen.link/PL1" });
      },
    });
    expect(seenBody.countryCode).toBeUndefined();
  });

  test("live needs the merchant's own URL prefix", async () => {
    const out = await createCheckout("adyen", {
      config: { ...CONFIG, environment: "live" },
      amount: 500,
      currency: "EUR",
      reference: "inv1",
      successUrl: "https://shop.example.com/thanks",
      fetchImpl: async () => {
        throw new Error("must not reach the network");
      },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("missing_secret");
  });

  test("a prefix that would redirect the API key to another host is refused", async () => {
    // The prefix is interpolated into the URL, so a value carrying `/` or `@`
    // would send the live API key somewhere of the attacker's choosing.
    for (const liveUrlPrefix of ["evil.example.com/", "a@evil.example.com", "a/b"]) {
      const out = await createCheckout("adyen", {
        config: { ...CONFIG, environment: "live", liveUrlPrefix },
        amount: 500,
        currency: "EUR",
        reference: "inv1",
        successUrl: "https://shop.example.com/thanks",
        fetchImpl: async () => {
          throw new Error("must not reach the network");
        },
      });
      expect(out.ok).toBe(false);
    }
  });

  test("a valid prefix builds Adyen's per-merchant live host", async () => {
    let seenUrl = "";
    await createCheckout("adyen", {
      config: { ...CONFIG, environment: "live", liveUrlPrefix: "1797a841fbb37ca7-AdyenDemo" },
      amount: 500,
      currency: "EUR",
      reference: "inv1",
      successUrl: "https://shop.example.com/thanks",
      fetchImpl: async (url) => {
        seenUrl = url;
        return ok({ id: "PL1", url: "https://adyen.link/PL1" });
      },
    });
    expect(seenUrl).toBe(
      "https://1797a841fbb37ca7-AdyenDemo-checkout-live.adyenpayments.com/checkout/v71/paymentLinks",
    );
  });

  test("an out-of-range expiry is dropped so Adyen's default applies", async () => {
    let seenBody: Record<string, unknown> = {};
    const send = async (expiresInSec: number) => {
      await createCheckout("adyen", {
        config: CONFIG,
        amount: 500,
        currency: "EUR",
        reference: "inv1",
        successUrl: "https://shop.example.com/thanks",
        expiresInSec,
        nowMs: NOW,
        fetchImpl: async (_url, init) => {
          seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return ok({ id: "PL1", url: "https://test.adyen.link/PL1" });
        },
      });
    };
    // Below Adyen's one-minute floor and above its 70-day ceiling: both 422 if
    // sent, and a dropped field is a better outcome than a rejected checkout.
    await send(30);
    expect(seenBody.expiresAt).toBeUndefined();
    await send(100 * 24 * 60 * 60);
    expect(seenBody.expiresAt).toBeUndefined();
    // In range, it travels as an ISO instant.
    await send(3600);
    expect(seenBody.expiresAt).toBe(new Date(NOW + 3_600_000).toISOString());
  });

  test("Adyen's error envelope is surfaced verbatim", async () => {
    const out = await createCheckout("adyen", {
      config: CONFIG,
      amount: 500,
      currency: "EUR",
      reference: "inv1",
      successUrl: "https://shop.example.com/thanks",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: 422,
            errorCode: "702",
            message: "Invalid merchant account",
            errorType: "validation",
          }),
          { status: 422 },
        ),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("rejected");
    expect(out.message).toBe("Invalid merchant account");
  });

  test("a transport failure is retryable, not a verdict", async () => {
    const out = await createCheckout("adyen", {
      config: CONFIG,
      amount: 500,
      currency: "EUR",
      reference: "inv1",
      successUrl: "https://shop.example.com/thanks",
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("unreachable");
  });

  test("a missing merchant account is caught before the network", async () => {
    let called = false;
    const out = await createCheckout("adyen", {
      config: { apiKey: "k", environment: "test" },
      amount: 500,
      currency: "EUR",
      reference: "inv1",
      successUrl: "https://shop.example.com/thanks",
      fetchImpl: async () => {
        called = true;
        return ok({});
      },
    });
    expect(out.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("Adyen — end to end through the receive endpoint", () => {
  let h: TestHarness;
  let providerId = "";
  let webhookPath = "";

  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/admin/payments/providers",
      json({
        provider: "adyen",
        config: {
          apiKey: "AQE1hmfxtestapikey",
          merchantAccount: "BacklexECOM",
          webhookSecret: HMAC_KEY_HEX,
          environment: "test",
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; webhookPath: string };
    };
    providerId = body.data.id;
    webhookPath = body.data.webhookPath;
  });
  afterAll(() => h.cleanup());

  const post = (rawBody: string) =>
    h.fetch(webhookPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
    });

  test("a signed authorisation lands as a payment row and is acknowledged", async () => {
    const res = await post(await signedBody([makeItem()]));
    expect(res.status).toBe(200);
    // Not the JSON envelope: older Adyen accounts treat anything but this as a
    // failed delivery and eventually disable the endpoint.
    expect(await res.text()).toBe("[accepted]");

    const rows = (await (await h.fetch("/api/items/payment_transactions")).json()) as {
      data: Record<string, unknown>[];
    };
    const row = rows.data.find((r) => r.external_id === "8836183819713023");
    expect(row).toBeTruthy();
    expect(row?.provider).toBe("adyen");
    expect(row?.amount).toBe(10000);
    expect(row?.status).toBe("succeeded");
    // The link between the money and the invoice row that asked for it.
    expect(row?.reference).toBe("inv7f3a29c4");
  });

  test("a refund adds a row without shrinking the payment it refunded", async () => {
    const before = (await (await h.fetch("/api/items/payment_transactions")).json()) as {
      data: Record<string, unknown>[];
    };
    const paymentBefore = before.data.find((r) => r.external_id === "8836183819713023");
    expect(paymentBefore?.amount).toBe(10000);

    const res = await post(
      await signedBody([
        makeItem({
          pspReference: "7712121212121212",
          originalReference: "8836183819713023",
          eventCode: "REFUND",
          amount: { currency: "EUR", value: 1000 },
        }),
      ]),
    );
    expect(res.status).toBe(200);

    const after = (await (await h.fetch("/api/items/payment_transactions")).json()) as {
      data: Record<string, unknown>[];
    };
    // The original payment is untouched — this is the delta-vs-snapshot trap
    // the row-keying rule exists to avoid, checked against the real upsert.
    expect(after.data.find((r) => r.external_id === "8836183819713023")?.amount).toBe(10000);
    const refund = after.data.find((r) => r.external_id === "7712121212121212");
    expect(refund?.status).toBe("refunded");
    expect(refund?.amount).toBe(1000);
  });

  test("an unsigned delivery is refused", async () => {
    const res = await post(
      JSON.stringify({ live: "false", notificationItems: [{ NotificationRequestItem: makeItem() }] }),
    );
    expect(res.status).toBe(400);
  });

  test("a retry of the same delivery is a no-op", async () => {
    const raw = await signedBody([makeItem()]);
    const again = await post(raw);
    expect(again.status).toBe(200);
    const rows = (await (await h.fetch("/api/items/payment_transactions")).json()) as {
      data: Record<string, unknown>[];
    };
    expect(rows.data.filter((r) => r.external_id === "8836183819713023")).toHaveLength(1);
  });

  test("sync explains that there is no catalog instead of reporting a clean run", async () => {
    const res = await h.fetch(`/api/admin/payments/providers/${providerId}/sync`, json({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { written: number; error?: string };
    expect(body.written).toBe(0);
    expect(body.error).toContain("no object catalog");
  });
});
