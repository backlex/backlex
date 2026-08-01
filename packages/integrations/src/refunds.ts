/**
 * @backlex/integrations/refunds — giving money back.
 *
 * `./payments.ts` records what a provider says happened. `./checkout.ts` asks
 * for money. This is the third direction, and the one that closes the loop: a
 * workspace that can bill a row can now reverse that charge from the same
 * place, instead of an operator logging into the PSP's dashboard and the ledger
 * quietly going stale.
 *
 * It is also the structural answer to the blind spot the `refresh` sync mode
 * papers over. Refreshing exists because a refund raised in the provider's own
 * dashboard notifies nobody; a refund raised HERE is one we already know about
 * at the moment it happens, so it needs no discovery at all.
 *
 * Same contract as the rest of the package: pure, no DB, no env, no
 * persistence. The consumer owns the ledger.
 *
 * ## The amount is always explicit
 *
 * Three providers (Stripe, Lemon Squeezy, Paddle) will refund "everything
 * remaining" if you omit the amount; the other seven require a figure. Rather
 * than expose a contract where `amount: undefined` means something different
 * per provider, this module ALWAYS requires minor units and the consumer
 * resolves "full" against `payment_transactions` before calling.
 *
 * That is not just tidiness. Resolving the remainder from our own ledger means
 * an over-refund is refused against a number we hold, before a credential ever
 * leaves the instance — and it makes the amount that was requested and the
 * amount that was recorded the same value by construction.
 *
 * ## Minor units are not what most of these APIs want
 *
 * The ledger is in minor units. Stripe, Adyen, Klarna, Polar and Lemon Squeezy
 * agree. PayTR, iyzico and Authorize.net want major-unit decimals — and PayTR
 * wants them on the REFUND while wanting minor units on the checkout token
 * request, which is the same provider disagreeing with itself. `toMajorUnits`
 * is applied per call rather than once, for exactly that reason.
 */

import { hmac, toBase64 } from "./payment-crypto";
import {
  ADYEN_API_VERSION,
  AUTHORIZENET_API_PATH,
  AUTHORIZENET_DEFAULT_CURRENCY,
  type FetchLike,
  KLARNA_ID_PATTERN,
  type PaymentProvider,
  adyenBase,
  authorizeNetErrorText,
  authorizeNetHost,
  authorizeNetOk,
  isPaymentProvider,
  iyzicoAuthHeaders,
  iyzicoHost,
  klarnaAuthHeader,
  klarnaHost,
  paddleBase,
  parseAuthorizeNetJson,
  polarBase,
  retrieveAuthorizeNetTransaction,
  toMajorUnits,
} from "./payments";

// ── Capability tables ───────────────────────────────────────────────────────

/**
 * How much of a payment this provider will let us give back.
 *
 * `full_and_partial` is the norm. Paddle is the exception: a partial refund is
 * an adjustment over specific transaction LINE ITEMS, identified by Paddle ids
 * that live on the transaction and that backlex never stores — the payment row
 * carries one amount, not a basket. A partial Paddle refund is therefore
 * refused by name rather than approximated, because approximating it means
 * refunding the wrong line.
 *
 * `null` would mean "cannot refund at all". Nothing sits there today, but the
 * column exists so a future acquirer that only reports settlements has an
 * honest place to be instead of being lumped in with the rest.
 */
export type PaymentRefundSupport = "full_and_partial" | "full_only";

export const PAYMENT_REFUND_SUPPORT: Record<PaymentProvider, PaymentRefundSupport | null> = {
  stripe: "full_and_partial",
  polar: "full_and_partial",
  lemonsqueezy: "full_and_partial",
  paddle: "full_only",
  paytr: "full_and_partial",
  iyzico: "full_and_partial",
  adyen: "full_and_partial",
  authorizenet: "full_and_partial",
  klarna: "full_and_partial",
  dummy: "full_and_partial",
};

export const refundSupportOf = (provider: string): PaymentRefundSupport | null =>
  PAYMENT_REFUND_SUPPORT[provider as PaymentProvider] ?? null;

export const canRefund = (provider: string): boolean => refundSupportOf(provider) !== null;

export const canRefundPartially = (provider: string): boolean =>
  refundSupportOf(provider) === "full_and_partial";

/**
 * Where this provider's refund ends up in the ledger — and therefore what the
 * consumer is allowed to write after a successful call.
 *
 * `restates` — the refund shows up as a changed field on the payment's OWN
 * record (`amount_refunded`, `refunded_amount`, a `refunded` status). A later
 * webhook or refresh re-states the same figure, so writing it optimistically
 * converges.
 *
 * `own_row` — the refund is a separate transaction with its own id, filed
 * against its own row. Adyen and Authorize.net both work this way, and both
 * send a notification for it. Bumping `amount_refunded` on the ORIGINAL payment
 * would be undone the moment anything re-reads that payment: its refunded
 * figure genuinely is zero, because the refund is not part of it. So the
 * consumer writes nothing and lets the notification file the refund, which is
 * the same path a dashboard-raised refund already takes.
 *
 * Getting this backwards is silent in both directions — an optimistic write
 * that later evaporates, or a refund that never appears — which is why it is a
 * table and not a judgement call at the call site.
 */
