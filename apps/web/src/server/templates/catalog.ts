import type { FieldChoice, FieldDef } from "@backlex/db";

/**
 * Schema template catalog — vertical "starter" collection sets seeded into a
 * new project. The cloud control plane passes a template `id` (via the
 * `SEED_TEMPLATE` worker var); this repo owns the actual definitions and
 * materializes them with the normal collection engine. Ids are the contract
 * with cloud — keep them stable.
 *
 * Collections are listed in dependency order (relation targets before the
 * collections that point at them) so `applyTemplate` can create them top-down.
 *
 * Templates are authored to a "professional" bar: foreign keys + status/date
 * columns are `indexed`, status/priority fields use colored `dropdown` choices,
 * money/email/url/rating fields carry soft `validation`, large collections are
 * split into form `group`s, content-heavy collections enable `fts`, and every
 * collection ships a few realistic `samples` so a fresh workspace is demo-ready.
 */
export interface TemplateCollection {
  slug: string;
  singular?: string;
  plural?: string;
  note?: string;
  /** Row-title format hint for the admin UI (extract/apply-custom fidelity —
   *  catalog templates leave it to the engine's defaults). */
  displayTemplate?: string;
  ownerScoped?: boolean;
  versioned?: boolean;
  vectorize?: boolean;
  /** Embedding model override (extract/apply-custom fidelity). */
  vectorizeModel?: string;
  /** Enable keyword full-text search — pairs with `searchable` fields. */
  fts?: boolean;
  defaultSort?: string;
  /** Collection-level admin group: the section header this collection lands
   *  under on the Collections page + sidebar tree. NOT the same thing as the
   *  per-field `group` (which sections the item FORM) — this one organizes the
   *  collection LIST. Header order lives in `SchemaTemplate.groups`. */
  group?: string;
  /** Explicit position within the group. Catalog templates omit it (derived
   *  from listing order); extract emits it so the round-trip preserves the
   *  admin's arrangement even though the array is dependency-ordered. */
  sortOrder?: number;
  /** Single-row collection (extract/apply-custom fidelity). */
  singleton?: boolean;
  /** Soft delete — rows get a `deleted_at` column instead of hard deletes. */
  softDelete?: boolean;
  /** Audit reads of this collection (extract/apply-custom fidelity). */
  auditReads?: boolean;
  fields: FieldDef[];
  /** Realistic example rows seeded on apply (only when the collection is newly
   *  created). Relation values use `{ ref: "slug:index" }`. */
  samples?: SampleRow[];
}

/** A role (+ its permission grants) seeded alongside the collections. Skipped
 *  wholesale when a role with the same name already exists in the workspace. */
export interface TemplateRole {
  name: string;
  description?: string;
  permissions: TemplatePermission[];
}

export interface TemplatePermission {
  collection: string;
  action: "read" | "create" | "update" | "delete" | "publish";
  /** Field allow-list (omit = all fields). */
  fields?: string[];
  /** Permission-DSL condition (same shape the permissions API accepts). */
  condition?: unknown;
}

/** An insights dashboard (+ its panels) seeded alongside the collections.
 *  Skipped wholesale when a dashboard with the same name already exists.
 *  Panels stick to `items-aggregate`/`static` — never raw SQL — so seeding is
 *  safe on every runtime. */
export interface TemplateDashboard {
  name: string;
  description?: string;
  panels: TemplatePanel[];
}

export interface TemplatePanel {
  name: string;
  description?: string;
  kind: "items-aggregate" | "static";
  viz:
    | "sparkline"
    | "line"
    | "area"
    | "bars"
    | "stacked-bars"
    | "donut"
    | "pie"
    | "radar"
    | "radial"
    | "counter"
    | "table";
  config: Record<string, unknown>;
  layout?: { x: number; y: number; w: number; h: number };
}

export interface SchemaTemplate {
  id: string;
  label: string;
  description: string;
  /** Ordered group-header names, merged into the workspace's `collectionGroups`
   *  setting on apply (missing headers appended after the existing ones).
   *  Falls back to first-appearance order of `collections[].group`. */
  groups?: string[];
  collections: TemplateCollection[];
  /** Optional bundled roles — see {@link TemplateRole}. */
  roles?: TemplateRole[];
  /** Optional bundled insights dashboards — see {@link TemplateDashboard}. */
  dashboards?: TemplateDashboard[];
}

/**
 * A reference to another seeded sample row, resolved at apply time to the real
 * inserted id. `ref` is `"<collectionSlug>:<sampleIndex>"` (0-based, in the
 * order the samples are listed). Used for relation / relation_many sample
 * values so demo data is relationally consistent. An unresolved ref (e.g. the
 * target collection already existed and was skipped) degrades to `null`.
 */
export interface SampleRef {
  ref: string;
}

export type SampleValue = unknown | SampleRef | SampleRef[];
export type SampleRow = Record<string, SampleValue>;

/* ───────────────────────────── field helpers ───────────────────────────── */

const EMAIL_RE = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$";
const URL_RE = "^https?://.+";
const SLUG_RE = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

/** Semantic badge colors for status/priority dropdowns. */
const C = {
  green: "#16a34a",
  blue: "#2563eb",
  amber: "#d97706",
  red: "#dc2626",
  gray: "#6b7280",
  purple: "#9333ea",
  teal: "#0d9488",
  slate: "#475569",
} as const;

/** Parse an ISO date to epoch ms for sample timestamp values (deterministic). */
const ms = (iso: string): number => new Date(iso).getTime();

const text = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "text", ...extra });
const notes = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "longtext", interface: "textarea", ...extra });
const num = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "number", ...extra });
const int = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "integer", ...extra });
const bool = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "boolean", interface: "toggle", ...extra });
const ts = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "timestamp", interface: "datetime", ...extra });
const date = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "timestamp", interface: "date", ...extra });
const file = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "file", ...extra });
/** Relations are indexed by default — they're the hot join/filter path. */
const rel = (name: string, to: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "relation", to, interface: "relation", indexed: true, ...extra });
const relMany = (name: string, to: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "relation_many", to, ...extra });
const email = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "text", interface: "email", validation: { regex: EMAIL_RE }, ...extra });
const url = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "text", interface: "url", validation: { regex: URL_RE }, ...extra });
const money = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "number", interface: "decimal", validation: { min: 0 }, ...extra });
const rating = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "integer", interface: "rating", validation: { min: 1, max: 5 }, ...extra });
const slugField = (name = "slug", extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "text", interface: "slug", unique: true, validation: { regex: SLUG_RE }, ...extra });
const computedNum = (name: string, formula: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "number", computed: { formula }, ...extra });
const computedText = (name: string, formula: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "text", computed: { formula }, ...extra });
/** Single image (file storage, image picker). */
const image = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "file", interface: "image", ...extra });
/** Free-form label list (JSON array). Never seeded with sample values — a JSON
 *  array bound straight into a Postgres jsonb column trips the pg driver; define
 *  the column, leave samples scalar. Same rule applies to `relation_many`. */
const tags = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "json", interface: "tags", ...extra });
/** Self-referential parent FK for hierarchical/tree collections. */
const parent = (to: string, extra: Partial<FieldDef> = {}): FieldDef => rel("parent", to, { label: "Parent", ...extra });
/** Integer position/sort key — indexed so ordered lists stay cheap. */
const position = (name = "position", extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "integer", default: 0, indexed: true, ...extra });
/** Percent 0–100 integer. */
const pct = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "integer", interface: "slider", validation: { min: 0, max: 100 }, ...extra });

/** Colored dropdown. `values` may be plain strings or `{ value, color, label }`. */
const select = (
  name: string,
  values: Array<string | FieldChoice>,
  extra: Partial<FieldDef> = {},
): FieldDef => ({
  name,
  type: "text",
  interface: "dropdown",
  options: { choices: values.map((v) => (typeof v === "string" ? { value: v } : v)) },
  indexed: true,
  ...extra,
});

const ch = (value: string, color: string, label?: string): FieldChoice => ({ value, color, label });

