/**
 * @backlex/integrations/payments — runtime-agnostic payment-provider adapters.
 *
 * Payments are deliberately NOT an `INTEGRATION_KINDS` entry. The kinds in
 * `./index.ts` model an OUTBOUND fan-out ("send this data event to Slack");
 * a payment provider is the opposite shape: it pushes signed webhooks AT us
 * and we pull its objects back for reconciliation. Sharing the `integrations`
 * table would also mean `dispatchIntegrations` fanning every record change at
 * Stripe, which is nonsense. So payments get their own kind list, their own
 * config schema, and their own system tables (`payment_providers` /
 * `payment_events`) on the consumer side.
 *
 * This module stays pure: no DB, no env, no persistence. It does use the
 * global Web Crypto (`crypto.subtle`), which every backlex runtime has
 * (Workers, Bun, Node 18+, Vercel, Netlify) — that is the one capability a
 * signature verifier cannot do without.
 *
 * The CONSUMER owns: storing + encrypting `config`, deduplicating events by
 * `eventId`, and writing the normalized rows into collections.
 */

import {
  DUMMY_SETTLEMENT_DOMAIN,
  enc,
  fromBase64,
  fromHex,
  hmac,
  timingSafeEqual,
  toBase64,
  toHex,
} from "./payment-crypto";

export const PAYMENT_PROVIDERS = [
  "stripe",
  "polar",
  "lemonsqueezy",
  "paddle",
  "paytr",
  "iyzico",
  // A global acquirer rather than a billing platform: Adyen processes the card
  // and reports what happened, but owns no customer/subscription/invoice
  // catalog to mirror. That distinction is why `PAYMENT_HAS_CATALOG` exists.
  "adyen",
  // The other acquirer shape, and the one that keeps the LEAST in its
  // notifications: Authorize.net signs the delivery like a webhook provider but
  // tells us only a transaction id and an amount — no currency, no order, no
  // merchant reference. What ties a payment to the row that asked for it has to
  // be fetched back. See `retrieveAuthorizeNetTransaction`.
  "authorizenet",
  // Buy-now-pay-later rather than a card acquirer, which changes what the
  // integration is FOR: Klarna's value is at the checkout moment, so an
  // inbound-only connection would only ever watch payments backlex never
  // initiated. It also authenticates nothing on the way in — its hosted page
  // posts an unsigned status change and the truth is fetched back — which puts
  // it in `retrieve` alongside iyzico. See `retrieveKlarnaPayment`.
  "klarna",
  // Not a PSP. A local, self-hosted stand-in that settles payments without
  // touching a real acquirer — the payment sibling of the `console` SMS and
  // email adapters, for demo instances and for smoke-testing a checkout flow
  // end to end without live keys. Connecting it is gated to demo/dev by the
  // consumer, because a provider that records payments as succeeded is a
  // foot-gun in production.
  "dummy",
] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const isPaymentProvider = (v: string): v is PaymentProvider =>
  (PAYMENT_PROVIDERS as readonly string[]).includes(v);

/** Human label per provider — used by the connect dialog and the CLI. */
export const PAYMENT_PROVIDER_LABELS: Record<PaymentProvider, string> = {
  stripe: "Stripe",
  polar: "Polar",
  lemonsqueezy: "Lemon Squeezy",
  paddle: "Paddle",
  paytr: "PayTR",
  iyzico: "iyzico",
  adyen: "Adyen",
  authorizenet: "Authorize.net",
  klarna: "Klarna",
  dummy: "Dummy (test only)",
};

/**
 * How a provider talks to us — the distinction the rest of this module branches
 * on.
 *
 * `webhook` (Stripe / Polar / Lemon Squeezy / Paddle / Adyen): the provider
 * pushes signed JSON events, so authenticity is established by checking a
 * signature against the delivery.
 *
 * Whether that same provider also exposes a LISTABLE object catalog is a
 * separate question — see `PAYMENT_HAS_CATALOG`. The two travelled together
 * until Adyen, which signs its notifications but is an acquirer with no
 * customer/subscription/invoice catalog to page through.
 *
 * `callback` (PayTR, and the Turkish PSPs generally): the provider POSTs a
 * form-encoded result to a callback URL when a payment settles, and that is the
 * whole surface — there is no catalog to page through. Reconcile is therefore
 * not merely unimplemented for these, it is *impossible*, and pretending
 * otherwise would report a successful sync that synced nothing.
 *
 * `retrieve` (iyzico, Klarna): the provider POSTs an unsigned body carrying
 * nothing but a HANDLE — iyzico a payment `token`, Klarna an HPP
 * `session.session_id` — and the result is fetched by calling the provider back
 * with the merchant's own API credentials. Authenticity therefore comes from
 * the RESPONSE, not the request: the posted body is discarded except for that
 * handle, and everything recorded is what the provider told us when we asked.
 * A forged or foreign handle yields an error or a stranger's `failure`, never a
 * recorded payment. Inventing a signature scheme for this instead would either
 * reject every real callback or accept forgeries. Klarna is explicit about it —
 * its own documentation tells merchants to put a one-time token in the callback
 * URL, because there is no signature to check.
 */
export type PaymentProviderMode = "webhook" | "callback" | "retrieve";

export const PAYMENT_PROVIDER_MODES: Record<PaymentProvider, PaymentProviderMode> = {
  stripe: "webhook",
  polar: "webhook",
  lemonsqueezy: "webhook",
  // Paddle is a merchant of record: it pushes signed events AND exposes a
  // paginated catalog, so it fits the webhook shape exactly.
  paddle: "webhook",
  paytr: "callback",
  iyzico: "retrieve",
  // Adyen signs every notification item with an HMAC, so the delivery IS the
  // evidence — the same shape as Stripe's, even though the signature travels
  // inside the JSON body rather than in a header.
  adyen: "webhook",
  // Authorize.net HMACs the raw body and puts the result in a header, the same
  // shape as Stripe's. The delivery is therefore the evidence — what it is NOT
  // is self-contained, which is a separate problem handled at normalize time.
  authorizenet: "webhook",
  // Klarna's Hosted Payment Page POSTs `{event_id, session:{session_id,status}}`
  // to the `status_update` URL with no signature over it at all, so the body is
  // a notification rather than evidence. The session is read back over Basic
  // auth, and a session id belonging to another merchant simply 404s.
  klarna: "retrieve",
  // The dummy page POSTs a form back the way a Turkish PSP does, and signs it
  // with the provider's own generated secret. It sits in `callback` rather
  // than getting a fourth mode precisely so it exercises the real code path —
  // a test provider that bypassed verification would test nothing.
  dummy: "callback",
};

export const isCallbackProvider = (p: string): boolean =>
  PAYMENT_PROVIDER_MODES[p as PaymentProvider] === "callback";

export const isRetrieveProvider = (p: string): boolean =>
  PAYMENT_PROVIDER_MODES[p as PaymentProvider] === "retrieve";

/**
 * Only a `webhook` provider signs its request and exposes a listable catalog.
 *
 * Everything that used to ask `isCallbackProvider` to mean "not a webhook
 * provider" asks this instead. The difference is not cosmetic: with a third
 * mode, `!isCallbackProvider` becomes TRUE for iyzico, so the signature
 * backstop would let it fall through to a branch that HMACs with an empty key,
 * and the reconcile gate would send it off to page a catalog that does not
 * exist. Deriving from the mode table keeps a fourth mode from doing the same.
 */
export const isWebhookProvider = (p: string): boolean =>
  PAYMENT_PROVIDER_MODES[p as PaymentProvider] === "webhook";

/**
 * Does this provider expose a listable object catalog to reconcile against?
 *
 * Split out from `isWebhookProvider` when Adyen arrived. Until then "signs its
 * pushes" and "can be paged through" were the same set, so one predicate did
 * both jobs — but Adyen is an ACQUIRER, not a billing platform. It authorises
 * cards and reports what happened; the customer, subscription and invoice
 * objects the other providers own simply do not exist on its side, and its
 * historical data comes out as scheduled report files rather than a paginated
 * API.
 *
 * Keeping the questions separate is what stops a reconcile from being offered
 * for a provider that has nothing to walk — which would either error out or,
 * worse, report a clean sync that synced nothing.
 */
export const PAYMENT_HAS_CATALOG: Record<PaymentProvider, boolean> = {
  stripe: true,
  polar: true,
  lemonsqueezy: true,
  paddle: true,
  // No catalog: each of these reports a settlement and nothing else.
  paytr: false,
  iyzico: false,
  adyen: false,
  // Authorize.net has reporting endpoints, but nothing that pages over
  // everything: `getTransactionListRequest` wants a settlement BATCH id, so
  // "walk the account" means enumerating batches by date range first. That is a
  // different, date-windowed operation rather than the cursor the reconcile
  // loop is built around, and offering it here would return a clean sync that
  // covered whichever batch happened to be first.
  authorizenet: false,
  // Klarna's Order Management API is addressed one `order_id` at a time; there
  // is no endpoint that pages over an account's orders, and no customer or
  // subscription object to mirror at all. Settlement reports come out of the
  // Merchant Portal as files, which is not a cursor.
  klarna: false,
  dummy: false,
};

export const hasObjectCatalog = (p: string): boolean =>
  PAYMENT_HAS_CATALOG[p as PaymentProvider] === true;

/**
 * Can this provider be asked about ONE payment, by the id we already stored?
 *
 * The answer to a different question from `PAYMENT_HAS_CATALOG`, and the one
 * that rescues the catalog-less providers. Klarna has no endpoint that pages
 * over an account — but every `order_id` it ever gave us is sitting in
 * `payment_transactions`. **We are the catalog.** So a sync for these providers
 * walks OUR rows and re-reads each one, which catches the refunds, late
 * captures and cancellations that a settlement-time-only integration is
 * structurally blind to.
 *
 * The bar is higher than "has a read endpoint", because the ledger upsert
 * REPLACES the row: a refresh has to restate EVERY money column it writes, or
 * it blanks whatever it left out. That is what rules iyzico out despite
 * `POST /payment/detail` existing and taking the `paymentId` we store — its
 * refunds live per item transaction in `itemTransactions[].refundHistory`, and
 * a mapping written on a guess would zero or misstate `amount_refunded` on
 * every pass. A provider only earns a `true` here once its single-payment read
 * is known to state the whole row.
 *
 * The four catalog providers are `false` because reconcile already walks them
 * properly; this is not a second way to do the same job.
 */
export const PAYMENT_CAN_REFETCH: Record<PaymentProvider, boolean> = {
  stripe: false,
  polar: false,
  lemonsqueezy: false,
  paddle: false,
  // No single-payment read at all: PayTR's callback is the entire surface, and
  // Adyen's history comes out as scheduled report FILES rather than an API.
  paytr: false,
  adyen: false,
  // Endpoint exists and takes the id we store; the refund shape does not.
  // See the paragraph above before changing this to `true`.
  iyzico: false,
  // `getTransactionDetailsRequest` states the transaction in full. Refunds are
  // separate transactions with their own rows, exactly as the webhook path
  // already records them, so a refresh restates the same columns it would.
  authorizenet: true,
  // `GET /ordermanagement/v1/orders/{id}` states order/captured/refunded amount,
  // status, fraud status and the merchant reference — the whole row.
  klarna: true,
  dummy: false,
};

export const canRefetchPayment = (p: string): boolean =>
  PAYMENT_CAN_REFETCH[p as PaymentProvider] === true;

/**
 * Which kind of sync, if any, this provider gets — the single answer the
 * service, the catalog endpoint and the admin UI all branch on.
 *
 * `catalog` walks the PROVIDER's listing. `refresh` walks OURS. `null` means
 * the connection genuinely cannot be synced, and saying so is the point: a
 * button that can only ever return an explanation is worse than no button.
 */
export type PaymentSyncMode = "catalog" | "refresh";

export const paymentSyncMode = (p: string): PaymentSyncMode | null =>
  hasObjectCatalog(p) ? "catalog" : canRefetchPayment(p) ? "refresh" : null;

/** The PayTR fields that go into the hash, in signing order. */
export const PAYTR_SIGNED_FIELDS = ["merchant_oid", "status", "total_amount"] as const;

/**
 * Parse a callback provider's form body into the object the normalizer sees.
 *
 * Exported so the consumer uses the SAME extraction the verifier does. Doing it
 * ad hoc with `Object.fromEntries` picks the LAST value of a repeated key while
 * the verifier reads the FIRST — the divergence that lets a signed
 * `status=failed` be recorded as a success.
 */
export const parseCallbackBody = (rawBody: string): Record<string, string> => {
  const form = new URLSearchParams(rawBody);
  const out: Record<string, string> = {};
  // First occurrence wins, matching `URLSearchParams.get` in the verifier.
  for (const [k, v] of form) if (!(k in out)) out[k] = v;
  return out;
};

/**
 * What the receive endpoint must write back, per provider.
 *
 * PayTR is the reason this exists: it requires the literal body `OK` and treats
 * anything else — including a perfectly good JSON success — as a failure, then
 * retries the callback on a schedule and eventually disables the merchant's
 * notification URL. `null` means "the default JSON envelope is fine".
 */
export const PAYMENT_ACK: Record<PaymentProvider, { body: string; contentType: string } | null> = {
  stripe: null,
  polar: null,
  lemonsqueezy: null,
  paddle: null,
  paytr: { body: "OK", contentType: "text/plain; charset=utf-8" },
  // iyzico is happy with any 2xx; the default envelope is fine.
  iyzico: null,
  // Adyen's documented acknowledgement. Newer versions of its docs say any 2xx
  // is accepted and the body is ignored, but `[accepted]` was required for
  // years and is still honoured — so it costs nothing and covers both.
  // Without it an older account's endpoint keeps retrying and is eventually
  // disabled, exactly the way PayTR's does.
  adyen: { body: "[accepted]", contentType: "text/plain; charset=utf-8" },
  // Any 2xx satisfies Authorize.net; it reads the status and ignores the body.
  authorizenet: null,
  // Klarna reads the status code and ignores the body.
  klarna: null,
  dummy: null,
};

/** One config field a UI should collect. Mirrors `IntegrationConfigField`. */
export interface PaymentConfigField {
  key: string;
  label: string;
  placeholder?: string;
  /** Encrypted at rest, masked when read back. */
  secret?: boolean;
  /** Optional fields may be left blank in the connect dialog. */
  optional?: boolean;
  /** Finite value set — the connect dialog renders a select instead of a
   *  free-text input. */
  choices?: string[];
  hint?: string;
}

/**
 * The countries Klarna sells in, as ISO-3166 alpha-2.
 *
 * A list rather than "any two letters" because `purchase_country` is not a
 * formality — it selects which BNPL methods the consumer is shown, and Klarna
 * rejects a market the merchant account is not enabled for. Offering a free-text
 * box would turn a typo into a rejected checkout with a message about payment
 * methods rather than about the country.
 */
export const KLARNA_MARKETS: readonly string[] = [
  "AT", "AU", "BE", "CA", "CH", "CZ", "DE", "DK", "ES", "FI", "FR", "GB",
  "GR", "IE", "IT", "MX", "NL", "NO", "NZ", "PL", "PT", "RO", "SE", "US",
];