export type PaymentRefundLedger = "restates" | "own_row";

export const PAYMENT_REFUND_LEDGER: Record<PaymentProvider, PaymentRefundLedger> = {
  stripe: "restates",
  polar: "restates",
  lemonsqueezy: "restates",
  paddle: "restates",
  klarna: "restates",
  // No refund notification and no refetch: our write is the only record there
  // will ever be. See `PAYMENT_CAN_REFETCH` for why iyzico is not refreshable.
  iyzico: "restates",
  paytr: "restates",
  dummy: "restates",
  // Both file a refund as its own transaction and both notify about it.
  adyen: "own_row",
  authorizenet: "own_row",
};

export const refundLedgerOf = (provider: string): PaymentRefundLedger =>
  PAYMENT_REFUND_LEDGER[provider as PaymentProvider] ?? "restates";

// ── Contract ────────────────────────────────────────────────────────────────

/**
 * The reasons a refund can be given, normalised across providers.
 *
 * Stripe and Polar both take an enum and both reject anything outside it, but
 * they do not agree on the members — Polar has a fourth (`general`) and Stripe
 * would 400 on it. Everyone else takes free text or nothing. So the reason is
 * modelled once here and translated per provider, and `description` carries the
 * human sentence separately.
 */
export const REFUND_REASONS = ["duplicate", "fraudulent", "requested_by_customer", "other"] as const;

export type RefundReason = (typeof REFUND_REASONS)[number];

export const isRefundReason = (v: string): v is RefundReason =>
  (REFUND_REASONS as readonly string[]).includes(v);

export interface RefundInput {
  /** DECRYPTED provider config — the consumer owns encryption at rest. */
  config: Record<string, unknown>;
  /** The provider's own id for the payment, exactly as `external_id` holds it. */
  externalId: string;
  /**
   * MINOR units. Always required — see the module header. The consumer has
   * already checked it against the refundable remainder.
   */
  amount: number;
  /** ISO-4217. Adyen requires it to match the authorisation's currency. */
  currency: string;
  reason?: RefundReason;
  /** Free text for the provider's own record, and for the customer where the
   *  provider shows it (Klarna puts it on the consumer's statement line). */
  description?: string;
  /** Our own reference for this refund. Adyen and Klarna both accept one; it is
   *  what a support conversation about a specific refund is about. */
  reference?: string;
  /**
   * Whether `amount` is the WHOLE remaining balance.
   *
   * Only Paddle needs to know: its `full` adjustment adjusts the grand total
   * and needs no line items, while anything else must be `partial` and cannot
   * be expressed without them. The consumer knows the answer because it read
   * the ledger; deriving it here would mean guessing.
   */
  full?: boolean;
  /**
   * The currency the connected account settles in. Authorize.net only — its
   * API states a currency nowhere, exactly as on the checkout and refresh paths.
   */
  accountCurrency?: string | null;
  /** The requesting IP. iyzico records one on a refund. */
  customerIp?: string;
  /** BCP-47-ish locale hint; providers take their own dialect of this. */
  locale?: string;
  /**
   * Idempotency key. Klarna requires one and it is the only guard against a
   * retried request refunding twice, so the consumer supplies a stable value
   * rather than letting each attempt mint a fresh one.
   */
  idempotencyKey?: string;
  fetchImpl?: FetchLike;
  /** Injectable clock (ms) so tests don't depend on wall time. */
  nowMs?: number;
}

export type RefundFailure =
  /** Not a provider we know at all. */
  | "unknown_provider"
  /** Known provider that cannot refund. */
  | "unsupported"
  /** Known provider that cannot refund PART of a payment. */
  | "partial_unsupported"
  /** The stored config is missing a credential this call needs. */
  | "missing_secret"
  /** The CALLER's input is wrong — amount, currency, or a required field. */
  | "invalid_input"
  /** The provider has never heard of this payment. Not retryable. */
  | "not_found"
  /** Transport failure. Not a verdict: safe to retry. */
  | "unreachable"
  /** The provider answered and said no. */
  | "rejected";

export type RefundResult =
  | {
      ok: true;
      /** The provider's own id for the refund. Empty when it issues none. */
      refundId: string;
      /** MINOR units, echoed so the caller records what actually moved. */
      amount: number;
      /**
       * `succeeded` — the money is on its way back and the provider said so.
       * `pending` — accepted but not yet decided. Adyen resolves this in a
       * REFUND webhook; Paddle holds live refunds for human approval. A caller
       * that treats `pending` as done will report a refund that may still be
       * declined.
       */
      status: "succeeded" | "pending";
      /** Set when the provider says something the operator should see even
       *  though the call succeeded (Paddle's approval hold, for one). */
      note?: string;
    }
  | { ok: false; reason: RefundFailure; message: string };

