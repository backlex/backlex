import type { FieldDef } from "@backlex/db";

/**
 * Schema template catalog — vertical "starter" collection sets seeded into a
 * new project. The cloud control plane passes a template `id` (via the
 * `SEED_TEMPLATE` worker var); this repo owns the actual definitions and
 * materializes them with the normal collection engine. Ids are the contract
 * with cloud — keep them stable.
 *
 * Collections are listed in dependency order (relation targets before the
 * collections that point at them) so `applyTemplate` can create them top-down.
 */
export interface TemplateCollection {
  slug: string;
  singular?: string;
  plural?: string;
  note?: string;
  ownerScoped?: boolean;
  versioned?: boolean;
  vectorize?: boolean;
  defaultSort?: string;
  fields: FieldDef[];
}

export interface SchemaTemplate {
  id: string;
  label: string;
  description: string;
  collections: TemplateCollection[];
}

const text = (name: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type: "text", ...extra });
const long = (name: string): FieldDef => ({ name, type: "longtext", interface: "richtext" });
const num = (name: string): FieldDef => ({ name, type: "number" });
const int = (name: string): FieldDef => ({ name, type: "integer" });
const bool = (name: string): FieldDef => ({ name, type: "boolean", interface: "toggle" });
const ts = (name: string): FieldDef => ({ name, type: "timestamp", interface: "datetime" });
const file = (name: string): FieldDef => ({ name, type: "file" });
const rel = (name: string, to: string): FieldDef => ({ name, type: "relation", to, interface: "relation" });
const relMany = (name: string, to: string): FieldDef => ({ name, type: "relation_many", to });
const select = (name: string, values: string[]): FieldDef => ({
  name,
  type: "text",
  interface: "dropdown",
  options: { choices: values.map((v) => ({ value: v })) },
});

