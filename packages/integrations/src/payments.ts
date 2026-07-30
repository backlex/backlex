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

export const PAYMENT_PROVIDERS = [
  "stripe",
  "polar",
  "lemonsqueezy",
  "paddle",
  "paytr",
  "iyzico",
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
};

/**
 * How a provider talks to us — the distinction the rest of this module branches
 * on.
 *
 * `webhook` (Stripe / Polar / Lemon Squeezy): the provider pushes signed JSON
 * events AND exposes a listable object catalog, so backlex can reconcile by
 * walking customers/subscriptions/invoices/payments.
 *
 * `callback` (PayTR, and the Turkish PSPs generally): the provider POSTs a
 * form-encoded result to a callback URL when a payment settles, and that is the
 * whole surface — there is no catalog to page through. Reconcile is therefore
 * not merely unimplemented for these, it is *impossible*, and pretending
 * otherwise would report a successful sync that synced nothing.
 *
 * `retrieve` (iyzico): the provider POSTs a bare `token` with NO signature on
 * it, and the payment result is fetched by calling the provider back with the
 * merchant's own API credentials. Authenticity therefore comes from the
 * RESPONSE, not the request — the posted body is discarded except for the
 * token, and everything recorded is what the provider told us when we asked.
 * A forged or foreign token yields an error or a stranger's `failure`, never a
 * recorded payment. Inventing a signature scheme for this instead would either
 * reject every real callback or accept forgeries.
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

const enc = new TextEncoder();

const importHmacKey = (keyBytes: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    // A fresh copy pins the exact byte range — some runtimes reject a view
    // whose underlying buffer is larger than the view itself.
    keyBytes.slice().buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

const hmac = async (keyBytes: Uint8Array, message: string): Promise<Uint8Array> => {
  const key = await importHmacKey(keyBytes);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return new Uint8Array(sig);
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const fromBase64 = (b64: string): Uint8Array | null => {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

/** Length-independent, content-constant-time string compare. */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

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
      processed_at: secToMs(o.created),
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
              amount: num(body.paidPrice) ?? num(body.price),
              amount_refunded: 0,
              currency: str(body.currency) ?? "TRY",
              status: succeeded ? "succeeded" : "failed",
              method: str(body.paymentChannel),
              failure_reason: succeeded
                ? null
                : (str(body.errorMessage) ?? str(body.errorCode) ?? (paymentStatus || null)),
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

export function normalizePaymentEvent(
  provider: string,
  payload: unknown,
  opts: { headerEventId?: string | null } = {},
): NormalizedPaymentEvent {
  const body = obj(payload) ?? {};
  const headerEventId = opts.headerEventId ?? null;
  if (provider === "iyzico") return normalizeIyzico(body);
  if (provider === "stripe") return normalizeStripe(body);
  if (provider === "polar") return normalizePolar(body, headerEventId);
  if (provider === "lemonsqueezy") return normalizeLemonSqueezy(body, headerEventId);
  if (provider === "paddle") return normalizePaddle(body, headerEventId);
  if (provider === "paytr") return normalizePayTR(body);
  return { eventId: headerEventId ?? "", type: "", livemode: null, records: [] };
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