export const TEMPLATES: SchemaTemplate[] = [
  { id: "blank", label: "Blank", description: "No collections — start from scratch.", collections: [] },

  {
    id: "blog",
    label: "Blog / CMS",
    groups: ["Content", "Taxonomy", "People"],
    description: "WordPress-grade content: posts & pages with SEO, categories, tags, authors and media.",
    collections: [
      { slug: "media", group: "Content", singular: "Media", plural: "Media", fields: [image("file"), text("alt", { label: "Alt text" }), text("caption"), int("width"), int("height")] },
      {
        slug: "authors", group: "People", singular: "Author", plural: "Authors", defaultSort: "name",
        fields: [text("name", { required: true }), slugField(), notes("bio"), image("avatar"), email("email"), url("website"), text("twitter", { label: "Twitter / X handle" })],
        samples: [
          { name: "Ada Lovelace", slug: "ada-lovelace", bio: "Writes about engineering and the craft of building software.", email: "ada@example.com" },
          { name: "Grace Hopper", slug: "grace-hopper", bio: "Product notes, release walkthroughs and the occasional rant.", email: "grace@example.com" },
        ],
      },
      {
        slug: "categories", group: "Taxonomy", singular: "Category", plural: "Categories", defaultSort: "name",
        fields: [text("name", { required: true }), slugField(), notes("description"), parent("categories"), text("color", { interface: "color" })],
        samples: [
          { name: "Engineering", slug: "engineering", color: C.blue },
          { name: "Product", slug: "product", color: C.purple },
        ],
      },
      {
        slug: "tags", group: "Taxonomy", singular: "Tag", plural: "Tags", defaultSort: "name",
        fields: [text("name", { required: true }), slugField(), notes("description")],
        samples: [{ name: "Release", slug: "release" }, { name: "Tutorial", slug: "tutorial" }],
      },
      {
        slug: "posts", group: "Content", singular: "Post", plural: "Posts", ownerScoped: true, versioned: true, vectorize: true, fts: true,
        defaultSort: "-_published_at",
        fields: [
          text("title", { required: true, vectorize: true, searchable: true, group: "Content" }),
          slugField("slug", { group: "Content" }),
          { name: "excerpt", type: "longtext", interface: "textarea", vectorize: true, searchable: true, group: "Content" },
          { name: "body", type: "longtext", interface: "richtext", vectorize: true, searchable: true, group: "Content" },
          image("cover", { group: "Content" }),
          rel("author", "authors", { group: "Meta" }),
          rel("category", "categories", { group: "Meta" }),
          relMany("tags", "tags", { group: "Meta" }),
          {
            name: "featured", type: "boolean", interface: "toggle", default: false, group: "Meta",
            label: "Featured post", description: "Pin this post to the top of the blog home page.",
          },
          { name: "reading_minutes", type: "integer", default: 0, label: "Reading time (min)", group: "Meta" },
          text("seo_title", { label: "SEO title", group: "SEO" }),
          notes("seo_description", { label: "SEO description", group: "SEO" }),
          image("og_image", { label: "Social share image", group: "SEO" }),
        ],
        samples: [
          {
            title: "Hello, world", slug: "hello-world",
            excerpt: "Our very first post.", body: "Welcome to the blog. This is the first post.",
            author: { ref: "authors:0" }, category: { ref: "categories:0" }, reading_minutes: 3,
          },
          {
            title: "Shipping the v1", slug: "shipping-the-v1",
            excerpt: "What changed in the first release.", body: "A walkthrough of everything in v1.",
            author: { ref: "authors:1" }, category: { ref: "categories:1" }, featured: true, reading_minutes: 6,
          },
        ],
      },
      {
        slug: "pages", group: "Content", singular: "Page", plural: "Pages", versioned: true, fts: true, defaultSort: "title",
        fields: [text("title", { required: true, searchable: true }), slugField(), { name: "body", type: "longtext", interface: "richtext", searchable: true }, text("seo_title", { label: "SEO title" }), notes("seo_description", { label: "SEO description" })],
        samples: [{ title: "About", slug: "about", body: "About this site." }, { title: "Contact", slug: "contact", body: "Get in touch." }],
      },
    ],
    roles: [
      {
        name: "Editor",
        description: "Create and edit content; publish posts and pages.",
        permissions: [
          { collection: "posts", action: "read" },
          { collection: "posts", action: "create" },
          { collection: "posts", action: "update" },
          { collection: "posts", action: "publish" },
          { collection: "pages", action: "read" },
          { collection: "pages", action: "create" },
          { collection: "pages", action: "update" },
          { collection: "pages", action: "publish" },
          { collection: "media", action: "read" },
          { collection: "media", action: "create" },
          { collection: "media", action: "update" },
          { collection: "categories", action: "read" },
          { collection: "tags", action: "read" },
          { collection: "authors", action: "read" },
        ],
      },
    ],
    dashboards: [
      {
        name: "Content overview",
        description: "Publishing volume and draft flow at a glance.",
        panels: [
          { name: "Posts", kind: "items-aggregate", viz: "counter", config: { collection: "posts", agg: "count" } },
          { name: "Pages", kind: "items-aggregate", viz: "counter", config: { collection: "pages", agg: "count" } },
          { name: "Posts by status", kind: "items-aggregate", viz: "donut", config: { collection: "posts", agg: "count", groupBy: "_status" } },
        ],
      },
    ],
  },

  {
    id: "ecommerce",
    label: "E-commerce",
    groups: ["Catalog", "Orders", "Customers", "Inventory", "Marketing"],
    description:
      "Shopify-grade storefront: products with options & variants, multi-location inventory, customers, discounts, orders with separate payment & fulfillment status, transactions, fulfillments, reviews and gift cards.",
    collections: [
      { slug: "media", group: "Catalog", singular: "Media", plural: "Media", fields: [image("file"), text("alt", { label: "Alt text" }), int("position", { default: 0 })] },
      {
        slug: "brands", group: "Catalog", singular: "Brand", plural: "Brands", defaultSort: "name",
        fields: [text("name", { required: true }), slugField(), image("logo"), url("website")],
        samples: [{ name: "Northwind", slug: "northwind" }, { name: "Acme", slug: "acme" }],
      },
      {
        // Hierarchical navigation tree (Saleor / BigCommerce category model).
        slug: "categories", group: "Catalog", singular: "Category", plural: "Categories", defaultSort: "position",
        fields: [
          text("name", { required: true }), slugField(),
          notes("description"), parent("categories"), image("image"),
          position(), bool("visible", { default: true, label: "Visible" }),
        ],
        samples: [
          { name: "Apparel", slug: "apparel", position: 1 },
          { name: "Accessories", slug: "accessories", position: 2 },
        ],
      },
      {
        // Merchandising grouping (Shopify manual/smart collection model).
        slug: "collections", group: "Catalog", singular: "Collection", plural: "Collections", defaultSort: "position",
        fields: [
          text("title", { required: true }), slugField(),
          notes("description"), image("image"),
          select("collection_type", [ch("manual", C.blue), ch("smart", C.purple)], { default: "manual", label: "Type" }),
          select("sort_order", ["manual", "best_selling", "alpha_asc", "alpha_desc", "price_asc", "price_desc", "created_desc"], { default: "manual", label: "Sort order" }),
          position(), bool("published", { default: true, label: "Published" }),
        ],
        samples: [{ title: "Summer Sale", slug: "summer-sale", collection_type: "manual", position: 1, published: true }],
      },
      {
        slug: "products", group: "Catalog", singular: "Product", plural: "Products", versioned: true, vectorize: true, fts: true, defaultSort: "name",
        fields: [
          text("name", { required: true, vectorize: true, searchable: true, group: "Basics" }),
          slugField("slug", { group: "Basics" }),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true, group: "Basics" },
          select("status", [ch("draft", C.gray), ch("active", C.green), ch("archived", C.slate)], { default: "active", group: "Basics" }),
          text("product_type", { label: "Type", group: "Basics" }),
          rel("brand", "brands", { group: "Basics" }),
          rel("category", "categories", { group: "Basics" }),
          tags("tags", { group: "Basics" }),
          money("price", { required: true, label: "Base price", group: "Pricing" }),
          money("compare_at_price", { label: "Compare-at price", group: "Pricing" }),
          select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD", group: "Pricing" }),
          bool("taxable", { default: true, label: "Taxable", group: "Pricing" }),
          text("sku", { unique: true, label: "SKU", group: "Inventory" }),
          int("stock", { default: 0, validation: { min: 0 }, label: "Total stock", group: "Inventory" }),
          bool("track_inventory", { default: true, label: "Track inventory", group: "Inventory" }),
          image("featured_image", { group: "Media" }),
          relMany("images", "media", { group: "Media" }),
          ts("published_at", { indexed: true, label: "Published at", group: "SEO" }),
          text("seo_title", { label: "SEO title", group: "SEO" }),
          notes("seo_description", { label: "SEO description", group: "SEO" }),
        ],
        samples: [
          { name: "Classic Tee", slug: "classic-tee", description: "A soft cotton t-shirt.", status: "active", product_type: "Apparel", brand: { ref: "brands:0" }, category: { ref: "categories:0" }, price: 25, compare_at_price: 30, currency: "USD", sku: "TEE-001", stock: 120 },
          { name: "Canvas Tote", slug: "canvas-tote", description: "Sturdy everyday tote bag.", status: "active", product_type: "Accessories", brand: { ref: "brands:1" }, category: { ref: "categories:1" }, price: 18, currency: "USD", sku: "TOTE-001", stock: 60 },
        ],
      },
      {
        // Option axes (e.g. Size, Color). Shopify caps at 3 per product.
        slug: "product_options", group: "Catalog", singular: "Option", plural: "Options", defaultSort: "position",
        fields: [rel("product", "products"), text("name", { required: true }), position()],
        samples: [
          { product: { ref: "products:0" }, name: "Size", position: 1 },
          { product: { ref: "products:0" }, name: "Color", position: 2 },
        ],
      },
      {
        slug: "product_option_values", group: "Catalog", singular: "Option value", plural: "Option values", defaultSort: "position",
        fields: [rel("option", "product_options"), text("value", { required: true }), text("swatch", { interface: "color", label: "Swatch color" }), position()],
        samples: [
          { option: { ref: "product_options:0" }, value: "S", position: 1 },
          { option: { ref: "product_options:0" }, value: "M", position: 2 },
          { option: { ref: "product_options:0" }, value: "L", position: 3 },
          { option: { ref: "product_options:1" }, value: "Black", swatch: "#111827", position: 1 },
          { option: { ref: "product_options:1" }, value: "White", swatch: "#f9fafb", position: 2 },
        ],
      },
      {
        slug: "locations", group: "Inventory", singular: "Location", plural: "Locations", defaultSort: "name",
        fields: [text("name", { required: true }), text("code", { label: "Code" }), text("address"), text("city"), text("country"), bool("active", { default: true, label: "Active" })],
        samples: [
          { name: "Central DC", code: "DC-1", city: "Newark", country: "US", active: true },
          { name: "West DC", code: "DC-2", city: "Reno", country: "US", active: true },
        ],
      },
      {
        // The unit of sale, price & inventory (Shopify/BigCommerce variant model).
        slug: "product_variants", group: "Catalog", singular: "Variant", plural: "Variants", defaultSort: "position",
        fields: [
          rel("product", "products", { group: "Variant" }),
          text("title", { label: "Title", group: "Variant" }),
          text("sku", { unique: true, label: "SKU", group: "Variant" }),
          text("barcode", { label: "Barcode / GTIN", group: "Variant" }),
          position("position", { group: "Variant" }),
          money("price", { required: true, group: "Pricing" }),
          money("compare_at_price", { label: "Compare-at price", group: "Pricing" }),
          money("cost", { label: "Cost per item", group: "Pricing" }),
          int("inventory_quantity", { default: 0, validation: { min: 0 }, label: "On hand", group: "Inventory" }),
          select("inventory_policy", [ch("deny", C.red), ch("continue", C.green)], { default: "deny", label: "When out of stock", group: "Inventory" }),
          num("weight", { validation: { min: 0 }, group: "Shipping" }),
          select("weight_unit", ["g", "kg", "oz", "lb"], { default: "kg", label: "Weight unit", group: "Shipping" }),
          bool("requires_shipping", { default: true, label: "Requires shipping", group: "Shipping" }),
        ],
        samples: [
          { product: { ref: "products:0" }, title: "S / Black", sku: "TEE-001-S-BLK", price: 25, cost: 9, inventory_quantity: 40, position: 1 },
          { product: { ref: "products:0" }, title: "M / Black", sku: "TEE-001-M-BLK", price: 25, cost: 9, inventory_quantity: 50, position: 2 },
        ],
      },
      {
        // Inventory as a (variant × location) join — not a single int on the variant.
        slug: "inventory_levels", group: "Inventory", singular: "Inventory level", plural: "Inventory levels",
        fields: [
          rel("variant", "product_variants"), rel("location", "locations"),
          int("available", { default: 0, validation: { min: 0 }, label: "Available" }),
          int("on_hand", { default: 0, validation: { min: 0 }, label: "On hand" }),
          int("committed", { default: 0, validation: { min: 0 }, label: "Committed" }),
          int("reorder_point", { default: 0, validation: { min: 0 }, label: "Reorder point" }),
        ],
        samples: [
          { variant: { ref: "product_variants:0" }, location: { ref: "locations:0" }, available: 40, on_hand: 40, reorder_point: 10 },
          { variant: { ref: "product_variants:1" }, location: { ref: "locations:0" }, available: 50, on_hand: 50, reorder_point: 10 },
        ],
      },
      {
        slug: "customers", group: "Customers", singular: "Customer", plural: "Customers", defaultSort: "-created_at",
        fields: [
          email("email", { required: true, unique: true, group: "Profile" }),
          text("first_name", { label: "First name", group: "Profile" }),
          text("last_name", { label: "Last name", group: "Profile" }),
          text("phone", { group: "Profile" }),
          select("state", [ch("enabled", C.green), ch("disabled", C.gray), ch("invited", C.blue), ch("declined", C.red)], { default: "enabled", label: "Account state", group: "Profile" }),
          bool("accepts_marketing", { default: false, label: "Accepts marketing", group: "Marketing" }),
          tags("tags", { group: "Marketing" }),
          money("total_spent", { default: 0, label: "Total spent", group: "Stats" }),
          int("orders_count", { default: 0, validation: { min: 0 }, label: "Orders count", group: "Stats" }),
          bool("tax_exempt", { default: false, label: "Tax exempt", group: "Stats" }),
          notes("note", { group: "Stats" }),
        ],
        samples: [
          { email: "jordan@example.com", first_name: "Jordan", last_name: "Reed", phone: "+1 555 0100", state: "enabled", total_spent: 43, orders_count: 1 },
          { email: "sam@example.com", first_name: "Sam", last_name: "Taylor", phone: "+1 555 0142", state: "enabled", total_spent: 18, orders_count: 1 },
        ],
      },
      {
        slug: "addresses", group: "Customers", singular: "Address", plural: "Addresses",
        fields: [
          rel("customer", "customers"), text("first_name", { label: "First name" }), text("last_name", { label: "Last name" }),
          text("company"), text("line1", { label: "Address line 1" }), text("line2", { label: "Address line 2" }),
          text("city"), text("province", { label: "State / Province" }), text("country"), text("postal_code", { label: "Postal code" }),
          text("phone"), bool("is_default", { default: false, label: "Default address" }),
        ],
        samples: [{ customer: { ref: "customers:0" }, first_name: "Jordan", last_name: "Reed", line1: "1 Market St", city: "San Francisco", province: "CA", country: "US", postal_code: "94105", is_default: true }],
      },
      {
        slug: "discounts", group: "Marketing", singular: "Discount", plural: "Discounts", defaultSort: "-starts_at",
        fields: [
          text("code", { unique: true, required: true }),
          select("value_type", [ch("percentage", C.blue), ch("fixed_amount", C.teal), ch("free_shipping", C.purple)], { default: "percentage", label: "Value type" }),
          num("value", { validation: { min: 0 } }),
          select("target_selection", [ch("all", C.gray), ch("entitled", C.amber)], { default: "all", label: "Applies to" }),
          money("minimum_amount", { label: "Minimum order amount" }),
          int("usage_limit", { validation: { min: 0 }, label: "Usage limit" }),
          int("usage_count", { default: 0, validation: { min: 0 }, label: "Times used" }),
          select("status", [ch("active", C.green), ch("scheduled", C.blue), ch("expired", C.gray)], { default: "active" }),
          ts("starts_at", { indexed: true, label: "Starts at" }),
          ts("ends_at", { label: "Ends at" }),
        ],
        samples: [{ code: "WELCOME10", value_type: "percentage", value: 10, target_selection: "all", status: "active", starts_at: ms("2026-01-01"), ends_at: ms("2026-12-31") }],
      },
      {
        slug: "orders", group: "Orders", singular: "Order", plural: "Orders", defaultSort: "-placed_at",
        fields: [
          text("number", { unique: true, group: "Order" }),
          rel("customer", "customers", { group: "Order" }),
          email("email", { group: "Order" }),
          // `status` = payment state (Shopify financial_status). Kept under this
          // name so existing apply/choice-membership tests stay valid.
          select("status", [ch("pending", C.amber), ch("authorized", C.blue), ch("partially_paid", C.amber, "Partially paid"), ch("paid", C.green), ch("partially_refunded", C.purple, "Partially refunded"), ch("refunded", C.gray), ch("voided", C.red)], { default: "pending", label: "Payment status", group: "Order" }),
          select("fulfillment_status", [ch("unfulfilled", C.gray), ch("partial", C.amber), ch("fulfilled", C.green), ch("restocked", C.slate)], { default: "unfulfilled", label: "Fulfillment status", group: "Order" }),
          select("channel", [ch("web", C.blue), ch("pos", C.teal), ch("draft", C.gray)], { default: "web", group: "Order" }),
          money("subtotal", { group: "Totals" }),
          money("total_tax", { label: "Tax", group: "Totals" }),
          money("total_shipping", { label: "Shipping", group: "Totals" }),
          money("total_discounts", { label: "Discounts", group: "Totals" }),
          money("total", { label: "Total", group: "Totals" }),
          select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD", group: "Totals" }),
          tags("tags", { group: "Meta" }),
          notes("note", { group: "Meta" }),
          select("cancel_reason", [ch("customer", C.gray), ch("fraud", C.red), ch("inventory", C.amber), ch("declined", C.red), ch("other", C.slate)], { label: "Cancel reason", group: "Meta" }),
          ts("placed_at", { indexed: true, label: "Placed at", group: "Order" }),
        ],
        samples: [
          { number: "ORD-1001", customer: { ref: "customers:0" }, email: "jordan@example.com", status: "paid", fulfillment_status: "fulfilled", subtotal: 43, total: 43, currency: "USD", placed_at: ms("2026-01-12") },
          { number: "ORD-1002", customer: { ref: "customers:1" }, email: "sam@example.com", status: "pending", fulfillment_status: "unfulfilled", subtotal: 18, total: 18, currency: "USD", placed_at: ms("2026-01-14") },
        ],
      },
      {
        slug: "order_items", group: "Orders", singular: "Order item", plural: "Order items",
        fields: [
          rel("order", "orders"), rel("product", "products"), rel("variant", "product_variants"),
          text("title", { label: "Title (snapshot)" }), text("sku", { label: "SKU (snapshot)" }),
          int("qty", { default: 1, validation: { min: 1 } }), money("unit_price"), money("total_discount", { label: "Line discount" }),
          computedNum("line_total", "qty * unit_price", { label: "Line total" }),
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
          select("kind", [ch("authorization", C.blue), ch("capture", C.teal), ch("sale", C.green), ch("void", C.gray), ch("refund", C.red)], { default: "sale" }),
          select("status", [ch("pending", C.amber), ch("success", C.green), ch("failure", C.red), ch("error", C.red)], { default: "success" }),
          money("amount"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
          text("gateway", { label: "Gateway" }), ts("processed_at", { indexed: true, label: "Processed at" }),
        ],
        samples: [{ order: { ref: "orders:0" }, kind: "sale", status: "success", amount: 43, currency: "USD", gateway: "stripe", processed_at: ms("2026-01-12") }],
      },
      {
        slug: "fulfillments", group: "Orders", singular: "Fulfillment", plural: "Fulfillments", defaultSort: "-shipped_at",
        fields: [
          rel("order", "orders"), rel("location", "locations"),
          select("status", [ch("pending", C.amber), ch("open", C.blue), ch("success", C.green), ch("cancelled", C.red)], { default: "pending" }),
          text("tracking_number", { label: "Tracking number" }), text("tracking_company", { label: "Carrier" }), url("tracking_url", { label: "Tracking URL" }),
          ts("shipped_at", { indexed: true, label: "Shipped at" }), ts("delivered_at", { label: "Delivered at" }),
        ],
        samples: [{ order: { ref: "orders:0" }, location: { ref: "locations:0" }, status: "success", tracking_number: "1Z999AA10123456784", tracking_company: "UPS", shipped_at: ms("2026-01-13") }],
      },
      {
        slug: "reviews", group: "Customers", singular: "Review", plural: "Reviews", ownerScoped: true, defaultSort: "-created_at",
        fields: [
          rel("product", "products"), rel("customer", "customers"),
          rating("rating"), text("title"), notes("body"),
          bool("verified_purchase", { default: false, label: "Verified purchase" }),
          select("status", [ch("pending", C.amber), ch("approved", C.green), ch("disapproved", C.red)], { default: "pending" }),
        ],
        samples: [{ product: { ref: "products:0" }, customer: { ref: "customers:0" }, rating: 5, title: "Perfect fit", body: "Great quality, fits perfectly.", verified_purchase: true, status: "approved" }],
      },
      {
        slug: "gift_cards", group: "Marketing", singular: "Gift card", plural: "Gift cards", defaultSort: "-created_at",
        fields: [
          text("code", { unique: true, required: true, label: "Code" }),
          money("initial_value", { label: "Initial value" }), money("balance", { label: "Balance" }),
          select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
          rel("customer", "customers"),
          select("status", [ch("enabled", C.green), ch("disabled", C.gray)], { default: "enabled" }),
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
          { collection: "products", action: "read" },
          { collection: "product_variants", action: "read" },
          { collection: "inventory_levels", action: "read" },
          { collection: "inventory_levels", action: "update" },
          { collection: "customers", action: "read" },
          { collection: "addresses", action: "read" },
        ],
      },
    ],
    dashboards: [
      {
        name: "Store overview",
        description: "Orders, revenue and catalog health.",
        panels: [
          { name: "Orders", kind: "items-aggregate", viz: "counter", config: { collection: "orders", agg: "count" } },
          { name: "Revenue", kind: "items-aggregate", viz: "counter", config: { collection: "orders", agg: "sum", field: "total" } },
          { name: "Customers", kind: "items-aggregate", viz: "counter", config: { collection: "customers", agg: "count" } },
          { name: "Orders by payment status", kind: "items-aggregate", viz: "bars", config: { collection: "orders", agg: "count", groupBy: "status" } },
          { name: "Orders by fulfillment", kind: "items-aggregate", viz: "donut", config: { collection: "orders", agg: "count", groupBy: "fulfillment_status" } },
          { name: "Products by status", kind: "items-aggregate", viz: "donut", config: { collection: "products", agg: "count", groupBy: "status" } },
        ],
      },
    ],
  },

  {
    id: "saas",
    label: "SaaS",
    groups: ["Accounts", "Catalog", "Billing", "Platform"],
    description:
      "Stripe-grade billing: accounts & members, products with prices, subscriptions and subscription items, invoices, payments, metered usage, plus feature flags and webhooks.",
    collections: [
      {
        slug: "accounts", group: "Accounts", singular: "Account", plural: "Accounts", defaultSort: "name",
        fields: [
          text("name", { required: true }), slugField(),
          email("billing_email", { label: "Billing email" }),
          select("status", [ch("active", C.green), ch("trialing", C.amber), ch("suspended", C.red)], { default: "trialing" }),
          select("currency", ["USD", "EUR", "GBP"], { default: "USD" }),
          select("tax_status", [ch("none", C.gray), ch("exempt", C.blue), ch("reverse", C.purple)], { default: "none", label: "Tax status" }),
        ],
        samples: [{ name: "Acme Inc", slug: "acme-inc", billing_email: "billing@acme.example", status: "active" }, { name: "Globex", slug: "globex", billing_email: "billing@globex.example", status: "trialing" }],
      },
      {
        slug: "account_members", group: "Accounts", singular: "Member", plural: "Members",
        fields: [rel("account", "accounts"), email("email", { required: true }), text("name"), select("role", [ch("owner", C.purple), ch("admin", C.blue), ch("member", C.gray), ch("billing", C.teal)], { default: "member" }), select("status", [ch("active", C.green), ch("invited", C.amber)], { default: "active" })],
        samples: [{ account: { ref: "accounts:0" }, email: "owner@acme.example", name: "Jordan Reed", role: "owner", status: "active" }],
      },
      {
        slug: "products", group: "Catalog", singular: "Product", plural: "Products", defaultSort: "name",
        fields: [text("name", { required: true }), notes("description"), bool("active", { default: true, label: "Active" }), text("unit_label", { label: "Unit label" })],
        samples: [{ name: "Pro Plan", description: "Everything in Starter, plus advanced features.", active: true }, { name: "API Usage", description: "Metered API calls.", active: true }],
      },
      {
        slug: "prices", group: "Catalog", singular: "Price", plural: "Prices", defaultSort: "unit_amount",
        fields: [
          rel("product", "products"),
          money("unit_amount", { required: true, label: "Unit amount" }),
          select("currency", ["USD", "EUR", "GBP"], { default: "USD" }),
          select("type", [ch("recurring", C.blue), ch("one_time", C.gray, "One-time")], { default: "recurring" }),
          select("interval", [ch("day", C.gray), ch("week", C.teal), ch("month", C.blue), ch("year", C.purple)], { default: "month", label: "Billing interval" }),
          int("interval_count", { default: 1, validation: { min: 1 }, label: "Interval count" }),
          select("usage_type", [ch("licensed", C.green), ch("metered", C.amber)], { default: "licensed", label: "Usage type" }),
          text("nickname"),
        ],
        samples: [
          { product: { ref: "products:0" }, unit_amount: 49, currency: "USD", type: "recurring", interval: "month", usage_type: "licensed", nickname: "Pro monthly" },
          { product: { ref: "products:1" }, unit_amount: 0.002, currency: "USD", type: "recurring", interval: "month", usage_type: "metered", nickname: "Per API call" },
        ],
      },
      {
        slug: "subscriptions", group: "Billing", singular: "Subscription", plural: "Subscriptions", defaultSort: "-current_period_end",
        fields: [
          rel("account", "accounts", { group: "Subscription" }),
          select("status", [ch("trialing", C.amber), ch("active", C.green), ch("past_due", C.red, "Past due"), ch("canceled", C.gray), ch("unpaid", C.red), ch("incomplete", C.slate), ch("paused", C.blue)], { default: "trialing", group: "Subscription" }),
          select("collection_method", [ch("charge_automatically", C.green, "Charge automatically"), ch("send_invoice", C.blue, "Send invoice")], { default: "charge_automatically", label: "Collection method", group: "Subscription" }),
          ts("current_period_start", { label: "Period start", group: "Billing period" }),
          ts("current_period_end", { indexed: true, label: "Period end", group: "Billing period" }),
          bool("cancel_at_period_end", { default: false, label: "Cancel at period end", group: "Billing period" }),
          ts("trial_end", { label: "Trial ends", group: "Billing period" }),
          ts("canceled_at", { label: "Canceled at", group: "Billing period" }),
        ],
        samples: [{ account: { ref: "accounts:0" }, status: "active", collection_method: "charge_automatically", current_period_start: ms("2026-06-01"), current_period_end: ms("2026-07-01") }],
      },
      {
        slug: "subscription_items", group: "Billing", singular: "Subscription item", plural: "Subscription items",
        fields: [rel("subscription", "subscriptions"), rel("price", "prices"), int("quantity", { default: 1, validation: { min: 1 } })],
        samples: [{ subscription: { ref: "subscriptions:0" }, price: { ref: "prices:0" }, quantity: 1 }],
      },
      {
        slug: "invoices", group: "Billing", singular: "Invoice", plural: "Invoices", defaultSort: "-issued_at",
        fields: [
          rel("account", "accounts"), rel("subscription", "subscriptions"), text("number", { unique: true }),
          select("status", [ch("draft", C.gray), ch("open", C.blue), ch("paid", C.green), ch("void", C.slate), ch("uncollectible", C.red)], { default: "draft" }),
          money("amount_due", { label: "Amount due" }), money("amount_paid", { label: "Amount paid" }),
          select("currency", ["USD", "EUR", "GBP"], { default: "USD" }),
          select("billing_reason", [ch("subscription_create", C.blue, "Subscription created"), ch("subscription_cycle", C.teal, "Renewal"), ch("manual", C.gray)], { default: "subscription_cycle", label: "Billing reason" }),
          date("due_date", { label: "Due date" }), ts("issued_at", { indexed: true, label: "Issued at" }),
          ts("period_start", { label: "Period start" }), ts("period_end", { label: "Period end" }),
        ],
        samples: [{ account: { ref: "accounts:0" }, subscription: { ref: "subscriptions:0" }, number: "INV-1001", status: "paid", amount_due: 49, amount_paid: 49, currency: "USD", billing_reason: "subscription_cycle", issued_at: ms("2026-06-01") }],
      },
      {
        slug: "payments", group: "Billing", singular: "Payment", plural: "Payments", defaultSort: "-created_at",
        fields: [
          rel("account", "accounts"), rel("invoice", "invoices"),
          money("amount"), select("currency", ["USD", "EUR", "GBP"], { default: "USD" }),
          select("status", [ch("succeeded", C.green), ch("pending", C.amber), ch("failed", C.red)], { default: "succeeded" }),
          select("payment_method", [ch("card", C.blue), ch("bank_transfer", C.teal, "Bank transfer"), ch("ach_debit", C.slate, "ACH debit")], { default: "card", label: "Payment method" }),
          text("failure_reason", { label: "Failure reason" }),
        ],
        samples: [{ account: { ref: "accounts:0" }, invoice: { ref: "invoices:0" }, amount: 49, currency: "USD", status: "succeeded", payment_method: "card" }],
      },
      {
        slug: "usage_records", group: "Billing", singular: "Usage", plural: "Usage", defaultSort: "-recorded_at",
        fields: [rel("subscription_item", "subscription_items"), text("metric"), num("quantity", { validation: { min: 0 } }), select("action", [ch("increment", C.blue), ch("set", C.purple)], { default: "increment" }), ts("recorded_at", { indexed: true, label: "Recorded at" })],
        samples: [{ subscription_item: { ref: "subscription_items:0" }, metric: "api_calls", quantity: 1240, action: "increment", recorded_at: ms("2026-06-20") }],
      },
      {
        slug: "feature_flags", group: "Platform", singular: "Feature flag", plural: "Feature flags", defaultSort: "key",
        fields: [text("key", { unique: true }), bool("enabled", { default: false }), pct("rollout_percentage", { default: 0, label: "Rollout (%)" }), notes("description")],
        samples: [{ key: "new_dashboard", enabled: true, rollout_percentage: 100, description: "Roll out the redesigned dashboard." }],
      },
      {
        slug: "webhooks", group: "Platform", singular: "Webhook", plural: "Webhooks",
        fields: [rel("account", "accounts"), url("url", { required: true }), text("secret", { label: "Signing secret" }), bool("active", { default: true })],
        samples: [{ account: { ref: "accounts:0" }, url: "https://acme.example/hooks/backlex", active: true }],
      },
    ],
  },

  {
    id: "crm",
    label: "CRM",
    groups: ["People", "Sales", "Engagement"],
    description:
      "Salesforce/HubSpot-grade sales CRM: companies, contacts with lifecycle stages, leads, a configurable pipeline of stages, deals with probability & forecast, logged activities and tasks.",
    collections: [
      {
        slug: "companies", group: "People", singular: "Company", plural: "Companies", defaultSort: "name",
        fields: [
          text("name", { required: true, group: "Company" }),
          url("domain", { group: "Company" }),
          text("industry", { group: "Company" }),
          select("type", [ch("prospect", C.gray), ch("customer", C.green), ch("partner", C.blue), ch("reseller", C.teal), ch("vendor", C.purple), ch("other", C.slate)], { default: "prospect", group: "Company" }),
          select("lifecycle_stage", [ch("subscriber", C.gray), ch("lead", C.blue), ch("marketingqualifiedlead", C.teal, "MQL"), ch("salesqualifiedlead", C.amber, "SQL"), ch("opportunity", C.purple), ch("customer", C.green), ch("evangelist", C.green), ch("other", C.slate)], { default: "lead", label: "Lifecycle stage", group: "Company" }),
          int("employees", { validation: { min: 0 }, group: "Firmographics" }),
          money("annual_revenue", { label: "Annual revenue", group: "Firmographics" }),
          text("phone", { group: "Firmographics" }),
          text("city", { group: "Firmographics" }),
          text("country", { group: "Firmographics" }),
        ],
        samples: [
          { name: "Acme Inc", domain: "https://acme.example", industry: "Manufacturing", type: "customer", lifecycle_stage: "customer", employees: 250, annual_revenue: 12000000, city: "Austin", country: "US" },
          { name: "Globex", domain: "https://globex.example", industry: "Energy", type: "prospect", lifecycle_stage: "opportunity", employees: 1200, annual_revenue: 80000000, city: "Denver", country: "US" },
        ],
      },
      {
        slug: "contacts", group: "People", singular: "Contact", plural: "Contacts", fts: true, defaultSort: "last_name",
        fields: [
          text("first_name", { label: "First name", searchable: true, group: "Identity" }),
          text("last_name", { label: "Last name", searchable: true, group: "Identity" }),
          computedText("full_name", "first_name || ' ' || last_name", { label: "Full name", group: "Identity" }),
          text("job_title", { label: "Job title", group: "Identity" }),
          email("email", { unique: true, searchable: true, group: "Contact" }),
          text("phone", { group: "Contact" }),
          text("mobile_phone", { label: "Mobile", group: "Contact" }),
          rel("company", "companies", { group: "Contact" }),
          select("lifecycle_stage", [ch("subscriber", C.gray), ch("lead", C.blue), ch("marketingqualifiedlead", C.teal, "MQL"), ch("salesqualifiedlead", C.amber, "SQL"), ch("opportunity", C.purple), ch("customer", C.green), ch("evangelist", C.green)], { default: "lead", label: "Lifecycle stage", group: "Status" }),
          select("lead_status", [ch("new", C.blue), ch("open", C.teal), ch("in_progress", C.amber, "In progress"), ch("connected", C.green), ch("unqualified", C.gray)], { default: "new", label: "Lead status", group: "Status" }),
          select("lead_source", [ch("web", C.blue), ch("phone_inquiry", C.teal, "Phone inquiry"), ch("partner_referral", C.purple, "Partner referral"), ch("purchased_list", C.gray, "Purchased list"), ch("event", C.amber), ch("other", C.slate)], { default: "web", label: "Source", group: "Status" }),
          ts("last_contacted", { label: "Last contacted", group: "Status" }),
        ],
        samples: [
          { first_name: "Jordan", last_name: "Reed", job_title: "Head of Ops", email: "jordan@acme.example", company: { ref: "companies:0" }, lifecycle_stage: "customer", lead_status: "connected", lead_source: "web" },
          { first_name: "Sam", last_name: "Taylor", job_title: "CTO", email: "sam@globex.example", company: { ref: "companies:1" }, lifecycle_stage: "opportunity", lead_status: "in_progress", lead_source: "event" },
        ],
      },
      {
        slug: "pipelines", group: "Sales", singular: "Pipeline", plural: "Pipelines", defaultSort: "position",
        fields: [text("name", { required: true }), bool("is_default", { default: false, label: "Default" }), position()],
        samples: [{ name: "Sales", is_default: true, position: 1 }],
      },
      {
        slug: "pipeline_stages", group: "Sales", singular: "Stage", plural: "Stages", defaultSort: "position",
        fields: [
          rel("pipeline", "pipelines"), text("name", { required: true }), position(),
          pct("probability", { default: 50, label: "Win probability (%)" }),
          bool("is_won", { default: false, label: "Won stage" }),
          bool("is_lost", { default: false, label: "Lost stage" }),
        ],
        samples: [
          { pipeline: { ref: "pipelines:0" }, name: "Qualification", position: 1, probability: 20 },
          { pipeline: { ref: "pipelines:0" }, name: "Proposal", position: 2, probability: 60 },
          { pipeline: { ref: "pipelines:0" }, name: "Negotiation", position: 3, probability: 80 },
          { pipeline: { ref: "pipelines:0" }, name: "Closed Won", position: 4, probability: 100, is_won: true },
          { pipeline: { ref: "pipelines:0" }, name: "Closed Lost", position: 5, probability: 0, is_lost: true },
        ],
      },
      {
        slug: "leads", group: "Sales", singular: "Lead", plural: "Leads", ownerScoped: true, defaultSort: "-created_at",
        fields: [
          text("first_name", { label: "First name" }), text("last_name", { label: "Last name" }),
          email("email"), text("phone"), text("company", { label: "Company (text)" }), text("title", { label: "Job title" }),
          select("status", [ch("new", C.blue), ch("working", C.amber), ch("qualified", C.green), ch("unqualified", C.gray)], { default: "new" }),
          select("rating", [ch("hot", C.red), ch("warm", C.amber), ch("cold", C.blue)], { default: "warm" }),
          select("source", [ch("web", C.blue), ch("phone_inquiry", C.teal, "Phone inquiry"), ch("partner_referral", C.purple, "Partner referral"), ch("event", C.amber), ch("other", C.slate)], { default: "web" }),
          int("score", { validation: { min: 0, max: 100 } }),
        ],
        samples: [{ first_name: "Alex", last_name: "Kim", email: "lead@example.com", company: "Initech", status: "new", rating: "warm", source: "web", score: 35 }],
      },
      {
        slug: "deals", group: "Sales", singular: "Deal", plural: "Deals", ownerScoped: true, defaultSort: "-created_at",
        fields: [
          text("name", { required: true, group: "Deal" }),
          money("amount", { group: "Deal" }),
          select("currency", ["USD", "EUR", "GBP"], { default: "USD", group: "Deal" }),
          rel("pipeline", "pipelines", { group: "Deal" }),
          rel("stage", "pipeline_stages", { group: "Deal" }),
          pct("probability", { default: 50, label: "Probability (%)", group: "Deal" }),
          select("deal_type", [ch("new_business", C.green, "New business"), ch("existing_business", C.blue, "Existing business")], { default: "new_business", label: "Deal type", group: "Deal" }),
          rel("company", "companies", { group: "Relations" }),
          rel("primary_contact", "contacts", { label: "Primary contact", group: "Relations" }),
          date("expected_close_date", { indexed: true, label: "Expected close", group: "Relations" }),
          text("lost_reason", { label: "Lost reason", group: "Relations" }),
        ],
        samples: [{ name: "Acme — annual contract", amount: 24000, currency: "USD", pipeline: { ref: "pipelines:0" }, stage: { ref: "pipeline_stages:1" }, probability: 60, deal_type: "new_business", company: { ref: "companies:0" }, primary_contact: { ref: "contacts:0" }, expected_close_date: ms("2026-08-01") }],
      },
      {
        slug: "activities", group: "Engagement", singular: "Activity", plural: "Activities", ownerScoped: true, defaultSort: "-due_at",
        fields: [
          select("type", [ch("call", C.blue), ch("email", C.teal), ch("meeting", C.purple), ch("note", C.gray), ch("task", C.amber)], { default: "note" }),
          text("subject"), notes("body"),
          select("direction", [ch("inbound", C.green), ch("outbound", C.blue)], { label: "Direction" }),
          rel("contact", "contacts"), rel("deal", "deals"), rel("company", "companies"),
          ts("due_at", { indexed: true, label: "Due at" }), ts("completed_at", { label: "Completed at" }),
        ],
        samples: [{ type: "call", subject: "Intro call", body: "Intro call with Jordan.", direction: "outbound", contact: { ref: "contacts:0" }, deal: { ref: "deals:0" }, due_at: ms("2026-07-05") }],
      },
      {
        slug: "tasks", group: "Engagement", singular: "Task", plural: "Tasks", ownerScoped: true, defaultSort: "due_at",
        fields: [text("title", { required: true }), select("priority", [ch("low", C.gray), ch("normal", C.blue), ch("high", C.red)], { default: "normal" }), bool("done", { default: false }), ts("due_at", { indexed: true })],
        samples: [{ title: "Send proposal to Acme", priority: "high", done: false, due_at: ms("2026-07-02") }],
      },
    ],
    roles: [
      {
        name: "Sales manager",
        description: "Read the whole CRM; work leads, deals and tasks across every rep.",
        permissions: [
          { collection: "companies", action: "read" },
          { collection: "contacts", action: "read" },
          { collection: "pipelines", action: "read" },
          { collection: "pipeline_stages", action: "read" },
          { collection: "leads", action: "read" },
          { collection: "leads", action: "update" },
          { collection: "deals", action: "read" },
          { collection: "deals", action: "update" },
          { collection: "activities", action: "read" },
          { collection: "tasks", action: "read" },
          { collection: "tasks", action: "update" },
        ],
      },
    ],
    dashboards: [
      {
        name: "Sales overview",
        description: "Pipeline value and deal flow.",
        panels: [
          { name: "Deals", kind: "items-aggregate", viz: "counter", config: { collection: "deals", agg: "count" } },
          { name: "Pipeline value", kind: "items-aggregate", viz: "counter", config: { collection: "deals", agg: "sum", field: "amount" } },
          { name: "Contacts", kind: "items-aggregate", viz: "counter", config: { collection: "contacts", agg: "count" } },
          { name: "Deals by type", kind: "items-aggregate", viz: "donut", config: { collection: "deals", agg: "count", groupBy: "deal_type" } },
          { name: "Leads by status", kind: "items-aggregate", viz: "bars", config: { collection: "leads", agg: "count", groupBy: "status" } },
        ],
      },
    ],
  },

  {
    id: "support",
    label: "Support / Helpdesk",
    groups: ["Tickets", "People", "Knowledge base"],
    description:
      "Zendesk-grade helpdesk: organizations, customers, agents and teams, tickets with separate status/priority/type axes, SLA policies, threaded messages with public/internal notes, a knowledge base and canned responses.",
    collections: [
      {
        slug: "organizations", group: "People", singular: "Organization", plural: "Organizations", defaultSort: "name",
        fields: [text("name", { required: true }), url("domain"), notes("notes")],
        samples: [{ name: "Acme Inc", domain: "https://acme.example" }],
      },
      {
        slug: "customers", group: "People", singular: "Customer", plural: "Customers", defaultSort: "name",
        fields: [email("email", { required: true, unique: true }), text("name"), text("phone"), rel("organization", "organizations")],
        samples: [{ email: "jordan@example.com", name: "Jordan Reed", organization: { ref: "organizations:0" } }, { email: "sam@example.com", name: "Sam Taylor", organization: { ref: "organizations:0" } }],
      },
      {
        slug: "agents", group: "People", singular: "Agent", plural: "Agents", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true }), select("role", [ch("agent", C.blue), ch("admin", C.purple)], { default: "agent" }), bool("active", { default: true, label: "Active" })],
        samples: [{ name: "Robin Park", email: "robin@support.example", role: "agent" }],
      },
      {
        slug: "teams", group: "People", singular: "Team", plural: "Teams", defaultSort: "name",
        fields: [text("name", { required: true }), notes("description")],
        samples: [{ name: "Tier 1" }, { name: "Billing" }],
      },
      {
        slug: "categories", group: "Knowledge base", singular: "Category", plural: "Categories", defaultSort: "name",
        fields: [text("name", { required: true })],
        samples: [{ name: "Billing" }, { name: "Technical" }],
      },
      {
        slug: "slas", group: "Tickets", singular: "SLA policy", plural: "SLA policies", defaultSort: "position",
        fields: [
          text("name", { required: true }), notes("description"), position(),
          select("priority", [ch("low", C.gray), ch("normal", C.blue), ch("high", C.amber), ch("urgent", C.red)], { default: "normal", label: "Applies to priority" }),
          int("first_reply_mins", { label: "First reply (min)", validation: { min: 0 } }),
          int("resolution_mins", { label: "Resolution (min)", validation: { min: 0 } }),
          bool("business_hours", { default: true, label: "Business hours only" }),
        ],
        samples: [
          { name: "Urgent", priority: "urgent", position: 1, first_reply_mins: 30, resolution_mins: 240 },
          { name: "Standard", priority: "normal", position: 2, first_reply_mins: 240, resolution_mins: 1440 },
        ],
      },
      {
        slug: "tickets", group: "Tickets", singular: "Ticket", plural: "Tickets", fts: true, defaultSort: "-created_at",
        fields: [
          text("subject", { required: true, searchable: true, group: "Ticket" }),
          { name: "description", type: "longtext", interface: "textarea", searchable: true, group: "Ticket" },
          select("status", [ch("new", C.purple), ch("open", C.blue), ch("pending", C.amber), ch("hold", C.slate), ch("solved", C.green), ch("closed", C.gray)], { default: "new", group: "Ticket" }),
          select("priority", [ch("low", C.gray), ch("normal", C.blue), ch("high", C.amber), ch("urgent", C.red)], { default: "normal", group: "Ticket" }),
          select("type", [ch("question", C.blue), ch("incident", C.amber), ch("problem", C.red), ch("task", C.teal)], { default: "question", group: "Ticket" }),
          select("channel", [ch("email", C.blue), ch("web", C.teal), ch("chat", C.purple), ch("phone", C.amber), ch("api", C.gray)], { default: "email", group: "Ticket" }),
          rel("requester", "customers", { group: "Assignment" }),
          rel("assignee", "agents", { group: "Assignment" }),
          rel("team", "teams", { group: "Assignment" }),
          rel("organization", "organizations", { group: "Assignment" }),
          rel("category", "categories", { group: "Assignment" }),
          rel("sla", "slas", { label: "SLA policy", group: "Assignment" }),
          select("satisfaction", [ch("offered", C.gray), ch("good", C.green), ch("bad", C.red)], { default: "offered", group: "Meta" }),
          tags("tags", { group: "Meta" }),
          ts("solved_at", { label: "Solved at", group: "Meta" }),
        ],
        samples: [
          { subject: "Cannot reset my password", description: "I keep getting an error.", status: "open", priority: "high", type: "incident", channel: "email", requester: { ref: "customers:0" }, assignee: { ref: "agents:0" }, team: { ref: "teams:0" }, category: { ref: "categories:1" }, sla: { ref: "slas:0" } },
          { subject: "Invoice question", description: "Where can I download my invoice?", status: "pending", priority: "normal", type: "question", channel: "web", requester: { ref: "customers:1" }, team: { ref: "teams:1" }, category: { ref: "categories:0" } },
        ],
      },
      {
        slug: "ticket_messages", group: "Tickets", singular: "Message", plural: "Messages", defaultSort: "created_at",
        fields: [rel("ticket", "tickets"), rel("agent", "agents"), notes("body"), bool("public", { default: true, label: "Public reply" })],
        samples: [{ ticket: { ref: "tickets:0" }, agent: { ref: "agents:0" }, body: "Thanks for reaching out — taking a look now.", public: true }],
      },
      {
        slug: "kb_articles", group: "Knowledge base", singular: "Article", plural: "Articles", versioned: true, vectorize: true, fts: true, defaultSort: "title",
        fields: [
          text("title", { required: true, vectorize: true, searchable: true }), slugField(),
          { name: "body", type: "longtext", interface: "richtext", vectorize: true, searchable: true },
          rel("category", "categories"), rel("author", "agents"),
          bool("promoted", { default: false, label: "Promoted" }),
        ],
        samples: [{ title: "How to reset your password", slug: "reset-password", body: "Go to Settings → Security and click Reset.", category: { ref: "categories:1" }, author: { ref: "agents:0" } }],
      },
      {
        slug: "canned_responses", group: "Tickets", singular: "Canned response", plural: "Canned responses", defaultSort: "title",
        fields: [text("title"), notes("body")],
        samples: [{ title: "Greeting", body: "Hi there! Thanks for contacting support." }],
      },
    ],
  },

  {
    id: "hr",
    label: "HR / People",
    groups: ["People", "Organization", "Operations"],
    description:
      "Workday/BambooHR-grade HRIS: employees with manager hierarchy, departments, locations, positions, time-off requests, performance reviews, documents and a compensation history.",
    collections: [
      {
        slug: "departments", group: "Organization", singular: "Department", plural: "Departments", defaultSort: "name",
        fields: [text("name", { required: true }), text("code"), parent("departments"), text("cost_center", { label: "Cost center" })],
        samples: [{ name: "Engineering", code: "ENG" }, { name: "Sales", code: "SALES" }],
      },
      {
        slug: "locations", group: "Organization", singular: "Location", plural: "Locations", defaultSort: "name",
        fields: [
          text("name", { required: true }),
          select("type", [ch("office", C.blue), ch("remote", C.teal), ch("hybrid", C.purple), ch("field", C.amber)], { default: "office" }),
          text("city"), text("country"), text("timezone", { label: "Timezone (IANA)" }), bool("is_headquarters", { default: false, label: "Headquarters" }),
        ],
        samples: [{ name: "HQ", type: "office", city: "Austin", country: "US", timezone: "America/Chicago", is_headquarters: true }],
      },
      {
        slug: "positions", group: "Organization", singular: "Position", plural: "Positions", defaultSort: "title",
        fields: [text("title", { required: true }), text("job_code", { label: "Job code" }), rel("department", "departments"), text("level", { label: "Level / grade" }), select("flsa_status", [ch("exempt", C.blue), ch("non_exempt", C.amber, "Non-exempt")], { default: "exempt", label: "FLSA status" }), bool("is_filled", { default: false, label: "Filled" })],
        samples: [{ title: "Software Engineer", job_code: "ENG-2", department: { ref: "departments:0" }, level: "L3", flsa_status: "exempt" }, { title: "Account Executive", job_code: "SAL-2", department: { ref: "departments:1" }, level: "L3", flsa_status: "exempt" }],
      },
      {
        slug: "employees", group: "People", singular: "Employee", plural: "Employees", fts: true, defaultSort: "last_name",
        fields: [
          text("employee_number", { unique: true, label: "Employee #", group: "Identity" }),
          text("first_name", { label: "First name", searchable: true, group: "Identity" }),
          text("last_name", { label: "Last name", searchable: true, group: "Identity" }),
          text("preferred_name", { label: "Preferred name", group: "Identity" }),
          computedText("full_name", "first_name || ' ' || last_name", { label: "Full name", group: "Identity" }),
          email("work_email", { unique: true, label: "Work email", group: "Contact" }),
          email("personal_email", { label: "Personal email", group: "Contact" }),
          text("phone", { group: "Contact" }),
          date("date_of_birth", { label: "Date of birth", group: "Contact" }),
          text("job_title", { label: "Job title", group: "Role" }),
          rel("department", "departments", { group: "Role" }),
          rel("position", "positions", { group: "Role" }),
          rel("manager", "employees", { group: "Role" }),
          rel("location", "locations", { group: "Role" }),
          select("employment_type", [ch("full_time", C.green, "Full time"), ch("part_time", C.blue, "Part time"), ch("contract", C.amber), ch("intern", C.teal), ch("temporary", C.gray)], { default: "full_time", label: "Employment type", group: "Employment" }),
          select("status", [ch("active", C.green), ch("on_leave", C.amber, "On leave"), ch("terminated", C.red)], { default: "active", group: "Employment" }),
          date("hire_date", { indexed: true, label: "Hire date", group: "Employment" }),
          date("termination_date", { label: "Termination date", group: "Employment" }),
          money("compensation_amount", { label: "Base compensation", group: "Compensation" }),
          select("compensation_currency", ["USD", "EUR", "GBP"], { default: "USD", label: "Currency", group: "Compensation" }),
          select("pay_frequency", [ch("hourly", C.gray), ch("biweekly", C.blue), ch("semimonthly", C.teal, "Semi-monthly"), ch("monthly", C.purple), ch("annually", C.green)], { default: "monthly", label: "Pay frequency", group: "Compensation" }),
        ],
        samples: [
          { employee_number: "E-001", first_name: "Ada", last_name: "Lovelace", work_email: "ada@company.example", job_title: "Software Engineer", department: { ref: "departments:0" }, position: { ref: "positions:0" }, location: { ref: "locations:0" }, employment_type: "full_time", status: "active", hire_date: ms("2024-03-01"), compensation_amount: 145000 },
          { employee_number: "E-002", first_name: "Sam", last_name: "Taylor", work_email: "sam@company.example", job_title: "Account Executive", department: { ref: "departments:1" }, position: { ref: "positions:1" }, location: { ref: "locations:0" }, employment_type: "full_time", status: "active", hire_date: ms("2025-09-15"), compensation_amount: 110000 },
        ],
      },
      {
        slug: "leave_requests", group: "Operations", singular: "Time off", plural: "Time off", defaultSort: "-start_date",
        fields: [
          rel("employee", "employees"),
          select("type", [ch("vacation", C.blue), ch("sick", C.amber), ch("personal", C.teal), ch("unpaid", C.gray), ch("parental", C.purple), ch("bereavement", C.slate)], { default: "vacation" }),
          date("start_date", { indexed: true, label: "Start date" }), date("end_date", { label: "End date" }),
          num("days", { validation: { min: 0 } }),
          select("status", [ch("pending", C.amber), ch("approved", C.green), ch("denied", C.red), ch("cancelled", C.gray)], { default: "pending" }),
          rel("approver", "employees"), notes("reason"),
        ],
        samples: [{ employee: { ref: "employees:0" }, type: "vacation", start_date: ms("2026-08-10"), end_date: ms("2026-08-17"), days: 5, status: "pending" }],
      },
      {
        slug: "performance_reviews", group: "Operations", singular: "Review", plural: "Reviews", defaultSort: "-created_at",
        fields: [
          rel("employee", "employees"), rel("reviewer", "employees"), text("period", { label: "Cycle / period" }),
          select("review_type", [ch("annual", C.blue), ch("quarterly", C.teal), ch("probationary", C.amber), ch("self", C.gray), ch("peer", C.purple), ch("360", C.green)], { default: "annual", label: "Review type" }),
          select("rating", [ch("outstanding", C.green), ch("exceeds", C.teal, "Exceeds expectations"), ch("meets", C.blue, "Meets expectations"), ch("partially_meets", C.amber, "Partially meets"), ch("does_not_meet", C.red, "Does not meet")], { default: "meets" }),
          select("status", [ch("not_started", C.gray, "Not started"), ch("in_progress", C.blue, "In progress"), ch("submitted", C.amber), ch("completed", C.green)], { default: "not_started" }),
          notes("notes"),
        ],
        samples: [{ employee: { ref: "employees:0" }, period: "2025 H2", review_type: "annual", rating: "outstanding", status: "completed", notes: "Outstanding contributions this half." }],
      },
      {
        slug: "documents", group: "People", singular: "Document", plural: "Documents",
        fields: [rel("employee", "employees"), text("title"), select("type", [ch("offer_letter", C.blue, "Offer letter"), ch("contract", C.purple), ch("tax_form", C.amber, "Tax form"), ch("certification", C.teal), ch("policy", C.gray), ch("other", C.slate)], { default: "other" }), file("file"), date("expires_at", { label: "Expires at" })],
        samples: [{ employee: { ref: "employees:0" }, title: "Offer letter", type: "offer_letter" }],
      },
      {
        slug: "compensation_history", group: "People", singular: "Compensation change", plural: "Compensation history", defaultSort: "-effective_date",
        fields: [
          rel("employee", "employees"), date("effective_date", { indexed: true, label: "Effective date" }),
          money("amount"), select("currency", ["USD", "EUR", "GBP"], { default: "USD" }),
          select("pay_type", [ch("salary", C.blue), ch("hourly", C.teal)], { default: "salary", label: "Pay type" }),
          select("change_reason", [ch("hire", C.green), ch("merit", C.blue), ch("promotion", C.purple), ch("market_adjustment", C.amber, "Market adjustment"), ch("role_change", C.teal, "Role change")], { default: "merit", label: "Reason" }),
        ],
        samples: [{ employee: { ref: "employees:0" }, effective_date: ms("2024-03-01"), amount: 145000, currency: "USD", pay_type: "salary", change_reason: "hire" }],
      },
    ],
  },

  {
    id: "projects",
    label: "Project management",
    groups: ["Planning", "Work", "Organize"],
    description:
      "Jira/Linear-grade issue tracking: projects, issues with type/state/priority and subtask & epic hierarchy, sprints (cycles), milestones, labels, comments and worklogs.",
    collections: [
      {
        slug: "members", group: "Organize", singular: "Member", plural: "Members", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true }), image("avatar"), select("role", [ch("admin", C.purple), ch("member", C.blue), ch("guest", C.gray)], { default: "member" })],
        samples: [{ name: "Ada Lovelace", email: "ada@team.example", role: "admin" }, { name: "Grace Hopper", email: "grace@team.example", role: "member" }],
      },
      {
        slug: "projects", group: "Planning", singular: "Project", plural: "Projects", defaultSort: "name",
        fields: [
          text("name", { required: true }), text("key", { unique: true, label: "Key" }),
          rel("lead", "members"),
          select("status", [ch("backlog", C.gray), ch("planned", C.blue), ch("started", C.amber), ch("paused", C.slate), ch("completed", C.green), ch("canceled", C.red)], { default: "planned" }),
          notes("description"), text("color", { interface: "color" }),
          date("start_date", { label: "Start date" }), date("target_date", { indexed: true, label: "Target date" }),
        ],
        samples: [{ name: "Website Redesign", key: "WEB", lead: { ref: "members:0" }, status: "started", description: "Refresh the marketing site.", target_date: ms("2026-09-01") }],
      },
      {
        slug: "labels", group: "Organize", singular: "Label", plural: "Labels", defaultSort: "name",
        fields: [text("name", { required: true }), text("color", { interface: "color" }), notes("description")],
        samples: [{ name: "frontend", color: C.blue }, { name: "bug", color: C.red }],
      },
      {
        slug: "milestones", group: "Planning", singular: "Milestone", plural: "Milestones", defaultSort: "target_date",
        fields: [rel("project", "projects"), text("name"), notes("description"), date("target_date", { indexed: true, label: "Target date" }), select("status", [ch("upcoming", C.gray), ch("in_progress", C.blue, "In progress"), ch("completed", C.green)], { default: "upcoming" }), position()],
        samples: [{ project: { ref: "projects:0" }, name: "Design complete", target_date: ms("2026-07-15"), status: "in_progress", position: 1 }],
      },
      {
        slug: "sprints", group: "Planning", singular: "Sprint", plural: "Sprints", defaultSort: "-start_date",
        fields: [rel("project", "projects"), text("name"), notes("goal"), int("number", { label: "Cycle #" }), date("start_date", { indexed: true, label: "Start date" }), date("end_date", { label: "End date" }), select("state", [ch("future", C.gray), ch("active", C.green), ch("closed", C.slate)], { default: "future" })],
        samples: [{ project: { ref: "projects:0" }, name: "Sprint 1", goal: "Ship the new home page.", number: 1, start_date: ms("2026-07-01"), end_date: ms("2026-07-14"), state: "active" }],
      },
      {
        slug: "issues", group: "Work", singular: "Issue", plural: "Issues", ownerScoped: true, fts: true, defaultSort: "-created_at",
        fields: [
          text("identifier", { unique: true, label: "Identifier", group: "Issue" }),
          text("title", { required: true, searchable: true, group: "Issue" }),
          notes("description", { searchable: true, group: "Issue" }),
          select("type", [ch("epic", C.purple), ch("story", C.green), ch("task", C.blue), ch("bug", C.red), ch("subtask", C.gray)], { default: "task", group: "Issue" }),
          select("state", [ch("backlog", C.gray), ch("todo", C.slate), ch("in_progress", C.blue, "In progress"), ch("in_review", C.amber, "In review"), ch("done", C.green), ch("canceled", C.red)], { default: "backlog", group: "Issue" }),
          select("priority", [ch("urgent", C.red), ch("high", C.amber), ch("medium", C.blue), ch("low", C.gray), ch("no_priority", C.slate, "No priority")], { default: "medium", group: "Issue" }),
          rel("project", "projects", { group: "Assignment" }),
          rel("assignee", "members", { group: "Assignment" }),
          rel("reporter", "members", { group: "Assignment" }),
          rel("sprint", "sprints", { group: "Assignment" }),
          rel("milestone", "milestones", { group: "Assignment" }),
          rel("parent", "issues", { label: "Parent issue", group: "Assignment" }),
          relMany("labels", "labels", { group: "Assignment" }),
          num("story_points", { validation: { min: 0 }, label: "Story points", group: "Planning" }),
          date("due_date", { indexed: true, label: "Due date", group: "Planning" }),
        ],
        samples: [
          { identifier: "WEB-1", title: "Wireframe the home page", description: "Low-fi wireframes for review.", type: "story", state: "in_progress", priority: "high", project: { ref: "projects:0" }, assignee: { ref: "members:0" }, reporter: { ref: "members:1" }, sprint: { ref: "sprints:0" }, story_points: 3, due_date: ms("2026-07-08") },
          { identifier: "WEB-2", title: "Set up analytics", description: "Add privacy-friendly analytics.", type: "task", state: "backlog", priority: "medium", project: { ref: "projects:0" }, assignee: { ref: "members:1" }, story_points: 2 },
        ],
      },
      {
        slug: "worklogs", group: "Work", singular: "Worklog", plural: "Worklogs", ownerScoped: true, defaultSort: "-logged_at",
        fields: [rel("issue", "issues"), rel("member", "members"), num("hours", { validation: { min: 0 } }), notes("description"), ts("logged_at", { indexed: true, label: "Logged at" })],
        samples: [{ issue: { ref: "issues:0" }, member: { ref: "members:0" }, hours: 3.5, logged_at: ms("2026-07-03") }],
      },
      {
        slug: "comments", group: "Work", singular: "Comment", plural: "Comments", ownerScoped: true, defaultSort: "created_at",
        fields: [rel("issue", "issues"), rel("author", "members"), notes("body")],
        samples: [{ issue: { ref: "issues:0" }, author: { ref: "members:1" }, body: "First draft looks great!" }],
      },
    ],
  },

  {
    id: "events",
    label: "Events / Booking",
    groups: ["Events", "Ticketing", "Attendees"],
    description:
      "Eventbrite-grade ticketing: events with venues & sessions, tiered ticket types with capacity, attendees, orders and individual issued tickets with check-in.",
    collections: [
      { slug: "media", group: "Events", singular: "Media", plural: "Media", fields: [image("file"), text("alt", { label: "Alt text" })] },
      {
        slug: "venues", group: "Events", singular: "Venue", plural: "Venues", defaultSort: "name",
        fields: [text("name", { required: true }), text("address"), text("city"), text("country"), int("capacity", { validation: { min: 0 } })],
        samples: [{ name: "Main Hall", address: "1 Conference Way", city: "Austin", country: "US", capacity: 500 }],
      },
      {
        slug: "organizers", group: "Events", singular: "Organizer", plural: "Organizers", defaultSort: "name",
        fields: [text("name", { required: true }), email("email"), url("website")],
        samples: [{ name: "Backlex Events", email: "events@backlex.example" }],
      },
      {
        slug: "events", group: "Events", singular: "Event", plural: "Events", versioned: true, vectorize: true, fts: true, defaultSort: "-start_at",
        fields: [
          text("title", { required: true, vectorize: true, searchable: true, group: "Event" }),
          slugField("slug", { group: "Event" }),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true, group: "Event" },
          rel("organizer", "organizers", { group: "Event" }),
          rel("venue", "venues", { group: "Event" }),
          select("status", [ch("draft", C.gray), ch("on_sale", C.green, "On sale"), ch("sold_out", C.amber, "Sold out"), ch("cancelled", C.red), ch("completed", C.slate)], { default: "draft", group: "Event" }),
          select("type", [ch("conference", C.blue), ch("workshop", C.teal), ch("concert", C.purple), ch("webinar", C.amber), ch("meetup", C.gray)], { default: "conference", group: "Event" }),
          bool("online", { default: false, label: "Online event", group: "Schedule" }),
          image("cover", { group: "Schedule" }),
          ts("start_at", { indexed: true, label: "Starts at", group: "Schedule" }),
          ts("end_at", { label: "Ends at", group: "Schedule" }),
          text("timezone", { label: "Timezone", group: "Schedule" }),
        ],
        samples: [{ title: "Backlex Conf 2026", slug: "backlex-conf-2026", description: "Our annual user conference.", organizer: { ref: "organizers:0" }, venue: { ref: "venues:0" }, status: "on_sale", type: "conference", start_at: ms("2026-10-01T09:00:00Z"), end_at: ms("2026-10-01T17:00:00Z") }],
      },
      {
        slug: "sessions", group: "Events", singular: "Session", plural: "Sessions", defaultSort: "start_at",
        fields: [rel("event", "events"), text("title"), notes("description"), text("speaker"), text("room"), ts("start_at", { indexed: true, label: "Starts at" }), ts("end_at", { label: "Ends at" })],
        samples: [{ event: { ref: "events:0" }, title: "Opening keynote", speaker: "Ada Lovelace", start_at: ms("2026-10-01T09:30:00Z"), end_at: ms("2026-10-01T10:30:00Z") }],
      },
      {
        slug: "ticket_types", group: "Ticketing", singular: "Ticket type", plural: "Ticket types", defaultSort: "price",
        fields: [
          rel("event", "events"), text("name"), money("price"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
          int("quantity", { validation: { min: 0 }, label: "Quantity" }), int("sold", { default: 0, validation: { min: 0 }, label: "Sold" }),
          int("min_per_order", { default: 1, label: "Min per order" }), int("max_per_order", { default: 10, label: "Max per order" }),
          ts("sales_start", { label: "Sales start" }), ts("sales_end", { label: "Sales end" }),
        ],
        samples: [{ event: { ref: "events:0" }, name: "General Admission", price: 99, currency: "USD", quantity: 400, sold: 120 }, { event: { ref: "events:0" }, name: "VIP", price: 249, currency: "USD", quantity: 50, sold: 12 }],
      },
      {
        slug: "attendees", group: "Attendees", singular: "Attendee", plural: "Attendees", defaultSort: "name",
        fields: [text("name"), email("email", { required: true }), text("phone"), text("company")],
        samples: [{ name: "Jordan Reed", email: "jordan@example.com", company: "Acme" }],
      },
      {
        slug: "orders", group: "Ticketing", singular: "Order", plural: "Orders", defaultSort: "-placed_at",
        fields: [
          text("number", { unique: true }), rel("event", "events"), rel("buyer", "attendees"),
          select("status", [ch("pending", C.amber), ch("paid", C.green), ch("refunded", C.gray), ch("cancelled", C.red)], { default: "pending" }),
          money("total"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }), ts("placed_at", { indexed: true, label: "Placed at" }),
        ],
        samples: [{ number: "EVT-1001", event: { ref: "events:0" }, buyer: { ref: "attendees:0" }, status: "paid", total: 198, currency: "USD", placed_at: ms("2026-08-01") }],
      },
      {
        slug: "tickets", group: "Ticketing", singular: "Ticket", plural: "Tickets", defaultSort: "-created_at",
        fields: [
          rel("order", "orders"), rel("ticket_type", "ticket_types"), rel("attendee", "attendees"),
          text("code", { unique: true, label: "Ticket code" }),
          select("status", [ch("valid", C.green), ch("checked_in", C.blue, "Checked in"), ch("cancelled", C.red)], { default: "valid" }),
          ts("checked_in_at", { label: "Checked in at" }),
        ],
        samples: [
          { order: { ref: "orders:0" }, ticket_type: { ref: "ticket_types:0" }, attendee: { ref: "attendees:0" }, code: "TIX-AAA-001", status: "valid" },
          { order: { ref: "orders:0" }, ticket_type: { ref: "ticket_types:0" }, attendee: { ref: "attendees:0" }, code: "TIX-AAA-002", status: "valid" },
        ],
      },
    ],
  },

  {
    id: "inventory",
    label: "Inventory / Operations",
    groups: ["Catalog", "Stock", "Purchasing"],
    description:
      "NetSuite-grade inventory: items with reorder points, multi-warehouse stock levels (on-hand / reserved / available), suppliers, purchase orders with line items, transfers and adjustments.",
    collections: [
      {
        slug: "warehouses", group: "Stock", singular: "Warehouse", plural: "Warehouses", defaultSort: "name",
        fields: [text("name", { required: true }), text("code"), text("address"), text("city"), text("country"), bool("active", { default: true, label: "Active" })],
        samples: [{ name: "Central DC", code: "DC-1", city: "Newark", country: "US", active: true }, { name: "West DC", code: "DC-2", city: "Reno", country: "US", active: true }],
      },
      {
        slug: "suppliers", group: "Purchasing", singular: "Supplier", plural: "Suppliers", defaultSort: "name",
        fields: [text("name", { required: true }), text("contact_name", { label: "Contact name" }), email("email"), text("phone"), text("address"), select("payment_terms", [ch("net_15", C.blue, "Net 15"), ch("net_30", C.teal, "Net 30"), ch("net_60", C.amber, "Net 60"), ch("prepaid", C.gray)], { default: "net_30", label: "Payment terms" }), bool("active", { default: true, label: "Active" })],
        samples: [{ name: "Globex Supplies", contact_name: "Pat Lee", email: "sales@globex.example", phone: "+1 555 0190", payment_terms: "net_30", active: true }],
      },
      {
        slug: "item_categories", group: "Catalog", singular: "Category", plural: "Categories", defaultSort: "name",
        fields: [text("name", { required: true }), parent("item_categories")],
        samples: [{ name: "Components" }, { name: "Finished goods" }],
      },
      {
        slug: "items", group: "Catalog", singular: "Item", plural: "Items", fts: true, defaultSort: "name",
        fields: [
          text("name", { required: true, searchable: true, group: "Item" }),
          text("sku", { unique: true, label: "SKU", group: "Item" }),
          text("barcode", { label: "Barcode", group: "Item" }),
          notes("description", { searchable: true, group: "Item" }),
          rel("category", "item_categories", { group: "Item" }),
          rel("supplier", "suppliers", { group: "Item" }),
          money("unit_cost", { label: "Unit cost", group: "Pricing" }),
          money("unit_price", { label: "Sell price", group: "Pricing" }),
          text("unit", { default: "ea", label: "Unit of measure", group: "Pricing" }),
          int("reorder_point", { default: 0, validation: { min: 0 }, label: "Reorder point", group: "Replenishment" }),
          int("reorder_quantity", { default: 0, validation: { min: 0 }, label: "Reorder qty", group: "Replenishment" }),
          bool("active", { default: true, label: "Active", group: "Replenishment" }),
        ],
        samples: [{ name: "Widget A", sku: "WID-A", category: { ref: "item_categories:0" }, supplier: { ref: "suppliers:0" }, unit_cost: 4.5, unit_price: 9.99, unit: "ea", reorder_point: 100, reorder_quantity: 500 }, { name: "Widget B", sku: "WID-B", category: { ref: "item_categories:0" }, supplier: { ref: "suppliers:0" }, unit_cost: 6.0, unit_price: 12.99, unit: "ea", reorder_point: 50, reorder_quantity: 200 }],
      },
      {
        slug: "stock_levels", group: "Stock", singular: "Stock level", plural: "Stock levels",
        fields: [
          rel("item", "items"), rel("warehouse", "warehouses"),
          int("on_hand", { default: 0, validation: { min: 0 }, label: "On hand" }),
          int("reserved", { default: 0, validation: { min: 0 }, label: "Reserved" }),
          int("incoming", { default: 0, validation: { min: 0 }, label: "Incoming" }),
          computedNum("available", "on_hand - reserved", { label: "Available" }),
        ],
        samples: [
          { item: { ref: "items:0" }, warehouse: { ref: "warehouses:0" }, on_hand: 500, reserved: 20 },
          { item: { ref: "items:1" }, warehouse: { ref: "warehouses:0" }, on_hand: 200, reserved: 0 },
        ],
      },
      {
        slug: "purchase_orders", group: "Purchasing", singular: "Purchase order", plural: "Purchase orders", defaultSort: "-order_date",
        fields: [
          text("number", { unique: true }), rel("supplier", "suppliers"), rel("warehouse", "warehouses"),
          select("status", [ch("draft", C.gray), ch("ordered", C.blue), ch("partial", C.amber, "Partially received"), ch("received", C.green), ch("cancelled", C.red)], { default: "draft" }),
          money("total"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
          date("order_date", { indexed: true, label: "Order date" }), date("expected_date", { label: "Expected date" }),
        ],
        samples: [{ number: "PO-2001", supplier: { ref: "suppliers:0" }, warehouse: { ref: "warehouses:0" }, status: "ordered", total: 2250, currency: "USD", order_date: ms("2026-06-01"), expected_date: ms("2026-06-12") }],
      },
      {
        slug: "purchase_order_items", group: "Purchasing", singular: "PO line", plural: "PO lines",
        fields: [rel("purchase_order", "purchase_orders"), rel("item", "items"), int("qty_ordered", { default: 1, validation: { min: 0 }, label: "Qty ordered" }), int("qty_received", { default: 0, validation: { min: 0 }, label: "Qty received" }), money("unit_cost", { label: "Unit cost" }), computedNum("line_total", "qty_ordered * unit_cost", { label: "Line total" })],
        samples: [{ purchase_order: { ref: "purchase_orders:0" }, item: { ref: "items:0" }, qty_ordered: 500, qty_received: 0, unit_cost: 4.5 }],
      },
      {
        slug: "stock_transfers", group: "Stock", singular: "Transfer", plural: "Transfers", defaultSort: "-transferred_at",
        fields: [rel("item", "items"), rel("from_warehouse", "warehouses", { label: "From warehouse" }), rel("to_warehouse", "warehouses", { label: "To warehouse" }), int("quantity", { validation: { min: 0 } }), select("status", [ch("pending", C.amber), ch("in_transit", C.blue, "In transit"), ch("completed", C.green)], { default: "pending" }), ts("transferred_at", { indexed: true, label: "Transferred at" })],
        samples: [{ item: { ref: "items:0" }, from_warehouse: { ref: "warehouses:0" }, to_warehouse: { ref: "warehouses:1" }, quantity: 50, status: "completed", transferred_at: ms("2026-06-10") }],
      },
      {
        slug: "stock_adjustments", group: "Stock", singular: "Adjustment", plural: "Adjustments", defaultSort: "-adjusted_at",
        fields: [rel("item", "items"), rel("warehouse", "warehouses"), int("quantity_change", { label: "Quantity change" }), select("reason", [ch("count", C.blue, "Cycle count"), ch("damage", C.red), ch("theft", C.amber), ch("return", C.green), ch("correction", C.gray)], { default: "count" }), notes("note"), ts("adjusted_at", { indexed: true, label: "Adjusted at" })],
        samples: [{ item: { ref: "items:1" }, warehouse: { ref: "warehouses:0" }, quantity_change: -5, reason: "damage", note: "Water damage in transit.", adjusted_at: ms("2026-06-15") }],
      },
    ],
  },

  {
    id: "real-estate",
    label: "Real estate",
    groups: ["Listings", "People", "Deals"],
    description: "Property listings, agents, inquiries and viewings.",
    collections: [
      { slug: "media", group: "Listings", singular: "Media", plural: "Media", fields: [file("file"), text("alt", { label: "Alt text" })] },
      {
        slug: "agents", group: "People", singular: "Agent", plural: "Agents", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true }), text("phone"), image("photo"), text("license_number", { label: "License #" }), text("agency")],
        samples: [{ name: "Casey Morgan", email: "casey@realty.example", phone: "+1 555 0170", license_number: "RE-558210", agency: "Skyline Realty" }],
      },
      {
        slug: "properties", group: "Listings", singular: "Property", plural: "Properties", versioned: true, vectorize: true, fts: true, defaultSort: "-created_at",
        fields: [
          text("title", { required: true, vectorize: true, searchable: true, group: "Listing" }),
          slugField("slug", { group: "Listing" }),
          text("mls_number", { unique: true, label: "MLS #", group: "Listing" }),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true, group: "Listing" },
          select("type", [ch("house", C.blue), ch("apartment", C.teal), ch("condo", C.purple), ch("townhouse", C.green), ch("land", C.amber), ch("commercial", C.slate)], { default: "house", group: "Listing" }),
          select("listing_type", [ch("sale", C.green, "For sale"), ch("rent", C.blue, "For rent")], { default: "sale", label: "Listing type", group: "Listing" }),
          select("status", [ch("active", C.green), ch("pending", C.amber), ch("under_offer", C.amber, "Under offer"), ch("sold", C.gray), ch("rented", C.blue), ch("off_market", C.slate, "Off market")], { default: "active", group: "Listing" }),
          money("price", { group: "Details" }),
          int("bedrooms", { default: 0, validation: { min: 0 }, group: "Details" }),
          num("bathrooms", { default: 0, validation: { min: 0 }, group: "Details" }),
          num("area_sqm", { label: "Living area (m²)", validation: { min: 0 }, group: "Details" }),
          num("lot_sqm", { label: "Lot size (m²)", validation: { min: 0 }, group: "Details" }),
          int("year_built", { label: "Year built", group: "Details" }),
          int("garage_spaces", { default: 0, validation: { min: 0 }, label: "Garage spaces", group: "Details" }),
          tags("amenities", { group: "Details" }),
          text("address", { group: "Location" }),
          text("city", { indexed: true, group: "Location" }),
          text("state", { label: "State / Province", group: "Location" }),
          text("postal_code", { label: "Postal code", group: "Location" }),
          num("latitude", { group: "Location" }),
          num("longitude", { group: "Location" }),
          rel("agent", "agents", { group: "Location" }),
          image("cover", { group: "Media" }),
          relMany("images", "media", { group: "Media" }),
          bool("featured", { default: false, label: "Featured", group: "Media" }),
        ],
        samples: [
          { title: "Sunny 2-bed apartment", slug: "sunny-2-bed-apartment", mls_number: "MLS-10001", description: "Bright apartment near the park.", type: "apartment", listing_type: "sale", status: "active", price: 320000, bedrooms: 2, bathrooms: 1, area_sqm: 78, year_built: 2015, city: "Austin", state: "TX", agent: { ref: "agents:0" }, featured: true },
          { title: "Family house with garden", slug: "family-house-with-garden", mls_number: "MLS-10002", description: "Spacious 4-bed with large garden.", type: "house", listing_type: "sale", status: "active", price: 540000, bedrooms: 4, bathrooms: 3, area_sqm: 180, lot_sqm: 600, year_built: 2008, garage_spaces: 2, city: "Denver", state: "CO", agent: { ref: "agents:0" } },
        ],
      },
      {
        slug: "inquiries", group: "Deals", singular: "Inquiry", plural: "Inquiries", ownerScoped: true, defaultSort: "-created_at",
        fields: [rel("property", "properties"), text("name"), email("email"), notes("message"), select("status", [ch("new", C.blue), ch("contacted", C.amber), ch("closed", C.gray)], { default: "new" })],
        samples: [{ property: { ref: "properties:0" }, name: "Jordan Reed", email: "jordan@example.com", message: "Is this still available?", status: "new" }],
      },
      {
        slug: "viewings", group: "Deals", singular: "Viewing", plural: "Viewings", defaultSort: "-scheduled_at",
        fields: [rel("property", "properties"), rel("agent", "agents"), text("name"), email("email"), ts("scheduled_at", { indexed: true, label: "Scheduled at" }), select("status", [ch("scheduled", C.blue), ch("completed", C.green), ch("no_show", C.red, "No show"), ch("cancelled", C.gray)], { default: "scheduled" }), notes("feedback")],
        samples: [{ property: { ref: "properties:0" }, agent: { ref: "agents:0" }, name: "Jordan Reed", email: "jordan@example.com", scheduled_at: ms("2026-07-10T15:00:00Z"), status: "scheduled" }],
      },
      {
        slug: "offers", group: "Deals", singular: "Offer", plural: "Offers", defaultSort: "-submitted_at",
        fields: [
          rel("property", "properties"), text("buyer_name", { label: "Buyer name" }), email("buyer_email", { label: "Buyer email" }),
          money("amount"), select("status", [ch("submitted", C.blue), ch("countered", C.amber), ch("accepted", C.green), ch("rejected", C.red), ch("withdrawn", C.gray)], { default: "submitted" }),
          ts("submitted_at", { indexed: true, label: "Submitted at" }), notes("note"),
        ],
        samples: [{ property: { ref: "properties:0" }, buyer_name: "Jordan Reed", buyer_email: "jordan@example.com", amount: 310000, status: "submitted", submitted_at: ms("2026-07-12") }],
      },
    ],
  },

  {
    id: "restaurant",
    label: "Restaurant",
    groups: ["Menu", "Front of house", "Orders"],
    description:
      "Toast/Square-grade restaurant ops: menus with categories, items and modifier groups, dietary flags, tables, reservations, and dine-in / takeout / delivery orders with line items.",
    collections: [
      {
        slug: "menu_categories", group: "Menu", singular: "Menu category", plural: "Menu categories", defaultSort: "position",
        fields: [text("name", { required: true }), notes("description"), position(), bool("active", { default: true, label: "Active" })],
        samples: [{ name: "Starters", position: 1 }, { name: "Mains", position: 2 }, { name: "Desserts", position: 3 }],
      },
      {
        slug: "menu_items", group: "Menu", singular: "Menu item", plural: "Menu items", fts: true, defaultSort: "name",
        fields: [
          text("name", { required: true, searchable: true, group: "Item" }),
          notes("description", { searchable: true, group: "Item" }),
          rel("category", "menu_categories", { group: "Item" }),
          money("price", { required: true, group: "Item" }),
          money("cost", { label: "Food cost", group: "Item" }),
          int("calories", { validation: { min: 0 }, group: "Item" }),
          int("prep_minutes", { default: 0, label: "Prep time (min)", validation: { min: 0 }, group: "Item" }),
          position("position", { group: "Item" }),
          image("image", { group: "Item" }),
          bool("available", { default: true, label: "Available", group: "Dietary" }),
          bool("spicy", { default: false, label: "Spicy", group: "Dietary" }),
          bool("vegetarian", { default: false, label: "Vegetarian", group: "Dietary" }),
          bool("vegan", { default: false, label: "Vegan", group: "Dietary" }),
          bool("gluten_free", { default: false, label: "Gluten-free", group: "Dietary" }),
        ],
        samples: [
          { name: "Bruschetta", description: "Toasted bread, tomato, basil.", category: { ref: "menu_categories:0" }, price: 8, vegetarian: true, position: 1 },
          { name: "Margherita Pizza", description: "Tomato, mozzarella, basil.", category: { ref: "menu_categories:1" }, price: 14, vegetarian: true, position: 1 },
        ],
      },
      {
        slug: "modifier_groups", group: "Menu", singular: "Modifier group", plural: "Modifier groups", defaultSort: "name",
        fields: [rel("menu_item", "menu_items"), text("name", { required: true }), int("min_select", { default: 0, label: "Min select" }), int("max_select", { default: 1, label: "Max select" }), bool("required", { default: false, label: "Required" })],
        samples: [{ menu_item: { ref: "menu_items:1" }, name: "Size", min_select: 1, max_select: 1, required: true }],
      },
      {
        slug: "modifiers", group: "Menu", singular: "Modifier", plural: "Modifiers", defaultSort: "name",
        fields: [rel("modifier_group", "modifier_groups"), text("name", { required: true }), money("price", { default: 0 })],
        samples: [{ modifier_group: { ref: "modifier_groups:0" }, name: 'Large (14")', price: 4 }, { modifier_group: { ref: "modifier_groups:0" }, name: 'Regular (10")', price: 0 }],
      },
      {
        slug: "tables", group: "Front of house", singular: "Table", plural: "Tables", defaultSort: "name",
        fields: [text("name", { required: true }), int("seats", { default: 2, validation: { min: 1 } }), text("section"), select("status", [ch("available", C.green), ch("occupied", C.amber), ch("reserved", C.blue)], { default: "available" })],
        samples: [{ name: "T1", seats: 2, section: "Patio", status: "available" }, { name: "T2", seats: 4, section: "Main", status: "available" }],
      },
      {
        slug: "reservations", group: "Front of house", singular: "Reservation", plural: "Reservations", defaultSort: "-reserved_at",
        fields: [text("name", { required: true }), email("email"), text("phone"), int("party_size", { default: 2, validation: { min: 1 }, label: "Party size" }), ts("reserved_at", { indexed: true, label: "Reserved at" }), rel("table", "tables"), select("status", [ch("pending", C.amber), ch("confirmed", C.green), ch("seated", C.blue), ch("completed", C.teal), ch("no_show", C.red, "No show"), ch("cancelled", C.gray)], { default: "pending" }), notes("notes")],
        samples: [{ name: "Jordan Reed", email: "jordan@example.com", party_size: 4, reserved_at: ms("2026-07-04T19:00:00Z"), table: { ref: "tables:1" }, status: "confirmed" }],
      },
      {
        slug: "orders", group: "Orders", singular: "Order", plural: "Orders", defaultSort: "-opened_at",
        fields: [
          text("number", { unique: true }), rel("table", "tables"),
          select("type", [ch("dine_in", C.blue, "Dine-in"), ch("takeout", C.teal), ch("delivery", C.purple)], { default: "dine_in" }),
          select("status", [ch("open", C.blue), ch("preparing", C.amber), ch("served", C.teal), ch("paid", C.green), ch("voided", C.red)], { default: "open" }),
          money("subtotal"), money("tax"), money("tip"), money("total"), ts("opened_at", { indexed: true, label: "Opened at" }),
        ],
        samples: [{ number: "R-1001", table: { ref: "tables:1" }, type: "dine_in", status: "open", subtotal: 22, tax: 1.9, total: 23.9, opened_at: ms("2026-07-04T19:15:00Z") }],
      },
      {
        slug: "order_items", group: "Orders", singular: "Order item", plural: "Order items",
        fields: [rel("order", "orders"), rel("menu_item", "menu_items"), int("qty", { default: 1, validation: { min: 1 } }), money("unit_price"), computedNum("line_total", "qty * unit_price", { label: "Line total" }), notes("special_requests", { label: "Special requests" })],
        samples: [{ order: { ref: "orders:0" }, menu_item: { ref: "menu_items:0" }, qty: 1, unit_price: 8 }, { order: { ref: "orders:0" }, menu_item: { ref: "menu_items:1" }, qty: 1, unit_price: 14 }],
      },
    ],
  },

  {
    id: "lms",
    label: "Online courses (LMS)",
    groups: ["Curriculum", "People", "Assessment", "Progress"],
    description:
      "Canvas/Teachable-grade learning platform: courses with modules & lessons, instructors, students and enrollments with progress, quizzes with questions & graded attempts, certificates and course reviews.",
    collections: [
      {
        slug: "categories", group: "Curriculum", singular: "Category", plural: "Categories", defaultSort: "name",
        fields: [text("name", { required: true }), slugField(), parent("categories")],
        samples: [{ name: "Programming", slug: "programming" }, { name: "Design", slug: "design" }],
      },
      {
        slug: "instructors", group: "People", singular: "Instructor", plural: "Instructors", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true }), notes("bio"), image("avatar")],
        samples: [{ name: "Dr. Ada Lovelace", email: "ada@academy.example", bio: "Teaches computing fundamentals." }],
      },
      {
        slug: "courses", group: "Curriculum", singular: "Course", plural: "Courses", versioned: true, vectorize: true, fts: true, defaultSort: "title",
        fields: [
          text("title", { required: true, vectorize: true, searchable: true, group: "Course" }),
          slugField("slug", { group: "Course" }),
          text("subtitle", { group: "Course" }),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true, group: "Course" },
          rel("instructor", "instructors", { group: "Course" }),
          rel("category", "categories", { group: "Course" }),
          select("level", [ch("beginner", C.green), ch("intermediate", C.amber), ch("advanced", C.red), ch("all_levels", C.blue, "All levels")], { default: "beginner", group: "Details" }),
          select("pricing_type", [ch("free", C.green), ch("one_time", C.blue, "One-time"), ch("subscription", C.purple), ch("payment_plan", C.amber, "Payment plan")], { default: "free", label: "Pricing", group: "Details" }),
          money("price", { default: 0, group: "Details" }),
          select("currency", ["USD", "EUR", "GBP"], { default: "USD", group: "Details" }),
          select("status", [ch("draft", C.gray), ch("published", C.green), ch("archived", C.slate)], { default: "draft", group: "Details" }),
          image("thumbnail", { group: "Media" }),
          int("duration_minutes", { default: 0, label: "Duration (min)", validation: { min: 0 }, group: "Media" }),
          text("language", { default: "en", group: "Media" }),
          ts("published_at", { indexed: true, label: "Published at", group: "Media" }),
        ],
        samples: [{ title: "Intro to Programming", slug: "intro-to-programming", subtitle: "Start coding from zero", description: "Start coding from zero.", instructor: { ref: "instructors:0" }, category: { ref: "categories:0" }, level: "beginner", pricing_type: "free", price: 0, status: "published", duration_minutes: 240 }],
      },
      {
        slug: "modules", group: "Curriculum", singular: "Module", plural: "Modules", defaultSort: "position",
        fields: [rel("course", "courses"), text("title", { required: true }), notes("description"), position(), bool("published", { default: true, label: "Published" })],
        samples: [{ course: { ref: "courses:0" }, title: "Getting started", position: 1 }, { course: { ref: "courses:0" }, title: "Variables & types", position: 2 }],
      },
      {
        slug: "lessons", group: "Curriculum", singular: "Lesson", plural: "Lessons", defaultSort: "position",
        fields: [
          rel("module", "modules"), rel("course", "courses"), text("title", { required: true }),
          select("type", [ch("video", C.blue), ch("text", C.gray), ch("quiz", C.purple), ch("pdf", C.amber), ch("audio", C.teal), ch("assignment", C.red)], { default: "video" }),
          { name: "content", type: "longtext", interface: "richtext" }, url("video_url", { label: "Video URL" }),
          int("duration_minutes", { default: 0, label: "Duration (min)", validation: { min: 0 } }),
          position(), bool("free_preview", { default: false, label: "Free preview" }), bool("published", { default: true, label: "Published" }),
        ],
        samples: [{ module: { ref: "modules:0" }, course: { ref: "courses:0" }, title: "Welcome", type: "video", content: "Course overview.", duration_minutes: 5, position: 1, free_preview: true }],
      },
      {
        slug: "students", group: "People", singular: "Student", plural: "Students", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true }), image("avatar")],
        samples: [{ name: "Sam Taylor", email: "sam@student.example" }],
      },
      {
        slug: "enrollments", group: "Progress", singular: "Enrollment", plural: "Enrollments", ownerScoped: true, defaultSort: "-enrolled_at",
        fields: [
          rel("student", "students"), rel("course", "courses"),
          select("status", [ch("active", C.green), ch("completed", C.blue), ch("expired", C.amber), ch("cancelled", C.gray)], { default: "active" }),
          pct("progress", { default: 0, label: "Progress (%)" }),
          ts("enrolled_at", { indexed: true, label: "Enrolled at" }), ts("completed_at", { label: "Completed at" }), ts("expires_at", { label: "Expires at" }),
        ],
        samples: [{ student: { ref: "students:0" }, course: { ref: "courses:0" }, status: "active", progress: 35, enrolled_at: ms("2026-06-01") }],
      },
      {
        slug: "quizzes", group: "Assessment", singular: "Quiz", plural: "Quizzes", defaultSort: "title",
        fields: [
          rel("course", "courses"), rel("lesson", "lessons"), text("title", { required: true }), notes("description"),
          select("type", [ch("graded", C.green), ch("practice", C.blue), ch("survey", C.gray), ch("exam", C.red)], { default: "graded" }),
          pct("passing_score", { default: 70, label: "Passing score (%)" }),
          int("max_attempts", { default: 0, validation: { min: 0 }, label: "Max attempts (0 = ∞)" }),
          int("time_limit_minutes", { label: "Time limit (min)", validation: { min: 0 } }),
        ],
        samples: [{ course: { ref: "courses:0" }, lesson: { ref: "lessons:0" }, title: "Module 1 quiz", type: "graded", passing_score: 70, max_attempts: 3 }],
      },
      {
        slug: "questions", group: "Assessment", singular: "Question", plural: "Questions", defaultSort: "position",
        fields: [
          rel("quiz", "quizzes"), notes("prompt"),
          select("type", [ch("multiple_choice", C.blue, "Multiple choice"), ch("true_false", C.teal, "True / false"), ch("multiple_answers", C.purple, "Multiple answers"), ch("short_answer", C.amber, "Short answer"), ch("essay", C.gray)], { default: "multiple_choice" }),
          num("points", { default: 1, validation: { min: 0 } }), position(),
          { name: "options", type: "json", interface: "json", label: "Choices" }, notes("explanation"),
        ],
        samples: [{ quiz: { ref: "quizzes:0" }, prompt: "What is a variable?", type: "multiple_choice", points: 1, position: 1 }],
      },
      {
        slug: "quiz_attempts", group: "Assessment", singular: "Attempt", plural: "Attempts", ownerScoped: true, defaultSort: "-started_at",
        fields: [
          rel("quiz", "quizzes"), rel("student", "students"), rel("enrollment", "enrollments"),
          int("attempt_number", { default: 1, label: "Attempt #", validation: { min: 1 } }),
          num("score", { validation: { min: 0 } }), bool("passed", { default: false, label: "Passed" }),
          select("status", [ch("in_progress", C.blue, "In progress"), ch("submitted", C.amber), ch("graded", C.green), ch("abandoned", C.gray)], { default: "in_progress" }),
          ts("started_at", { indexed: true, label: "Started at" }), ts("submitted_at", { label: "Submitted at" }),
        ],
        samples: [{ quiz: { ref: "quizzes:0" }, student: { ref: "students:0" }, enrollment: { ref: "enrollments:0" }, attempt_number: 1, score: 80, passed: true, status: "graded", started_at: ms("2026-06-05") }],
      },
      {
        slug: "certificates", group: "Progress", singular: "Certificate", plural: "Certificates", defaultSort: "-issued_at",
        fields: [rel("student", "students"), rel("course", "courses"), rel("enrollment", "enrollments"), text("serial", { unique: true, label: "Serial number" }), ts("issued_at", { indexed: true, label: "Issued at" }), date("expires_at", { label: "Expires at" }), select("status", [ch("issued", C.green), ch("revoked", C.red), ch("expired", C.gray)], { default: "issued" })],
        samples: [{ student: { ref: "students:0" }, course: { ref: "courses:0" }, enrollment: { ref: "enrollments:0" }, serial: "CERT-0001", issued_at: ms("2026-06-30"), status: "issued" }],
      },
      {
        slug: "reviews", group: "Progress", singular: "Review", plural: "Reviews", ownerScoped: true, defaultSort: "-created_at",
        fields: [rel("student", "students"), rel("course", "courses"), rating("rating"), text("title"), notes("body"), select("status", [ch("pending", C.amber), ch("published", C.green), ch("hidden", C.gray)], { default: "pending" })],
        samples: [{ student: { ref: "students:0" }, course: { ref: "courses:0" }, rating: 5, title: "Loved it", body: "Clear and beginner-friendly.", status: "published" }],
      },
    ],
  },

  {
    id: "ats",
    label: "Recruiting (ATS)",
    groups: ["Jobs", "Candidates", "Hiring"],
    description:
      "Greenhouse/Lever-grade applicant tracking: job requisitions, candidates, a configurable interview pipeline of stages, applications (status separate from stage), interviews, scorecards and offers.",
    collections: [
      {
        slug: "departments", group: "Jobs", singular: "Department", plural: "Departments", defaultSort: "name",
        fields: [text("name", { required: true })],
        samples: [{ name: "Engineering" }, { name: "Marketing" }],
      },
      {
        slug: "jobs", group: "Jobs", singular: "Job", plural: "Jobs", versioned: true, fts: true, defaultSort: "-created_at",
        fields: [
          text("title", { required: true, searchable: true, group: "Job" }),
          slugField("slug", { group: "Job" }),
          text("requisition_id", { label: "Requisition ID", group: "Job" }),
          { name: "description", type: "longtext", interface: "richtext", searchable: true, group: "Job" },
          rel("department", "departments", { group: "Job" }),
          text("location", { group: "Details" }),
          select("employment_type", [ch("full_time", C.green, "Full time"), ch("part_time", C.blue, "Part time"), ch("contract", C.amber), ch("internship", C.teal), ch("temporary", C.gray)], { default: "full_time", label: "Employment type", group: "Details" }),
          select("status", [ch("draft", C.gray), ch("open", C.green), ch("on_hold", C.amber, "On hold"), ch("closed", C.slate), ch("filled", C.blue)], { default: "open", group: "Details" }),
          int("openings", { default: 1, validation: { min: 0 }, group: "Details" }),
          text("hiring_manager", { label: "Hiring manager", group: "Details" }),
          text("recruiter", { group: "Details" }),
          money("salary_min", { label: "Salary min", group: "Compensation" }),
          money("salary_max", { label: "Salary max", group: "Compensation" }),
          select("salary_currency", ["USD", "EUR", "GBP"], { default: "USD", label: "Currency", group: "Compensation" }),
        ],
        samples: [{ title: "Senior Backend Engineer", slug: "senior-backend-engineer", requisition_id: "REQ-001", description: "Build our API platform.", department: { ref: "departments:0" }, location: "Remote", employment_type: "full_time", status: "open", openings: 2, hiring_manager: "Grace Hopper", salary_min: 120000, salary_max: 160000 }],
      },
      {
        slug: "stages", group: "Hiring", singular: "Stage", plural: "Stages", defaultSort: "position",
        fields: [
          rel("job", "jobs"), text("name", { required: true }),
          select("type", [ch("application_review", C.gray, "Application review"), ch("assessment", C.teal), ch("phone_interview", C.blue, "Phone interview"), ch("onsite_interview", C.amber, "Onsite interview"), ch("offer", C.purple), ch("hired", C.green)], { default: "application_review", label: "Stage type" }),
          position(),
        ],
        samples: [
          { job: { ref: "jobs:0" }, name: "Application Review", type: "application_review", position: 1 },
          { job: { ref: "jobs:0" }, name: "Phone Screen", type: "phone_interview", position: 2 },
          { job: { ref: "jobs:0" }, name: "Onsite", type: "onsite_interview", position: 3 },
          { job: { ref: "jobs:0" }, name: "Offer", type: "offer", position: 4 },
        ],
      },
      {
        slug: "candidates", group: "Candidates", singular: "Candidate", plural: "Candidates", fts: true, defaultSort: "last_name",
        fields: [
          text("first_name", { label: "First name", searchable: true }), text("last_name", { label: "Last name", searchable: true }),
          email("email", { unique: true }), text("phone"), file("resume"), url("linkedin", { label: "LinkedIn" }),
          text("location"), text("current_company", { label: "Current company" }), text("current_title", { label: "Current title" }),
          select("source", [ch("inbound", C.blue), ch("referral", C.green), ch("sourced", C.purple), ch("agency", C.amber), ch("job_board", C.teal, "Job board"), ch("event", C.gray), ch("social_media", C.slate, "Social media")], { default: "inbound" }),
        ],
        samples: [{ first_name: "Jordan", last_name: "Reed", email: "jordan@example.com", phone: "+1 555 0123", current_company: "Initech", current_title: "Backend Engineer", source: "referral" }],
      },
      {
        slug: "applications", group: "Candidates", singular: "Application", plural: "Applications", ownerScoped: true, defaultSort: "-applied_at",
        fields: [
          rel("job", "jobs"), rel("candidate", "candidates"), rel("stage", "stages"),
          select("status", [ch("active", C.blue), ch("rejected", C.red), ch("hired", C.green)], { default: "active" }),
          select("source", [ch("inbound", C.blue), ch("referral", C.green), ch("sourced", C.purple), ch("agency", C.amber), ch("job_board", C.teal, "Job board")], { default: "inbound" }),
          rating("rating"), text("rejection_reason", { label: "Rejection reason" }), notes("notes"), ts("applied_at", { indexed: true, label: "Applied at" }),
        ],
        samples: [{ job: { ref: "jobs:0" }, candidate: { ref: "candidates:0" }, stage: { ref: "stages:1" }, status: "active", source: "referral", rating: 4, notes: "Strong background — schedule a call.", applied_at: ms("2026-06-15") }],
      },
      {
        slug: "interviews", group: "Hiring", singular: "Interview", plural: "Interviews", defaultSort: "-scheduled_at",
        fields: [
          rel("application", "applications"), rel("stage", "stages"), text("interviewer"),
          ts("scheduled_at", { indexed: true, label: "Scheduled at" }), int("duration_minutes", { default: 60, label: "Duration (min)", validation: { min: 0 } }),
          select("status", [ch("scheduled", C.blue), ch("completed", C.green), ch("cancelled", C.gray), ch("no_show", C.red, "No show")], { default: "scheduled" }),
          notes("feedback"),
        ],
        samples: [{ application: { ref: "applications:0" }, stage: { ref: "stages:1" }, interviewer: "Grace Hopper", scheduled_at: ms("2026-06-22T16:00:00Z"), status: "scheduled" }],
      },
      {
        slug: "scorecards", group: "Hiring", singular: "Scorecard", plural: "Scorecards", defaultSort: "-created_at",
        fields: [rel("interview", "interviews"), rel("application", "applications"), text("interviewer"), select("recommendation", [ch("strong_yes", C.green, "Strong yes"), ch("yes", C.teal), ch("no", C.amber), ch("strong_no", C.red, "Strong no"), ch("no_decision", C.gray, "No decision")], { default: "no_decision" }), notes("notes")],
        samples: [{ interview: { ref: "interviews:0" }, application: { ref: "applications:0" }, interviewer: "Grace Hopper", recommendation: "yes", notes: "Solid systems-design answers." }],
      },
      {
        slug: "offers", group: "Hiring", singular: "Offer", plural: "Offers", defaultSort: "-created_at",
        fields: [
          rel("application", "applications"), rel("candidate", "candidates"), rel("job", "jobs"),
          money("salary"), select("currency", ["USD", "EUR", "GBP"], { default: "USD" }),
          date("start_date", { label: "Start date" }),
          select("status", [ch("draft", C.gray), ch("approved", C.blue), ch("sent", C.amber), ch("accepted", C.green), ch("declined", C.red), ch("rescinded", C.slate)], { default: "draft" }),
          ts("sent_at", { label: "Sent at" }),
        ],
        samples: [{ application: { ref: "applications:0" }, candidate: { ref: "candidates:0" }, job: { ref: "jobs:0" }, salary: 150000, currency: "USD", start_date: ms("2026-08-01"), status: "draft" }],
      },
    ],
  },

  {
    id: "marketplace",
    label: "Marketplace",
    groups: ["Catalog", "Vendors", "Orders", "Customers"],
    description:
      "Amazon/Etsy-grade multi-vendor marketplace: vendors with commission & payouts, category tree, listings, buyers, orders split into per-vendor line items, and moderated reviews.",
    collections: [
      { slug: "media", group: "Catalog", singular: "Media", plural: "Media", fields: [image("file"), text("alt", { label: "Alt text" })] },
      {
        slug: "vendors", group: "Vendors", singular: "Vendor", plural: "Vendors", defaultSort: "name",
        fields: [
          text("name", { required: true }), slugField(), email("email", { unique: true }), notes("description"), image("logo"),
          select("status", [ch("pending", C.amber), ch("active", C.green), ch("suspended", C.red)], { default: "pending" }),
          num("commission_pct", { default: 10, validation: { min: 0, max: 100 }, label: "Commission (%)" }),
          num("rating", { validation: { min: 0, max: 5 }, label: "Rating" }),
          text("payout_account", { label: "Payout account" }),
        ],
        samples: [{ name: "Acme Goods", slug: "acme-goods", email: "sales@acme.example", status: "active", commission_pct: 12, rating: 4.7 }],
      },
      {
        slug: "categories", group: "Catalog", singular: "Category", plural: "Categories", defaultSort: "name",
        fields: [text("name", { required: true }), slugField(), parent("categories")],
        samples: [{ name: "Home", slug: "home" }, { name: "Outdoors", slug: "outdoors" }],
      },
      {
        slug: "listings", group: "Catalog", singular: "Listing", plural: "Listings", versioned: true, vectorize: true, fts: true, defaultSort: "-created_at",
        fields: [
          text("title", { required: true, vectorize: true, searchable: true, group: "Listing" }),
          slugField("slug", { group: "Listing" }),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true, group: "Listing" },
          rel("vendor", "vendors", { group: "Listing" }),
          rel("category", "categories", { group: "Listing" }),
          text("sku", { label: "SKU", group: "Listing" }),
          tags("tags", { group: "Listing" }),
          money("price", { required: true, group: "Pricing" }),
          money("compare_at_price", { label: "Compare-at price", group: "Pricing" }),
          select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD", group: "Pricing" }),
          select("condition", [ch("new", C.green), ch("used", C.amber), ch("refurbished", C.blue)], { default: "new", group: "Pricing" }),
          int("stock", { default: 0, validation: { min: 0 }, group: "Pricing" }),
          select("status", [ch("draft", C.gray), ch("active", C.green), ch("paused", C.amber), ch("sold_out", C.red, "Sold out")], { default: "active", group: "Pricing" }),
          image("cover", { group: "Media" }),
          relMany("images", "media", { group: "Media" }),
          bool("featured", { default: false, label: "Featured", group: "Media" }),
        ],
        samples: [{ title: "Camp Stove", slug: "camp-stove", description: "Compact gas stove.", vendor: { ref: "vendors:0" }, category: { ref: "categories:1" }, sku: "CAMP-STOVE-1", price: 45, currency: "USD", condition: "new", stock: 30, status: "active" }],
      },
      {
        slug: "buyers", group: "Customers", singular: "Buyer", plural: "Buyers", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true }), text("phone")],
        samples: [{ name: "Sam Taylor", email: "sam@example.com" }],
      },
      {
        slug: "orders", group: "Orders", singular: "Order", plural: "Orders", defaultSort: "-placed_at",
        fields: [text("number", { unique: true }), rel("buyer", "buyers"), select("status", [ch("pending", C.amber), ch("paid", C.green), ch("shipped", C.blue), ch("delivered", C.teal), ch("refunded", C.red)], { default: "pending" }), money("subtotal"), money("total"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }), ts("placed_at", { indexed: true, label: "Placed at" })],
        samples: [{ number: "M-1001", buyer: { ref: "buyers:0" }, status: "paid", subtotal: 45, total: 45, currency: "USD", placed_at: ms("2026-06-18") }],
      },
      {
        slug: "order_items", group: "Orders", singular: "Order item", plural: "Order items",
        fields: [rel("order", "orders"), rel("listing", "listings"), rel("vendor", "vendors"), int("qty", { default: 1, validation: { min: 1 } }), money("unit_price"), computedNum("line_total", "qty * unit_price", { label: "Line total" })],
        samples: [{ order: { ref: "orders:0" }, listing: { ref: "listings:0" }, vendor: { ref: "vendors:0" }, qty: 1, unit_price: 45 }],
      },
      {
        slug: "payouts", group: "Vendors", singular: "Payout", plural: "Payouts", defaultSort: "-period_end",
        fields: [rel("vendor", "vendors"), money("amount"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }), select("status", [ch("pending", C.amber), ch("paid", C.green), ch("failed", C.red)], { default: "pending" }), date("period_start", { label: "Period start" }), date("period_end", { indexed: true, label: "Period end" })],
        samples: [{ vendor: { ref: "vendors:0" }, amount: 39.6, currency: "USD", status: "pending", period_start: ms("2026-06-01"), period_end: ms("2026-06-30") }],
      },
      {
        slug: "reviews", group: "Customers", singular: "Review", plural: "Reviews", ownerScoped: true, defaultSort: "-created_at",
        fields: [rel("listing", "listings"), rel("buyer", "buyers"), rating("rating"), text("title"), notes("body"), bool("verified_purchase", { default: false, label: "Verified purchase" }), select("status", [ch("pending", C.amber), ch("approved", C.green), ch("rejected", C.red)], { default: "pending" })],
        samples: [{ listing: { ref: "listings:0" }, buyer: { ref: "buyers:0" }, rating: 5, title: "Great for trips", body: "Works great on trips.", verified_purchase: true, status: "approved" }],
      },
    ],
  },

  {
    id: "nonprofit",
    label: "Nonprofit",
    groups: ["Donors", "Fundraising", "Volunteering"],
    description:
      "Salesforce NPSP-grade fundraising: donors, campaigns, donations (one-time & recurring), pledges, grants, volunteers, events and volunteer shifts.",
    collections: [
      {
        slug: "donors", group: "Donors", singular: "Donor", plural: "Donors", defaultSort: "name",
        fields: [
          text("name", { required: true }), email("email", { unique: true }), text("phone"),
          select("type", [ch("individual", C.blue), ch("organization", C.purple), ch("foundation", C.teal)], { default: "individual" }),
          text("address"), text("city"), text("country"),
          money("total_donated", { default: 0, label: "Total donated" }),
          date("first_gift_at", { label: "First gift" }), date("last_gift_at", { label: "Last gift" }),
        ],
        samples: [{ name: "Jordan Reed", email: "jordan@example.com", type: "individual", total_donated: 100 }, { name: "Globex Foundation", email: "giving@globex.example", type: "foundation", total_donated: 25000 }],
      },
      {
        slug: "campaigns", group: "Fundraising", singular: "Campaign", plural: "Campaigns", defaultSort: "-created_at",
        fields: [
          text("name", { required: true, group: "Campaign" }),
          slugField("slug", { group: "Campaign" }),
          { name: "description", type: "longtext", interface: "richtext", group: "Campaign" },
          select("type", [ch("annual_fund", C.blue, "Annual fund"), ch("capital", C.purple), ch("event", C.amber), ch("emergency", C.red)], { default: "annual_fund", group: "Campaign" }),
          money("goal_amount", { label: "Goal", group: "Progress" }),
          money("raised_amount", { default: 0, label: "Raised", group: "Progress" }),
          select("status", [ch("planned", C.gray), ch("active", C.green), ch("paused", C.amber), ch("completed", C.blue)], { default: "planned", group: "Progress" }),
          date("starts_at", { indexed: true, label: "Starts at", group: "Progress" }),
          date("ends_at", { label: "Ends at", group: "Progress" }),
        ],
        samples: [{ name: "Winter Fund", slug: "winter-fund", description: "Support families this winter.", type: "emergency", goal_amount: 50000, raised_amount: 12500, status: "active", starts_at: ms("2026-11-01"), ends_at: ms("2026-12-31") }],
      },
      {
        slug: "donations", group: "Fundraising", singular: "Donation", plural: "Donations", ownerScoped: true, defaultSort: "-donated_at",
        fields: [
          rel("donor", "donors"), rel("campaign", "campaigns"), money("amount", { required: true }),
          select("currency", ["USD", "EUR", "GBP"], { default: "USD" }),
          select("type", [ch("one_time", C.blue, "One-time"), ch("recurring", C.purple)], { default: "one_time", label: "Gift type" }),
          select("payment_method", [ch("card", C.blue), ch("bank_transfer", C.teal, "Bank transfer"), ch("cash", C.gray), ch("check", C.amber)], { default: "card", label: "Payment method" }),
          select("status", [ch("pending", C.amber), ch("completed", C.green), ch("refunded", C.red)], { default: "completed" }),
          bool("anonymous", { default: false, label: "Anonymous" }), bool("tax_receipt_sent", { default: false, label: "Tax receipt sent" }),
          ts("donated_at", { indexed: true, label: "Donated at" }),
        ],
        samples: [{ donor: { ref: "donors:0" }, campaign: { ref: "campaigns:0" }, amount: 100, currency: "USD", type: "one_time", payment_method: "card", status: "completed", donated_at: ms("2026-11-10") }],
      },
      {
        slug: "pledges", group: "Fundraising", singular: "Pledge", plural: "Pledges", defaultSort: "-created_at",
        fields: [rel("donor", "donors"), rel("campaign", "campaigns"), money("amount"), int("installments", { default: 1, validation: { min: 1 } }), select("status", [ch("active", C.green), ch("fulfilled", C.blue), ch("cancelled", C.gray)], { default: "active" }), date("start_date", { label: "Start date" })],
        samples: [{ donor: { ref: "donors:1" }, campaign: { ref: "campaigns:0" }, amount: 12000, installments: 12, status: "active", start_date: ms("2026-01-01") }],
      },
      {
        slug: "grants", group: "Fundraising", singular: "Grant", plural: "Grants", defaultSort: "-applied_at",
        fields: [text("name", { required: true }), text("funder"), money("amount"), select("status", [ch("researching", C.gray), ch("applied", C.blue), ch("awarded", C.green), ch("declined", C.red)], { default: "researching" }), date("applied_at", { indexed: true, label: "Applied at" }), date("decision_at", { label: "Decision date" })],
        samples: [{ name: "Community Resilience Grant", funder: "City Foundation", amount: 30000, status: "applied", applied_at: ms("2026-05-01") }],
      },
      {
        slug: "volunteers", group: "Volunteering", singular: "Volunteer", plural: "Volunteers", defaultSort: "name",
        fields: [text("name", { required: true }), email("email"), text("phone"), notes("skills"), select("status", [ch("active", C.green), ch("inactive", C.gray)], { default: "active" })],
        samples: [{ name: "Casey Morgan", email: "casey@example.com", skills: "Event setup, outreach.", status: "active" }],
      },
      {
        slug: "events", group: "Volunteering", singular: "Event", plural: "Events", defaultSort: "-starts_at",
        fields: [text("title", { required: true }), slugField(), { name: "description", type: "longtext", interface: "richtext" }, ts("starts_at", { indexed: true, label: "Starts at" }), text("location"), int("capacity", { validation: { min: 0 } })],
        samples: [{ title: "Charity Gala", slug: "charity-gala", description: "Annual fundraising gala.", starts_at: ms("2026-12-05T18:00:00Z"), location: "Grand Hotel", capacity: 200 }],
      },
      {
        slug: "volunteer_shifts", group: "Volunteering", singular: "Shift", plural: "Shifts", defaultSort: "-created_at",
        fields: [rel("event", "events"), rel("volunteer", "volunteers"), text("role"), num("hours", { validation: { min: 0 } }), select("status", [ch("scheduled", C.blue), ch("completed", C.green), ch("no_show", C.red, "No show")], { default: "scheduled" })],
        samples: [{ event: { ref: "events:0" }, volunteer: { ref: "volunteers:0" }, role: "Registration desk", hours: 4, status: "scheduled" }],
      },
    ],
  },

  {
    id: "forms",
    label: "Forms & surveys",
    groups: ["Forms", "Results"],
    description:
      "Typeform-grade form builder: forms with a typed question bank (text, choice, rating, file…), required & conditional fields, complete/partial responses and per-question answers.",
    collections: [
      {
        slug: "forms", group: "Forms", singular: "Form", plural: "Forms", defaultSort: "-created_at",
        fields: [
          text("name", { required: true }), slugField(), notes("description"),
          select("status", [ch("draft", C.gray), ch("published", C.green), ch("closed", C.red)], { default: "draft" }),
          notes("submit_message", { label: "Thank-you message" }),
          int("response_count", { default: 0, validation: { min: 0 }, label: "Responses" }),
          bool("allow_multiple", { default: true, label: "Allow multiple submissions" }),
          bool("requires_login", { default: false, label: "Requires login" }),
        ],
        samples: [{ name: "Customer Feedback", slug: "customer-feedback", description: "Tell us how we did.", status: "published", submit_message: "Thanks for your feedback!" }],
      },
      {
        slug: "questions", group: "Forms", singular: "Question", plural: "Questions", defaultSort: "position",
        fields: [
          rel("form", "forms"), text("label", { required: true }), text("help_text", { label: "Help text" }),
          select("type", [ch("short_text", C.blue, "Short text"), ch("long_text", C.teal, "Long text"), ch("email", C.purple), ch("number", C.gray), ch("single_select", C.amber, "Single choice"), ch("multi_select", C.amber, "Multiple choice"), ch("rating", C.green), ch("date", C.slate), ch("file", C.gray), ch("yes_no", C.blue, "Yes / no")], { default: "short_text" }),
          position(), bool("required", { default: false }),
          { name: "options", type: "json", interface: "json", label: "Choices" },
        ],
        samples: [
          { form: { ref: "forms:0" }, label: "How satisfied were you?", type: "rating", position: 1, required: true },
          { form: { ref: "forms:0" }, label: "Any other comments?", type: "long_text", position: 2 },
        ],
      },
      {
        slug: "responses", group: "Results", singular: "Response", plural: "Responses", defaultSort: "-submitted_at",
        fields: [rel("form", "forms"), email("email"), select("status", [ch("complete", C.green), ch("partial", C.amber)], { default: "complete" }), ts("submitted_at", { indexed: true, label: "Submitted at" })],
        samples: [{ form: { ref: "forms:0" }, email: "jordan@example.com", status: "complete", submitted_at: ms("2026-06-20") }],
      },
      {
        slug: "answers", group: "Results", singular: "Answer", plural: "Answers",
        fields: [rel("response", "responses"), rel("question", "questions"), notes("value")],
        samples: [
          { response: { ref: "responses:0" }, question: { ref: "questions:0" }, value: "5" },
          { response: { ref: "responses:0" }, question: { ref: "questions:1" }, value: "Loved the support." },
        ],
      },
    ],
  },

  {
    id: "invoicing",
    label: "Invoicing / Billing",
    groups: ["Billing", "Expenses", "Settings"],
    description:
      "QuickBooks-grade billing: customers with payment terms, invoices with line items and taxes, payments, credit notes, and company expenses with approval status.",
    collections: [
      {
        slug: "taxes", group: "Settings", singular: "Tax", plural: "Taxes", defaultSort: "name",
        fields: [text("name", { required: true }), num("rate", { validation: { min: 0, max: 100 }, label: "Rate (%)" }), bool("active", { default: true, label: "Active" })],
        samples: [{ name: "VAT 20%", rate: 20, active: true }, { name: "Sales tax 8.5%", rate: 8.5, active: true }],
      },
      {
        slug: "customers", group: "Billing", singular: "Customer", plural: "Customers", fts: true, defaultSort: "name",
        fields: [
          text("name", { required: true, searchable: true, group: "Customer" }),
          email("email", { group: "Customer" }), text("phone", { group: "Customer" }),
          text("tax_number", { label: "Tax number", group: "Customer" }),
          text("address", { group: "Address" }), text("city", { group: "Address" }), text("country", { group: "Address" }),
          select("payment_terms", [ch("due_on_receipt", C.green, "Due on receipt"), ch("net_15", C.blue, "Net 15"), ch("net_30", C.teal, "Net 30"), ch("net_60", C.amber, "Net 60")], { default: "net_30", label: "Payment terms", group: "Billing" }),
          select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD", group: "Billing" }),
          notes("notes", { group: "Billing" }), bool("active", { default: true, label: "Active", group: "Billing" }),
        ],
        samples: [
          { name: "Acme Corp", email: "billing@acme.example", tax_number: "US-88-1234567", city: "Chicago", country: "US", payment_terms: "net_30", currency: "USD", active: true },
          { name: "Nordwind GmbH", email: "finanz@nordwind.example", tax_number: "DE123456789", city: "Hamburg", country: "DE", payment_terms: "net_15", currency: "EUR", active: true },
        ],
      },
      {
        slug: "invoices", group: "Billing", singular: "Invoice", plural: "Invoices", defaultSort: "-issue_date",
        fields: [
          text("number", { required: true, unique: true, group: "Invoice" }),
          rel("customer", "customers", { group: "Invoice" }),
          select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("partial", C.amber, "Partially paid"), ch("paid", C.green), ch("overdue", C.red), ch("void", C.slate)], { default: "draft", group: "Invoice" }),
          date("issue_date", { indexed: true, label: "Issue date", group: "Invoice" }),
          date("due_date", { indexed: true, label: "Due date", group: "Invoice" }),
          select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD", group: "Amounts" }),
          money("subtotal", { group: "Amounts" }), money("tax_total", { label: "Tax", group: "Amounts" }), money("total", { group: "Amounts" }),
          money("amount_paid", { label: "Amount paid", group: "Amounts" }),
          computedNum("balance_due", "total - amount_paid", { label: "Balance due", group: "Amounts" }),
          notes("notes", { group: "Amounts" }),
        ],
        samples: [
          { number: "INV-2026-001", customer: { ref: "customers:0" }, status: "paid", issue_date: ms("2026-06-01"), due_date: ms("2026-07-01"), currency: "USD", subtotal: 4800, tax_total: 408, total: 5208, amount_paid: 5208 },
          { number: "INV-2026-002", customer: { ref: "customers:1" }, status: "sent", issue_date: ms("2026-06-20"), due_date: ms("2026-07-05"), currency: "EUR", subtotal: 1500, tax_total: 300, total: 1800, amount_paid: 0 },
        ],
      },
      {
        slug: "invoice_lines", group: "Billing", singular: "Line item", plural: "Line items",
        fields: [
          rel("invoice", "invoices"), text("description", { required: true }),
          num("quantity", { default: 1, validation: { min: 0 } }), money("unit_price", { label: "Unit price" }),
          rel("tax", "taxes"), computedNum("line_total", "quantity * unit_price", { label: "Line total" }),
        ],
        samples: [
          { invoice: { ref: "invoices:0" }, description: "Consulting — June retainer", quantity: 32, unit_price: 150, tax: { ref: "taxes:1" } },
          { invoice: { ref: "invoices:1" }, description: "Design sprint", quantity: 1, unit_price: 1500, tax: { ref: "taxes:0" } },
        ],
      },
      {
        slug: "payments", group: "Billing", singular: "Payment", plural: "Payments", defaultSort: "-received_at",
        fields: [
          rel("invoice", "invoices"), rel("customer", "customers"), money("amount"),
          select("method", [ch("bank_transfer", C.blue, "Bank transfer"), ch("card", C.purple), ch("cash", C.green), ch("check", C.gray), ch("other", C.slate)], { default: "bank_transfer" }),
          date("received_at", { indexed: true, label: "Received at" }), text("reference"),
        ],
        samples: [{ invoice: { ref: "invoices:0" }, customer: { ref: "customers:0" }, amount: 5208, method: "bank_transfer", received_at: ms("2026-06-28"), reference: "WIRE-84413" }],
      },
      {
        slug: "credit_notes", group: "Billing", singular: "Credit note", plural: "Credit notes", defaultSort: "-issued_at",
        fields: [
          text("number", { required: true, unique: true }), rel("invoice", "invoices"), rel("customer", "customers"), money("amount"),
          select("status", [ch("draft", C.gray), ch("issued", C.blue), ch("applied", C.green)], { default: "draft" }),
          select("reason", [ch("return", C.amber), ch("correction", C.blue), ch("goodwill", C.teal), ch("duplicate", C.gray)], { default: "correction" }),
          date("issued_at", { indexed: true, label: "Issued at" }), notes("note"),
        ],
        samples: [{ number: "CN-2026-001", invoice: { ref: "invoices:0" }, customer: { ref: "customers:0" }, amount: 150, status: "applied", reason: "correction", issued_at: ms("2026-06-30"), note: "Overbilled one consulting hour." }],
      },
      {
        slug: "expenses", group: "Expenses", singular: "Expense", plural: "Expenses", defaultSort: "-spent_at",
        fields: [
          text("merchant", { required: true, group: "Expense" }),
          select("category", [ch("travel", C.blue), ch("meals", C.amber), ch("office", C.teal), ch("software", C.purple), ch("other", C.gray)], { default: "other", group: "Expense" }),
          money("amount", { group: "Expense" }), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD", group: "Expense" }),
          date("spent_at", { indexed: true, label: "Spent at", group: "Expense" }),
          select("status", [ch("submitted", C.blue), ch("approved", C.green), ch("reimbursed", C.teal), ch("rejected", C.red)], { default: "submitted", group: "Approval" }),
          text("submitted_by", { label: "Submitted by", group: "Approval" }),
          bool("billable", { default: false, label: "Billable to a customer", group: "Approval" }),
          rel("customer", "customers", { label: "Re-invoice to", group: "Approval" }),
          file("receipt", { group: "Approval" }),
        ],
        samples: [
          { merchant: "Delta Airlines", category: "travel", amount: 420, currency: "USD", spent_at: ms("2026-06-12"), status: "approved", submitted_by: "Sam Carter", billable: true, customer: { ref: "customers:0" } },
          { merchant: "Figma", category: "software", amount: 45, currency: "USD", spent_at: ms("2026-06-15"), status: "submitted", submitted_by: "Robin Vale" },
        ],
      },
    ],
    roles: [
      {
        name: "Bookkeeper",
        description: "Manage invoices, payments, credit notes and expenses; read customers and taxes.",
        permissions: [
          { collection: "taxes", action: "read" },
          { collection: "customers", action: "read" },
          { collection: "invoices", action: "read" },
          { collection: "invoices", action: "create" },
          { collection: "invoices", action: "update" },
          { collection: "invoice_lines", action: "read" },
          { collection: "invoice_lines", action: "create" },
          { collection: "invoice_lines", action: "update" },
          { collection: "payments", action: "read" },
          { collection: "payments", action: "create" },
          { collection: "credit_notes", action: "read" },
          { collection: "credit_notes", action: "create" },
          { collection: "credit_notes", action: "update" },
          { collection: "expenses", action: "read" },
          { collection: "expenses", action: "update" },
        ],
      },
    ],
    dashboards: [
      {
        name: "Billing overview",
        description: "Invoiced vs collected, invoice flow and spend.",
        panels: [
          { name: "Invoices", kind: "items-aggregate", viz: "counter", config: { collection: "invoices", agg: "count" } },
          { name: "Invoiced total", kind: "items-aggregate", viz: "counter", config: { collection: "invoices", agg: "sum", field: "total" } },
          { name: "Collected", kind: "items-aggregate", viz: "counter", config: { collection: "invoices", agg: "sum", field: "amount_paid" } },
          { name: "Invoices by status", kind: "items-aggregate", viz: "donut", config: { collection: "invoices", agg: "count", groupBy: "status" } },
          { name: "Payments by method", kind: "items-aggregate", viz: "bars", config: { collection: "payments", agg: "count", groupBy: "method" } },
          { name: "Expenses by category", kind: "items-aggregate", viz: "bars", config: { collection: "expenses", agg: "count", groupBy: "category" } },
        ],
      },
    ],
  },

  {
    id: "appointments",
    label: "Appointments / Scheduling",
    groups: ["Scheduling", "Catalog", "People"],
    description:
      "Calendly-grade booking: bookable services with duration, buffer and price, staff with weekly availability, resources (rooms, stations), customers, and bookings with payment status and reminders.",
    collections: [
      {
        slug: "staff", group: "People", singular: "Staff member", plural: "Staff", defaultSort: "name",
        fields: [text("name", { required: true }), text("title"), email("email"), text("phone"), image("avatar"), notes("bio"), bool("active", { default: true, label: "Active" })],
        samples: [{ name: "Maya Chen", title: "Senior consultant", email: "maya@example.com", active: true }, { name: "Leo Fontaine", title: "Consultant", email: "leo@example.com", active: true }],
      },
      {
        slug: "resources", group: "Catalog", singular: "Resource", plural: "Resources", defaultSort: "name",
        fields: [
          text("name", { required: true }),
          select("type", [ch("room", C.blue), ch("station", C.amber), ch("equipment", C.teal), ch("other", C.gray)], { default: "room" }),
          int("capacity", { default: 1, validation: { min: 1 } }), bool("active", { default: true, label: "Active" }),
        ],
        samples: [{ name: "Meeting room A", type: "room", capacity: 6, active: true }, { name: "Studio 1", type: "station", capacity: 1, active: true }],
      },
      {
        slug: "services", group: "Catalog", singular: "Service", plural: "Services", fts: true, defaultSort: "name",
        fields: [
          text("name", { required: true, searchable: true, group: "Service" }), notes("description", { searchable: true, group: "Service" }),
          int("duration_minutes", { default: 30, validation: { min: 5 }, label: "Duration (min)", group: "Slot" }),
          int("buffer_minutes", { default: 0, validation: { min: 0 }, label: "Buffer after (min)", group: "Slot" }),
          select("location_type", [ch("in_person", C.blue, "In person"), ch("video", C.purple), ch("phone", C.teal)], { default: "in_person", label: "Location", group: "Slot" }),
          money("price", { group: "Pricing" }), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD", group: "Pricing" }),
          relMany("providers", "staff", { label: "Bookable staff", group: "Pricing" }),
          bool("active", { default: true, label: "Active", group: "Pricing" }),
        ],
        samples: [
          { name: "Intro consultation", description: "30-minute discovery call.", duration_minutes: 30, buffer_minutes: 10, location_type: "video", price: 0, currency: "USD", active: true },
          { name: "Strategy session", description: "Deep-dive working session.", duration_minutes: 90, buffer_minutes: 15, location_type: "in_person", price: 240, currency: "USD", active: true },
        ],
      },
      {
        slug: "availability_rules", group: "Scheduling", singular: "Availability rule", plural: "Availability",
        fields: [
          rel("staff", "staff"),
          select("weekday", [ch("monday", C.blue), ch("tuesday", C.blue), ch("wednesday", C.blue), ch("thursday", C.blue), ch("friday", C.blue), ch("saturday", C.amber), ch("sunday", C.amber)], { default: "monday" }),
          text("start_time", { default: "09:00", label: "From (HH:MM)" }), text("end_time", { default: "17:00", label: "To (HH:MM)" }),
          bool("active", { default: true, label: "Active" }),
        ],
        samples: [
          { staff: { ref: "staff:0" }, weekday: "monday", start_time: "09:00", end_time: "17:00", active: true },
          { staff: { ref: "staff:0" }, weekday: "wednesday", start_time: "10:00", end_time: "16:00", active: true },
        ],
      },
      {
        slug: "customers", group: "People", singular: "Customer", plural: "Customers", fts: true, defaultSort: "name",
        fields: [text("name", { required: true, searchable: true }), email("email"), text("phone"), notes("notes")],
        samples: [{ name: "Jordan Ellis", email: "jordan@example.com", phone: "+1 555 0142" }],
      },
      {
        slug: "bookings", group: "Scheduling", singular: "Booking", plural: "Bookings", defaultSort: "-starts_at",
        fields: [
          rel("service", "services", { group: "Booking" }), rel("staff", "staff", { group: "Booking" }),
          rel("resource", "resources", { group: "Booking" }), rel("customer", "customers", { group: "Booking" }),
          ts("starts_at", { required: true, indexed: true, label: "Starts at", group: "Booking" }),
          ts("ends_at", { label: "Ends at", group: "Booking" }),
          select("status", [ch("pending", C.amber), ch("confirmed", C.blue), ch("completed", C.green), ch("cancelled", C.red), ch("no_show", C.slate, "No-show")], { default: "pending", group: "Status" }),
          select("payment_status", [ch("unpaid", C.gray), ch("paid", C.green), ch("refunded", C.red)], { default: "unpaid", label: "Payment", group: "Status" }),
          money("amount", { group: "Status" }), notes("notes", { group: "Status" }),
        ],
        samples: [
          { service: { ref: "services:0" }, staff: { ref: "staff:0" }, customer: { ref: "customers:0" }, starts_at: ms("2026-07-14T15:00:00Z"), ends_at: ms("2026-07-14T15:30:00Z"), status: "confirmed", payment_status: "unpaid", amount: 0 },
          { service: { ref: "services:1" }, staff: { ref: "staff:1" }, resource: { ref: "resources:0" }, customer: { ref: "customers:0" }, starts_at: ms("2026-07-18T09:00:00Z"), ends_at: ms("2026-07-18T10:30:00Z"), status: "pending", payment_status: "paid", amount: 240 },
        ],
      },
      {
        slug: "reminders", group: "Scheduling", singular: "Reminder", plural: "Reminders",
        fields: [
          rel("booking", "bookings"),
          select("channel", [ch("email", C.blue), ch("sms", C.teal, "SMS")], { default: "email" }),
          int("minutes_before", { default: 60, validation: { min: 0 }, label: "Minutes before" }),
          select("status", [ch("scheduled", C.amber), ch("sent", C.green), ch("failed", C.red)], { default: "scheduled" }),
          ts("sent_at", { label: "Sent at" }),
        ],
        samples: [{ booking: { ref: "bookings:0" }, channel: "email", minutes_before: 60, status: "scheduled" }],
      },
    ],
    roles: [
      {
        name: "Front desk",
        description: "Take and manage bookings; read the service catalog and staff schedules.",
        permissions: [
          { collection: "staff", action: "read" },
          { collection: "resources", action: "read" },
          { collection: "services", action: "read" },
          { collection: "availability_rules", action: "read" },
          { collection: "customers", action: "read" },
          { collection: "customers", action: "create" },
          { collection: "customers", action: "update" },
          { collection: "bookings", action: "read" },
          { collection: "bookings", action: "create" },
          { collection: "bookings", action: "update" },
          { collection: "reminders", action: "read" },
          { collection: "reminders", action: "create" },
          { collection: "reminders", action: "update" },
        ],
      },
    ],
    dashboards: [
      {
        name: "Bookings overview",
        description: "Booking volume, status mix and revenue.",
        panels: [
          { name: "Bookings", kind: "items-aggregate", viz: "counter", config: { collection: "bookings", agg: "count" } },
          { name: "Revenue", kind: "items-aggregate", viz: "counter", config: { collection: "bookings", agg: "sum", field: "amount" } },
          { name: "Customers", kind: "items-aggregate", viz: "counter", config: { collection: "customers", agg: "count" } },
          { name: "Bookings by status", kind: "items-aggregate", viz: "donut", config: { collection: "bookings", agg: "count", groupBy: "status" } },
          { name: "Bookings by payment", kind: "items-aggregate", viz: "bars", config: { collection: "bookings", agg: "count", groupBy: "payment_status" } },
        ],
      },
    ],
  },

  {
    id: "field-service",
    label: "Field service",
    groups: ["Work orders", "People", "Catalog"],
    description:
      "Odoo/Jobber-grade field service: customers with service addresses, technicians, work orders with scheduling and priority, visit timesheets, parts used per job, and signed completion worksheets.",
    collections: [
      {
        slug: "technicians", group: "People", singular: "Technician", plural: "Technicians", defaultSort: "name",
        fields: [text("name", { required: true }), email("email"), text("phone"), text("skills_summary", { label: "Skills" }), select("home_region", ["north", "south", "east", "west", "central"], { default: "central", label: "Home region" }), bool("active", { default: true, label: "Active" })],
        samples: [
          { name: "Dana Whitfield", email: "dana@example.com", phone: "+1 555 0170", skills_summary: "HVAC, electrical", home_region: "north", active: true },
          { name: "Marco Ruiz", email: "marco@example.com", phone: "+1 555 0171", skills_summary: "Plumbing", home_region: "central", active: true },
        ],
      },
      {
        slug: "customers", group: "People", singular: "Customer", plural: "Customers", fts: true, defaultSort: "name",
        fields: [
          text("name", { required: true, searchable: true, group: "Customer" }), email("email", { group: "Customer" }), text("phone", { group: "Customer" }),
          text("address", { group: "Service address" }), text("city", { group: "Service address" }), text("postal_code", { label: "Postal code", group: "Service address" }),
          notes("access_notes", { label: "Access notes", group: "Service address" }),
        ],
        samples: [{ name: "Riverside Apartments", email: "manager@riverside.example", phone: "+1 555 0180", address: "88 River Rd", city: "Portland", access_notes: "Gate code 4415; parking in the rear lot." }],
      },
      {
        slug: "parts", group: "Catalog", singular: "Part", plural: "Parts", defaultSort: "name",
        fields: [text("name", { required: true }), text("sku", { unique: true, label: "SKU" }), money("unit_cost", { label: "Unit cost" }), money("unit_price", { label: "Bill price" }), int("stock", { default: 0, validation: { min: 0 } })],
        samples: [{ name: "Condenser fan motor", sku: "HVAC-FM-01", unit_cost: 84, unit_price: 149, stock: 12 }, { name: "3/4\" ball valve", sku: "PLB-BV-34", unit_cost: 9.5, unit_price: 24, stock: 40 }],
      },
      {
        slug: "work_orders", group: "Work orders", singular: "Work order", plural: "Work orders", fts: true, defaultSort: "-scheduled_at",
        fields: [
          text("number", { required: true, unique: true, group: "Job" }),
          text("title", { required: true, searchable: true, group: "Job" }),
          notes("description", { searchable: true, group: "Job" }),
          rel("customer", "customers", { group: "Job" }),
          rel("technician", "technicians", { group: "Assignment" }),
          select("priority", [ch("low", C.gray), ch("normal", C.blue), ch("high", C.amber), ch("urgent", C.red)], { default: "normal", group: "Assignment" }),
          select("status", [ch("new", C.gray), ch("scheduled", C.blue), ch("en_route", C.teal, "En route"), ch("in_progress", C.amber, "In progress"), ch("done", C.green), ch("cancelled", C.red)], { default: "new", group: "Assignment" }),
          ts("scheduled_at", { indexed: true, label: "Scheduled at", group: "Schedule" }),
          int("estimated_minutes", { default: 60, validation: { min: 0 }, label: "Estimate (min)", group: "Schedule" }),
          ts("completed_at", { label: "Completed at", group: "Schedule" }),
        ],
        samples: [
          { number: "WO-1001", title: "AC unit not cooling — building B", description: "Tenant reports warm air from unit 2B.", customer: { ref: "customers:0" }, technician: { ref: "technicians:0" }, priority: "high", status: "scheduled", scheduled_at: ms("2026-07-15T13:00:00Z"), estimated_minutes: 90 },
          { number: "WO-1002", title: "Quarterly boiler inspection", customer: { ref: "customers:0" }, technician: { ref: "technicians:1" }, priority: "normal", status: "done", scheduled_at: ms("2026-07-01T09:00:00Z"), estimated_minutes: 60, completed_at: ms("2026-07-01T10:05:00Z") },
        ],
      },
      {
        slug: "visits", group: "Work orders", singular: "Visit", plural: "Visits", defaultSort: "-started_at",
        fields: [rel("work_order", "work_orders"), rel("technician", "technicians"), ts("started_at", { indexed: true, label: "Started at" }), ts("ended_at", { label: "Ended at" }), int("minutes_on_site", { default: 0, validation: { min: 0 }, label: "Minutes on site" }), notes("summary")],
        samples: [{ work_order: { ref: "work_orders:1" }, technician: { ref: "technicians:1" }, started_at: ms("2026-07-01T09:00:00Z"), ended_at: ms("2026-07-01T10:05:00Z"), minutes_on_site: 65, summary: "Inspection passed; replaced pressure gauge." }],
      },
      {
        slug: "work_order_parts", group: "Work orders", singular: "Part used", plural: "Parts used",
        fields: [rel("work_order", "work_orders"), rel("part", "parts"), int("quantity", { default: 1, validation: { min: 0 } }), money("unit_price", { label: "Billed price" }), computedNum("line_total", "quantity * unit_price", { label: "Line total" })],
        samples: [{ work_order: { ref: "work_orders:1" }, part: { ref: "parts:1" }, quantity: 1, unit_price: 24 }],
      },
      {
        slug: "worksheets", group: "Work orders", singular: "Worksheet", plural: "Worksheets", defaultSort: "-signed_at",
        fields: [
          rel("work_order", "work_orders"), notes("work_performed", { label: "Work performed" }), notes("recommendations"),
          select("outcome", [ch("resolved", C.green), ch("follow_up", C.amber, "Needs follow-up"), ch("unresolved", C.red)], { default: "resolved" }),
          rating("customer_rating", { label: "Customer rating" }), text("signed_by", { label: "Signed by" }), ts("signed_at", { label: "Signed at" }), file("signature"),
        ],
        samples: [{ work_order: { ref: "work_orders:1" }, work_performed: "Full inspection; gauge swap.", outcome: "resolved", customer_rating: 5, signed_by: "R. Alvarez", signed_at: ms("2026-07-01T10:10:00Z") }],
      },
    ],
    roles: [
      {
        name: "Dispatcher",
        description: "Schedule and assign work orders; manage customers; read everything else.",
        permissions: [
          { collection: "technicians", action: "read" },
          { collection: "customers", action: "read" },
          { collection: "customers", action: "create" },
          { collection: "customers", action: "update" },
          { collection: "parts", action: "read" },
          { collection: "work_orders", action: "read" },
          { collection: "work_orders", action: "create" },
          { collection: "work_orders", action: "update" },
          { collection: "visits", action: "read" },
          { collection: "work_order_parts", action: "read" },
          { collection: "worksheets", action: "read" },
        ],
      },
    ],
    dashboards: [
      {
        name: "Field operations",
        description: "Job load, status mix and technician activity.",
        panels: [
          { name: "Work orders", kind: "items-aggregate", viz: "counter", config: { collection: "work_orders", agg: "count" } },
          { name: "Visits", kind: "items-aggregate", viz: "counter", config: { collection: "visits", agg: "count" } },
          { name: "Minutes on site", kind: "items-aggregate", viz: "counter", config: { collection: "visits", agg: "sum", field: "minutes_on_site" } },
          { name: "Orders by status", kind: "items-aggregate", viz: "donut", config: { collection: "work_orders", agg: "count", groupBy: "status" } },
          { name: "Orders by priority", kind: "items-aggregate", viz: "bars", config: { collection: "work_orders", agg: "count", groupBy: "priority" } },
        ],
      },
    ],
  },

  {
    id: "rental",
    label: "Rental",
    groups: ["Catalog", "Rentals", "People"],
    description:
      "Odoo-grade rental ops: rentable products with hourly/daily/weekly rates, serialized units, customers, rental orders with pickup & return schedules, per-line periods, and late-return fees.",
    collections: [
      {
        slug: "rental_products", group: "Catalog", singular: "Rental product", plural: "Rental products", fts: true, defaultSort: "name",
        fields: [
          text("name", { required: true, searchable: true, group: "Product" }), notes("description", { searchable: true, group: "Product" }),
          select("category", [ch("tools", C.blue), ch("vehicles", C.teal), ch("av_equipment", C.purple, "A/V equipment"), ch("event", C.amber, "Event & party"), ch("other", C.gray)], { default: "other", group: "Product" }),
          money("rate_hourly", { label: "Hourly rate", group: "Rates" }),
          money("rate_daily", { label: "Daily rate", group: "Rates" }),
          money("rate_weekly", { label: "Weekly rate", group: "Rates" }),
          money("deposit", { label: "Security deposit", group: "Rates" }),
          money("late_fee_per_day", { label: "Late fee / day", group: "Rates" }),
          int("padding_hours", { default: 0, validation: { min: 0 }, label: "Padding between rentals (h)", group: "Rates" }),
          bool("active", { default: true, label: "Active", group: "Rates" }),
        ],
        samples: [
          { name: "Excavator — 1.7t mini", category: "tools", rate_hourly: 45, rate_daily: 280, rate_weekly: 1250, deposit: 500, late_fee_per_day: 80, padding_hours: 2, active: true },
          { name: "PA system — 2×12\" + mixer", category: "av_equipment", rate_daily: 90, rate_weekly: 420, deposit: 150, late_fee_per_day: 30, active: true },
        ],
      },
      {
        slug: "units", group: "Catalog", singular: "Unit", plural: "Units", defaultSort: "serial",
        fields: [
          rel("product", "rental_products"), text("serial", { required: true, unique: true, label: "Serial no." }),
          select("condition", [ch("new", C.green), ch("good", C.blue), ch("worn", C.amber), ch("maintenance", C.red, "In maintenance"), ch("retired", C.slate)], { default: "good" }),
          date("acquired_at", { label: "Acquired" }), notes("notes"),
        ],
        samples: [
          { product: { ref: "rental_products:0" }, serial: "EXC-17-001", condition: "good", acquired_at: ms("2025-03-10") },
          { product: { ref: "rental_products:1" }, serial: "PA-212-004", condition: "new", acquired_at: ms("2026-01-22") },
        ],
      },
      {
        slug: "customers", group: "People", singular: "Customer", plural: "Customers", fts: true, defaultSort: "name",
        fields: [text("name", { required: true, searchable: true }), email("email"), text("phone"), text("id_document", { label: "ID document no." }), notes("notes")],
        samples: [{ name: "Hartley Construction", email: "ops@hartley.example", phone: "+1 555 0166", id_document: "BL-778812" }],
      },
      {
        slug: "rental_orders", group: "Rentals", singular: "Rental order", plural: "Rental orders", defaultSort: "-starts_at",
        fields: [
          text("number", { required: true, unique: true, group: "Order" }), rel("customer", "customers", { group: "Order" }),
          select("status", [ch("quote", C.gray), ch("reserved", C.blue), ch("picked_up", C.amber, "Picked up"), ch("returned", C.green), ch("late", C.red), ch("cancelled", C.slate)], { default: "quote", group: "Order" }),
          ts("starts_at", { indexed: true, label: "Pickup at", group: "Period" }),
          ts("due_back_at", { indexed: true, label: "Due back at", group: "Period" }),
          ts("returned_at", { label: "Returned at", group: "Period" }),
          money("subtotal", { group: "Totals" }), money("deposit_held", { label: "Deposit held", group: "Totals" }),
          money("late_fees", { label: "Late fees", group: "Totals" }), money("total", { group: "Totals" }),
        ],
        samples: [
          { number: "RO-3001", customer: { ref: "customers:0" }, status: "picked_up", starts_at: ms("2026-07-08T08:00:00Z"), due_back_at: ms("2026-07-15T08:00:00Z"), subtotal: 1250, deposit_held: 500, late_fees: 0, total: 1250 },
          { number: "RO-3002", customer: { ref: "customers:0" }, status: "returned", starts_at: ms("2026-06-20T09:00:00Z"), due_back_at: ms("2026-06-22T09:00:00Z"), returned_at: ms("2026-06-23T11:00:00Z"), subtotal: 180, deposit_held: 150, late_fees: 30, total: 210 },
        ],
      },
      {
        slug: "rental_lines", group: "Rentals", singular: "Rental line", plural: "Rental lines",
        fields: [
          rel("order", "rental_orders"), rel("product", "rental_products"), rel("unit", "units"),
          select("rate_type", [ch("hourly", C.blue), ch("daily", C.teal), ch("weekly", C.purple)], { default: "daily", label: "Rate" }),
          num("periods", { default: 1, validation: { min: 0 }, label: "Periods billed" }), money("rate", { label: "Rate amount" }),
          computedNum("line_total", "periods * rate", { label: "Line total" }),
        ],
        samples: [
          { order: { ref: "rental_orders:0" }, product: { ref: "rental_products:0" }, unit: { ref: "units:0" }, rate_type: "weekly", periods: 1, rate: 1250 },
          { order: { ref: "rental_orders:1" }, product: { ref: "rental_products:1" }, unit: { ref: "units:1" }, rate_type: "daily", periods: 2, rate: 90 },
        ],
      },
      {
        slug: "inspections", group: "Rentals", singular: "Inspection", plural: "Inspections", defaultSort: "-inspected_at",
        fields: [
          rel("order", "rental_orders"), rel("unit", "units"),
          select("stage", [ch("pre_rental", C.blue, "Pre-rental"), ch("post_return", C.teal, "Post-return")], { default: "pre_rental" }),
          select("result", [ch("ok", C.green, "OK"), ch("damage", C.red), ch("missing_parts", C.amber, "Missing parts")], { default: "ok" }),
          money("damage_charge", { label: "Damage charge" }), notes("notes"), file("photo"), ts("inspected_at", { indexed: true, label: "Inspected at" }),
        ],
        samples: [{ order: { ref: "rental_orders:1" }, unit: { ref: "units:1" }, stage: "post_return", result: "ok", damage_charge: 0, inspected_at: ms("2026-06-23T11:20:00Z") }],
      },
    ],
    roles: [
      {
        name: "Rental desk",
        description: "Create and manage rental orders, customers and inspections; read the catalog.",
        permissions: [
          { collection: "rental_products", action: "read" },
          { collection: "units", action: "read" },
          { collection: "units", action: "update" },
          { collection: "customers", action: "read" },
          { collection: "customers", action: "create" },
          { collection: "customers", action: "update" },
          { collection: "rental_orders", action: "read" },
          { collection: "rental_orders", action: "create" },
          { collection: "rental_orders", action: "update" },
          { collection: "rental_lines", action: "read" },
          { collection: "rental_lines", action: "create" },
          { collection: "rental_lines", action: "update" },
          { collection: "inspections", action: "read" },
          { collection: "inspections", action: "create" },
        ],
      },
    ],
    dashboards: [
      {
        name: "Rental overview",
        description: "Fleet utilization, order flow and revenue.",
        panels: [
          { name: "Rental orders", kind: "items-aggregate", viz: "counter", config: { collection: "rental_orders", agg: "count" } },
          { name: "Revenue", kind: "items-aggregate", viz: "counter", config: { collection: "rental_orders", agg: "sum", field: "total" } },
          { name: "Late fees", kind: "items-aggregate", viz: "counter", config: { collection: "rental_orders", agg: "sum", field: "late_fees" } },
          { name: "Orders by status", kind: "items-aggregate", viz: "donut", config: { collection: "rental_orders", agg: "count", groupBy: "status" } },
          { name: "Units by condition", kind: "items-aggregate", viz: "bars", config: { collection: "units", agg: "count", groupBy: "condition" } },
        ],
      },
    ],
  },

  {
    id: "fleet",
    label: "Fleet",
    groups: ["Fleet", "Usage", "Costs"],
    description:
      "Odoo Fleet-grade vehicle management: vehicles with model/plate/status, drivers and assignment history, lease & insurance contracts with renewal dates, odometer logs, and service records with costs.",
    collections: [
      {
        slug: "drivers", group: "Fleet", singular: "Driver", plural: "Drivers", defaultSort: "name",
        fields: [text("name", { required: true }), email("email"), text("phone"), text("license_no", { label: "License no." }), date("license_expires", { label: "License expires" }), bool("active", { default: true, label: "Active" })],
        samples: [{ name: "Priya Nair", email: "priya@example.com", license_no: "D-4471820", license_expires: ms("2028-03-01"), active: true }, { name: "Tom Becker", email: "tom@example.com", license_no: "D-9982710", license_expires: ms("2027-09-15"), active: true }],
      },
      {
        slug: "vehicles", group: "Fleet", singular: "Vehicle", plural: "Vehicles", fts: true, defaultSort: "name",
        fields: [
          text("name", { required: true, searchable: true, group: "Vehicle" }),
          text("make", { group: "Vehicle" }), text("model", { group: "Vehicle" }), int("year", { validation: { min: 1980, max: 2100 }, group: "Vehicle" }),
          text("plate", { unique: true, label: "License plate", group: "Vehicle" }), text("vin", { label: "VIN", group: "Vehicle" }),
          select("fuel_type", [ch("gasoline", C.amber), ch("diesel", C.slate), ch("hybrid", C.teal), ch("electric", C.green)], { default: "gasoline", label: "Fuel", group: "Specs" }),
          select("status", [ch("ordered", C.gray), ch("active", C.green), ch("in_service", C.amber, "In service"), ch("retired", C.slate), ch("sold", C.blue)], { default: "active", group: "Specs" }),
          rel("current_driver", "drivers", { label: "Current driver", group: "Specs" }),
          int("odometer", { default: 0, validation: { min: 0 }, label: "Odometer (km)", group: "Specs" }),
          money("acquisition_cost", { label: "Acquisition cost", group: "Specs" }),
          date("acquired_at", { label: "Acquired", group: "Specs" }),
        ],
        samples: [
          { name: "Van 12", make: "Ford", model: "Transit", year: 2024, plate: "7-KLM-482", fuel_type: "diesel", status: "active", current_driver: { ref: "drivers:0" }, odometer: 48210, acquisition_cost: 42000, acquired_at: ms("2024-05-01") },
          { name: "Car 3", make: "Tesla", model: "Model 3", year: 2025, plate: "9-EV-2210", fuel_type: "electric", status: "active", current_driver: { ref: "drivers:1" }, odometer: 15890, acquisition_cost: 39000, acquired_at: ms("2025-02-14") },
        ],
      },
      {
        slug: "assignments", group: "Usage", singular: "Assignment", plural: "Assignments", defaultSort: "-assigned_at",
        fields: [rel("vehicle", "vehicles"), rel("driver", "drivers"), ts("assigned_at", { indexed: true, label: "Assigned at" }), ts("returned_at", { label: "Returned at" }), notes("note")],
        samples: [{ vehicle: { ref: "vehicles:0" }, driver: { ref: "drivers:0" }, assigned_at: ms("2026-01-05T08:00:00Z") }],
      },
      {
        slug: "contracts", group: "Costs", singular: "Contract", plural: "Contracts", defaultSort: "-ends_at",
        fields: [
          rel("vehicle", "vehicles"),
          select("type", [ch("lease", C.blue), ch("insurance", C.teal), ch("warranty", C.purple), ch("service_plan", C.amber, "Service plan")], { default: "lease" }),
          text("provider"), text("reference"),
          date("starts_at", { label: "Starts" }), date("ends_at", { indexed: true, label: "Ends" }),
          money("monthly_cost", { label: "Monthly cost" }),
          select("status", [ch("active", C.green), ch("expiring", C.amber), ch("expired", C.red), ch("cancelled", C.slate)], { default: "active" }),
        ],
        samples: [{ vehicle: { ref: "vehicles:0" }, type: "insurance", provider: "Allianz", reference: "POL-88213", starts_at: ms("2026-01-01"), ends_at: ms("2026-12-31"), monthly_cost: 110, status: "active" }],
      },
      {
        slug: "odometer_logs", group: "Usage", singular: "Odometer log", plural: "Odometer logs", defaultSort: "-logged_at",
        fields: [rel("vehicle", "vehicles"), rel("driver", "drivers"), int("reading", { validation: { min: 0 }, label: "Reading (km)" }), date("logged_at", { indexed: true, label: "Logged at" })],
        samples: [{ vehicle: { ref: "vehicles:0" }, driver: { ref: "drivers:0" }, reading: 48210, logged_at: ms("2026-07-01") }],
      },
      {
        slug: "service_records", group: "Costs", singular: "Service record", plural: "Service records", defaultSort: "-serviced_at",
        fields: [
          rel("vehicle", "vehicles"),
          select("service_type", [ch("maintenance", C.blue), ch("repair", C.red), ch("tires", C.slate), ch("inspection", C.teal), ch("fuel", C.amber), ch("other", C.gray)], { default: "maintenance", label: "Type" }),
          text("vendor"), money("cost"), int("odometer_at", { validation: { min: 0 }, label: "Odometer (km)" }), date("serviced_at", { indexed: true, label: "Serviced at" }), notes("notes"),
        ],
        samples: [
          { vehicle: { ref: "vehicles:0" }, service_type: "maintenance", vendor: "Ford Service Center", cost: 320, odometer_at: 45000, serviced_at: ms("2026-05-20"), notes: "45k service — oil, filters, brake check." },
          { vehicle: { ref: "vehicles:1" }, service_type: "tires", vendor: "QuickTire", cost: 540, odometer_at: 15000, serviced_at: ms("2026-06-11") },
        ],
      },
    ],
    roles: [
      {
        name: "Fleet manager",
        description: "Manage vehicles, assignments, contracts and service records.",
        permissions: [
          { collection: "drivers", action: "read" },
          { collection: "drivers", action: "create" },
          { collection: "drivers", action: "update" },
          { collection: "vehicles", action: "read" },
          { collection: "vehicles", action: "create" },
          { collection: "vehicles", action: "update" },
          { collection: "assignments", action: "read" },
          { collection: "assignments", action: "create" },
          { collection: "assignments", action: "update" },
          { collection: "contracts", action: "read" },
          { collection: "contracts", action: "create" },
          { collection: "contracts", action: "update" },
          { collection: "odometer_logs", action: "read" },
          { collection: "odometer_logs", action: "create" },
          { collection: "service_records", action: "read" },
          { collection: "service_records", action: "create" },
          { collection: "service_records", action: "update" },
        ],
      },
    ],
    dashboards: [
      {
        name: "Fleet overview",
        description: "Fleet size, running costs and service activity.",
        panels: [
          { name: "Vehicles", kind: "items-aggregate", viz: "counter", config: { collection: "vehicles", agg: "count" } },
          { name: "Service spend", kind: "items-aggregate", viz: "counter", config: { collection: "service_records", agg: "sum", field: "cost" } },
          { name: "Monthly contracts", kind: "items-aggregate", viz: "counter", config: { collection: "contracts", agg: "sum", field: "monthly_cost" } },
          { name: "Vehicles by status", kind: "items-aggregate", viz: "donut", config: { collection: "vehicles", agg: "count", groupBy: "status" } },
          { name: "Service by type", kind: "items-aggregate", viz: "bars", config: { collection: "service_records", agg: "count", groupBy: "service_type" } },
        ],
      },
    ],
  },

  {
    id: "maintenance",
    label: "Maintenance / Assets",
    groups: ["Assets", "Requests"],
    description:
      "Odoo Maintenance-grade asset upkeep: equipment with location and warranty, maintenance teams, corrective & preventive requests with priority and downtime, and recurring preventive schedules.",
    collections: [
      {
        slug: "teams", group: "Requests", singular: "Team", plural: "Teams", defaultSort: "name",
        fields: [text("name", { required: true }), notes("description")],
        samples: [{ name: "Internal maintenance", description: "In-house crew for facilities and machines." }, { name: "Vendor — HVAC" }],
      },
      {
        slug: "equipment_categories", group: "Assets", singular: "Category", plural: "Categories", defaultSort: "name",
        fields: [text("name", { required: true }), parent("equipment_categories")],
        samples: [{ name: "Production machines" }, { name: "Facilities" }],
      },
      {
        slug: "equipment", group: "Assets", singular: "Equipment", plural: "Equipment", fts: true, defaultSort: "name",
        fields: [
          text("name", { required: true, searchable: true, group: "Asset" }), text("serial", { unique: true, label: "Serial no.", group: "Asset" }),
          rel("category", "equipment_categories", { group: "Asset" }), text("location", { group: "Asset" }),
          rel("team", "teams", { label: "Maintenance team", group: "Upkeep" }),
          select("criticality", [ch("low", C.gray), ch("medium", C.blue), ch("high", C.amber), ch("critical", C.red)], { default: "medium", group: "Upkeep" }),
          date("purchased_at", { label: "Purchased", group: "Upkeep" }), date("warranty_until", { label: "Warranty until", group: "Upkeep" }),
          money("purchase_cost", { label: "Purchase cost", group: "Upkeep" }),
          bool("active", { default: true, label: "In service", group: "Upkeep" }),
        ],
        samples: [
          { name: "CNC mill #2", serial: "CNC-2201", category: { ref: "equipment_categories:0" }, location: "Hall A", team: { ref: "teams:0" }, criticality: "critical", purchased_at: ms("2023-08-15"), warranty_until: ms("2026-08-15"), purchase_cost: 84000, active: true },
          { name: "Rooftop AC unit", serial: "HVAC-R1", category: { ref: "equipment_categories:1" }, location: "Roof", team: { ref: "teams:1" }, criticality: "high", purchased_at: ms("2022-04-01"), purchase_cost: 12500, active: true },
        ],
      },
      {
        slug: "maintenance_requests", group: "Requests", singular: "Request", plural: "Requests", fts: true, defaultSort: "-requested_at",
        fields: [
          text("title", { required: true, searchable: true, group: "Request" }), notes("description", { searchable: true, group: "Request" }),
          rel("equipment", "equipment", { group: "Request" }), rel("team", "teams", { group: "Request" }),
          select("kind", [ch("corrective", C.red), ch("preventive", C.blue)], { default: "corrective", label: "Type", group: "Triage" }),
          select("priority", [ch("low", C.gray), ch("normal", C.blue), ch("high", C.amber), ch("critical", C.red)], { default: "normal", group: "Triage" }),
          select("status", [ch("new", C.gray), ch("in_progress", C.amber, "In progress"), ch("blocked", C.red), ch("done", C.green), ch("cancelled", C.slate)], { default: "new", group: "Triage" }),
          ts("requested_at", { indexed: true, label: "Requested at", group: "Timing" }),
          ts("scheduled_for", { label: "Scheduled for", group: "Timing" }),
          ts("completed_at", { label: "Completed at", group: "Timing" }),
          int("downtime_minutes", { default: 0, validation: { min: 0 }, label: "Downtime (min)", group: "Timing" }),
          money("cost", { group: "Timing" }),
        ],
        samples: [
          { title: "Spindle vibration above threshold", description: "Vibration sensor tripped during morning shift.", equipment: { ref: "equipment:0" }, team: { ref: "teams:0" }, kind: "corrective", priority: "critical", status: "in_progress", requested_at: ms("2026-07-09T06:40:00Z"), downtime_minutes: 240 },
          { title: "Quarterly filter change", equipment: { ref: "equipment:1" }, team: { ref: "teams:1" }, kind: "preventive", priority: "normal", status: "done", requested_at: ms("2026-06-25T09:00:00Z"), completed_at: ms("2026-06-25T11:30:00Z"), cost: 180 },
        ],
      },
      {
        slug: "preventive_schedules", group: "Requests", singular: "Preventive schedule", plural: "Preventive schedules", defaultSort: "next_due",
        fields: [
          rel("equipment", "equipment"), rel("team", "teams"), text("task", { required: true, label: "Task" }),
          select("frequency", [ch("weekly", C.blue), ch("monthly", C.teal), ch("quarterly", C.amber), ch("yearly", C.purple)], { default: "monthly" }),
          date("last_done", { label: "Last done" }), date("next_due", { indexed: true, label: "Next due" }), bool("active", { default: true, label: "Active" }),
        ],
        samples: [{ equipment: { ref: "equipment:1" }, team: { ref: "teams:1" }, task: "Replace filters + coil clean", frequency: "quarterly", last_done: ms("2026-06-25"), next_due: ms("2026-09-25"), active: true }],
      },
    ],
    roles: [
      {
        name: "Maintenance tech",
        description: "Work requests and schedules; read the asset register.",
        permissions: [
          { collection: "teams", action: "read" },
          { collection: "equipment_categories", action: "read" },
          { collection: "equipment", action: "read" },
          { collection: "equipment", action: "update" },
          { collection: "maintenance_requests", action: "read" },
          { collection: "maintenance_requests", action: "create" },
          { collection: "maintenance_requests", action: "update" },
          { collection: "preventive_schedules", action: "read" },
          { collection: "preventive_schedules", action: "update" },
        ],
      },
    ],
    dashboards: [
      {
        name: "Maintenance overview",
        description: "Request load, downtime and asset criticality.",
        panels: [
          { name: "Open requests", kind: "items-aggregate", viz: "counter", config: { collection: "maintenance_requests", agg: "count" } },
          { name: "Downtime (min)", kind: "items-aggregate", viz: "counter", config: { collection: "maintenance_requests", agg: "sum", field: "downtime_minutes" } },
          { name: "Maintenance spend", kind: "items-aggregate", viz: "counter", config: { collection: "maintenance_requests", agg: "sum", field: "cost" } },
          { name: "Requests by status", kind: "items-aggregate", viz: "donut", config: { collection: "maintenance_requests", agg: "count", groupBy: "status" } },
          { name: "Requests by type", kind: "items-aggregate", viz: "bars", config: { collection: "maintenance_requests", agg: "count", groupBy: "kind" } },
        ],
      },
    ],
  },

  {
    id: "manufacturing",
    label: "Manufacturing",
    groups: ["Engineering", "Production", "Catalog"],
    description:
      "Odoo MRP-grade production: products (raw / component / finished), multi-line bills of materials with per-operation work centers, manufacturing orders that consume components, work orders per operation, and scrap records.",
    collections: [
      {
        slug: "work_centers", group: "Production", singular: "Work center", plural: "Work centers", defaultSort: "name",
        fields: [
          text("name", { required: true }), text("code", { unique: true }),
          int("capacity_per_hour", { default: 1, validation: { min: 0 }, label: "Capacity / hour" }),
          money("cost_per_hour", { label: "Cost / hour" }), bool("active", { default: true, label: "Active" }),
        ],
        samples: [{ name: "Assembly line 1", code: "ASM-1", capacity_per_hour: 20, cost_per_hour: 85, active: true }, { name: "Paint booth", code: "PNT-1", capacity_per_hour: 12, cost_per_hour: 60, active: true }],
      },
      {
        slug: "products", group: "Catalog", singular: "Product", plural: "Products", fts: true, defaultSort: "name",
        fields: [
          text("name", { required: true, searchable: true, group: "Product" }), text("sku", { unique: true, label: "SKU", group: "Product" }),
          select("kind", [ch("raw", C.slate, "Raw material"), ch("component", C.blue), ch("finished", C.green, "Finished good")], { default: "component", label: "Type", group: "Product" }),
          text("unit", { default: "ea", label: "Unit of measure", group: "Product" }),
          money("cost", { label: "Standard cost", group: "Stock" }),
          int("on_hand", { default: 0, validation: { min: 0 }, label: "On hand", group: "Stock" }),
          int("reorder_point", { default: 0, validation: { min: 0 }, label: "Reorder point", group: "Stock" }),
          bool("active", { default: true, label: "Active", group: "Stock" }),
        ],
        samples: [
          { name: "Steel frame", sku: "RM-FRAME", kind: "raw", unit: "ea", cost: 34, on_hand: 320, reorder_point: 100, active: true },
          { name: "Motor assembly", sku: "CMP-MOTOR", kind: "component", unit: "ea", cost: 78, on_hand: 140, reorder_point: 50, active: true },
          { name: "E-bike Model S", sku: "FG-EBIKE-S", kind: "finished", unit: "ea", cost: 420, on_hand: 25, reorder_point: 10, active: true },
        ],
      },
      {
        slug: "boms", group: "Engineering", singular: "Bill of materials", plural: "Bills of materials", defaultSort: "name",
        fields: [
          text("name", { required: true }), rel("product", "products", { label: "Produces" }),
          int("output_qty", { default: 1, validation: { min: 1 }, label: "Output qty" }),
          text("version", { default: "v1" }),
          select("status", [ch("draft", C.gray), ch("active", C.green), ch("obsolete", C.slate)], { default: "active" }),
        ],
        samples: [{ name: "E-bike Model S — standard build", product: { ref: "products:2" }, output_qty: 1, version: "v3", status: "active" }],
      },
      {
        slug: "bom_lines", group: "Engineering", singular: "BoM line", plural: "BoM lines",
        fields: [rel("bom", "boms"), rel("component", "products"), num("quantity", { default: 1, validation: { min: 0 } }), notes("note")],
        samples: [
          { bom: { ref: "boms:0" }, component: { ref: "products:0" }, quantity: 1 },
          { bom: { ref: "boms:0" }, component: { ref: "products:1" }, quantity: 1 },
        ],
      },
      {
        slug: "bom_operations", group: "Engineering", singular: "Operation", plural: "Operations", defaultSort: "position",
        fields: [rel("bom", "boms"), text("name", { required: true }), rel("work_center", "work_centers"), int("minutes", { default: 30, validation: { min: 0 }, label: "Duration (min)" }), position()],
        samples: [
          { bom: { ref: "boms:0" }, name: "Frame prep", work_center: { ref: "work_centers:1" }, minutes: 25, position: 1 },
          { bom: { ref: "boms:0" }, name: "Final assembly", work_center: { ref: "work_centers:0" }, minutes: 45, position: 2 },
        ],
      },
      {
        slug: "manufacturing_orders", group: "Production", singular: "Manufacturing order", plural: "Manufacturing orders", defaultSort: "-planned_start",
        fields: [
          text("number", { required: true, unique: true, group: "Order" }), rel("bom", "boms", { group: "Order" }), rel("product", "products", { group: "Order" }),
          int("quantity", { default: 1, validation: { min: 1 }, group: "Order" }),
          select("status", [ch("draft", C.gray), ch("confirmed", C.blue), ch("in_progress", C.amber, "In progress"), ch("done", C.green), ch("cancelled", C.red)], { default: "draft", group: "Order" }),
          select("priority", [ch("normal", C.blue), ch("rush", C.red)], { default: "normal", group: "Order" }),
          ts("planned_start", { indexed: true, label: "Planned start", group: "Schedule" }),
          ts("planned_end", { label: "Planned end", group: "Schedule" }),
          ts("completed_at", { label: "Completed at", group: "Schedule" }),
          int("qty_produced", { default: 0, validation: { min: 0 }, label: "Qty produced", group: "Schedule" }),
        ],
        samples: [
          { number: "MO-501", bom: { ref: "boms:0" }, product: { ref: "products:2" }, quantity: 10, status: "in_progress", priority: "normal", planned_start: ms("2026-07-10T07:00:00Z"), planned_end: ms("2026-07-12T16:00:00Z"), qty_produced: 4 },
          { number: "MO-502", bom: { ref: "boms:0" }, product: { ref: "products:2" }, quantity: 5, status: "confirmed", priority: "rush", planned_start: ms("2026-07-16T07:00:00Z") },
        ],
      },
      {
        slug: "work_orders", group: "Production", singular: "Work order", plural: "Work orders", defaultSort: "-started_at",
        fields: [
          rel("manufacturing_order", "manufacturing_orders", { label: "MO" }), text("operation", { required: true }), rel("work_center", "work_centers"),
          select("status", [ch("pending", C.gray), ch("running", C.amber), ch("done", C.green), ch("blocked", C.red)], { default: "pending" }),
          ts("started_at", { indexed: true, label: "Started at" }), ts("finished_at", { label: "Finished at" }),
          int("minutes_actual", { default: 0, validation: { min: 0 }, label: "Actual minutes" }),
        ],
        samples: [{ manufacturing_order: { ref: "manufacturing_orders:0" }, operation: "Frame prep", work_center: { ref: "work_centers:1" }, status: "done", started_at: ms("2026-07-10T07:15:00Z"), finished_at: ms("2026-07-10T11:40:00Z"), minutes_actual: 265 }],
      },
      {
        slug: "scrap_records", group: "Production", singular: "Scrap record", plural: "Scrap records", defaultSort: "-scrapped_at",
        fields: [
          rel("manufacturing_order", "manufacturing_orders", { label: "MO" }), rel("product", "products"), int("quantity", { default: 1, validation: { min: 0 } }),
          select("reason", [ch("defect", C.red), ch("damage", C.amber), ch("expired", C.slate), ch("other", C.gray)], { default: "defect" }),
          notes("note"), ts("scrapped_at", { indexed: true, label: "Scrapped at" }),
        ],
        samples: [{ manufacturing_order: { ref: "manufacturing_orders:0" }, product: { ref: "products:1" }, quantity: 1, reason: "defect", note: "Bent shaft on arrival.", scrapped_at: ms("2026-07-10T09:00:00Z") }],
      },
    ],
    roles: [
      {
        name: "Production supervisor",
        description: "Run manufacturing and work orders; read engineering data.",
        permissions: [
          { collection: "work_centers", action: "read" },
          { collection: "products", action: "read" },
          { collection: "boms", action: "read" },
          { collection: "bom_lines", action: "read" },
          { collection: "bom_operations", action: "read" },
          { collection: "manufacturing_orders", action: "read" },
          { collection: "manufacturing_orders", action: "create" },
          { collection: "manufacturing_orders", action: "update" },
          { collection: "work_orders", action: "read" },
          { collection: "work_orders", action: "create" },
          { collection: "work_orders", action: "update" },
          { collection: "scrap_records", action: "read" },
          { collection: "scrap_records", action: "create" },
        ],
      },
    ],
    dashboards: [
      {
        name: "Production overview",
        description: "Order flow, output and scrap.",
        panels: [
          { name: "Manufacturing orders", kind: "items-aggregate", viz: "counter", config: { collection: "manufacturing_orders", agg: "count" } },
          { name: "Units produced", kind: "items-aggregate", viz: "counter", config: { collection: "manufacturing_orders", agg: "sum", field: "qty_produced" } },
          { name: "Scrapped units", kind: "items-aggregate", viz: "counter", config: { collection: "scrap_records", agg: "sum", field: "quantity" } },
          { name: "MOs by status", kind: "items-aggregate", viz: "donut", config: { collection: "manufacturing_orders", agg: "count", groupBy: "status" } },
          { name: "Scrap by reason", kind: "items-aggregate", viz: "bars", config: { collection: "scrap_records", agg: "count", groupBy: "reason" } },
        ],
      },
    ],
  },
];

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