export const TEMPLATES: SchemaTemplate[] = [
  { id: "blank", label: "Blank", description: "No collections — start from scratch.", collections: [] },

  {
    id: "blog",
    label: "Blog / CMS",
    description: "Posts, pages, categories, tags, authors and media.",
    collections: [
      { slug: "media", singular: "Media", plural: "Media", fields: [file("file"), text("alt")] },
      { slug: "authors", singular: "Author", plural: "Authors", fields: [text("name", { required: true }), long("bio"), file("avatar")] },
      { slug: "categories", singular: "Category", plural: "Categories", fields: [text("name", { required: true }), text("slug", { unique: true })] },
      { slug: "tags", singular: "Tag", plural: "Tags", fields: [text("name", { required: true })] },
      {
        slug: "posts", singular: "Post", plural: "Posts", ownerScoped: true, versioned: true, vectorize: true,
        defaultSort: "-_published_at",
        fields: [
          text("title", { required: true, vectorize: true }), text("slug", { unique: true }),
          { name: "excerpt", type: "longtext", vectorize: true }, { name: "body", type: "longtext", interface: "richtext", vectorize: true },
          file("cover"), rel("author", "authors"), rel("category", "categories"), relMany("tags", "tags"),
        ],
      },
      { slug: "pages", singular: "Page", plural: "Pages", versioned: true, fields: [text("title", { required: true }), text("slug", { unique: true }), long("body")] },
    ],
  },

  {
    id: "ecommerce",
    label: "E-commerce",
    description: "Products, variants, orders, customers, discounts and reviews.",
    collections: [
      { slug: "media", singular: "Media", plural: "Media", fields: [file("file"), text("alt")] },
      { slug: "categories", singular: "Category", plural: "Categories", fields: [text("name", { required: true }), text("slug", { unique: true })] },
      { slug: "customers", singular: "Customer", plural: "Customers", fields: [text("email", { required: true, unique: true }), text("name"), text("phone")] },
      {
        slug: "products", singular: "Product", plural: "Products", versioned: true, vectorize: true,
        fields: [
          text("name", { required: true, vectorize: true }), text("slug", { unique: true }), { name: "description", type: "longtext", vectorize: true },
          num("price"), text("currency"), text("sku", { unique: true }), int("stock"), relMany("images", "media"), rel("category", "categories"),
        ],
      },
      { slug: "product_variants", singular: "Variant", plural: "Variants", fields: [rel("product", "products"), text("name"), text("sku"), num("price"), int("stock")] },
      { slug: "discounts", singular: "Discount", plural: "Discounts", fields: [text("code", { unique: true }), select("type", ["percent", "fixed"]), num("value"), ts("expires_at")] },
      { slug: "addresses", singular: "Address", plural: "Addresses", fields: [rel("customer", "customers"), text("line1"), text("line2"), text("city"), text("country"), text("postal_code")] },
      {
        slug: "orders", singular: "Order", plural: "Orders", defaultSort: "-placed_at",
        fields: [text("number", { unique: true }), rel("customer", "customers"), select("status", ["pending", "paid", "shipped", "delivered", "cancelled"]), num("total"), text("currency"), ts("placed_at")],
      },
      { slug: "order_items", singular: "Order item", plural: "Order items", fields: [rel("order", "orders"), rel("product", "products"), int("qty"), num("unit_price")] },
      { slug: "reviews", singular: "Review", plural: "Reviews", ownerScoped: true, fields: [rel("product", "products"), rel("customer", "customers"), int("rating"), long("body")] },
    ],
  },

  {
    id: "saas",
    label: "SaaS",
    description: "Accounts, members, plans, subscriptions, invoices and usage.",
    collections: [
      { slug: "accounts", singular: "Account", plural: "Accounts", fields: [text("name", { required: true }), text("slug", { unique: true }), select("status", ["active", "suspended"])] },
      { slug: "account_members", singular: "Member", plural: "Members", fields: [rel("account", "accounts"), text("email", { required: true }), select("role", ["owner", "admin", "member"])] },
      { slug: "plans", singular: "Plan", plural: "Plans", fields: [text("name", { required: true }), num("price"), text("currency"), text("interval")] },
      { slug: "subscriptions", singular: "Subscription", plural: "Subscriptions", fields: [rel("account", "accounts"), rel("plan", "plans"), select("status", ["trialing", "active", "past_due", "canceled"]), ts("current_period_end")] },
      { slug: "invoices", singular: "Invoice", plural: "Invoices", defaultSort: "-issued_at", fields: [rel("account", "accounts"), text("number", { unique: true }), num("amount"), text("currency"), select("status", ["draft", "open", "paid", "void"]), ts("issued_at")] },
      { slug: "usage_records", singular: "Usage", plural: "Usage", fields: [rel("account", "accounts"), text("metric"), num("quantity"), ts("recorded_at")] },
      { slug: "feature_flags", singular: "Feature flag", plural: "Feature flags", fields: [text("key", { unique: true }), bool("enabled"), long("description")] },
      { slug: "webhooks", singular: "Webhook", plural: "Webhooks", fields: [rel("account", "accounts"), text("url"), bool("active")] },
    ],
  },

  {
    id: "crm",
    label: "CRM",
    description: "Contacts, companies, leads, deals, pipelines and activities.",
    collections: [
      { slug: "companies", singular: "Company", plural: "Companies", fields: [text("name", { required: true }), text("domain"), text("industry"), int("employees")] },
      { slug: "contacts", singular: "Contact", plural: "Contacts", fields: [text("first_name"), text("last_name"), text("email", { unique: true }), text("phone"), rel("company", "companies")] },
      { slug: "pipelines", singular: "Pipeline", plural: "Pipelines", fields: [text("name", { required: true })] },
      { slug: "pipeline_stages", singular: "Stage", plural: "Stages", defaultSort: "position", fields: [rel("pipeline", "pipelines"), text("name", { required: true }), int("position")] },
      { slug: "leads", singular: "Lead", plural: "Leads", ownerScoped: true, fields: [text("name"), text("email"), select("status", ["new", "qualified", "lost"]), text("source")] },
      { slug: "deals", singular: "Deal", plural: "Deals", ownerScoped: true, defaultSort: "-created_at", fields: [text("title", { required: true }), num("amount"), text("currency"), rel("company", "companies"), rel("stage", "pipeline_stages"), ts("close_date")] },
      { slug: "activities", singular: "Activity", plural: "Activities", ownerScoped: true, fields: [select("type", ["call", "email", "meeting", "note"]), long("body"), rel("contact", "contacts"), rel("deal", "deals"), ts("due_at")] },
      { slug: "tasks", singular: "Task", plural: "Tasks", ownerScoped: true, fields: [text("title", { required: true }), bool("done"), ts("due_at")] },
    ],
  },

  {
    id: "support",
    label: "Support / Helpdesk",
    description: "Tickets, messages, agents, SLAs and a knowledge base.",
    collections: [
      { slug: "customers", singular: "Customer", plural: "Customers", fields: [text("email", { required: true, unique: true }), text("name")] },
      { slug: "agents", singular: "Agent", plural: "Agents", fields: [text("name", { required: true }), text("email", { unique: true })] },
      { slug: "categories", singular: "Category", plural: "Categories", fields: [text("name", { required: true })] },
      { slug: "slas", singular: "SLA", plural: "SLAs", fields: [text("name"), int("first_response_mins"), int("resolution_mins")] },
      { slug: "tickets", singular: "Ticket", plural: "Tickets", defaultSort: "-created_at", fields: [text("subject", { required: true }), select("status", ["open", "pending", "solved", "closed"]), select("priority", ["low", "normal", "high", "urgent"]), rel("customer", "customers"), rel("agent", "agents"), rel("category", "categories")] },
      { slug: "ticket_messages", singular: "Message", plural: "Messages", fields: [rel("ticket", "tickets"), long("body"), bool("internal")] },
      { slug: "kb_articles", singular: "Article", plural: "Articles", versioned: true, vectorize: true, fields: [text("title", { required: true, vectorize: true }), text("slug", { unique: true }), { name: "body", type: "longtext", vectorize: true }, rel("category", "categories")] },
      { slug: "canned_responses", singular: "Canned response", plural: "Canned responses", fields: [text("title"), long("body")] },
    ],
  },

  {
    id: "hr",
    label: "HR / People",
    description: "Employees, departments, leave, documents and reviews.",
    collections: [
      { slug: "departments", singular: "Department", plural: "Departments", fields: [text("name", { required: true })] },
      { slug: "positions", singular: "Position", plural: "Positions", fields: [text("title", { required: true }), rel("department", "departments")] },
      { slug: "employees", singular: "Employee", plural: "Employees", fields: [text("first_name"), text("last_name"), text("email", { unique: true }), rel("department", "departments"), rel("position", "positions"), ts("hired_at"), select("status", ["active", "on_leave", "terminated"])] },
      { slug: "leave_requests", singular: "Leave request", plural: "Leave requests", fields: [rel("employee", "employees"), select("type", ["annual", "sick", "unpaid"]), ts("start_date"), ts("end_date"), select("status", ["pending", "approved", "rejected"])] },
      { slug: "documents", singular: "Document", plural: "Documents", fields: [rel("employee", "employees"), text("title"), file("file")] },
      { slug: "performance_reviews", singular: "Review", plural: "Reviews", fields: [rel("employee", "employees"), text("period"), int("score"), long("notes")] },
    ],
  },

  {
    id: "projects",
    label: "Project management",
    description: "Projects, tasks, milestones, sprints and time tracking.",
    collections: [
      { slug: "members", singular: "Member", plural: "Members", fields: [text("name", { required: true }), text("email", { unique: true })] },
      { slug: "projects", singular: "Project", plural: "Projects", fields: [text("name", { required: true }), text("key", { unique: true }), select("status", ["active", "archived"]), long("description")] },
      { slug: "milestones", singular: "Milestone", plural: "Milestones", fields: [rel("project", "projects"), text("name"), ts("due_at")] },
      { slug: "sprints", singular: "Sprint", plural: "Sprints", fields: [rel("project", "projects"), text("name"), ts("start_date"), ts("end_date")] },
      { slug: "tasks", singular: "Task", plural: "Tasks", ownerScoped: true, defaultSort: "-created_at", fields: [text("title", { required: true }), long("description"), select("status", ["todo", "in_progress", "done"]), select("priority", ["low", "medium", "high"]), rel("project", "projects"), rel("assignee", "members"), rel("sprint", "sprints"), ts("due_at")] },
      { slug: "time_entries", singular: "Time entry", plural: "Time entries", ownerScoped: true, fields: [rel("task", "tasks"), rel("member", "members"), num("hours"), ts("logged_at")] },
      { slug: "comments", singular: "Comment", plural: "Comments", ownerScoped: true, fields: [rel("task", "tasks"), long("body")] },
    ],
  },

  {
    id: "events",
    label: "Events / Booking",
    description: "Events, sessions, venues, tickets and attendees.",
    collections: [
      { slug: "venues", singular: "Venue", plural: "Venues", fields: [text("name", { required: true }), text("address"), int("capacity")] },
      { slug: "events", singular: "Event", plural: "Events", versioned: true, defaultSort: "-start_at", fields: [text("title", { required: true }), text("slug", { unique: true }), long("description"), rel("venue", "venues"), ts("start_at"), ts("end_at")] },
      { slug: "sessions", singular: "Session", plural: "Sessions", fields: [rel("event", "events"), text("title"), ts("start_at"), ts("end_at")] },
      { slug: "ticket_types", singular: "Ticket type", plural: "Ticket types", fields: [rel("event", "events"), text("name"), num("price"), int("quantity")] },
      { slug: "attendees", singular: "Attendee", plural: "Attendees", fields: [text("name"), text("email", { required: true })] },
      { slug: "bookings", singular: "Booking", plural: "Bookings", defaultSort: "-created_at", fields: [rel("ticket_type", "ticket_types"), rel("attendee", "attendees"), select("status", ["reserved", "paid", "cancelled"]), int("qty")] },
    ],
  },

  {
    id: "inventory",
    label: "Inventory / Operations",
    description: "Items, warehouses, stock levels, suppliers and purchase orders.",
    collections: [
      { slug: "warehouses", singular: "Warehouse", plural: "Warehouses", fields: [text("name", { required: true }), text("location")] },
      { slug: "suppliers", singular: "Supplier", plural: "Suppliers", fields: [text("name", { required: true }), text("email"), text("phone")] },
      { slug: "items", singular: "Item", plural: "Items", fields: [text("name", { required: true }), text("sku", { unique: true }), num("unit_cost"), text("unit")] },
      { slug: "stock_levels", singular: "Stock level", plural: "Stock levels", fields: [rel("item", "items"), rel("warehouse", "warehouses"), int("quantity")] },
      { slug: "purchase_orders", singular: "Purchase order", plural: "Purchase orders", defaultSort: "-created_at", fields: [text("number", { unique: true }), rel("supplier", "suppliers"), select("status", ["draft", "ordered", "received"]), num("total")] },
      { slug: "stock_transfers", singular: "Transfer", plural: "Transfers", fields: [rel("item", "items"), rel("from_warehouse", "warehouses"), rel("to_warehouse", "warehouses"), int("quantity"), ts("transferred_at")] },
    ],
  },
];

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

export const getTemplate = (id: string): SchemaTemplate | undefined =>
  TEMPLATES.find((t) => t.id === id);

/** Lightweight catalog for pickers/previews (no full field defs). */
export const templateSummaries = () =>
  TEMPLATES.map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    collections: t.collections.map((c) => ({
      slug: c.slug,
      label: c.plural ?? c.slug,
      fieldCount: c.fields.length,
    })),
  }));