export const PAYMENT_PROVIDER_FIELDS: Record<PaymentProvider, PaymentConfigField[]> = {
  stripe: [
    {
      key: "apiKey",
      label: "Secret API key",
      placeholder: "sk_live_… or rk_live_…",
      secret: true,
      hint: "A restricted key with read access to customers, subscriptions, invoices and charges is enough.",
    },
    {
      key: "webhookSecret",
      label: "Webhook signing secret",
      placeholder: "whsec_…",
      secret: true,
      hint: "Shown once when you add the endpoint in Stripe → Developers → Webhooks.",
    },
  ],
  polar: [
    { key: "apiKey", label: "Organization access token", placeholder: "polar_oat_…", secret: true },
    { key: "webhookSecret", label: "Webhook secret", placeholder: "whsec_… (base64)", secret: true },
    {
      key: "server",
      label: "Environment",
      placeholder: "production",
      optional: true,
      choices: ["production", "sandbox"],
      hint: "Sandbox points at Polar's test API — use it while wiring things up.",
    },
  ],
  lemonsqueezy: [
    { key: "apiKey", label: "API key", placeholder: "eyJ0eXAiOi…", secret: true },
    { key: "webhookSecret", label: "Signing secret", placeholder: "The secret you set on the webhook", secret: true },
    {
      key: "storeId",
      label: "Store ID",
      placeholder: "12345",
      optional: true,
      hint: "Scopes the reconcile pull to one store. Leave blank to sync every store on the account.",
    },
  ],
  paddle: [
    {
      key: "apiKey",
      label: "API key",
      placeholder: "pdl_live_… or pdl_sdbx_…",
      secret: true,
      hint: "A read-only key is enough — reconcile only lists customers, subscriptions and transactions.",
    },
    {
      key: "webhookSecret",
      label: "Notification secret",
      placeholder: "pdl_ntfset_…",
      secret: true,
      hint: "Shown once when you create the notification destination in Paddle.",
    },
    {
      key: "environment",
      label: "Environment",
      choices: ["production", "sandbox"],
      hint: "Sandbox points at sandbox-api.paddle.com.",
    },
  ],
  paytr: [
    { key: "merchantId", label: "Merchant ID", placeholder: "123456" },
    { key: "merchantKey", label: "Merchant key", placeholder: "From the PayTR panel", secret: true },
    { key: "merchantSalt", label: "Merchant salt", placeholder: "From the PayTR panel", secret: true },
    {
      key: "environment",
      label: "Environment",
      optional: true,
      choices: ["production", "test"],
      hint: "Test opens checkouts with PayTR's `test_mode` set, so no card is charged.",
    },
  ],
  iyzico: [
    {
      key: "apiKey",
      label: "API key",
      placeholder: "sandbox-… or the live key",
      secret: true,
      hint: "Used to authenticate the call that retrieves each payment — the callback itself carries no signature.",
    },
    { key: "secretKey", label: "Secret key", placeholder: "From the iyzico merchant panel", secret: true },
    {
      key: "environment",
      label: "Environment",
      choices: ["production", "sandbox"],
      hint: "Sandbox points at sandbox-api.iyzipay.com.",
    },
  ],
  adyen: [
    {
      key: "apiKey",
      label: "API key",
      placeholder: "AQE1hmfx…",
      secret: true,
      hint: "Customer Area → Developers → API credentials. Needs the Checkout role to open payment links.",
    },
    {
      key: "merchantAccount",
      label: "Merchant account",
      placeholder: "YourCompanyECOM",
      hint: "The account code, not the company account — Adyen rejects a payment link opened against the wrong one.",
    },
    {
      key: "webhookSecret",
      label: "HMAC key",
      placeholder: "The hex key generated with the webhook",
      secret: true,
      hint: "Customer Area → Developers → Webhooks → Generate HMAC key. It signs each notification item.",
    },
    {
      key: "environment",
      label: "Environment",
      choices: ["test", "live"],
      hint: "Test points at checkout-test.adyen.com.",
    },
    {
      key: "liveUrlPrefix",
      label: "Live URL prefix",
      placeholder: "1797a841fbb37ca7-AdyenDemo",
      optional: true,
      hint: "Required on live only. Adyen gives every merchant its own endpoint host; the prefix is shown next to the live API credential.",
    },
  ],
  authorizenet: [
    {
      key: "apiLoginId",
      label: "API login ID",
      placeholder: "5KP3u95bQpv",
      hint: "Account → Settings → Security Settings → API Credentials and Keys. Not the merchant login you sign in with.",
    },
    {
      key: "transactionKey",
      label: "Transaction key",
      placeholder: "346HZ32z3fP4hTG2",
      secret: true,
      hint: "Generated beside the API login ID, and shown only once.",
    },
    {
      key: "webhookSecret",
      label: "Signature key",
      placeholder: "The signature key from API Credentials and Keys",
      secret: true,
      hint: "Signs every webhook. A different value from the transaction key, on the same page — sending one where the other belongs fails every delivery.",
    },
    {
      key: "environment",
      label: "Environment",
      choices: ["production", "sandbox"],
      hint: "Sandbox points at apitest.authorize.net and needs sandbox credentials — a production key will not authenticate against it.",
    },
    {
      key: "currency",
      // Not a preference. Authorize.net's API carries no currency field
      // ANYWHERE — not on a transaction, not on a webhook, not in the schema —
      // because a merchant account settles in exactly one. Without this the
      // ledger would have to guess what an amount means.
      label: "Account currency",
      choices: ["USD", "CAD", "GBP", "EUR", "AUD", "NZD", "DKK", "NOK", "PLN", "SEK", "ZAR"],
      hint: "The single currency this merchant account settles in. Authorize.net never states it on a payment, so every recorded amount is filed under this.",
    },
  ],
  klarna: [
    {
      key: "username",
      label: "API username",
      placeholder: "PK00000_0a0a0a0a",
      hint: "Merchant Portal → Settings → Klarna API credentials. Half of a Basic-auth pair, not a bearer token.",
    },
    {
      key: "password",
      label: "API password",
      placeholder: "Shown once when the credential is created",
      secret: true,
    },
    {
      key: "region",
      // Klarna's regions are separate deployments, not a routing hint: a
      // European credential does not authenticate against the North American
      // host, and the failure reads as a bad password.
      label: "Region",
      choices: ["europe", "north_america", "oceania"],
      hint: "The region the API credential was issued in. Klarna runs one deployment per region and a credential works in exactly one.",
    },
    {
      key: "environment",
      label: "Environment",
      choices: ["playground", "production"],
      hint: "Playground points at api.playground.klarna.com and needs playground credentials.",
    },
    {
      key: "purchaseCountry",
      // Required by Klarna Payments and NOT derivable: it decides which BNPL
      // methods the consumer is offered, and Klarna refuses a country the
      // merchant account is not enabled for. A customer address can override it
      // per checkout when one is supplied.
      label: "Default purchase country",
      choices: [...KLARNA_MARKETS],
      hint: "Used when a checkout carries no customer country. Klarna decides which payment methods to offer from it, and refuses markets this account is not enabled for.",
    },
  ],
  dummy: [
    {
      key: "secret",
      label: "Signing secret",
      placeholder: "Generated for you if left blank",
      secret: true,
      optional: true,
      hint: "Signs both the hosted test checkout and the settlement it posts back.",
    },
  ],
};

/** Config keys holding secrets, per provider — encrypt at rest, mask on read. */
export const PAYMENT_SECRET_KEYS: Record<PaymentProvider, string[]> = {
  stripe: ["apiKey", "webhookSecret"],
  polar: ["apiKey", "webhookSecret"],
  lemonsqueezy: ["apiKey", "webhookSecret"],
  paddle: ["apiKey", "webhookSecret"],
  // A callback provider signs with its merchant credential rather than a
  // separate webhook secret, so the signing material IS that credential.
  paytr: ["merchantKey", "merchantSalt"],
  // iyzico signs nothing inbound; these authenticate the outbound retrieve,
  // which is what makes a callback trustworthy at all.
  iyzico: ["apiKey", "secretKey"],
  // `merchantAccount` and `liveUrlPrefix` are identifiers, not credentials —
  // masking them would hide the two fields an admin most often needs to check.
  adyen: ["apiKey", "webhookSecret"],
  // `apiLoginId` is half a credential and the field an admin most often needs
  // to read back; the transaction key is the half worth hiding. `currency` and
  // `environment` are settings, not secrets.
  authorizenet: ["transactionKey", "webhookSecret"],
  // The username is the half an admin needs to read back to tell two Klarna
  // credentials apart; `region`, `environment` and `purchaseCountry` are
  // settings whose values the admin has to be able to check.
  klarna: ["password"],
  dummy: ["secret"],
};

/**
 * Payment secrets are ENCRYPTED at rest by the consumer, so the value this
 * masker sees is ciphertext — a head/tail mask would show a fragment of the
 * envelope, not a recognisable `sk_live_…` prefix. A fixed sentinel is both
 * more honest and easier for the connect dialog to detect on resubmit.
 */
export const MASKED_SECRET = "••••••••";

/** Return a copy of `config` with this provider's secrets masked for display. */
export function maskPaymentConfig(
  provider: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const secrets = new Set(PAYMENT_SECRET_KEYS[provider as PaymentProvider] ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = secrets.has(k) && typeof v === "string" && v ? MASKED_SECRET : v;
  }
  return out;
}

// ── Signature verification ──────────────────────────────────────────────────

export interface VerifyInput {
  /** The EXACT bytes the provider signed — never a re-serialized object. */
  rawBody: string;
  /** Case-insensitive header lookup is done internally. */
  headers: Record<string, string> | Headers;
  /** Decrypted signing secret from the provider config. Used by the `webhook`
   *  providers, which have a dedicated signing secret. */
  secret: string;
  /** Whole decrypted provider config. A `callback` provider signs with its
   *  merchant credentials (PayTR needs BOTH the key and the salt), so one
   *  `secret` string cannot express it. */
  config?: Record<string, unknown>;
  /** Replay window in seconds for the timestamped schemes. Default 300. */
  toleranceSec?: number;
  /** Injectable clock (ms) so tests don't depend on wall time. */
  nowMs?: number;
}

export interface VerifyResult {
  ok: boolean;
  /** Machine-readable failure cause; `undefined` when `ok`. */
  reason?:
    | "unknown_provider"
    | "missing_secret"
    | "missing_signature"
    | "malformed_signature"
    | "timestamp_out_of_tolerance"
    | "signature_mismatch";
}

const headerOf = (headers: Record<string, string> | Headers, name: string): string | null => {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
};

// The HMAC + encoding primitives live in `./payment-crypto` so the outbound
// checkout builder signs with the same implementation this verifier checks
// against — see that module's header for why one copy matters.

/**
 * Verify a provider webhook signature. Never throws — a malformed header is a
 * `{ ok: false, reason }`, so the caller can log the cause and 400 uniformly.
 *
 *   stripe        `Stripe-Signature: t=<unix>,v1=<hex>` over `<t>.<body>`
 *   polar         standard-webhooks: `webhook-signature: v1,<base64>` over
 *                 `<webhook-id>.<webhook-timestamp>.<body>`, secret is
 *                 `whsec_<base64 key>`
 *   lemonsqueezy  `X-Signature: <hex>` over the raw body, secret is the
 *                 literal string
 */
export async function verifyPaymentSignature(
  provider: string,
  input: VerifyInput,
): Promise<VerifyResult> {
  if (!isPaymentProvider(provider)) return { ok: false, reason: "unknown_provider" };
  // Non-webhook providers carry their credentials in `config`, not `secret`.
  if (isWebhookProvider(provider) && !input.secret) {
    return { ok: false, reason: "missing_secret" };
  }

  if (provider === "paytr") {
    const cfg = input.config ?? {};
    const merchantKey = str(cfg.merchantKey);
    const merchantSalt = str(cfg.merchantSalt);
    if (!merchantKey || !merchantSalt) return { ok: false, reason: "missing_secret" };

    // PayTR posts application/x-www-form-urlencoded, and signs a concatenation
    // of specific FIELDS — not the raw body — so the body has to be parsed
    // before anything can be checked.
    const form = new URLSearchParams(input.rawBody);
    // Parameter pollution is a real forgery path here: `URLSearchParams.get`
    // returns the FIRST value while `Object.fromEntries` keeps the LAST, so a
    // body carrying `status` twice could be verified against one value and
    // recorded as the other — turning a genuine failed payment into a recorded
    // success. Duplicates of a signed field have no legitimate use; refuse.
    for (const field of PAYTR_SIGNED_FIELDS) {
      if (form.getAll(field).length > 1) return { ok: false, reason: "malformed_signature" };
    }
    if (form.getAll("hash").length > 1) return { ok: false, reason: "malformed_signature" };
    const merchantOid = form.get("merchant_oid");
    const status = form.get("status");
    const totalAmount = form.get("total_amount");
    const provided = form.get("hash");
    if (!provided) return { ok: false, reason: "missing_signature" };
    if (merchantOid === null || status === null || totalAmount === null) {
      return { ok: false, reason: "malformed_signature" };
    }
    // hash = base64(HMAC-SHA256(merchant_oid + merchant_salt + status + total_amount, merchant_key))
    const expected = toBase64(
      await hmac(enc.encode(merchantKey), `${merchantOid}${merchantSalt}${status}${totalAmount}`),
    );
    // PayTR's callback carries no timestamp, so there is no replay window to
    // enforce here; `merchant_oid` is the merchant's own unique order id and the
    // consumer dedupes on it.
    return timingSafeEqual(provided, expected)
      ? { ok: true }
      : { ok: false, reason: "signature_mismatch" };
  }
  if (provider === "dummy") {
    // Hex HMAC over the raw body, keyed by the provider's own generated
    // secret. The hosted page is served by backlex, so this verifies that the
    // settlement came from a checkout we minted rather than from anyone who
    // found the receive URL.
    //
    // The domain prefix is what stops the OTHER thing that secret signs — the
    // outbound checkout link — from being replayed here. Without it both are
    // `hex(HMAC(secret, text))` over attacker-visible bytes, so a link's `sig`
    // would verify as a settlement signature for the same bytes. It must match
    // `signDummySettlement` in `@backlex/integrations/checkout` exactly.
    const secret = str((input.config ?? {}).secret);
    if (!secret) return { ok: false, reason: "missing_secret" };
    const given = headerOf(input.headers, "x-backlex-signature");
    if (!given) return { ok: false, reason: "missing_signature" };
    const want = toHex(
      await hmac(enc.encode(secret), `${DUMMY_SETTLEMENT_DOMAIN}${input.rawBody}`),
    );
    return timingSafeEqual(given.trim(), want)
      ? { ok: true }
      : { ok: false, reason: "signature_mismatch" };
  }

  if (provider === "adyen") {
    // Adyen is the one provider whose signature travels INSIDE the body: each
    // notification item carries its own `additionalData.hmacSignature` over a
    // canonical join of eight of its own fields, not over the raw bytes.
    //
    // The HMAC key from the Customer Area is HEX — signing with the ASCII of
    // that string silently never matches, so a bad decode is treated as a
    // missing credential rather than a mismatch.
    const keyBytes = fromHex(input.secret);
    if (!keyBytes) return { ok: false, reason: "missing_secret" };

    let body: unknown;
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      return { ok: false, reason: "malformed_signature" };
    }
    const items = adyenNotificationItems(body);
    // An empty batch has nothing to authenticate, so accepting it would accept
    // an unsigned request that happens to parse.
    if (items.length === 0) return { ok: false, reason: "missing_signature" };

    // EVERY item must verify, and the same extractor feeds the normalizer.
    // Checking only the first would let anyone append extra items to a genuine
    // delivery and have them recorded — Adyen may legitimately batch several
    // notifications into one POST, so extra items are not by themselves odd.
    for (const item of items) {
      const given = str(obj(item.additionalData)?.hmacSignature);
      if (!given) return { ok: false, reason: "missing_signature" };
      const expected = toBase64(await hmac(keyBytes, adyenSigningString(item)));
      if (!timingSafeEqual(given, expected)) return { ok: false, reason: "signature_mismatch" };
    }
    // Adyen signs no timestamp, so there is no replay window to enforce here.
    // `pspReference` is unique per event and the consumer dedupes on it, which
    // is what makes a replayed delivery a no-op.
    return { ok: true };
  }

  // Backstop. Every branch below assumes a `webhook` provider with a real
  // signing secret; a non-webhook provider that reached here has no branch of
  // its own and would fall through to the last one, which HMACs with an empty
  // key — and an empty-key HMAC is computable by anyone, so it would accept
  // forgeries. Asked as "is this a webhook provider" rather than "is this the
  // callback provider", so a mode added later fails closed by default.
  if (!isWebhookProvider(provider)) return { ok: false, reason: "unknown_provider" };

  const toleranceSec = input.toleranceSec ?? 300;
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);

  if (provider === "stripe") {
    const header = headerOf(input.headers, "stripe-signature");
    if (!header) return { ok: false, reason: "missing_signature" };
    let timestamp = "";
    const candidates: string[] = [];
    for (const part of header.split(",")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k === "t") timestamp = v;
      else if (k === "v1") candidates.push(v);
    }
    if (!timestamp || candidates.length === 0) return { ok: false, reason: "malformed_signature" };
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, reason: "malformed_signature" };
    if (Math.abs(nowSec - ts) > toleranceSec) return { ok: false, reason: "timestamp_out_of_tolerance" };
    const expected = toHex(await hmac(enc.encode(input.secret), `${timestamp}.${input.rawBody}`));
    // Stripe sends every active endpoint secret's signature during a rotation,
    // so any one matching v1 is a pass.
    return candidates.some((c) => timingSafeEqual(c, expected))
      ? { ok: true }
      : { ok: false, reason: "signature_mismatch" };
  }

  if (provider === "authorizenet") {
    // `X-ANET-Signature: sha512=<HEX>` — HMAC-SHA512 over the raw body.
    //
    // The key is the Signature Key from the merchant interface, used as its
    // literal characters. That is the OPPOSITE of Adyen, whose HMAC key is the
    // hex ENCODING of the key bytes and has to be decoded first — and both keys
    // are long printable hex-looking strings, so the two are easy to confuse
    // and impossible to tell apart by eye. Getting it wrong produces a
    // well-formed signature that never matches any delivery.
    const header = headerOf(input.headers, "x-anet-signature");
    if (!header) return { ok: false, reason: "missing_signature" };
    const eq = header.indexOf("=");
    if (eq < 0) return { ok: false, reason: "malformed_signature" };
    const scheme = header.slice(0, eq).trim().toLowerCase();
    const given = header.slice(eq + 1).trim();
    // Pinned rather than inferred from the value's length: accepting whatever
    // algorithm the sender names is how a downgrade gets in.
    if (scheme !== "sha512" || !given) return { ok: false, reason: "malformed_signature" };
    const expected = toHex(await hmac(enc.encode(input.secret), input.rawBody, "SHA-512"));
    // Authorize.net sends the digest upper-cased; compare on one case so a
    // change of mind on their side isn't a total outage.
    return timingSafeEqual(given.toLowerCase(), expected)
      ? { ok: true }
      : { ok: false, reason: "signature_mismatch" };
  }

  if (provider === "paddle") {
    // `Paddle-Signature: ts=<unix>;h1=<hex>` — HMAC-SHA256 over `ts:rawBody`
    // keyed by the notification secret. Same shape as Stripe's, different
    // separator, and the secret is used raw (no base64 decode).
    const header = headerOf(input.headers, "paddle-signature");
    if (!header) return { ok: false, reason: "missing_signature" };
    let timestamp = "";
    const candidates: string[] = [];
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k === "ts") timestamp = v;
      else if (k === "h1") candidates.push(v);
    }
    if (!timestamp || candidates.length === 0) return { ok: false, reason: "malformed_signature" };
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, reason: "malformed_signature" };
    // Without the window a captured event could be replayed indefinitely.
    if (Math.abs(nowSec - ts) > toleranceSec) {
      return { ok: false, reason: "timestamp_out_of_tolerance" };
    }
    const expected = toHex(await hmac(enc.encode(input.secret), `${timestamp}:${input.rawBody}`));
    return candidates.some((c) => timingSafeEqual(c, expected))
      ? { ok: true }
      : { ok: false, reason: "signature_mismatch" };
  }

  if (provider === "polar") {
    const id = headerOf(input.headers, "webhook-id");
    const timestamp = headerOf(input.headers, "webhook-timestamp");
    const sigHeader = headerOf(input.headers, "webhook-signature");
    if (!id || !timestamp || !sigHeader) return { ok: false, reason: "missing_signature" };
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, reason: "malformed_signature" };
    if (Math.abs(nowSec - ts) > toleranceSec) return { ok: false, reason: "timestamp_out_of_tolerance" };
    // `whsec_` prefixed secrets carry a base64 key; a bare secret is used raw.
    const rawSecret = input.secret.startsWith("whsec_") ? input.secret.slice("whsec_".length) : input.secret;
    const keyBytes = fromBase64(rawSecret) ?? enc.encode(rawSecret);
    const expected = toBase64(await hmac(keyBytes, `${id}.${timestamp}.${input.rawBody}`));
    // Space-separated `v1,<sig>` entries — one per active secret.
    const candidates = sigHeader
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith("v1,") ? s.slice(3) : s));
    if (candidates.length === 0) return { ok: false, reason: "malformed_signature" };
    return candidates.some((c) => timingSafeEqual(c, expected))
      ? { ok: true }
      : { ok: false, reason: "signature_mismatch" };
  }

  // lemonsqueezy
  const sig = headerOf(input.headers, "x-signature");
  if (!sig) return { ok: false, reason: "missing_signature" };
  const expected = toHex(await hmac(enc.encode(input.secret), input.rawBody));
  return timingSafeEqual(sig.trim(), expected) ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

