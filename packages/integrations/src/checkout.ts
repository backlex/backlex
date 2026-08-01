/**
 * @backlex/integrations/checkout — asking for money.
 *
 * `./payments.ts` is inbound-only: it parses what a provider tells us happened.
 * Nothing in it ever *initiates* a payment, so a workspace whose `invoices`
 * collection is full of unpaid rows had no way to hand a customer a link. This
 * module is the other direction — hand it an amount and get back a hosted
 * checkout URL.
 *
 * Same contract as the rest of the package: pure, no DB, no env, no
 * persistence. The one capability it needs is `crypto.subtle` (PayTR and
 * iyzico both authenticate the outbound request with an HMAC), which every
 * backlex runtime has.
 *
 * ## The two provider shapes
 *
 * `adhoc` — hand the provider an amount and it mints a one-off checkout.
 * Stripe (`price_data`), PayTR (`get-token`), iyzico
 * (`checkoutform/initialize`) and Adyen (`paymentLinks`) all work this way,
 * and it is the shape the templates need: an invoice row carries an amount
 * that exists nowhere in the provider's catalog.
 *
 * `catalog` — Polar, Lemon Squeezy and Paddle mint a checkout against a
 * PRE-EXISTING product/price id. There is no amount parameter; you send a
 * `priceId` and the provider decides what it costs. That is a genuinely
 * different call shape and a different admin workflow (somebody has to create
 * the product first), so it is not implemented here — `createCheckout` returns
 * an explicit `catalog_only` refusal naming what is missing rather than
 * failing in a way that reads like an outage.
 *
 * ## `reference` is the whole point
 *
 * Without it this module is a URL generator. Our own row identifier travels out
 * with the checkout (Stripe `client_reference_id`, PayTR `merchant_oid`,
 * iyzico `conversationId`, Adyen `reference`) and comes back on the settlement
 * event, where
 * `./payments.ts` lifts it onto the payment record. That is what ties a
 * received payment to the invoice it paid.
 *
 * The catch is PayTR: `merchant_oid` must be ALPHANUMERIC. So the reference
 * contract for every provider is the narrowest one any of them imposes —
 * `[A-Za-z0-9]{1,48}` — rather than per-provider mangling that would make the
 * value that comes back differ from the value that went out.
 */

import {
  DUMMY_CHECKOUT_DOMAIN,
  DUMMY_SETTLEMENT_DOMAIN,
  hmac,
  toBase64,
  toHex,
} from "./payment-crypto";
import {
  type FetchLike,
  type PaymentProvider,
  isPaymentProvider,
  toMajorUnits,
} from "./payments";

// ── Capability table ────────────────────────────────────────────────────────

export type PaymentCheckoutMode = "adhoc" | "catalog";

/**
 * How (or whether) each provider can be asked for a checkout.
 *
 * `null` would mean "no hosted checkout at all". Every provider currently
 * connected has one, but the column exists so a future acquirer that only
 * reports settlements has somewhere honest to sit instead of being lumped in
 * with `catalog`.
 */
export const PAYMENT_CHECKOUT_MODES: Record<PaymentProvider, PaymentCheckoutMode | null> = {
  stripe: "adhoc",
  paytr: "adhoc",
  iyzico: "adhoc",
  // Pay by Link takes a bare amount, so Adyen is `adhoc` despite being an
  // acquirer rather than a billing platform.
  adyen: "adhoc",
  dummy: "adhoc",
  polar: "catalog",
  lemonsqueezy: "catalog",
  paddle: "catalog",
};

export const checkoutModeOf = (provider: string): PaymentCheckoutMode | null =>
  PAYMENT_CHECKOUT_MODES[provider as PaymentProvider] ?? null;

/** Can this provider mint a checkout for an arbitrary amount today? */
export const supportsAdhocCheckout = (provider: string): boolean =>
  checkoutModeOf(provider) === "adhoc";

// ── Contract ────────────────────────────────────────────────────────────────

/**
 * The reference contract, set by the strictest provider (PayTR's
 * `merchant_oid`). The consumer derives one from its own row id; 48 characters
 * comfortably fits a dash-stripped UUID.
 */
export const CHECKOUT_REFERENCE_PATTERN = /^[A-Za-z0-9]{1,48}$/;