// ── Small local helpers ─────────────────────────────────────────────────────

const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null;

const fail = (reason: RefundFailure, message: string): RefundResult => ({ ok: false, reason, message });

const doFetch = (input: RefundInput): FetchLike => input.fetchImpl ?? ((i, init) => fetch(i, init));

const form = (params: Record<string, string | undefined>): string => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v);
  return body.toString();
};

const jsonOf = async (res: Response): Promise<Record<string, unknown> | null> => {
  try {
    const parsed = await res.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** A 4xx is the provider's verdict; a 5xx is its weather. Only the second is
 *  worth retrying, and conflating them turns one bad request into a retry loop. */
const statusReason = (status: number): RefundFailure =>
  status === 404 ? "not_found" : status >= 400 && status < 500 ? "rejected" : "unreachable";

const DEFAULT_DESCRIPTION = "Refund";

// ── Shared input validation ─────────────────────────────────────────────────

/**
 * Everything that is wrong regardless of provider, checked before dispatch so a
 * bad amount reads the same whichever provider is connected.
 */
const validateCommon = (input: RefundInput): RefundResult | null => {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return fail(
      "invalid_input",
      `amount must be a positive integer in minor units (got ${JSON.stringify(input.amount)})`,
    );
  }
  if (!/^[A-Za-z]{3}$/.test(String(input.currency ?? ""))) {
    return fail("invalid_input", `currency must be a 3-letter ISO-4217 code (got "${input.currency}")`);
  }
  if (!input.externalId) {
    return fail("invalid_input", "externalId is required — it is the provider's id for the payment");
  }
  return null;
};

// ── Stripe ──────────────────────────────────────────────────────────────────

const STRIPE_REFUND_API = "https://api.stripe.com/v1/refunds";

/** Stripe rejects a `reason` outside its own three, so ours is translated and
 *  `other` is dropped rather than sent. */
const STRIPE_REASONS: Partial<Record<RefundReason, string>> = {
  duplicate: "duplicate",
  fraudulent: "fraudulent",
  requested_by_customer: "requested_by_customer",
};

/**
 * Stripe takes either a charge or a PaymentIntent, and which one we hold
 * depends on how the row got here: the webhook path records a PaymentIntent id
 * for `payment_intent.succeeded`, while a catalog reconcile walks `charges` and
 * records a charge id. Both are valid refund targets and they are told apart by
 * their prefix, which Stripe guarantees.
 *
 * Sending a charge id in the `payment_intent` field is not a soft failure —
 * Stripe answers "No such payment_intent", which reads like the payment is
 * gone rather than like the field is wrong.
 */
const stripeRefund = async (input: RefundInput): Promise<RefundResult> => {
  const apiKey = str(input.config.apiKey);
  if (!apiKey) return fail("missing_secret", "Stripe needs its secret API key to refund a payment");

  const id = input.externalId;
  const target = id.startsWith("pi_") ? "payment_intent" : "charge";
  const params: Record<string, string | undefined> = {
    [target]: id,
    amount: String(input.amount),
    reason: input.reason ? STRIPE_REASONS[input.reason] : undefined,
    "metadata[backlex_reference]": input.reference || undefined,
  };

  let res: Response;
  try {
    res = await doFetch(input)(STRIPE_REFUND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        // Stripe's own idempotency header. A retried refund reuses the key and
        // returns the FIRST result rather than moving the money twice.
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      body: form(params),
    });
  } catch (e) {
    return fail("unreachable", `Could not reach Stripe: ${(e as Error).message}`);
  }

  const body = await jsonOf(res);
  if (!res.ok) {
    const err = body?.error as Record<string, unknown> | undefined;
    const code = str(err?.code) ?? "";
    // Stripe reports an unknown id as a 400 with `resource_missing`, not a 404.
    const reason: RefundFailure = code === "resource_missing" ? "not_found" : statusReason(res.status);
    return fail(reason, str(err?.message) ?? `Stripe rejected the refund (HTTP ${res.status})`);
  }
  const refundId = str(body?.id);
  if (!refundId) return fail("rejected", "Stripe reported success with no refund id");
  const status = str(body?.status);
  if (status === "failed" || status === "canceled") {
    return fail("rejected", `Stripe created the refund and immediately marked it ${status}`);
  }
  return {
    ok: true,
    refundId,
    amount: typeof body?.amount === "number" ? body.amount : input.amount,
    // `pending` and `requires_action` both mean the money has not moved yet.
    status: status === "succeeded" ? "succeeded" : "pending",
  };
};

// ── Adyen ───────────────────────────────────────────────────────────────────

/**
 * Adyen's psp reference goes in the URL PATH, so it is gated the same way
 * Klarna's order id is: a hostile value would choose which endpoint the API key
 * is sent to.
 */
const ADYEN_PSP_PATTERN = /^[A-Za-z0-9]{1,64}$/;