// ── Canonical record shapes ─────────────────────────────────────────────────

/** The four collections a payments sync writes into. */
export const PAYMENT_RECORD_KINDS = ["customer", "subscription", "invoice", "payment"] as const;
export type PaymentRecordKind = (typeof PAYMENT_RECORD_KINDS)[number];

/**
 * Collection slug per record kind — the contract between this module and the
 * collections the consumer provisions.
 *
 * All four are `payment_*` prefixed on purpose. The obvious name for the last
 * one is `payments`, but that slug is common enough in real schemas (invoicing,
 * ecommerce and clinic templates all ship one) that adopting it would mean
 * writing provider rows into somebody's unrelated business table.
 */
export const PAYMENT_COLLECTION_SLUGS: Record<PaymentRecordKind, string> = {
  customer: "payment_customers",
  subscription: "payment_subscriptions",
  invoice: "payment_invoices",
  payment: "payment_transactions",
};

/** Columns every synced collection must carry. A pre-existing collection that
 *  lacks them is somebody else's table wearing the same slug — never write to
 *  it (see `ensurePaymentCollections`). */
export const PAYMENT_MARKER_COLUMNS = ["provider", "external_id"] as const;

export interface PaymentRecord {
  kind: PaymentRecordKind;
  /** Snake_case columns matching the provisioned collection's fields. */
  row: Record<string, unknown>;
}

export interface NormalizedPaymentEvent {
  /** Provider-unique event id — the dedupe key. */
  eventId: string;
  /** Provider event name, verbatim (`invoice.paid`, `subscription_created`, …). */
  type: string;
  /** `false` for test/sandbox traffic when the provider says so, else null. */
  livemode: boolean | null;
  records: PaymentRecord[];
}

/** Namespaced row id — keeps two providers' `1` from colliding in one table. */
export const paymentRowId = (provider: string, externalId: string | number): string =>
  `${provider}_${String(externalId)}`;

const str = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : null;

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

const bool = (v: unknown): boolean => v === true || v === 1 || v === "true";

/**
 * ISO-4217 currencies whose minor unit is NOT two digits. Everything absent
 * from this table is assumed to be 2 (the overwhelming majority).
 *
 * This matters because `payment_transactions.amount` is an integer in minor
 * units, and providers disagree about what they quote: Stripe and PayTR send
 * minor units already, while iyzico quotes major-unit decimals ("108.90").
 * Hard-coding ×100 would be wrong for JPY (¥500 is 500, not 50000) and for the
 * three-digit Gulf dinars — and JPY in particular is unavoidable the moment a
 * Japanese provider is wired up.
 */
const CURRENCY_EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

/**
 * Digits after the decimal point for a currency's minor unit. Unknown or
 * malformed input falls back to 2.
 *
 * The `typeof` check rather than `?? 2` is belt-and-braces: an inherited
 * `Object.prototype` member would be an object, not `undefined`, and `??`
 * would pass it straight through into `10 ** it` as `NaN`. Upper-casing the
 * key already makes every such name non-matching (`"__PROTO__"` is not
 * `"__proto__"`), so this is defence for a future edit that drops the
 * normalisation, not a live hole.
 */
export const currencyExponent = (currency: string | null | undefined): number => {
  const e = CURRENCY_EXPONENTS[String(currency ?? "").toUpperCase()];
  return typeof e === "number" ? e : 2;
};

/**
 * A provider's major-unit figure ("108.90") → the integer minor units the
 * ledger stores (10890). Rounds rather than truncates: `108.9 * 100` is
 * `10889.999999999998` in binary floating point, and truncation would quietly
 * bill a cent short on a large fraction of real amounts.
 */
export const toMinorUnits = (
  value: unknown,
  currency: string | null | undefined,
): number | null => {
  const n = num(value);
  if (n === null) return null;
  return Math.round(n * 10 ** currencyExponent(currency));
};

/** Minor units (10890) → the major-unit decimal string providers such as
 *  iyzico expect on the way out ("108.90"). */
export const toMajorUnits = (
  minor: number,
  currency: string | null | undefined,
): string => {
  const e = currencyExponent(currency);
  return (minor / 10 ** e).toFixed(e);
};

/** Unix seconds → ms. */
const secToMs = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n * 1000);
};

/** ISO-8601 → ms. */
const isoToMs = (v: unknown): number | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const meta = (v: unknown): Record<string, unknown> | null => obj(v);

/** Relation value: the row id of a referenced object, or null. */
const rel = (provider: string, externalId: unknown): string | null => {
  const id = str(externalId);
  return id ? paymentRowId(provider, id) : null;
};

/**
 * The merchant's own identifier, coming back on a settlement.
 *
 * This is the return leg of `@backlex/integrations/checkout`: a checkout is
 * minted carrying the id of the row that asked for the money, and the provider
 * echoes it here. Without it a received payment is an orphan — the amount is
 * known and what it paid for is not.
 *
 * Stripe exposes it two ways. `client_reference_id` rides the Checkout Session
 * and is the documented field; `metadata.backlex_reference` is set on the
 * PaymentIntent as well, because a charge- or intent-shaped event never carries
 * the session's field. A reconcile that walks charges sees only the second one.
 */
const checkoutReference = (o: Record<string, unknown>): string | null =>
  str(o.client_reference_id) ?? str(meta(o.metadata)?.backlex_reference);

// ── Stripe mappers ──────────────────────────────────────────────────────────

const stripeCustomer = (o: Record<string, unknown>): PaymentRecord => ({
  kind: "customer",
  row: {
    id: paymentRowId("stripe", String(o.id)),
    provider: "stripe",
    external_id: String(o.id),
    email: str(o.email),
    name: str(o.name),
    currency: str(o.currency),
    delinquent: bool(o.delinquent),
    metadata: meta(o.metadata),
    source_created_at: secToMs(o.created),
  },
});

const stripeSubscription = (o: Record<string, unknown>): PaymentRecord => {
  const items = obj(o.items);
  const first = obj(Array.isArray(items?.data) ? items?.data[0] : undefined);
  const price = obj(first?.price);
  const recurring = obj(price?.recurring);
  const plan = obj(o.plan);
  return {
    kind: "subscription",
    row: {
      id: paymentRowId("stripe", String(o.id)),
      provider: "stripe",
      external_id: String(o.id),
      customer: rel("stripe", o.customer),
      status: str(o.status),
      product_name: str(price?.nickname) ?? str(plan?.nickname) ?? str(price?.product) ?? null,
      price_amount: num(price?.unit_amount) ?? num(plan?.amount),
      currency: str(price?.currency) ?? str(o.currency) ?? str(plan?.currency),
      billing_interval: str(recurring?.interval) ?? str(plan?.interval),
      quantity: num(first?.quantity) ?? num(o.quantity),
      current_period_start: secToMs(o.current_period_start ?? first?.current_period_start),
      current_period_end: secToMs(o.current_period_end ?? first?.current_period_end),
      cancel_at_period_end: bool(o.cancel_at_period_end),
      canceled_at: secToMs(o.canceled_at),
      trial_end: secToMs(o.trial_end),
      metadata: meta(o.metadata),
      source_created_at: secToMs(o.created ?? o.start_date),
    },
  };
};

const stripeInvoice = (o: Record<string, unknown>): PaymentRecord => {
  const transitions = obj(o.status_transitions);
  const parent = obj(o.parent);
  const subDetails = obj(parent?.subscription_details);
  return {
    kind: "invoice",
    row: {
      id: paymentRowId("stripe", String(o.id)),
      provider: "stripe",
      external_id: String(o.id),
      customer: rel("stripe", o.customer),
      // `invoice.subscription` was folded into `parent` in Stripe's 2025 API
      // versions; read both so either account version syncs.
      subscription: rel("stripe", o.subscription ?? subDetails?.subscription),
      number: str(o.number),
      status: str(o.status),
      amount_due: num(o.amount_due),
      amount_paid: num(o.amount_paid),
      amount_remaining: num(o.amount_remaining),
      currency: str(o.currency),
      hosted_url: str(o.hosted_invoice_url),
      due_at: secToMs(o.due_date),
      paid_at: secToMs(transitions?.paid_at),
      metadata: meta(o.metadata),
      source_created_at: secToMs(o.created),
    },
  };
};

const stripeChargePayment = (o: Record<string, unknown>): PaymentRecord => {
  const methodDetails = obj(o.payment_method_details);
  return {
    kind: "payment",
    row: {
      id: paymentRowId("stripe", String(o.id)),
      provider: "stripe",
      external_id: String(o.id),
      customer: rel("stripe", o.customer),
      invoice: rel("stripe", o.invoice),
      amount: num(o.amount),
      amount_refunded: num(o.amount_refunded) ?? 0,
      currency: str(o.currency),
      status: str(o.status),
      method: str(methodDetails?.type) ?? str(o.payment_method),
      failure_reason: str(o.failure_message) ?? str(o.failure_code),
      reference: checkoutReference(o),
      processed_at: secToMs(o.created),
      metadata: meta(o.metadata),
      source_created_at: secToMs(o.created),
    },
  };
};

const stripeIntentPayment = (o: Record<string, unknown>): PaymentRecord => {
  const err = obj(o.last_payment_error);
  return {
    kind: "payment",
    row: {
      id: paymentRowId("stripe", String(o.id)),
      provider: "stripe",
      external_id: String(o.id),
      customer: rel("stripe", o.customer),
      invoice: rel("stripe", o.invoice),
      amount: num(o.amount_received) ?? num(o.amount),
      amount_refunded: 0,
      currency: str(o.currency),
      status: str(o.status),
      method: str(o.payment_method_types ? (o.payment_method_types as unknown[])[0] : null),
      failure_reason: str(err?.message) ?? str(err?.code),
      reference: checkoutReference(o),
      processed_at: secToMs(o.created),
      metadata: meta(o.metadata),
      source_created_at: secToMs(o.created),
    },
  };
};

/**
 * A completed Checkout Session → the payment it produced.
 *
 * Keyed on the PAYMENT INTENT id, not the session id, on purpose. Stripe fires
 * `checkout.session.completed` and `payment_intent.succeeded` for the same
 * money; keying on `cs_…` would file two payment rows for one charge. Sharing
 * the intent's row id makes the two events upsert over each other instead —
 * and the session is the one carrying `client_reference_id`, so whichever
 * arrives second, the reference survives.
 *
 * A session with no payment intent (subscription setup, a zero-total order) is
 * not a payment and produces nothing.
 */
