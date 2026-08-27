import type { SchemaTemplate } from "../types";
import { bool, C, ch, computedMoneyIn, date, email, flag, flow, half, hint, int, money, moneyIn, ms, notes, num, pct, position, rel, sec, select, seq, slugField, stacked, text, ts, url, when } from "../dsl";

export const saas: SchemaTemplate = {
  id: "saas",
  label: "SaaS",
  groups: ["Accounts", "Catalog", "Billing", "Platform"],
  description:
    "Stripe-grade billing: accounts & members, products with prices and entitlement features, coupons and add-ons, subscriptions with items and cancellation reasons, invoices with line items, credit notes, payments with stored methods, refunds and dunning retries, metered usage, plus feature flags, webhooks and API keys.",
  collections: [
    {
      slug: "accounts", group: "Accounts", singular: "Account", plural: "Accounts", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), slugField("name")),
        ...half(
          email("billing_email", { label: "Billing email" }),
          select("status", [ch("active", C.green), ch("trialing", C.amber), ch("suspended", C.red)], { default: "trialing" }),
        ),
        ...half(
          select("currency", ["USD", "EUR", "GBP"], { default: "USD" }),
          select("tax_status", [ch("none", C.gray), ch("exempt", C.blue), ch("reverse", C.purple)], { default: "none", label: "Tax status" }),
        ),
      ],
      samples: [{ name: "Acme Inc", slug: "acme-inc", billing_email: "billing@acme.example", status: "active" }, { name: "Globex", slug: "globex", billing_email: "billing@globex.example", status: "trialing" }],
    },
    {
      slug: "account_members", group: "Accounts", singular: "Member", plural: "Members",
      fields: [
        rel("account", "accounts"),
        ...half(text("name"), email("email", { required: true })),
        ...half(
          select("role", [ch("owner", C.purple), ch("admin", C.blue), ch("member", C.gray), ch("billing", C.teal)], { default: "member" }),
          select("status", [ch("active", C.green), ch("invited", C.amber)], { default: "active" }),
        ),
      ],
      samples: [{ account: { ref: "accounts:0" }, email: "owner@acme.example", name: "Jordan Reed", role: "owner", status: "active" }],
    },
    {
      slug: "tax_rates", group: "Billing", singular: "Tax rate", plural: "Tax rates", defaultSort: "display_name", displayTemplate: "{{display_name}}",
      fields: [
        ...half(text("display_name", { required: true, label: "Display name" }), text("jurisdiction")),
        ...half(
          num("percentage", { validation: { min: 0, max: 100 }, label: "Rate (%)", format: { style: "percent100", precision: 2 } }),
          text("country", { label: "Country code" }),
        ),
        ...half(bool("inclusive", { default: false, label: "Prices include tax" }), flag("active")),
      ],
      samples: [
        { display_name: "US Sales Tax", jurisdiction: "CA", percentage: 8.5, country: "US", inclusive: false, active: true },
        { display_name: "UK VAT", jurisdiction: "GB", percentage: 20, country: "GB", inclusive: true, active: true },
      ],
    },
    {
      // Stored instrument (Stripe PaymentMethod) — never the raw PAN, just the
      // gateway token plus the display fragments a human needs.
      slug: "payment_methods", group: "Billing", singular: "Payment method", plural: "Payment methods",
      fields: [
        ...half(rel("account", "accounts"), select("type", [ch("card", C.blue), ch("bank_account", C.teal, "Bank account"), ch("sepa_debit", C.slate, "SEPA debit")], { default: "card" })),
        ...half(text("brand"), text("last4", { label: "Last 4" })),
        ...half(int("exp_month", { validation: { min: 1, max: 12 }, label: "Expiry month" }), int("exp_year", { label: "Expiry year" })),
        ...half(bool("is_default", { default: false, label: "Default method" }), text("gateway_token", { private: true, label: "Gateway token", description: "Stored for reconciliation; never returned by the API." })),
      ],
      samples: [{ account: { ref: "accounts:0" }, type: "card", brand: "Visa", last4: "4242", exp_month: 11, exp_year: 2029, is_default: true }],
    },
    {
      slug: "products", group: "Catalog", singular: "Product", plural: "Products", defaultSort: "name",
      fields: [
        text("name", { required: true }),
        notes("description"),
        ...half(flag("active", { label: "Active" }), text("unit_label", { label: "Unit label" })),
      ],
      samples: [{ name: "Pro Plan", description: "Everything in Starter, plus advanced features.", active: true }, { name: "API Usage", description: "Metered API calls.", active: true }],
    },
    {
      // What a plan actually unlocks (Stripe Entitlements) — the thing your app
      // checks at runtime, kept separate from what you charge for.
      slug: "features", group: "Catalog", singular: "Feature", plural: "Features", defaultSort: "key",
      fields: [
        ...half(text("key", { required: true, unique: true, description: "The identifier your app checks, e.g. sso." }), text("name", { required: true })),
        notes("description"),
      ],
      samples: [
        { key: "sso", name: "SAML single sign-on", description: "Log in through the customer's own identity provider." },
        { key: "api_calls", name: "Monthly API calls", description: "Metered ceiling on API requests." },
      ],
    },
    {
      slug: "prices", group: "Catalog", singular: "Price", plural: "Prices", defaultSort: "unit_amount",
      fields: stacked(
        sec("Price", [
          ...half(rel("product", "products"), text("nickname")),
          // NOT `moneyIn`, deliberately. A metered price is a RATE, and the
          // catalog's own sample is $0.002 per API call — three decimals a
          // dollar cannot express. Stripe splits the same way (`unit_amount`
          // vs `unit_amount_decimal`); a money column would have to round
          // sub-cent pricing away, so this stays a plain number and the
          // `currency` beside it says what the rate is quoted in.
          ...half(money("unit_amount", { required: true, label: "Unit amount" }), select("currency", ["USD", "EUR", "GBP"], { default: "USD" })),
        ]),
        sec("Recurrence", [
          ...half(
            select("type", [ch("recurring", C.blue), ch("one_time", C.gray, "One-time")], { default: "recurring" }),
            select("usage_type", [ch("licensed", C.green), ch("metered", C.amber)], { default: "licensed", label: "Usage type" }),
          ),
          ...half(
            select("interval", [ch("day", C.gray), ch("week", C.teal), ch("month", C.blue), ch("year", C.purple)], { default: "month", label: "Billing interval" }),
            int("interval_count", { default: 1, validation: { min: 1 }, label: "Interval count" }),
          ),
        ]),
      ),
      samples: [
        { product: { ref: "products:0" }, unit_amount: 49, currency: "USD", type: "recurring", interval: "month", usage_type: "licensed", nickname: "Pro monthly" },
        { product: { ref: "products:1" }, unit_amount: 0.002, currency: "USD", type: "recurring", interval: "month", usage_type: "metered", nickname: "Per API call" },
      ],
    },
    {
      slug: "plan_features", group: "Catalog", singular: "Plan feature", plural: "Plan features",
      note: "Which features a product grants, and up to what limit.",
      fields: [
        ...half(rel("product", "products"), rel("feature", "features")),
        ...half(
          bool("included", { default: true, label: "Included" }),
          num("limit_value", { label: "Limit", description: "Leave empty for unlimited." }),
        ),
      ],
      samples: [
        { product: { ref: "products:0" }, feature: { ref: "features:0" }, included: true },
        { product: { ref: "products:0" }, feature: { ref: "features:1" }, included: true, limit_value: 250000 },
      ],
    },
    {
      slug: "coupons", group: "Catalog", singular: "Coupon", plural: "Coupons", defaultSort: "code",
      fields: stacked(
        sec("Coupon", [
          ...half(
            text("code", { required: true, unique: true }),
            select("status", [ch("active", C.green), ch("archived", C.gray)], { default: "active" }),
          ),
          ...half(pct("percent_off", { label: "Percent off (%)" }), money("amount_off", { label: "Amount off" })),
        ]),
        sec("Redemption", [
          ...half(
            select("duration", [ch("once", C.gray), ch("repeating", C.blue), ch("forever", C.purple)], { default: "once" }),
            int("duration_in_months", { validation: { min: 1 }, label: "Duration (months)" }),
          ),
          ...half(
            int("max_redemptions", { validation: { min: 1 }, label: "Max redemptions" }),
            int("times_redeemed", { default: 0, validation: { min: 0 }, label: "Times redeemed" }),
          ),
        ]),
      ),
      samples: [
        { code: "LAUNCH20", percent_off: 20, duration: "repeating", duration_in_months: 3, max_redemptions: 100, times_redeemed: 12, status: "active" },
        { code: "FRIEND10", amount_off: 10, duration: "once", times_redeemed: 4, status: "active" },
      ],
    },
    {
      slug: "addons", group: "Catalog", singular: "Add-on", plural: "Add-ons", defaultSort: "name",
      fields: [
        text("name", { required: true }),
        notes("description"),
        ...half(money("price", { required: true }), select("billing", [ch("per_seat", C.blue, "Per seat"), ch("flat", C.teal)], { default: "flat" })),
        flag("active", { label: "Active" }),
      ],
      samples: [
        { name: "Extra seats", description: "Additional team seats beyond the plan allowance.", price: 9, billing: "per_seat", active: true },
        { name: "Priority support", description: "4-hour first-response SLA.", price: 99, billing: "flat", active: true },
      ],
    },
    {
      slug: "cancellation_reasons", group: "Billing", singular: "Cancellation reason", plural: "Cancellation reasons", defaultSort: "position",
      fields: [...half(text("name", { required: true }), position()), notes("description")],
      samples: [{ name: "Too expensive", position: 1 }, { name: "Missing features", position: 2 }, { name: "Switched to a competitor", position: 3 }],
    },
    {
      slug: "subscriptions", group: "Billing", singular: "Subscription", plural: "Subscriptions", defaultSort: "-current_period_end",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Subscription", [
          ...half(
            rel("account", "accounts"),
            select("status", [ch("trialing", C.amber), ch("active", C.green), ch("past_due", C.red, "Past due"), ch("canceled", C.gray), ch("unpaid", C.red), ch("incomplete", C.slate), ch("paused", C.blue)], { default: "trialing" }),
          ),
          ...half(
            select("collection_method", [ch("charge_automatically", C.green, "Charge automatically"), ch("send_invoice", C.blue, "Send invoice")], { default: "charge_automatically", label: "Collection method" }),
            rel("coupon", "coupons"),
          ),
        ]),
        sec("Billing period", [
          ...half(ts("current_period_start", { range: { end: "current_period_end" }, label: "Period start" }), ts("current_period_end", { indexed: true, label: "Period end" })),
          ...half(ts("trial_end", { label: "Trial ends" }), bool("cancel_at_period_end", { default: false, label: "Cancel at period end" })),
        ]),
        sec("Churn", [
          ...half(ts("canceled_at", { label: "Canceled at", conditions: [when("status", "_eq", "canceled", "required"), when("status", "_neq", "canceled", "hidden")] }), rel("cancellation_reason", "cancellation_reasons", { label: "Cancellation reason" })),
        ], { folded: true }),
      ),
      samples: [{ account: { ref: "accounts:0" }, status: "active", collection_method: "charge_automatically", coupon: { ref: "coupons:0" }, current_period_start: ms("2026-06-01"), current_period_end: ms("2026-07-01") }],
    },
    {
      slug: "subscription_items", group: "Billing", singular: "Subscription item", plural: "Subscription items",
      fields: [rel("subscription", "subscriptions"), ...half(rel("price", "prices"), int("quantity", { default: 1, validation: { min: 1 } }))],
      samples: [{ subscription: { ref: "subscriptions:0" }, price: { ref: "prices:0" }, quantity: 1 }],
    },
    {
      slug: "subscription_addons", group: "Billing", singular: "Subscription add-on", plural: "Subscription add-ons",
      fields: [rel("subscription", "subscriptions"), ...half(rel("addon", "addons"), int("quantity", { default: 1, validation: { min: 1 } }))],
      samples: [{ subscription: { ref: "subscriptions:0" }, addon: { ref: "addons:1" }, quantity: 1 }],
    },
    {
      slug: "invoices", group: "Billing", singular: "Invoice", plural: "Invoices", defaultSort: "-issued_at",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Invoice", [
          ...half(seq("number", "INV-{YYYY}-{####}"), select("status", [ch("draft", C.gray), ch("open", C.blue), ch("paid", C.green), ch("void", C.slate), ch("uncollectible", C.red)], {
            default: "draft",
            ...flow(
              { draft: ["open", "void"], open: ["paid", "void", "uncollectible"] },
              { initial: ["draft"], labels: { open: "Finalize", paid: "Mark paid", void: "Void", uncollectible: "Write off" } },
            ),
          })),
          ...half(rel("account", "accounts"), rel("subscription", "subscriptions")),
          select("billing_reason", [ch("subscription_create", C.blue, "Subscription created"), ch("subscription_cycle", C.teal, "Renewal"), ch("manual", C.gray)], { default: "subscription_cycle", label: "Billing reason" }),
        ]),
        sec("Amounts", [
          ...half(moneyIn("amount_due", { label: "Amount due" }), moneyIn("amount_paid", { label: "Amount paid" })),
          select("currency", ["USD", "EUR", "GBP"], { default: "USD" }),
        ]),
        sec("Period", [
          ...half(ts("issued_at", { indexed: true, label: "Issued at" }), date("due_date", { label: "Due date" })),
          ...half(ts("period_start", { range: { end: "period_end" }, label: "Period start" }), ts("period_end", { label: "Period end" })),
        ]),
      ),
      samples: [{ account: { ref: "accounts:0" }, subscription: { ref: "subscriptions:0" }, status: "paid", amount_due: 49, amount_paid: 49, currency: "USD", billing_reason: "subscription_cycle", issued_at: ms("2026-06-01") }],
    },
    {
      slug: "invoice_lines", group: "Billing", singular: "Invoice line", plural: "Invoice lines",
      // Ten storage columns since the amounts gained their denomination — past
      // the point a flat list reads as one glance.
      fields: stacked(
        sec("Line", [
          hint("invoice_lines_amount", "Amount is generated as quantity × unit amount — adjust the inputs, not the result."),
          ...half(rel("invoice", "invoices"), rel("price", "prices")),
          text("description"),
        ]),
        sec("Amounts", [
          ...half(num("quantity", { default: 1, validation: { min: 0 } }), moneyIn("unit_amount", { label: "Unit amount" })),
          ...half(select("currency", ["USD", "EUR", "GBP"], { default: "USD" }), rel("tax_rate", "tax_rates", { label: "Tax rate" })),
          computedMoneyIn("amount", "quantity * unit_amount"),
        ]),
        sec("Period", [
          ...half(ts("period_start", { range: { end: "period_end" }, label: "Period start" }), ts("period_end", { label: "Period end" })),
        ]),
      ),
      samples: [{ invoice: { ref: "invoices:0" }, price: { ref: "prices:0" }, description: "Pro Plan — monthly", quantity: 1, unit_amount: 49, period_start: ms("2026-06-01"), period_end: ms("2026-07-01") }],
    },
    {
      // Post-issue correction (Stripe CreditNote) — an issued invoice is
      // immutable, so a reduction is its own document.
      slug: "credit_notes", group: "Billing", singular: "Credit note", plural: "Credit notes", defaultSort: "-issued_at",
      fields: stacked(
        sec("Credit note", [
          ...half(seq("number", "CN-{YYYY}-{####}"), rel("invoice", "invoices")),
          ...half(moneyIn("amount", { required: true }), select("currency", ["USD", "EUR", "GBP"], { default: "USD" })),
        ]),
        sec("Reason", [
          ...half(
            select("reason", [ch("duplicate", C.gray), ch("fraudulent", C.red), ch("order_change", C.amber, "Order change"), ch("product_unsatisfactory", C.purple, "Unsatisfactory")], { default: "order_change" }),
            select("status", [ch("issued", C.green), ch("void", C.gray)], { default: "issued" }),
          ),
          ...half(ts("issued_at", { indexed: true, label: "Issued at" }), notes("note")),
        ]),
      ),
      samples: [{ invoice: { ref: "invoices:0" }, amount: 10, currency: "USD", reason: "order_change", status: "issued", issued_at: ms("2026-06-05") }],
    },
    {
      slug: "payments", group: "Billing", singular: "Payment", plural: "Payments", defaultSort: "-created_at",
      fields: [
        ...half(rel("account", "accounts"), rel("invoice", "invoices")),
        ...half(moneyIn("amount"), select("currency", ["USD", "EUR", "GBP"], { default: "USD" })),
        ...half(
          select("status", [ch("succeeded", C.green), ch("pending", C.amber), ch("failed", C.red)], { default: "succeeded" }),
          select("payment_method", [ch("card", C.blue), ch("bank_transfer", C.teal, "Bank transfer"), ch("ach_debit", C.slate, "ACH debit")], { default: "card", label: "Payment method" }),
        ),
        ...half(rel("method", "payment_methods", { label: "Stored method" }), text("failure_reason", { label: "Failure reason", conditions: [when("status", "_eq", "failed", "required"), when("status", "_neq", "failed", "hidden")] })),
      ],
      samples: [{ account: { ref: "accounts:0" }, invoice: { ref: "invoices:0" }, amount: 49, currency: "USD", status: "succeeded", payment_method: "card", method: { ref: "payment_methods:0" } }],
    },
    {
      slug: "refunds", group: "Billing", singular: "Refund", plural: "Refunds", defaultSort: "-created_at",
      fields: [
        ...half(rel("payment", "payments"), moneyIn("amount", { required: true })),
        select("currency", ["USD", "EUR", "GBP"], { default: "USD" }),
        ...half(
          select("status", [ch("pending", C.amber), ch("succeeded", C.green), ch("failed", C.red)], { default: "pending" }),
          select("reason", [ch("duplicate", C.gray), ch("fraudulent", C.red), ch("requested_by_customer", C.blue, "Requested by customer")], { default: "requested_by_customer" }),
        ),
        ...half(ts("processed_at", { indexed: true, label: "Processed at" }), notes("note")),
      ],
      samples: [{ payment: { ref: "payments:0" }, amount: 10, status: "succeeded", reason: "requested_by_customer", processed_at: ms("2026-06-05") }],
    },
    {
      slug: "dunning_attempts", group: "Billing", singular: "Dunning attempt", plural: "Dunning attempts", defaultSort: "-next_retry_at",
      fields: [
        ...half(rel("invoice", "invoices"), int("attempt_number", { default: 1, validation: { min: 1 }, label: "Attempt #" })),
        ...half(
          select("status", [ch("scheduled", C.blue), ch("succeeded", C.green), ch("failed", C.red), ch("exhausted", C.gray)], { default: "scheduled" }),
          ts("next_retry_at", { indexed: true, label: "Next retry at" }),
        ),
        text("failure_message", { label: "Failure message" }),
      ],
      samples: [
        { invoice: { ref: "invoices:0" }, attempt_number: 1, status: "failed", next_retry_at: ms("2026-06-03T08:00:00Z"), failure_message: "card_declined" },
        { invoice: { ref: "invoices:0" }, attempt_number: 2, status: "succeeded", next_retry_at: ms("2026-06-06T08:00:00Z") },
      ],
    },
    {
      slug: "usage_records", group: "Billing", singular: "Usage", plural: "Usage", defaultSort: "-recorded_at",
      fields: [
        rel("subscription_item", "subscription_items"),
        ...half(text("metric"), num("quantity", { validation: { min: 0 } })),
        ...half(select("action", [ch("increment", C.blue), ch("set", C.purple)], { default: "increment" }), ts("recorded_at", { indexed: true, label: "Recorded at" })),
      ],
      samples: [{ subscription_item: { ref: "subscription_items:0" }, metric: "api_calls", quantity: 1240, action: "increment", recorded_at: ms("2026-06-20") }],
    },
    {
      slug: "feature_flags", group: "Platform", singular: "Feature flag", plural: "Feature flags", defaultSort: "key",
      fields: [
        ...half(text("key", { unique: true }), bool("enabled", { default: false })),
        pct("rollout_percentage", { default: 0, label: "Rollout (%)" }),
        notes("description"),
      ],
      samples: [{ key: "new_dashboard", enabled: true, rollout_percentage: 100, description: "Roll out the redesigned dashboard." }],
    },
    {
      slug: "webhooks", group: "Platform", singular: "Webhook", plural: "Webhooks",
      fields: [
        rel("account", "accounts"),
        url("url", { required: true }),
        ...half(text("secret", { private: true, label: "Signing secret" }), flag("active")),
      ],
      samples: [{ account: { ref: "accounts:0" }, url: "https://acme.example/hooks/backlex", active: true }],
    },
    {
      slug: "api_keys", group: "Platform", singular: "API key", plural: "API keys", defaultSort: "-last_used_at",
      fields: [
        ...half(rel("account", "accounts"), text("name", { required: true })),
        ...half(
          text("prefix", { unique: true, label: "Key prefix" }),
          select("status", [ch("active", C.green), ch("revoked", C.red)], { default: "active" }),
        ),
        ...half(ts("last_used_at", { indexed: true, label: "Last used at" }), ts("expires_at", { label: "Expires at" })),
      ],
      samples: [
        { account: { ref: "accounts:0" }, name: "Production", prefix: "blx_live_9f2a", status: "active", last_used_at: ms("2026-07-01T12:30:00Z") },
        { account: { ref: "accounts:1" }, name: "Staging", prefix: "blx_test_4c1d", status: "revoked", last_used_at: ms("2026-05-11T09:00:00Z") },
      ],
    },
  ],
  roles: [
    {
      name: "Billing admin",
      description: "Run day-to-day billing: subscriptions, invoices, payments, coupons and dunning; read accounts and the catalog.",
      permissions: [
        { collection: "accounts", action: "read" },
        { collection: "account_members", action: "read" },
        { collection: "products", action: "read" },
        { collection: "prices", action: "read" },
        { collection: "coupons", action: "read" },
        { collection: "coupons", action: "create" },
        { collection: "coupons", action: "update" },
        { collection: "addons", action: "read" },
        { collection: "cancellation_reasons", action: "read" },
        { collection: "subscriptions", action: "read" },
        { collection: "subscriptions", action: "update" },
        { collection: "subscription_items", action: "read" },
        { collection: "subscription_items", action: "update" },
        { collection: "subscription_addons", action: "read" },
        { collection: "subscription_addons", action: "update" },
        { collection: "invoices", action: "read" },
        { collection: "invoices", action: "create" },
        { collection: "invoices", action: "update" },
        { collection: "invoice_lines", action: "read" },
        { collection: "invoice_lines", action: "create" },
        { collection: "invoice_lines", action: "update" },
        { collection: "credit_notes", action: "read" },
        { collection: "credit_notes", action: "create" },
        { collection: "payments", action: "read" },
        { collection: "payments", action: "create" },
        { collection: "payment_methods", action: "read" },
        { collection: "refunds", action: "read" },
        { collection: "refunds", action: "create" },
        { collection: "tax_rates", action: "read" },
        { collection: "dunning_attempts", action: "read" },
        { collection: "dunning_attempts", action: "update" },
        { collection: "usage_records", action: "read" },
      ],
    },
  ],
  dashboards: [
    {
      name: "SaaS billing overview",
      description: "Accounts, subscription health and collections.",
      panels: [
        { name: "Accounts", kind: "items-aggregate", viz: "counter", config: { collection: "accounts", agg: "count" } },
        { name: "Subscriptions", kind: "items-aggregate", viz: "counter", config: { collection: "subscriptions", agg: "count" } },
        { name: "Collected", kind: "items-aggregate", viz: "counter", config: { collection: "payments", agg: "sum", field: "amount" } },
        { name: "Refunded", kind: "items-aggregate", viz: "counter", config: { collection: "refunds", agg: "sum", field: "amount" } },
        { name: "Subscriptions by status", kind: "items-aggregate", viz: "donut", config: { collection: "subscriptions", agg: "count", groupBy: "status" } },
        { name: "Invoices by status", kind: "items-aggregate", viz: "donut", config: { collection: "invoices", agg: "count", groupBy: "status" } },
        { name: "Payments by method", kind: "items-aggregate", viz: "bars", config: { collection: "payments", agg: "count", groupBy: "payment_method" } },
        { name: "Dunning by status", kind: "items-aggregate", viz: "bars", config: { collection: "dunning_attempts", agg: "count", groupBy: "status" } },
      ],
    },
  ],
  /**
   * The rules a subscription-billing operation runs on, already running.
   *
   * Two things are deliberately absent, both for the same reason — a flow's
   * `data` is ONE row and it cannot join:
   *
   * - **"a payment failed, so put the subscription into past_due".** A payment
   *   carries `account` and `invoice`; which SUBSCRIPTION the money was for is
   *   on the invoice, one hop away. A step that guessed would move the wrong
   *   subscription on any account holding two, so the flow opens the dunning
   *   attempt it CAN address (the payment knows its invoice) and reports the
   *   rest.
   * - **"the period rolled over, so raise the next invoice".** An invoice's
   *   lines come from `subscription_items` × `prices` — two collections the
   *   triggering row cannot reach — so a flow could only ever produce an empty
   *   invoice with a confident number on it.
   */
  flows: [
    {
      name: "Warn three days before a trial converts",
      // Fires once per subscription, three days before `trial_end`, at 09:00,
      // and only for the ones still trialing. The account's NAME is not on the
      // subscription row, so the notice names what the row itself knows — how
      // it will be collected — and links to the list rather than inventing a
      // label for a company it cannot read.
      trigger: `schedule:${JSON.stringify({
        collection: "subscriptions",
        field: "trial_end",
        offset: { value: 3, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "trialing" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "A trial ends in three days",
          body: "Collection is set to {{ data.collection_method }}. Check a payment method is on file before it converts — a trial that ends without one lands in dunning on day one.",
          url: "/collections/subscriptions",
        },
      ],
    },
    {
      name: "Open a dunning retry when a payment fails",
      // `…:created` rather than `…:updated` + a condition, and that is the
      // careful choice here: `payments.status` declares no lifecycle, so there
      // is no transition trigger to use, and an update trigger cannot tell
      // "just failed" from "was saved again while failed" — it would append
      // another retry every time somebody typed into the failure reason.
      trigger: "event:items:payments:created",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "failed" } },
          then: [
            {
              // `attempt_number` is deliberately NOT written: the right value is
              // "one more than the attempts already logged against this
              // invoice", which is a count across sibling rows a flow cannot
              // read. Left off, the column's own default stands and an operator
              // renumbers a ladder that was already running.
              type: "item.create",
              collection: "dunning_attempts",
              data: {
                invoice: "{{ data.invoice }}",
                status: "scheduled",
                failure_message: "{{ data.failure_reason }}",
              },
            },
            {
              type: "notification",
              title: "A payment failed",
              body: "{{ data.failure_reason }} — a retry is scheduled against the invoice. The subscription's own status is not touched; open the invoice to see which one is affected.",
              url: "/collections/dunning_attempts",
            },
          ],
        },
      ],
    },
    {
      name: "Sweep invoices that are open past their due date",
      trigger: "cron:0 7 * * *",
      operations: [
        {
          type: "foreach",
          collection: "invoices",
          filter: { status: { _eq: "open" }, due_date: { _lt: "$now" } },
          // Oldest debt first, and capped — an uncollectible-heavy year would
          // otherwise post a morning digest nobody reads to the bottom of.
          sort: "due_date",
          limit: 25,
          do: [
            {
              // Reported, not moved. The invoice lifecycle offers no "overdue"
              // value — the only state past `open` that says nobody paid is
              // `uncollectible`, and writing a debt off is a decision a person
              // makes, not one a nightly sweep makes for them.
              type: "notification",
              title: "Past due: invoice {{ $item.number }}",
              body: "Still open after its due date, {{ $item.amount_due }} {{ $item.currency }} due. Chase it, or write it off as uncollectible.",
              url: "/collections/invoices",
            },
          ],
        },
      ],
    },
    {
      name: "Warn a week before an API key expires",
      // The failure this prevents is the one nobody sees coming: a key with an
      // expiry set months ago stops authenticating at midnight and the
      // customer's integration goes dark. Only `active` keys are worth a
      // notice — a revoked one expiring is already over.
      trigger: `schedule:${JSON.stringify({
        collection: "api_keys",
        field: "expires_at",
        offset: { value: 7, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "active" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "API key {{ data.prefix }} expires in seven days",
          body: "Issue the replacement and let the customer cut over before this one stops authenticating.",
          url: "/collections/api_keys",
        },
      ],
    },
    {
      name: "Email the invoice when it is finalized (needs email + a PDF renderer)",
      // Off until both are configured — the name carries the prerequisite so
      // nobody has to open it to find out why nothing arrived.
      active: false,
      // A TRANSITION trigger rather than `…:updated` plus a condition on the
      // status: a flow sees the row as it now stands with no before-image, so
      // an update trigger cannot tell "just became open" from "was saved again
      // while open" — and this one MAILS a customer. `invoices.status` declares
      // its lifecycle (draft → open is the Finalize edge), so the move
      // announces itself, once.
      trigger: "event:items:invoices:transition:status:*:open",
      operations: [
        { type: "document.render", templateKey: "subscription_invoice" },
        {
          type: "email",
          to: "{{ data.account.billing_email }}",
          subject: "Invoice {{ data.number }}",
          html: "<p>Your invoice is attached.</p>",
          attach: ["{{ $last.key }}"],
        },
      ],
    },
    {
      name: "Monthly recurring-revenue report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:SaaS billing overview",
          subject: "Subscriptions and collections — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "subscription_invoice",
      name: "Subscription invoice",
      description: "The invoice as the account receives it, with the period it covers.",
      filename: "subscription-invoice-{{ data.number }}",
      variables: ["number", "amount_due", "currency"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:22px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:18px}" +
        "th,td{text-align:left;padding:7px 6px;border-bottom:1px solid #e5e5e5}" +
        "td.n,th.n{text-align:right}" +
        ".totals{margin-top:14px;width:100%}" +
        ".totals td{border:0;padding:3px 6px}" +
        "</style></head><body>" +
        "<h1>Invoice {{ data.number }}</h1>" +
        '<p class="muted">Issued {{ data.issued_at }} · Due {{ data.due_date }}</p>' +
        '<p class="muted">Billing period {{ data.period_start }} — {{ data.period_end }} ' +
        "· {{ data.billing_reason }}</p>" +
        "<p><strong>{{ data.account.name }}</strong><br>{{ data.account.billing_email }}</p>" +
        '<table><thead><tr><th>Description</th><th class="n">Qty</th>' +
        '<th class="n">Unit</th><th class="n">Amount</th></tr></thead><tbody>' +
        "<!-- one row per invoice line; fill from your own query or a foreach -->" +
        "</tbody></table>" +
        '<table class="totals">' +
        '<tr><td class="n"><strong>Amount due {{ data.currency }}</strong></td>' +
        '<td class="n"><strong>{{ data.amount_due }}</strong></td></tr>' +
        '<tr><td class="n">Paid</td><td class="n">{{ data.amount_paid }}</td></tr></table>' +
        '<p class="muted">Charged automatically to the stored payment method unless ' +
        "this account is billed by invoice. Tax is applied per line at the rate " +
        "recorded against it.</p>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "credit_note",
      name: "Credit note",
      description: "A correction against an issued invoice, which cannot itself be edited.",
      filename: "credit-note-{{ data.number }}",
      variables: ["number", "amount", "currency"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:16px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5}" +
        "th{width:34%;color:#555;font-weight:600}" +
        "</style></head><body>" +
        "<h1>Credit note {{ data.number }}</h1>" +
        '<p class="muted">Issued {{ data.issued_at }} · {{ data.status }}</p>' +
        "<table>" +
        "<tr><th>Against invoice</th><td>{{ data.invoice.number }}</td></tr>" +
        "<tr><th>Account</th><td>{{ data.invoice.account.name }}</td></tr>" +
        "<tr><th>Reason</th><td>{{ data.reason }}</td></tr>" +
        "<tr><th>Amount</th><td>{{ data.amount }} {{ data.currency }}</td></tr>" +
        "</table>" +
        "<p>{{ data.note }}</p>" +
        '<p class="muted">An issued invoice is immutable, so this document — not an ' +
        "edit — is the record of the reduction. Apply it against the next invoice " +
        "or refund it against the original payment.</p>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      name: "New billing account details",
      collection: "accounts",
      settings: {
        submitLabel: "Send billing details",
        successMessage: "Thank you — your account is set up and your first invoice will follow.",
      },
      fields: [
        // `name` is exposed because the schema requires it — a required field
        // left off the form makes the whole apply fail. `slug` is left off
        // deliberately: it is folded from the name on write, and asking an
        // outsider for a URL handle invites two accounts fighting over one.
        { name: "name", label: "Company or organisation" },
        { name: "billing_email", label: "Billing email", help: "Where invoices and receipts are sent." },
        { name: "currency", label: "Billing currency", help: "Every invoice on this account is denominated in it." },
        { name: "tax_status", label: "Tax treatment", help: "Choose reverse charge only if you are VAT-registered in another EU state." },
      ],
    },
    {
      // Lands unattached on purpose, and the team attaches it: `account` is a
      // relation, which no public form may expose — an anonymous submitter
      // choosing which account a billing contact joins is the whole of the
      // problem. So this is a link sent TO one customer, and the row it
      // produces is claimed once.
      name: "Billing contact details",
      collection: "account_members",
      settings: {
        submitLabel: "Send contact",
        successMessage: "Received — we'll add this contact to your account's billing notices.",
      },
      fields: [
        { name: "name", label: "Full name" },
        { name: "email", label: "Email", help: "Invoices and dunning notices go here." },
        { name: "role", label: "Role on the account", help: "Pick “billing” for someone who only handles invoices." },
      ],
    },
  ],
  agents: [
    {
      name: "Subscription analyst",
      handle: "subscription-analyst",
      description: "Answers questions about recurring revenue, churn and what is not being collected.",
      systemPrompt:
        "You help a SaaS billing team read its own book. Answer questions about " +
        "accounts, subscriptions, invoices, payments, refunds, dunning and " +
        "metered usage from the workspace's own data. A subscription is earning " +
        "while its status is trialing, active or past_due; canceled, unpaid and " +
        "incomplete ones are not, and past_due means the money is late rather " +
        "than gone. Read collection from invoices — amount_due against " +
        "amount_paid — never from a subscription's price, because coupons, " +
        "add-ons and credit notes all land on the invoice. Amounts are " +
        "denominated by each row's own currency, so never add two currencies " +
        "together; give a figure per currency. Metered usage lives in " +
        "usage_records against a subscription item, so a usage question is " +
        "always about an item, not an account. When a figure has a seeded KPI — " +
        "invoiced amount, collected amount, active subscriptions, cancelled " +
        "subscriptions, failed dunning attempts — run that definition instead of " +
        "adding rows up your own way, so your answer matches the dashboard. Be " +
        "brief, name the account or invoice number you mean, and say plainly " +
        "when the data does not answer the question.",
      tools: [
        "collections.list",
        "collections.read",
        "collections.aggregate",
        "collections.search",
        "kpis.run",
        "dashboards.run",
      ],
      maxSteps: 8,
    },
  ],
};