/**
 * Adyen refunds are ASYNCHRONOUS. A 201 means "accepted", not "refunded" — the
 * verdict arrives later as a REFUND notification, which is also the thing that
 * files the refund's own row. That is why Adyen is `own_row` in the ledger
 * table: there is nothing truthful to write here yet.
 */
const adyenRefund = async (input: RefundInput): Promise<RefundResult> => {
  const apiKey = str(input.config.apiKey);
  const merchantAccount = str(input.config.merchantAccount);
  if (!apiKey) return fail("missing_secret", "Adyen needs its API key to refund a payment");
  if (!merchantAccount) {
    return fail("missing_secret", "Adyen needs the merchant account code to refund a payment");
  }
  if (!ADYEN_PSP_PATTERN.test(input.externalId)) {
    return fail("invalid_input", "That is not a well-formed Adyen psp reference");
  }
  const host = adyenBase(input.config);
  if ("error" in host) return fail("missing_secret", host.error);

  const payload: Record<string, unknown> = {
    merchantAccount,
    // Minor units on both sides, the same as the checkout — no conversion.
    amount: { currency: input.currency.toUpperCase(), value: input.amount },
    reference: input.reference || undefined,
  };
  if (payload.reference === undefined) delete payload.reference;

  let res: Response;
  try {
    res = await doFetch(input)(
      `${host.base}/${ADYEN_API_VERSION}/payments/${encodeURIComponent(input.externalId)}/refunds`,
      {
        method: "POST",
        headers: {
          "x-API-key": apiKey,
          "Content-Type": "application/json",
          ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
        },
        body: JSON.stringify(payload),
      },
    );
  } catch (e) {
    return fail("unreachable", `Could not reach Adyen: ${(e as Error).message}`);
  }

  const body = await jsonOf(res);
  if (!res.ok) {
    return fail(
      statusReason(res.status),
      str(body?.message) ?? `Adyen rejected the refund (HTTP ${res.status})`,
    );
  }
  const refundId = str(body?.pspReference);
  if (!refundId) return fail("rejected", "Adyen accepted the refund but returned no psp reference");
  return {
    ok: true,
    refundId,
    amount: input.amount,
    // `received` is Adyen's only success status here, and it means exactly what
    // it says.
    status: "pending",
    note: "Adyen decides refunds asynchronously — the outcome arrives as a REFUND webhook",
  };
};

// ── Klarna ──────────────────────────────────────────────────────────────────

/**
 * Klarna refunds the ORDER, not the session — `external_id` holds the order id
 * that `place_order_mode: CAPTURE_ORDER` produced, which is what makes this
 * reachable at all. An HPP session id would 404 here.
 *
 * The refund id comes back in a RESPONSE HEADER (`Refund-ID`), not in the body;
 * the body of a 201 is empty. Reading `body.refund_id` yields null silently and
 * the refund still happened, so the header is the only place to look.
 */
