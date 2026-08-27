import type { SchemaTemplate } from "../types";
import { bool, C, ch, computedMoneyIn, date, email, half, hint, image, int, money, moneyIn, ms, notes, num, parent, phone, rating, rel, relMany, sec, select, seq, slugField, stacked, tabbed, tags, text, ts, userLink, when } from "../dsl";

export const marketplace: SchemaTemplate = {
  id: "marketplace",
  label: "Marketplace",
  groups: ["Catalog", "Vendors", "Orders", "Customers"],
  description:
    "Amazon/Etsy-grade multi-vendor marketplace: vendor applications & onboarding, vendors with commission, payouts and shipping options, category tree, listings, promotions, buyers, orders split into per-vendor line items, disputes and moderated reviews.",
  collections: [
    { slug: "media", group: "Catalog", singular: "Media", plural: "Media", fields: [image("file"), text("alt", { label: "Alt text" })] },
    {
      slug: "vendor_applications", group: "Vendors", singular: "Vendor application", plural: "Vendor applications", defaultSort: "-applied_at", displayTemplate: "{{business_name}}",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Applicant", [
          ...half(text("business_name", { required: true, label: "Business name" }), text("category")),
          ...half(text("contact_name", { label: "Contact name" }), email("contact_email", { label: "Contact email" })),
        ]),
        sec("Review", [
          ...half(
            select("status", [ch("submitted", C.blue), ch("reviewing", C.amber), ch("approved", C.green), ch("rejected", C.red)], { default: "submitted" }),
            ts("applied_at", { indexed: true, label: "Applied at" }),
          ),
          notes("notes"),
        ]),
      ),
      samples: [{ business_name: "Trailhead Supply", contact_name: "Mia Chen", contact_email: "mia@trailhead.example", category: "Outdoors", status: "reviewing", applied_at: ms("2026-06-20") }],
    },
    {
      slug: "vendors", group: "Vendors", singular: "Vendor", plural: "Vendors", defaultSort: "name",
      portalLink: { emailField: "email", role: "Vendor (portal)" },
      fields: tabbed(
        sec("Vendor", [
          ...half(text("name", { required: true }), slugField("name")),
          ...half(email("email", { unique: true }), image("logo")),
          notes("description"),
        ]),
        sec("Commercials", [
          ...half(
            select("status", [ch("pending", C.amber), ch("active", C.green), ch("suspended", C.red)], { default: "pending" }),
            num("commission_pct", { format: { style: "percent100" }, default: 10, validation: { min: 0, max: 100 }, label: "Commission (%)" }),
          ),
          ...half(num("rating", { validation: { min: 0, max: 5 }, label: "Rating" }), text("payout_account", { label: "Payout account" })),
        ]),
        sec("Access", [userLink()]),
      ),
      samples: [{ name: "Acme Goods", slug: "acme-goods", email: "sales@acme.example", status: "active", commission_pct: 12, rating: 4.7 }],
    },
    {
      slug: "shipping_options", group: "Vendors", singular: "Shipping option", plural: "Shipping options", defaultSort: "price",
      fields: [
        ...half(rel("vendor", "vendors"), text("name", { required: true })),
        ...half(
          select("kind", [ch("standard", C.blue), ch("express", C.purple), ch("pickup", C.teal)], { default: "standard" }),
          money("price"),
        ),
        int("eta_days", { validation: { min: 0 }, label: "ETA (days)" }),
      ],
      samples: [
        { vendor: { ref: "vendors:0" }, name: "Standard ground", kind: "standard", price: 5.99, eta_days: 5 },
        { vendor: { ref: "vendors:0" }, name: "Express 2-day", kind: "express", price: 14.99, eta_days: 2 },
      ],
    },
    {
      slug: "categories", group: "Catalog", singular: "Category", plural: "Categories", defaultSort: "name",
      fields: [...half(text("name", { required: true }), slugField("name")), parent("categories")],
      samples: [{ name: "Home", slug: "home" }, { name: "Outdoors", slug: "outdoors" }],
    },
    {
      slug: "promotions", group: "Catalog", singular: "Promotion", plural: "Promotions", defaultSort: "-starts_at",
      fields: stacked(
        sec("Promotion", [
          ...half(rel("vendor", "vendors"), text("name", { required: true })),
          ...half(
            select("kind", [ch("percent", C.blue), ch("amount", C.teal), ch("free_shipping", C.purple, "Free shipping")], { default: "percent" }),
            num("value", { validation: { min: 0 } }),
          ),
          text("code", { unique: true }),
        ]),
        sec("Window", [
          ...half(ts("starts_at", { range: { end: "ends_at" }, indexed: true, label: "Starts at" }), ts("ends_at", { indexed: true, label: "Ends at" })),
          select("status", [ch("scheduled", C.gray), ch("active", C.green), ch("expired", C.slate), ch("disabled", C.red)], { default: "scheduled" }),
        ]),
      ),
      samples: [{ vendor: { ref: "vendors:0" }, name: "Summer sale", kind: "percent", value: 15, code: "SUMMER15", starts_at: ms("2026-07-01"), ends_at: ms("2026-07-31"), status: "active" }],
    },
    {
      slug: "listings", group: "Catalog", singular: "Listing", plural: "Listings", versioned: true, vectorize: true, fts: true, defaultSort: "-created_at",
      fields: tabbed(
        sec("Listing", [
          ...half(text("title", { required: true, vectorize: true, searchable: true }), slugField("title")),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true },
          ...half(rel("vendor", "vendors"), rel("category", "categories")),
          ...half(text("sku", { label: "SKU" }), tags("tags")),
        ]),
        sec("Pricing", [
          ...half(moneyIn("price", { required: true }), moneyIn("compare_at_price", { label: "Compare-at price" })),
          ...half(
            select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
            select("condition", [ch("new", C.green), ch("used", C.amber), ch("refurbished", C.blue)], { default: "new" }),
          ),
          ...half(
            int("stock", { default: 0, validation: { min: 0 } }),
            select("status", [ch("draft", C.gray), ch("active", C.green), ch("paused", C.amber), ch("sold_out", C.red, "Sold out")], { default: "active" }),
          ),
        ]),
        sec("Media", [
          image("cover"),
          relMany("images", "media"),
          bool("featured", { default: false, label: "Featured" }),
        ]),
      ),
      samples: [{ title: "Camp Stove", slug: "camp-stove", description: "Compact gas stove.", vendor: { ref: "vendors:0" }, category: { ref: "categories:1" }, sku: "CAMP-STOVE-1", price: 45, currency: "USD", condition: "new", stock: 30, status: "active" }],
    },
    {
      slug: "buyers", group: "Customers", singular: "Buyer", plural: "Buyers", defaultSort: "name",
      portalLink: { emailField: "email", role: "Buyer (portal)" },
      fields: [...half(text("name", { required: true }), email("email", { unique: true })), ...half(phone("phone"), userLink())],
      samples: [{ name: "Sam Taylor", email: "sam@example.com" }],
    },
    {
      slug: "orders", group: "Orders", singular: "Order", plural: "Orders", defaultSort: "-placed_at",
      kanbanGroupBy: "status",
      fields: [
        ...half(seq("number", "M-{YYYY}-{#####}"), rel("buyer", "buyers")),
        ...half(
          select("status", [ch("pending", C.amber), ch("paid", C.green), ch("shipped", C.blue), ch("delivered", C.teal), ch("refunded", C.red)], { default: "pending" }),
          ts("placed_at", { indexed: true, label: "Placed at" }),
        ),
        ...half(moneyIn("subtotal"), moneyIn("total")),
        select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
      ],
      samples: [{ buyer: { ref: "buyers:0" }, status: "paid", subtotal: 45, total: 45, currency: "USD", placed_at: ms("2026-06-18") }],
    },
    {
      slug: "order_items", group: "Orders", singular: "Order item", plural: "Order items",
      fields: [
        hint("mkt_line_total", "Line total is generated as qty × unit price."),
        ...half(rel("order", "orders"), rel("listing", "listings")),
        ...half(rel("vendor", "vendors"), int("qty", { default: 1, validation: { min: 1 } })),
        ...half(moneyIn("unit_price"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
        computedMoneyIn("line_total", "qty * unit_price", { label: "Line total" }),
      ],
      samples: [{ order: { ref: "orders:0" }, listing: { ref: "listings:0" }, vendor: { ref: "vendors:0" }, qty: 1, unit_price: 45 }],
    },
    {
      slug: "disputes", group: "Orders", singular: "Dispute", plural: "Disputes", defaultSort: "-opened_at",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Dispute", [
          ...half(rel("order", "orders"), rel("order_item", "order_items", { label: "Line item" })),
          ...half(rel("buyer", "buyers"), rel("vendor", "vendors")),
        ]),
        sec("Resolution", [
          ...half(
            select("reason", [ch("not_received", C.amber, "Not received"), ch("not_as_described", C.blue, "Not as described"), ch("damaged", C.red), ch("refund_request", C.purple, "Refund request")], { default: "not_received" }),
            select("status", [ch("open", C.blue), ch("vendor_responded", C.amber, "Vendor responded"), ch("resolved_buyer", C.green, "Resolved for buyer"), ch("resolved_vendor", C.teal, "Resolved for vendor"), ch("escalated", C.red)], { default: "open" }),
          ),
          ts("opened_at", { indexed: true, label: "Opened at" }),
          notes("resolution", { conditions: [when("status", "_in", ["resolved_buyer", "resolved_vendor"], "required")] }),
        ]),
      ),
      samples: [{ order: { ref: "orders:0" }, order_item: { ref: "order_items:0" }, buyer: { ref: "buyers:0" }, vendor: { ref: "vendors:0" }, reason: "damaged", status: "open", opened_at: ms("2026-06-25T10:00:00Z") }],
    },
    {
      slug: "payouts", group: "Vendors", singular: "Payout", plural: "Payouts", defaultSort: "-period_end",
      fields: [
        ...half(rel("vendor", "vendors"), moneyIn("amount")),
        ...half(
          select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
          select("status", [ch("pending", C.amber), ch("paid", C.green), ch("failed", C.red)], { default: "pending" }),
        ),
        ...half(date("period_start", { range: { end: "period_end", bounds: "[]" }, label: "Period start" }), date("period_end", { indexed: true, label: "Period end" })),
      ],
      samples: [{ vendor: { ref: "vendors:0" }, amount: 39.6, currency: "USD", status: "pending", period_start: ms("2026-06-01"), period_end: ms("2026-06-30") }],
    },
    {
      slug: "reviews", group: "Customers", singular: "Review", plural: "Reviews", ownerScoped: true, defaultSort: "-created_at",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Review", [
          ...half(rel("listing", "listings"), rel("buyer", "buyers")),
          ...half(rating("rating"), text("title")),
          notes("body"),
        ]),
        sec("Moderation", [
          ...half(
            select("status", [ch("pending", C.amber), ch("approved", C.green), ch("rejected", C.red)], { default: "pending" }),
            bool("verified_purchase", { default: false, label: "Verified purchase" }),
          ),
        ]),
      ),
      samples: [{ listing: { ref: "listings:0" }, buyer: { ref: "buyers:0" }, rating: 5, title: "Great for trips", body: "Works great on trips.", verified_purchase: true, status: "approved" }],
    },
  ],
  roles: [
    {
      name: "Marketplace ops",
      description: "Run day-to-day operations: orders, disputes and payouts; read vendors, listings and buyers.",
      permissions: [
        { collection: "vendors", action: "read" },
        { collection: "listings", action: "read" },
        { collection: "buyers", action: "read" },
        { collection: "orders", action: "read" },
        { collection: "orders", action: "update" },
        { collection: "order_items", action: "read" },
        { collection: "shipping_options", action: "read" },
        { collection: "disputes", action: "read" },
        { collection: "disputes", action: "create" },
        { collection: "disputes", action: "update" },
        { collection: "payouts", action: "read" },
        { collection: "payouts", action: "create" },
        { collection: "payouts", action: "update" },
      ],
    },
    {
      name: "Catalog moderator",
      description: "Onboard vendors and moderate the catalog: applications, listings, promotions and reviews.",
      permissions: [
        { collection: "vendor_applications", action: "read" },
        { collection: "vendor_applications", action: "update" },
        { collection: "vendors", action: "read" },
        { collection: "vendors", action: "update" },
        { collection: "categories", action: "read" },
        { collection: "listings", action: "read" },
        { collection: "listings", action: "update" },
        { collection: "promotions", action: "read" },
        { collection: "promotions", action: "update" },
        { collection: "reviews", action: "read" },
        { collection: "reviews", action: "update" },
        { collection: "media", action: "read" },
      ],
    },
    {
      name: "Buyer (portal)",
      description: "Signed-in buyer self-service: browse the catalog, see own orders and disputes, open disputes and leave reviews.",
      permissions: [
        { collection: "categories", action: "read" },
        { collection: "listings", action: "read" },
        { collection: "buyers", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "orders", action: "read", condition: { "buyer.app_user_id": { _eq: "$user.id" } } },
        { collection: "order_items", action: "read", condition: { "order.buyer.app_user_id": { _eq: "$user.id" } } },
        { collection: "disputes", action: "read", condition: { "buyer.app_user_id": { _eq: "$user.id" } } },
        { collection: "disputes", action: "create" },
        { collection: "reviews", action: "read", condition: { "buyer.app_user_id": { _eq: "$user.id" } } },
        { collection: "reviews", action: "create" },
      ],
    },
    {
      name: "Vendor (portal)",
      description: "Signed-in vendor self-service: manage own listings, see own order lines, payouts and disputes — never other vendors' data.",
      permissions: [
        { collection: "categories", action: "read" },
        { collection: "vendors", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "listings", action: "read", condition: { "vendor.app_user_id": { _eq: "$user.id" } } },
        { collection: "listings", action: "update", condition: { "vendor.app_user_id": { _eq: "$user.id" } } },
        { collection: "order_items", action: "read", condition: { "vendor.app_user_id": { _eq: "$user.id" } } },
        { collection: "payouts", action: "read", condition: { "vendor.app_user_id": { _eq: "$user.id" } } },
        { collection: "disputes", action: "read", condition: { "vendor.app_user_id": { _eq: "$user.id" } } },
      ],
    },
  ],
  dashboards: [
    {
      name: "Marketplace overview",
      description: "GMV, order flow, vendor onboarding and trust & safety.",
      panels: [
        { name: "Vendors", kind: "items-aggregate", viz: "counter", config: { collection: "vendors", agg: "count" } },
        { name: "Listings", kind: "items-aggregate", viz: "counter", config: { collection: "listings", agg: "count" } },
        { name: "GMV", kind: "items-aggregate", viz: "counter", config: { collection: "orders", agg: "sum", field: "total" } },
        { name: "Orders by status", kind: "items-aggregate", viz: "donut", config: { collection: "orders", agg: "count", groupBy: "status" } },
        { name: "Listings by status", kind: "items-aggregate", viz: "bars", config: { collection: "listings", agg: "count", groupBy: "status" } },
        { name: "Disputes by status", kind: "items-aggregate", viz: "bars", config: { collection: "disputes", agg: "count", groupBy: "status" } },
        { name: "Reviews by status", kind: "items-aggregate", viz: "donut", config: { collection: "reviews", agg: "count", groupBy: "status" } },
        { name: "Applications by status", kind: "items-aggregate", viz: "donut", config: { collection: "vendor_applications", agg: "count", groupBy: "status" } },
      ],
    },
  ],
  /**
   * The rules a marketplace runs on, already running.
   *
   * Deliberately absent: "the period closed, so raise each vendor's payout".
   * What a vendor is owed is their commission on the ORDER ITEMS carrying their
   * id — a second collection — while `commission_pct` lives on the vendor and
   * the amounts live on the lines. A flow's `data` is one row and cannot join,
   * so a step that wrote an amount would be inventing one, and a payout that is
   * wrong reads as settled. The monthly run below hands each vendor's rate and
   * name to whoever can total the lines, and leaves the money to them.
   *
   * Nothing here uses a transition trigger, and that is a fact about this
   * template rather than a preference: no status field in the marketplace
   * declares a lifecycle, so `…:updated` plus a condition is the only shape
   * available. The one flow that uses it is written so a re-fire is a no-op.
   */
  flows: [
    {
      name: "Tell the catalog team when a vendor applies",
      trigger: "event:items:vendor_applications:created",
      operations: [
        {
          type: "notification",
          title: "Vendor application: {{ data.business_name }}",
          body: "{{ data.contact_name }} ({{ data.contact_email }}) sells in {{ data.category }}. Screen it before it reaches the catalog.",
          url: "/collections/vendor_applications",
        },
      ],
    },
    {
      name: "Take a listing off sale when its last unit goes",
      // An `…:updated` trigger with a condition, because `listings.status`
      // declares no lifecycle for a transition trigger to announce. That makes
      // re-firing the hazard, so the rule is written to be idempotent instead:
      // the condition only holds while the listing is still `active` with
      // nothing left, and the update below is what stops it holding. The write
      // raises another `updated` event, which then matches nothing.
      trigger: "event:items:listings:updated",
      operations: [
        {
          type: "condition",
          filter: { stock: { _eq: 0 }, status: { _eq: "active" } },
          then: [
            {
              type: "item.update",
              collection: "listings",
              id: "{{ data.id }}",
              data: { status: "sold_out" },
            },
            {
              type: "notification",
              title: "{{ data.title }} has sold out",
              body: "The last unit went and the listing is now marked sold out. Restock it or leave it — a buyer can no longer order it either way.",
              url: "/collections/listings",
            },
          ],
        },
      ],
    },
    {
      name: "Escalate a dispute the vendor has not answered in three days",
      // Fires once per dispute, three days after `opened_at`, at 09:00 — and
      // only for the ones still sitting at `open`. `_eq` rather than a list on
      // purpose: a dispute the vendor HAS answered is `vendor_responded` and
      // belongs to whoever is reading the answer, not to this rule.
      trigger: `schedule:${JSON.stringify({
        collection: "disputes",
        field: "opened_at",
        offset: { value: 3, unit: "days", direction: "after" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "open" } },
      })}`,
      operations: [
        {
          type: "item.update",
          collection: "disputes",
          id: "{{ data.id }}",
          data: { status: "escalated" },
        },
        {
          type: "notification",
          title: "Dispute escalated — no vendor response in three days",
          body: "Opened {{ data.opened_at }} for {{ data.reason }}. The response window has passed, so it is now yours to decide.",
          url: "/collections/disputes",
        },
      ],
    },
    {
      name: "Open the monthly payout run for every active vendor",
      trigger: "cron:0 6 1 * *",
      operations: [
        {
          // One notice per vendor rather than one summary, because the work is
          // per vendor: their share is their own order lines at their own rate.
          // Capped and alphabetical — switched on over a marketplace with a
          // thousand sellers, an uncapped sweep is a page nobody reads to the
          // bottom of, and the cap is visible in the last line of the body.
          type: "foreach",
          collection: "vendors",
          filter: { status: { _eq: "active" } },
          sort: "name",
          limit: 50,
          do: [
            {
              type: "notification",
              title: "Payout due: {{ $item.name }}",
              body: "Commission is {{ $item.commission_pct }}%. Total last month's order items filed under this vendor, take the commission off, and raise the payout against {{ $item.payout_account }}.",
              url: "/collections/payouts",
            },
          ],
        },
        {
          type: "notification",
          title: "Payout run opened",
          body: "Active vendors have each been listed for the period just closed — at most fifty per run, alphabetically. Raise the rest by hand if the marketplace has outgrown that.",
          url: "/collections/vendors",
        },
      ],
    },
    {
      name: "Email the buyer their order confirmation (needs email + a PDF renderer)",
      // Off until both are configured; the name carries the prerequisite so
      // nobody has to open it to find out. Sent on creation rather than on
      // payment because that is when a buyer expects it — the document prints
      // the order's own status, so a pending order says so on the page.
      active: false,
      trigger: "event:items:orders:created",
      operations: [
        { type: "document.render", templateKey: "marketplace_order_confirmation" },
        {
          type: "email",
          to: "{{ data.buyer.email }}",
          subject: "Your order {{ data.number }}",
          html: "<p>Thanks — your order is confirmed and attached.</p><p>Items may arrive separately: each one ships from the vendor who listed it.</p>",
          attach: ["{{ $last.key }}"],
        },
      ],
    },
    {
      name: "Monthly marketplace report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Marketplace overview",
          subject: "Marketplace — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "marketplace_order_confirmation",
      name: "Marketplace order confirmation",
      description: "The order as the buyer receives it, with who is shipping what.",
      filename: "order-{{ data.number }}",
      variables: ["number", "total", "currency"],
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
        "<h1>Order {{ data.number }}</h1>" +
        '<p class="muted">Placed {{ data.placed_at }} · {{ data.status }}</p>' +
        "<p><strong>{{ data.buyer.name }}</strong><br>{{ data.buyer.email }}</p>" +
        // "Sold by" is a column of its own because it is the thing a marketplace
        // receipt has to say that a shop's does not: one order, several sellers.
        '<table><thead><tr><th>Item</th><th>Sold by</th><th class="n">Qty</th>' +
        '<th class="n">Unit</th><th class="n">Line total</th></tr></thead><tbody>' +
        "<!-- one row per order item; fill from your own query or a foreach -->" +
        "</tbody></table>" +
        '<table class="totals">' +
        '<tr><td class="n">Subtotal</td><td class="n">{{ data.subtotal }}</td></tr>' +
        '<tr><td class="n"><strong>Total {{ data.currency }}</strong></td>' +
        '<td class="n"><strong>{{ data.total }}</strong></td></tr></table>' +
        '<p class="muted">Lines may arrive separately — each is fulfilled by the ' +
        "vendor who listed it, under their own shipping option. Quote the order " +
        "number above in any question about a single line, and open a dispute " +
        "against that line rather than the whole order.</p>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "vendor_payout_statement",
      name: "Vendor payout statement",
      description: "What a vendor was paid for one period, and on what basis.",
      filename: "payout-{{ data.period_end }}",
      variables: ["amount", "period_start", "period_end"],
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
        "<h1>Payout statement</h1>" +
        '<p class="muted">{{ data.period_start }} — {{ data.period_end }}</p>' +
        "<p><strong>{{ data.vendor.name }}</strong><br>{{ data.vendor.email }}</p>" +
        "<table>" +
        "<tr><th>Period</th><td>{{ data.period_start }} — {{ data.period_end }}</td></tr>" +
        "<tr><th>Commission rate</th><td>{{ data.vendor.commission_pct }}%</td></tr>" +
        "<tr><th>Payable</th><td>{{ data.amount }} {{ data.currency }}</td></tr>" +
        "<tr><th>Status</th><td>{{ data.status }}</td></tr>" +
        "<tr><th>Paid to</th><td>{{ data.vendor.payout_account }}</td></tr>" +
        "</table>" +
        '<p class="muted">The payable figure is this vendor\'s share of the order ' +
        "lines settled inside the period above, after the commission rate shown. " +
        "A statement marked pending has been worked out and not yet sent — the " +
        "date it leaves is the date the status changes.</p>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      // Lands as a `submitted` application, never as a vendor: the default on
      // `status` is what keeps an unscreened seller out of the catalog, so the
      // column is deliberately off the form. `notes` IS exposed, and it is the
      // reviewer's own notes column — which is exactly where whoever screens
      // this already looks, so an applicant's context arrives beside the
      // decision instead of in a mailbox.
      name: "Sell on the marketplace",
      collection: "vendor_applications",
      settings: {
        submitLabel: "Apply to sell",
        successMessage: "Thanks — we review new sellers within two business days.",
      },
      fields: [
        { name: "business_name", label: "Business name" },
        { name: "contact_name", label: "Your name" },
        { name: "contact_email", label: "Work email", help: "Where the onboarding steps will be sent." },
        { name: "category", label: "What do you sell?", help: "Roughly — outdoors, kitchen, tools." },
        { name: "notes", label: "Anything else we should know?", help: "Where you ship from, and what volume you expect per month." },
      ],
    },
    {
      // `status` is off the form on purpose: it defaults to `pending`, and that
      // default is the only thing keeping an unmoderated review off the listing
      // page. Which listing the review is about is a relation a public form
      // cannot set, and `verified_purchase` is a claim only the order data can
      // settle — the moderator attaches both on the pass they were making
      // anyway.
      name: "Rate a marketplace purchase",
      collection: "reviews",
      settings: {
        submitLabel: "Post review",
        successMessage: "Thank you — every review is read before it goes up.",
      },
      fields: [
        { name: "rating", label: "Rating", help: "1 to 5." },
        { name: "title", label: "Headline" },
        { name: "body", label: "Your review" },
      ],
    },
  ],
  agents: [
    {
      name: "Marketplace analyst",
      handle: "marketplace-analyst",
      description: "Answers questions about vendors, listings, orders and what is owed.",
      systemPrompt:
        "You help the team running a multi-vendor marketplace read its own " +
        "numbers. Answer using the workspace's data only. Five rules this " +
        "marketplace's schema makes necessary. One order belongs to a buyer but " +
        "is split across sellers: the order row carries what the BUYER paid, " +
        "and what each vendor sold is on the order items, which carry their own " +
        "vendor — never report a vendor's sales off the orders table. GMV is " +
        "the orders total; the marketplace's own revenue is commission, which " +
        "is `commission_pct` on the vendor applied to that vendor's lines and " +
        "is stored nowhere, so say plainly when you have worked a figure out " +
        "that way. Money carries its own currency and amounts in different " +
        "currencies are never added together. A listing being `active` says " +
        "nothing about whether anyone can buy it — `stock` does. Moderation " +
        "state is not decoration: only `approved` vendor applications and " +
        "`approved` reviews are public, and a `pending` payout is owed rather " +
        "than paid. When a figure appears on the Marketplace overview " +
        "dashboard, run that definition instead of adding rows up your own way, " +
        "so your answer matches the board. Name the vendor, listing or order " +
        "number you mean, be brief, and say plainly when the data does not " +
        "answer the question.",
      tools: [
        "collections.list",
        "collections.read",
        "collections.aggregate",
        "collections.search",
        "dashboards.run",
      ],
      maxSteps: 8,
    },
  ],
};