/** Strip a row id down to something every provider will carry. A UUID becomes
 *  its 32-hex form, which is still unique and still recognisable. */
export const toCheckoutReference = (raw: string): string =>
  String(raw ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 48);

export interface CheckoutCustomer {
  email?: string;
  name?: string;
  /** E.164 preferred; iyzico wants a `gsmNumber` and PayTR a `user_phone`. */
  phone?: string;
  address?: string;
  city?: string;
  /** ISO-3166 alpha-2 or the provider's own country name. */
  country?: string;
  /**
   * iyzico requires an identity number on the buyer. Turkish regulation is why
   * it exists; iyzico's own documentation uses a repunit placeholder for
   * merchants that don't collect it, and that is the default here.
   */
  identityNumber?: string;
}

export interface CheckoutInput {
  /** DECRYPTED provider config — the consumer owns encryption at rest. */
  config: Record<string, unknown>;
  /** MINOR units, matching what `payment_transactions.amount` stores. */
  amount: number;
  /** ISO-4217. Lower/upper case is normalised per provider. */
  currency: string;
  /** Our own row identifier. Must match `CHECKOUT_REFERENCE_PATTERN`. */
  reference: string;
  /** What the customer sees on the checkout line item. */
  description?: string;
  customer?: CheckoutCustomer;
  /** Where the provider sends the customer after a successful payment. */
  successUrl: string;
  /** Where it sends them after a cancel or failure. Defaults to `successUrl`
   *  — a provider that requires both (all three of these do) must be given
   *  something rather than a blank that fails validation on their side. */
  cancelUrl?: string;
  /**
   * Where the provider POSTs the settlement.
   *
   * Required by PayTR and iyzico, which have no dashboard-configured endpoint
   * for a hosted checkout — the URL travels WITH the request. Stripe ignores
   * it (its webhook endpoint is configured once, in the dashboard).
   */
  callbackUrl?: string;
  /**
   * The PAYING CUSTOMER's IP. PayTR folds it into the token hash and uses it
   * for fraud scoring, so a placeholder would be both a lie and a support
   * ticket. Absent, a PayTR checkout is refused rather than faked.
   */
  customerIp?: string;
  /** Catalog providers: the pre-existing product/price/variant id. */
  priceId?: string;
  /** Seconds until the hosted page stops accepting payment. */
  expiresInSec?: number;
  /** BCP-47-ish locale hint. Providers take their own dialect of this. */
  locale?: string;
  /** Origin the `dummy` provider's hosted page is served from. Ignored by
   *  every real provider. */
  hostedBaseUrl?: string;
  /** The provider row's webhook token — routing key for the `dummy` page. */
  hostedToken?: string;
  fetchImpl?: FetchLike;
  /** Injectable clock (ms) so tests don't depend on wall time. */
  nowMs?: number;
}

export type CheckoutFailure =
  /** Not a provider we know at all. */
  | "unknown_provider"
  /** Known provider, but it has no hosted checkout. */
  | "unsupported"
  /** Known provider whose checkout needs a pre-made product/price id. */
  | "catalog_only"
  /** The stored config is missing a credential this call needs. */
  | "missing_secret"
  /** The CALLER's input is wrong — amount, reference, or a required field. */
  | "invalid_input"
  /** Transport failure. Not a verdict: safe to retry. */
  | "unreachable"
  /** The provider answered and said no. */
  | "rejected";

export type CheckoutResult =
  | {
      ok: true;
      /** Where to send the customer. */
      url: string;
      /** The provider's own id for this checkout (session id / token). */
      externalId: string;
      /** Epoch ms, or null when the provider doesn't say. */
      expiresAt: number | null;
      /** Echoed back so a caller that let us derive it knows what to store. */
      reference: string;
    }
  | { ok: false; reason: CheckoutFailure; message: string };

// ── Small local helpers ─────────────────────────────────────────────────────

const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null;

const fail = (reason: CheckoutFailure, message: string): CheckoutResult => ({
  ok: false,
  reason,
  message,
});

const doFetch = (input: CheckoutInput): FetchLike =>
  input.fetchImpl ?? ((i, init) => fetch(i, init));