const stripeSessionPayment = (o: Record<string, unknown>): PaymentRecord | null => {
  const intentId = str(o.payment_intent);
  if (!intentId) return null;
  const paid = str(o.payment_status) === "paid";
  return {
    kind: "payment",
    row: {
      id: paymentRowId("stripe", intentId),
      provider: "stripe",
      external_id: intentId,
      customer: rel("stripe", o.customer),
      invoice: rel("stripe", o.invoice),
      amount: num(o.amount_total),
      amount_refunded: 0,
      currency: str(o.currency),
      status: paid ? "succeeded" : "pending",
      method: null,
      failure_reason: null,
      reference: checkoutReference(o),
      processed_at: paid ? secToMs(o.created) : null,
      metadata: meta(o.metadata),
      source_created_at: secToMs(o.created),
    },
  };
};

const normalizeStripe = (payload: Record<string, unknown>): NormalizedPaymentEvent => {
  const type = str(payload.type) ?? "";
  const data = obj(payload.data);
  const o = obj(data?.object);
  const records: PaymentRecord[] = [];
  if (o && typeof o.id === "string") {
    if (type.startsWith("customer.subscription.")) records.push(stripeSubscription(o));
    else if (type.startsWith("customer.")) records.push(stripeCustomer(o));
    else if (type.startsWith("invoice.")) records.push(stripeInvoice(o));
    else if (type.startsWith("charge.")) records.push(stripeChargePayment(o));
    else if (type.startsWith("payment_intent.")) records.push(stripeIntentPayment(o));
    else if (type.startsWith("checkout.session.")) {
      const session = stripeSessionPayment(o);
      if (session) records.push(session);
    }
  }
  return {
    eventId: str(payload.id) ?? "",
    type,
    livemode: typeof payload.livemode === "boolean" ? payload.livemode : null,
    records,
  };
};

// ── Polar mappers ───────────────────────────────────────────────────────────

const polarCustomer = (o: Record<string, unknown>): PaymentRecord => ({
  kind: "customer",
  row: {
    id: paymentRowId("polar", String(o.id)),
    provider: "polar",
    external_id: String(o.id),
    email: str(o.email),
    name: str(o.name),
    currency: null,
    delinquent: false,
    metadata: meta(o.metadata),
    source_created_at: isoToMs(o.created_at),
  },
});

const polarSubscription = (o: Record<string, unknown>): PaymentRecord => {
  const product = obj(o.product);
  return {
    kind: "subscription",
    row: {
      id: paymentRowId("polar", String(o.id)),
      provider: "polar",
      external_id: String(o.id),
      customer: rel("polar", o.customer_id),
      status: str(o.status),
      product_name: str(product?.name),
      price_amount: num(o.amount),
      currency: str(o.currency),
      billing_interval: str(o.recurring_interval),
      quantity: 1,
      current_period_start: isoToMs(o.current_period_start),
      current_period_end: isoToMs(o.current_period_end),
      cancel_at_period_end: bool(o.cancel_at_period_end),
      canceled_at: isoToMs(o.canceled_at),
      trial_end: isoToMs(o.trial_ends_at),
      metadata: meta(o.metadata),
      source_created_at: isoToMs(o.created_at),
    },
  };
};

/** A Polar order is both the billing document and the money movement, so it
 *  lands as an invoice AND (when settled) a payment. */
const polarOrder = (o: Record<string, unknown>): PaymentRecord[] => {
  const id = String(o.id);
  const paid = bool(o.paid) || str(o.status) === "paid";
  const total = num(o.total_amount) ?? num(o.amount);
  const invoice: PaymentRecord = {
    kind: "invoice",
    row: {
      id: paymentRowId("polar", id),
      provider: "polar",
      external_id: id,
      customer: rel("polar", o.customer_id),
      subscription: rel("polar", o.subscription_id),
      number: str(o.invoice_number),
      status: str(o.status),
      amount_due: total,
      amount_paid: paid ? total : 0,
      amount_remaining: paid ? 0 : total,
      currency: str(o.currency),
      hosted_url: str(o.invoice_url) ?? str(o.hosted_invoice_url),
      due_at: null,
      paid_at: paid ? isoToMs(o.created_at) : null,
      metadata: meta(o.metadata),
      source_created_at: isoToMs(o.created_at),
    },
  };
  const payment: PaymentRecord = {
    kind: "payment",
    row: {
      id: paymentRowId("polar", id),
      provider: "polar",
      external_id: id,
      customer: rel("polar", o.customer_id),
      invoice: paymentRowId("polar", id),
      amount: total,
      amount_refunded: num(o.refunded_amount) ?? 0,
      currency: str(o.currency),
      status: paid ? "succeeded" : (str(o.status) ?? "pending"),
      method: null,
      failure_reason: null,
      processed_at: isoToMs(o.created_at),
      metadata: meta(o.metadata),
      source_created_at: isoToMs(o.created_at),
    },
  };
  return [invoice, payment];
};

const normalizePolar = (
  payload: Record<string, unknown>,
  headerEventId: string | null,
): NormalizedPaymentEvent => {
  const type = str(payload.type) ?? "";
  const o = obj(payload.data);
  const records: PaymentRecord[] = [];
  if (o && o.id !== undefined) {
    if (type.startsWith("customer.")) records.push(polarCustomer(o));
    else if (type.startsWith("subscription.")) records.push(polarSubscription(o));
    else if (type.startsWith("order.")) records.push(...polarOrder(o));
  }
  return {
    // Polar puts no id in the body — standard-webhooks carries it in the
    // `webhook-id` header, which is what makes replays detectable at all.
    eventId: headerEventId ?? (o && o.id !== undefined ? `${type}:${String(o.id)}` : ""),
    type,
    livemode: null,
    records,
  };
};

// ── Lemon Squeezy mappers ───────────────────────────────────────────────────

/** LS never sends a `customer.*` webhook, so the buyer is derived from the
 *  order/subscription attributes that always carry `customer_id`. */
const lsDerivedCustomer = (a: Record<string, unknown>): PaymentRecord | null => {
  const customerId = str(a.customer_id);
  if (!customerId) return null;
  return {
    kind: "customer",
    row: {
      id: paymentRowId("lemonsqueezy", customerId),
      provider: "lemonsqueezy",
      external_id: customerId,
      email: str(a.user_email) ?? str(a.email),
      name: str(a.user_name) ?? str(a.name),
      currency: str(a.currency),
      delinquent: false,
      metadata: null,
      source_created_at: isoToMs(a.created_at),
    },
  };
};

const lsSubscription = (id: string, a: Record<string, unknown>): PaymentRecord => {
  const firstItem = obj(a.first_subscription_item);
  return {
    kind: "subscription",
    row: {
      id: paymentRowId("lemonsqueezy", id),
      provider: "lemonsqueezy",
      external_id: id,
      customer: rel("lemonsqueezy", a.customer_id),
      status: str(a.status),
      product_name: [str(a.product_name), str(a.variant_name)].filter(Boolean).join(" — ") || null,
      // LS keeps the price on the variant, not on the subscription payload.
      price_amount: null,
      currency: null,
      billing_interval: null,
      quantity: num(firstItem?.quantity) ?? 1,
      current_period_start: null,
      current_period_end: isoToMs(a.renews_at),
      cancel_at_period_end: bool(a.cancelled),
      canceled_at: bool(a.cancelled) ? isoToMs(a.ends_at) : null,
      trial_end: isoToMs(a.trial_ends_at),
      metadata: null,
      source_created_at: isoToMs(a.created_at),
    },
  };
};

const lsOrder = (id: string, a: Record<string, unknown>): PaymentRecord[] => {
  const total = num(a.total);
  const refunded = bool(a.refunded);
  const paid = str(a.status) === "paid";
  return [
    {
      kind: "invoice",
      row: {
        id: paymentRowId("lemonsqueezy", id),
        provider: "lemonsqueezy",
        external_id: id,
        customer: rel("lemonsqueezy", a.customer_id),
        subscription: null,
        number: str(a.order_number) ?? str(a.identifier),
        status: str(a.status),
        amount_due: total,
        amount_paid: paid ? total : 0,
        amount_remaining: paid ? 0 : total,
        currency: str(a.currency),
        hosted_url: str(obj(a.urls)?.receipt),
        due_at: null,
        paid_at: paid ? isoToMs(a.created_at) : null,
        metadata: null,
        source_created_at: isoToMs(a.created_at),
      },
    },
    {
      kind: "payment",
      row: {
        id: paymentRowId("lemonsqueezy", id),
        provider: "lemonsqueezy",
        external_id: id,
        customer: rel("lemonsqueezy", a.customer_id),
        invoice: paymentRowId("lemonsqueezy", id),
        amount: total,
        amount_refunded: refunded ? total : 0,
        currency: str(a.currency),
        status: refunded ? "refunded" : paid ? "succeeded" : (str(a.status) ?? "pending"),
        method: null,
        failure_reason: null,
        processed_at: isoToMs(a.created_at),
        metadata: null,
        source_created_at: isoToMs(a.created_at),
      },
    },
  ];
};

const lsSubscriptionInvoice = (id: string, a: Record<string, unknown>): PaymentRecord => {
  const refunded = bool(a.refunded);
  const total = num(a.total);
  return {
    kind: "payment",
    row: {
      id: paymentRowId("lemonsqueezy", `inv_${id}`),
      provider: "lemonsqueezy",
      external_id: id,
      customer: rel("lemonsqueezy", a.customer_id),
      invoice: null,
      amount: total,
      amount_refunded: refunded ? total : 0,
      currency: str(a.currency),
      status: refunded ? "refunded" : (str(a.status) ?? "pending"),
      method: str(a.card_brand),
      failure_reason: null,
      processed_at: isoToMs(a.created_at),
      metadata: { subscription_id: str(a.subscription_id), billing_reason: str(a.billing_reason) },
      source_created_at: isoToMs(a.created_at),
    },
  };
};

const normalizeLemonSqueezy = (
  payload: Record<string, unknown>,
  headerEventId: string | null,
): NormalizedPaymentEvent => {
  const m = obj(payload.meta);
  const type = str(m?.event_name) ?? "";
  const data = obj(payload.data);
  const id = str(data?.id);
  const a = obj(data?.attributes) ?? {};
  const resource = str(data?.type) ?? "";
  const records: PaymentRecord[] = [];

  if (id) {
    const derived = lsDerivedCustomer(a);
    if (derived) records.push(derived);
    if (resource === "subscriptions") records.push(lsSubscription(id, a));
    else if (resource === "orders") records.push(...lsOrder(id, a));
    else if (resource === "subscription-invoices") records.push(lsSubscriptionInvoice(id, a));
  }

  return {
    // `meta.webhook_id` is per-delivery; LS retries reuse it, so it is the
    // correct dedupe key. Fall back to event+resource id for older payloads.
    eventId: str(m?.webhook_id) ?? headerEventId ?? (id ? `${type}:${id}` : ""),
    type,
    livemode: typeof a.test_mode === "boolean" ? !a.test_mode : null,
    records,
  };
};

/**
 * Turn a verified provider webhook body into a canonical event + rows.
 * Unknown event types normalize to `records: []` — the consumer still records
 * the event (so the log is complete) but writes nothing.
 */
/**
 * Paddle Billing (v2) event → normalized records.
 *
 * Paddle is a **merchant of record**: it is the seller, so it owns tax
 * determination and remittance. That is the whole reason to support it — it
 * removes the need for a separate tax engine. It also means the amounts here
 * are what Paddle collected, not what the vendor nets.
 *
 * Envelope: `{ event_id, event_type, occurred_at, data: {...} }`. Money is a
 * STRING of minor units (`"1999"`), not a number, because Paddle refuses to
 * round-trip currency through a float — so every amount goes through `num()`
 * rather than being read directly.
 */
const normalizePaddle = (
  body: Record<string, unknown>,
  headerEventId: string | null,
): NormalizedPaymentEvent => {
  const eventId = str(body.event_id) ?? headerEventId ?? "";
  const type = str(body.event_type) ?? "";
  const d = obj(body.data) ?? {};
  const id = str(d.id);
  const records: PaymentRecord[] = [];

  if (id) {
    if (type.startsWith("customer.")) {
      records.push({
        kind: "customer",
        row: {
          id: paymentRowId("paddle", id),
          provider: "paddle",
          external_id: id,
          email: str(d.email),
          name: str(d.name),
          currency: null,
          delinquent: null,
          metadata: meta(d.custom_data),
          source_created_at: isoToMs(d.created_at),
        },
      });
    } else if (type.startsWith("subscription.")) {
      const items = Array.isArray(d.items) ? d.items : [];
      const first = obj(items[0]);
      const price = obj(first?.price);
      const unit = obj(price?.unit_price);
      const period = obj(price?.billing_cycle) ?? obj(d.billing_cycle);
      const billing = obj(d.current_billing_period);
      records.push({
        kind: "subscription",
        row: {
          id: paymentRowId("paddle", id),
          provider: "paddle",
          external_id: id,
          customer: rel("paddle", d.customer_id),
          status: str(d.status),
          product_name: str(price?.name) ?? str(price?.description),
          price_amount: num(unit?.amount),
          currency: str(unit?.currency_code) ?? str(d.currency_code),
          billing_interval: str(period?.interval),
          quantity: num(first?.quantity),
          current_period_start: isoToMs(billing?.starts_at),
          current_period_end: isoToMs(billing?.ends_at),
          cancel_at_period_end: str(d.scheduled_change) ? null : null,
          canceled_at: isoToMs(d.canceled_at),
          trial_end: null,
          metadata: meta(d.custom_data),
          source_created_at: isoToMs(d.created_at),
        },
      });
    } else if (type.startsWith("transaction.")) {
      // A Paddle transaction is the billable event: it carries both the invoice
      // view (totals, tax) and the payment view (what was collected).
      const details = obj(d.details);
      const totals = obj(details?.totals);
      records.push({
        kind: "invoice",
        row: {
          id: paymentRowId("paddle", id),
          provider: "paddle",
          external_id: id,
          customer: rel("paddle", d.customer_id),
          subscription: rel("paddle", d.subscription_id),
          number: str(d.invoice_number),
          status: str(d.status),
          // Paddle reports tax separately because it is the one remitting it.
          amount_due: num(totals?.total),
          amount_paid: num(totals?.total),
          tax: num(totals?.tax),
          currency: str(d.currency_code),
          issued_at: isoToMs(d.billed_at ?? d.created_at),
          paid_at: isoToMs(d.billed_at),
          metadata: meta(d.custom_data),
          source_created_at: isoToMs(d.created_at),
        },
      });
      records.push({
        kind: "payment",
        row: {
          id: paymentRowId("paddle", `${id}:payment`),
          provider: "paddle",
          external_id: `${id}:payment`,
          customer: rel("paddle", d.customer_id),
          invoice: rel("paddle", id),
          amount: num(totals?.total),
          amount_refunded: 0,
          currency: str(d.currency_code),
          status: str(d.status) === "completed" ? "succeeded" : str(d.status),
          method: null,
          failure_reason: null,
          processed_at: isoToMs(d.billed_at),
          metadata: meta(d.custom_data),
        },
      });
    }
  }

  return {
    eventId,
    type,
    // Paddle exposes the environment on the notification, not the event body;
    // absent means we cannot tell, which is different from "test".
    livemode: null,
    records,
  };
};

/**
 * PayTR callback → one `payment` record.
 *
 * Unlike the webhook providers there is no event envelope and no customer /
 * subscription / invoice objects — the callback IS the payment result, so this
 * produces exactly one row and never more.
 *
 * `merchant_oid` is the merchant's own order id, which makes it both the
 * external id and the dedupe key: PayTR retries the same callback until it gets
 * `OK`, so the consumer will legitimately see it more than once.
 *
 * Amounts arrive in KURUŞ (1/100 TRY) as `total_amount`, matching how the other
 * providers report minor units, so no conversion is applied. `payment_amount`
 * is the pre-commission figure and is kept in metadata rather than overwriting
 * the settled amount.
 */
