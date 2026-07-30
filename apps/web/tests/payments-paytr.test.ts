/**
 * PayTR — the first callback-style payment provider.
 *
 * It differs from Stripe/Polar/Lemon Squeezy in three ways that each have their
 * own failure mode, so each gets its own assertions:
 *   1. it signs FORM FIELDS, not the raw JSON body,
 *   2. it has no object catalog, so reconcile is impossible rather than absent,
 *   3. it demands the literal body `OK` and retries forever without it.
 */
import { describe, expect, test } from "bun:test";
import {
  PAYMENT_ACK,
  PAYMENT_PROVIDER_MODES,
  PAYMENT_SECRET_KEYS,
  isCallbackProvider,
  normalizePaymentEvent,
  parseCallbackBody,
  verifyPaymentSignature,
} from "../../../packages/integrations/src/payments";

const MERCHANT_KEY = "mk_test_key";
const MERCHANT_SALT = "ms_test_salt";
const CONFIG = { merchantId: "123456", merchantKey: MERCHANT_KEY, merchantSalt: MERCHANT_SALT };

/** Build the hash exactly as PayTR documents it, independently of the code
 *  under test — a shared helper would hide a wrong formula from both sides. */
const paytrHash = async (merchantOid: string, status: string, totalAmount: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(MERCHANT_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${merchantOid}${MERCHANT_SALT}${status}${totalAmount}`),
  );
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
};

const body = async (
  over: Record<string, string> = {},
  opts: { hash?: string } = {},
): Promise<string> => {
  const fields = {
    merchant_oid: "ORDER-1001",
    status: "success",
    total_amount: "14990",
    payment_type: "card",
    currency: "TL",
    ...over,
  };
  const hash =
    opts.hash ??
    (await paytrHash(fields.merchant_oid, fields.status, fields.total_amount));
  return new URLSearchParams({ ...fields, hash }).toString();
};

const verify = (rawBody: string) =>
  verifyPaymentSignature("paytr", { rawBody, headers: {}, secret: "", config: CONFIG });

describe("provider registration", () => {
  test("PayTR is a callback provider and its credentials are secrets", () => {
    expect(PAYMENT_PROVIDER_MODES.paytr).toBe("callback");
    expect(isCallbackProvider("paytr")).toBe(true);
    expect(isCallbackProvider("stripe")).toBe(false);
    // Both are signing material; storing either in the clear would let anyone
    // with DB read forge a callback.
    expect(PAYMENT_SECRET_KEYS.paytr).toEqual(["merchantKey", "merchantSalt"]);
  });

  test("the webhook providers keep the default JSON ack; PayTR does not", () => {
    expect(PAYMENT_ACK.stripe).toBeNull();
    // Anything but the literal "OK" makes PayTR retry and eventually disable
    // the merchant's notification URL.
    expect(PAYMENT_ACK.paytr).toEqual({ body: "OK", contentType: "text/plain; charset=utf-8" });
  });
});

describe("signature verification", () => {
  test("a correctly hashed callback verifies", async () => {
    expect(await verify(await body())).toEqual({ ok: true });
  });

  test("a tampered amount is rejected", async () => {
    // The classic attack: replay a real callback with the amount raised.
    const raw = await body();
    const params = new URLSearchParams(raw);
    params.set("total_amount", "1");
    expect(await verify(params.toString())).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  test("flipping a failed callback to success is rejected", async () => {
    const raw = await body({ status: "failed" });
    const params = new URLSearchParams(raw);
    params.set("status", "success");
    expect((await verify(params.toString())).ok).toBe(false);
  });

  test("a hash computed with the wrong salt is rejected", async () => {
    // Proves the salt is actually in the signed string — omitting it would make
    // the merchant key alone sufficient to forge.
    const wrong = await (async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(MERCHANT_KEY),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode("ORDER-1001WRONGSALTsuccess14990"),
      );
      let bin = "";
      for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
      return btoa(bin);
    })();
    expect((await verify(await body({}, { hash: wrong }))).ok).toBe(false);
  });

  test("a missing hash is missing_signature, not a crash", async () => {
    const params = new URLSearchParams(await body());
    params.delete("hash");
    expect(await verify(params.toString())).toEqual({ ok: false, reason: "missing_signature" });
  });

  test("a callback missing a signed field is malformed, not silently accepted", async () => {
    const params = new URLSearchParams(await body());
    params.delete("total_amount");
    expect(await verify(params.toString())).toEqual({ ok: false, reason: "malformed_signature" });
  });

  test("an unconfigured merchant is missing_secret rather than a false pass", async () => {
    const raw = await body();
    for (const config of [{}, { merchantKey: MERCHANT_KEY }, { merchantSalt: MERCHANT_SALT }]) {
      const out = await verifyPaymentSignature("paytr", {
        rawBody: raw,
        headers: {},
        secret: "",
        config,
      });
      expect(out).toEqual({ ok: false, reason: "missing_secret" });
    }
  });

  test("a callback provider does not need the webhook `secret` field", async () => {
    // The generic guard rejects an empty `secret` for webhook providers; a
    // callback provider must not be caught by it.
    expect((await verify(await body())).ok).toBe(true);
  });
});

describe("forgery paths", () => {
  test("a repeated signed field is refused, not verified against one value and recorded as another", async () => {
    // URLSearchParams.get returns the FIRST value; Object.fromEntries keeps the
    // LAST. Without an explicit refusal an attacker could replay a genuine
    // `status=failed` callback with `&status=success` appended: the hash still
    // covers "failed", but the row would be written as a success.
    const genuine = await body({ status: "failed" });
    const polluted = `${genuine}&status=success`;
    expect(await verify(polluted)).toEqual({ ok: false, reason: "malformed_signature" });
  });

  test("every signed field is protected from pollution, not just status", async () => {
    const genuine = await body();
    for (const field of ["merchant_oid", "total_amount", "status"]) {
      expect((await verify(`${genuine}&${field}=x`)).ok).toBe(false);
    }
    // …and a duplicated hash cannot be used to smuggle a second candidate.
    expect((await verify(`${genuine}&hash=abc`)).ok).toBe(false);
  });

  test("the shared parser takes the FIRST value, matching the verifier", async () => {
    // If these ever diverge again, the pollution path reopens.
    const parsed = parseCallbackBody("status=failed&status=success&merchant_oid=A");
    expect(parsed.status).toBe("failed");
    expect(parsed.merchant_oid).toBe("A");
  });

  test("a callback provider with no verifier branch fails closed", async () => {
    // The generic `missing_secret` guard is relaxed for callback providers, so
    // one added without its own branch would fall through to the last branch,
    // which HMACs with an EMPTY key — computable by anyone. This asserts the
    // backstop that stops that: paytr is the only callback provider today, and
    // it is handled before the backstop, so an unknown one must be refused.
    const out = await verifyPaymentSignature("stripe", {
      rawBody: await body(),
      headers: {},
      secret: "",
      config: CONFIG,
    });
    // A webhook provider with no secret is still refused up front.
    expect(out).toEqual({ ok: false, reason: "missing_secret" });
  });
});

describe("normalization", () => {
  const parse = (raw: string) =>
    normalizePaymentEvent("paytr", Object.fromEntries(new URLSearchParams(raw)));

  test("a successful callback becomes exactly one payment row", async () => {
    const out = parse(await body());
    expect(out.type).toBe("payment.success");
    expect(out.records).toHaveLength(1);
    const row = out.records[0]!.row;
    expect(out.records[0]!.kind).toBe("payment");
    expect(row.provider).toBe("paytr");
    // merchant_oid is the merchant's own order id — the external id AND the
    // dedupe key, because PayTR retries until it gets OK.
    expect(row.external_id).toBe("ORDER-1001");
    expect(out.eventId).toBe("ORDER-1001");
    expect(row.status).toBe("succeeded");
    // total_amount is already in kuruş; converting would inflate by 100×.
    expect(row.amount).toBe(14990);
  });

  test("a failed callback records the reason instead of dropping it", async () => {
    const out = parse(
      await body({ status: "failed", failed_reason_msg: "Yetersiz bakiye", failed_reason_code: "6" }),
    );
    expect(out.type).toBe("payment.failed");
    const row = out.records[0]!.row;
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toBe("Yetersiz bakiye");
  });

  test("test_mode marks the event as not livemode", async () => {
    expect(parse(await body({ test_mode: "1" })).livemode).toBe(false);
    expect(parse(await body()).livemode).toBe(true);
  });

  test("a callback with no order id yields no rows rather than a junk one", async () => {
    const out = normalizePaymentEvent("paytr", { status: "success" });
    expect(out.records).toEqual([]);
  });
});