const klarnaRefund = async (input: RefundInput): Promise<RefundResult> => {
  const username = str(input.config.username);
  const password = str(input.config.password);
  if (!username || !password) {
    return fail("missing_secret", "Klarna needs its API username and password to refund an order");
  }
  if (!KLARNA_ID_PATTERN.test(input.externalId)) {
    return fail("invalid_input", "That is not a well-formed Klarna order id");
  }

  const headers: Record<string, string> = {
    Authorization: klarnaAuthHeader(username, password),
    "Content-Type": "application/json",
  };
  // Klarna documents this as required and it is the only thing standing between
  // a retried request and a doubled refund.
  if (input.idempotencyKey) headers["Klarna-Idempotency-Key"] = input.idempotencyKey;

  let res: Response;
  try {
    res = await doFetch(input)(
      `${klarnaHost(input.config)}/ordermanagement/v1/orders/${encodeURIComponent(input.externalId)}/refunds`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          // Minor units, matching the order amount the session was created with.
          refunded_amount: input.amount,
          description: input.description || DEFAULT_DESCRIPTION,
        }),
      },
    );
  } catch (e) {
    return fail("unreachable", `Could not reach Klarna: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const body = await jsonOf(res);
    const messages = body?.error_messages;
    const first = Array.isArray(messages) ? str(messages[0]) : null;
    const code = str(body?.error_code);
    const correlation = str(body?.correlation_id);
    const detail = first ?? code ?? `HTTP ${res.status}`;
    return fail(
      statusReason(res.status),
      `Klarna rejected the refund: ${detail}` +
        (correlation ? ` (correlation id ${correlation})` : ""),
    );
  }

  return {
    ok: true,
    // Absent only if Klarna changes the contract; the refund still succeeded,
    // so an empty id is not an error.
    refundId: res.headers.get("Refund-ID") ?? "",
    amount: input.amount,
    status: "succeeded",
  };
};

// ── Authorize.net ───────────────────────────────────────────────────────────

/**
 * Authorize.net will not refund on a transaction id alone.
 *
 * A `refundTransaction` needs the ORIGINAL payment method as well as
 * `refTransId` — either the full card number, which we have never held, or the
 * last four digits with a masked expiry. Neither the notification nor anything
 * in `payment_transactions` carries those four digits, so the refund starts
 * with a `getTransactionDetails` call to read them off the transaction we are
 * about to reverse.
 *
 * This is the second time Authorize.net has needed an enrichment retrieve on a
 * path that looks like it should be one call (the first was the settlement
 * notification, which does not name the invoice it paid). Unlike that one this
 * retrieve is NOT best-effort: without the digits there is no request to send.
 */
const AUTHORIZENET_MASKED_EXPIRY = "XXXX";

/** `payment.creditCard.cardNumber` comes back masked as `XXXX1234`. Also
 *  handles a bank account, whose last four live under `bankAccount`. */
const authorizeNetLastFour = (transaction: Record<string, unknown>): string | null => {
  const payment = transaction.payment as Record<string, unknown> | undefined;
  const card = payment?.creditCard as Record<string, unknown> | undefined;
  const masked = str(card?.cardNumber);
  if (masked) {
    const digits = masked.replace(/\D/g, "");
    if (digits.length >= 4) return digits.slice(-4);
  }
  const bank = payment?.bankAccount as Record<string, unknown> | undefined;
  const account = str(bank?.accountNumber);
  if (account) {
    const digits = account.replace(/\D/g, "");
    if (digits.length >= 4) return digits.slice(-4);
  }
  return null;
};

const authorizeNetRefund = async (input: RefundInput): Promise<RefundResult> => {
  const name = str(input.config.apiLoginId);
  const transactionKey = str(input.config.transactionKey);
  if (!name || !transactionKey) {
    return fail(
      "missing_secret",
      "Authorize.net needs its API login ID and transaction key to refund a payment",
    );
  }

  // Same refusal the checkout makes, for the same reason: the account settles
  // in exactly one currency and the API has no field to say otherwise, so
  // refunding "in EUR" from a USD account would silently give back a different
  // sum than the one asked for.
  const accountCurrency = (
    str(input.accountCurrency) ??
    str(input.config.currency) ??
    AUTHORIZENET_DEFAULT_CURRENCY
  ).toUpperCase();
  if (input.currency.toUpperCase() !== accountCurrency) {
    return fail(
      "invalid_input",
      `This Authorize.net account settles in ${accountCurrency}, and Authorize.net has no way ` +
        `to refund in another currency — the refund asked for ${input.currency.toUpperCase()}`,
    );
  }

  // Step 1: read the card's last four off the transaction being reversed.
  const detail = await retrieveAuthorizeNetTransaction({
    config: input.config,
    transId: input.externalId,
    fetchImpl: input.fetchImpl,
  });
  if (!detail.ok) {
    if (detail.reason === "missing_secret") return fail("missing_secret", "Authorize.net rejected the credentials");
    if (detail.reason === "unreachable") return fail("unreachable", "Could not reach Authorize.net");
    return fail(
      /not found|invalid.*transaction/i.test(detail.message ?? "") ? "not_found" : "rejected",
      detail.message ?? "Authorize.net would not describe that transaction",
    );
  }
  const lastFour = authorizeNetLastFour(detail.transaction);
  if (!lastFour) {
    return fail(
      "rejected",
      "Authorize.net requires the last four digits of the original payment method to refund, " +
        "and this transaction reports none",
    );
  }

  // Step 2: the refund itself.
  const payload = {
    createTransactionRequest: {
      merchantAuthentication: { name, transactionKey },
      refId: input.reference || undefined,
      transactionRequest: {
        transactionType: "refundTransaction",
        // Major-unit decimal string, the mirror of what the notification
        // normalizer reads on the way back in.
        amount: toMajorUnits(input.amount, input.currency),
        payment: {
          creditCard: { cardNumber: lastFour, expirationDate: AUTHORIZENET_MASKED_EXPIRY },
        },
        refTransId: input.externalId,
      },
    },
  };

  let res: Response;
  try {
    res = await doFetch(input)(`${authorizeNetHost(input.config)}${AUTHORIZENET_API_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return fail("unreachable", `Could not reach Authorize.net: ${(e as Error).message}`);
  }
  if (!res.ok) return fail("unreachable", `Authorize.net returned HTTP ${res.status}`);

  const body = parseAuthorizeNetJson(await res.text());
  if (!body) return fail("unreachable", "Authorize.net returned a response that was not JSON");
  // 200 is not the verdict here either — refusals come back with an OK status
  // and an `Error` result code.
  if (!authorizeNetOk(body)) {
    return fail("rejected", authorizeNetErrorText(body) ?? "Authorize.net rejected the refund");
  }
  const txn = body.transactionResponse as Record<string, unknown> | undefined;
  const refundId = str(txn?.transId);
  if (!refundId || refundId === "0") {
    // A zero transaction id with an otherwise-OK envelope is Authorize.net's
    // way of declining; the detail is in the transaction response's own errors.
    return fail("rejected", "Authorize.net declined the refund");
  }
  return { ok: true, refundId, amount: input.amount, status: "succeeded" };
};

// ── PayTR ───────────────────────────────────────────────────────────────────

const PAYTR_REFUND_API = "https://www.paytr.com/odeme/iade";

/**
 * PayTR's refund hash.
 *
 * base64(HMAC-SHA256(merchant_id + merchant_oid + return_amount + merchant_salt,
 *   merchant_key))
 *
 * The `return_amount` folded into the hash must be the EXACT string sent as the
 * field, which is why the value is formatted once and reused rather than being
 * built twice.
 */
export const paytrRefundHash = async (
  fields: { merchantId: string; merchantOid: string; returnAmount: string },
  merchantKey: string,
  merchantSalt: string,
): Promise<string> =>
  toBase64(
    await hmac(
      new TextEncoder().encode(merchantKey),
      `${fields.merchantId}${fields.merchantOid}${fields.returnAmount}${merchantSalt}`,
    ),
  );

/**
 * PayTR refunds against `merchant_oid` — the reference the checkout travelled
 * out with, which for PayTR is also what `external_id` stores. It is the one
 * provider here where those are the same value.
 *
 * `return_amount` is a MAJOR-unit decimal ("10.25"), while `payment_amount` on
 * the checkout's token request is MINOR units. Same provider, same money, two
 * conventions — sending minor units here refunds a hundred times too much and
 * PayTR would happily accept it up to the payment total.
 */
const paytrRefund = async (input: RefundInput): Promise<RefundResult> => {
  const merchantId = str(input.config.merchantId);
  const merchantKey = str(input.config.merchantKey);
  const merchantSalt = str(input.config.merchantSalt);
  if (!merchantId || !merchantKey || !merchantSalt) {
    return fail("missing_secret", "PayTR needs its merchant id, key and salt to refund a payment");
  }

  const returnAmount = toMajorUnits(input.amount, input.currency);
  const paytrToken = await paytrRefundHash(
    { merchantId, merchantOid: input.externalId, returnAmount },
    merchantKey,
    merchantSalt,
  );

  let res: Response;
  try {
    res = await doFetch(input)(PAYTR_REFUND_API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        merchant_id: merchantId,
        merchant_oid: input.externalId,
        return_amount: returnAmount,
        paytr_token: paytrToken,
      }),
    });
  } catch (e) {
    return fail("unreachable", `Could not reach PayTR: ${(e as Error).message}`);
  }
  if (!res.ok) return fail("unreachable", `PayTR returned HTTP ${res.status}`);

  const body = await jsonOf(res);
  if (!body) return fail("unreachable", "PayTR returned a non-JSON response");
  const status = str(body.status);
  if (status === "success") {
    return {
      ok: true,
      // PayTR issues no refund id of its own — the order number is the handle,
      // and it is what a support conversation with PayTR would be about.
      refundId: input.externalId,
      amount: input.amount,
      status: "succeeded",
    };
  }
  // `failed` specifically means PayTR has no transaction for that order number.
  if (status === "failed") {
    return fail("not_found", `PayTR has no payment recorded for order "${input.externalId}"`);
  }
  const errNo = str(body.err_no);
  const errMsg = str(body.err_msg);
  return fail(
    "rejected",
    errMsg ? `PayTR rejected the refund: ${errMsg}${errNo ? ` (${errNo})` : ""}` : "PayTR rejected the refund",
  );
};