const normalizePayTR = (body: Record<string, unknown>): NormalizedPaymentEvent => {
  const merchantOid = str(body.merchant_oid) ?? "";
  const status = str(body.status) ?? "";
  const succeeded = status === "success";
  return {
    // PayTR sends no event id of its own; the order id is the stable key.
    eventId: merchantOid,
    type: succeeded ? "payment.success" : "payment.failed",
    // `test_mode` is "1" on the sandbox merchant.
    livemode: str(body.test_mode) === "1" ? false : true,
    records: merchantOid
      ? [
          {
            kind: "payment",
            row: {
              id: paymentRowId("paytr", merchantOid),
              provider: "paytr",
              external_id: merchantOid,
              customer: null,
              invoice: null,
              amount: num(body.total_amount),
              amount_refunded: 0,
              currency: str(body.currency) ?? "TRY",
              status: succeeded ? "succeeded" : "failed",
              method: str(body.payment_type),
              failure_reason: succeeded
                ? null
                : (str(body.failed_reason_msg) ?? str(body.failed_reason_code)),
              // `merchant_oid` IS the reference — the checkout builder sends
              // our row identifier as the order id, which is why the reference
              // contract is restricted to what PayTR accepts there.
              reference: merchantOid,
              processed_at: null,
              metadata: {
                ...(str(body.payment_amount) ? { payment_amount: str(body.payment_amount) } : {}),
                ...(str(body.installment_count)
                  ? { installment_count: str(body.installment_count) }
                  : {}),
              },
            },
          },
        ]
      : [],
  };
};

// ── iyzico: retrieve-based verification ─────────────────────────────────────

/** iyzico's two hosts. Fixed constants — never assembled from config. */
const IYZICO_HOSTS = {
  production: "https://api.iyzipay.com",
  sandbox: "https://sandbox-api.iyzipay.com",
} as const;

/** The one endpoint this integration calls. */
const IYZICO_RETRIEVE_PATH = "/payment/iyzipos/checkoutform/auth/ecom/detail";

/**
 * iyzico's IYZWSv2 request authentication.
 *
 * signature = hex(HMAC-SHA256(secretKey, randomKey + uriPath + requestBody))
 * Authorization: IYZWSv2 base64("apiKey:…&randomKey:…&signature:…")
 *
 * The random key also travels as `x-iyzi-rnd` so iyzico can recompute it.
 */
const iyzicoAuthHeaders = async (
  apiKey: string,
  secretKey: string,
  uriPath: string,
  body: string,
  randomKey: string,
): Promise<Record<string, string>> => {
  const signature = toHex(await hmac(enc.encode(secretKey), `${randomKey}${uriPath}${body}`));
  const params = `apiKey:${apiKey}&randomKey:${randomKey}&signature:${signature}`;
  return {
    Authorization: `IYZWSv2 ${btoa(params)}`,
    "x-iyzi-rnd": randomKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
};

export interface IyzicoRetrieveInput {
  /** Decrypted provider config: apiKey, secretKey, environment. */
  config: Record<string, unknown>;
  /** The token iyzico posted to the callback. Opaque; never interpolated
   *  into a URL — it travels in the JSON body. */
  token: string;
  fetchImpl?: FetchLike;
  /** Injectable so tests do not depend on randomness. */
  randomKey?: string;
}

export type IyzicoRetrieveResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: "missing_secret" | "unreachable" | "rejected" };

/**
 * Ask iyzico what happened for a token.
 *
 * This IS the verification step for iyzico. The callback that triggered it is
 * unauthenticated and its body is thrown away; only the token is carried over,
 * and what gets recorded is iyzico's own answer, fetched with the merchant's
 * credentials. A token that is forged, replayed from another merchant, or
 * simply invented comes back as a `failure` (or an error) and produces no
 * payment record.
 */
export async function retrieveIyzicoPayment(
  input: IyzicoRetrieveInput,
): Promise<IyzicoRetrieveResult> {
  const apiKey = str(input.config.apiKey);
  const secretKey = str(input.config.secretKey);
  if (!apiKey || !secretKey) return { ok: false, reason: "missing_secret" };

  const host =
    str(input.config.environment) === "sandbox" ? IYZICO_HOSTS.sandbox : IYZICO_HOSTS.production;
  const body = JSON.stringify({ locale: "tr", token: input.token });
  const randomKey = input.randomKey ?? `${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
  const headers = await iyzicoAuthHeaders(apiKey, secretKey, IYZICO_RETRIEVE_PATH, body, randomKey);

  const doFetch: FetchLike = input.fetchImpl ?? ((i, init) => fetch(i, init));
  let res: Response;
  try {
    res = await doFetch(`${host}${IYZICO_RETRIEVE_PATH}`, { method: "POST", headers, body });
  } catch {
    // Transport failure, not a verdict. The caller turns this into a retry
    // rather than recording a payment that may well have succeeded.
    return { ok: false, reason: "unreachable" };
  }
  if (!res.ok) return { ok: false, reason: "unreachable" };

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  const parsed = obj(payload);
  if (!parsed) return { ok: false, reason: "unreachable" };
  // iyzico answers 200 with `status: "failure"` for a token it does not
  // recognise, which is exactly what a forged callback looks like. That is a
  // verdict, not an outage — no retry, no record.
  if (str(parsed.status) !== "success") return { ok: false, reason: "rejected" };
  return { ok: true, payload: parsed };
}

/**
 * Normalize a retrieved iyzico payment.
 *
 * The shape here is the RETRIEVE response, never the callback body — see
 * `retrieveIyzicoPayment` for why that distinction is the whole security model.
 */
const normalizeIyzico = (body: Record<string, unknown>): NormalizedPaymentEvent => {
  const paymentId = str(body.paymentId) ?? str(body.token) ?? "";
  const currency = str(body.currency) ?? "TRY";
  // `paymentStatus` is the settlement verdict; `status` above it only says the
  // API call itself succeeded, and conflating the two records a declined card
  // as a completed payment.
  const paymentStatus = str(body.paymentStatus) ?? "";
  const succeeded = paymentStatus === "SUCCESS";
  return {
    eventId: paymentId,
    type: succeeded ? "payment.success" : "payment.failed",
    // The sandbox key prefix is the only signal iyzico gives here.
    livemode: !String(str(body.token) ?? "").startsWith("sandbox-"),
    records: paymentId
      ? [
          {
            kind: "payment",
            row: {
              id: paymentRowId("iyzico", paymentId),
              provider: "iyzico",
              external_id: paymentId,
              customer: null,
              invoice: null,
              // `paidPrice` is what was actually charged (it includes the
              // installment surcharge); `price` is the basket total.
              //
              // iyzico quotes MAJOR units ("108.90") where Stripe and PayTR
              // both send minor units. Writing it through verbatim put iyzico
              // rows in the ledger 100x smaller than every other provider's —
              // and `amount` is an integer column, so the fraction was lost on
              // top. Convert on the way in so one `payment_transactions` sum
              // means one thing.
              amount: toMinorUnits(body.paidPrice ?? body.price, currency),
              amount_refunded: 0,
              currency,
              status: succeeded ? "succeeded" : "failed",
              method: str(body.paymentChannel),
              failure_reason: succeeded
                ? null
                : (str(body.errorMessage) ?? str(body.errorCode) ?? (paymentStatus || null)),
              // iyzico echoes the `conversationId` the checkout was opened
              // with; `basketId` carries the same value as a fallback for a
              // checkout opened by something other than backlex.
              reference: str(body.conversationId) ?? str(body.basketId),
              processed_at: null,
              metadata: {
                ...(str(body.basketId) ? { basket_id: str(body.basketId) } : {}),
                ...(str(body.conversationId) ? { conversation_id: str(body.conversationId) } : {}),
                ...(str(body.installment) ? { installment: str(body.installment) } : {}),
                ...(str(body.cardAssociation) ? { card_association: str(body.cardAssociation) } : {}),
              },
            },
          },
        ]
      : [],
  };
};

// ── Adyen ───────────────────────────────────────────────────────────────────

/**
 * The eight fields Adyen signs, in signing order.
 *
 * Exported because the order is load-bearing and invisible in the output: a
 * wrong order produces a well-formed signature that never matches, and Adyen
 * reports nothing beyond a rejected webhook.
 */
export const ADYEN_SIGNED_FIELDS = [
  "pspReference",
  "originalReference",
  "merchantAccountCode",
  "merchantReference",
  "amount.value",
  "amount.currency",
  "eventCode",
  "success",
] as const;

/**
 * Adyen's field escaping: backslash first, then colon.
 *
 * Order matters. Escaping colons first would turn `:` into `\:` and the second
 * pass would then double the backslash it just wrote, yielding `\\:` — a
 * different string from the one Adyen signed.
 */
const adyenEscape = (v: string): string => v.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

/** The canonical string Adyen HMACs, for one notification item. */
export const adyenSigningString = (item: Record<string, unknown>): string => {
  const amount = obj(item.amount) ?? {};
  return [
    str(item.pspReference) ?? "",
    str(item.originalReference) ?? "",
    str(item.merchantAccountCode) ?? "",
    str(item.merchantReference) ?? "",
    // A JSON number in the body; the signature is over its decimal text.
    str(amount.value) ?? "",
    str(amount.currency) ?? "",
    str(item.eventCode) ?? "",
    str(item.success) ?? "",
  ]
    .map(adyenEscape)
    .join(":");
};

/**
 * Unwrap `{ notificationItems: [{ NotificationRequestItem: {...} }] }`.
 *
 * Shared by the verifier and the normalizer on purpose: if they disagreed
 * about which entries count, an item could be verified and not recorded — or,
 * far worse, recorded without having been verified.
 */
export const adyenNotificationItems = (payload: unknown): Record<string, unknown>[] => {
  const body = obj(payload);
  const list = Array.isArray(body?.notificationItems) ? body.notificationItems : [];
  const out: Record<string, unknown>[] = [];
  for (const entry of list) {
    const item = obj(obj(entry)?.NotificationRequestItem);
    if (item) out.push(item);
  }
  return out;
};

/**
 * One Adyen notification item → at most one payment row.
 *
 * ## Why some events key on `originalReference` and others don't
 *
 * Adyen sends DELTAS, not object snapshots. Every other provider here re-sends
 * the whole object on every event, so a refund simply restates the order with
 * `amount_refunded` filled in. Adyen instead sends a REFUND item whose
 * `amount` is the refunded amount and whose `originalReference` points at the
 * authorisation.
 *
 * That matters because the ledger's upsert REPLACES the row rather than
 * merging into it. Filing a refund against the original payment's row id would
 * therefore overwrite `amount` — the payment total — with the refunded portion,
 * silently shrinking a €100 payment to the €10 that came back.
 *
 * So the split is by what the item's own `amount` actually means:
 *
 *   AUTHORISATION / CAPTURE / CANCELLATION — the item's amount IS the
 *   payment's amount, so these upsert the authorisation's row (`CAPTURE` and
 *   `CANCELLATION` carry it as `originalReference`) and the row stays one
 *   payment. A partial capture legitimately narrows the amount to what was
 *   actually taken, which is the more truthful figure anyway.
 *
 *   REFUND / CHARGEBACK — the amount is a different, smaller movement, so it
 *   gets its OWN row keyed on its own `pspReference`, with the authorisation
 *   recorded in `metadata.original_reference`. `SUM(amount) WHERE status =
 *   'succeeded'` therefore still returns what was collected, and the reversals
 *   are their own rows rather than a mutation that loses the original.
 *
 * A FAILED modification (`CAPTURE_FAILED`, a `success:false` cancellation)
 * writes nothing at all: the authorisation still stands, and the only honest
 * options are "leave the row alone" or "rewrite it from a payload that does not
 * describe it". The event is still recorded in `payment_events`, so the failure
 * is visible without corrupting the ledger.
 */
const adyenPaymentRecord = (item: Record<string, unknown>): PaymentRecord | null => {
  const psp = str(item.pspReference);
  if (!psp) return null;
  const eventCode = (str(item.eventCode) ?? "").toUpperCase();
  const success = str(item.success) === "true";
  const original = str(item.originalReference);
  const amountObj = obj(item.amount) ?? {};
  // Adyen quotes minor units already, matching what the ledger stores.
  const amount = num(amountObj.value);
  const currency = str(amountObj.currency);
  const at = isoToMs(item.eventDate);
  const reason = str(item.reason);
  const additional = obj(item.additionalData) ?? {};

  // `CANCEL_OR_REFUND` is one event code for two outcomes; Adyen says which in
  // `additionalData["modification.action"]`. Without this it would be filed as
  // a cancellation even when money was actually sent back.
  const resolved =
    eventCode === "CANCEL_OR_REFUND"
      ? str(additional["modification.action"])?.toLowerCase() === "refund"
        ? "REFUND"
        : "CANCELLATION"
      : eventCode;

  const common = {
    provider: "adyen",
    customer: null,
    invoice: null,
    currency,
    method: str(item.paymentMethod),
    // Our own row id, echoed back from the payment link's `reference`. This is
    // what ties the money to the invoice row that asked for it.
    reference: str(item.merchantReference),
    processed_at: at,
    source_created_at: at,
  };

  if (resolved === "AUTHORISATION") {
    return {
      kind: "payment",
      row: {
        ...common,
        id: paymentRowId("adyen", psp),
        external_id: psp,
        amount,
        amount_refunded: 0,
        status: success ? "succeeded" : "failed",
        failure_reason: success ? null : reason,
        metadata: adyenMetadata(item, null),
      },
    };
  }

  // Everything past here is a modification of an existing authorisation, and a
  // modification with nothing to modify is not something to guess at.
  if (!success) return null;

  if (resolved === "CAPTURE" || resolved === "CANCELLATION") {
    const target = original ?? psp;
    return {
      kind: "payment",
      row: {
        ...common,
        id: paymentRowId("adyen", target),
        external_id: target,
        amount,
        amount_refunded: 0,
        status: resolved === "CAPTURE" ? "succeeded" : "canceled",
        failure_reason: null,
        metadata: adyenMetadata(item, psp === target ? null : psp),
      },
    };
  }

  if (resolved === "REFUND" || resolved === "CHARGEBACK") {
    return {
      kind: "payment",
      row: {
        ...common,
        id: paymentRowId("adyen", psp),
        external_id: psp,
        amount,
        amount_refunded: amount,
        status: resolved === "REFUND" ? "refunded" : "chargeback",
        failure_reason: resolved === "CHARGEBACK" ? reason : null,
        metadata: adyenMetadata(item, null),
      },
    };
  }

  // REPORT_AVAILABLE, NOTIFICATION_OF_CHARGEBACK, the *_FAILED codes and
  // anything Adyen adds later: recorded as an event, no row written.
  return null;
};

/** Provider detail worth keeping without inventing columns for it. */
const adyenMetadata = (
  item: Record<string, unknown>,
  modificationPsp: string | null,
): Record<string, unknown> => {
  const additional = obj(item.additionalData) ?? {};
  return {
    event_code: str(item.eventCode),
    ...(str(item.originalReference) ? { original_reference: str(item.originalReference) } : {}),
    ...(modificationPsp ? { modification_reference: modificationPsp } : {}),
    ...(str(item.merchantAccountCode) ? { merchant_account: str(item.merchantAccountCode) } : {}),
    ...(str(additional.paymentMethodVariant)
      ? { payment_method_variant: str(additional.paymentMethodVariant) }
      : {}),
    ...(str(additional.authCode) ? { auth_code: str(additional.authCode) } : {}),
  };
};

/**
 * An Adyen notification batch → normalized records.
 *
 * Every item in the batch has already had its HMAC checked by
 * `verifyPaymentSignature`, which refuses the whole delivery if any single one
 * fails — so this function does not re-authenticate and must never be called
 * on an unverified body.
 */
const normalizeAdyen = (body: Record<string, unknown>): NormalizedPaymentEvent => {
  const items = adyenNotificationItems(body);
  const records: PaymentRecord[] = [];
  const keys: string[] = [];
  const types = new Set<string>();

  for (const item of items) {
    const psp = str(item.pspReference);
    const code = str(item.eventCode) ?? "";
    if (psp) keys.push(`${psp}:${code}`);
    if (code) types.add(code);
    const record = adyenPaymentRecord(item);
    if (record) records.push(record);
  }

  return {
    // Adyen retries resend the identical batch, so the joined per-item keys are
    // stable across retries. Row writes are idempotent by row id anyway, so a
    // batch that later arrives split into single deliveries re-applies cleanly
    // rather than duplicating.
    eventId: keys.join(","),
    type: [...types].join(","),
    // The envelope's `live` flag is a STRING ("false" on the test platform).
    livemode: str(body.live) === "true",
    records,
  };
};

// ── Authorize.net ───────────────────────────────────────────────────────────

/** The two hosts. Fixed constants — never assembled from config. */
const AUTHORIZENET_HOSTS = {
  production: "https://api.authorize.net",
  sandbox: "https://apitest.authorize.net",
} as const;

/** One endpoint serves the whole API; the request's single top-level key is
 *  what selects the operation. */
export const AUTHORIZENET_API_PATH = "/xml/v1/request.api";

/**
 * What an Authorize.net amount is assumed to be worth when the connection
 * never said. USD because it is the only currency every Authorize.net account
 * can settle in — but a wrong guess is a silently mispriced ledger, which is
 * why the connect dialog asks for it rather than leaving it to this.
 */
export const AUTHORIZENET_DEFAULT_CURRENCY = "USD";

export const authorizeNetHost = (config: Record<string, unknown>): string =>
  str(config.environment) === "sandbox"
    ? AUTHORIZENET_HOSTS.sandbox
    : AUTHORIZENET_HOSTS.production;

/**
 * Parse an Authorize.net JSON response.
 *
 * It answers `application/json` with a UTF-8 BOM in front of the opening brace,
 * which `JSON.parse` rejects with a bare "Unexpected token" naming a character
 * that does not appear when the body is printed. Every client for this API ends
 * up with this line; ours is here so both call sites share it.
 */
export const parseAuthorizeNetJson = (text: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, "").trim());
    return obj(parsed);
  } catch {
    return null;
  }
};

/**
 * Did Authorize.net accept the call?
 *
 * It answers **HTTP 200 for errors too**, with the verdict in
 * `messages.resultCode`. Trusting the status code here would read an
 * authentication failure as a successful lookup that happened to return nothing.
 */
export const authorizeNetOk = (body: Record<string, unknown>): boolean =>
  str(obj(body.messages)?.resultCode) === "Ok";

/** The first error text, for a caller that has to explain the refusal. */
export const authorizeNetErrorText = (body: Record<string, unknown>): string | null => {
  const list = obj(body.messages)?.message;
  const first = obj(Array.isArray(list) ? list[0] : list);
  return str(first?.text) ?? str(first?.code);
};

/**
 * The transaction id a notification is about, or null when it is about
 * something else (a customer profile, a subscription).
 *
 * Exported so the consumer decides whether to fetch detail using the SAME test
 * the normalizer uses to decide whether a payment row is written — the two
 * disagreeing would mean fetching detail that is thrown away, or worse, writing
 * a payment row while never looking for the invoice number that completes it.
 */
export const authorizeNetTransactionId = (payload: unknown): string | null => {
  const p = obj(obj(payload)?.payload);
  if (!p || str(p.entityName) !== "transaction") return null;
  return str(p.id);
};

export interface AuthorizeNetRetrieveInput {
  /** Decrypted provider config: apiLoginId, transactionKey, environment. */
  config: Record<string, unknown>;
  /** The transaction id the notification carried. */
  transId: string;
  fetchImpl?: FetchLike;
}

export type AuthorizeNetRetrieveResult =
  | { ok: true; transaction: Record<string, unknown> }
  | { ok: false; reason: "missing_secret" | "unreachable" | "rejected"; message?: string };

/**
 * Ask Authorize.net for the full detail behind a transaction id.
 *
 * Unlike iyzico's retrieve this is NOT the authentication step — the webhook's
 * HMAC already established that. It exists because an Authorize.net
 * notification is the thinnest of any provider here: a transaction id, an
 * amount and a response code. The order — and therefore the invoice number the
 * checkout travelled out with — lives only on the transaction itself.
 *
 * That matters more than it sounds. `refId`, the obvious place to put a
 * merchant's own identifier, is echoed on the API RESPONSE and is not stored
 * against the transaction, so it cannot come back on a later event. Only
 * `order.invoiceNumber` persists. Without this call an Authorize.net payment
 * arrives with an amount and no idea what it paid for, which is precisely the
 * "URL generator" failure the checkout module exists to avoid.
 */
export async function retrieveAuthorizeNetTransaction(
  input: AuthorizeNetRetrieveInput,
): Promise<AuthorizeNetRetrieveResult> {
  const name = str(input.config.apiLoginId);
  const transactionKey = str(input.config.transactionKey);
  if (!name || !transactionKey) return { ok: false, reason: "missing_secret" };

  const body = JSON.stringify({
    getTransactionDetailsRequest: {
      merchantAuthentication: { name, transactionKey },
      transId: input.transId,
    },
  });

  const doFetch: FetchLike = input.fetchImpl ?? ((i, init) => fetch(i, init));
  let res: Response;
  try {
    res = await doFetch(`${authorizeNetHost(input.config)}${AUTHORIZENET_API_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!res.ok) return { ok: false, reason: "unreachable" };

  const parsed = parseAuthorizeNetJson(await res.text());
  if (!parsed) return { ok: false, reason: "unreachable" };
  if (!authorizeNetOk(parsed)) {
    return { ok: false, reason: "rejected", message: authorizeNetErrorText(parsed) ?? undefined };
  }
  const transaction = obj(parsed.transaction);
  if (!transaction) return { ok: false, reason: "rejected", message: "no transaction in response" };
  return { ok: true, transaction };
}

