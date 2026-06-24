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
  ownerScoped?: boolean;
  versioned?: boolean;
  vectorize?: boolean;
  /** Enable keyword full-text search — pairs with `searchable` fields. */
  fts?: boolean;
  defaultSort?: string;
  fields: FieldDef[];
  /** Realistic example rows seeded on apply (only when the collection is newly
   *  created). Relation values use `{ ref: "slug:index" }`. */
  samples?: SampleRow[];
}

export interface SchemaTemplate {
  id: string;
  label: string;
  description: string;
  collections: TemplateCollection[];
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
    description: "Posts, pages, categories, tags, authors and media.",
    collections: [
      { slug: "media", singular: "Media", plural: "Media", fields: [file("file"), text("alt", { label: "Alt text" })] },
      {
        slug: "authors", singular: "Author", plural: "Authors", defaultSort: "name",
        fields: [text("name", { required: true }), notes("bio"), file("avatar"), email("email"), url("website")],
        samples: [
          { name: "Ada Lovelace", bio: "Writes about engineering and the craft of building software.", email: "ada@example.com" },
          { name: "Grace Hopper", bio: "Product notes, release walkthroughs and the occasional rant.", email: "grace@example.com" },
        ],
      },
      {
        slug: "categories", singular: "Category", plural: "Categories", defaultSort: "name",
        fields: [text("name", { required: true }), slugField(), text("color", { interface: "color" })],
        samples: [
          { name: "Engineering", slug: "engineering", color: C.blue },
          { name: "Product", slug: "product", color: C.purple },
        ],
      },
      {
        slug: "tags", singular: "Tag", plural: "Tags", defaultSort: "name",
        fields: [text("name", { required: true }), slugField()],
        samples: [{ name: "Release", slug: "release" }, { name: "Tutorial", slug: "tutorial" }],
      },
      {
        slug: "posts", singular: "Post", plural: "Posts", ownerScoped: true, versioned: true, vectorize: true, fts: true,
        defaultSort: "-_published_at",
        fields: [
          text("title", { required: true, vectorize: true, searchable: true, group: "Content" }),
          slugField("slug", { group: "Content" }),
          { name: "excerpt", type: "longtext", interface: "textarea", vectorize: true, searchable: true, group: "Content" },
          { name: "body", type: "longtext", interface: "richtext", vectorize: true, searchable: true, group: "Content" },
          file("cover", { group: "Content" }),
          rel("author", "authors", { group: "Meta" }),
          rel("category", "categories", { group: "Meta" }),
          relMany("tags", "tags", { group: "Meta" }),
          {
            name: "featured", type: "boolean", interface: "toggle", default: false, group: "Meta",
            label: "Featured post", description: "Pin this post to the top of the blog home page.",
          },
          { name: "reading_minutes", type: "integer", default: 0, label: "Reading time (min)", group: "Meta" },
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
        slug: "pages", singular: "Page", plural: "Pages", versioned: true, fts: true, defaultSort: "title",
        fields: [text("title", { required: true, searchable: true }), slugField(), { name: "body", type: "longtext", interface: "richtext", searchable: true }],
        samples: [{ title: "About", slug: "about", body: "About this site." }, { title: "Contact", slug: "contact", body: "Get in touch." }],
      },
    ],
  },