export const getTemplate = (id: string): SchemaTemplate | undefined =>
  TEMPLATES.find((t) => t.id === id);

/** Picker grouping. Keep ids stable; new templates just need a row here (they
 *  fall back to "Other" if missing). */
const CATEGORY: Record<string, string> = {
  blank: "General",
  blog: "Content & Marketing",
  forms: "Content & Marketing",
  ecommerce: "Commerce",
  marketplace: "Commerce",
  restaurant: "Commerce",
  crm: "Sales & CRM",
  saas: "Sales & CRM",
  hr: "People & HR",
  ats: "People & HR",
  inventory: "Operations",
  support: "Operations",
  projects: "Operations",
  invoicing: "Finance",
  appointments: "Operations",
  "field-service": "Operations",
  rental: "Commerce",
  fleet: "Operations",
  maintenance: "Operations",
  manufacturing: "Operations",
  "real-estate": "Industry",
  lms: "Industry",
  nonprofit: "Industry",
  events: "Industry",
};

/** Popular starters surfaced with a "Recommended" badge in the picker. */
const RECOMMENDED = new Set(["blog", "ecommerce", "crm"]);

/** Lightweight catalog for pickers/previews (no full field defs). */
export const templateSummaries = () =>
  TEMPLATES.map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    category: CATEGORY[t.id] ?? "Other",
    recommended: RECOMMENDED.has(t.id),
    sampleRows: t.collections.reduce((n, c) => n + (c.samples?.length ?? 0), 0),
    /** Admin group headers seeded by this template, in order. */
    groups: t.groups ?? [],
    /** Bundled role names seeded on apply. */
    roles: (t.roles ?? []).map((r) => r.name),
    /** Bundled dashboard names seeded on apply. */
    dashboards: (t.dashboards ?? []).map((d) => d.name),
    collections: t.collections.map((c) => ({
      slug: c.slug,
      label: c.plural ?? c.slug,
      fieldCount: c.fields.length,
      /** Admin group this collection lands under (null = ungrouped). */
      group: c.group ?? null,
    })),
  }));