/**
 * `net.authorize.payment.authcapture.created` → `{ subject: "authcapture",
 * action: "created" }`.
 *
 * The last two segments are the load-bearing pair, and it is the SECOND-TO-LAST
 * that names the operation — `…payment.refund.created` is a refund, not a
 * creation of something called payment. The families nest to different depths
 * (`net.authorize.payment.*` vs `net.authorize.customer.subscription.*`), so
 * both are taken from the end rather than by index from the front.
 */
const authorizeNetEvent = (eventType: string): { subject: string; action: string } => {
  const parts = eventType.split(".");
  return {
    subject: parts.length >= 2 ? (parts[parts.length - 2] as string) : "",
    action: parts.length >= 1 ? (parts[parts.length - 1] as string) : "",
  };
};

/**
 * Authorize.net's response codes. 1 is the only one that means the money moved.
 * 4 is held for fraud review — approved by the gateway, not yet by the
 * merchant — so it is `pending` rather than a success or a failure.
 */
const authorizeNetStatusFor = (
  responseCode: number | null,
  settled: "succeeded" | "pending" | "canceled" | "refunded",
): string => {
  if (responseCode === 4) return "pending";
  if (responseCode !== null && responseCode !== 1) return "failed";
  return settled;
};

/**
 * One Authorize.net notification → at most one payment or subscription row.
 *
 * ## Keying, and why it needs less care than Adyen's
 *
 * Authorize.net REUSES the original transaction id for a capture and for a
 * void: capturing an authorisation does not mint a new transaction, it settles
 * the existing one. So `payload.id` upserts onto the same row on its own, with
 * none of the `originalReference` bookkeeping Adyen needs.
 *
 * A REFUND is the exception, and it is the same trap Adyen documents: a refund
 * is a NEW transaction whose amount is the refunded portion, not the payment's
 * total. Since the ledger's upsert REPLACES the row, filing it against the
 * original would overwrite a $100 payment with the $10 that came back. It gets
 * its own row keyed on its own transaction id, and `SUM(amount)` still means
 * what it should.
 */
const authorizeNetPaymentRecord = (
  eventType: string,
  p: Record<string, unknown>,
  currency: string,
  detail: Record<string, unknown> | null,
): PaymentRecord | null => {
  const id = str(p.id);
  if (!id) return null;
  const { subject, action } = authorizeNetEvent(eventType);
  const responseCode = num(p.responseCode);

  let settled: "succeeded" | "pending" | "canceled" | "refunded";
  if (subject === "fraud") {
    // `fraud.held` is the gateway saying a human has to look at this, which is
    // exactly `pending`; approve and decline resolve it either way. A decline
    // is a failure regardless of the response code the held authorisation
    // carried, so it does not go through the shared status mapping.
    if (action === "declined") return failedFraudRecord(id, p, currency, detail);
    settled = action === "approved" ? "succeeded" : "pending";
  } else {
    switch (subject) {
      case "authorization":
        // Authorised but not captured: the money is held, not taken.
        settled = "pending";
        break;
      case "authcapture":
      case "capture":
      case "priorAuthCapture":
        settled = "succeeded";
        break;
      case "void":
        settled = "canceled";
        break;
      case "refund":
        settled = "refunded";
        break;
      default:
        // Anything Authorize.net adds later is logged as an event and writes
        // no row, rather than being guessed into the ledger.
        return null;
    }
  }

  const amount = toMinorUnits(p.authAmount, currency);
  const order = obj(detail?.order);
  const refunded = settled === "refunded";
  return {
    kind: "payment",
    row: {
      id: paymentRowId("authorizenet", id),
      provider: "authorizenet",
      external_id: id,
      customer: null,
      invoice: null,
      amount,
      amount_refunded: refunded ? amount : 0,
      currency,
      status: authorizeNetStatusFor(responseCode, settled),
      method: authorizeNetMethod(detail),
      failure_reason:
        responseCode !== null && responseCode !== 1 && responseCode !== 4
          ? (str(detail?.responseReasonDescription) ?? `response code ${responseCode}`)
          : null,
      // The invoice number is the only merchant identifier Authorize.net keeps
      // with a transaction, so it is what the checkout sends and what comes
      // back. `merchantReferenceId` is read first for the case where the
      // notification does carry one and no detail was fetched.
      reference: str(order?.invoiceNumber) ?? str(p.merchantReferenceId),
      processed_at: isoToMs(detail?.submitTimeUTC),
      metadata: authorizeNetMetadata(eventType, p, detail),
      source_created_at: isoToMs(detail?.submitTimeUTC),
    },
  };
};

/** A declined fraud review: the authorisation is dead, and the amount is the
 *  one that will NOT be collected. */
const failedFraudRecord = (
  id: string,
  p: Record<string, unknown>,
  currency: string,
  detail: Record<string, unknown> | null,
): PaymentRecord => {
  const order = obj(detail?.order);
  return {
    kind: "payment",
    row: {
      id: paymentRowId("authorizenet", id),
      provider: "authorizenet",
      external_id: id,
      customer: null,
      invoice: null,
      amount: toMinorUnits(p.authAmount, currency),
      amount_refunded: 0,
      currency,
      status: "failed",
      method: authorizeNetMethod(detail),
      failure_reason: str(detail?.responseReasonDescription) ?? "declined in fraud review",
      reference: str(order?.invoiceNumber) ?? str(p.merchantReferenceId),
      processed_at: isoToMs(detail?.submitTimeUTC),
      metadata: authorizeNetMetadata("net.authorize.payment.fraud.declined", p, detail),
      source_created_at: isoToMs(detail?.submitTimeUTC),
    },
  };
};

/** How it was paid, from the retrieved detail — the notification never says. */
const authorizeNetMethod = (detail: Record<string, unknown> | null): string | null => {
  const payment = obj(detail?.payment);
  if (!payment) return null;
  const card = obj(payment.creditCard);
  if (card) return str(card.cardType) ?? "card";
  if (obj(payment.bankAccount)) return "bank_account";
  return null;
};

const authorizeNetMetadata = (
  eventType: string,
  p: Record<string, unknown>,
  detail: Record<string, unknown> | null,
): Record<string, unknown> => ({
  event_type: eventType,
  ...(str(p.authCode) ? { auth_code: str(p.authCode) } : {}),
  ...(str(p.avsResponse) ? { avs_response: str(p.avsResponse) } : {}),
  // A refund's link back to what it refunded. Only the retrieved detail has it.
  ...(str(detail?.refTransId) ? { original_reference: str(detail?.refTransId) } : {}),
  ...(str(detail?.transactionStatus) ? { transaction_status: str(detail?.transactionStatus) } : {}),
  ...(str(obj(detail?.order)?.description)
    ? { description: str(obj(detail?.order)?.description) }
    : {}),
});

/**
 * A retrieved Authorize.net transaction's own status → the ledger's vocabulary.
 *
 * The refresh path reads `transactionStatus`, which the NOTIFICATION never
 * carries — and that is most of the value. `capturedPendingSettlement` becoming
 * `settledSuccessfully` overnight, a `returnedItem` (an ACH bounce, days
 * later), or a void raised in the merchant interface are all invisible to a
 * webhook-only integration because Authorize.net sends nothing for them.
 */
const AUTHORIZENET_DETAIL_STATUS: Record<string, string> = {
  settledSuccessfully: "succeeded",
  // Captured into a batch that has not settled yet. The money is taken.
  capturedPendingSettlement: "succeeded",
  // Held, not taken — the same reading the bare `authorization` event gets.
  authorizedPendingCapture: "pending",
  refundSettledSuccessfully: "refunded",
  refundPendingSettlement: "refunded",
  voided: "canceled",
  declined: "failed",
  expired: "failed",
  // The gateway wants a human to look at it.
  FDSPendingReview: "pending",
  FDSAuthorizedPendingReview: "pending",
  // An ACH debit that came back after the fact. It is not a refund — nobody
  // chose to give the money back — but it is not money received either.
  returnedItem: "failed",
  communicationError: "failed",
  generalError: "failed",
};

/**
 * One retrieved Authorize.net transaction → the payment row.
 *
 * Deliberately reads `authAmount` rather than `settleAmount`, matching what the
 * webhook path writes. The two paths upsert the SAME row and the upsert
 * replaces it, so reading a different amount field here would make a payment's
 * recorded figure flip every time a refresh ran.
 */
const authorizeNetDetailRecord = (
  detail: Record<string, unknown>,
  currency: string,
): PaymentRecord | null => {
  const id = str(detail.transId);
  if (!id) return null;
  const transactionStatus = str(detail.transactionStatus) ?? "";
  const status = AUTHORIZENET_DETAIL_STATUS[transactionStatus] ?? "pending";
  const amount = toMinorUnits(detail.authAmount ?? detail.settleAmount, currency);
  const order = obj(detail.order);
  return {
    kind: "payment",
    row: {
      id: paymentRowId("authorizenet", id),
      provider: "authorizenet",
      external_id: id,
      customer: null,
      invoice: null,
      amount,
      // A refund is its own transaction with its own row, exactly as the
      // webhook path files it — so the refunded figure belongs to THAT row,
      // never subtracted from the payment it refunded.
      amount_refunded: status === "refunded" ? amount : 0,
      currency,
      status,
      method: authorizeNetMethod(detail),
      failure_reason:
        status === "failed"
          ? (str(detail.responseReasonDescription) ?? (transactionStatus || "declined"))
          : null,
      reference: str(order?.invoiceNumber),
      processed_at: isoToMs(detail.submitTimeUTC),
      metadata: {
        // `event_type` is deliberately absent: a refresh genuinely does not
        // know which notification first created this row, and inventing one
        // would put a fabricated event name into the ledger. `transaction_type`
        // is the equivalent fact, and Authorize.net actually states it.
        ...(str(detail.transactionType) ? { transaction_type: str(detail.transactionType) } : {}),
        ...(transactionStatus ? { transaction_status: transactionStatus } : {}),
        ...(str(detail.authCode) ? { auth_code: str(detail.authCode) } : {}),
        ...(str(detail.avsResponse) ? { avs_response: str(detail.avsResponse) } : {}),
        ...(str(detail.refTransId) ? { original_reference: str(detail.refTransId) } : {}),
        ...(str(order?.description) ? { description: str(order?.description) } : {}),
      },
      source_created_at: isoToMs(detail.submitTimeUTC),
    },
  };
};