const form = (params: Record<string, string | undefined>): string => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v);
  return body.toString();
};

/** Split a display name into iyzico's required name/surname pair. A single
 *  word repeats rather than sending an empty surname, which iyzico rejects. */
const splitName = (full: string | undefined): { name: string; surname: string } => {
  const parts = String(full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { name: "Customer", surname: "Customer" };
  if (parts.length === 1) return { name: parts[0] as string, surname: parts[0] as string };
  return { name: parts.slice(0, -1).join(" "), surname: parts[parts.length - 1] as string };
};

// ── Shared input validation ─────────────────────────────────────────────────

/**
 * Everything that is wrong regardless of provider.
 *
 * Checked BEFORE dispatch so a bad amount reads the same whichever provider is
 * connected — and, more importantly, so an invalid reference never reaches a
 * provider. A checkout minted with a reference the settlement can't carry back
 * is worse than no checkout: the money arrives and nothing knows what it paid
 * for.
 */
const validateCommon = (input: CheckoutInput): CheckoutResult | null => {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return fail(
      "invalid_input",
      `amount must be a positive integer in minor units (got ${JSON.stringify(input.amount)})`,
    );
  }
  if (!/^[A-Za-z]{3}$/.test(String(input.currency ?? ""))) {
    return fail("invalid_input", `currency must be a 3-letter ISO-4217 code (got "${input.currency}")`);
  }
  if (!CHECKOUT_REFERENCE_PATTERN.test(String(input.reference ?? ""))) {
    return fail(
      "invalid_input",
      "reference must be 1–48 alphanumeric characters — it travels out with the " +
        "checkout and comes back on the settlement event, and PayTR's `merchant_oid` " +
        "accepts nothing else",
    );
  }
  if (!input.successUrl) return fail("invalid_input", "successUrl is required");
  return null;
};

// ── Stripe ──────────────────────────────────────────────────────────────────

const STRIPE_API = "https://api.stripe.com/v1/checkout/sessions";

/** Stripe's own bounds on `expires_at`: no sooner than 30 minutes, no later
 *  than 24 hours. An out-of-range value is dropped rather than sent — the
 *  default (24h) is a better outcome than a 400. */
const STRIPE_MIN_EXPIRY_SEC = 30 * 60;
const STRIPE_MAX_EXPIRY_SEC = 24 * 60 * 60;

