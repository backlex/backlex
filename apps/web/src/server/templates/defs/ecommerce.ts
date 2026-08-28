import type { SchemaTemplate } from "../types";
import { bool, C, ch, computedMoneyIn, computedNum, date, email, flag, flow, geo, half, hint, image, int, moneyIn, ms, notes, num, parent, pct, phone, position, rating, rel, relMany, rollup, sec, select, seq, slugField, stacked, tabbed, tags, text, ts, url, userLink, when } from "../dsl";

/**
 * The commerce model, read off the three platforms that publish theirs.
 *
 * Every entity below was checked against a real schema rather than recalled:
 * Saleor's `schema.graphql` (893 `type` declarations), Medusa v2's store and
 * admin OpenAPI documents, and BigCommerce's Storefront GraphQL schema by
 * introspection — its `dev-docs` repository is archived and its REST reference
 * is no longer published as a spec, so the guides were read for the parts the
 * storefront schema cannot show (price-list assignment, tax zones, consignments).
 *
 * Three shapes are worth knowing before editing anything here, because each one
 * is the answer to a question this file used to get wrong.
 *
 * **A variant is defined by the option values it selects.** `product_variants`
 * carries a `title` for humans, but `variant_option_values` is what makes
 * "Size = M, Colour = Black" resolvable to one sellable unit. A storefront that
 * has to parse the title has no model at all — which is what shipped before.
 *
 * **An order has three axes, not two.** `state` is the order's own lifecycle,
 * `status` is payment, `fulfillment_status` is delivery. Cancellation lives on
 * `state` and nowhere else: it used to be a value of the payment column, so
 * every KPI that meant to exclude cancelled orders excluded nothing and counted
 * them into revenue.
 *
 * **Every amount carries its denomination.** Not just the totals: a line, a
 * discount allocation, a consignment's shipping and a customer's lifetime
 * spend are all `moneyIn`, denominated by their own row's `currency`. A bare
 * number here is not a smaller version of the same thing — it is an amount
 * whose unit nothing knows, and `sum()` over a column of those adds €85 to
 * $100 and answers 185.5. The totals were protected and the lines that make
 * them up were not, which is the same defect one table over from where it was
 * fixed.
 *
 * **Price is a table, not a column.** `product_variants.price` is the default
 * list price and a single-price shop never needs more. `prices` is what a
 * variant costs on a given price list, in a given currency, at a given
 * quantity — the one shape that covers wholesale, sales, and quantity breaks
 * without three mechanisms.
 */
