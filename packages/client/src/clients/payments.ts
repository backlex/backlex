import type { ClientCore } from "../core";

/** One connected payment provider. Secrets come back MASKED. */
export interface PaymentProviderConnection {
  id: string;
  /** `stripe` | `polar` | `lemonsqueezy`. */
  provider: string;
  status: string;
  /** Provider config with every secret field masked (`sk_l…3f9x`). */
  config: Record<string, unknown>;
  webhookToken: string;
  /** Origin-relative path to paste into the provider's webhook settings. */
  webhookPath: string;
  syncCursor: Record<string, string | null> | null;
  lastEventAt?: unknown;
  lastSyncAt?: unknown;
  lastSyncError: string | null;
  createdAt?: unknown;
}

export interface PaymentProviderInput {
  provider: string;
  /** Credentials. A masked value is treated as "leave the stored one alone". */
  config?: Record<string, unknown>;
  status?: "connected" | "disabled";
}

/** One inbound webhook delivery, verified or not. */
export interface PaymentEvent {
  id: string;
  providerId: string;
  /** The provider's own event id — the replay key. */
  externalId: string;
  type: string;
  /** `received` | `processed` | `skipped` | `failed`. */
  status: string;
  recordCount: number;
  error: string | null;
  createdAt?: unknown;
  processedAt?: unknown;
}

export interface PaymentSyncResult {
  queued?: boolean;
  jobId?: string;
  provider?: string;
  written?: number;
  failed?: number;
  cursors?: Record<string, string | null>;
  error?: string;
}

export interface PaymentCollectionsResult {
  /** Slugs this call created. */
  created: string[];
  /** Slugs that already existed as sync targets. */
  existing: string[];
  /** Slugs taken by an unrelated collection — nothing is written to these
   *  until one of the two is renamed. */
  conflicts: string[];
  /** Columns added to an already-existing sync target, by slug. Empty in the
   *  steady state; populated when a workspace catches up to a new column. */
  addedFields: Record<string, string[]>;
}

/** Where the customer pays, plus the reference that ties it back. */
export interface PaymentCheckout {
  provider: string;
  providerId: string;
  /** Hosted payment page — send the customer here. */
  url: string;
  /** The provider's own id for the checkout (session id / token). */
  externalId: string;
  /** Epoch ms, or null when the provider doesn't say. */
  expiresAt: number | null;
  /**
   * Travels out with the checkout and comes back on the settlement event as
   * `payment_transactions.reference` — this is what ties the payment to the
   * row that asked for it.
   */
  reference: string;
  /** Set when `writeBack` was given: what was updated where. */
  writtenBack: { collection: string; itemId: string; fields: string[] } | null;
}

export interface PaymentCheckoutInput {
  /** Connected provider row id. Takes precedence over `provider`. */
  providerId?: string;
  /** Provider name, for callers that don't hold the connection id. */
  provider?: string;
  /** MINOR units (cents), matching `payment_transactions.amount`. */
  amount: number;
  currency: string;
  description?: string;
  /** PayTR and iyzico both require `email`; the rest sharpens fraud scoring. */
  customer?: {
    email?: string;
    name?: string;
    phone?: string;
    address?: string;
    city?: string;
    country?: string;
    identityNumber?: string;
  };
  successUrl?: string;
  cancelUrl?: string;
  /** Overrides the reference derived from `writeBack.itemId`. Non-alphanumeric
   *  characters are stripped — PayTR's order id accepts nothing else. */
  reference?: string;
  /** The PAYING customer's IP. PayTR folds it into the token hash; the server
   *  falls back to the calling request's IP. */
  customerIp?: string;
  expiresInSec?: number;
  locale?: string;
  /** Store the link on the row that is asking to be paid. Both fields must
   *  already exist on the collection. */
  writeBack?: {
    collection: string;
    itemId: string;
    urlField: string;
    referenceField?: string;
  };
}