  {
    id: "ecommerce",
    label: "E-commerce",
    description: "Products, variants, orders, customers, discounts and reviews.",
    collections: [
      { slug: "media", singular: "Media", plural: "Media", fields: [file("file"), text("alt", { label: "Alt text" })] },
      {
        slug: "categories", singular: "Category", plural: "Categories", defaultSort: "name",
        fields: [text("name", { required: true }), slugField()],
        samples: [{ name: "Apparel", slug: "apparel" }, { name: "Accessories", slug: "accessories" }],
      },
      {
        slug: "customers", singular: "Customer", plural: "Customers", defaultSort: "-created_at",
        fields: [email("email", { required: true, unique: true }), text("name"), text("phone")],
        samples: [
          { email: "jordan@example.com", name: "Jordan Reed", phone: "+1 555 0100" },
          { email: "sam@example.com", name: "Sam Taylor", phone: "+1 555 0142" },
        ],
      },
      {
        slug: "products", singular: "Product", plural: "Products", versioned: true, vectorize: true, fts: true, defaultSort: "name",
        fields: [
          text("name", { required: true, vectorize: true, searchable: true, group: "Basics" }),
          slugField("slug", { group: "Basics" }),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true, group: "Basics" },
          rel("category", "categories", { group: "Basics" }),
          money("price", { required: true, group: "Pricing" }),
          select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD", group: "Pricing" }),
          text("sku", { unique: true, group: "Pricing" }),
          int("stock", { default: 0, validation: { min: 0 }, group: "Inventory" }),
          bool("active", { default: true, label: "Active", group: "Inventory" }),
          relMany("images", "media", { group: "Media" }),
        ],
        samples: [
          { name: "Classic Tee", slug: "classic-tee", description: "A soft cotton t-shirt.", category: { ref: "categories:0" }, price: 25, currency: "USD", sku: "TEE-001", stock: 120 },
          { name: "Canvas Tote", slug: "canvas-tote", description: "Sturdy everyday tote bag.", category: { ref: "categories:1" }, price: 18, currency: "USD", sku: "TOTE-001", stock: 60 },
        ],
      },
      {
        slug: "product_variants", singular: "Variant", plural: "Variants",
        fields: [rel("product", "products"), text("name"), text("sku"), money("price"), int("stock", { default: 0, validation: { min: 0 } })],
        samples: [
          { product: { ref: "products:0" }, name: "Small", sku: "TEE-001-S", price: 25, stock: 40 },
          { product: { ref: "products:0" }, name: "Medium", sku: "TEE-001-M", price: 25, stock: 50 },
        ],
      },
      {
        slug: "discounts", singular: "Discount", plural: "Discounts", defaultSort: "-expires_at",
        fields: [text("code", { unique: true }), select("type", ["percent", "fixed"], { default: "percent" }), num("value", { validation: { min: 0 } }), date("expires_at", { indexed: true })],
        samples: [{ code: "WELCOME10", type: "percent", value: 10, expires_at: ms("2026-12-31") }],
      },
      {
        slug: "addresses", singular: "Address", plural: "Addresses",
        fields: [rel("customer", "customers"), text("line1", { label: "Address line 1" }), text("line2", { label: "Address line 2" }), text("city"), text("country"), text("postal_code", { label: "Postal code" })],
        samples: [{ customer: { ref: "customers:0" }, line1: "1 Market St", city: "San Francisco", country: "US", postal_code: "94105" }],
      },
      {
        slug: "orders", singular: "Order", plural: "Orders", defaultSort: "-placed_at",
        fields: [
          text("number", { unique: true, group: "Order" }),
          rel("customer", "customers", { group: "Order" }),
          select("status", [ch("pending", C.amber), ch("paid", C.green), ch("shipped", C.blue), ch("delivered", C.teal), ch("cancelled", C.red)], { default: "pending", group: "Order" }),
          money("total", { group: "Payment" }),
          select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD", group: "Payment" }),
          ts("placed_at", { indexed: true, group: "Order" }),
        ],
        samples: [
          { number: "ORD-1001", customer: { ref: "customers:0" }, status: "paid", total: 43, currency: "USD", placed_at: ms("2026-01-12") },
          { number: "ORD-1002", customer: { ref: "customers:1" }, status: "pending", total: 18, currency: "USD", placed_at: ms("2026-01-14") },
        ],
      },
      {
        slug: "order_items", singular: "Order item", plural: "Order items",
        fields: [
          rel("order", "orders"), rel("product", "products"),
          int("qty", { default: 1, validation: { min: 1 } }), money("unit_price"),
          computedNum("line_total", "qty * unit_price", { label: "Line total" }),
        ],
        samples: [
          { order: { ref: "orders:0" }, product: { ref: "products:0" }, qty: 1, unit_price: 25 },
          { order: { ref: "orders:0" }, product: { ref: "products:1" }, qty: 1, unit_price: 18 },
        ],
      },
      {
        slug: "reviews", singular: "Review", plural: "Reviews", ownerScoped: true, defaultSort: "-created_at",
        fields: [rel("product", "products"), rel("customer", "customers"), rating("rating"), notes("body")],
        samples: [{ product: { ref: "products:0" }, customer: { ref: "customers:0" }, rating: 5, body: "Great quality, fits perfectly." }],
      },
    ],
  },

  {
    id: "saas",
    label: "SaaS",
    description: "Accounts, members, plans, subscriptions, invoices and usage.",
    collections: [
      {
        slug: "accounts", singular: "Account", plural: "Accounts", defaultSort: "name",
        fields: [text("name", { required: true }), slugField(), select("status", [ch("active", C.green), ch("suspended", C.red)], { default: "active" })],
        samples: [{ name: "Acme Inc", slug: "acme-inc", status: "active" }, { name: "Globex", slug: "globex", status: "active" }],
      },
      {
        slug: "account_members", singular: "Member", plural: "Members",
        fields: [rel("account", "accounts"), email("email", { required: true }), select("role", [ch("owner", C.purple), ch("admin", C.blue), ch("member", C.gray)], { default: "member" })],
        samples: [{ account: { ref: "accounts:0" }, email: "owner@acme.example", role: "owner" }],
      },
      {
        slug: "plans", singular: "Plan", plural: "Plans", defaultSort: "price",
        fields: [text("name", { required: true }), money("price"), select("currency", ["USD", "EUR", "GBP"], { default: "USD" }), select("interval", [ch("month", C.blue), ch("year", C.teal)], { default: "month" })],
        samples: [{ name: "Starter", price: 0, currency: "USD", interval: "month" }, { name: "Pro", price: 49, currency: "USD", interval: "month" }],
      },
      {
        slug: "subscriptions", singular: "Subscription", plural: "Subscriptions", defaultSort: "-current_period_end",
        fields: [rel("account", "accounts"), rel("plan", "plans"), select("status", [ch("trialing", C.amber), ch("active", C.green), ch("past_due", C.red), ch("canceled", C.gray)], { default: "trialing" }), ts("current_period_end", { indexed: true })],
        samples: [{ account: { ref: "accounts:0" }, plan: { ref: "plans:1" }, status: "active", current_period_end: ms("2026-07-01") }],
      },
      {
        slug: "invoices", singular: "Invoice", plural: "Invoices", defaultSort: "-issued_at",
        fields: [rel("account", "accounts"), text("number", { unique: true }), money("amount"), select("currency", ["USD", "EUR", "GBP"], { default: "USD" }), select("status", [ch("draft", C.gray), ch("open", C.blue), ch("paid", C.green), ch("void", C.red)], { default: "draft" }), ts("issued_at", { indexed: true })],
        samples: [{ account: { ref: "accounts:0" }, number: "INV-1001", amount: 49, currency: "USD", status: "paid", issued_at: ms("2026-06-01") }],
      },
      {
        slug: "usage_records", singular: "Usage", plural: "Usage", defaultSort: "-recorded_at",
        fields: [rel("account", "accounts"), text("metric"), num("quantity", { validation: { min: 0 } }), ts("recorded_at", { indexed: true })],
        samples: [{ account: { ref: "accounts:0" }, metric: "api_calls", quantity: 1240, recorded_at: ms("2026-06-20") }],
      },
      {
        slug: "feature_flags", singular: "Feature flag", plural: "Feature flags", defaultSort: "key",
        fields: [text("key", { unique: true }), bool("enabled", { default: false }), notes("description")],
        samples: [{ key: "new_dashboard", enabled: true, description: "Roll out the redesigned dashboard." }],
      },
      {
        slug: "webhooks", singular: "Webhook", plural: "Webhooks",
        fields: [rel("account", "accounts"), url("url", { required: true }), bool("active", { default: true })],
        samples: [{ account: { ref: "accounts:0" }, url: "https://acme.example/hooks/backlex", active: true }],
      },
    ],
  },

  {
    id: "crm",
    label: "CRM",
    description: "Contacts, companies, leads, deals, pipelines and activities.",
    collections: [
      {
        slug: "companies", singular: "Company", plural: "Companies", defaultSort: "name",
        fields: [text("name", { required: true }), url("domain"), text("industry"), int("employees", { validation: { min: 0 } })],
        samples: [{ name: "Acme Inc", domain: "https://acme.example", industry: "Manufacturing", employees: 250 }, { name: "Globex", domain: "https://globex.example", industry: "Energy", employees: 1200 }],
      },
      {
        slug: "contacts", singular: "Contact", plural: "Contacts", defaultSort: "last_name",
        fields: [
          text("first_name", { label: "First name", group: "Identity" }),
          text("last_name", { label: "Last name", group: "Identity" }),
          computedText("full_name", "first_name || ' ' || last_name", { label: "Full name", group: "Identity" }),
          email("email", { unique: true, group: "Contact" }),
          text("phone", { group: "Contact" }),
          rel("company", "companies", { group: "Contact" }),
        ],
        samples: [
          { first_name: "Jordan", last_name: "Reed", email: "jordan@acme.example", company: { ref: "companies:0" } },
          { first_name: "Sam", last_name: "Taylor", email: "sam@globex.example", company: { ref: "companies:1" } },
        ],
      },
      {
        slug: "pipelines", singular: "Pipeline", plural: "Pipelines",
        fields: [text("name", { required: true })],
        samples: [{ name: "Sales" }],
      },
      {
        slug: "pipeline_stages", singular: "Stage", plural: "Stages", defaultSort: "position",
        fields: [rel("pipeline", "pipelines"), text("name", { required: true }), int("position", { default: 0, indexed: true })],
        samples: [
          { pipeline: { ref: "pipelines:0" }, name: "Qualified", position: 1 },
          { pipeline: { ref: "pipelines:0" }, name: "Proposal", position: 2 },
          { pipeline: { ref: "pipelines:0" }, name: "Won", position: 3 },
        ],
      },
      {
        slug: "leads", singular: "Lead", plural: "Leads", ownerScoped: true, defaultSort: "-created_at",
        fields: [text("name"), email("email"), select("status", [ch("new", C.blue), ch("qualified", C.green), ch("lost", C.red)], { default: "new" }), text("source")],
        samples: [{ name: "Inbound demo request", email: "lead@example.com", status: "new", source: "website" }],
      },
      {
        slug: "deals", singular: "Deal", plural: "Deals", ownerScoped: true, defaultSort: "-created_at",
        fields: [text("title", { required: true }), money("amount"), select("currency", ["USD", "EUR", "GBP"], { default: "USD" }), rel("company", "companies"), rel("stage", "pipeline_stages"), date("close_date", { indexed: true })],
        samples: [{ title: "Acme — annual contract", amount: 24000, currency: "USD", company: { ref: "companies:0" }, stage: { ref: "pipeline_stages:1" }, close_date: ms("2026-08-01") }],
      },
      {
        slug: "activities", singular: "Activity", plural: "Activities", ownerScoped: true, defaultSort: "-due_at",
        fields: [select("type", [ch("call", C.blue), ch("email", C.teal), ch("meeting", C.purple), ch("note", C.gray)], { default: "note" }), notes("body"), rel("contact", "contacts"), rel("deal", "deals"), ts("due_at", { indexed: true })],
        samples: [{ type: "call", body: "Intro call with Jordan.", contact: { ref: "contacts:0" }, deal: { ref: "deals:0" }, due_at: ms("2026-07-05") }],
      },
      {
        slug: "tasks", singular: "Task", plural: "Tasks", ownerScoped: true, defaultSort: "due_at",
        fields: [text("title", { required: true }), bool("done", { default: false }), ts("due_at", { indexed: true })],
        samples: [{ title: "Send proposal to Acme", done: false, due_at: ms("2026-07-02") }],
      },
    ],
  },

  {
    id: "support",
    label: "Support / Helpdesk",
    description: "Tickets, messages, agents, SLAs and a knowledge base.",
    collections: [
      {
        slug: "customers", singular: "Customer", plural: "Customers", defaultSort: "name",
        fields: [email("email", { required: true, unique: true }), text("name")],
        samples: [{ email: "jordan@example.com", name: "Jordan Reed" }, { email: "sam@example.com", name: "Sam Taylor" }],
      },
      {
        slug: "agents", singular: "Agent", plural: "Agents", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true })],
        samples: [{ name: "Robin Park", email: "robin@support.example" }],
      },
      {
        slug: "categories", singular: "Category", plural: "Categories", defaultSort: "name",
        fields: [text("name", { required: true })],
        samples: [{ name: "Billing" }, { name: "Technical" }],
      },
      {
        slug: "slas", singular: "SLA", plural: "SLAs",
        fields: [text("name"), int("first_response_mins", { label: "First response (min)", validation: { min: 0 } }), int("resolution_mins", { label: "Resolution (min)", validation: { min: 0 } })],
        samples: [{ name: "Standard", first_response_mins: 60, resolution_mins: 1440 }],
      },
      {
        slug: "tickets", singular: "Ticket", plural: "Tickets", fts: true, defaultSort: "-created_at",
        fields: [
          text("subject", { required: true, searchable: true, group: "Ticket" }),
          select("status", [ch("open", C.blue), ch("pending", C.amber), ch("solved", C.green), ch("closed", C.gray)], { default: "open", group: "Ticket" }),
          select("priority", [ch("low", C.gray), ch("normal", C.blue), ch("high", C.amber), ch("urgent", C.red)], { default: "normal", group: "Ticket" }),
          rel("customer", "customers", { group: "Assignment" }),
          rel("agent", "agents", { group: "Assignment" }),
          rel("category", "categories", { group: "Assignment" }),
        ],
        samples: [
          { subject: "Cannot reset my password", status: "open", priority: "high", customer: { ref: "customers:0" }, agent: { ref: "agents:0" }, category: { ref: "categories:1" } },
          { subject: "Invoice question", status: "pending", priority: "normal", customer: { ref: "customers:1" }, category: { ref: "categories:0" } },
        ],
      },
      {
        slug: "ticket_messages", singular: "Message", plural: "Messages", defaultSort: "created_at",
        fields: [rel("ticket", "tickets"), notes("body"), bool("internal", { default: false, label: "Internal note" })],
        samples: [{ ticket: { ref: "tickets:0" }, body: "Thanks for reaching out — taking a look now.", internal: false }],
      },
      {
        slug: "kb_articles", singular: "Article", plural: "Articles", versioned: true, vectorize: true, fts: true, defaultSort: "title",
        fields: [text("title", { required: true, vectorize: true, searchable: true }), slugField(), { name: "body", type: "longtext", interface: "richtext", vectorize: true, searchable: true }, rel("category", "categories")],
        samples: [{ title: "How to reset your password", slug: "reset-password", body: "Go to Settings → Security and click Reset.", category: { ref: "categories:1" } }],
      },
      {
        slug: "canned_responses", singular: "Canned response", plural: "Canned responses", defaultSort: "title",
        fields: [text("title"), notes("body")],
        samples: [{ title: "Greeting", body: "Hi there! Thanks for contacting support." }],
      },
    ],
  },

  {
    id: "hr",
    label: "HR / People",
    description: "Employees, departments, leave, documents and reviews.",
    collections: [
      {
        slug: "departments", singular: "Department", plural: "Departments", defaultSort: "name",
        fields: [text("name", { required: true })],
        samples: [{ name: "Engineering" }, { name: "Sales" }],
      },
      {
        slug: "positions", singular: "Position", plural: "Positions", defaultSort: "title",
        fields: [text("title", { required: true }), rel("department", "departments")],
        samples: [{ title: "Software Engineer", department: { ref: "departments:0" } }, { title: "Account Executive", department: { ref: "departments:1" } }],
      },
      {
        slug: "employees", singular: "Employee", plural: "Employees", defaultSort: "last_name",
        fields: [
          text("first_name", { label: "First name", group: "Identity" }),
          text("last_name", { label: "Last name", group: "Identity" }),
          computedText("full_name", "first_name || ' ' || last_name", { label: "Full name", group: "Identity" }),
          email("email", { unique: true, group: "Identity" }),
          rel("department", "departments", { group: "Role" }),
          rel("position", "positions", { group: "Role" }),
          date("hired_at", { indexed: true, group: "Role" }),
          select("status", [ch("active", C.green), ch("on_leave", C.amber), ch("terminated", C.red)], { default: "active", group: "Role" }),
        ],
        samples: [
          { first_name: "Ada", last_name: "Lovelace", email: "ada@company.example", department: { ref: "departments:0" }, position: { ref: "positions:0" }, hired_at: ms("2024-03-01"), status: "active" },
          { first_name: "Sam", last_name: "Taylor", email: "sam@company.example", department: { ref: "departments:1" }, position: { ref: "positions:1" }, hired_at: ms("2025-09-15"), status: "active" },
        ],
      },
      {
        slug: "leave_requests", singular: "Leave request", plural: "Leave requests", defaultSort: "-start_date",
        fields: [rel("employee", "employees"), select("type", [ch("annual", C.blue), ch("sick", C.amber), ch("unpaid", C.gray)], { default: "annual" }), date("start_date", { indexed: true }), date("end_date"), select("status", [ch("pending", C.amber), ch("approved", C.green), ch("rejected", C.red)], { default: "pending" })],
        samples: [{ employee: { ref: "employees:0" }, type: "annual", start_date: ms("2026-08-10"), end_date: ms("2026-08-17"), status: "pending" }],
      },
      {
        slug: "documents", singular: "Document", plural: "Documents",
        fields: [rel("employee", "employees"), text("title"), file("file")],
        samples: [{ employee: { ref: "employees:0" }, title: "Offer letter" }],
      },
      {
        slug: "performance_reviews", singular: "Review", plural: "Reviews", defaultSort: "-created_at",
        fields: [rel("employee", "employees"), text("period"), rating("score"), notes("notes")],
        samples: [{ employee: { ref: "employees:0" }, period: "2025 H2", score: 5, notes: "Outstanding contributions this half." }],
      },
    ],
  },

  {
    id: "projects",
    label: "Project management",
    description: "Projects, tasks, milestones, sprints and time tracking.",
    collections: [
      {
        slug: "members", singular: "Member", plural: "Members", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true })],
        samples: [{ name: "Ada Lovelace", email: "ada@team.example" }, { name: "Grace Hopper", email: "grace@team.example" }],
      },
      {
        slug: "projects", singular: "Project", plural: "Projects", defaultSort: "name",
        fields: [text("name", { required: true }), text("key", { unique: true, label: "Key" }), select("status", [ch("active", C.green), ch("archived", C.gray)], { default: "active" }), notes("description")],
        samples: [{ name: "Website Redesign", key: "WEB", status: "active", description: "Refresh the marketing site." }],
      },
      {
        slug: "milestones", singular: "Milestone", plural: "Milestones", defaultSort: "due_at",
        fields: [rel("project", "projects"), text("name"), date("due_at", { indexed: true })],
        samples: [{ project: { ref: "projects:0" }, name: "Design complete", due_at: ms("2026-07-15") }],
      },
      {
        slug: "sprints", singular: "Sprint", plural: "Sprints", defaultSort: "-start_date",
        fields: [rel("project", "projects"), text("name"), date("start_date", { indexed: true }), date("end_date")],
        samples: [{ project: { ref: "projects:0" }, name: "Sprint 1", start_date: ms("2026-07-01"), end_date: ms("2026-07-14") }],
      },
      {
        slug: "tasks", singular: "Task", plural: "Tasks", ownerScoped: true, fts: true, defaultSort: "-created_at",
        fields: [
          text("title", { required: true, searchable: true, group: "Task" }),
          notes("description", { searchable: true, group: "Task" }),
          select("status", [ch("todo", C.gray), ch("in_progress", C.blue, "In progress"), ch("done", C.green)], { default: "todo", group: "Task" }),
          select("priority", [ch("low", C.gray), ch("medium", C.blue), ch("high", C.red)], { default: "medium", group: "Task" }),
          rel("project", "projects", { group: "Assignment" }),
          rel("assignee", "members", { group: "Assignment" }),
          rel("sprint", "sprints", { group: "Assignment" }),
          date("due_at", { indexed: true, group: "Assignment" }),
        ],
        samples: [
          { title: "Wireframe the home page", description: "Low-fi wireframes for review.", status: "in_progress", priority: "high", project: { ref: "projects:0" }, assignee: { ref: "members:0" }, sprint: { ref: "sprints:0" }, due_at: ms("2026-07-08") },
          { title: "Set up analytics", description: "Add privacy-friendly analytics.", status: "todo", priority: "medium", project: { ref: "projects:0" }, assignee: { ref: "members:1" } },
        ],
      },
      {
        slug: "time_entries", singular: "Time entry", plural: "Time entries", ownerScoped: true, defaultSort: "-logged_at",
        fields: [rel("task", "tasks"), rel("member", "members"), num("hours", { validation: { min: 0 } }), ts("logged_at", { indexed: true })],
        samples: [{ task: { ref: "tasks:0" }, member: { ref: "members:0" }, hours: 3.5, logged_at: ms("2026-07-03") }],
      },
      {
        slug: "comments", singular: "Comment", plural: "Comments", ownerScoped: true, defaultSort: "created_at",
        fields: [rel("task", "tasks"), notes("body")],
        samples: [{ task: { ref: "tasks:0" }, body: "First draft looks great!" }],
      },
    ],
  },

  {
    id: "events",
    label: "Events / Booking",
    description: "Events, sessions, venues, tickets and attendees.",
    collections: [
      {
        slug: "venues", singular: "Venue", plural: "Venues", defaultSort: "name",
        fields: [text("name", { required: true }), text("address"), int("capacity", { validation: { min: 0 } })],
        samples: [{ name: "Main Hall", address: "1 Conference Way", capacity: 500 }],
      },
      {
        slug: "events", singular: "Event", plural: "Events", versioned: true, fts: true, defaultSort: "-start_at",
        fields: [
          text("title", { required: true, searchable: true, group: "Event" }),
          slugField("slug", { group: "Event" }),
          { name: "description", type: "longtext", interface: "richtext", searchable: true, group: "Event" },
          rel("venue", "venues", { group: "Schedule" }),
          ts("start_at", { indexed: true, group: "Schedule" }),
          ts("end_at", { group: "Schedule" }),
        ],
        samples: [{ title: "Backlex Conf 2026", slug: "backlex-conf-2026", description: "Our annual user conference.", venue: { ref: "venues:0" }, start_at: ms("2026-10-01T09:00:00Z"), end_at: ms("2026-10-01T17:00:00Z") }],
      },
      {
        slug: "sessions", singular: "Session", plural: "Sessions", defaultSort: "start_at",
        fields: [rel("event", "events"), text("title"), ts("start_at", { indexed: true }), ts("end_at")],
        samples: [{ event: { ref: "events:0" }, title: "Opening keynote", start_at: ms("2026-10-01T09:30:00Z"), end_at: ms("2026-10-01T10:30:00Z") }],
      },
      {
        slug: "ticket_types", singular: "Ticket type", plural: "Ticket types", defaultSort: "price",
        fields: [rel("event", "events"), text("name"), money("price"), int("quantity", { validation: { min: 0 } })],
        samples: [{ event: { ref: "events:0" }, name: "General Admission", price: 99, quantity: 400 }, { event: { ref: "events:0" }, name: "VIP", price: 249, quantity: 50 }],
      },
      {
        slug: "attendees", singular: "Attendee", plural: "Attendees", defaultSort: "name",
        fields: [text("name"), email("email", { required: true })],
        samples: [{ name: "Jordan Reed", email: "jordan@example.com" }],
      },
      {
        slug: "bookings", singular: "Booking", plural: "Bookings", defaultSort: "-created_at",
        fields: [rel("ticket_type", "ticket_types"), rel("attendee", "attendees"), select("status", [ch("reserved", C.amber), ch("paid", C.green), ch("cancelled", C.red)], { default: "reserved" }), int("qty", { default: 1, validation: { min: 1 } })],
        samples: [{ ticket_type: { ref: "ticket_types:0" }, attendee: { ref: "attendees:0" }, status: "paid", qty: 2 }],
      },
    ],
  },

  {
    id: "inventory",
    label: "Inventory / Operations",
    description: "Items, warehouses, stock levels, suppliers and purchase orders.",
    collections: [
      {
        slug: "warehouses", singular: "Warehouse", plural: "Warehouses", defaultSort: "name",
        fields: [text("name", { required: true }), text("location")],
        samples: [{ name: "Central DC", location: "Newark, NJ" }, { name: "West DC", location: "Reno, NV" }],
      },
      {
        slug: "suppliers", singular: "Supplier", plural: "Suppliers", defaultSort: "name",
        fields: [text("name", { required: true }), email("email"), text("phone")],
        samples: [{ name: "Globex Supplies", email: "sales@globex.example", phone: "+1 555 0190" }],
      },
      {
        slug: "items", singular: "Item", plural: "Items", fts: true, defaultSort: "name",
        fields: [text("name", { required: true, searchable: true }), text("sku", { unique: true }), money("unit_cost", { label: "Unit cost" }), text("unit")],
        samples: [{ name: "Widget A", sku: "WID-A", unit_cost: 4.5, unit: "ea" }, { name: "Widget B", sku: "WID-B", unit_cost: 6.0, unit: "ea" }],
      },
      {
        slug: "stock_levels", singular: "Stock level", plural: "Stock levels",
        fields: [rel("item", "items"), rel("warehouse", "warehouses"), int("quantity", { default: 0, validation: { min: 0 } })],
        samples: [
          { item: { ref: "items:0" }, warehouse: { ref: "warehouses:0" }, quantity: 500 },
          { item: { ref: "items:1" }, warehouse: { ref: "warehouses:0" }, quantity: 200 },
        ],
      },
      {
        slug: "purchase_orders", singular: "Purchase order", plural: "Purchase orders", defaultSort: "-created_at",
        fields: [text("number", { unique: true }), rel("supplier", "suppliers"), select("status", [ch("draft", C.gray), ch("ordered", C.blue), ch("received", C.green)], { default: "draft" }), money("total")],
        samples: [{ number: "PO-2001", supplier: { ref: "suppliers:0" }, status: "ordered", total: 2250 }],
      },
      {
        slug: "stock_transfers", singular: "Transfer", plural: "Transfers", defaultSort: "-transferred_at",
        fields: [rel("item", "items"), rel("from_warehouse", "warehouses", { label: "From warehouse" }), rel("to_warehouse", "warehouses", { label: "To warehouse" }), int("quantity", { validation: { min: 0 } }), ts("transferred_at", { indexed: true })],
        samples: [{ item: { ref: "items:0" }, from_warehouse: { ref: "warehouses:0" }, to_warehouse: { ref: "warehouses:1" }, quantity: 50, transferred_at: ms("2026-06-10") }],
      },
    ],
  },

  {
    id: "real-estate",
    label: "Real estate",
    description: "Property listings, agents, inquiries and viewings.",
    collections: [
      { slug: "media", singular: "Media", plural: "Media", fields: [file("file"), text("alt", { label: "Alt text" })] },
      {
        slug: "agents", singular: "Agent", plural: "Agents", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true }), text("phone"), file("photo")],
        samples: [{ name: "Casey Morgan", email: "casey@realty.example", phone: "+1 555 0170" }],
      },
      {
        slug: "properties", singular: "Property", plural: "Properties", versioned: true, vectorize: true, fts: true, defaultSort: "-created_at",
        fields: [
          text("title", { required: true, vectorize: true, searchable: true, group: "Listing" }),
          slugField("slug", { group: "Listing" }),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true, group: "Listing" },
          select("type", [ch("house", C.blue), ch("apartment", C.teal), ch("land", C.amber), ch("commercial", C.purple)], { default: "house", group: "Listing" }),
          select("status", [ch("for_sale", C.green, "For sale"), ch("under_offer", C.amber, "Under offer"), ch("sold", C.gray), ch("rented", C.blue)], { default: "for_sale", group: "Listing" }),
          money("price", { group: "Details" }),
          int("bedrooms", { default: 0, validation: { min: 0 }, group: "Details" }),
          int("bathrooms", { default: 0, validation: { min: 0 }, group: "Details" }),
          num("area_sqm", { label: "Area (m²)", validation: { min: 0 }, group: "Details" }),
          text("address", { group: "Location" }),
          text("city", { indexed: true, group: "Location" }),
          rel("agent", "agents", { group: "Location" }),
          relMany("images", "media", { group: "Media" }),
          bool("featured", { default: false, label: "Featured", group: "Media" }),
        ],
        samples: [
          { title: "Sunny 2-bed apartment", slug: "sunny-2-bed-apartment", description: "Bright apartment near the park.", type: "apartment", status: "for_sale", price: 320000, bedrooms: 2, bathrooms: 1, area_sqm: 78, city: "Austin", agent: { ref: "agents:0" }, featured: true },
          { title: "Family house with garden", slug: "family-house-with-garden", description: "Spacious 4-bed with large garden.", type: "house", status: "for_sale", price: 540000, bedrooms: 4, bathrooms: 3, area_sqm: 180, city: "Denver", agent: { ref: "agents:0" } },
        ],
      },
      {
        slug: "inquiries", singular: "Inquiry", plural: "Inquiries", ownerScoped: true, defaultSort: "-created_at",
        fields: [rel("property", "properties"), text("name"), email("email"), notes("message"), select("status", [ch("new", C.blue), ch("contacted", C.amber), ch("closed", C.gray)], { default: "new" })],
        samples: [{ property: { ref: "properties:0" }, name: "Jordan Reed", email: "jordan@example.com", message: "Is this still available?", status: "new" }],
      },
      {
        slug: "viewings", singular: "Viewing", plural: "Viewings", defaultSort: "-scheduled_at",
        fields: [rel("property", "properties"), text("name"), email("email"), ts("scheduled_at", { indexed: true }), select("status", [ch("scheduled", C.blue), ch("completed", C.green), ch("no_show", C.red, "No show")], { default: "scheduled" })],
        samples: [{ property: { ref: "properties:0" }, name: "Jordan Reed", email: "jordan@example.com", scheduled_at: ms("2026-07-10T15:00:00Z"), status: "scheduled" }],
      },
    ],
  },

  {
    id: "restaurant",
    label: "Restaurant",
    description: "Menu, tables, reservations and orders.",
    collections: [
      {
        slug: "menu_categories", singular: "Menu category", plural: "Menu categories", defaultSort: "position",
        fields: [text("name", { required: true }), int("position", { default: 0, indexed: true })],
        samples: [{ name: "Starters", position: 1 }, { name: "Mains", position: 2 }, { name: "Desserts", position: 3 }],
      },
      {
        slug: "menu_items", singular: "Menu item", plural: "Menu items", fts: true, defaultSort: "name",
        fields: [
          text("name", { required: true, searchable: true, group: "Item" }),
          notes("description", { searchable: true, group: "Item" }),
          rel("category", "menu_categories", { group: "Item" }),
          money("price", { required: true, group: "Item" }),
          bool("available", { default: true, label: "Available", group: "Flags" }),
          bool("spicy", { default: false, label: "Spicy", group: "Flags" }),
          file("image", { group: "Flags" }),
        ],
        samples: [
          { name: "Bruschetta", description: "Toasted bread, tomato, basil.", category: { ref: "menu_categories:0" }, price: 8 },
          { name: "Margherita Pizza", description: "Tomato, mozzarella, basil.", category: { ref: "menu_categories:1" }, price: 14 },
        ],
      },
      {
        slug: "tables", singular: "Table", plural: "Tables", defaultSort: "name",
        fields: [text("name", { required: true }), int("seats", { default: 2, validation: { min: 1 } })],
        samples: [{ name: "T1", seats: 2 }, { name: "T2", seats: 4 }],
      },
      {
        slug: "reservations", singular: "Reservation", plural: "Reservations", defaultSort: "-reserved_at",
        fields: [text("name", { required: true }), email("email"), text("phone"), int("party_size", { default: 2, validation: { min: 1 }, label: "Party size" }), ts("reserved_at", { indexed: true }), rel("table", "tables"), select("status", [ch("pending", C.amber), ch("confirmed", C.green), ch("seated", C.blue), ch("cancelled", C.red)], { default: "pending" })],
        samples: [{ name: "Jordan Reed", email: "jordan@example.com", party_size: 4, reserved_at: ms("2026-07-04T19:00:00Z"), table: { ref: "tables:1" }, status: "confirmed" }],
      },
      {
        slug: "orders", singular: "Order", plural: "Orders", defaultSort: "-created_at",
        fields: [text("number", { unique: true }), rel("table", "tables"), select("status", [ch("open", C.blue), ch("preparing", C.amber), ch("served", C.teal), ch("paid", C.green)], { default: "open" }), money("total")],
        samples: [{ number: "R-1001", table: { ref: "tables:1" }, status: "open", total: 22 }],
      },
      {
        slug: "order_items", singular: "Order item", plural: "Order items",
        fields: [rel("order", "orders"), rel("menu_item", "menu_items"), int("qty", { default: 1, validation: { min: 1 } }), money("unit_price"), computedNum("line_total", "qty * unit_price", { label: "Line total" })],
        samples: [{ order: { ref: "orders:0" }, menu_item: { ref: "menu_items:0" }, qty: 1, unit_price: 8 }, { order: { ref: "orders:0" }, menu_item: { ref: "menu_items:1" }, qty: 1, unit_price: 14 }],
      },
    ],
  },

  {
    id: "lms",
    label: "Online courses (LMS)",
    description: "Courses, modules, lessons, students and enrollments.",
    collections: [
      {
        slug: "instructors", singular: "Instructor", plural: "Instructors", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true }), notes("bio")],
        samples: [{ name: "Dr. Ada Lovelace", email: "ada@academy.example", bio: "Teaches computing fundamentals." }],
      },
      {
        slug: "courses", singular: "Course", plural: "Courses", versioned: true, vectorize: true, fts: true, defaultSort: "title",
        fields: [
          text("title", { required: true, vectorize: true, searchable: true, group: "Course" }),
          slugField("slug", { group: "Course" }),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true, group: "Course" },
          rel("instructor", "instructors", { group: "Course" }),
          select("level", [ch("beginner", C.green), ch("intermediate", C.amber), ch("advanced", C.red)], { default: "beginner", group: "Details" }),
          money("price", { default: 0, group: "Details" }),
          bool("published", { default: false, label: "Published", group: "Details" }),
        ],
        samples: [{ title: "Intro to Programming", slug: "intro-to-programming", description: "Start coding from zero.", instructor: { ref: "instructors:0" }, level: "beginner", price: 0, published: true }],
      },
      {
        slug: "modules", singular: "Module", plural: "Modules", defaultSort: "position",
        fields: [rel("course", "courses"), text("title", { required: true }), int("position", { default: 0, indexed: true })],
        samples: [{ course: { ref: "courses:0" }, title: "Getting started", position: 1 }, { course: { ref: "courses:0" }, title: "Variables & types", position: 2 }],
      },
      {
        slug: "lessons", singular: "Lesson", plural: "Lessons", defaultSort: "position",
        fields: [rel("module", "modules"), text("title", { required: true }), { name: "content", type: "longtext", interface: "richtext" }, int("duration_mins", { default: 0, label: "Duration (min)", validation: { min: 0 } }), int("position", { default: 0, indexed: true })],
        samples: [{ module: { ref: "modules:0" }, title: "Welcome", content: "Course overview.", duration_mins: 5, position: 1 }],
      },
      {
        slug: "students", singular: "Student", plural: "Students", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true })],
        samples: [{ name: "Sam Taylor", email: "sam@student.example" }],
      },
      {
        slug: "enrollments", singular: "Enrollment", plural: "Enrollments", ownerScoped: true, defaultSort: "-enrolled_at",
        fields: [rel("student", "students"), rel("course", "courses"), select("status", [ch("active", C.green), ch("completed", C.blue), ch("dropped", C.gray)], { default: "active" }), int("progress", { default: 0, validation: { min: 0, max: 100 }, label: "Progress (%)" }), ts("enrolled_at", { indexed: true })],
        samples: [{ student: { ref: "students:0" }, course: { ref: "courses:0" }, status: "active", progress: 35, enrolled_at: ms("2026-06-01") }],
      },
    ],
  },

  {
    id: "ats",
    label: "Recruiting (ATS)",
    description: "Job openings, candidates, applications and interviews.",
    collections: [
      {
        slug: "departments", singular: "Department", plural: "Departments", defaultSort: "name",
        fields: [text("name", { required: true })],
        samples: [{ name: "Engineering" }, { name: "Marketing" }],
      },
      {
        slug: "jobs", singular: "Job", plural: "Jobs", versioned: true, fts: true, defaultSort: "-created_at",
        fields: [
          text("title", { required: true, searchable: true, group: "Job" }),
          slugField("slug", { group: "Job" }),
          { name: "description", type: "longtext", interface: "richtext", searchable: true, group: "Job" },
          rel("department", "departments", { group: "Job" }),
          text("location", { group: "Details" }),
          select("employment_type", [ch("full_time", C.green, "Full time"), ch("part_time", C.blue, "Part time"), ch("contract", C.amber), ch("intern", C.gray)], { default: "full_time", label: "Employment type", group: "Details" }),
          select("status", [ch("draft", C.gray), ch("open", C.green), ch("closed", C.red)], { default: "open", group: "Details" }),
          money("salary_min", { label: "Salary min", group: "Compensation" }),
          money("salary_max", { label: "Salary max", group: "Compensation" }),
        ],
        samples: [{ title: "Senior Backend Engineer", slug: "senior-backend-engineer", description: "Build our API platform.", department: { ref: "departments:0" }, location: "Remote", employment_type: "full_time", status: "open", salary_min: 120000, salary_max: 160000 }],
      },
      {
        slug: "candidates", singular: "Candidate", plural: "Candidates", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true }), text("phone"), file("resume"), url("linkedin", { label: "LinkedIn" })],
        samples: [{ name: "Jordan Reed", email: "jordan@example.com", phone: "+1 555 0123" }],
      },
      {
        slug: "applications", singular: "Application", plural: "Applications", ownerScoped: true, defaultSort: "-applied_at",
        fields: [
          rel("job", "jobs"), rel("candidate", "candidates"),
          select("stage", [ch("applied", C.gray), ch("screening", C.blue), ch("interview", C.amber), ch("offer", C.purple), ch("hired", C.green), ch("rejected", C.red)], { default: "applied" }),
          rating("rating"), notes("notes"), ts("applied_at", { indexed: true }),
        ],
        samples: [{ job: { ref: "jobs:0" }, candidate: { ref: "candidates:0" }, stage: "screening", rating: 4, notes: "Strong background — schedule a call.", applied_at: ms("2026-06-15") }],
      },
      {
        slug: "interviews", singular: "Interview", plural: "Interviews", defaultSort: "-scheduled_at",
        fields: [rel("application", "applications"), text("interviewer"), ts("scheduled_at", { indexed: true }), notes("notes")],
        samples: [{ application: { ref: "applications:0" }, interviewer: "Grace Hopper", scheduled_at: ms("2026-06-22T16:00:00Z") }],
      },
    ],
  },

  {
    id: "marketplace",
    label: "Marketplace",
    description: "Multi-vendor listings, orders and reviews.",
    collections: [
      { slug: "media", singular: "Media", plural: "Media", fields: [file("file"), text("alt", { label: "Alt text" })] },
      {
        slug: "vendors", singular: "Vendor", plural: "Vendors", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true }), select("status", [ch("active", C.green), ch("suspended", C.red)], { default: "active" }), num("commission_pct", { default: 10, validation: { min: 0, max: 100 }, label: "Commission (%)" })],
        samples: [{ name: "Acme Goods", email: "sales@acme.example", status: "active", commission_pct: 12 }],
      },
      {
        slug: "categories", singular: "Category", plural: "Categories", defaultSort: "name",
        fields: [text("name", { required: true }), slugField()],
        samples: [{ name: "Home", slug: "home" }, { name: "Outdoors", slug: "outdoors" }],
      },
      {
        slug: "listings", singular: "Listing", plural: "Listings", versioned: true, vectorize: true, fts: true, defaultSort: "-created_at",
        fields: [
          text("title", { required: true, vectorize: true, searchable: true, group: "Listing" }),
          slugField("slug", { group: "Listing" }),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true, group: "Listing" },
          rel("vendor", "vendors", { group: "Listing" }),
          rel("category", "categories", { group: "Listing" }),
          money("price", { required: true, group: "Pricing" }),
          int("stock", { default: 0, validation: { min: 0 }, group: "Pricing" }),
          select("status", [ch("active", C.green), ch("paused", C.amber), ch("sold_out", C.red, "Sold out")], { default: "active", group: "Pricing" }),
          relMany("images", "media", { group: "Media" }),
        ],
        samples: [{ title: "Camp Stove", slug: "camp-stove", description: "Compact gas stove.", vendor: { ref: "vendors:0" }, category: { ref: "categories:1" }, price: 45, stock: 30, status: "active" }],
      },
      {
        slug: "buyers", singular: "Buyer", plural: "Buyers", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true })],
        samples: [{ name: "Sam Taylor", email: "sam@example.com" }],
      },
      {
        slug: "orders", singular: "Order", plural: "Orders", defaultSort: "-placed_at",
        fields: [text("number", { unique: true }), rel("buyer", "buyers"), rel("vendor", "vendors"), select("status", [ch("pending", C.amber), ch("paid", C.green), ch("shipped", C.blue), ch("delivered", C.teal), ch("refunded", C.red)], { default: "pending" }), money("total"), ts("placed_at", { indexed: true })],
        samples: [{ number: "M-1001", buyer: { ref: "buyers:0" }, vendor: { ref: "vendors:0" }, status: "paid", total: 45, placed_at: ms("2026-06-18") }],
      },
      {
        slug: "reviews", singular: "Review", plural: "Reviews", ownerScoped: true, defaultSort: "-created_at",
        fields: [rel("listing", "listings"), rel("buyer", "buyers"), rating("rating"), notes("body")],
        samples: [{ listing: { ref: "listings:0" }, buyer: { ref: "buyers:0" }, rating: 5, body: "Works great on trips." }],
      },
    ],
  },

  {
    id: "nonprofit",
    label: "Nonprofit",
    description: "Donors, campaigns, donations, volunteers and events.",
    collections: [
      {
        slug: "donors", singular: "Donor", plural: "Donors", defaultSort: "name",
        fields: [text("name", { required: true }), email("email", { unique: true }), text("phone")],
        samples: [{ name: "Jordan Reed", email: "jordan@example.com" }, { name: "Sam Taylor", email: "sam@example.com" }],
      },
      {
        slug: "campaigns", singular: "Campaign", plural: "Campaigns", defaultSort: "-created_at",
        fields: [
          text("name", { required: true, group: "Campaign" }),
          slugField("slug", { group: "Campaign" }),
          { name: "description", type: "longtext", interface: "richtext", group: "Campaign" },
          money("goal_amount", { label: "Goal", group: "Progress" }),
          money("raised_amount", { default: 0, label: "Raised", group: "Progress" }),
          select("status", [ch("active", C.green), ch("paused", C.amber), ch("completed", C.blue)], { default: "active", group: "Progress" }),
          date("starts_at", { indexed: true, group: "Progress" }),
          date("ends_at", { group: "Progress" }),
        ],
        samples: [{ name: "Winter Fund", slug: "winter-fund", description: "Support families this winter.", goal_amount: 50000, raised_amount: 12500, status: "active", starts_at: ms("2026-11-01"), ends_at: ms("2026-12-31") }],
      },
      {
        slug: "donations", singular: "Donation", plural: "Donations", ownerScoped: true, defaultSort: "-donated_at",
        fields: [rel("donor", "donors"), rel("campaign", "campaigns"), money("amount", { required: true }), select("status", [ch("pending", C.amber), ch("completed", C.green), ch("refunded", C.red)], { default: "completed" }), ts("donated_at", { indexed: true })],
        samples: [{ donor: { ref: "donors:0" }, campaign: { ref: "campaigns:0" }, amount: 100, status: "completed", donated_at: ms("2026-11-10") }],
      },
      {
        slug: "volunteers", singular: "Volunteer", plural: "Volunteers", defaultSort: "name",
        fields: [text("name", { required: true }), email("email"), notes("skills")],
        samples: [{ name: "Casey Morgan", email: "casey@example.com", skills: "Event setup, outreach." }],
      },
      {
        slug: "events", singular: "Event", plural: "Events", defaultSort: "-starts_at",
        fields: [text("title", { required: true }), slugField(), { name: "description", type: "longtext", interface: "richtext" }, ts("starts_at", { indexed: true }), text("location")],
        samples: [{ title: "Charity Gala", slug: "charity-gala", description: "Annual fundraising gala.", starts_at: ms("2026-12-05T18:00:00Z"), location: "Grand Hotel" }],
      },
    ],
  },

  {
    id: "forms",
    label: "Forms & surveys",
    description: "Build forms, collect responses and answers.",
    collections: [
      {
        slug: "forms", singular: "Form", plural: "Forms", defaultSort: "-created_at",
        fields: [text("name", { required: true }), slugField(), notes("description"), select("status", [ch("draft", C.gray), ch("published", C.green), ch("closed", C.red)], { default: "draft" })],
        samples: [{ name: "Customer Feedback", slug: "customer-feedback", description: "Tell us how we did.", status: "published" }],
      },
      {
        slug: "questions", singular: "Question", plural: "Questions", defaultSort: "position",
        fields: [rel("form", "forms"), text("label", { required: true }), select("type", [ch("text", C.blue), ch("textarea", C.teal), ch("select", C.purple), ch("checkbox", C.amber), ch("rating", C.green)], { default: "text" }), int("position", { default: 0, indexed: true }), bool("required", { default: false })],
        samples: [
          { form: { ref: "forms:0" }, label: "How satisfied were you?", type: "rating", position: 1, required: true },
          { form: { ref: "forms:0" }, label: "Any other comments?", type: "textarea", position: 2 },
        ],
      },
      {
        slug: "responses", singular: "Response", plural: "Responses", defaultSort: "-submitted_at",
        fields: [rel("form", "forms"), email("email"), ts("submitted_at", { indexed: true })],
        samples: [{ form: { ref: "forms:0" }, email: "jordan@example.com", submitted_at: ms("2026-06-20") }],
      },
      {
        slug: "answers", singular: "Answer", plural: "Answers",
        fields: [rel("response", "responses"), rel("question", "questions"), notes("value")],
        samples: [
          { response: { ref: "responses:0" }, question: { ref: "questions:0" }, value: "5" },
          { response: { ref: "responses:0" }, question: { ref: "questions:1" }, value: "Loved the support." },
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
    collections: t.collections.map((c) => ({
      slug: c.slug,
      label: c.plural ?? c.slug,
      fieldCount: c.fields.length,
    })),
  }));