const refetchAuthorizeNet = async (input: RefetchInput): Promise<RefetchResult> => {
  const got = await retrieveAuthorizeNetTransaction({
    config: input.config,
    transId: input.externalId,
    fetchImpl: input.fetchImpl,
  });
  if (!got.ok) {
    if (got.reason === "missing_secret") return { ok: false, reason: "missing_secret" };
    if (got.reason === "unreachable") return { ok: false, reason: "unreachable" };
    // Authorize.net answers HTTP 200 with an error envelope for a transaction
    // id it does not recognise, so "rejected" is where a gone payment lands.
    // Reported as `not_found` when it names that specifically, because the
    // caller skips those instead of counting them as failures.
    return {
      ok: false,
      reason: /not found|invalid.*transaction/i.test(got.message ?? "") ? "not_found" : "rejected",
    };
  }
  const record = authorizeNetDetailRecord(
    got.transaction,
    (input.accountCurrency ?? "").toUpperCase() || AUTHORIZENET_DEFAULT_CURRENCY,
  );
  return { ok: true, records: record ? [record] : [] };
};

/** An ARB subscription event. The payload is its own small shape — a name, an
 *  amount in MAJOR units and a status — with no customer attached. */
const authorizeNetSubscriptionRecord = (
  p: Record<string, unknown>,
  currency: string,
): PaymentRecord | null => {
  const id = str(p.id);
  if (!id) return null;
  return {
    kind: "subscription",
    row: {
      id: paymentRowId("authorizenet", id),
      provider: "authorizenet",
      external_id: id,
      customer: null,
      status: str(p.status),
      product_name: str(p.name),
      price_amount: toMinorUnits(p.amount, currency),
      currency,
      billing_interval: null,
      quantity: 1,
      current_period_start: null,
      current_period_end: null,
      cancel_at_period_end: false,
      canceled_at: null,
      trial_end: null,
      metadata: null,
      source_created_at: null,
    },
  };
};

/**
 * An Authorize.net notification → normalized records.
 *
 * `accountCurrency` is not a nicety. Authorize.net's API carries no currency
 * field anywhere — not on a transaction, not on a notification, not in its
 * schema — because a merchant account settles in exactly one. It is collected
 * on the connection and threaded through here so an amount lands in the ledger
 * meaning something.
 *
 * `detail` is the optional result of `retrieveAuthorizeNetTransaction`. Absent,
 * the payment is still recorded — the signature already proved it happened —
 * but without the invoice number that ties it to the row that asked for it.
 */
const normalizeAuthorizeNet = (
  body: Record<string, unknown>,
  accountCurrency: string,
  detail: Record<string, unknown> | null,
): NormalizedPaymentEvent => {
  const type = str(body.eventType) ?? "";
  const p = obj(body.payload) ?? {};
  const entityName = str(p.entityName) ?? "";
  const records: PaymentRecord[] = [];

  if (entityName === "transaction") {
    const record = authorizeNetPaymentRecord(type, p, accountCurrency, detail);
    if (record) records.push(record);
  } else if (entityName === "subscription") {
    const record = authorizeNetSubscriptionRecord(p, accountCurrency);
    if (record) records.push(record);
  }
  // Customer-profile and payment-profile events carry an id and nothing else —
  // no email, no name — so there is no customer row worth writing from one.
  // They are still recorded in `payment_events`.

  return {
    // Unique per delivery and stable across Authorize.net's own retries.
    eventId: str(body.notificationId) ?? "",
    type,
    // Nothing on the notification distinguishes the sandbox; the connection's
    // environment does, and saying "live" from here would be a guess.
    livemode: null,
    records,
  };
};

// ── Klarna ──────────────────────────────────────────────────────────────────

/**
 * Klarna's six hosts. Region is a DEPLOYMENT, not a routing hint: a European
 * credential does not authenticate against the North American host, and the
 * refusal comes back as a 401 that reads exactly like a wrong password.
 *
 * Fixed constants, never assembled from config — see `klarnaHost`.
 */
const KLARNA_HOSTS = {
  europe: {
    playground: "https://api.playground.klarna.com",
    production: "https://api.klarna.com",
  },
  north_america: {
    playground: "https://api-na.playground.klarna.com",
    production: "https://api-na.klarna.com",
  },
  oceania: {
    playground: "https://api-oc.playground.klarna.com",
    production: "https://api-oc.klarna.com",
  },
} as const;

/**
 * Which Klarna host this connection talks to.
 *
 * Defaults to `playground` rather than production, the opposite of the other
 * providers here. Klarna's credentials are region- AND environment-scoped, so a
 * connection that never chose is far more likely to be a merchant wiring things
 * up than a live account — and pointing a half-configured connection at
 * production is the more expensive way to be wrong.
 */
export const klarnaHost = (config: Record<string, unknown>): string => {
  const region = str(config.region) ?? "europe";
  const hosts = KLARNA_HOSTS[region as keyof typeof KLARNA_HOSTS] ?? KLARNA_HOSTS.europe;
  return str(config.environment) === "production" ? hosts.production : hosts.playground;
};

/**
 * Basic auth over the credential pair from the Merchant Portal.
 *
 * Encoded through UTF-8 rather than handed straight to `btoa`, which throws on
 * any code point above U+00FF. Klarna's own credentials are ASCII, but the
 * value comes from a text box an admin typed into — and a throw here would
 * escape `createCheckout`, which documents itself as never throwing, turning a
 * bad credential into a 500 instead of a `missing_secret` an admin can act on.
 */
export const klarnaAuthHeader = (username: string, password: string): string =>
  `Basic ${toBase64(enc.encode(`${username}:${password}`))}`;

/**
 * Both Klarna ids this module interpolates into a URL path.
 *
 * iyzico's token never needed this — it travels in a JSON body. Klarna's do go
 * in the path (`/hpp/v1/sessions/<id>`), and both arrive from an UNAUTHENTICATED
 * callback, so a value carrying `../` or a query string would let the caller
 * choose which endpoint the merchant's credentials are sent to. Klarna's own ids
 * are UUIDs; anything else is refused rather than escaped.
 */
const KLARNA_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The HPP session handle out of Klarna's unsigned status callback.
 *
 * Exported so the consumer lifts it the same way every time. The body is
 * `{ event_id, session: { session_id, status, updated_at, expires_at } }`, and
 * `session_id` is the ONLY field carried over — everything else is re-read from
 * Klarna, because none of it is authenticated.
 */
export const klarnaSessionIdFrom = (rawBody: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const body = obj(parsed);
  const id = str(obj(body?.session)?.session_id) ?? str(body?.session_id);
  return id && KLARNA_ID_PATTERN.test(id) ? id : null;
};

export interface KlarnaRetrieveInput {
  /** Decrypted provider config: username, password, region, environment. */
  config: Record<string, unknown>;
  /** The HPP session id the callback carried. */
  sessionId: string;
  fetchImpl?: FetchLike;
}

export type KlarnaRetrieveResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: "missing_secret" | "unreachable" | "rejected" };

const klarnaGet = async (
  doFetch: FetchLike,
  url: string,
  auth: string,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number }> => {
  let res: Response;
  try {
    res = await doFetch(url, { method: "GET", headers: { Authorization: auth, Accept: "application/json" } });
  } catch {
    // Transport failure. Reported as 0 so the caller can tell it from a verdict.
    return { ok: false, status: 0 };
  }
  if (!res.ok) return { ok: false, status: res.status };
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, status: 0 };
  }
  const body = obj(parsed);
  return body ? { ok: true, body } : { ok: false, status: 0 };
};

/**
 * Ask Klarna what happened for an HPP session.
 *
 * This IS the verification step, the same way iyzico's retrieve is: the callback
 * that triggered it carries no signature — Klarna's own documentation tells
 * merchants to put a one-time token in the URL instead — so the posted body is
 * discarded except for the session id, and what gets recorded is Klarna's answer
 * fetched with the merchant's own credentials. A session id belonging to another
 * merchant, or invented, 404s and produces nothing.
 *
 * ## Two calls, and why the second one is not optional
 *
 * The session read says only whether the consumer got through
 * (`status: COMPLETED`) and, in `CAPTURE_ORDER` mode, hands back an `order_id`.
 * The money — amount, currency, what was captured, what was refunded, and the
 * `merchant_reference1` that ties it to the invoice row — lives on the ORDER, so
 * the order is read too. A session that completed but whose order cannot be
 * read is reported `unreachable` rather than recorded with a guessed amount:
 * Klarna retries the callback, and a payment filed at the wrong figure is worse
 * than one filed late.
 *
 * ## Why a non-completed session is `ok`
 *
 * Klarna calls `status_update` on EVERY transition, including `IN_PROGRESS` and
 * the retryable `FAILED`/`BACK`/`ERROR`. Those are genuine deliveries about a
 * session we own, so refusing them would 400 in Klarna's dashboard and read as a
 * broken endpoint. They come back `ok` with no order attached, and the
 * normalizer writes no row — the delivery is still logged in `payment_events`.
 */
export async function retrieveKlarnaPayment(
  input: KlarnaRetrieveInput,
): Promise<KlarnaRetrieveResult> {
  const username = str(input.config.username);
  const password = str(input.config.password);
  if (!username || !password) return { ok: false, reason: "missing_secret" };
  if (!KLARNA_ID_PATTERN.test(input.sessionId)) return { ok: false, reason: "rejected" };

  const doFetch: FetchLike = input.fetchImpl ?? ((i, init) => fetch(i, init));
  const host = klarnaHost(input.config);
  const auth = klarnaAuthHeader(username, password);

  const session = await klarnaGet(doFetch, `${host}/hpp/v1/sessions/${input.sessionId}`, auth);
  if (!session.ok) {
    // 4xx is a verdict — an unknown session, or one belonging to somebody else.
    // Anything else (0, 5xx) is an outage, and the caller turns it into a retry
    // rather than filing a payment that may well have succeeded as a forgery.
    return { ok: false, reason: session.status >= 400 && session.status < 500 ? "rejected" : "unreachable" };
  }

  const status = str(session.body.status) ?? "";
  const orderId = str(session.body.order_id);
  // Only a completed session has an order behind it. A completed session with
  // NO order id is a session opened in `NONE` place-order mode by something
  // other than backlex's checkout — Klarna is waiting for that integration to
  // place the order itself, and there is nothing here to record yet.
  if (status !== "COMPLETED" || !orderId || !KLARNA_ID_PATTERN.test(orderId)) {
    return { ok: true, payload: { ...session.body, session_id: input.sessionId } };
  }

  const order = await klarnaGet(doFetch, `${host}/ordermanagement/v1/orders/${orderId}`, auth);
  if (!order.ok) return { ok: false, reason: "unreachable" };
  return {
    ok: true,
    // The session fields stay under their own key so the normalizer can tell
    // "the consumer got through" from "this is what the order says", and so an
    // order field never silently shadows a session one of the same name.
    payload: { ...order.body, session_id: input.sessionId, session_status: status, order_id: orderId },
  };
}

/**
 * Klarna order status → the ledger's own vocabulary.
 *
 * `AUTHORIZED` is deliberately `pending`: the money is reserved and not taken,
 * the same reading Authorize.net's bare `authorization` gets. Checkouts opened
 * by backlex ask for `CAPTURE_ORDER`, so they arrive `CAPTURED` — a session
 * created elsewhere against this connection may not.
 */
const klarnaStatusFor = (orderStatus: string, fraudStatus: string): string => {
  if (fraudStatus === "REJECTED") return "failed";
  switch (orderStatus) {
    case "CAPTURED":
    case "PART_CAPTURED":
      return fraudStatus === "PENDING" ? "pending" : "succeeded";
    case "AUTHORIZED":
      return "pending";
    case "CANCELLED":
      return "canceled";
    case "EXPIRED":
      return "failed";
    default:
      return orderStatus ? orderStatus.toLowerCase() : "pending";
  }
};

/**
 * A retrieved Klarna order → one payment record.
 *
 * ## Amounts need no conversion
 *
 * Klarna quotes MINOR units, the same as the ledger — unlike iyzico, whose
 * major-unit decimals put its rows in at a hundredth of everyone else's until
 * that was fixed. `captured_amount` is preferred over `order_amount` because it
 * is what actually moved; an authorised-not-captured order reports
 * `captured_amount: 0`, and filing the authorisation's full total as money
 * received would overstate the ledger. `order_amount` is the fallback for the
 * partially-captured and cancelled cases, where 0 would be a lie in the other
 * direction.
 *
 * ## What a session-only delivery produces
 *
 * Nothing. `IN_PROGRESS`, `CANCELLED`, `TIMEOUT` and the retryable states carry
 * no order, so they write no row — an abandoned checkout is not a payment, and
 * a `failed` row for one that the consumer then retries successfully would sit
 * in the ledger for ever next to the real payment. The delivery is still in
 * `payment_events`, which is where an admin looks for "did anyone open it".
 */
const normalizeKlarna = (body: Record<string, unknown>): NormalizedPaymentEvent => {
  const sessionId = str(body.session_id) ?? "";
  const sessionStatus = str(body.session_status) ?? str(body.status) ?? "";
  const orderId = str(body.order_id);
  // Dedupe key. `updated_at` is what makes a genuine transition distinct from
  // Klarna's retry of the same one: the retry repeats the timestamp, a real
  // progression does not. Falling back to the status keeps a session with no
  // timestamp from collapsing every delivery onto one event.
  const stamp = str(body.updated_at) ?? sessionStatus;
  const eventId = sessionId ? `klarna_${sessionId}_${stamp}` : "";

  if (!orderId) {
    return {
      eventId,
      type: `session.${sessionStatus || "unknown"}`,
      livemode: null,
      records: [],
    };
  }

  return {
    eventId,
    type: `order.${str(body.status) || "unknown"}`,
    // The playground is a separate HOST, not a flag on the payload — Klarna
    // says nothing about it here, and the connection's `environment` is what
    // actually knows.
    livemode: null,
    records: [klarnaOrderRecord(body, orderId, sessionId, sessionStatus)],
  };
};

/**
 * A Klarna Order Management order → the payment row.
 *
 * Split out from `normalizeKlarna` so the settlement callback and the refresh
 * sync build the row from ONE mapping. They read the same endpoint, and the
 * upsert REPLACES the row — two mappings that drifted would mean a refresh
 * quietly rewriting a payment into a slightly different shape every six hours.
 *
 * Every money field the row carries is stated by this one response
 * (`order_amount`, `captured_amount`, `refunded_amount`), which is precisely
 * what qualifies Klarna for a refresh at all — see `PAYMENT_CAN_REFETCH`.
 */
const klarnaOrderRecord = (
  body: Record<string, unknown>,
  orderId: string,
  sessionId: string,
  sessionStatus: string,
): PaymentRecord => {
  const currency = str(body.purchase_currency) ?? "EUR";
  const captured = num(body.captured_amount);
  const orderStatus = str(body.status) ?? "";
  const fraudStatus = str(body.fraud_status) ?? "";
  const billing = obj(body.billing_address);
  return {
    kind: "payment",
    row: {
      id: paymentRowId("klarna", orderId),
      provider: "klarna",
      external_id: orderId,
      customer: null,
      invoice: null,
      amount: captured !== null && captured > 0 ? captured : num(body.order_amount),
      amount_refunded: num(body.refunded_amount) ?? 0,
      currency,
      status: klarnaStatusFor(orderStatus, fraudStatus),
      // Klarna is one payment method as far as the ledger is concerned;
      // which BNPL plan the consumer picked is not on the order.
      method: "klarna",
      failure_reason:
        fraudStatus === "REJECTED"
          ? "rejected in Klarna's fraud review"
          : orderStatus === "EXPIRED"
            ? "the authorization expired before it was captured"
            : null,
      // `merchant_reference1` is what the checkout travelled out with.
      reference: str(body.merchant_reference1) ?? str(body.merchant_reference2),
      processed_at: isoToMs(body.completed_at) ?? isoToMs(body.created_at),
      metadata: {
        // A refresh has no session behind it, so these are omitted rather than
        // written as empty — the row keeps whatever the settlement recorded.
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(sessionStatus ? { session_status: sessionStatus } : {}),
        ...(str(body.klarna_reference) ? { klarna_reference: str(body.klarna_reference) } : {}),
        ...(fraudStatus ? { fraud_status: fraudStatus } : {}),
        ...(str(billing?.email) ? { email: str(billing?.email) } : {}),
        ...(str(billing?.country) ? { country: str(billing?.country) } : {}),
      },
      source_created_at: isoToMs(body.created_at),
    },
  };
};