export const ecommerce: SchemaTemplate = {
  id: "ecommerce",
  label: "E-commerce",
  groups: ["Catalog", "Channels & pricing", "Inventory", "Customers", "Orders", "Post-purchase", "Marketing", "Storefront", "Shipping & tax"],
  description:
    "A full commerce model: products with typed attributes, options, variants and non-stocked modifiers; sales channels with per-channel publication, price lists, quantity breaks and multi-currency; multi-location inventory with reservations and a movement ledger; carts with lines, orders with a lifecycle separate from payment and delivery, consignments for pickup and split shipments, per-line tax, coded and automatic promotions, gift-card ledgers, returns/exchanges/claims, subscriptions — plus the storefront itself: pages, menus, redirects and content translations.",
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
          // A `smart` collection used to be a label with nothing behind it: the
          // type could be chosen and no rule could be written, so the choice
          // meant nothing. The rule is JSON in the same filter shape the items
          // API takes, e.g. {"tags":{"_contains":"sale"}} — a storefront runs it
          // as a query instead of reading a membership table.
          hint("collections_rule", "A smart collection's members come from this filter, in the same shape /api/items takes. Leave it empty for a manual collection."),
          { name: "rule", type: "json", interface: "code", label: "Smart rule" },
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
      // One row per translated FIELD, the shape Saleor's `*Translation` types and
      // Medusa's `AdminTranslation` both settle on.
      //
      // Deliberately generic rather than a `product_translations` +
      // `category_translations` + … family: a storefront reads this by
      // (collection, row, locale) in one query for a whole page, and a template
      // cannot know which collections a merchant will localise. The engine does
      // not resolve these automatically — the storefront picks the row, which is
      // the honest arrangement for a headless backend and is said out loud here
      // so nobody expects `GET /api/items/products` to answer in French.
      slug: "translations", group: "Storefront", singular: "Translation", plural: "Translations", fts: true,
      fields: [
        hint("translations_shape", "One row per translated field. The storefront reads by collection + row + locale; nothing here rewrites an API response on its own."),
        ...half(
          text("collection", { required: true, indexed: true, description: "Collection slug, e.g. products." }),
          text("row_id", { required: true, indexed: true, label: "Row ID" }),
        ),
        ...half(
          text("field", { required: true, description: "Column name being translated, e.g. name or description." }),
          text("locale", { required: true, indexed: true, description: "BCP-47 tag, e.g. tr, de, fr-CA." }),
        ),
        notes("value", { required: true, searchable: true }),
      ],
      samples: [
        { collection: "categories", row_id: "seed-apparel", field: "name", locale: "tr", value: "Giyim" },
        { collection: "categories", row_id: "seed-accessories", field: "name", locale: "tr", value: "Aksesuar" },
      ],
    },
    {
      // Where stock sits and, now, where a shopper may collect it. Saleor calls
      // the second half `clickAndCollectOption`; BigCommerce models it as a
      // pickup consignment against a location. Same fact, stored once.
      slug: "locations", group: "Inventory", singular: "Location", plural: "Locations", defaultSort: "name",
      fields: stacked(
        sec("Location", [
          ...half(text("name", { required: true }), text("code", { label: "Code" })),
          ...half(
            select("location_type", [ch("warehouse", C.blue), ch("store", C.teal), ch("pickup_point", C.purple, "Pickup point")], { default: "warehouse", label: "Type" }),
            flag("active", { label: "Active" }),
          ),
        ]),
        sec("Address", [
          text("address"),
          ...half(text("city"), text("country")),
          geo("coordinates", ["address", "city", "country"], { label: "Map pin" }),
        ]),
        sec("Pickup", [
          bool("pickup_enabled", { default: false, label: "Collect from here" }),
          notes("pickup_instructions", { label: "Collection instructions" }),
        ]),
      ),
      samples: [
        { name: "Central DC", code: "DC-1", location_type: "warehouse", city: "Newark", country: "US", active: true },
        { name: "West DC", code: "DC-2", location_type: "warehouse", city: "Reno", country: "US", active: true },
        { name: "Flagship store", code: "ST-1", location_type: "store", city: "San Francisco", country: "US", pickup_enabled: true, pickup_instructions: "Collect from the counter at the back, 10:00–18:00.", active: true },
      ],
    },
    {
      // BigCommerce's transactional/display split, which is the distinction that
      // makes multi-currency honest: a display currency converts a number on
      // screen, a transactional one is what the shopper is actually charged in
      // and what the order is denominated by.
      slug: "currencies", group: "Channels & pricing", singular: "Currency", plural: "Currencies", defaultSort: "code",
      fields: [
        hint("currencies_transactional", "A transactional currency is one an order can be placed in. A display-only currency converts prices on screen at the rate below and checkout still happens in a transactional one."),
        ...half(
          text("code", { required: true, unique: true, label: "Code", description: "ISO 4217, e.g. USD." }),
          text("name", { required: true }),
        ),
        ...half(text("symbol"), int("decimals", { default: 2, validation: { min: 0, max: 4 }, label: "Decimal places" })),
        ...half(
          num("exchange_rate", { default: 1, validation: { min: 0 }, label: "Rate from default", description: "How many of this currency one unit of the default currency buys." }),
          bool("is_transactional", { default: true, label: "Transactional" }),
        ),
        ...half(bool("is_default", { default: false, label: "Store default" }), flag("active")),
      ],
      samples: [
        { code: "USD", name: "US Dollar", symbol: "$", decimals: 2, exchange_rate: 1, is_transactional: true, is_default: true, active: true },
        { code: "EUR", name: "Euro", symbol: "€", decimals: 2, exchange_rate: 0.92, is_transactional: true, is_default: false, active: true },
        { code: "TRY", name: "Turkish Lira", symbol: "₺", decimals: 2, exchange_rate: 34.2, is_transactional: false, is_default: false, active: true },
      ],
    },
    {
      // Saleor's `Channel` rather than Medusa's SalesChannel/Region pair.
      //
      // Medusa splits "where it is sold" from "what currency and countries
      // apply", and the split costs every reader the job of remembering which
      // question each one answers. Saleor folds them into one thing that has a
      // currency, a country set and its own tax posture — and a merchant who
      // genuinely needs two currencies in one storefront opens two channels,
      // which is the same amount of configuration and one fewer concept.
      slug: "channels", group: "Channels & pricing", singular: "Channel", plural: "Channels", defaultSort: "name",
      fields: [
        hint("channels_currency", "A channel is denominated by one currency. Selling the same catalog in a second currency means a second channel — that is the trade for not carrying a separate region concept."),
        ...half(
          text("name", { required: true }),
          text("code", { required: true, unique: true, description: "Referenced by the storefront, e.g. web-us." }),
        ),
        ...half(
          select("channel_type", [ch("web", C.blue), ch("pos", C.teal), ch("marketplace", C.purple), ch("b2b", C.amber, "B2B"), ch("social", C.slate)], { default: "web", label: "Type" }),
          rel("currency", "currencies", { label: "Currency" }),
        ),
        ...half(rel("default_location", "locations", { label: "Ships from" }), flag("active")),
        tags("countries", { label: "Countries", description: "ISO country codes this channel sells into, e.g. US, CA." }),
        bool("prices_include_tax", { default: false, label: "Prices include tax", description: "Whether the amounts on price lists for this channel are gross." }),
      ],
      samples: [
        { name: "Online store", code: "web-us", channel_type: "web", currency: { ref: "currencies:0" }, default_location: { ref: "locations:0" }, prices_include_tax: false, active: true },
        { name: "Europe store", code: "web-eu", channel_type: "web", currency: { ref: "currencies:1" }, default_location: { ref: "locations:0" }, prices_include_tax: true, active: true },
        { name: "Flagship POS", code: "pos-sf", channel_type: "pos", currency: { ref: "currencies:0" }, default_location: { ref: "locations:2" }, prices_include_tax: false, active: true },
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
      // Saleor's `TaxClass`, and the piece a flat per-zone rate cannot express:
      // books at 1% and electronics at 20% in the same country. The rate lives
      // at the intersection of class and zone, on `tax_rates` below.
      slug: "tax_classes", group: "Shipping & tax", singular: "Tax class", plural: "Tax classes", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("code", { label: "Code" })),
        ...half(bool("is_default", { default: false, label: "Default class" }), flag("active")),
        notes("description"),
      ],
      samples: [
        { name: "Standard", code: "standard", is_default: true, active: true },
        { name: "Reduced", code: "reduced", is_default: false, active: true, description: "Books, food, children's clothing in most jurisdictions." },
        { name: "Zero-rated", code: "zero", is_default: false, active: true },
      ],
    },
    {
      slug: "tax_rates", group: "Shipping & tax", singular: "Tax rate", plural: "Tax rates", defaultSort: "name",
      fields: [
        hint("tax_rates_scope", "A rate applies where its zone, country, province and postal prefix all match — leave the narrower ones blank to cover the whole zone."),
        ...half(text("name", { required: true }), rel("zone", "shipping_zones")),
        ...half(rel("tax_class", "tax_classes", { label: "Applies to class" }), text("country", { label: "Country code" })),
        ...half(text("province", { label: "State / Province" }), text("postal_prefix", { label: "Postal-code prefix" })),
        ...half(
          num("rate", { validation: { min: 0, max: 100 }, label: "Rate (%)", format: { style: "percent100", precision: 2 } }),
          bool("inclusive", { default: false, label: "Prices include tax" }),
        ),
        flag("active"),
      ],
      samples: [
        { name: "US standard", zone: { ref: "shipping_zones:0" }, tax_class: { ref: "tax_classes:0" }, country: "US", rate: 8.5, inclusive: false, active: true },
        { name: "EU VAT — standard", zone: { ref: "shipping_zones:1" }, tax_class: { ref: "tax_classes:0" }, rate: 20, inclusive: true, active: true },
        { name: "EU VAT — reduced", zone: { ref: "shipping_zones:1" }, tax_class: { ref: "tax_classes:1" }, rate: 5, inclusive: true, active: true },
      ],
    },
    {
      slug: "shipping_rates", group: "Shipping & tax", singular: "Shipping rate", plural: "Shipping rates", defaultSort: "price",
      fields: stacked(
        sec("Rate", [
          ...half(text("name", { required: true }), rel("zone", "shipping_zones")),
          text("carrier"),
          ...half(moneyIn("price"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
        ]),
        sec("Eligibility", [
          hint("shipping_rates_rules", "The two bounds below cover most rates. Anything else — a country list, a customer group, a product tag — is a shipping rate rule."),
          ...half(
            moneyIn("min_order_subtotal", { label: "Minimum order subtotal" }),
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
      // Medusa's `ShippingOptionRule` — attribute / operator / value, evaluated
      // against the cart. One shape covers every condition a rate can have, so a
      // new condition is a row rather than a column.
      slug: "shipping_rate_rules", group: "Shipping & tax", singular: "Shipping rule", plural: "Shipping rules",
      fields: [
        hint("shipping_rules_shape", "Every rule on a rate must pass for it to be offered. Comma-separate the value for `in` and `not in`."),
        ...half(rel("rate", "shipping_rates", { required: true }), select("attribute", [ch("subtotal", C.teal), ch("weight", C.blue), ch("item_count", C.purple, "Item count"), ch("country", C.amber), ch("customer_group", C.slate, "Customer group"), ch("product_tag", C.gray, "Product tag")], { default: "subtotal" })),
        ...half(
          select("operator", [ch("eq", C.gray, "is"), ch("neq", C.gray, "is not"), ch("gt", C.blue, ">"), ch("gte", C.blue, "≥"), ch("lt", C.amber, "<"), ch("lte", C.amber, "≤"), ch("in", C.teal, "in"), ch("nin", C.red, "not in")], { default: "eq" }),
          text("value", { required: true }),
        ),
      ],
      samples: [
        { rate: { ref: "shipping_rates:1" }, attribute: "country", operator: "in", value: "US,CA" },
      ],
    },
    {
      // Saleor's `ProductType`: what kind of thing this is, which decides
      // whether it ships, what tax class it defaults to, and (through
      // `attributes`) which fields it carries.
      slug: "product_types", group: "Catalog", singular: "Product type", plural: "Product types", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), slugField("name")),
        ...half(rel("tax_class", "tax_classes", { label: "Default tax class" }), bool("requires_shipping", { default: true, label: "Ships physically" })),
        ...half(bool("is_digital", { default: false, label: "Digital" }), num("default_weight", { validation: { min: 0 }, label: "Default weight" })),
        ...half(
          select("weight_unit", ["g", "kg", "oz", "lb"], { default: "kg", label: "Weight unit" }),
          flag("active"),
        ),
        notes("description"),
      ],
      samples: [
        { name: "Apparel", slug: "apparel", tax_class: { ref: "tax_classes:0" }, requires_shipping: true, is_digital: false, default_weight: 0.3, weight_unit: "kg", active: true },
        { name: "Accessories", slug: "accessories", tax_class: { ref: "tax_classes:0" }, requires_shipping: true, is_digital: false, weight_unit: "kg", active: true },
        { name: "Digital download", slug: "digital-download", tax_class: { ref: "tax_classes:2" }, requires_shipping: false, is_digital: true, weight_unit: "kg", active: true },
      ],
    },
    {
      // Saleor's `Attribute`. What this adds over simply putting a column on
      // `products`: the field set VARIES BY PRODUCT TYPE — a shoe has a heel
      // height, a book has an ISBN, and neither wants the other's column. A
      // dynamic schema solves "add a column to every product"; this solves the
      // other one.
      slug: "attributes", group: "Catalog", singular: "Attribute", plural: "Attributes", defaultSort: "position",
      fields: [
        ...half(text("name", { required: true }), slugField("name")),
        ...half(
          select("input_type", [ch("dropdown", C.blue), ch("multiselect", C.teal), ch("text", C.gray), ch("rich_text", C.gray, "Rich text"), ch("number", C.purple), ch("boolean", C.slate), ch("date", C.amber), ch("swatch", C.red), ch("file", C.gray)], { default: "dropdown", label: "Input type" }),
          select("scope", [ch("product", C.blue), ch("variant", C.purple), ch("both", C.teal)], { default: "product", description: "Whether the value is set on the product, on each variant, or either." }),
        ),
        ...half(text("unit", { description: "Shown after the value, e.g. cm or GB." }), position()),
        ...half(bool("value_required", { default: false, label: "Required" }), bool("visible_in_storefront", { default: true, label: "Show on storefront" })),
        flag("filterable", { default: false, label: "Filterable", description: "Offer this attribute as a storefront facet." }),
      ],
      samples: [
        { name: "Material", slug: "material", input_type: "dropdown", scope: "product", position: 1, visible_in_storefront: true, filterable: true },
        { name: "Fit", slug: "fit", input_type: "dropdown", scope: "product", position: 2, visible_in_storefront: true, filterable: true },
        { name: "Care instructions", slug: "care-instructions", input_type: "text", scope: "product", position: 3, visible_in_storefront: true, filterable: false },
      ],
    },
    {
      slug: "attribute_values", group: "Catalog", singular: "Attribute value", plural: "Attribute values", defaultSort: "position",
      fields: [
        rel("attribute", "attributes", { required: true }),
        ...half(text("value", { required: true }), text("label")),
        ...half(text("swatch", { interface: "color", label: "Swatch color" }), position("attribute")),
      ],
      samples: [
        { attribute: { ref: "attributes:0" }, value: "cotton", label: "100% cotton", position: 1 },
        { attribute: { ref: "attributes:0" }, value: "canvas", label: "Cotton canvas", position: 2 },
        { attribute: { ref: "attributes:1" }, value: "regular", label: "Regular fit", position: 1 },
        { attribute: { ref: "attributes:1" }, value: "relaxed", label: "Relaxed fit", position: 2 },
      ],
    },
    {
      slug: "products", group: "Catalog", singular: "Product", plural: "Products", versioned: true, vectorize: true, fts: true, defaultSort: "name",
      fields: tabbed(
        sec("Basics", [
          ...half(text("name", { required: true, vectorize: true, searchable: true }), slugField("name")),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true },
          ...half(
            // The product's own lifecycle, and the one every store has whether
            // or not it uses channels. Per-channel publication is a listing row;
            // this is the global switch that outranks it.
            select("status", [ch("draft", C.gray), ch("active", C.green), ch("archived", C.slate)], { default: "active" }),
            rel("product_type", "product_types", { label: "Type" }),
          ),
          ...half(rel("brand", "brands"), rel("category", "categories", { label: "Primary category" })),
          tags("tags"),
          ...half(
            // BigCommerce exposes `featuredProducts` on the storefront; that
            // needs a merchandising flag to read from.
            bool("featured", { default: false, label: "Featured", description: "Surfaces the product in featured storefront slots." }),
            select("condition", [ch("new", C.green), ch("refurbished", C.amber), ch("used", C.slate)], { default: "new" }),
          ),
        ]),
        sec("Pricing", [
          ...half(moneyIn("price", { required: true, label: "Base price" }), moneyIn("compare_at_price", { label: "Compare-at price" })),
          ...half(
            select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
            bool("taxable", { default: true, label: "Taxable" }),
          ),
          ...half(rel("tax_class", "tax_classes", { label: "Tax class" }), rel("tax_rate", "tax_rates", { label: "Tax rate override" })),
        ]),
        sec("Inventory", [
          // Summed straight from the LEVELS, not from the variants — and that
          // distinction is the whole reason it can exist.
          //
          // A rollup of a rollup does not refresh: the write path restates a
          // parent from its children with a direct UPDATE, which never re-enters
          // the write path to restate the grandparent. So summing
          // `product_variants.inventory_quantity` (itself a rollup) would leave
          // this stale — measured, a level moved 60 → 85, the variant followed
          // and the product stayed at 60. Reaching past the variant to `on_hand`
          // — a plain column — makes the two SIBLING rollups over one child, and
          // the write path refreshes every parent that rolls up from a
          // collection, not just the first.
          //
          // The price is the denormalised `inventory_levels.product`; see the
          // note on that field.
          hint("products_stock", "Totalled across every location this product is stocked in, and refused as input. Stock is entered per (variant, location) on Inventory levels — a product with no variants has nowhere to hold any, and reads zero."),
          ...half(text("sku", { unique: true, label: "SKU" }), text("barcode", { label: "Barcode" })),
          ...half(text("gtin", { label: "GTIN" }), text("mpn", { label: "MPN" })),
          ...half(
            rollup(
              "stock",
              { from: "inventory_levels", via: "product", fn: "sum", field: "on_hand" },
              { label: "Total on hand", description: "Summed across every inventory level of this product. Stock is edited per location." },
            ),
            bool("track_inventory", { default: true, label: "Track inventory" }),
          ),
          ...half(
            int("min_purchase_qty", { default: 1, validation: { min: 1 }, label: "Minimum per order" }),
            int("max_purchase_qty", { validation: { min: 1 }, label: "Maximum per order" }),
          ),
        ]),
        sec("Media", [image("featured_image"), relMany("images", "media")]),
        sec("Availability", [
          ...half(ts("published_at", { indexed: true, label: "Published at" }), ts("available_from", { label: "Buyable from" })),
          ...half(
            ts("preorder_release_at", { label: "Pre-order release" }),
            text("preorder_message", { label: "Pre-order message", description: "Shown instead of the stock line while the release date is in the future." }),
          ),
        ]),
        sec("Storefront", [
          text("seo_title", { label: "SEO title" }),
          notes("seo_description", { label: "SEO description" }),
          // Kept by the server from approved reviews, so the storefront can sort
          // and filter by rating without counting rows on every request.
          ...half(
            rollup(
              "rating",
              { from: "reviews", via: "product", fn: "avg", field: "rating", filter: { status: { _eq: "approved" } } },
              { label: "Rating", description: "Averaged from this product's approved reviews." },
            ),
            rollup(
              "review_count",
              { from: "reviews", via: "product", fn: "count", filter: { status: { _eq: "approved" } } },
              { label: "Reviews", description: "Approved reviews only." },
            ),
          ),
        ]),
      ),
      samples: [
        { name: "Classic Tee", slug: "classic-tee", description: "A soft cotton t-shirt.", status: "active", product_type: { ref: "product_types:0" }, brand: { ref: "brands:0" }, category: { ref: "categories:0" }, condition: "new", price: 25, compare_at_price: 30, currency: "USD", tax_class: { ref: "tax_classes:0" }, sku: "TEE-001" },
        { name: "Canvas Tote", slug: "canvas-tote", description: "Sturdy everyday tote bag.", status: "active", product_type: { ref: "product_types:1" }, brand: { ref: "brands:1" }, category: { ref: "categories:1" }, condition: "new", price: 18, currency: "USD", tax_class: { ref: "tax_classes:0" }, sku: "TOTE-001" },
      ],
    },
    {
      // A product belongs to many categories (BigCommerce sends an array,
      // Medusa keeps a `categories` list). `products.category` stays as the
      // primary one — the breadcrumb has to pick a single path.
      slug: "product_categories", group: "Catalog", singular: "Product category", plural: "Product categories",
      fields: [
        ...half(
          rel("product", "products", { required: true }),
          rel("category", "categories", { required: true, uniqueWith: ["product"] }),
        ),
        ...half(bool("is_primary", { default: false, label: "Primary" }), position("category")),
      ],
      samples: [
        { product: { ref: "products:0" }, category: { ref: "categories:0" }, is_primary: true, position: 1 },
        { product: { ref: "products:1" }, category: { ref: "categories:1" }, is_primary: true, position: 1 },
      ],
    },
    {
      // The membership table a manual collection reads. A smart collection
      // leaves it empty and answers from `collections.rule` instead.
      slug: "product_collections", group: "Catalog", singular: "Collection member", plural: "Collection members", defaultSort: "position",
      fields: [
        ...half(
          rel("product", "products", { required: true }),
          rel("collection", "collections", { required: true, uniqueWith: ["product"] }),
        ),
        position("collection"),
      ],
      samples: [
        { product: { ref: "products:0" }, collection: { ref: "collections:0" }, position: 1 },
        { product: { ref: "products:1" }, collection: { ref: "collections:0" }, position: 2 },
      ],
    },
    {
      // BigCommerce `relatedProducts`, widened to carry WHY two products are
      // linked — a cross-sell belongs in the cart, an accessory belongs on the
      // product page, and a storefront that cannot tell them apart shows both in
      // both places.
      slug: "related_products", group: "Catalog", singular: "Related product", plural: "Related products", defaultSort: "position",
      fields: [
        ...half(rel("product", "products", { required: true }), rel("related_product", "products", { required: true, label: "Related to" })),
        ...half(
          // A pair is linked once per KIND — the same two products may be both
          // an accessory and a replacement, but not two accessories.
          select("relation_type", [ch("related", C.gray), ch("upsell", C.green), ch("cross_sell", C.blue, "Cross-sell"), ch("accessory", C.teal), ch("replacement", C.amber)], { default: "related", label: "Kind", uniqueWith: ["product", "related_product"] }),
          position("product"),
        ),
      ],
      samples: [
        { product: { ref: "products:0" }, related_product: { ref: "products:1" }, relation_type: "cross_sell", position: 1 },
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
          ...half(text("sku", { unique: true, label: "SKU" }), text("barcode", { label: "Barcode" })),
          ...half(text("gtin", { label: "GTIN" }), text("mpn", { label: "MPN" })),
        ]),
        sec("Pricing", [
          // Money with its own denomination, like everywhere else amounts are
          // stored. This column used to be a bare number while the PRODUCT's
          // price carried a currency — so the figure that actually reaches a
          // cart was the one nothing protected.
          ...half(moneyIn("price", { required: true }), moneyIn("compare_at_price", { label: "Compare-at price" })),
          ...half(moneyIn("cost", { label: "Cost per item" }), moneyIn("map_price", { label: "Minimum advertised price" })),
          ...half(
            select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
            bool("is_default", { default: false, label: "Default variant" }),
          ),
        ]),
        sec("Inventory", [
          ...half(
            // Summed from the levels rather than typed, because the comment
            // above `inventory_levels` — "not a single int on the variant" —
            // was true of this column too. It held 140 while the variant's one
            // location held 40, and neither number knew about the other.
            rollup(
              "inventory_quantity",
              { from: "inventory_levels", via: "variant", fn: "sum", field: "on_hand" },
              { label: "On hand", description: "Summed across this variant's inventory levels. Stock is edited per location." },
            ),
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
        { product: { ref: "products:0" }, title: "S / Black", sku: "TEE-001-S-BLK", price: 25, cost: 9, currency: "USD", is_default: true, position: 1 },
        { product: { ref: "products:0" }, title: "M / Black", sku: "TEE-001-M-BLK", price: 25, cost: 9, currency: "USD", position: 2 },
        { product: { ref: "products:1" }, title: "Natural", sku: "TOTE-001-NAT", price: 18, cost: 6, currency: "USD", is_default: true, position: 1 },
      ],
    },
    {
      // What makes an option system real: the variant IS its selected values.
      //
      // Without this table a variant's identity is the free text in its
      // `title`, so "Size = M, Colour = Black" cannot be resolved to a unit, a
      // missing combination cannot be detected, and a swatch grid has nothing to
      // bind to. Saleor, Medusa and BigCommerce all carry this link; it was the
      // one piece missing here, and its absence made three collections
      // decorative.
      slug: "variant_option_values", group: "Catalog", singular: "Variant option", plural: "Variant options",
      fields: [
        hint("variant_option_values_shape", "One row per option axis of a variant. Two options means two rows — together they are what the shopper selected."),
        // One row per (variant, option): a variant selects exactly one value on
        // each axis. Without it a variant could claim Size = S AND Size = M at
        // once, which is precisely the unresolvability this table was added to
        // prevent — the swatch grid gets two answers and no rule for picking.
        ...half(
          rel("variant", "product_variants", { required: true }),
          rel("option", "product_options", { required: true, uniqueWith: ["variant"] }),
        ),
        rel("value", "product_option_values", { required: true, label: "Selected value" }),
      ],
      samples: [
        { variant: { ref: "product_variants:0" }, option: { ref: "product_options:0" }, value: { ref: "product_option_values:0" } },
        { variant: { ref: "product_variants:0" }, option: { ref: "product_options:1" }, value: { ref: "product_option_values:3" } },
        { variant: { ref: "product_variants:1" }, option: { ref: "product_options:0" }, value: { ref: "product_option_values:1" } },
        { variant: { ref: "product_variants:1" }, option: { ref: "product_options:1" }, value: { ref: "product_option_values:3" } },
      ],
    },
    {
      // Saleor's assigned attributes, flattened into one row per (thing,
      // attribute). The value lands in the column matching the attribute's
      // input type — a dropdown fills `value_option`, a number fills
      // `value_number`, and reading one means looking at the attribute first.
      slug: "product_attributes", group: "Catalog", singular: "Product attribute", plural: "Product attributes",
      fields: [
        hint("product_attributes_value", "Fill the value column that matches the attribute's input type. A dropdown or swatch uses Value (option); everything else uses one of the typed columns."),
        ...half(rel("product", "products"), rel("variant", "product_variants", { description: "Set only for a variant-scoped attribute." })),
        ...half(rel("attribute", "attributes", { required: true }), rel("value_option", "attribute_values", { label: "Value (option)" })),
        ...half(text("value_text", { label: "Value (text)" }), num("value_number", { label: "Value (number)" })),
        ...half(bool("value_boolean", { default: false, label: "Value (yes/no)" }), ts("value_date", { label: "Value (date)" })),
      ],
      samples: [
        { product: { ref: "products:0" }, attribute: { ref: "attributes:0" }, value_option: { ref: "attribute_values:0" } },
        { product: { ref: "products:0" }, attribute: { ref: "attributes:1" }, value_option: { ref: "attribute_values:2" } },
        { product: { ref: "products:1" }, attribute: { ref: "attributes:0" }, value_option: { ref: "attribute_values:1" } },
      ],
    },
    {
      // BigCommerce's modifiers — the only one of the three that models this,
      // and a real gap in the other two. A modifier changes what happens to the
      // unit (an engraving, a gift message, an extended warranty) without
      // changing WHICH unit leaves the shelf, so it must not create a variant
      // and must not hold stock.
      slug: "product_modifiers", group: "Catalog", singular: "Modifier", plural: "Modifiers", defaultSort: "position",
      fields: [
        hint("product_modifiers_scope", "A modifier never creates a variant and never holds stock — it changes the price, the weight or the instructions attached to a unit."),
        rel("product", "products", { required: true }),
        ...half(
          text("name", { required: true }),
          select("modifier_type", [ch("checkbox", C.blue), ch("text", C.gray), ch("multiline_text", C.gray, "Long text"), ch("number", C.purple), ch("date", C.amber), ch("file", C.slate), ch("choice", C.teal, "Choice list")], { default: "choice", label: "Kind" }),
        ),
        ...half(bool("is_required", { default: false, label: "Required" }), position("product")),
        notes("help_text", { label: "Help text" }),
      ],
      samples: [
        { product: { ref: "products:0" }, name: "Gift message", modifier_type: "multiline_text", is_required: false, position: 1, help_text: "Printed on a card and placed in the parcel." },
        { product: { ref: "products:1" }, name: "Monogram", modifier_type: "text", is_required: false, position: 1, help_text: "Up to three letters, embroidered on the front pocket." },
      ],
    },
    {
      // The choices of a `choice` modifier, with BigCommerce's adjusters: what
      // picking this option does to the price and the weight.
      slug: "modifier_values", group: "Catalog", singular: "Modifier value", plural: "Modifier values", defaultSort: "position",
      fields: [
        ...half(rel("modifier", "product_modifiers", { required: true }), text("label", { required: true })),
        ...half(moneyIn("price_adjustment", { validation: {}, label: "Price adjustment" }), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
        ...half(num("weight_adjustment", { label: "Weight adjustment" }), position("modifier")),
        bool("is_default", { default: false, label: "Default" }),
      ],
      samples: [
        { modifier: { ref: "product_modifiers:1" }, label: "Gold thread", price_adjustment: 5, position: 1, is_default: false },
        { modifier: { ref: "product_modifiers:1" }, label: "White thread", price_adjustment: 0, position: 2, is_default: true },
      ],
    },
    {
      // Saleor's `ProductChannelListing`. `products.status` is the global
      // switch; this is where a product is live on the web store and held back
      // from the marketplace, with its own publication dates.
      slug: "product_channel_listings", group: "Channels & pricing", singular: "Channel listing", plural: "Channel listings",
      fields: [
        hint("listings_precedence", "A product that is draft or archived is off everywhere — this row only narrows a product that is otherwise active."),
        // One listing per (product, channel). Two rows — one saying published,
        // one saying not — left the storefront with no rule for which to read.
        ...half(
          rel("product", "products", { required: true }),
          rel("channel", "channels", { required: true, uniqueWith: ["product"] }),
        ),
        ...half(bool("is_published", { default: true, label: "Published" }), bool("visible_in_listings", { default: true, label: "Show in listings" })),
        ...half(ts("published_at", { indexed: true, label: "Published at" }), ts("available_from", { label: "Buyable from" })),
        position("channel"),
      ],
      samples: [
        { product: { ref: "products:0" }, channel: { ref: "channels:0" }, is_published: true, visible_in_listings: true, position: 1 },
        { product: { ref: "products:1" }, channel: { ref: "channels:0" }, is_published: true, visible_in_listings: true, position: 2 },
        { product: { ref: "products:0" }, channel: { ref: "channels:1" }, is_published: true, visible_in_listings: true, position: 1 },
      ],
    },
    {
      // Medusa's `PriceList` + BigCommerce's price-list assignment in one row.
      //
      // `sale` marks the prices as a temporary reduction (a storefront strikes
      // the old one through); `override` is a different price for a different
      // audience, with nothing to strike through — wholesale, not a sale.
      slug: "price_lists", group: "Channels & pricing", singular: "Price list", plural: "Price lists", defaultSort: "-priority",
      fields: stacked(
        sec("Price list", [
          ...half(text("name", { required: true }), text("code", { label: "Code" })),
          ...half(
            select("list_type", [ch("sale", C.red), ch("override", C.blue)], { default: "sale", label: "Kind" }),
            select("status", [ch("draft", C.gray), ch("active", C.green), ch("expired", C.slate)], { default: "draft" }),
          ),
          notes("description"),
        ]),
        sec("Applies to", [
          hint("price_lists_scope", "Leave a scope blank to mean everyone: a list with no customer group and no channel applies to every shopper."),
          ...half(rel("customer_group", "customer_groups", { label: "Customer group" }), rel("channel", "channels")),
          ...half(
            int("priority", { default: 0, label: "Priority", description: "Highest priority wins where two lists both apply." }),
            flag("active"),
          ),
        ]),
        sec("Schedule", [
          ...half(ts("starts_at", { range: { end: "ends_at" }, indexed: true, label: "Starts at" }), ts("ends_at", { label: "Ends at" })),
        ]),
      ),
      samples: [
        { name: "Wholesale", code: "wholesale", list_type: "override", status: "active", customer_group: { ref: "customer_groups:1" }, priority: 10, active: true, description: "Trade pricing for approved accounts." },
        { name: "Summer sale", code: "summer-sale", list_type: "sale", status: "active", channel: { ref: "channels:0" }, priority: 5, active: true, starts_at: ms("2026-06-01"), ends_at: ms("2026-08-31") },
      ],
    },
    {
      // One row is "what this variant costs, on this list, in this currency, at
      // this quantity". Quantity breaks are the same row with a range rather
      // than a second mechanism — Medusa's `min_quantity`/`max_quantity` and
      // BigCommerce's bulk-pricing tiers land in the same place.
      slug: "prices", group: "Channels & pricing", singular: "Price", plural: "Prices",
      fields: [
        hint("prices_tiers", "Leave the quantity range empty for the ordinary price. A row with a range from 10 is the price once ten are in the basket."),
        ...half(rel("variant", "product_variants", { required: true }), rel("price_list", "price_lists", { label: "On list" })),
        ...half(moneyIn("amount", { required: true }), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
        ...half(
          int("min_quantity", { validation: { min: 1 }, label: "From quantity" }),
          // A tier whose ceiling is below its floor matches no basket at any
          // quantity, so it is not a price anyone will ever be charged — it is
          // a row that looks like one. Refused rather than stored.
          int("max_quantity", {
            validation: { min: 1, rule: { max_quantity: { _gte: "$field.min_quantity" } }, message: "A quantity tier cannot end below the quantity it starts at." },
            label: "To quantity",
          }),
        ),
      ],
      samples: [
        { variant: { ref: "product_variants:0" }, price_list: { ref: "price_lists:0" }, amount: 18, currency: "USD" },
        { variant: { ref: "product_variants:0" }, price_list: { ref: "price_lists:0" }, amount: 15, currency: "USD", min_quantity: 10 },
        { variant: { ref: "product_variants:0" }, price_list: { ref: "price_lists:1" }, amount: 20, currency: "USD" },
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
        // `available` used to be a third number an operator was asked to keep
        // in step with the other two by hand. It is a definition, not a
        // judgement, so the database computes it and nobody can disagree with it.
        hint("levels_available", "On hand is the only number here anyone types. Committed is summed from the reservations still held against this level, and Available is generated as the difference — both are refused as input."),
        // One row per (variant, location) — the pair is what an inventory level
        // IS, and without the constraint three rows for one pair made
        // `sum(available)` answer 146 for a number that should be one. Both ends
        // are required for the same reason: a level naming neither is not a
        // level, and a NULL would slip past the index (NULLs compare distinct).
        ...half(
          rel("variant", "product_variants", { required: true }),
          rel("location", "locations", { required: true, uniqueWith: ["variant"] }),
        ),
        // Denormalised, and deliberately so: it is what lets `products.stock` be
        // a real rollup instead of a number nobody maintains. The product is
        // reachable through `variant`, but a rollup needs a relation ON THE
        // CHILD pointing at the parent it restates, and a chain of two rollups
        // does not refresh.
        //
        // It is NOT part of the (variant, location) key — the variant already
        // determines it, so adding it would only widen the index. The cost is
        // that nothing forces this to agree with `variant.product`; the same
        // trade `inventory_reservations` already makes by carrying `level`,
        // `variant` and `location` at once.
        rel("product", "products", { required: true, label: "Product", description: "The variant's product. Kept here so a product can total its stock; it must match the variant." }),
        ...half(
          int("on_hand", { default: 0, validation: { min: 0 }, label: "On hand" }),
          rollup(
            "committed",
            { from: "inventory_reservations", via: "level", fn: "sum", field: "qty", filter: { status: { _eq: "held" } } },
            { label: "Committed", description: "Summed from the reservations still held against this level — released and consumed ones drop out." },
          ),
        ),
        ...half(
          computedNum("available", "on_hand - committed", { label: "Available" }),
          int("incoming", { default: 0, validation: { min: 0 }, label: "Incoming", description: "On a purchase order and not yet received." }),
        ),
        ...half(
          int("reorder_point", { default: 0, validation: { min: 0 }, label: "Reorder point" }),
          int("safety_stock", { default: 0, validation: { min: 0 }, label: "Safety stock" }),
        ),
      ],
      samples: [
        { product: { ref: "products:0" }, variant: { ref: "product_variants:0" }, location: { ref: "locations:0" }, on_hand: 40, reorder_point: 10, safety_stock: 5 },
        { product: { ref: "products:0" }, variant: { ref: "product_variants:1" }, location: { ref: "locations:0" }, on_hand: 50, reorder_point: 10, safety_stock: 5 },
        { product: { ref: "products:1" }, variant: { ref: "product_variants:2" }, location: { ref: "locations:1" }, on_hand: 60, reorder_point: 15, safety_stock: 5 },
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
          ...half(
            text("locale", { label: "Preferred language", description: "BCP-47 tag used to pick a translation, e.g. tr." }),
            userLink(),
          ),
        ]),
        sec("Marketing", [
          bool("accepts_marketing", { default: false, label: "Accepts marketing" }),
          tags("tags"),
        ]),
        sec("Activity", [
          ...half(
            select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD", description: "The unit the two amounts below are kept in." }),
            rollup(
              "orders_count",
              { from: "orders", via: "customer", fn: "count", filter: { state: { _neq: "cancelled" } } },
              { label: "Orders count", description: "Counted from this customer's orders, cancelled ones excluded." },
            ),
          ),
          ...half(
            // NOT a rollup, and it cannot be one: a money rollup is refused
            // when either side is denominated per row, which both of these are.
            // Summing a customer's orders across currencies would need an
            // exchange rate the sum does not have.
            moneyIn("total_spent", { default: 0, label: "Total spent", description: "Kept by whatever records the payment — a money total cannot be summed across an order history in several currencies." }),
            moneyIn("store_credit", { default: 0, label: "Store credit" }),
          ),
          bool("tax_exempt", { default: false, label: "Tax exempt" }),
          notes("note", { label: "Internal note" }),
        ]),
      ),
      samples: [
        { email: "jordan@example.com", first_name: "Jordan", last_name: "Reed", phone: "+15555550100", state: "enabled", customer_group: { ref: "customer_groups:0" }, total_spent: 43 },
        { email: "sam@example.com", first_name: "Sam", last_name: "Taylor", phone: "+15555550142", state: "enabled", customer_group: { ref: "customer_groups:1" }, total_spent: 18 },
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
      // The other half of `selling_plans`. A plan is an offer; this is somebody
      // who took it — which is what nothing recorded before, so a store could
      // advertise "deliver every month" and had nowhere to say who was on it or
      // when they are next billed.
      slug: "subscriptions", group: "Catalog", singular: "Subscription", plural: "Subscriptions", defaultSort: "next_billing_at",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Subscription", [
          ...half(rel("customer", "customers", { required: true }), rel("selling_plan", "selling_plans", { required: true, label: "Plan" })),
          ...half(rel("variant", "product_variants", { required: true }), int("quantity", { default: 1, validation: { min: 1 } })),
          ...half(
            select("status", [ch("active", C.green), ch("paused", C.amber), ch("cancelled", C.gray), ch("expired", C.slate)], {
              default: "active",
              ...flow(
                { active: ["paused", "cancelled"], paused: ["active", "cancelled"] },
                { initial: ["active"], labels: { paused: "Pause", active: "Resume", cancelled: "Cancel" } },
              ),
            }),
            rel("shipping_address", "addresses", { label: "Ship to" }),
          ),
        ]),
        sec("Billing", [
          ...half(ts("started_at", { indexed: true, label: "Started at" }), ts("next_billing_at", { indexed: true, label: "Next billing" })),
          ...half(int("cycles_completed", { default: 0, validation: { min: 0 }, label: "Cycles billed" }), ts("cancelled_at", { label: "Cancelled at" })),
        ]),
        sec("Notes", [notes("note")]),
      ),
      samples: [
        { customer: { ref: "customers:0" }, selling_plan: { ref: "selling_plans:0" }, variant: { ref: "product_variants:0" }, quantity: 1, status: "active", shipping_address: { ref: "addresses:0" }, started_at: ms("2026-01-12"), next_billing_at: ms("2026-02-12"), cycles_completed: 1 },
      ],
    },
    {
      // BigCommerce is the only one of the three that models a wishlist, and it
      // is the one shoppers ask for. `token` is what makes a public list
      // shareable without exposing the customer id.
      slug: "wishlists", group: "Customers", singular: "Wishlist", plural: "Wishlists", ownerScoped: true, defaultSort: "-created_at",
      fields: [
        ...half(rel("customer", "customers", { required: true }), text("name", { required: true, default: "Wishlist" })),
        ...half(
          bool("is_public", { default: false, label: "Shareable" }),
          // The token IS the authorisation for a public list — anyone holding
          // it sees a named person's saved items. Generate it, never type it.
          text("token", { indexed: true, unique: true, label: "Share token", description: "A random, unguessable value your app generates — the share link is the only thing protecting a public list." }),
        ),
      ],
      samples: [{ customer: { ref: "customers:0" }, name: "Gift ideas", is_public: false }],
    },
    {
      // Owner-scoped like its parent, deliberately. A list is one shopper's and
      // the lines are the list — scoping only the parent would mean a grant on
      // the child (the natural one for "let people manage their own wishlist")
      // handed every shopper everybody else's.
      slug: "wishlist_items", group: "Customers", singular: "Wishlist item", plural: "Wishlist items", ownerScoped: true, defaultSort: "position",
      fields: [
        ...half(
          rel("wishlist", "wishlists", { required: true }),
          rel("product", "products", { required: true, uniqueWith: ["wishlist"] }),
        ),
        ...half(rel("variant", "product_variants"), position("wishlist")),
      ],
      samples: [{ wishlist: { ref: "wishlists:0" }, product: { ref: "products:1" }, variant: { ref: "product_variants:2" }, position: 1 },
      ],
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
      // One collection for coded discounts AND automatic promotions, which is
      // Medusa's arrangement and the better one: Saleor keeps `Voucher` and
      // `Promotion` apart and then has to duplicate scheduling, budgets,
      // stacking and channel scope across both. Here a coupon is a promotion
      // that happens to have a code.
      slug: "discounts", group: "Marketing", singular: "Discount", plural: "Discounts", defaultSort: "-starts_at",
      fields: tabbed(
        sec("Discount", [
          ...half(text("name", { required: true }), text("code", { unique: true, description: "Leave empty for a promotion that applies without a code." })),
          ...half(
            bool("automatic", { default: false, label: "Applies automatically" }),
            select("status", [ch("draft", C.gray), ch("scheduled", C.blue), ch("active", C.green), ch("expired", C.slate)], { default: "active" }),
          ),
          ...half(
            select("discount_type", [ch("standard", C.blue), ch("buy_get", C.purple, "Buy X get Y")], { default: "standard", label: "Kind" }),
            select("value_type", [ch("percentage", C.blue), ch("fixed_amount", C.teal), ch("free_shipping", C.purple)], { default: "percentage", label: "Value type" }),
          ),
          ...half(
            num("value", { validation: { min: 0 } }),
            select("target_type", [ch("items", C.blue), ch("shipping", C.teal), ch("order", C.purple)], { default: "items", label: "Applies to" }),
          ),
          select("allocation", [ch("across", C.blue, "Across the matching items"), ch("each", C.teal, "To each matching item")], { default: "across", label: "Allocation" }),
        ]),
        sec("Buy & get", [
          hint("discounts_buyget", "Only read for a Buy X get Y discount. The rules tab decides which items count as the X and which as the Y."),
          ...half(
            int("buy_quantity", { validation: { min: 1 }, label: "Buy quantity", conditions: [when("discount_type", "_neq", "buy_get", "hidden")] }),
            int("get_quantity", { validation: { min: 1 }, label: "Get quantity", conditions: [when("discount_type", "_neq", "buy_get", "hidden")] }),
          ),
          pct("get_discount_pct", { default: 100, label: "Discount on the free items (%)", conditions: [when("discount_type", "_neq", "buy_get", "hidden")] }),
        ]),
        sec("Limits", [
          ...half(
            select("target_selection", [ch("all", C.gray), ch("entitled", C.amber)], { default: "all", label: "Scope", description: "Entitled means only what the rules tab names — and with no target rule there, it names nothing and the discount comes off nothing." }),
            select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD", description: "The unit a fixed-amount value and the minimum below are in." }),
          ),
          ...half(
            moneyIn("minimum_amount", { label: "Minimum order amount" }),
            int("min_item_qty", { validation: { min: 0 }, label: "Minimum items" }),
          ),
          ...half(
            int("usage_limit", { validation: { min: 0 }, label: "Usage limit" }),
            int("usage_count", { default: 0, validation: { min: 0 }, label: "Times used" }),
          ),
          ...half(
            bool("once_per_customer", { default: false, label: "Once per customer" }),
            bool("combinable", { default: false, label: "Stacks with others" }),
          ),
          int("priority", { default: 0, label: "Priority", description: "Highest priority is applied first when two discounts both qualify." }),
        ]),
        sec("Schedule", [
          ...half(ts("starts_at", { range: { end: "ends_at" }, indexed: true, label: "Starts at" }), ts("ends_at", { label: "Ends at" })),
        ]),
      ),
      samples: [
        { name: "Welcome 10%", code: "WELCOME10", automatic: false, discount_type: "standard", value_type: "percentage", value: 10, target_type: "items", allocation: "across", target_selection: "all", status: "active", starts_at: ms("2026-01-01"), ends_at: ms("2026-12-31") },
        { name: "Free shipping over $75", automatic: true, discount_type: "standard", value_type: "free_shipping", value: 0, target_type: "shipping", allocation: "across", target_selection: "all", minimum_amount: 75, status: "active", priority: 5, starts_at: ms("2026-01-01") },
      ],
    },
    {
      // What a discount is FOR, and what qualifies an order for it. The old
      // model offered `target_selection: entitled` with nothing to point at, so
      // the choice could be made and meant nothing; Saleor writes this as a
      // JSON predicate and Medusa as attribute/operator/values rows. Rows, here
      // — a merchant can author one in the admin without writing JSON.
      slug: "discount_rules", group: "Marketing", singular: "Discount rule", plural: "Discount rules",
      fields: [
        hint("discount_rules_scope", "A `target` rule says which items the discount comes off. A `condition` rule says what the order must satisfy for it to apply at all."),
        ...half(rel("discount", "discounts", { required: true }), select("scope", [ch("target", C.green), ch("condition", C.blue)], { default: "target" })),
        ...half(
          select("attribute", [ch("product", C.blue), ch("collection", C.purple), ch("category", C.teal), ch("brand", C.amber), ch("tag", C.gray), ch("customer_group", C.slate, "Customer group"), ch("country", C.gray), ch("subtotal", C.green)], { default: "product" }),
          select("operator", [ch("in", C.teal, "in"), ch("nin", C.red, "not in"), ch("eq", C.gray, "is"), ch("gt", C.blue, ">"), ch("gte", C.blue, "≥"), ch("lt", C.amber, "<"), ch("lte", C.amber, "≤")], { default: "in" }),
        ),
        ...half(rel("product", "products"), rel("collection", "collections")),
        ...half(rel("category", "categories"), text("value", { description: "Used when the attribute is not one of the relations above." })),
      ],
      samples: [
        { discount: { ref: "discounts:1" }, scope: "condition", attribute: "country", operator: "in", value: "US,CA" },
      ],
    },
    {
      // Pre-checkout basket (Medusa Cart) — the abandoned-cart recovery surface.
      slug: "carts", group: "Orders", singular: "Cart", plural: "Carts", defaultSort: "-updated_at",
      fields: stacked(
        sec("Cart", [
          ...half(rel("customer", "customers"), email("email")),
          ...half(
            rel("channel", "channels"),
            select("status", [ch("active", C.blue), ch("completed", C.green), ch("abandoned", C.amber)], { default: "active" }),
          ),
          ...half(
            // Kept by the server from the cart's own lines, so an abandoned-cart
            // report never disagrees with what is in the basket.
            rollup("item_count", { from: "cart_items", via: "cart", fn: "sum", field: "qty" }, { label: "Items" }),
            moneyIn("subtotal"),
          ),
          ...half(select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }), moneyIn("discount_total", { label: "Discounts" })),
          moneyIn("tax_total", { label: "Tax" }),
        ]),
        sec("Recovery", [
          ...half(
            ts("abandoned_at", { indexed: true, label: "Abandoned at" }),
            bool("recovery_email_sent", { default: false, label: "Recovery email sent" }),
          ),
        ]),
      ),
      samples: [
        { customer: { ref: "customers:1" }, email: "sam@example.com", channel: { ref: "channels:0" }, status: "abandoned", subtotal: 61, currency: "USD", abandoned_at: ms("2026-01-15"), recovery_email_sent: false },
      ],
    },
    {
      // The lines a cart is made of — absent before, which left an abandoned
      // basket as two scalars: a count and a total. A recovery email could not
      // name what was left behind, and nothing could be carried into an order.
      slug: "cart_items", group: "Orders", singular: "Cart item", plural: "Cart items",
      // Sectioned like `order_items`, which is the row this one becomes at
      // checkout — two shapes a person reads side by side should not be laid
      // out differently.
      fields: stacked(
        sec("Line", [
          hint("cart_items_snapshot", "Title, SKU and unit price are snapshots taken when the line was added — a catalog price change must not silently reprice a basket somebody is looking at."),
          ...half(rel("cart", "carts", { required: true }), rel("product", "products")),
          ...half(rel("variant", "product_variants"), text("title", { label: "Title (snapshot)" })),
          ...half(text("sku", { label: "SKU (snapshot)" }), int("qty", { default: 1, validation: { min: 1 } })),
        ]),
        sec("Amounts", [
          ...half(moneyIn("unit_price"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
          ...half(bool("gift_wrap", { default: false, label: "Gift wrap" }), tags("selected_options", { label: "Selected options", description: "The modifier choices on this line, as name/value pairs." })),
        ]),
      ),
      samples: [
        { cart: { ref: "carts:0" }, product: { ref: "products:0" }, variant: { ref: "product_variants:1" }, title: "Classic Tee — M / Black", sku: "TEE-001-M-BLK", qty: 1, unit_price: 25 },
        { cart: { ref: "carts:0" }, product: { ref: "products:1" }, variant: { ref: "product_variants:2" }, title: "Canvas Tote", sku: "TOTE-001-NAT", qty: 2, unit_price: 18 },
      ],
    },
    {
      slug: "orders", group: "Orders", singular: "Order", plural: "Orders", defaultSort: "-placed_at",
      kanbanGroupBy: "fulfillment_status",
      fields: tabbed(
        sec("Order", [
          ...half(seq("number", "ORD-{YYYY}-{#####}"), ts("placed_at", { indexed: true, label: "Placed at" })),
          // Three axes, and they answer three different questions. `state` is
          // the order's own life: a cancelled order is cancelled whatever its
          // payment says. Cancellation used to be a value of the payment column
          // (`voided`), which is why every KPI that filtered `status != cancelled`
          // filtered nothing and counted cancelled orders into revenue.
          ...half(
            select("state", [ch("draft", C.gray), ch("open", C.blue), ch("completed", C.green), ch("cancelled", C.red)], {
              default: "open",
              label: "Order state",
              ...flow(
                { draft: ["open", "cancelled"], open: ["completed", "cancelled"], completed: ["cancelled"] },
                { initial: ["draft", "open"], labels: { open: "Place", completed: "Complete", cancelled: "Cancel" } },
              ),
            }),
            select("status", [ch("pending", C.amber), ch("authorized", C.blue), ch("partially_paid", C.amber, "Partially paid"), ch("paid", C.green), ch("partially_refunded", C.purple, "Partially refunded"), ch("refunded", C.gray), ch("voided", C.red)], { default: "pending", label: "Payment status" }),
          ),
          ...half(
            select("fulfillment_status", [ch("unfulfilled", C.gray), ch("partial", C.amber), ch("fulfilled", C.green), ch("restocked", C.slate)], { default: "unfulfilled", label: "Fulfillment status" }),
            rel("channel", "channels", { label: "Sold through" }),
          ),
          ...half(rel("customer", "customers"), email("email")),
          // The marketplace's own handle for this order's shipment package.
          // A marketplace's status notifications address the PACKAGE, not the
          // order, so an order pulled in from one has nowhere to be notified
          // about without this — it is what the Trendyol tasks' package-id
          // setting is pointed at.
          text("marketplace_package_id", { indexed: true, label: "Marketplace package ID" }),
        ]),
        sec("Delivery", [
          ...half(rel("shipping_address", "addresses", { label: "Ship to" }), rel("billing_address", "addresses", { label: "Bill to" })),
          ...half(rel("shipping_rate", "shipping_rates", { label: "Shipping method" }), rel("discount", "discounts", { label: "Discount applied" })),
        ]),
        sec("Totals", [
          hint("orders_totals", "Totals are a snapshot taken at checkout — edit them only to correct a mistake, never to discount an order after the fact."),
          ...half(moneyIn("subtotal"), moneyIn("total_tax", { label: "Tax" })),
          ...half(moneyIn("total_shipping", { label: "Shipping" }), moneyIn("total_discounts", { label: "Discounts" })),
          ...half(moneyIn("gift_card_total", { label: "Paid by gift card" }), moneyIn("total_fees", { label: "Fees" })),
          ...half(moneyIn("total", { label: "Total" }), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
          num("exchange_rate", { default: 1, validation: { min: 0 }, label: "Rate to store currency", description: "What the order's currency was worth against the store default when it was placed." }),
        ]),
        sec("Meta", [
          tags("tags"),
          notes("note"),
          ...half(
            select("cancel_reason", [ch("customer", C.gray), ch("fraud", C.red), ch("inventory", C.amber), ch("declined", C.red), ch("other", C.slate)], {
              label: "Cancel reason",
              // Asked for exactly when an order is being cancelled, and out of
              // the way otherwise — a permanent "why was this cancelled?" box on
              // a live order is a question with no answer.
              conditions: [when("state", "_eq", "cancelled", "required"), when("state", "_neq", "cancelled", "hidden")],
            }),
            ts("cancelled_at", { indexed: true, label: "Cancelled at", conditions: [when("state", "_neq", "cancelled", "hidden")] }),
          ),
        ]),
      ),
      samples: [
        { customer: { ref: "customers:0" }, email: "jordan@example.com", state: "completed", status: "paid", fulfillment_status: "fulfilled", channel: { ref: "channels:0" }, shipping_address: { ref: "addresses:0" }, shipping_rate: { ref: "shipping_rates:0" }, subtotal: 43, total_shipping: 6.5, total: 49.5, currency: "USD", exchange_rate: 1, placed_at: ms("2026-01-12") },
        { customer: { ref: "customers:1" }, email: "sam@example.com", state: "open", status: "pending", fulfillment_status: "unfulfilled", channel: { ref: "channels:0" }, subtotal: 18, total: 18, currency: "USD", exchange_rate: 1, placed_at: ms("2026-01-14") },
      ],
    },
    {
      slug: "order_items", group: "Orders", singular: "Order item", plural: "Order items",
      // Fourteen storage columns since every amount gained its denomination —
      // past the point a form fits one screen, so the sections become tabs.
      fields: tabbed(
        sec("Line", [
          hint("order_items_total", "Line total is generated by the database as qty × unit price — it can't be typed in. Tax is per line because one order routinely mixes rates."),
          ...half(rel("order", "orders"), rel("product", "products")),
          ...half(rel("variant", "product_variants"), text("title", { label: "Title (snapshot)" })),
          ...half(text("sku", { label: "SKU (snapshot)" }), int("qty", { default: 1, validation: { min: 1 } })),
          tags("selected_options", { label: "Selected options", description: "The modifier choices this line was bought with." }),
        ]),
        sec("Amounts", [
          ...half(moneyIn("unit_price"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
          ...half(moneyIn("total_discount", { label: "Line discount" }), moneyIn("tax_amount", { label: "Tax" })),
          ...half(
            num("tax_rate", { validation: { min: 0, max: 100 }, label: "Tax rate (%)", format: { style: "percent100", precision: 2 } }),
            rel("tax_class", "tax_classes", { label: "Tax class" }),
          ),
          computedMoneyIn("line_total", "qty * unit_price", { label: "Line total" }),
        ]),
      ),
      samples: [
        { order: { ref: "orders:0" }, product: { ref: "products:0" }, variant: { ref: "product_variants:0" }, title: "Classic Tee — S / Black", sku: "TEE-001-S-BLK", qty: 1, unit_price: 25, tax_rate: 8.5, tax_amount: 2.13, tax_class: { ref: "tax_classes:0" } },
        { order: { ref: "orders:0" }, product: { ref: "products:1" }, variant: { ref: "product_variants:2" }, title: "Canvas Tote", sku: "TOTE-001-NAT", qty: 1, unit_price: 18, tax_rate: 8.5, tax_amount: 1.53, tax_class: { ref: "tax_classes:0" } },
      ],
    },
    {
      // Which discount took how much off what. `orders.total_discounts` is the
      // sum; this is the working. Without it an order says money came off and
      // cannot say why, which is the first question asked about every one.
      slug: "order_discounts", group: "Orders", singular: "Order discount", plural: "Order discounts",
      fields: [
        hint("order_discounts_scope", "Leave the line empty for a discount that came off the order as a whole; name a line for one allocated to a single item."),
        ...half(rel("order", "orders", { required: true }), rel("order_item", "order_items", { label: "On line" })),
        ...half(rel("discount", "discounts"), text("code", { label: "Code used" })),
        ...half(moneyIn("amount", { required: true }), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
        text("description"),
      ],
      samples: [
        { order: { ref: "orders:0" }, discount: { ref: "discounts:1" }, amount: 6.5, description: "Free shipping over $75" },
      ],
    },
    {
      // BigCommerce splits an order into consignments by DESTINATION and
      // delivery kind, which is what makes both split shipments and collect-in-
      // store expressible. Saleor gets partway with a collection point on the
      // order; a single shipping address, as here before, gets nowhere.
      slug: "consignments", group: "Orders", singular: "Consignment", plural: "Consignments",
      fields: [
        hint("consignments_kinds", "One consignment per destination. A pickup consignment names a location instead of an address; a digital one needs neither."),
        ...half(rel("order", "orders", { required: true }), select("consignment_type", [ch("shipping", C.blue), ch("pickup", C.teal), ch("digital", C.purple)], { default: "shipping", label: "Kind" })),
        ...half(rel("shipping_address", "addresses", { label: "Ship to" }), rel("pickup_location", "locations", { label: "Collect from" })),
        ...half(rel("shipping_rate", "shipping_rates", { label: "Shipping method" }), moneyIn("shipping_cost", { label: "Shipping cost" })),
        ...half(select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }), select("status", [ch("pending", C.amber), ch("ready", C.blue), ch("shipped", C.teal), ch("delivered", C.green), ch("collected", C.green), ch("cancelled", C.red)], { default: "pending" })),
      ],
      samples: [
        { order: { ref: "orders:0" }, consignment_type: "shipping", shipping_address: { ref: "addresses:0" }, shipping_rate: { ref: "shipping_rates:0" }, shipping_cost: 6.5, status: "delivered" },
      ],
    },
    {
      slug: "fulfillments", group: "Orders", singular: "Fulfillment", plural: "Fulfillments", defaultSort: "-shipped_at",
      fields: tabbed(
        sec("Fulfillment", [
          ...half(rel("order", "orders"), rel("consignment", "consignments", { label: "For consignment" })),
          ...half(
            rel("location", "locations", { label: "Shipped from" }),
            select("status", [ch("pending", C.amber), ch("open", C.blue), ch("success", C.green), ch("cancelled", C.red)], { default: "pending" }),
          ),
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
      samples: [{ order: { ref: "orders:0" }, consignment: { ref: "consignments:0" }, location: { ref: "locations:0" }, status: "success", tracking_number: "1Z999AA10123456784", tracking_company: "UPS", shipment_status: "delivered", shipped_at: ms("2026-01-13") }],
    },
    {
      // What was in the box. A fulfillment used to point at an order and no
      // further, so `fulfillment_status: "partial"` was a value nothing could
      // substantiate — a two-parcel order could not say which parcel held what.
      slug: "fulfillment_items", group: "Orders", singular: "Fulfilled item", plural: "Fulfilled items",
      fields: [
        // One row per (fulfillment, order line): a parcel says how many of a
        // line it holds once, not twice.
        ...half(
          rel("fulfillment", "fulfillments", { required: true }),
          rel("order_item", "order_items", { required: true, uniqueWith: ["fulfillment"] }),
        ),
        int("qty", { default: 1, validation: { min: 1 }, label: "Quantity shipped" }),
      ],
      samples: [
        { fulfillment: { ref: "fulfillments:0" }, order_item: { ref: "order_items:0" }, qty: 1 },
        { fulfillment: { ref: "fulfillments:0" }, order_item: { ref: "order_items:1" }, qty: 1 },
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
        ...half(
          text("reference", { indexed: true, label: "Provider reference", description: "The gateway's own id for this movement — what a reconciliation matches on." }),
          text("payment_method", { label: "Method" }),
        ),
      ],
      samples: [{ order: { ref: "orders:0" }, kind: "sale", status: "success", amount: 43, currency: "USD", gateway: "stripe", reference: "pi_3ORD0001", payment_method: "card", processed_at: ms("2026-01-12") }],
    },
    {
      // Money back out (Shopify/Vendure Refund) — kept separate from the
      // transaction ledger so partial refunds carry their own reason + restock.
      slug: "refunds", group: "Post-purchase", singular: "Refund", plural: "Refunds", defaultSort: "-processed_at",
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
      // Medusa's `ReturnReason`, and the reason it is a table: "why do we get
      // returns" is a question a free-text column can never answer. The parent
      // link is what lets "too small" and "too large" both roll up to "fit".
      slug: "return_reasons", group: "Post-purchase", singular: "Return reason", plural: "Return reasons", defaultSort: "position",
      fields: [
        ...half(text("name", { required: true }), text("code", { label: "Code" })),
        ...half(parent("return_reasons"), position("parent")),
        flag("active"),
      ],
      samples: [
        { name: "Fit", code: "fit", position: 1, active: true },
        { name: "Damaged in transit", code: "damaged", position: 2, active: true },
        { name: "Not as described", code: "not-as-described", position: 3, active: true },
        { name: "Changed my mind", code: "changed-mind", position: 4, active: true },
      ],
    },
    {
      // RMA. One collection for returns, exchanges and claims, distinguished by
      // `return_type`: Medusa models the three as separate entities that share
      // almost every column, and the difference between them is what happens
      // after the goods come back, not what the request itself looks like.
      slug: "returns", group: "Post-purchase", singular: "Return", plural: "Returns", defaultSort: "-requested_at",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Return", [
          ...half(seq("number", "RMA-{#####}", { label: "RMA number" }), rel("order", "orders")),
          ...half(
            select("return_type", [ch("return", C.blue), ch("exchange", C.purple), ch("claim", C.amber)], { default: "return", label: "Kind", description: "A return refunds, an exchange ships a replacement, a claim is for goods that arrived damaged." }),
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
          ),
          ...half(
            rel("refund", "refunds", { label: "Linked refund" }),
            rel("replacement_order", "orders", { label: "Replacement order", conditions: [when("return_type", "_eq", "return", "hidden")] }),
          ),
        ]),
        sec("Handling", [
          ...half(ts("requested_at", { indexed: true, label: "Requested at" }), ts("received_at", { label: "Received at" })),
          ...half(text("tracking_number", { label: "Return tracking" }), moneyIn("restocking_fee", { label: "Restocking fee" })),
          ...half(select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }), rel("location", "locations", { label: "Returned to" })),
          notes("note"),
        ]),
      ),
      samples: [{ order: { ref: "orders:0" }, return_type: "return", status: "completed", refund: { ref: "refunds:0" }, requested_at: ms("2026-01-17"), received_at: ms("2026-01-19"), location: { ref: "locations:0" }, note: "Customer returned the tote." }],
    },
    {
      slug: "return_items", group: "Post-purchase", singular: "Return item", plural: "Return items",
      fields: [
        ...half(rel("return", "returns"), rel("order_item", "order_items")),
        ...half(
          int("qty", { default: 1, validation: { min: 1 }, label: "Requested" }),
          int("received_qty", { default: 0, validation: { min: 0 }, label: "Received" }),
        ),
        ...half(
          int("damaged_qty", { default: 0, validation: { min: 0 }, label: "Damaged" }),
          select("condition", [ch("resellable", C.green), ch("damaged", C.red), ch("opened", C.amber)], { default: "resellable" }),
        ),
        rel("reason", "return_reasons"),
        notes("note"),
      ],
      samples: [{ return: { ref: "returns:0" }, order_item: { ref: "order_items:1" }, qty: 1, received_qty: 1, damaged_qty: 1, condition: "damaged", reason: { ref: "return_reasons:1" }, note: "Torn strap" }],
    },
    {
      // Saleor's `Allocation` / Medusa's `Reservation`. `inventory_levels.committed`
      // is the total; this is who is holding it. Without these rows a held unit
      // cannot be released when its order is cancelled, and a stuck `committed`
      // makes stock disappear with no way to find it.
      slug: "inventory_reservations", group: "Inventory", singular: "Reservation", plural: "Reservations", defaultSort: "-created_at",
      fields: [
        hint("reservations_committed", "The open reservations against a level are what its Committed number means. Release one when the order is cancelled; consume it when the goods ship."),
        // The link that makes the sentence above TRUE.
        //
        // A reservation named a variant and a location, and an inventory level
        // names the same pair — but nothing joined the two, so `committed` could
        // not be derived from anything and was a number an operator was asked to
        // keep in step by hand. It never was: a held reservation left `committed`
        // at zero, and `available` (generated as on hand minus committed) went on
        // reporting the reserved units as sellable. Same shape as the missing
        // `variant_option_values` link one release earlier — three collections
        // that look related and are not.
        rel("level", "inventory_levels", { required: true, label: "Against level" }),
        ...half(rel("variant", "product_variants", { required: true }), rel("location", "locations", { required: true })),
        ...half(rel("order", "orders"), rel("order_item", "order_items")),
        ...half(
          int("qty", { default: 1, validation: { min: 1 }, label: "Quantity held" }),
          select("status", [ch("held", C.amber), ch("released", C.gray), ch("consumed", C.green)], { default: "held" }),
        ),
        ts("expires_at", { indexed: true, label: "Expires at", description: "When an unconverted basket's hold lapses." }),
      ],
      samples: [
        { level: { ref: "inventory_levels:1" }, variant: { ref: "product_variants:1" }, location: { ref: "locations:0" }, order: { ref: "orders:1" }, qty: 1, status: "held", expires_at: ms("2026-01-16") },
      ],
    },
    {
      // The audit trail behind every number on an inventory level. A level says
      // what is there now; this says how it got there, which is the only way a
      // stock discrepancy is ever explained.
      slug: "stock_movements", group: "Inventory", singular: "Stock movement", plural: "Stock movements", defaultSort: "-occurred_at",
      fields: [
        // A movement is ONE location's ledger entry, and `transfer` is the kind
        // that reads as if it should name two. It deliberately does not: the
        // per-location question every stock report asks is `SUM(qty) WHERE
        // location = X`, and a single row holding both ends would have to be
        // special-cased out of that sum by every reader. So a transfer is the
        // pair of signed rows, and the hint below says so — the gap was never a
        // missing column, it was that nothing told two operators to record it
        // the same way.
        hint(
          "movements_transfer",
          "One row per location. A transfer is TWO rows sharing a reference — negative where the goods left, positive where they arrived — so every location's running total stays a plain sum of its own rows.",
        ),
        ...half(rel("variant", "product_variants", { required: true }), rel("location", "locations", { required: true })),
        ...half(
          select("movement_type", [ch("receipt", C.green), ch("sale", C.blue), ch("return", C.teal), ch("adjustment", C.amber), ch("transfer", C.purple), ch("shrinkage", C.red)], { default: "adjustment", label: "Kind" }),
          int("qty", { label: "Quantity", description: "Signed: negative takes stock away." }),
        ),
        ...half(text("reference", { indexed: true, description: "Order number, PO number, count sheet or transfer number this movement came from — and what joins the two halves of a transfer." }), ts("occurred_at", { indexed: true, label: "Occurred at" })),
        notes("note"),
      ],
      samples: [
        { variant: { ref: "product_variants:0" }, location: { ref: "locations:0" }, movement_type: "receipt", qty: 40, reference: "PO-1001", occurred_at: ms("2026-01-05") },
        { variant: { ref: "product_variants:0" }, location: { ref: "locations:0" }, movement_type: "sale", qty: -1, reference: "ORD-2026-00001", occurred_at: ms("2026-01-12") },
      ],
    },
    {
      slug: "gift_cards", group: "Marketing", singular: "Gift card", plural: "Gift cards", defaultSort: "-created_at",
      fields: [
        hint("gift_cards_balance", "Balance is the running figure operators read. Every change to it should also land as a gift-card transaction, which is what makes it auditable."),
        ...half(text("code", { unique: true, required: true, label: "Code" }), rel("customer", "customers")),
        ...half(moneyIn("initial_value", { label: "Initial value" }), moneyIn("balance", { label: "Balance" })),
        ...half(
          select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
          select("status", [ch("enabled", C.green), ch("disabled", C.gray), ch("expired", C.slate)], { default: "enabled" }),
        ),
        date("expires_at", { indexed: true, label: "Expires at" }),
      ],
      samples: [{ code: "GIFT-AB12-CD34", initial_value: 50, balance: 50, currency: "USD", customer: { ref: "customers:0" }, status: "enabled", expires_at: ms("2027-12-31") }],
    },
    {
      // Saleor keeps a `GiftCardEvent` ledger and Medusa a store-credit account
      // with credits and debits; a bare `balance` column, as here before, is a
      // number that changed and cannot say why or against which order.
      slug: "gift_card_transactions", group: "Marketing", singular: "Gift card entry", plural: "Gift card entries", defaultSort: "-occurred_at",
      fields: [
        ...half(rel("gift_card", "gift_cards", { required: true }), rel("order", "orders")),
        ...half(
          select("txn_type", [ch("issue", C.green), ch("redeem", C.blue), ch("refund", C.teal), ch("adjust", C.amber), ch("expire", C.gray)], { default: "redeem", label: "Kind" }),
          moneyIn("amount", { required: true, description: "Signed: a redemption is negative." }),
        ),
        ...half(select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }), ts("occurred_at", { indexed: true, label: "Occurred at" })),
        notes("note"),
      ],
      samples: [
        { gift_card: { ref: "gift_cards:0" }, txn_type: "issue", amount: 50, currency: "USD", occurred_at: ms("2026-01-02"), note: "Issued at purchase." },
      ],
    },
  ],
  roles: [
    {
      name: "Store staff",
      description: "Day-to-day store operations: manage orders, fulfillments, returns and stock; read the catalog, pricing and customers.",
      permissions: [
        { collection: "orders", action: "read" },
        { collection: "orders", action: "update" },
        { collection: "order_items", action: "read" },
        { collection: "order_discounts", action: "read" },
        { collection: "consignments", action: "read" },
        { collection: "consignments", action: "create" },
        { collection: "consignments", action: "update" },
        { collection: "fulfillments", action: "read" },
        { collection: "fulfillments", action: "create" },
        { collection: "fulfillments", action: "update" },
        { collection: "fulfillment_items", action: "read" },
        { collection: "fulfillment_items", action: "create" },
        { collection: "fulfillment_items", action: "update" },
        { collection: "transactions", action: "read" },
        { collection: "returns", action: "read" },
        { collection: "returns", action: "create" },
        { collection: "returns", action: "update" },
        { collection: "return_items", action: "read" },
        { collection: "return_items", action: "create" },
        { collection: "return_items", action: "update" },
        { collection: "return_reasons", action: "read" },
        { collection: "refunds", action: "read" },
        { collection: "products", action: "read" },
        { collection: "product_variants", action: "read" },
        { collection: "product_options", action: "read" },
        { collection: "product_option_values", action: "read" },
        { collection: "variant_option_values", action: "read" },
        { collection: "product_modifiers", action: "read" },
        { collection: "modifier_values", action: "read" },
        { collection: "product_channel_listings", action: "read" },
        { collection: "price_lists", action: "read" },
        { collection: "prices", action: "read" },
        { collection: "channels", action: "read" },
        { collection: "currencies", action: "read" },
        { collection: "inventory_levels", action: "read" },
        { collection: "inventory_levels", action: "update" },
        { collection: "inventory_reservations", action: "read" },
        { collection: "inventory_reservations", action: "update" },
        { collection: "stock_movements", action: "read" },
        { collection: "stock_movements", action: "create" },
        { collection: "locations", action: "read" },
        { collection: "customers", action: "read" },
        { collection: "addresses", action: "read" },
        { collection: "carts", action: "read" },
        { collection: "cart_items", action: "read" },
        { collection: "subscriptions", action: "read" },
        { collection: "subscriptions", action: "update" },
        { collection: "gift_cards", action: "read" },
        { collection: "gift_card_transactions", action: "read" },
        { collection: "gift_card_transactions", action: "create" },
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
        { name: "Orders by state", kind: "items-aggregate", viz: "donut", config: { collection: "orders", agg: "count", groupBy: "state" } },
        { name: "Orders by payment status", kind: "items-aggregate", viz: "bars", config: { collection: "orders", agg: "count", groupBy: "status" } },
        { name: "Orders by fulfillment", kind: "items-aggregate", viz: "donut", config: { collection: "orders", agg: "count", groupBy: "fulfillment_status" } },
        { name: "Orders by channel", kind: "items-aggregate", viz: "bars", config: { collection: "orders", agg: "count", groupBy: "channel" } },
        { name: "Products by status", kind: "items-aggregate", viz: "donut", config: { collection: "products", agg: "count", groupBy: "status" } },
        { name: "Returns by kind", kind: "items-aggregate", viz: "donut", config: { collection: "returns", agg: "count", groupBy: "return_type" } },
        { name: "Returns by status", kind: "items-aggregate", viz: "donut", config: { collection: "returns", agg: "count", groupBy: "status" } },
        { name: "Carts by status", kind: "items-aggregate", viz: "donut", config: { collection: "carts", agg: "count", groupBy: "status" } },
        { name: "Subscriptions by status", kind: "items-aggregate", viz: "donut", config: { collection: "subscriptions", agg: "count", groupBy: "status" } },
        { name: "Stock movements by kind", kind: "items-aggregate", viz: "bars", config: { collection: "stock_movements", agg: "sum", field: "qty", groupBy: "movement_type" } },
      ],
    },
  ],
  /**
   * The rules a store runs on, already running.
   *
   * Deliberately absent: "an order was paid, so take the stock down". Which
   * units an order consumed lives on its `order_items`, and where they were
   * held lives on `inventory_reservations` — a flow's `data` is the order row
   * and can see neither. A step that decremented something would have to guess
   * the location, and a wrong location is worse than no adjustment because it
   * reads as done. So the flows below report the fact and leave the count to
   * whoever is holding the box.
   */
  flows: [
    {
      name: "Tell the team when an order is placed",
      trigger: "event:items:orders:created",
      operations: [
        {
          type: "notification",
          title: "Order {{ data.number }} placed",
          body: "{{ data.total }} {{ data.currency }}. Check the items are in stock before it is picked.",
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
          state: { _eq: "open" },
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
      name: "Keep a price list's status in step with its schedule",
      // The same two-pass shape as the discount flow above, and for the same
      // reason: a sale that has already been and gone must not be left showing
      // `draft` because only one of the two loops could reach it.
      trigger: "cron:0 3 * * *",
      operations: [
        {
          type: "foreach",
          collection: "price_lists",
          filter: { status: { _eq: "draft" }, starts_at: { _lte: "$now" } },
          do: [
            {
              type: "item.update",
              collection: "price_lists",
              id: "{{ $item.id }}",
              data: { status: "active" },
            },
          ],
        },
        {
          type: "foreach",
          collection: "price_lists",
          filter: { ends_at: { _lt: "$now" }, status: { _neq: "expired" } },
          do: [
            {
              type: "item.update",
              collection: "price_lists",
              id: "{{ $item.id }}",
              data: { status: "expired" },
            },
          ],
        },
      ],
    },
    {
      name: "Retire a gift card once its expiry has passed",
      // An expired card that still says `enabled` is a card a shopper is told
      // at checkout they cannot use, with nothing on the record explaining why.
      trigger: "cron:30 3 * * *",
      operations: [
        {
          type: "foreach",
          collection: "gift_cards",
          filter: { expires_at: { _lt: "$now" }, status: { _eq: "enabled" } },
          do: [
            {
              type: "item.update",
              collection: "gift_cards",
              id: "{{ $item.id }}",
              data: { status: "expired" },
            },
          ],
        },
      ],
    },
    {
      name: "Ask for a received return to be put back into stock",
      // A TRANSITION trigger, which `returns.status` can carry because it
      // declares a lifecycle. It fires once, on the move itself — an
      // `…:updated` trigger with a condition cannot tell "just arrived" from
      // "was saved again after arriving", so it would ask for the same box to be
      // put away every time anybody edited the row.
      trigger: "event:items:returns:transition:status:*:received",
      operations: [
        {
          type: "notification",
          title: "Return {{ data.number }} is back",
          body: "Its return items say which units came back and in what condition — only the resellable ones go back onto a location's inventory level, as a stock movement.",
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
      name: "Remind a subscriber before the next charge (needs email)",
      active: false,
      trigger: `schedule:${JSON.stringify({
        collection: "subscriptions",
        field: "next_billing_at",
        offset: { value: 3, unit: "days", direction: "before" },
        at: 600,
        timeZone: null,
        where: { status: { _eq: "active" } },
      })}`,
      operations: [
        {
          type: "email",
          to: "{{ data.customer.email }}",
          subject: "Your next delivery is on its way",
          html: "<p>Your subscription renews in three days. Change or pause it any time before then.</p>",
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
        '<p class="muted">Placed {{ data.placed_at }}</p>' +
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
        '<tr><td class="n">Gift card</td><td class="n">{{ data.gift_card_total }}</td></tr>' +
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
      // storefront — and off the product's rating roll-up, which counts
      // approved reviews only. Which product a review is about is a relation the
      // public page cannot set either, so the moderator attaches it on approval.
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
        "workspace's data only. Six rules this store's schema makes " +
        "necessary. An order carries THREE separate columns and they answer " +
        "three different questions: `state` is the order's own life (a " +
        "cancelled order is cancelled whatever else says), `status` is " +
        "payment, `fulfillment_status` is delivery — never report one as " +
        "another, and exclude cancelled orders by `state`, never by " +
        "`status`. Money carries its own currency; amounts in different " +
        "currencies are never added together. Refunds are their own rows, so " +
        "revenue net of refunds is the orders total minus the refunds total, " +
        "not a single column. What a shopper can actually buy is `available` " +
        "on an inventory level, per location — it is on hand minus committed. " +
        "A product's `stock` and a variant's `inventory_quantity` are each " +
        "summed from the inventory levels below them, so they count units " +
        "already promised to an order and are never the sellable figure. " +
        "A variant's price may be overridden by a price list for a " +
        "customer group, a channel or a quantity break, so the number on the " +
        "variant is the default and not necessarily what was charged. A " +
        "return, an exchange and a claim are all rows in `returns`, told " +
        "apart by `return_type`. Name the order number, be brief, and say " +
        "plainly when the data does not answer the question.",
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
   * That distinction is the whole reason there are only four: a template
   * cannot know which experiments a merchant wants to run, and seeding
   * invented ones would be noise an operator has to clear out. These are
   * decisions every store has already made and currently hard-codes in its
   * front end — so they arrive as something a deploy can change without a
   * deploy, which is what the feature is for.
   *
   * Defaults are the safe reading of each: guest checkout on because refusing
   * it costs sales, reviews on because the collection exists, wishlists on
   * because they cost nothing, wholesale off because the pricing it exposes is
   * not for everybody.
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
      key: "storefront.wishlists",
      enabled: true,
      description: "Let a signed-in shopper save products to a list.",
    },
    {
      key: "storefront.wholesale-pricing",
      enabled: false,
      // The payload is what a storefront reads once the flag is on: which
      // customer group's price list applies. A flag that only said on/off would
      // leave the front end hard-coding the group anyway.
      value: { customerGroupCode: "wholesale", priceListCode: "wholesale" },
      description: "Show customer-group pricing to signed-in buyers in that group.",
    },
  ],
};