/** What a provider gave back, and what that did to the ledger. */
export interface PaymentRefund {
  provider: string;
  providerId: string;
  /** The `payment_transactions` row that was refunded. */
  paymentRowId: string;
  /** The provider's own id for the payment. */
  externalId: string;
  /** The provider's own id for the refund. Empty when it issues none. */
  refundId: string;
  /** MINOR units actually refunded. */
  amount: number;
  currency: string;
  /**
   * `pending` means the provider accepted the refund but has not decided it —
   * Adyen resolves this in a REFUND webhook and Paddle holds live refunds for
   * human approval. Treating it as done reports money that may not move.
   */
  status: "succeeded" | "pending";
  /** Whether this took the payment's refunded total to its full amount. */
  full: boolean;
  /**
   * What was written to `payment_transactions`, or null for providers that file
   * a refund as its own transaction (Adyen, Authorize.net) — there the refund's
   * own notification writes the row, and bumping the original would be undone.
   */
  ledger: { amountRefunded: number; status: string } | null;
  /** Set when the provider said something the operator should see. */
  note?: string;
}

export interface PaymentRefundInput {
  /** Connected provider row id. Takes precedence over `provider`. */
  providerId?: string;
  provider?: string;
  /** Which payment. One of these three; tried in this order. */
  paymentRowId?: string;
  externalId?: string;
  /** The reference an outbound checkout travelled with. Refused when it matches
   *  more than one payment. */
  reference?: string;
  /** MINOR units. Omitted refunds the whole remaining balance. */
  amount?: number;
  reason?: "duplicate" | "fraudulent" | "requested_by_customer" | "other";
  description?: string;
  /** Overrides the derived key. The default is derived from the payment and the
   *  amount already refunded, so a retry dedupes and a second refund does not. */
  idempotencyKey?: string;
}

export interface PaymentCatalogEntry {
  provider: string;
  label: string;
  /**
   * `adhoc` takes an amount and mints a one-off checkout; `catalog` needs a
   * pre-existing price id and is not supported yet; `null` means the provider
   * has no hosted checkout at all.
   */
  checkoutMode: "adhoc" | "catalog" | null;
  /**
   * How much of a payment this provider will give back. `full_only` is Paddle,
   * whose partial refunds adjust individual line items backlex does not store.
   */
  refundSupport?: "full_and_partial" | "full_only" | null;
  fields: {
    key: string;
    label: string;
    placeholder?: string;
    secret?: boolean;
    optional?: boolean;
    /** Finite value set — render a select rather than a text input. */
    choices?: string[];
    hint?: string;
  }[];
}