// ── iyzico ──────────────────────────────────────────────────────────────────

/**
 * Refund V2, deliberately — not the original `/payment/iyzipos/refund`.
 *
 * The v1 call refunds a single BASKET ITEM and is keyed on
 * `paymentTransactionId`, an id that lives inside `itemTransactions[]` and that
 * `payment_transactions` has never stored. V2 is keyed on `paymentId`, which is
 * exactly what `external_id` holds, and it lets iyzico decide the item
 * allocation itself.
 *
 * The trade is that iyzico documents V2 as unsuitable for a basket with more
 * than one item. Every checkout this codebase mints has exactly one synthesised
 * line, so backlex-originated payments are squarely inside that. A payment that
 * arrived from a multi-item basket created elsewhere is the case to watch, and
 * it is called out in the docs rather than silently mis-allocated.
 */
const IYZICO_REFUND_PATH = "/v2/payment/refund";

const iyzicoRefund = async (input: RefundInput): Promise<RefundResult> => {
  const apiKey = str(input.config.apiKey);
  const secretKey = str(input.config.secretKey);
  if (!apiKey || !secretKey) {
    return fail("missing_secret", "iyzico needs its API key and secret key to refund a payment");
  }

  const body = JSON.stringify({
    locale: (input.locale ?? "tr").slice(0, 2),
    conversationId: input.reference || input.externalId,
    paymentId: input.externalId,
    // Major-unit decimals outbound, minor units in the ledger — the same
    // conversion the checkout does, and the one that was already got wrong once.
    price: toMajorUnits(input.amount, input.currency),
    currency: input.currency.toUpperCase(),
    ip: input.customerIp || undefined,
  });
  const randomKey = `${input.nowMs ?? Date.now()}${Math.random().toString(36).slice(2, 10)}`;
  const headers = await iyzicoAuthHeaders(apiKey, secretKey, IYZICO_REFUND_PATH, body, randomKey);

  let res: Response;
  try {
    res = await doFetch(input)(`${iyzicoHost(input.config)}${IYZICO_REFUND_PATH}`, {
      method: "POST",
      headers,
      body,
    });
  } catch (e) {
    return fail("unreachable", `Could not reach iyzico: ${(e as Error).message}`);
  }
  if (!res.ok) return fail(statusReason(res.status), `iyzico returned HTTP ${res.status}`);

  const out = await jsonOf(res);
  if (!out) return fail("unreachable", "iyzico returned a non-JSON response");
  if (str(out.status) !== "success") {
    const message = str(out.errorMessage) ?? "iyzico rejected the refund";
    // iyzico reports an unknown payment as an ordinary error; naming it stops
    // the caller retrying a payment that does not exist.
    const code = str(out.errorCode) ?? "";
    return fail(/not found|bulunam/i.test(message) || code === "5088" ? "not_found" : "rejected", message);
  }
  return {
    ok: true,
    refundId: str(out.paymentTransactionId) ?? str(out.paymentId) ?? input.externalId,
    amount: input.amount,
    status: "succeeded",
  };
};