/**
 * Read one Klarna order by id. The refresh sync's half of the retrieve.
 */
const refetchKlarna = async (input: RefetchInput): Promise<RefetchResult> => {
  const username = str(input.config.username);
  const password = str(input.config.password);
  if (!username || !password) return { ok: false, reason: "missing_secret" };
  if (!KLARNA_ID_PATTERN.test(input.externalId)) return { ok: false, reason: "rejected" };
  const doFetch: FetchLike = input.fetchImpl ?? ((i, init) => fetch(i, init));
  const order = await klarnaGet(
    doFetch,
    `${klarnaHost(input.config)}/ordermanagement/v1/orders/${input.externalId}`,
    klarnaAuthHeader(username, password),
  );
  if (!order.ok) {
    if (order.status === 404) return { ok: false, reason: "not_found" };
    return { ok: false, reason: order.status >= 400 && order.status < 500 ? "rejected" : "unreachable" };
  }
  return { ok: true, records: [klarnaOrderRecord(order.body, input.externalId, "", "")] };
};

/**
 * The handle a `retrieve` provider's unsigned callback carries, per provider.
 *
 * Exported so the consumer never re-derives it per provider at the call site.
 * The two bodies are not the same shape at all — iyzico posts form-encoded
 * `token=…`, Klarna posts JSON — and picking the wrong parser yields `null`,
 * which the receive path reports as a missing signature. That reads as a forged
 * callback rather than as a parser mismatch, so the two live together here.
 */
export const parseRetrieveHandle = (provider: string, rawBody: string): string | null => {
  if (provider === "iyzico") return parseCallbackBody(rawBody).token ?? null;
  if (provider === "klarna") return klarnaSessionIdFrom(rawBody);
  return null;
};

/**
 * The dummy provider's settlement → one payment record.
 *
 * Shaped like PayTR's on purpose: a form-encoded body with an order id, a
 * status and a minor-unit total. The point of the provider is to exercise the
 * real receive path — verification, dedupe, normalize, upsert — so its payload
 * deliberately looks like a real one rather than a privileged shortcut.
 */
const normalizeDummy = (body: Record<string, unknown>): NormalizedPaymentEvent => {
  const reference = str(body.reference) ?? "";
  const succeeded = str(body.status) === "success";
  return {
    eventId: reference,
    type: succeeded ? "payment.success" : "payment.failed",
    // Nothing about this provider is live money, and saying otherwise would
    // let a dummy row through a `livemode` filter meant to hide test data.
    livemode: false,
    records: reference
      ? [
          {
            kind: "payment",
            row: {
              id: paymentRowId("dummy", reference),
              provider: "dummy",
              external_id: reference,
              customer: null,
              invoice: null,
              amount: num(body.amount),
              amount_refunded: 0,
              currency: str(body.currency) ?? "USD",
              status: succeeded ? "succeeded" : "failed",
              method: "dummy",
              failure_reason: succeeded ? null : (str(body.reason) ?? "declined by the tester"),
              reference,
              processed_at: num(body.at),
              metadata: {},
              source_created_at: num(body.at),
            },
          },
        ]
      : [],
  };
};

export function normalizePaymentEvent(
  provider: string,
  payload: unknown,
  opts: {
    headerEventId?: string | null;
    /**
     * The currency the connected account settles in. Only Authorize.net needs
     * it, and it needs it absolutely: its API states a currency nowhere, so an
     * amount arrives as a bare decimal.
     */
    accountCurrency?: string | null;
    /**
     * Provider detail fetched separately because the notification was too thin
     * to write a useful row from — today only Authorize.net's
     * `getTransactionDetailsRequest` result.
     */
    detail?: unknown;
  } = {},
): NormalizedPaymentEvent {
  const body = obj(payload) ?? {};
  const headerEventId = opts.headerEventId ?? null;
  if (provider === "iyzico") return normalizeIyzico(body);
  if (provider === "stripe") return normalizeStripe(body);
  if (provider === "polar") return normalizePolar(body, headerEventId);
  if (provider === "lemonsqueezy") return normalizeLemonSqueezy(body, headerEventId);
  if (provider === "paddle") return normalizePaddle(body, headerEventId);
  if (provider === "paytr") return normalizePayTR(body);
  if (provider === "adyen") return normalizeAdyen(body);
  if (provider === "authorizenet") {
    return normalizeAuthorizeNet(
      body,
      (opts.accountCurrency ?? "").toUpperCase() || AUTHORIZENET_DEFAULT_CURRENCY,
      obj(opts.detail),
    );
  }
  if (provider === "klarna") return normalizeKlarna(body);
  if (provider === "dummy") return normalizeDummy(body);
  return { eventId: headerEventId ?? "", type: "", livemode: null, records: [] };
}

// ── Refresh: re-read the payments we already know about ─────────────────────

export interface RefetchInput {
  /** Decrypted provider config. */
  config: Record<string, unknown>;
  /** The provider's own id, exactly as stored in `external_id`. */
  externalId: string;
  /** The currency the connected account settles in. Only Authorize.net needs
   *  it, for the same reason the webhook path does — its API states none. */
  accountCurrency?: string | null;
  fetchImpl?: FetchLike;
}

export type RefetchResult =
  | { ok: true; records: PaymentRecord[] }
  /**
   * `not_found` is a VERDICT that must not be confused with `unreachable`.
   * A payment the provider no longer knows about is not a reason to retry for
   * ever, and it is not a reason to blank the row either — the caller skips it
   * and leaves what the settlement recorded standing.
   */
  | { ok: false; reason: "unsupported" | "missing_secret" | "unreachable" | "rejected" | "not_found" };

/**
 * Ask a provider about one payment we already have a row for.
 *
 * This is the primitive behind the `refresh` sync mode. It exists because a
 * settlement-time-only integration is structurally blind to everything that
 * happens AFTER the money arrives — a refund raised in the provider's own
 * dashboard notifies nobody, and for a catalog-less provider there is no
 * listing to reconcile against either.
 *
 * Never throws: every outcome is a `reason` the caller can act on, because the
 * caller is a loop over hundreds of rows and one bad id must not end the run.
 */
export async function refetchPayment(
  provider: string,
  input: RefetchInput,
): Promise<RefetchResult> {
  if (!canRefetchPayment(provider)) return { ok: false, reason: "unsupported" };
  if (!input.externalId) return { ok: false, reason: "rejected" };
  if (provider === "klarna") return refetchKlarna(input);
  if (provider === "authorizenet") return refetchAuthorizeNet(input);
  // Unreachable while the capability table and this dispatch agree; a provider
  // marked refetchable with no branch lands here rather than silently
  // reporting a clean refresh that refreshed nothing.
  return { ok: false, reason: "unsupported" };
}

// ── Reconcile: pull objects back from the provider API ──────────────────────

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchPageInput {
  provider: string;
  /** Decrypted provider config. */
  config: Record<string, unknown>;
  kind: PaymentRecordKind;
  /** Opaque provider cursor from the previous page; null starts at the top. */
  cursor?: string | null;
  /** Objects per page. Clamped to each provider's own maximum. */
  limit?: number;
  fetchImpl?: FetchLike;
}

export interface FetchPageResult {
  records: PaymentRecord[];
  /** Pass back as `cursor` to continue; null when the listing is exhausted. */
  nextCursor: string | null;
  /** Set when the provider refused the call — the caller surfaces it. */
  error?: string;
}

const polarBase = (config: Record<string, unknown>): string =>
  str(config.server) === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";

/** Provider path + response shape per kind. Stripe pages by object id
 *  (`starting_after`), Polar and LS by page number. */
export async function fetchPaymentPage(input: FetchPageInput): Promise<FetchPageResult> {
  const doFetch: FetchLike = input.fetchImpl ?? ((i, init) => fetch(i, init));
  const config = input.config;
  const apiKey = str(config.apiKey) ?? "";
  const empty: FetchPageResult = { records: [], nextCursor: null };
  // Asked before the credential check so the answer names the real obstacle: a
  // provider with no catalog is not fixable by supplying a better API key.
  // Adyen is the case that makes this worth stating — it authenticates fine and
  // still has nothing to page through.
  if (!hasObjectCatalog(input.provider)) return { ...empty, error: "no_object_catalog" };
  if (!apiKey) return { ...empty, error: "missing_api_key" };

  try {
    if (input.provider === "stripe") {
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
      const path: Record<PaymentRecordKind, string> = {
        customer: "customers",
        subscription: "subscriptions",
        invoice: "invoices",
        payment: "charges",
      };
      const qs = new URLSearchParams({ limit: String(limit) });
      // Stripe only expands sub-objects on request; the price is what makes a
      // subscription row useful, so ask for it.
      if (input.kind === "subscription") qs.append("expand[]", "data.items.data.price");
      if (input.cursor) qs.set("starting_after", input.cursor);
      const res = await doFetch(`https://api.stripe.com/v1/${path[input.kind]}?${qs}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return { ...empty, error: `stripe ${res.status}` };
      const body = (await res.json()) as { data?: unknown[]; has_more?: boolean };
      const rows = Array.isArray(body.data) ? body.data : [];
      const records: PaymentRecord[] = [];
      for (const raw of rows) {
        const o = obj(raw);
        if (!o || typeof o.id !== "string") continue;
        if (input.kind === "customer") records.push(stripeCustomer(o));
        else if (input.kind === "subscription") records.push(stripeSubscription(o));
        else if (input.kind === "invoice") records.push(stripeInvoice(o));
        else records.push(stripeChargePayment(o));
      }
      const last = rows.length > 0 ? obj(rows[rows.length - 1]) : null;
      const nextCursor = body.has_more && last && typeof last.id === "string" ? last.id : null;
      return { records, nextCursor };
    }

    if (input.provider === "polar") {
      // Polar has no customer-facing "invoice" list; orders back both kinds.
      const path: Record<PaymentRecordKind, string> = {
        customer: "customers",
        subscription: "subscriptions",
        invoice: "orders",
        payment: "orders",
      };
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
      const page = Math.max(Number(input.cursor ?? "1") || 1, 1);
      const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
      const res = await doFetch(`${polarBase(config)}/v1/${path[input.kind]}?${qs}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return { ...empty, error: `polar ${res.status}` };
      const body = (await res.json()) as {
        items?: unknown[];
        pagination?: { max_page?: number };
      };
      const rows = Array.isArray(body.items) ? body.items : [];
      const records: PaymentRecord[] = [];
      for (const raw of rows) {
        const o = obj(raw);
        if (!o || o.id === undefined) continue;
        if (input.kind === "customer") records.push(polarCustomer(o));
        else if (input.kind === "subscription") records.push(polarSubscription(o));
        else {
          const both = polarOrder(o);
          const want = input.kind === "invoice" ? "invoice" : "payment";
          records.push(...both.filter((r) => r.kind === want));
        }
      }
      const maxPage = num(body.pagination?.max_page) ?? page;
      return { records, nextCursor: page < maxPage ? String(page + 1) : null };
    }

    if (input.provider === "lemonsqueezy") {
      const path: Record<PaymentRecordKind, string> = {
        customer: "customers",
        subscription: "subscriptions",
        invoice: "orders",
        payment: "orders",
      };
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
      const page = Math.max(Number(input.cursor ?? "1") || 1, 1);
      const qs = new URLSearchParams({
        "page[size]": String(limit),
        "page[number]": String(page),
      });
      const storeId = str(config.storeId);
      if (storeId) qs.set("filter[store_id]", storeId);
      const res = await doFetch(`https://api.lemonsqueezy.com/v1/${path[input.kind]}?${qs}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.api+json" },
      });
      if (!res.ok) return { ...empty, error: `lemonsqueezy ${res.status}` };
      const body = (await res.json()) as {
        data?: unknown[];
        meta?: { page?: { lastPage?: number } };
      };
      const rows = Array.isArray(body.data) ? body.data : [];
      const records: PaymentRecord[] = [];
      for (const raw of rows) {
        const o = obj(raw);
        const id = str(o?.id);
        const a = obj(o?.attributes) ?? {};
        if (!id) continue;
        if (input.kind === "customer") {
          records.push({
            kind: "customer",
            row: {
              id: paymentRowId("lemonsqueezy", id),
              provider: "lemonsqueezy",
              external_id: id,
              email: str(a.email),
              name: str(a.name),
              currency: null,
              delinquent: false,
              metadata: null,
              source_created_at: isoToMs(a.created_at),
            },
          });
        } else if (input.kind === "subscription") {
          records.push(lsSubscription(id, a));
        } else {
          const both = lsOrder(id, a);
          const want = input.kind === "invoice" ? "invoice" : "payment";
          records.push(...both.filter((r) => r.kind === want));
        }
      }
      const lastPage = num(body.meta?.page?.lastPage) ?? page;
      return { records, nextCursor: page < lastPage ? String(page + 1) : null };
    }

    if (input.provider === "paddle") {
      // Paddle pages by an opaque `after` cursor carried in
      // `meta.pagination.next` as a full URL; the cursor stored here is just
      // the id to resume after, so a stale absolute URL can never be replayed.
      const base =
        str(config.environment) === "sandbox"
          ? "https://sandbox-api.paddle.com"
          : "https://api.paddle.com";
      const path: Record<PaymentRecordKind, string> = {
        customer: "customers",
        subscription: "subscriptions",
        // Paddle has one billable object; it backs both kinds.
        invoice: "transactions",
        payment: "transactions",
      };
      const qs = new URLSearchParams({ per_page: String(Math.min(Math.max(input.limit ?? 100, 1), 200)) });
      if (input.cursor) qs.set("after", input.cursor);
      const res = await doFetch(`${base}/${path[input.kind]}?${qs}`, {
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      });
      if (!res.ok) return { ...empty, error: `paddle ${res.status}` };
      const body = (await res.json()) as {
        data?: unknown[];
        meta?: { pagination?: { has_more?: boolean; next?: string } };
      };
      const rows = Array.isArray(body.data) ? body.data : [];
      const records: PaymentRecord[] = [];
      for (const raw of rows) {
        const o = obj(raw);
        if (!o || typeof o.id !== "string") continue;
        // Reuse the event normalizer so a reconciled row and a webhook row are
        // byte-identical — two shapes for one object is how sync drift starts.
        const kindEvent =
          input.kind === "customer"
            ? "customer.updated"
            : input.kind === "subscription"
              ? "subscription.updated"
              : "transaction.updated";
        const out = normalizePaddle({ event_type: kindEvent, data: o }, null);
        records.push(...out.records.filter((r) => r.kind === input.kind));
      }
      const last = rows.length > 0 ? obj(rows[rows.length - 1]) : null;
      const hasMore = body.meta?.pagination?.has_more === true;
      const nextCursor = hasMore && last && typeof last.id === "string" ? last.id : null;
      return { records, nextCursor };
    }

    return { ...empty, error: "unknown_provider" };
  } catch (e) {
    return { ...empty, error: (e as Error)?.message ?? "fetch_failed" };
  }
}
