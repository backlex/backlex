import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, email, half, hint, image, int, money, moneyIn, ms, notes, num, parent, phone, rating, rel, relMany, sec, select, slugField, stacked, tabbed, tags, text, ts, userLink } from "../dsl";

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
      fields: [
        ...half(text("number", { unique: true }), rel("buyer", "buyers")),
        ...half(
          select("status", [ch("pending", C.amber), ch("paid", C.green), ch("shipped", C.blue), ch("delivered", C.teal), ch("refunded", C.red)], { default: "pending" }),
          ts("placed_at", { indexed: true, label: "Placed at" }),
        ),
        ...half(moneyIn("subtotal"), moneyIn("total")),
        select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
      ],
      samples: [{ number: "M-1001", buyer: { ref: "buyers:0" }, status: "paid", subtotal: 45, total: 45, currency: "USD", placed_at: ms("2026-06-18") }],
    },
    {
      slug: "order_items", group: "Orders", singular: "Order item", plural: "Order items",
      fields: [
        hint("mkt_line_total", "Line total is generated as qty × unit price."),
        ...half(rel("order", "orders"), rel("listing", "listings")),
        ...half(rel("vendor", "vendors"), int("qty", { default: 1, validation: { min: 1 } })),
        ...half(money("unit_price"), computedNum("line_total", "qty * unit_price", { label: "Line total" })),
      ],
      samples: [{ order: { ref: "orders:0" }, listing: { ref: "listings:0" }, vendor: { ref: "vendors:0" }, qty: 1, unit_price: 45 }],
    },
    {
      slug: "disputes", group: "Orders", singular: "Dispute", plural: "Disputes", defaultSort: "-opened_at",
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
          notes("resolution"),
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
};