// ── Polar ───────────────────────────────────────────────────────────────────

/** Polar's enum has a fourth member Stripe's does not, which is where our
 *  `other` lands rather than being dropped. */
const POLAR_REASONS: Record<RefundReason, string> = {
  duplicate: "duplicate",
  fraudulent: "fraudulent",
  requested_by_customer: "customer_request",
  other: "other",
};

const polarRefund = async (input: RefundInput): Promise<RefundResult> => {
  const apiKey = str(input.config.apiKey);
  if (!apiKey) return fail("missing_secret", "Polar needs its access token to refund an order");

  let res: Response;
  try {
    res = await doFetch(input)(`${polarBase(input.config)}/v1/refunds`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: input.externalId,
        amount: input.amount,
        reason: POLAR_REASONS[input.reason ?? "other"],
        comment: input.description || undefined,
      }),
    });
  } catch (e) {
    return fail("unreachable", `Could not reach Polar: ${(e as Error).message}`);
  }

  const body = await jsonOf(res);
  if (!res.ok) {
    return fail(
      statusReason(res.status),
      str(body?.detail) ?? str(body?.error) ?? `Polar rejected the refund (HTTP ${res.status})`,
    );
  }
  const refundId = str(body?.id);
  if (!refundId) return fail("rejected", "Polar reported success with no refund id");
  return {
    ok: true,
    refundId,
    amount: typeof body?.amount === "number" ? body.amount : input.amount,
    status: str(body?.status) === "succeeded" ? "succeeded" : "pending",
  };
};

// ── Lemon Squeezy ───────────────────────────────────────────────────────────

/**
 * Lemon Squeezy refunds an ORDER, and its API is JSON:API — the amount travels
 * inside a `data.attributes` envelope with a matching `type` and `id`, and a
 * plain `{ amount }` body is rejected as malformed rather than as a bad amount.
 */
const lemonSqueezyRefund = async (input: RefundInput): Promise<RefundResult> => {
  const apiKey = str(input.config.apiKey);
  if (!apiKey) return fail("missing_secret", "Lemon Squeezy needs its API key to refund an order");

  let res: Response;
  try {
    res = await doFetch(input)(
      `https://api.lemonsqueezy.com/v1/orders/${encodeURIComponent(input.externalId)}/refund`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/vnd.api+json",
          Accept: "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "orders",
            id: String(input.externalId),
            // Cents, matching the ledger.
            attributes: { amount: input.amount },
          },
        }),
      },
    );
  } catch (e) {
    return fail("unreachable", `Could not reach Lemon Squeezy: ${(e as Error).message}`);
  }

  const body = await jsonOf(res);
  if (!res.ok) {
    const errors = body?.errors;
    const first = Array.isArray(errors) ? (errors[0] as Record<string, unknown> | undefined) : undefined;
    return fail(
      statusReason(res.status),
      str(first?.detail) ?? str(first?.title) ?? `Lemon Squeezy rejected the refund (HTTP ${res.status})`,
    );
  }
  const data = body?.data as Record<string, unknown> | undefined;
  return {
    ok: true,
    // The response is the updated ORDER, so its id is the order's, not a
    // separate refund's — Lemon Squeezy issues no refund object.
    refundId: str(data?.id) ?? input.externalId,
    amount: input.amount,
    status: "succeeded",
  };
};

// ── Paddle ──────────────────────────────────────────────────────────────────