export interface PaymentsClient {
  /** Supported providers and the config fields each one needs. */
  catalog(): Promise<{ providers: PaymentCatalogEntry[]; recordKinds: string[] }>;
  /** Connected providers plus a count of deliveries per status. */
  list(): Promise<{ data: PaymentProviderConnection[]; stats: Record<string, number> }>;
  /** Connect or reconfigure a provider; also provisions the sync collections. */
  connect(
    input: PaymentProviderInput,
  ): Promise<{ data: PaymentProviderConnection; collections: PaymentCollectionsResult }>;
  /** Disconnect. Synced rows are kept — that data is the workspace's. */
  disconnect(id: string): Promise<{ ok: boolean }>;
  /** Issue a fresh receive URL and invalidate the previous one. */
  rotateToken(id: string): Promise<{ data: PaymentProviderConnection }>;
  /** Pull objects back from the provider API and upsert them. */
  sync(
    id: string,
    opts?: { kinds?: string[]; maxPages?: number; resume?: boolean; async?: boolean },
  ): Promise<PaymentSyncResult>;
  /**
   * Open a hosted checkout and get a link to send the customer to.
   *
   * The outbound half of payments. `writeBack` stores the URL on the row that
   * is asking to be paid; the `reference` it travels with comes back on the
   * settlement as `payment_transactions.reference`, which is what ties the
   * money to the invoice. Amounts are MINOR units, matching the ledger.
   *
   * Stripe, Adyen, Authorize.net, PayTR, iyzico, Klarna and the test `dummy`
   * provider take an ad-hoc amount. Polar, Lemon Squeezy and Paddle need a pre-made
   * price and are refused with a `catalog_only` explanation rather than a
   * confusing failure.
   *
   * Authorize.net is the one with extra rules: its API states no currency
   * anywhere, so it charges only in the currency the connected account settles
   * in and refuses anything else, and the reference is shortened to 20
   * characters because that is all its invoice number will carry back. The
   * returned `reference` is what was actually sent — store that, not the value
   * you passed in.
   */
  checkout(input: PaymentCheckoutInput): Promise<{ data: PaymentCheckout }>;
  /**
   * Give back some or all of a payment.
   *
   * Say which payment by `paymentRowId`, `externalId` or the checkout
   * `reference`; omit `amount` to refund everything still refundable. The
   * remainder is computed from `payment_transactions` and checked BEFORE the
   * provider is called, so a refund can never take the total past what was
   * charged.
   *
   * Every provider can refund. Paddle can only refund in FULL from here — a
   * partial Paddle refund adjusts individual transaction line items, which a
   * payment row does not carry.
   *
   * Watch `status`: Adyen decides refunds asynchronously (the outcome arrives
   * as a REFUND webhook) and Paddle holds live refunds for review, so both can
   * come back `pending`. For those two `ledger` is null as well — they file a
   * refund as its own transaction, and its own notification writes the row.
   */
  refund(input: PaymentRefundInput): Promise<{ data: PaymentRefund }>;
  /** Recent webhook deliveries, newest first. */
  events(opts?: { providerId?: string; limit?: number }): Promise<{ data: PaymentEvent[] }>;
  /** (Re-)provision the four sync collections. Idempotent. */
  provisionCollections(): Promise<PaymentCollectionsResult>;
}

export const makePayments = (core: ClientCore): PaymentsClient => {
  // Payment providers. Admin-scoped over `/api/admin/payments`; the synced
  // business data is read through the ordinary collection surface.
  const pay = (id: string) => `/api/admin/payments/providers/${encodeURIComponent(id)}`;
  const payments: PaymentsClient = {
    catalog: () =>
      core.request<{ providers: PaymentCatalogEntry[]; recordKinds: string[] }>(
        "GET",
        "/api/admin/payments/catalog",
      ),
    list: () =>
      core.request<{ data: PaymentProviderConnection[]; stats: Record<string, number> }>(
        "GET",
        "/api/admin/payments/providers",
      ),
    connect: (input: PaymentProviderInput) =>
      core.request<{ data: PaymentProviderConnection; collections: PaymentCollectionsResult }>(
        "POST",
        "/api/admin/payments/providers",
        input,
      ),
    disconnect: (id: string) => core.request<{ ok: boolean }>("DELETE", pay(id)),
    rotateToken: (id: string) =>
      core.request<{ data: PaymentProviderConnection }>("POST", `${pay(id)}/rotate-token`, {}),
    sync: (id: string, opts?: { kinds?: string[]; maxPages?: number; resume?: boolean; async?: boolean }) =>
      core.request<PaymentSyncResult>("POST", `${pay(id)}/sync`, opts ?? {}),
    checkout: (input: PaymentCheckoutInput) =>
      core.request<{ data: PaymentCheckout }>("POST", "/api/admin/payments/checkout", input),
    refund: (input: PaymentRefundInput) =>
      core.request<{ data: PaymentRefund }>("POST", "/api/admin/payments/refund", input),
    events: (opts?: { providerId?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (opts?.providerId) qs.set("providerId", opts.providerId);
      if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
      const q = qs.toString();
      return core.request<{ data: PaymentEvent[] }>(
        "GET",
        `/api/admin/payments/events${q ? `?${q}` : ""}`,
      );
    },
    provisionCollections: () =>
      core.request<PaymentCollectionsResult>("POST", "/api/admin/payments/collections", {}),
  };

  return payments;
};