const stripeCheckout = async (input: CheckoutInput): Promise<CheckoutResult> => {
  const apiKey = str(input.config.apiKey);
  if (!apiKey) return fail("missing_secret", "Stripe needs its secret API key to open a checkout");

  const now = input.nowMs ?? Date.now();
  const params: Record<string, string | undefined> = {
    mode: "payment",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl ?? input.successUrl,
    // The documented field for a merchant's own identifier. It comes back on
    // `checkout.session.*` verbatim.
    client_reference_id: input.reference,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": input.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(input.amount),
    "line_items[0][price_data][product_data][name]": input.description || "Payment",
    // Belt and braces: `client_reference_id` rides the SESSION, but a
    // reconcile that walks charges sees the payment intent, whose metadata is
    // copied from here.
    "metadata[backlex_reference]": input.reference,
    "payment_intent_data[metadata][backlex_reference]": input.reference,
    customer_email: input.customer?.email || undefined,
    locale: input.locale || undefined,
  };
  if (input.expiresInSec) {
    const clamped =
      input.expiresInSec >= STRIPE_MIN_EXPIRY_SEC && input.expiresInSec <= STRIPE_MAX_EXPIRY_SEC
        ? input.expiresInSec
        : null;
    if (clamped) params.expires_at = String(Math.floor(now / 1000) + clamped);
  }

  let res: Response;
  try {
    res = await doFetch(input)(STRIPE_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form(params),
    });
  } catch (e) {
    return fail("unreachable", `Could not reach Stripe: ${(e as Error).message}`);
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return fail("unreachable", `Stripe returned a non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const err = body.error as Record<string, unknown> | undefined;
    return fail("rejected", str(err?.message) ?? `Stripe rejected the checkout (HTTP ${res.status})`);
  }
  const url = str(body.url);
  const id = str(body.id);
  if (!url || !id) return fail("rejected", "Stripe returned a session with no URL");
  const expires = typeof body.expires_at === "number" ? body.expires_at * 1000 : null;
  return { ok: true, url, externalId: id, expiresAt: expires, reference: input.reference };
};

// ── PayTR ───────────────────────────────────────────────────────────────────

const PAYTR_TOKEN_API = "https://www.paytr.com/odeme/api/get-token";
const PAYTR_PAY_BASE = "https://www.paytr.com/odeme/guvenli";

/**
 * PayTR names TRY "TL" and only accepts a handful of others. An unknown code
 * is passed through rather than silently rewritten — PayTR's own error is more
 * informative than a guess.
 */
const paytrCurrency = (currency: string): string => {
  const c = currency.toUpperCase();
  return c === "TRY" ? "TL" : c;
};

/**
 * PayTR's token hash.
 *
 * base64(HMAC-SHA256(merchant_id + user_ip + merchant_oid + email +
 *   payment_amount + user_basket + no_installment + max_installment +
 *   currency + test_mode + merchant_salt, merchant_key))
 *
 * Field ORDER is load-bearing and PayTR gives no diagnostic beyond a generic
 * failure, so the concatenation is built from one array rather than inline.
 */
export const paytrTokenHash = async (
  fields: {
    merchantId: string;
    userIp: string;
    merchantOid: string;
    email: string;
    paymentAmount: string;
    userBasket: string;
    noInstallment: string;
    maxInstallment: string;
    currency: string;
    testMode: string;
  },
  merchantKey: string,
  merchantSalt: string,
): Promise<string> => {
  const message =
    [
      fields.merchantId,
      fields.userIp,
      fields.merchantOid,
      fields.email,
      fields.paymentAmount,
      fields.userBasket,
      fields.noInstallment,
      fields.maxInstallment,
      fields.currency,
      fields.testMode,
    ].join("") + merchantSalt;
  return toBase64(await hmac(new TextEncoder().encode(merchantKey), message));
};

const paytrCheckout = async (input: CheckoutInput): Promise<CheckoutResult> => {
  const merchantId = str(input.config.merchantId);
  const merchantKey = str(input.config.merchantKey);
  const merchantSalt = str(input.config.merchantSalt);
  if (!merchantId || !merchantKey || !merchantSalt) {
    return fail("missing_secret", "PayTR needs its merchant id, key and salt to open a checkout");
  }
  const email = str(input.customer?.email);
  if (!email) return fail("invalid_input", "PayTR requires the customer's email address");
  if (!input.customerIp) {
    // PayTR hashes the payer's IP and scores it for fraud. Sending a
    // placeholder would produce a checkout that works in testing and gets the
    // merchant's real transactions declined.
    return fail("invalid_input", "PayTR requires the paying customer's IP address (`customerIp`)");
  }
  if (!input.callbackUrl) {
    return fail("invalid_input", "PayTR requires a callback URL to report the settlement to");
  }

  const currency = paytrCurrency(input.currency);
  const testMode = str(input.config.environment) === "test" ? "1" : "0";
  const paymentAmount = String(input.amount);
  // `[[name, unit price as a major-unit string, quantity]]`, base64'd.
  const userBasket = toBase64(
    new TextEncoder().encode(
      JSON.stringify([[input.description || "Payment", toMajorUnits(input.amount, input.currency), 1]]),
    ),
  );
  const noInstallment = "0";
  const maxInstallment = "0";

  const paytrToken = await paytrTokenHash(
    {
      merchantId,
      userIp: input.customerIp,
      merchantOid: input.reference,
      email,
      paymentAmount,
      userBasket,
      noInstallment,
      maxInstallment,
      currency,
      testMode,
    },
    merchantKey,
    merchantSalt,
  );

  const body = form({
    merchant_id: merchantId,
    user_ip: input.customerIp,
    merchant_oid: input.reference,
    email,
    payment_amount: paymentAmount,
    paytr_token: paytrToken,
    user_basket: userBasket,
    debug_on: "0",
    no_installment: noInstallment,
    max_installment: maxInstallment,
    user_name: input.customer?.name || "Customer",
    user_address: input.customer?.address || "-",
    user_phone: input.customer?.phone || "-",
    merchant_ok_url: input.successUrl,
    merchant_fail_url: input.cancelUrl ?? input.successUrl,
    // PayTR posts the settlement here, per checkout — there is no dashboard
    // endpoint for the hosted form.
    merchant_notify_url: input.callbackUrl,
    timeout_limit: "30",
    currency,
    test_mode: testMode,
    lang: (input.locale ?? "tr").slice(0, 2),
  });

  let res: Response;
  try {
    res = await doFetch(input)(PAYTR_TOKEN_API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    return fail("unreachable", `Could not reach PayTR: ${(e as Error).message}`);
  }
  if (!res.ok) return fail("unreachable", `PayTR returned HTTP ${res.status}`);

  let payload: Record<string, unknown>;
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    return fail("unreachable", "PayTR returned a non-JSON response");
  }
  if (str(payload.status) !== "success") {
    return fail("rejected", str(payload.reason) ?? "PayTR rejected the token request");
  }
  const token = str(payload.token);
  if (!token) return fail("rejected", "PayTR reported success with no token");

  return {
    ok: true,
    url: `${PAYTR_PAY_BASE}/${token}`,
    externalId: token,
    // `timeout_limit` is 30 minutes, expressed to PayTR in minutes.
    expiresAt: (input.nowMs ?? Date.now()) + 30 * 60_000,
    reference: input.reference,
  };
};

// ── iyzico ──────────────────────────────────────────────────────────────────

const IYZICO_HOSTS = {
  production: "https://api.iyzipay.com",
  sandbox: "https://sandbox-api.iyzipay.com",
} as const;

const IYZICO_INIT_PATH = "/payment/iyzipos/checkoutform/initialize/auth/ecom";

/**
 * iyzico's IYZWSv2 request authentication — the same construction the retrieve
 * call in `./payments.ts` uses, against a different path.
 *
 * signature = hex(HMAC-SHA256(secretKey, randomKey + uriPath + requestBody))
 * Authorization: IYZWSv2 base64("apiKey:…&randomKey:…&signature:…")
 */
const iyzicoAuthHeaders = async (
  apiKey: string,
  secretKey: string,
  uriPath: string,
  body: string,
  randomKey: string,
): Promise<Record<string, string>> => {
  const signature = toHex(
    await hmac(new TextEncoder().encode(secretKey), `${randomKey}${uriPath}${body}`),
  );
  return {
    Authorization: `IYZWSv2 ${btoa(`apiKey:${apiKey}&randomKey:${randomKey}&signature:${signature}`)}`,
    "x-iyzi-rnd": randomKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
};

/** iyzico's documented placeholder for merchants that don't collect one. */
const IYZICO_PLACEHOLDER_IDENTITY = "11111111111";

const iyzicoCheckout = async (input: CheckoutInput): Promise<CheckoutResult> => {
  const apiKey = str(input.config.apiKey);
  const secretKey = str(input.config.secretKey);
  if (!apiKey || !secretKey) {
    return fail("missing_secret", "iyzico needs its API key and secret key to open a checkout");
  }
  const email = str(input.customer?.email);
  if (!email) return fail("invalid_input", "iyzico requires the customer's email address");
  if (!input.callbackUrl) {
    return fail("invalid_input", "iyzico requires a callback URL to report the settlement to");
  }

  const host =
    str(input.config.environment) === "sandbox" ? IYZICO_HOSTS.sandbox : IYZICO_HOSTS.production;
  // iyzico quotes money as major-unit decimals on the way out, while the
  // ledger stores minor units — the same conversion the inbound normalizer
  // does in reverse.
  const price = toMajorUnits(input.amount, input.currency);
  const { name, surname } = splitName(input.customer?.name);
  const address = input.customer?.address || "-";
  const city = input.customer?.city || "-";
  const country = input.customer?.country || "Turkey";

  const payload = {
    locale: (input.locale ?? "tr").slice(0, 2),
    conversationId: input.reference,
    price,
    paidPrice: price,
    currency: input.currency.toUpperCase(),
    basketId: input.reference,
    paymentGroup: "PRODUCT",
    callbackUrl: input.callbackUrl,
    enabledInstallments: [1],
    buyer: {
      id: input.reference,
      name,
      surname,
      gsmNumber: input.customer?.phone || undefined,
      email,
      identityNumber: input.customer?.identityNumber || IYZICO_PLACEHOLDER_IDENTITY,
      registrationAddress: address,
      ip: input.customerIp || undefined,
      city,
      country,
    },
    shippingAddress: { contactName: `${name} ${surname}`, city, country, address },
    billingAddress: { contactName: `${name} ${surname}`, city, country, address },
    basketItems: [
      {
        id: input.reference,
        name: input.description || "Payment",
        category1: "Payment",
        // Nothing ships — every checkout this module mints is for a service or
        // an invoice, and iyzico validates the enum.
        itemType: "VIRTUAL",
        price,
      },
    ],
  };
  const body = JSON.stringify(payload);
  const randomKey = `${input.nowMs ?? Date.now()}${Math.random().toString(36).slice(2, 10)}`;
  const headers = await iyzicoAuthHeaders(apiKey, secretKey, IYZICO_INIT_PATH, body, randomKey);

  let res: Response;
  try {
    res = await doFetch(input)(`${host}${IYZICO_INIT_PATH}`, { method: "POST", headers, body });
  } catch (e) {
    return fail("unreachable", `Could not reach iyzico: ${(e as Error).message}`);
  }
  if (!res.ok) return fail("unreachable", `iyzico returned HTTP ${res.status}`);

  let out: Record<string, unknown>;
  try {
    out = (await res.json()) as Record<string, unknown>;
  } catch {
    return fail("unreachable", "iyzico returned a non-JSON response");
  }
  if (str(out.status) !== "success") {
    return fail("rejected", str(out.errorMessage) ?? "iyzico rejected the checkout");
  }
  const url = str(out.paymentPageUrl) ?? str(out.payWithIyzicoPageUrl);
  const token = str(out.token);
  if (!url || !token) {
    // The alternative is `checkoutFormContent`, a <script> blob meant to be
    // embedded rather than linked to. Handing that back as a "URL" would break
    // at the click, so say so here instead.
    return fail(
      "rejected",
      "iyzico returned an embedded checkout form rather than a hosted page URL — " +
        "enable the hosted checkout page on the merchant account",
    );
  }
  const expire = out.tokenExpireTime;
  return {
    ok: true,
    url,
    externalId: token,
    expiresAt:
      typeof expire === "number" ? (input.nowMs ?? Date.now()) + expire * 1000 : null,
    reference: input.reference,
  };
};

// ── Adyen ───────────────────────────────────────────────────────────────────

const ADYEN_API_VERSION = "v71";
const ADYEN_TEST_BASE = "https://checkout-test.adyen.com";

/**
 * Adyen's live endpoints are per-merchant: the host carries a prefix issued
 * with the live API credential. It is interpolated into a URL, so it is
 * validated as an opaque token rather than trusted — a prefix carrying `/` or
 * `@` would redirect the API key to a host of someone else's choosing.
 */
const ADYEN_LIVE_PREFIX_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** Adyen's own bounds on a payment link's lifetime: at least a minute, at most
 *  70 days. Outside that it 422s, so an out-of-range value is dropped and
 *  Adyen's 24-hour default applies instead. */
const ADYEN_MIN_EXPIRY_SEC = 60;
const ADYEN_MAX_EXPIRY_SEC = 70 * 24 * 60 * 60;

const adyenBase = (config: Record<string, unknown>): { base: string } | { error: string } => {
  if (str(config.environment) !== "live") return { base: ADYEN_TEST_BASE };
  const prefix = str(config.liveUrlPrefix);
  if (!prefix) {
    return {
      error:
        "Adyen live payments need the live URL prefix from the Customer Area — " +
        "the live API has no shared host",
    };
  }
  if (!ADYEN_LIVE_PREFIX_PATTERN.test(prefix)) {
    return { error: "The Adyen live URL prefix must be letters, digits and dashes only" };
  }
  return { base: `https://${prefix}-checkout-live.adyenpayments.com/checkout` };
};

/**
 * Adyen wants `expiresAt` as an ISO-8601 instant WITH an offset. `toISOString`
 * emits `…Z`, which qualifies.
 */
const adyenExpiry = (nowMs: number, expiresInSec: number | undefined): string | undefined => {
  if (!expiresInSec) return undefined;
  if (expiresInSec < ADYEN_MIN_EXPIRY_SEC || expiresInSec > ADYEN_MAX_EXPIRY_SEC) return undefined;
  return new Date(nowMs + expiresInSec * 1000).toISOString();
};

const adyenCheckout = async (input: CheckoutInput): Promise<CheckoutResult> => {
  const apiKey = str(input.config.apiKey);
  const merchantAccount = str(input.config.merchantAccount);
  if (!apiKey) return fail("missing_secret", "Adyen needs its API key to open a payment link");
  if (!merchantAccount) {
    return fail("missing_secret", "Adyen needs the merchant account code to open a payment link");
  }
  const host = adyenBase(input.config);
  if ("error" in host) return fail("missing_secret", host.error);

  const now = input.nowMs ?? Date.now();
  // Adyen quotes minor units, the same as the ledger — no conversion, unlike
  // iyzico. `countryCode` is only sent when it really is ISO-3166 alpha-2;
  // `CheckoutCustomer.country` also accepts a country NAME (iyzico wants one),
  // and Adyen 422s on anything that isn't two letters.
  const country = str(input.customer?.country);
  const payload: Record<string, unknown> = {
    amount: { currency: input.currency.toUpperCase(), value: input.amount },
    merchantAccount,
    // Comes back as `merchantReference` on every notification item.
    reference: input.reference,
    description: input.description || "Payment",
    shopperEmail: str(input.customer?.email) ?? undefined,
    shopperLocale: input.locale || undefined,
    countryCode: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : undefined,
    // Adyen has ONE return URL — the shopper lands there whether they paid or
    // gave up, with the outcome in the query string. `cancelUrl` has nowhere
    // to go, so it is deliberately unused rather than quietly substituted.
    returnUrl: input.successUrl,
    expiresAt: adyenExpiry(now, input.expiresInSec),
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

  let res: Response;
  try {
    res = await doFetch(input)(`${host.base}/${ADYEN_API_VERSION}/paymentLinks`, {
      method: "POST",
      headers: { "x-API-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return fail("unreachable", `Could not reach Adyen: ${(e as Error).message}`);
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return fail("unreachable", `Adyen returned a non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    // Adyen's error envelope is `{ status, errorCode, message, errorType }`.
    return fail(
      "rejected",
      str(body.message) ?? `Adyen rejected the payment link (HTTP ${res.status})`,
    );
  }

  const url = str(body.url);
  const id = str(body.id);
  if (!url || !id) return fail("rejected", "Adyen returned a payment link with no URL");
  const expiresAt = str(body.expiresAt);
  const parsedExpiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  return {
    ok: true,
    url,
    externalId: id,
    expiresAt: Number.isNaN(parsedExpiry) ? null : parsedExpiry,
    reference: input.reference,
  };
};

// ── dummy ───────────────────────────────────────────────────────────────────

/**
 * The query parameters the hosted `dummy` page is driven by, signed so the
 * page cannot be used to record an arbitrary payment.
 *
 * The signature is the reason this is not simply a link with an amount in it:
 * the page settles a payment, and an unsigned one would let anyone who can
 * reach the origin mint a "succeeded" row for any amount. It is the same shape
 * of guard the real providers get from their webhook HMAC.
 */
export const DUMMY_CHECKOUT_PARAMS = ["r", "a", "c", "d", "s", "f"] as const;

/**
 * The two things this secret signs — the outbound link and the inbound
 * settlement — are domain-prefixed so one can never be replayed as the other.
 *
 * Without the prefix both are `hex(HMAC-SHA256(secret, message))` over
 * attacker-visible text, so a signature minted for a checkout is a valid
 * settlement signature for the identical bytes. Values are percent-encoded for
 * the same reason: `URLSearchParams.get` returns the DECODED value, so a
 * description containing `&status=success` would otherwise re-partition the
 * signing string into fields the settlement parser reads.
 */
const dummySigningString = (params: URLSearchParams): string =>
  DUMMY_CHECKOUT_DOMAIN +
  DUMMY_CHECKOUT_PARAMS.map((k) => `${k}=${encodeURIComponent(params.get(k) ?? "")}`).join("&");

export const signDummyCheckout = async (
  secret: string,
  params: URLSearchParams,
): Promise<string> => toHex(await hmac(new TextEncoder().encode(secret), dummySigningString(params)));

/** Constant-time check that a hosted-page request came from a checkout we
 *  actually minted. */
export const verifyDummyCheckout = async (
  secret: string,
  params: URLSearchParams,
): Promise<boolean> => {
  const given = params.get("sig") ?? "";
  const expected = await signDummyCheckout(secret, params);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
};

/**
 * Sign the settlement body the hosted page posts back.
 *
 * Domain-prefixed for the reason given above, and exported so the page and the
 * inbound verifier cannot drift — a mismatch here would look exactly like a
 * forged callback.
 */
export const signDummySettlement = async (secret: string, rawBody: string): Promise<string> =>
  toHex(await hmac(new TextEncoder().encode(secret), DUMMY_SETTLEMENT_DOMAIN + rawBody));

const dummyCheckout = async (input: CheckoutInput): Promise<CheckoutResult> => {
  const secret = str(input.config.secret);
  if (!secret) return fail("missing_secret", "The dummy provider has no signing secret");
  if (!input.hostedBaseUrl || !input.hostedToken) {
    return fail(
      "invalid_input",
      "The dummy provider's checkout is hosted by backlex itself and needs the " +
        "origin and the provider's webhook token",
    );
  }
  const params = new URLSearchParams({
    r: input.reference,
    a: String(input.amount),
    c: input.currency.toUpperCase(),
    d: input.description || "Payment",
    s: input.successUrl,
    f: input.cancelUrl ?? input.successUrl,
  });
  params.set("sig", await signDummyCheckout(secret, params));
  const base = input.hostedBaseUrl.replace(/\/+$/, "");
  return {
    ok: true,
    url: `${base}/api/payments/dummy/${encodeURIComponent(input.hostedToken)}?${params.toString()}`,
    externalId: input.reference,
    expiresAt: null,
    reference: input.reference,
  };
};

// ── Dispatch ────────────────────────────────────────────────────────────────

/** Why a catalog provider can't take an amount, phrased for an admin. */
const CATALOG_MESSAGE: Partial<Record<PaymentProvider, string>> = {
  polar: "Polar checkouts are opened against an existing product price",
  lemonsqueezy: "Lemon Squeezy checkouts are opened against an existing variant",
  paddle: "Paddle checkouts are opened against an existing price",
};

/**
 * Open a hosted checkout and return the URL to send the customer to.
 *
 * Never throws: a transport failure, a provider refusal and a bad input are all
 * `{ ok: false, reason }`, because the caller has to tell them apart. Only
 * `unreachable` is worth a retry — retrying a `rejected` re-sends a request the
 * provider has already refused, and retrying `invalid_input` cannot help.
 */
export async function createCheckout(
  provider: string,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  if (!isPaymentProvider(provider)) {
    return fail("unknown_provider", `Unknown payment provider "${provider}"`);
  }
  const mode = checkoutModeOf(provider);
  if (mode === null) {
    return fail("unsupported", `${provider} does not offer a hosted checkout`);
  }
  if (mode === "catalog") {
    // Deliberately explicit rather than a half-working attempt: these three
    // take a `priceId` and no amount, which is a different call and a
    // different admin workflow (somebody has to create the product first).
    return fail(
      "catalog_only",
      `${CATALOG_MESSAGE[provider] ?? `${provider} checkouts need a pre-existing price`}, ` +
        `not an ad-hoc amount. Charging an invoice total through it isn't supported yet.`,
    );
  }

  const invalid = validateCommon(input);
  if (invalid) return invalid;

  switch (provider) {
    case "stripe":
      return stripeCheckout(input);
    case "paytr":
      return paytrCheckout(input);
    case "iyzico":
      return iyzicoCheckout(input);
    case "adyen":
      return adyenCheckout(input);
    case "dummy":
      return dummyCheckout(input);
    default:
      // Unreachable while the mode table and this switch agree; a new `adhoc`
      // provider with no branch lands here rather than silently doing nothing.
      return fail("unsupported", `${provider} has no checkout implementation`);
  }
}
