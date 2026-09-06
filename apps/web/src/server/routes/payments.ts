/**
 * Admin payments API — `/api/admin/payments`.
 *
 * Connect a provider, read its receive URL, watch the delivery log, and kick a
 * reconcile. Every handler delegates to `services/payments`; the SDK, GraphQL,
 * MCP and CLI surfaces all come back through these same endpoints, so the
 * guards live in the service and are stated once.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import {
  paymentSyncMode,
  PAYMENT_PROVIDERS,
  PAYMENT_PROVIDER_FIELDS,
  PAYMENT_PROVIDER_LABELS,
  PAYMENT_RECORD_KINDS,
} from "@backlex/integrations/payments";
import { PAYMENT_CHECKOUT_MODES } from "@backlex/integrations/checkout";
import { PAYMENT_REFUND_SUPPORT, REFUND_REASONS } from "@backlex/integrations/refunds";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses, httpUrl } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { logActivity, requestMeta } from "../services/activity";
import { enqueueJob } from "../services/jobs";
import {
  connectProvider,
  createPaymentCheckout,
  disconnectProvider,
  ensurePaymentCollections,
  listPaymentEvents,
  listProviders,
  paymentEventStats,
  reconcileProvider,
  refundPayment,
  rotateWebhookToken,
} from "../services/payments";

const tags = ["payments"];

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};

const adminGate = [requireUser, requireAdminMiddleware];

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const ProviderRow = z
  .object({
    id: z.string(),
    provider: z.string(),
    status: z.string(),
    config: z.record(z.string(), z.unknown()).openapi({
      description: "Provider config with every secret field masked.",
    }),
    webhookToken: z.string(),
    webhookPath: z.string().openapi({
      description: "Origin-relative path the provider should POST deliveries to.",
    }),
    syncCursor: z.record(z.string(), z.string().nullable()).nullable(),
    lastEventAt: z.unknown().optional(),
    lastSyncAt: z.unknown().optional(),
    lastSyncError: z.string().nullable(),
    createdAt: z.unknown().optional(),
  })
  .openapi("PaymentProvider");

const ProviderInput = z
  .object({
    provider: z.enum(PAYMENT_PROVIDERS).openapi({
      description: "Which payment provider to connect.",
    }),
    config: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        "Provider credentials. Secret keys are encrypted at rest; omitting a " +
        "secret (or sending its masked value back) leaves the stored one intact.",
    }),
    status: z.enum(["connected", "disabled"]).optional(),
  })
  .openapi("PaymentProviderInput");

const CheckoutInput = z
  .object({
    providerId: z.string().optional().openapi({
      description: "Connected provider row id. Takes precedence over `provider`.",
    }),
    provider: z.enum(PAYMENT_PROVIDERS).optional().openapi({
      description: "Provider name, for callers that don't hold the connection id.",
    }),
    amount: z.number().int().positive().openapi({
      description: "MINOR units (cents), matching `payment_transactions.amount`.",
    }),
    currency: z.string().length(3),
    description: z.string().max(200).optional(),
    customer: z
      .object({
        email: z.string().email().optional(),
        name: z.string().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        country: z.string().optional(),
        identityNumber: z.string().optional(),
      })
      .optional()
      .openapi({
        description:
          "PayTR and iyzico both require an email address; the rest is optional " +
          "and improves the provider's own fraud scoring.",
      }),
    successUrl: httpUrl().optional(),
    cancelUrl: httpUrl().optional(),
    reference: z.string().max(48).optional().openapi({
      description:
        "Overrides the reference derived from `writeBack.itemId`. Non-alphanumeric " +
        "characters are stripped — PayTR's `merchant_oid` accepts nothing else.",
    }),
    customerIp: z.string().optional(),
    expiresInSec: z.number().int().positive().optional(),
    locale: z.string().max(10).optional(),
    writeBack: z
      .object({
        collection: z.string(),
        itemId: z.string(),
        urlField: z.string(),
        referenceField: z.string().optional(),
      })
      .optional()
      .openapi({
        description:
          "Store the link on the row that is asking to be paid. The fields must " +
          "already exist on the collection — a checkout is never opened against a " +
          "field that can't record it.",
      }),
  })
  .openapi("PaymentCheckoutInput");

const CheckoutResultSchema = z
  .object({
    data: z.object({
      provider: z.string(),
      providerId: z.string(),
      url: z.string(),
      externalId: z.string(),
      expiresAt: z.number().nullable(),
      reference: z.string(),
      writtenBack: z
        .object({
          collection: z.string(),
          itemId: z.string(),
          fields: z.array(z.string()),
        })
        .nullable(),
    }),
  })
  .openapi("PaymentCheckoutResult");

const RefundInputSchema = z
  .object({
    providerId: z.string().optional().openapi({
      description: "Connected provider row id. Takes precedence over `provider`.",
    }),
    provider: z.enum(PAYMENT_PROVIDERS).optional(),
    paymentRowId: z.string().optional().openapi({
      description: "The `payment_transactions` row to refund.",
    }),
    externalId: z.string().optional().openapi({
      description: "The provider's own id for the payment.",
    }),
    reference: z.string().optional().openapi({
      description:
        "The reference an outbound checkout travelled with. Refused when it matches " +
        "more than one payment — one invoice can be billed more than once.",
    }),
    amount: z.number().int().positive().optional().openapi({
      description:
        "MINOR units. Omitted refunds the whole remaining balance. Checked against " +
        "`amount - amount_refunded` on the ledger row before the provider is called.",
    }),
    reason: z.enum(REFUND_REASONS).optional(),
    description: z.string().max(200).optional(),
    idempotencyKey: z.string().max(255).optional().openapi({
      description:
        "Overrides the derived key. The default is derived from the payment and the " +
        "amount already refunded, so a retry is deduplicated while a genuine second " +
        "refund is not.",
    }),
  })
  .openapi("PaymentRefundInput");

const RefundResultSchema = z
  .object({
    data: z.object({
      provider: z.string(),
      providerId: z.string(),
      paymentRowId: z.string(),
      externalId: z.string(),
      refundId: z.string(),
      amount: z.number().int(),
      currency: z.string(),
      status: z.enum(["succeeded", "pending"]),
      full: z.boolean(),
      ledger: z
        .object({ amountRefunded: z.number().int(), status: z.string() })
        .nullable()
        .openapi({
          description:
            "What was written to `payment_transactions`, or null for providers that " +
            "file a refund as its own transaction (Adyen, Authorize.net) — there the " +
            "refund's own notification writes the row.",
        }),
      note: z.string().optional(),
    }),
  })
  .openapi("PaymentRefundResult");

const EventRow = z
  .object({
    id: z.string(),
    providerId: z.string(),
    externalId: z.string(),
    type: z.string(),
    status: z.string(),
    recordCount: z.number().int(),
    error: z.string().nullable(),
    createdAt: z.unknown().optional(),
    processedAt: z.unknown().optional(),
  })
  .openapi("PaymentEvent");

export const paymentsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/catalog",
      tags,
      summary: "Supported payment providers and their config fields",
      description:
        "Drives the connect dialog: the provider list, each provider's config " +
        "fields (with `secret` flags), and the collection slugs a sync writes into.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "Catalog",
          content: {
            "application/json": {
              schema: z.object({
                providers: z.array(
                  z.object({
                    provider: z.string(),
                    label: z.string(),
                    checkoutMode: z.enum(["adhoc", "catalog"]).nullable().openapi({
                      description:
                        "`adhoc` takes an amount and mints a one-off checkout; `catalog` " +
                        "needs a pre-existing price id and is not supported yet; `null` " +
                        "means the provider has no hosted checkout at all.",
                    }),
                    reconcilable: z.boolean().openapi({
                      description:
                        "Whether `POST /providers/{id}/sync` does anything at all. True " +
                        "for both sync shapes — see `syncMode`. False only for the " +
                        "providers that neither expose a catalog nor allow a single " +
                        "payment to be re-read (Adyen, PayTR, iyzico), where sync returns " +
                        "an explanation rather than pretending to have synced.",
                    }),
                    refundSupport: z
                      .enum(["full_and_partial", "full_only"])
                      .nullable()
                      .openapi({
                        description:
                          "How much of a payment this provider will give back. " +
                          "`full_only` is Paddle: a partial refund there adjusts individual " +
                          "transaction line items, which backlex does not store. `null` " +
                          "means the provider cannot refund at all.",
                      }),
                    syncMode: z.enum(["catalog", "refresh"]).nullable().openapi({
                      description:
                        "`catalog` walks the PROVIDER's own listing of customers, " +
                        "subscriptions, invoices and payments. `refresh` walks OURS: the " +
                        "provider has no listing, so the sweep re-reads the ids already in " +
                        "`payment_transactions` to pick up refunds, late captures and " +
                        "cancellations that were never pushed. `null` means no sync.",
                    }),
                    fields: z.array(
                      z.object({
                        key: z.string(),
                        label: z.string(),
                        placeholder: z.string().optional(),
                        secret: z.boolean().optional(),
                        optional: z.boolean().optional(),
                        choices: z.array(z.string()).optional(),
                        hint: z.string().optional(),
                      }),
                    ),
                  }),
                ),
                recordKinds: z.array(z.string()),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    (c) =>
      c.json({
        providers: PAYMENT_PROVIDERS.map((p) => ({
          provider: p,
          label: PAYMENT_PROVIDER_LABELS[p],
          checkoutMode: PAYMENT_CHECKOUT_MODES[p],
          refundSupport: PAYMENT_REFUND_SUPPORT[p],
          reconcilable: paymentSyncMode(p) !== null,
          syncMode: paymentSyncMode(p),
          fields: PAYMENT_PROVIDER_FIELDS[p],
        })),
        recordKinds: [...PAYMENT_RECORD_KINDS],
      }),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/providers",
      tags,
      summary: "List connected payment providers",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "Connected providers",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(ProviderRow),
                stats: z.record(z.string(), z.number()),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const [data, stats] = await Promise.all([
        listProviders(ctx, tenantId),
        paymentEventStats(ctx, tenantId),
      ]);
      return c.json({ data, stats });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/providers",
      tags,
      summary: "Connect (or reconfigure) a payment provider",
      description:
        "Idempotent per (workspace, provider). Also provisions the four sync " +
        "collections if they don't exist yet, so the first delivery has somewhere to land.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { content: { "application/json": { schema: ProviderInput } } },
      },
      responses: {
        200: {
          description: "Connected",
          content: {
            "application/json": {
              schema: z.object({
                data: ProviderRow,
                collections: z.object({
                  created: z.array(z.string()),
                  existing: z.array(z.string()),
                  conflicts: z.array(z.string()).openapi({
                    description:
                      "Slugs already taken by a collection that isn't a sync target — " +
                      "nothing is written to these until they're renamed.",
                  }),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const data = await connectProvider(ctx, tenantId, body, ctx.env.AUTH_SECRET);
      const collections = await ensurePaymentCollections(ctx, tenantId);
      await logActivity(c, {
        action: "payments.connect",
        collection: "system_payment_providers",
        itemId: data.id,
        payload: { provider: data.provider },
      });
      return c.json({ data, collections });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/providers/{id}/rotate-token",
      tags,
      summary: "Issue a fresh webhook receive URL",
      description:
        "Invalidates the previous URL immediately — paste the new one into the " +
        "provider dashboard or deliveries will start 404ing.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Rotated",
          content: { "application/json": { schema: z.object({ data: ProviderRow }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const data = await rotateWebhookToken(ctx, tenantId, id);
      await logActivity(c, {
        action: "payments.rotate_token",
        collection: "system_payment_providers",
        itemId: id,
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/providers/{id}/sync",
      tags,
      summary: "Reconcile against the provider API",
      description:
        "Pulls customers / subscriptions / invoices / payments back and upserts " +
        "them — closing the gap webhooks leave (missed deliveries, objects that " +
        "predate the connection). `async: true` queues it as a durable job instead " +
        "of running it inline.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z.object({
                kinds: z.array(z.enum(PAYMENT_RECORD_KINDS)).optional(),
                maxPages: z.number().int().min(1).max(100).optional(),
                resume: z.boolean().optional().openapi({
                  description: "Continue from the stored cursor instead of the top.",
                }),
                async: z.boolean().optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Reconcile result, or the queued job id",
          content: {
            "application/json": {
              schema: z.object({
                queued: z.boolean().optional(),
                jobId: z.string().optional(),
                provider: z.string().optional(),
                written: z.number().optional(),
                failed: z.number().optional(),
                cursors: z.record(z.string(), z.string().nullable()).optional(),
                error: z.string().optional(),
                refreshed: z
                  .object({ checked: z.number(), missing: z.number() })
                  .optional()
                  .openapi({
                    description:
                      "Present only when `syncMode` is `refresh`. `checked` is how many " +
                      "recorded payments were re-read from the provider this run — a " +
                      "healthy sweep re-reads unchanged payments, so `written` alone " +
                      "reads as though everything changed. `missing` counts ids the " +
                      "provider no longer knows about; those rows are left standing " +
                      "rather than blanked.",
                  }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const body = (c.req.valid("json") ?? {}) as {
        kinds?: (typeof PAYMENT_RECORD_KINDS)[number][];
        maxPages?: number;
        resume?: boolean;
        async?: boolean;
      };
      if (body.async) {
        const job = await enqueueJob(ctx, {
          type: "payments.reconcile",
          tenantId,
          payload: {
            providerId: id,
            kinds: body.kinds,
            maxPages: body.maxPages,
            resume: body.resume ?? true,
          },
        });
        return c.json({ queued: true, jobId: job.id });
      }
      const out = await reconcileProvider(ctx, tenantId, {
        providerId: id,
        kinds: body.kinds,
        maxPages: body.maxPages,
        resume: body.resume,
      });
      await logActivity(c, {
        action: "payments.sync",
        collection: "system_payment_providers",
        itemId: id,
        response: { written: out.written, failed: out.failed },
      });
      return c.json(out);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/providers/{id}",
      tags,
      summary: "Disconnect a payment provider",
      description:
        "Removes the connection and its delivery log. The synced collections and " +
        "their rows are left alone — that data is the workspace's, not the provider's.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Disconnected",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      await disconnectProvider(ctx, tenantId, id);
      await logActivity(c, {
        action: "payments.disconnect",
        collection: "system_payment_providers",
        itemId: id,
      });
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/collections",
      tags,
      summary: "Provision the four sync collections",
      description:
        "Idempotent. Runs automatically on connect; exposed separately so an " +
        "admin who dropped one can put it back.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "Provisioned",
          content: {
            "application/json": {
              schema: z.object({
                created: z.array(z.string()),
                existing: z.array(z.string()),
                conflicts: z.array(z.string()),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const out = await ensurePaymentCollections(ctx, tenantId);
      return c.json(out);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/checkout",
      tags,
      summary: "Open a hosted checkout and get a payment link",
      description:
        "The outbound half of payments: hand a connected provider an amount and " +
        "get back a URL to send the customer to. `writeBack` stores that URL on " +
        "the row that is asking to be paid, and the `reference` it travels with " +
        "comes back on the settlement event as `payment_transactions.reference`, " +
        "which is what ties the payment to the invoice. Amounts are MINOR units " +
        "(cents), matching the ledger.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { content: { "application/json": { schema: CheckoutInput } } },
      },
      responses: {
        200: {
          description: "Checkout opened",
          content: { "application/json": { schema: CheckoutResultSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const out = await createPaymentCheckout(ctx, tenantId, {
        ...body,
        // PayTR hashes the payer's IP. When an admin opens a link on a
        // customer's behalf the request IP is the best available answer, and
        // it beats refusing outright — but an explicit value always wins.
        customerIp: body.customerIp ?? requestMeta(c.req.raw, c.get("ctx").env).ip ?? undefined,
        // A preview or staging deploy must not send customers to production,
        // and its settlement callback has to come back to itself.
        baseUrl: new URL(c.req.url).origin,
      });
      await logActivity(c, {
        action: "payments.checkout",
        collection: "system_payment_providers",
        itemId: out.providerId,
        // Deliberately no URL and no customer details: this row is persisted
        // and readable by anyone with activity access, and the URL is a
        // bearer link to a payment page.
        payload: { provider: out.provider, amount: body.amount, currency: body.currency },
        response: { reference: out.reference, writtenBack: Boolean(out.writtenBack) },
      });
      return c.json({ data: out });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/refund",
      tags,
      summary: "Refund some or all of a payment",
      description:
        "The reverse of `/checkout`. Say which payment by `paymentRowId`, " +
        "`externalId` or the checkout `reference`; omit `amount` to give back " +
        "everything still refundable. The refundable remainder is checked against " +
        "`payment_transactions` BEFORE the provider is called, so a refund can " +
        "never take the total past what was charged. Amounts are MINOR units.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: { content: { "application/json": { schema: RefundInputSchema } } },
      },
      responses: {
        200: {
          description: "Refund accepted by the provider",
          content: { "application/json": { schema: RefundResultSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const out = await refundPayment(ctx, tenantId, {
        ...body,
        // iyzico records an IP against a refund. The admin raising it is the
        // best answer available, and it beats sending nothing.
        customerIp: requestMeta(c.req.raw, c.get("ctx").env).ip ?? undefined,
      });
      await logActivity(c, {
        action: "payments.refund",
        collection: "system_payment_providers",
        itemId: out.providerId,
        // Money moving is exactly the thing an audit reader needs to see, and
        // unlike a checkout URL none of this is a bearer credential.
        payload: {
          provider: out.provider,
          paymentRowId: out.paymentRowId,
          amount: out.amount,
          currency: out.currency,
        },
        response: { refundId: out.refundId, status: out.status, full: out.full },
      });
      return c.json({ data: out });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/events",
      tags,
      summary: "Recent webhook deliveries",
      security: SECURITY,
      middleware: adminGate,
      request: {
        query: z.object({
          providerId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: {
        200: {
          description: "Deliveries, newest first",
          content: {
            "application/json": { schema: z.object({ data: z.array(EventRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { providerId, limit } = c.req.valid("query");
      const data = await listPaymentEvents(ctx, tenantId, { providerId, limit });
      return c.json({ data });
    },
  );
