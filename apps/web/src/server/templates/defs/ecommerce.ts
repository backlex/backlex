import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, email, flag, flow, geo, half, hint, image, int, money, moneyIn, ms, notes, num, parent, pct, phone, position, rating, rel, relMany, sec, select, seq, slugField, stacked, tabbed, tags, text, ts, url, userLink, when } from "../dsl";

export const ecommerce: SchemaTemplate = {
  id: "ecommerce",
  label: "E-commerce",
  groups: ["Catalog", "Orders", "Customers", "Inventory", "Marketing", "Storefront", "Shipping & tax"],
  description:
    "Shopify-grade storefront: products with options & variants and subscribe-and-save selling plans, multi-location inventory, customer groups, discounts, carts, orders with separate payment & fulfillment status, transactions, refunds, returns, fulfillments, shipping zones & rates, tax rates, reviews, gift cards, plus the storefront surface itself — content pages, navigation menus and URL redirects.",
  collections: [
    {
      slug: "media", group: "Catalog", singular: "Media", plural: "Media",
      fields: [image("file"), ...half(text("alt", { label: "Alt text" }), position())],
    },
    {
      slug: "brands", group: "Catalog", singular: "Brand", plural: "Brands", defaultSort: "name",
      fields: [...half(text("name", { required: true }), slugField("name")), ...half(image("logo"), url("website"))],
      samples: [{ name: "Northwind", slug: "northwind" }, { name: "Acme", slug: "acme" }],
    },
    {
      // Hierarchical navigation tree (Saleor / BigCommerce category model).
      slug: "categories", group: "Catalog", singular: "Category", plural: "Categories", defaultSort: "position",
      fields: [
        ...half(text("name", { required: true }), slugField("name")),
        notes("description"),
        ...half(parent("categories"), image("image")),
        ...half(position("parent"), flag("visible", { label: "Visible" })),
      ],
      samples: [
        { name: "Apparel", slug: "apparel", position: 1 },
        { name: "Accessories", slug: "accessories", position: 2 },
      ],
    },
    {
      // Merchandising grouping (Shopify manual/smart collection model).
      slug: "collections", group: "Catalog", singular: "Collection", plural: "Collections", defaultSort: "position",
      fields: stacked(
        sec("Collection", [
          ...half(text("title", { required: true }), slugField("title")),
          notes("description"),
          image("image"),
        ]),
        sec("Merchandising", [
          ...half(
            select("collection_type", [ch("manual", C.blue), ch("smart", C.purple)], { default: "manual", label: "Type" }),
            select("sort_order", ["manual", "best_selling", "alpha_asc", "alpha_desc", "price_asc", "price_desc", "created_desc"], { default: "manual", label: "Sort order" }),
          ),
          ...half(position(), flag("published", { label: "Published" })),
        ]),
      ),
      samples: [{ title: "Summer Sale", slug: "summer-sale", collection_type: "manual", position: 1, published: true }],
    },
    {
      // Storefront content page (Shopify Storefront `page`). A store needs
      // About / Shipping policy / FAQ without pulling in the whole blog model.
      slug: "pages", group: "Storefront", singular: "Page", plural: "Pages", versioned: true, fts: true, defaultSort: "title",
      fields: stacked(
        sec("Content", [
          ...half(text("title", { required: true, searchable: true }), slugField("title")),
          { name: "body", type: "longtext", interface: "richtext", searchable: true },
        ]),
        sec("SEO", [
          text("seo_title", { label: "SEO title" }),
          notes("seo_description", { label: "SEO description" }),
          flag("visible"),
        ], { folded: true }),
      ),
      samples: [
        { title: "Shipping & returns", slug: "shipping-returns", body: "Orders ship within two business days.", visible: true },
        { title: "About us", slug: "about-us", body: "We have been making things since 2019.", visible: true },
      ],
    },
    {
      // Storefront navigation (Shopify Storefront `menu`). Nav is authored
      // content, not a projection of the category tree — a header menu routinely
      // mixes categories, collections, pages and external links.
      slug: "menus", group: "Storefront", singular: "Menu", plural: "Menus", defaultSort: "handle",
      fields: [
        ...half(text("title", { required: true }), text("handle", { unique: true, required: true, description: "Referenced by the storefront, e.g. main-menu or footer." })),
      ],
      samples: [{ title: "Main menu", handle: "main-menu" }, { title: "Footer", handle: "footer" }],
    },
    {
      slug: "menu_items", group: "Storefront", singular: "Menu item", plural: "Menu items", defaultSort: "position",
      fields: stacked(
        sec("Item", [
          ...half(rel("menu", "menus", { required: true }), text("title", { required: true })),
          ...half(rel("parent", "menu_items", { label: "Nested under" }), position("menu")),
        ]),
        sec("Target", [
          hint("menu_items_target", "Point at one of the links below — whichever is set wins, in the order shown."),
          ...half(rel("category", "categories"), rel("collection", "collections")),
          ...half(rel("page", "pages"), url("external_url", { label: "External URL" })),
        ]),
      ),
      samples: [
        { menu: { ref: "menus:0" }, title: "Apparel", category: { ref: "categories:0" }, position: 1 },
        { menu: { ref: "menus:0" }, title: "Summer Sale", collection: { ref: "collections:0" }, position: 2 },
        { menu: { ref: "menus:1" }, title: "Shipping & returns", page: { ref: "pages:0" }, position: 1 },
      ],
    },
    {
      // Shopify `urlRedirects` / BigCommerce `route` — the thing that keeps SEO
      // alive when a product handle or category path changes.
      slug: "redirects", group: "Storefront", singular: "Redirect", plural: "Redirects", defaultSort: "from_path",
      fields: [
        ...half(
          text("from_path", { required: true, unique: true, label: "From path", description: "Path only, e.g. /products/old-handle." }),
          text("to_path", { required: true, label: "To path or URL" }),
        ),
        ...half(bool("permanent", { default: true, label: "Permanent (301)" }), flag("active")),
      ],
      samples: [
        { from_path: "/products/tee", to_path: "/products/classic-tee", permanent: true, active: true },
        { from_path: "/sale", to_path: "/collections/summer-sale", permanent: false, active: true },
      ],
    },
    {
      // Pricing / eligibility tier a customer belongs to (Vendure CustomerGroup,
      // Shopify customer segment) — the hook for wholesale + tax-exempt B2B.
      slug: "customer_groups", group: "Customers", singular: "Customer group", plural: "Customer groups", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("code", { label: "Code" })),
        ...half(
          pct("discount_pct", { label: "Standing discount (%)" }),
          bool("tax_exempt", { default: false, label: "Tax exempt" }),
        ),
        notes("note", { label: "Internal note" }),
      ],
      samples: [
        { name: "Retail", code: "retail", discount_pct: 0, tax_exempt: false },
        { name: "Wholesale", code: "wholesale", discount_pct: 25, tax_exempt: true, note: "Net-30 terms, minimum 10 units." },
      ],
    },
    {
      // Where you ship / charge tax (Vendure Zone, Medusa Region).
      slug: "shipping_zones", group: "Shipping & tax", singular: "Shipping zone", plural: "Shipping zones", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), flag("active")),
        tags("countries", { label: "Countries", description: "ISO country codes this zone covers, e.g. US, CA." }),
      ],
      samples: [{ name: "North America", active: true }, { name: "Europe", active: true }],
    },
    {
      slug: "tax_rates", group: "Shipping & tax", singular: "Tax rate", plural: "Tax rates", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), rel("zone", "shipping_zones")),
        ...half(
          num("rate", { validation: { min: 0, max: 100 }, label: "Rate (%)", format: { style: "percent100", precision: 2 } }),
          bool("inclusive", { default: false, label: "Prices include tax" }),
        ),
        flag("active"),
      ],
      samples: [
        { name: "US standard", zone: { ref: "shipping_zones:0" }, rate: 8.5, inclusive: false, active: true },
        { name: "EU VAT", zone: { ref: "shipping_zones:1" }, rate: 20, inclusive: true, active: true },
      ],
    },
    {
      slug: "shipping_rates", group: "Shipping & tax", singular: "Shipping rate", plural: "Shipping rates", defaultSort: "price",
      fields: stacked(
        sec("Rate", [
          ...half(text("name", { required: true }), rel("zone", "shipping_zones")),
          ...half(text("carrier"), money("price")),
        ]),
        sec("Eligibility", [
          ...half(
            money("min_order_subtotal", { label: "Minimum order subtotal" }),
            num("max_weight_kg", { validation: { min: 0 }, label: "Maximum weight (kg)" }),
          ),
          ...half(int("eta_days", { label: "Delivery estimate (days)" }), flag("active")),
        ]),
      ),
      samples: [
        { name: "Standard", zone: { ref: "shipping_zones:0" }, carrier: "UPS", price: 6.5, eta_days: 4, active: true },
        { name: "Free over $75", zone: { ref: "shipping_zones:0" }, carrier: "UPS", price: 0, min_order_subtotal: 75, eta_days: 5, active: true },
      ],
    },
    {
      slug: "locations", group: "Inventory", singular: "Location", plural: "Locations", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("code", { label: "Code" })),
        text("address"),
        ...half(text("city"), text("country")),
        geo("coordinates", ["address", "city", "country"], { label: "Map pin" }),
        flag("active", { label: "Active" }),
      ],
      samples: [
        { name: "Central DC", code: "DC-1", city: "Newark", country: "US", active: true },
        { name: "West DC", code: "DC-2", city: "Reno", country: "US", active: true },
      ],
    },
    {
      slug: "products", group: "Catalog", singular: "Product", plural: "Products", versioned: true, vectorize: true, fts: true, defaultSort: "name",
      fields: tabbed(
        sec("Basics", [
          ...half(text("name", { required: true, vectorize: true, searchable: true }), slugField("name")),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true },
          ...half(
            select("status", [ch("draft", C.gray), ch("active", C.green), ch("archived", C.slate)], { default: "active" }),
            text("product_type", { label: "Type" }),
          ),
          ...half(rel("brand", "brands"), rel("category", "categories")),
          ...half(
            tags("tags"),
            // BigCommerce exposes `featuredProducts` on the storefront; that
            // needs a merchandising flag to read from.
            bool("featured", { default: false, label: "Featured", description: "Surfaces the product in featured storefront slots." }),
          ),
        ]),
        sec("Pricing", [
          ...half(moneyIn("price", { required: true, label: "Base price" }), moneyIn("compare_at_price", { label: "Compare-at price" })),
          ...half(
            select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
            bool("taxable", { default: true, label: "Taxable" }),
          ),
          rel("tax_rate", "tax_rates", { label: "Tax rate override" }),
        ]),
        sec("Inventory", [
          hint("products_stock", "Total stock is a roll-up for reporting. The sellable number per warehouse lives on Inventory levels."),
          ...half(text("sku", { unique: true, label: "SKU" }), text("barcode", { label: "Barcode / GTIN" })),
          ...half(
            int("stock", { default: 0, validation: { min: 0 }, label: "Total stock" }),
            bool("track_inventory", { default: true, label: "Track inventory" }),
          ),
        ]),
        sec("Media", [image("featured_image"), relMany("images", "media")]),
        sec("SEO", [
          ts("published_at", { indexed: true, label: "Published at" }),
          text("seo_title", { label: "SEO title" }),
          notes("seo_description", { label: "SEO description" }),
        ]),
      ),
      samples: [
        { name: "Classic Tee", slug: "classic-tee", description: "A soft cotton t-shirt.", status: "active", product_type: "Apparel", brand: { ref: "brands:0" }, category: { ref: "categories:0" }, price: 25, compare_at_price: 30, currency: "USD", sku: "TEE-001", stock: 120 },
        { name: "Canvas Tote", slug: "canvas-tote", description: "Sturdy everyday tote bag.", status: "active", product_type: "Accessories", brand: { ref: "brands:1" }, category: { ref: "categories:1" }, price: 18, currency: "USD", sku: "TOTE-001", stock: 60 },
      ],
    },
    {
      // Option axes (e.g. Size, Color). Shopify caps at 3 per product.
      slug: "product_options", group: "Catalog", singular: "Option", plural: "Options", defaultSort: "position",
      fields: [rel("product", "products"), ...half(text("name", { required: true }), position("product"))],
      samples: [
        { product: { ref: "products:0" }, name: "Size", position: 1 },
        { product: { ref: "products:0" }, name: "Color", position: 2 },
      ],
    },
    {
      slug: "product_option_values", group: "Catalog", singular: "Option value", plural: "Option values", defaultSort: "position",
      fields: [
        rel("option", "product_options"),
        ...half(text("value", { required: true }), text("swatch", { interface: "color", label: "Swatch color" })),
        position("option"),
      ],
      samples: [
        { option: { ref: "product_options:0" }, value: "S", position: 1 },
        { option: { ref: "product_options:0" }, value: "M", position: 2 },
        { option: { ref: "product_options:0" }, value: "L", position: 3 },
        { option: { ref: "product_options:1" }, value: "Black", swatch: "#111827", position: 1 },
        { option: { ref: "product_options:1" }, value: "White", swatch: "#f9fafb", position: 2 },
      ],
    },
    {
      // The unit of sale, price & inventory (Shopify/BigCommerce variant model).
      slug: "product_variants", group: "Catalog", singular: "Variant", plural: "Variants", defaultSort: "position",
      fields: tabbed(
        sec("Variant", [
          rel("product", "products"),
          ...half(text("title", { label: "Title" }), position("product")),
          ...half(text("sku", { unique: true, label: "SKU" }), text("barcode", { label: "Barcode / GTIN" })),
        ]),
        sec("Pricing", [
          ...half(money("price", { required: true }), money("compare_at_price", { label: "Compare-at price" })),
          money("cost", { label: "Cost per item" }),
        ]),
        sec("Inventory", [
          ...half(
            int("inventory_quantity", { default: 0, validation: { min: 0 }, label: "On hand" }),
            select("inventory_policy", [ch("deny", C.red), ch("continue", C.green)], { default: "deny", label: "When out of stock" }),
          ),
        ]),
        sec("Shipping", [
          ...half(
            num("weight", { validation: { min: 0 } }),
            select("weight_unit", ["g", "kg", "oz", "lb"], { default: "kg", label: "Weight unit" }),
          ),
          bool("requires_shipping", { default: true, label: "Requires shipping" }),
        ]),
        // What a marketplace says about this unit after it was published.
        //
        // On the VARIANT rather than the product because a marketplace rules on
        // one sellable unit at a time — one size can be refused for a missing
        // attribute while its siblings go live, and a product-level column
        // could only ever record the last answer to arrive.
        sec("Marketplace listing", [
          hint(
            "variants_listing",
            "Filled in by a marketplace integration after a publish. A verdict lands here minutes or hours later, per unit — the marketplace decides in its own time.",
          ),
          ...half(
            select(
              "listing_status",
              [ch("pending", C.amber), ch("accepted", C.green), ch("rejected", C.red)],
              { label: "Listing status" },
            ),
            // The handle the marketplace knows this listing by. Three of the
            // four mint no id of their own and echo the seller's code back, so
            // this is often the same value as `sku` — and that is the answer,
            // not a bug to normalise away.
            text("listing_id", { indexed: true, label: "Listing ID" }),
          ),
          ...half(
            ts("listed_at", { label: "Listed at" }),
            notes("listing_error", { label: "Rejection reason" }),
          ),
        ]),
      ),
      samples: [
        { product: { ref: "products:0" }, title: "S / Black", sku: "TEE-001-S-BLK", price: 25, cost: 9, inventory_quantity: 40, position: 1 },
        { product: { ref: "products:0" }, title: "M / Black", sku: "TEE-001-M-BLK", price: 25, cost: 9, inventory_quantity: 50, position: 2 },
      ],
    },
    {
      // Subscribe-and-save / prepaid plans (Shopify Storefront
      // `sellingPlanGroups`) — a recurring purchase option attached to a
      // product, distinct from the one-off price on the variant.
      slug: "selling_plans", group: "Catalog", singular: "Selling plan", plural: "Selling plans", defaultSort: "name",
      fields: stacked(
        sec("Plan", [
          ...half(text("name", { required: true }), rel("product", "products")),
          ...half(
            select("kind", [ch("subscription", C.purple), ch("prepaid", C.teal), ch("try_before_you_buy", C.blue, "Try before you buy")], { default: "subscription" }),
            flag("active"),
          ),
        ]),
        sec("Cadence & discount", [
          ...half(
            select("billing_interval", [ch("day", C.gray), ch("week", C.teal), ch("month", C.blue), ch("year", C.purple)], { default: "month", label: "Billing interval" }),
            int("interval_count", { default: 1, validation: { min: 1 }, label: "Every" }),
          ),
          ...half(
            pct("discount_pct", { default: 0, label: "Subscriber discount (%)" }),
            int("min_cycles", { validation: { min: 0 }, label: "Minimum cycles" }),
          ),
        ]),
      ),
      samples: [
        { name: "Deliver every month — save 10%", product: { ref: "products:0" }, kind: "subscription", billing_interval: "month", interval_count: 1, discount_pct: 10, min_cycles: 3, active: true },
        { name: "Prepaid 6 months", product: { ref: "products:1" }, kind: "prepaid", billing_interval: "month", interval_count: 6, discount_pct: 15, active: true },
      ],
    },
    {
      // Inventory as a (variant × location) join — not a single int on the variant.
      slug: "inventory_levels", group: "Inventory", singular: "Inventory level", plural: "Inventory levels",
      fields: [
        hint("levels_available", "Available is what a shopper can buy: on hand minus committed. Keep the three numbers consistent when adjusting by hand."),
        ...half(rel("variant", "product_variants"), rel("location", "locations")),
        ...half(
          int("on_hand", { default: 0, validation: { min: 0 }, label: "On hand" }),
          int("committed", { default: 0, validation: { min: 0 }, label: "Committed" }),
        ),
        ...half(
          int("available", { default: 0, validation: { min: 0 }, label: "Available" }),
          int("reorder_point", { default: 0, validation: { min: 0 }, label: "Reorder point" }),
        ),
      ],
      samples: [
        { variant: { ref: "product_variants:0" }, location: { ref: "locations:0" }, available: 40, on_hand: 40, reorder_point: 10 },
        { variant: { ref: "product_variants:1" }, location: { ref: "locations:0" }, available: 50, on_hand: 50, reorder_point: 10 },
      ],
    },
    {
      slug: "customers", group: "Customers", singular: "Customer", plural: "Customers", defaultSort: "-created_at",
      fields: tabbed(
        sec("Profile", [
          ...half(text("first_name", { label: "First name" }), text("last_name", { label: "Last name" })),
          ...half(email("email", { required: true, unique: true }), phone("phone")),
          ...half(
            select("state", [ch("enabled", C.green), ch("disabled", C.gray), ch("invited", C.blue), ch("declined", C.red)], { default: "enabled", label: "Account state" }),
            rel("customer_group", "customer_groups", { label: "Group" }),
          ),
          userLink(),
        ]),
        sec("Marketing", [
          bool("accepts_marketing", { default: false, label: "Accepts marketing" }),
          tags("tags"),
        ]),
        sec("Activity", [
          ...half(
            money("total_spent", { default: 0, label: "Total spent" }),
            int("orders_count", { default: 0, validation: { min: 0 }, label: "Orders count" }),
          ),
          bool("tax_exempt", { default: false, label: "Tax exempt" }),
          notes("note", { label: "Internal note" }),
        ]),
      ),
      samples: [
        { email: "jordan@example.com", first_name: "Jordan", last_name: "Reed", phone: "+15555550100", state: "enabled", customer_group: { ref: "customer_groups:0" }, total_spent: 43, orders_count: 1 },
        { email: "sam@example.com", first_name: "Sam", last_name: "Taylor", phone: "+15555550142", state: "enabled", customer_group: { ref: "customer_groups:1" }, total_spent: 18, orders_count: 1 },
      ],
    },
    {
      slug: "addresses", group: "Customers", singular: "Address", plural: "Addresses", displayTemplate: "{{first_name}} {{last_name}} — {{city}}",
      fields: stacked(
        sec("Recipient", [
          rel("customer", "customers"),
          ...half(text("first_name", { label: "First name" }), text("last_name", { label: "Last name" })),
          ...half(text("company"), phone("phone")),
        ]),
        sec("Address", [
          text("line1", { label: "Address line 1" }),
          text("line2", { label: "Address line 2" }),
          ...half(text("city"), text("province", { label: "State / Province" })),
          ...half(text("postal_code", { label: "Postal code" }), text("country")),
          bool("is_default", { default: false, label: "Default address" }),
        ]),
      ),
      samples: [{ customer: { ref: "customers:0" }, first_name: "Jordan", last_name: "Reed", line1: "1 Market St", city: "San Francisco", province: "CA", country: "US", postal_code: "94105", is_default: true }],
    },
    {
      slug: "discounts", group: "Marketing", singular: "Discount", plural: "Discounts", defaultSort: "-starts_at",
      fields: stacked(
        sec("Discount", [
          ...half(
            text("code", { unique: true, required: true }),
            select("status", [ch("active", C.green), ch("scheduled", C.blue), ch("expired", C.gray)], { default: "active" }),
          ),
          ...half(
            select("value_type", [ch("percentage", C.blue), ch("fixed_amount", C.teal), ch("free_shipping", C.purple)], { default: "percentage", label: "Value type" }),
            num("value", { validation: { min: 0 } }),
          ),
        ]),
        sec("Limits", [
          ...half(
            select("target_selection", [ch("all", C.gray), ch("entitled", C.amber)], { default: "all", label: "Applies to" }),
            money("minimum_amount", { label: "Minimum order amount" }),
          ),
          ...half(
            int("usage_limit", { validation: { min: 0 }, label: "Usage limit" }),
            int("usage_count", { default: 0, validation: { min: 0 }, label: "Times used" }),
          ),
        ]),
        sec("Schedule", [
          ...half(ts("starts_at", { range: { end: "ends_at" }, indexed: true, label: "Starts at" }), ts("ends_at", { label: "Ends at" })),
        ]),
      ),
      samples: [{ code: "WELCOME10", value_type: "percentage", value: 10, target_selection: "all", status: "active", starts_at: ms("2026-01-01"), ends_at: ms("2026-12-31") }],
    },
    {
      // Pre-checkout basket (Medusa Cart) — the abandoned-cart recovery surface.
      slug: "carts", group: "Orders", singular: "Cart", plural: "Carts", defaultSort: "-updated_at",
      fields: stacked(
        sec("Cart", [
          ...half(rel("customer", "customers"), email("email")),
          ...half(
            select("status", [ch("active", C.blue), ch("completed", C.green), ch("abandoned", C.amber)], { default: "active" }),
            int("item_count", { default: 0, validation: { min: 0 }, label: "Items" }),
          ),
          ...half(moneyIn("subtotal"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
        ]),
        sec("Recovery", [
          ...half(
            ts("abandoned_at", { indexed: true, label: "Abandoned at" }),
            bool("recovery_email_sent", { default: false, label: "Recovery email sent" }),
          ),
        ]),
      ),
      samples: [
        { customer: { ref: "customers:1" }, email: "sam@example.com", status: "abandoned", item_count: 2, subtotal: 61, currency: "USD", abandoned_at: ms("2026-01-15"), recovery_email_sent: false },
      ],
    },
    {
      slug: "orders", group: "Orders", singular: "Order", plural: "Orders", defaultSort: "-placed_at",
      kanbanGroupBy: "fulfillment_status",
      fields: tabbed(
        sec("Order", [
          ...half(seq("number", "ORD-{YYYY}-{#####}"), ts("placed_at", { indexed: true, label: "Placed at" })),
          ...half(rel("customer", "customers"), email("email")),
          // `status` = payment state (Shopify financial_status). Kept under this
          // name so existing apply/choice-membership tests stay valid.
          ...half(
            select("status", [ch("pending", C.amber), ch("authorized", C.blue), ch("partially_paid", C.amber, "Partially paid"), ch("paid", C.green), ch("partially_refunded", C.purple, "Partially refunded"), ch("refunded", C.gray), ch("voided", C.red)], { default: "pending", label: "Payment status" }),
            select("fulfillment_status", [ch("unfulfilled", C.gray), ch("partial", C.amber), ch("fulfilled", C.green), ch("restocked", C.slate)], { default: "unfulfilled", label: "Fulfillment status" }),
          ),
          ...half(
            select("channel", [ch("web", C.blue), ch("pos", C.teal), ch("marketplace", C.purple), ch("draft", C.gray)], { default: "web" }),
            // The marketplace's own handle for this order's shipment package.
            // A marketplace's status notifications address the PACKAGE, not the
            // order, so an order pulled in from one has nowhere to be notified
            // about without this — it is what the Trendyol tasks' package-id
            // setting is pointed at.
            text("marketplace_package_id", { indexed: true, label: "Marketplace package ID" }),
          ),
        ]),
        sec("Delivery", [
          ...half(rel("shipping_address", "addresses", { label: "Ship to" }), rel("billing_address", "addresses", { label: "Bill to" })),
          ...half(rel("shipping_rate", "shipping_rates", { label: "Shipping method" }), rel("discount", "discounts", { label: "Discount applied" })),
        ]),
        sec("Totals", [
          hint("orders_totals", "Totals are a snapshot taken at checkout — edit them only to correct a mistake, never to discount an order after the fact."),
          ...half(moneyIn("subtotal"), moneyIn("total_tax", { label: "Tax" })),
          ...half(moneyIn("total_shipping", { label: "Shipping" }), moneyIn("total_discounts", { label: "Discounts" })),
          ...half(moneyIn("total", { label: "Total" }), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
        ]),
        sec("Meta", [
          tags("tags"),
          notes("note"),
          ...half(
            select("cancel_reason", [ch("customer", C.gray), ch("fraud", C.red), ch("inventory", C.amber), ch("declined", C.red), ch("other", C.slate)], {
              label: "Cancel reason",
              // Asked for exactly when an order is being voided, and out of the
              // way otherwise — a permanent "why was this cancelled?" box on a
              // live order is a question with no answer.
              conditions: [when("status", "_eq", "voided", "required"), when("status", "_neq", "voided", "hidden")],
            }),
            ts("cancelled_at", { label: "Cancelled at", conditions: [when("status", "_neq", "voided", "hidden")] }),
          ),
        ]),
      ),
      samples: [
        { customer: { ref: "customers:0" }, email: "jordan@example.com", status: "paid", fulfillment_status: "fulfilled", shipping_address: { ref: "addresses:0" }, shipping_rate: { ref: "shipping_rates:0" }, subtotal: 43, total_shipping: 6.5, total: 49.5, currency: "USD", placed_at: ms("2026-01-12") },
        { customer: { ref: "customers:1" }, email: "sam@example.com", status: "pending", fulfillment_status: "unfulfilled", subtotal: 18, total: 18, currency: "USD", placed_at: ms("2026-01-14") },
      ],
    },
    {
      slug: "order_items", group: "Orders", singular: "Order item", plural: "Order items",
      fields: [
        hint("order_items_total", "Line total is generated by the database as qty × unit price — it can't be typed in."),
        ...half(rel("order", "orders"), rel("product", "products")),
        rel("variant", "product_variants"),
        ...half(text("title", { label: "Title (snapshot)" }), text("sku", { label: "SKU (snapshot)" })),
        ...half(int("qty", { default: 1, validation: { min: 1 } }), money("unit_price")),
        ...half(money("total_discount", { label: "Line discount" }), computedNum("line_total", "qty * unit_price", { label: "Line total" })),
      ],
      samples: [
        { order: { ref: "orders:0" }, product: { ref: "products:0" }, variant: { ref: "product_variants:0" }, title: "Classic Tee — S / Black", sku: "TEE-001-S-BLK", qty: 1, unit_price: 25 },
        { order: { ref: "orders:0" }, product: { ref: "products:1" }, title: "Canvas Tote", sku: "TOTE-001", qty: 1, unit_price: 18 },
      ],
    },
    {
      // Payment ledger — `kind` and `status` are two separate axes (Shopify).
      slug: "transactions", group: "Orders", singular: "Transaction", plural: "Transactions", defaultSort: "-processed_at",
      fields: [
        rel("order", "orders"),
        ...half(
          select("kind", [ch("authorization", C.blue), ch("capture", C.teal), ch("sale", C.green), ch("void", C.gray), ch("refund", C.red)], { default: "sale" }),
          select("status", [ch("pending", C.amber), ch("success", C.green), ch("failure", C.red), ch("error", C.red)], { default: "success" }),
        ),
        ...half(moneyIn("amount"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
        ...half(text("gateway", { label: "Gateway" }), ts("processed_at", { indexed: true, label: "Processed at" })),
      ],
      samples: [{ order: { ref: "orders:0" }, kind: "sale", status: "success", amount: 43, currency: "USD", gateway: "stripe", processed_at: ms("2026-01-12") }],
    },
    {
      // Money back out (Shopify/Vendure Refund) — kept separate from the
      // transaction ledger so partial refunds carry their own reason + restock.
      slug: "refunds", group: "Orders", singular: "Refund", plural: "Refunds", defaultSort: "-processed_at",
      fields: stacked(
        sec("Refund", [
          ...half(rel("order", "orders"), rel("transaction", "transactions", { label: "Against transaction" })),
          ...half(moneyIn("amount", { required: true }), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
          ...half(
            select("status", [ch("pending", C.amber), ch("success", C.green), ch("failure", C.red)], { default: "pending" }),
            ts("processed_at", { indexed: true, label: "Processed at" }),
          ),
        ]),
        sec("Reason", [
          ...half(
            select("reason", [ch("customer", C.gray), ch("damaged", C.red), ch("wrong_item", C.amber, "Wrong item"), ch("not_delivered", C.red, "Not delivered"), ch("other", C.slate)], { default: "customer" }),
            bool("restock", { default: true, label: "Restock the items" }),
          ),
          notes("note"),
        ]),
      ),
      samples: [{ order: { ref: "orders:0" }, transaction: { ref: "transactions:0" }, amount: 18, currency: "USD", status: "success", reason: "damaged", restock: false, processed_at: ms("2026-01-20"), note: "Tote arrived with a torn strap." }],
    },
    {
      // RMA (Medusa Return / Shopify Return) — the request, separate from the
      // money movement, because goods come back before a refund is issued.
      slug: "returns", group: "Orders", singular: "Return", plural: "Returns", defaultSort: "-requested_at",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Return", [
          ...half(seq("number", "RMA-{#####}", { label: "RMA number" }), rel("order", "orders")),
          ...half(
            select("status", [ch("requested", C.amber), ch("approved", C.blue), ch("received", C.teal), ch("completed", C.green), ch("cancelled", C.gray)], {
              default: "requested",
              ...flow(
                {
                  requested: ["approved", "cancelled"],
                  approved: ["received", "cancelled"],
                  received: ["completed"],
                },
                { initial: ["requested"], labels: { approved: "Approve", received: "Mark received", completed: "Complete" } },
              ),
            }),
            rel("refund", "refunds", { label: "Linked refund" }),
          ),
        ]),
        sec("Handling", [
          ...half(ts("requested_at", { indexed: true, label: "Requested at" }), ts("received_at", { label: "Received at" })),
          ...half(text("tracking_number", { label: "Return tracking" }), money("restocking_fee", { label: "Restocking fee" })),
          notes("note"),
        ]),
      ),
      samples: [{ order: { ref: "orders:0" }, status: "completed", refund: { ref: "refunds:0" }, requested_at: ms("2026-01-17"), received_at: ms("2026-01-19"), note: "Customer returned the tote." }],
    },
    {
      slug: "return_items", group: "Orders", singular: "Return item", plural: "Return items",
      fields: [
        ...half(rel("return", "returns"), rel("order_item", "order_items")),
        ...half(int("qty", { default: 1, validation: { min: 1 } }), select("condition", [ch("resellable", C.green), ch("damaged", C.red), ch("opened", C.amber)], { default: "resellable" })),
        text("reason"),
      ],
      samples: [{ return: { ref: "returns:0" }, order_item: { ref: "order_items:1" }, qty: 1, condition: "damaged", reason: "Torn strap" }],
    },
    {
      slug: "fulfillments", group: "Orders", singular: "Fulfillment", plural: "Fulfillments", defaultSort: "-shipped_at",
      fields: stacked(
        sec("Fulfillment", [
          ...half(rel("order", "orders"), rel("location", "locations")),
          select("status", [ch("pending", C.amber), ch("open", C.blue), ch("success", C.green), ch("cancelled", C.red)], { default: "pending" }),
        ]),
        sec("Tracking", [
          ...half(
            // A fulfillment that succeeded went somewhere; one that has not shipped
            // yet has nothing to track.
            text("tracking_number", { label: "Tracking number", conditions: [when("status", "_eq", "success", "required")] }),
            text("tracking_company", { label: "Carrier" }),
          ),
          url("tracking_url", { label: "Tracking URL" }),
          ...half(ts("shipped_at", { indexed: true, label: "Shipped at" }), ts("delivered_at", { label: "Delivered at" })),
        ]),
        // What a carrier integration books and then reads back. Separate from
        // Tracking above because those four are what a human types when nobody
        // booked it through here — these are written by the provider and are
        // the handles it needs to ask again or cancel.
        sec("Carrier booking", [
          hint(
            "fulfillments_carrier",
            "Filled in by a carrier integration. `Status` above is yours — where the fulfillment is in your process; `Carrier status` is the carrier's own last word, and only it moves on its own.",
          ),
          ...half(
            text("carrier_code", { label: "Booked with", description: "The integration that booked it, e.g. easypost." }),
            // The handle the carrier knows this consignment by, and the one
            // that cancels or re-reads it. Carriers that print a barcode make
            // that barcode the handle; aggregators issue an id instead.
            text("carrier_shipment_id", { indexed: true, label: "Carrier shipment ID" }),
          ),
          ...half(
            // The vocabulary aggregators normalise every carrier onto, so a
            // second carrier does not arrive with a second set of words.
            select(
              "shipment_status",
              [
                ch("pre_transit", C.slate),
                ch("in_transit", C.blue),
                ch("out_for_delivery", C.teal),
                ch("delivered", C.green),
                ch("available_for_pickup", C.amber),
                ch("return_to_sender", C.amber),
                ch("failure", C.red),
                ch("cancelled", C.gray),
                ch("unknown", C.gray),
              ],
              { label: "Carrier status" },
            ),
            ts("estimated_delivery_at", { label: "Estimated delivery" }),
          ),
          // A storage key, not a URL: a signed link expires, and a column of
          // dead links is worse than one the reader signs on demand.
          text("label_key", { label: "Label (storage key)" }),
        ]),
      ),
      samples: [{ order: { ref: "orders:0" }, location: { ref: "locations:0" }, status: "success", tracking_number: "1Z999AA10123456784", tracking_company: "UPS", shipment_status: "delivered", shipped_at: ms("2026-01-13") }],
    },
    {
      slug: "reviews", group: "Customers", singular: "Review", plural: "Reviews", ownerScoped: true, defaultSort: "-created_at",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Review", [
          ...half(rel("product", "products"), rel("customer", "customers")),
          ...half(rating("rating"), text("title")),
          notes("body"),
        ]),
        sec("Moderation", [
          ...half(
            select("status", [ch("pending", C.amber), ch("approved", C.green), ch("disapproved", C.red)], { default: "pending" }),
            bool("verified_purchase", { default: false, label: "Verified purchase" }),
          ),
        ]),
      ),
      samples: [{ product: { ref: "products:0" }, customer: { ref: "customers:0" }, rating: 5, title: "Perfect fit", body: "Great quality, fits perfectly.", verified_purchase: true, status: "approved" }],
    },
    {
      slug: "gift_cards", group: "Marketing", singular: "Gift card", plural: "Gift cards", defaultSort: "-created_at",
      fields: [
        ...half(text("code", { unique: true, required: true, label: "Code" }), rel("customer", "customers")),
        ...half(moneyIn("initial_value", { label: "Initial value" }), moneyIn("balance", { label: "Balance" })),
        ...half(
          select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
          select("status", [ch("enabled", C.green), ch("disabled", C.gray)], { default: "enabled" }),
        ),
        date("expires_at", { indexed: true, label: "Expires at" }),
      ],
      samples: [{ code: "GIFT-AB12-CD34", initial_value: 50, balance: 50, currency: "USD", customer: { ref: "customers:0" }, status: "enabled", expires_at: ms("2027-12-31") }],
    },
  ],
  roles: [
    {
      name: "Store staff",
      description: "Day-to-day store operations: manage orders, fulfillments and stock; read the catalog and customers.",
      permissions: [
        { collection: "orders", action: "read" },
        { collection: "orders", action: "update" },
        { collection: "order_items", action: "read" },
        { collection: "fulfillments", action: "read" },
        { collection: "fulfillments", action: "create" },
        { collection: "fulfillments", action: "update" },
        { collection: "transactions", action: "read" },
        { collection: "returns", action: "read" },
        { collection: "returns", action: "create" },
        { collection: "returns", action: "update" },
        { collection: "return_items", action: "read" },
        { collection: "return_items", action: "create" },
        { collection: "refunds", action: "read" },
        { collection: "products", action: "read" },
        { collection: "product_variants", action: "read" },
        { collection: "inventory_levels", action: "read" },
        { collection: "inventory_levels", action: "update" },
        { collection: "customers", action: "read" },
        { collection: "addresses", action: "read" },
        { collection: "carts", action: "read" },
        { collection: "pages", action: "read" },
        { collection: "menus", action: "read" },
        { collection: "menu_items", action: "read" },
        { collection: "redirects", action: "read" },
        { collection: "selling_plans", action: "read" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Store overview",
      description: "Orders, revenue, returns and catalog health.",
      panels: [
        { name: "Orders", kind: "items-aggregate", viz: "counter", config: { collection: "orders", agg: "count" } },
        { name: "Revenue", kind: "items-aggregate", viz: "counter", config: { collection: "orders", agg: "sum", field: "total" } },
        { name: "Customers", kind: "items-aggregate", viz: "counter", config: { collection: "customers", agg: "count" } },
        { name: "Refunded", kind: "items-aggregate", viz: "counter", config: { collection: "refunds", agg: "sum", field: "amount" } },
        { name: "Orders by payment status", kind: "items-aggregate", viz: "bars", config: { collection: "orders", agg: "count", groupBy: "status" } },
        { name: "Orders by fulfillment", kind: "items-aggregate", viz: "donut", config: { collection: "orders", agg: "count", groupBy: "fulfillment_status" } },
        { name: "Products by status", kind: "items-aggregate", viz: "donut", config: { collection: "products", agg: "count", groupBy: "status" } },
        { name: "Returns by status", kind: "items-aggregate", viz: "donut", config: { collection: "returns", agg: "count", groupBy: "status" } },
        { name: "Carts by status", kind: "items-aggregate", viz: "donut", config: { collection: "carts", agg: "count", groupBy: "status" } },
      ],
    },
  ],
  /**
   * The rules a store runs on, already running.
   *
   * Deliberately absent: "an order was paid, so take the stock down". Which
   * units an order consumed lives on its `order_items`, and where they were
   * held lives on `inventory_levels` — a flow's `data` is the order row and can
   * see neither. A step that decremented something would have to guess the
   * location, and a wrong location is worse than no adjustment because it reads
   * as done. So the flows below report the fact and leave the count to whoever
   * is holding the box.
   */
  flows: [
    {
      name: "Tell the team when an order is placed",
      trigger: "event:items:orders:created",
      operations: [
        {
          type: "notification",
          title: "Order {{ data.number }} placed",
          body: "{{ data.total }} {{ data.currency }} via {{ data.channel }}. Check the items are in stock before it is picked.",
          url: "/collections/orders",
        },
      ],
    },
    {
      name: "Chase an order that was paid a day ago and still has not gone out",
      // A schedule rather than `event:items:orders:updated`, and that is the
      // whole point: a flow sees the row as it now stands, with no before-image,
      // so an update trigger cannot tell "just became paid" from "was saved
      // again while paid" and would re-announce every edit. Anchored on
      // `placed_at` it fires once per order, the morning after, and only for the
      // ones still sitting there.
      trigger: `schedule:${JSON.stringify({
        collection: "orders",
        field: "placed_at",
        offset: { value: 1, unit: "days", direction: "after" },
        at: 540,
        timeZone: null,
        where: {
          status: { _eq: "paid" },
          fulfillment_status: { _in: ["unfulfilled", "partial"] },
        },
      })}`,
      operations: [
        {
          type: "notification",
          title: "Order {{ data.number }} is paid and still unshipped",
          body: "Paid a day ago, nothing fulfilled yet. Pick it or say why it is held.",
          url: "/collections/orders",
        },
      ],
    },
    {
      name: "Keep a discount's status in step with its schedule",
      trigger: "cron:0 3 * * *",
      operations: [
        // Open first, close second — on purpose. A `foreach` queries when it
        // runs rather than from a snapshot taken at the top of the flow, so a
        // discount whose whole window has already gone by is activated by the
        // first loop and expired by the second in the same run, instead of
        // being left showing `scheduled` for ever.
        {
          type: "foreach",
          collection: "discounts",
          filter: { status: { _eq: "scheduled" }, starts_at: { _lte: "$now" } },
          do: [
            {
              type: "item.update",
              collection: "discounts",
              id: "{{ $item.id }}",
              data: { status: "active" },
            },
          ],
        },
        {
          type: "foreach",
          collection: "discounts",
          filter: { ends_at: { _lt: "$now" }, status: { _neq: "expired" } },
          do: [
            {
              type: "item.update",
              collection: "discounts",
              id: "{{ $item.id }}",
              data: { status: "expired" },
            },
          ],
        },
      ],
    },
    {
      name: "Ask for a received return to be put back into stock",
      // A TRANSITION trigger, which `returns.status` can carry because it is
      // the one status in this template that declares a lifecycle. It fires
      // once, on the move itself — an `…:updated` trigger with a condition
      // cannot tell "just arrived" from "was saved again after arriving", so
      // it would ask for the same box to be put away every time anybody edited
      // the row. The other update-triggered flows here keep their condition
      // because their fields declare no lifecycle to announce.
      trigger: "event:items:returns:transition:status:*:received",
      operations: [
        {
          type: "notification",
          title: "Return {{ data.number }} is back",
          body: "Its return items say which units came back and in what condition — only the resellable ones go back onto a location's inventory level.",
          url: "/collections/returns",
        },
      ],
    },
    {
      name: "Win back an abandoned cart the next morning (needs email)",
      // Off until a mail transport is configured. The cart carries its own
      // `email`, so no relation has to resolve for the message to address
      // somebody — a guest cart is recoverable too.
      active: false,
      trigger: `schedule:${JSON.stringify({
        collection: "carts",
        field: "abandoned_at",
        offset: { value: 1, unit: "days", direction: "after" },
        at: 600,
        timeZone: null,
        where: { status: { _eq: "abandoned" }, recovery_email_sent: { _eq: false } },
      })}`,
      operations: [
        {
          type: "email",
          to: "{{ data.email }}",
          subject: "You left something in your basket",
          html: "<p>Your basket is still here — {{ data.item_count }} item(s), {{ data.subtotal }} {{ data.currency }}.</p><p>Pick up where you left off whenever you like.</p>",
        },
        // Flagged on the row as well as excluded by the trigger's `where`: the
        // flag is what an operator reads off the cart to know it was chased,
        // and it survives the flow being edited or re-pointed later.
        {
          type: "item.update",
          collection: "carts",
          id: "{{ data.id }}",
          data: { recovery_email_sent: true },
        },
      ],
    },
    {
      name: "Monthly store report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Store overview",
          subject: "Store — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "packing_slip",
      name: "Packing slip",
      description: "What goes in the box with the order.",
      filename: "packing-slip-{{ data.number }}",
      variables: ["number", "placed_at"],
      // No prices anywhere on it, deliberately: a packing slip travels with the
      // goods and is routinely read by the recipient of a gift, so the amounts
      // belong on the receipt below and nowhere near this one.
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:16mm}" +
        "body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:22px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        ".cols{display:flex;gap:40px;margin-top:18px}" +
        "table{width:100%;border-collapse:collapse;margin-top:20px}" +
        "th,td{text-align:left;padding:7px 6px;border-bottom:1px solid #e5e5e5}" +
        "td.n,th.n{text-align:right}" +
        "</style></head><body>" +
        "<h1>Packing slip — {{ data.number }}</h1>" +
        '<p class="muted">Placed {{ data.placed_at }} · {{ data.channel }}</p>' +
        '<div class="cols">' +
        "<div><strong>Ship to</strong><br>" +
        "{{ data.shipping_address.first_name }} {{ data.shipping_address.last_name }}<br>" +
        "{{ data.shipping_address.company }}<br>" +
        "{{ data.shipping_address.line1 }}<br>{{ data.shipping_address.line2 }}<br>" +
        "{{ data.shipping_address.city }} {{ data.shipping_address.province }} " +
        "{{ data.shipping_address.postal_code }}<br>{{ data.shipping_address.country }}</div>" +
        "<div><strong>Shipping</strong><br>{{ data.shipping_rate.name }}<br>" +
        "{{ data.shipping_rate.carrier }}</div>" +
        "</div>" +
        '<table><thead><tr><th>SKU</th><th>Item</th><th class="n">Qty</th></tr></thead><tbody>' +
        "<!-- one row per order item; fill from your own query or a foreach -->" +
        "</tbody></table>" +
        '<p class="muted">{{ data.note }}</p>' +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "16mm" },
    },
    {
      key: "order_receipt",
      name: "Order receipt",
      description: "The order as the customer receives it, with the amounts.",
      filename: "receipt-{{ data.number }}",
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
        "<h1>Receipt — {{ data.number }}</h1>" +
        '<p class="muted">Placed {{ data.placed_at }}</p>' +
        "<p><strong>{{ data.customer.first_name }} {{ data.customer.last_name }}</strong><br>" +
        "{{ data.email }}</p>" +
        '<table><thead><tr><th>Item</th><th class="n">Qty</th>' +
        '<th class="n">Unit</th><th class="n">Line total</th></tr></thead><tbody>' +
        "<!-- one row per order item; fill from your own query or a foreach -->" +
        "</tbody></table>" +
        '<table class="totals">' +
        '<tr><td class="n">Subtotal</td><td class="n">{{ data.subtotal }}</td></tr>' +
        '<tr><td class="n">Discounts</td><td class="n">{{ data.total_discounts }}</td></tr>' +
        '<tr><td class="n">Shipping</td><td class="n">{{ data.total_shipping }}</td></tr>' +
        '<tr><td class="n">Tax</td><td class="n">{{ data.total_tax }}</td></tr>' +
        '<tr><td class="n"><strong>Total {{ data.currency }}</strong></td>' +
        '<td class="n"><strong>{{ data.total }}</strong></td></tr></table>' +
        '<p class="muted">Keep this with your order — a return quotes the order number above.</p>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      // The `Wholesale` customer group already ships in this template, but a
      // group is a relation and a public form cannot set one — so an applicant
      // lands as an ordinary customer and staff move them into the group when
      // they approve the account. `note` is the collection's own internal note
      // column, which is exactly where whoever reviews this will look.
      name: "Wholesale account application",
      collection: "customers",
      settings: {
        submitLabel: "Apply",
        successMessage: "Thanks — we review applications within two business days.",
      },
      fields: [
        { name: "first_name", label: "First name" },
        { name: "last_name", label: "Last name" },
        { name: "email", label: "Work email", help: "Where account details and invoices will be sent." },
        { name: "phone" },
        {
          name: "note",
          label: "Tell us about your business",
          help: "Where you sell, and roughly what volume you expect per month.",
        },
      ],
    },
    {
      // `status` is deliberately off the form: it defaults to `pending`, and
      // that default is the only thing keeping an unmoderated review off the
      // storefront. Which product a review is about is a relation the public
      // page cannot set either, so the moderator attaches it on approval —
      // which is the same pass they were already making.
      name: "Write a review",
      collection: "reviews",
      settings: {
        submitLabel: "Post review",
        successMessage: "Thank you — we read every review before it goes up.",
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
      name: "Store analyst",
      handle: "store-analyst",
      description: "Answers questions about orders, stock and what is selling.",
      systemPrompt:
        "You help a store team read its own numbers. Answer using the " +
        "workspace's data only. Four rules this store's schema makes " +
        "necessary: payment status and fulfillment status are separate " +
        "columns on an order — never report one as the other, and 'paid' says " +
        "nothing about whether it shipped. Money carries its own currency; " +
        "amounts in different currencies are never added together. Refunds are " +
        "their own rows, so revenue net of refunds is the orders total minus " +
        "the refunds total, not a single column. What a shopper can actually " +
        "buy is 'available' on an inventory level, per location — a product's " +
        "own stock number is a reporting roll-up and may lag. Name the order " +
        "number, be brief, and say plainly when the data does not answer the " +
        "question.",
      // `dashboards.run` rather than a KPI tool: this template bundles the
      // "Store overview" dashboard and no KPI definitions, so that is where the
      // agreed figures actually live.
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
  /**
   * Remote config the STOREFRONT reads, not internal toggles.
   *
   * That distinction is the whole reason there are only three: a template
   * cannot know which experiments a merchant wants to run, and seeding
   * invented ones would be noise an operator has to clear out. These three are
   * decisions every store has already made and currently hard-codes in its
   * front end — so they arrive as something a deploy can change without a
   * deploy, which is what the feature is for.
   *
   * Defaults are the safe reading of each: guest checkout on because refusing
   * it costs sales, reviews on because the collection exists, wholesale off
   * because the pricing it exposes is not for everybody.
   */
  flags: [
    {
      key: "storefront.guest-checkout",
      enabled: true,
      description: "Let a buyer complete an order without creating an account.",
    },
    {
      key: "storefront.reviews",
      enabled: true,
      description: "Show product reviews, and accept new ones.",
    },
    {
      key: "storefront.wholesale-pricing",
      enabled: false,
      // The payload is what a storefront reads once the flag is on: which
      // customer group's standing discount applies. A flag that only said
      // on/off would leave the front end hard-coding the group anyway.
      value: { customerGroupCode: "wholesale" },
      description: "Show customer-group pricing to signed-in buyers in that group.",
    },
  ],
};