/**
 * The payment row's `external_id` for Paddle is `<transaction id>:payment`.
 *
 * That suffix exists because one Paddle transaction produces both an invoice
 * record and a payment record, and the two would otherwise collide on the same
 * key. The adjustments API wants the bare `txn_…`, so it is stripped here — an
 * id with the suffix left on comes back as a validation error about a malformed
 * Paddle id, which reads like our stored value is corrupt rather than decorated.
 */
const PADDLE_PAYMENT_SUFFIX = ":payment";

export const paddleTransactionId = (externalId: string): string =>
  externalId.endsWith(PADDLE_PAYMENT_SUFFIX)
    ? externalId.slice(0, -PADDLE_PAYMENT_SUFFIX.length)
    : externalId;

const paddleRefund = async (input: RefundInput): Promise<RefundResult> => {
  const apiKey = str(input.config.apiKey);
  if (!apiKey) return fail("missing_secret", "Paddle needs its API key to refund a transaction");
  // Guarded again here as well as in `createRefund`, because this is the branch
  // that would otherwise send a `full` adjustment for a partial amount and
  // return the WHOLE transaction to the customer.
  if (input.full !== true) {
    return fail(
      "partial_unsupported",
      "Paddle refunds part of a transaction by adjusting individual line items, and " +
        "backlex stores a payment as one amount rather than a basket — only a full " +
        "refund can be issued from here",
    );
  }

  let res: Response;
  try {
    res = await doFetch(input)(`${paddleBase(input.config)}/adjustments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "refund",
        transaction_id: paddleTransactionId(input.externalId),
        // Paddle requires a human-readable reason and keeps it for the record.
        reason: input.description || input.reason || DEFAULT_DESCRIPTION,
        type: "full",
      }),
    });
  } catch (e) {
    return fail("unreachable", `Could not reach Paddle: ${(e as Error).message}`);
  }

  const body = await jsonOf(res);
  if (!res.ok) {
    const error = body?.error as Record<string, unknown> | undefined;
    return fail(
      statusReason(res.status),
      str(error?.detail) ?? `Paddle rejected the refund (HTTP ${res.status})`,
    );
  }
  const data = body?.data as Record<string, unknown> | undefined;
  const refundId = str(data?.id);
  if (!refundId) return fail("rejected", "Paddle reported success with no adjustment id");
  const status = str(data?.status);
  // Live refunds are held for Paddle to review; sandbox auto-approves on a
  // timer. Reporting `pending_approval` as done would tell an operator the
  // money is on its way back when Paddle may still decline it.
  const approved = status === "approved";
  return {
    ok: true,
    refundId,
    amount: input.amount,
    status: approved ? "succeeded" : "pending",
    note: approved ? undefined : "Paddle holds refunds for review before the money moves",
  };
};

// ── dummy ───────────────────────────────────────────────────────────────────

/**
 * No network, no credential, no failure mode. The `dummy` provider exists so a
 * demo instance and the smoke tests can drive the whole money path without a
 * PSP account, and it is gated to non-production by the consumer for the same
 * reason its checkout is: a provider that records refunds as succeeded is a
 * foot-gun anywhere real money is involved.
 */
const dummyRefund = (input: RefundInput): RefundResult => ({
  ok: true,
  refundId: `dummy_re_${input.externalId}_${input.nowMs ?? Date.now()}`,
  amount: input.amount,
  status: "succeeded",
});

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Give back some or all of a payment.
 *
 * Never throws: a transport failure, a provider refusal and a bad input are all
 * `{ ok: false, reason }`, because the caller has to tell them apart before it
 * decides whether to retry — and a refund retried against a provider that
 * already accepted it is the one mistake in this module that costs real money.
 * Only `unreachable` is worth retrying, and only with the same
 * `idempotencyKey`.
 */
export async function createRefund(provider: string, input: RefundInput): Promise<RefundResult> {
  if (!isPaymentProvider(provider)) {
    return fail("unknown_provider", `Unknown payment provider "${provider}"`);
  }
  const support = refundSupportOf(provider);
  if (support === null) return fail("unsupported", `${provider} cannot issue refunds`);

  const invalid = validateCommon(input);
  if (invalid) return invalid;

  if (support === "full_only" && input.full !== true) {
    return fail(
      "partial_unsupported",
      `${provider} can only refund a payment in full from here`,
    );
  }

  switch (provider) {
    case "stripe":
      return stripeRefund(input);
    case "adyen":
      return adyenRefund(input);
    case "klarna":
      return klarnaRefund(input);
    case "authorizenet":
      return authorizeNetRefund(input);
    case "paytr":
      return paytrRefund(input);
    case "iyzico":
      return iyzicoRefund(input);
    case "polar":
      return polarRefund(input);
    case "lemonsqueezy":
      return lemonSqueezyRefund(input);
    case "paddle":
      return paddleRefund(input);
    case "dummy":
      return dummyRefund(input);
    default:
      // Unreachable while the support table and this switch agree; a new
      // refundable provider with no branch lands here rather than silently
      // reporting a refund that never happened.
      return fail("unsupported", `${provider} has no refund implementation`);
  }
}
