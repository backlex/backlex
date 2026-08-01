import { PAYMENT_PROVIDERS } from "@backlex/integrations/payments";
import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Payments MCP tools — connect a provider, watch deliveries, trigger a
 * reconcile. Every call goes back through `/api/admin/payments`, so the admin
 * gate and secret masking are the REST ones.
 *
 * There is deliberately no tool for reading synced billing rows: those live in
 * ordinary collections, so `collections-list` / `collections-read` already
 * cover `payment_customers`, `payment_subscriptions`, `payment_invoices` and
 * `payments` with the caller's own permissions applied.
 */

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const BASE = "/api/admin/payments";

export const listPaymentProviders: McpTool = {
  name: "payments.list",
  description:
    "List payment providers connected to the active workspace (Stripe / Polar / " +
    "Lemon Squeezy), with each one's webhook receive path, last event time and " +
    "last sync result. Secrets come back masked. Admin-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`${BASE}/providers`);
    return textResult(await readJson<unknown>(res));
  },
};

export const paymentsCatalog: McpTool = {
  name: "payments.catalog",
  description:
    "Which payment providers are supported and what config each one needs " +
    "(field keys, which are secret). Call this before `payments.connect` so " +
    "the credentials you ask the user for match the provider.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`${BASE}/catalog`);
    return textResult(await readJson<unknown>(res));
  },
};

export const connectPaymentProvider: McpTool = {
  name: "payments.connect",
  description:
    "Connect (or reconfigure) a payment provider. Also provisions the four sync " +
    "collections — payment_customers, payment_subscriptions, payment_invoices, " +
    "payments — so incoming webhooks have somewhere to land. Returns the " +
    "webhook path to paste into the provider's dashboard. Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      // Derived, not hand-listed: this enum had drifted three providers behind
      // the registry, so an agent could not connect Paddle, PayTR or iyzico at
      // all even though the REST endpoint accepted them.
      provider: { type: "string", enum: [...PAYMENT_PROVIDERS] },
      config: {
        type: "object",
        description:
          "Credentials — see `payments.catalog` for the keys. Omitting a secret " +
          "leaves the stored one untouched.",
      },
      status: { type: "string", enum: ["connected", "disabled"] },
    },
    required: ["provider"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`${BASE}/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const disconnectPaymentProvider: McpTool = {
  name: "payments.disconnect",
  description:
    "Disconnect a payment provider by id. The synced rows are kept — that data " +
    "belongs to the workspace, not the provider. Admin-only.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`${BASE}/providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const rotatePaymentToken: McpTool = {
  name: "payments.rotate_token",
  description:
    "Issue a fresh webhook receive URL for a provider. The previous URL stops " +
    "working immediately, so the new one must be pasted into the provider " +
    "dashboard. Admin-only.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(
      `${BASE}/providers/${encodeURIComponent(id)}/rotate-token`,
      { method: "POST" },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const syncPaymentProvider: McpTool = {
  name: "payments.sync",
  description:
    "Reconcile against the provider API: pull customers / subscriptions / " +
    "invoices / payments back and upsert them. Use it after connecting (to " +
    "backfill history) or when a delivery was missed. Set `async` to queue it " +
    "as a durable job for large accounts. Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Connected provider id." },
      kinds: {
        type: "array",
        description: "Restrict to some record kinds; defaults to all four.",
        items: { type: "string", enum: ["customer", "subscription", "invoice", "payment"] },
      },
      maxPages: { type: "number", description: "Pages per kind (1-100)." },
      resume: { type: "boolean", description: "Continue from the stored cursor." },
      async: { type: "boolean", description: "Queue as a job instead of running inline." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id, ...body } = args as Record<string, unknown>;
    const providerId = String(id ?? "");
    if (!providerId) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(
      `${BASE}/providers/${encodeURIComponent(providerId)}/sync`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return textResult(await readJson<unknown>(res));
  },
};

export const listPaymentEvents: McpTool = {
  name: "payments.events",
  description:
    "Recent inbound webhook deliveries, newest first. `status` is received / " +
    "processed / skipped (an event type we don't map) / failed — start here " +
    "when billing data looks stale. Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      providerId: { type: "string" },
      limit: { type: "number", description: "1-200, default 50." },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const qs = new URLSearchParams();
    if (args.providerId) qs.set("providerId", String(args.providerId));
    if (args.limit !== undefined) qs.set("limit", String(args.limit));
    const q = qs.toString();
    const res = await ctx.fetchInternal(`${BASE}/events${q ? `?${q}` : ""}`);
    return textResult(await readJson<unknown>(res));
  },
};

export const provisionPaymentCollections: McpTool = {
  name: "payments.provision_collections",
  description:
    "(Re-)create the four collections a payments sync writes into. Idempotent — " +
    "runs automatically on connect, exposed here for a workspace where one was " +
    "dropped. Admin-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`${BASE}/collections`, { method: "POST" });
    return textResult(await readJson<unknown>(res));
  },
};

export const createPaymentCheckout: McpTool = {
  name: "payments.checkout",
  description:
    "Open a hosted checkout and get a payment link to send the customer. This is " +
    "how you ASK for money — the rest of these tools only mirror payments that " +
    "already happened. `amount` is in MINOR units (cents), matching the ledger. " +
    "Use `writeBack` to store the link on the invoice/quote/donation row that is " +
    "asking to be paid; the `reference` it travels with comes back on the " +
    "settlement as `payment_transactions.reference`, which is what ties the two " +
    "together. Stripe, Adyen, Authorize.net, PayTR, iyzico, Klarna and the test " +
    "`dummy` provider take an ad-hoc amount; Polar, Lemon Squeezy and Paddle need a pre-made " +
    "price and will refuse. Authorize.net charges only in the currency its account " +
    "settles in, and shortens the reference to 20 characters. Admin-only.",
  inputSchema: {
    type: "object",
    properties: {
      providerId: { type: "string", description: "Connected provider id. Wins over `provider`." },
      provider: { type: "string", enum: [...PAYMENT_PROVIDERS] },
      amount: { type: "number", description: "MINOR units — 1050 is $10.50." },
      currency: { type: "string", description: "3-letter ISO-4217 code." },
      description: { type: "string", description: "What the customer sees on the line item." },
      customer: {
        type: "object",
        description:
          "PayTR and iyzico both require `email`. `name`, `phone`, `address`, " +
          "`city`, `country` sharpen the provider's own fraud scoring.",
      },
      successUrl: { type: "string" },
      cancelUrl: { type: "string" },
      reference: {
        type: "string",
        description:
          "Overrides the reference derived from `writeBack.itemId`. Alphanumeric, " +
          "max 48 — non-alphanumeric characters are stripped.",
      },
      customerIp: { type: "string", description: "The PAYING customer's IP (PayTR needs it)." },
      expiresInSec: { type: "number" },
      locale: { type: "string" },
      writeBack: {
        type: "object",
        description:
          "Store the link on a row: { collection, itemId, urlField, referenceField? }. " +
          "Both fields must already exist on the collection.",
      },
    },
    required: ["amount", "currency"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`${BASE}/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return textResult(await readJson<unknown>(res));
  },
};

export const paymentsTools: McpTool[] = [
  paymentsCatalog,
  listPaymentProviders,
  connectPaymentProvider,
  disconnectPaymentProvider,
  rotatePaymentToken,
  syncPaymentProvider,
  createPaymentCheckout,
  listPaymentEvents,
  provisionPaymentCollections,
];
