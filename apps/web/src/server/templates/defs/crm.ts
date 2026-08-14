import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, computedText, date, email, file, flag, flow, half, hint, host, int, money, moneyIn, ms, notes, num, pct, phone, position, rel, sec, select, stacked, text, ts } from "../dsl";

export const crm: SchemaTemplate = {
  id: "crm",
  label: "CRM",
  groups: ["People", "Sales", "Catalog", "Engagement", "Marketing"],
  description:
    "Salesforce/HubSpot-grade sales CRM: companies, contacts with lifecycle stages, leads, a configurable pipeline of stages, deals with probability, forecast and product line items, sales teams with targets, lead sources and lost reasons, a sellable product catalog with quotes and quote lines, signed contracts, marketing campaigns with membership tracking, plus logged activities, notes and tasks.",
  collections: [
    {
      slug: "companies", group: "People", singular: "Company", plural: "Companies", defaultSort: "name",
      fields: stacked(
        sec("Company", [
          ...half(text("name", { required: true }), host("domain")),
          ...half(
            text("industry"),
            select("type", [ch("prospect", C.gray), ch("customer", C.green), ch("partner", C.blue), ch("reseller", C.teal), ch("vendor", C.purple), ch("other", C.slate)], { default: "prospect" }),
          ),
          select("lifecycle_stage", [ch("subscriber", C.gray), ch("lead", C.blue), ch("marketingqualifiedlead", C.teal, "MQL"), ch("salesqualifiedlead", C.amber, "SQL"), ch("opportunity", C.purple), ch("customer", C.green), ch("evangelist", C.green), ch("other", C.slate)], { default: "lead", label: "Lifecycle stage" }),
        ]),
        sec("Firmographics", [
          ...half(int("employees", { validation: { min: 0 } }), money("annual_revenue", { label: "Annual revenue" })),
          ...half(phone("phone"), text("city")),
          text("country"),
        ]),
      ),
      samples: [
        { name: "Acme Inc", domain: "acme.example", industry: "Manufacturing", type: "customer", lifecycle_stage: "customer", employees: 250, annual_revenue: 12000000, city: "Austin", country: "US" },
        { name: "Globex", domain: "globex.example", industry: "Energy", type: "prospect", lifecycle_stage: "opportunity", employees: 1200, annual_revenue: 80000000, city: "Denver", country: "US" },
      ],
    },
    {
      slug: "contacts", group: "People", singular: "Contact", plural: "Contacts", fts: true, defaultSort: "last_name",
      fields: stacked(
        sec("Identity", [
          ...half(text("first_name", { label: "First name", searchable: true }), text("last_name", { label: "Last name", searchable: true })),
          ...half(computedText("full_name", "first_name || ' ' || last_name", { label: "Full name" }), text("job_title", { label: "Job title" })),
        ]),
        sec("Contact", [
          ...half(email("email", { unique: true, searchable: true }), rel("company", "companies")),
          ...half(phone("phone"), phone("mobile_phone", { label: "Mobile" })),
        ]),
        sec("Status", [
          ...half(
            select("lifecycle_stage", [ch("subscriber", C.gray), ch("lead", C.blue), ch("marketingqualifiedlead", C.teal, "MQL"), ch("salesqualifiedlead", C.amber, "SQL"), ch("opportunity", C.purple), ch("customer", C.green), ch("evangelist", C.green)], { default: "lead", label: "Lifecycle stage" }),
            select("lead_status", [ch("new", C.blue), ch("open", C.teal), ch("in_progress", C.amber, "In progress"), ch("connected", C.green), ch("unqualified", C.gray)], { default: "new", label: "Lead status" }),
          ),
          ...half(
            select("lead_source", [ch("web", C.blue), ch("phone_inquiry", C.teal, "Phone inquiry"), ch("partner_referral", C.purple, "Partner referral"), ch("purchased_list", C.gray, "Purchased list"), ch("event", C.amber), ch("other", C.slate)], { default: "web", label: "Source" }),
            ts("last_contacted", { label: "Last contacted" }),
          ),
        ]),
      ),
      samples: [
        { first_name: "Jordan", last_name: "Reed", job_title: "Head of Ops", email: "jordan@acme.example", company: { ref: "companies:0" }, lifecycle_stage: "customer", lead_status: "connected", lead_source: "web" },
        { first_name: "Sam", last_name: "Taylor", job_title: "CTO", email: "sam@globex.example", company: { ref: "companies:1" }, lifecycle_stage: "opportunity", lead_status: "in_progress", lead_source: "event" },
      ],
    },
    {
      slug: "sales_teams", group: "Sales", singular: "Sales team", plural: "Sales teams", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("region")),
        ...half(money("target_amount", { label: "Target amount" }), flag("active", { label: "Active" })),
      ],
      samples: [{ name: "AMER Enterprise", region: "North America", target_amount: 500000, active: true }, { name: "EMEA Mid-market", region: "Europe", target_amount: 300000, active: true }],
    },
    {
      slug: "lead_sources", group: "Sales", singular: "Lead source", plural: "Lead sources", defaultSort: "name",
      fields: [
        ...half(
          text("name", { required: true }),
          select("channel", [ch("web", C.blue), ch("event", C.amber), ch("referral", C.purple), ch("outbound", C.teal), ch("paid_ads", C.red, "Paid ads"), ch("other", C.slate)], { default: "web" }),
        ),
      ],
      samples: [{ name: "Website form", channel: "web" }, { name: "SaaStr booth", channel: "event" }, { name: "Partner referral", channel: "referral" }],
    },
    {
      slug: "lost_reasons", group: "Sales", singular: "Lost reason", plural: "Lost reasons", defaultSort: "position",
      fields: [...half(text("name", { required: true }), position())],
      samples: [{ name: "Price too high", position: 1 }, { name: "Chose a competitor", position: 2 }, { name: "No budget this year", position: 3 }],
    },
    {
      slug: "pipelines", group: "Sales", singular: "Pipeline", plural: "Pipelines", defaultSort: "position",
      fields: [text("name", { required: true }), ...half(bool("is_default", { default: false, label: "Default" }), position())],
      samples: [{ name: "Sales", is_default: true, position: 1 }],
    },
    {
      slug: "pipeline_stages", group: "Sales", singular: "Stage", plural: "Stages", defaultSort: "position",
      fields: [
        ...half(rel("pipeline", "pipelines"), text("name", { required: true })),
        ...half(position("pipeline"), pct("probability", { default: 50, label: "Win probability (%)" })),
        ...half(
          bool("is_won", { default: false, label: "Won stage" }),
          bool("is_lost", { default: false, label: "Lost stage" }),
        ),
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
      fields: stacked(
        sec("Lead", [
          ...half(text("first_name", { label: "First name" }), text("last_name", { label: "Last name" })),
          ...half(email("email"), phone("phone")),
          ...half(text("company", { label: "Company (text)" }), text("title", { label: "Job title" })),
        ]),
        sec("Qualification", [
          ...half(
            select("status", [ch("new", C.blue), ch("working", C.amber), ch("qualified", C.green), ch("unqualified", C.gray)], { default: "new" }),
            select("rating", [ch("hot", C.red), ch("warm", C.amber), ch("cold", C.blue)], { default: "warm" }),
          ),
          int("score", { validation: { min: 0, max: 100 } }),
        ]),
        sec("Routing", [
          ...half(
            select("source", [ch("web", C.blue), ch("phone_inquiry", C.teal, "Phone inquiry"), ch("partner_referral", C.purple, "Partner referral"), ch("event", C.amber), ch("other", C.slate)], { default: "web" }),
            rel("lead_source", "lead_sources", { label: "Source (lookup)" }),
          ),
          rel("team", "sales_teams", { label: "Sales team" }),
        ]),
      ),
      samples: [{ first_name: "Alex", last_name: "Kim", email: "lead@example.com", company: "Initech", status: "new", rating: "warm", source: "web", lead_source: { ref: "lead_sources:0" }, team: { ref: "sales_teams:0" }, score: 35 }],
    },
    {
      slug: "deals", group: "Sales", singular: "Deal", plural: "Deals", ownerScoped: true, defaultSort: "-created_at",
      fields: stacked(
        sec("Deal", [
          text("name", { required: true }),
          ...half(moneyIn("amount"), select("currency", ["USD", "EUR", "GBP"], { default: "USD" })),
          ...half(
            select("deal_type", [ch("new_business", C.green, "New business"), ch("existing_business", C.blue, "Existing business")], { default: "new_business", label: "Deal type" }),
            date("expected_close_date", { indexed: true, label: "Expected close" }),
          ),
        ]),
        sec("Pipeline", [
          ...half(rel("pipeline", "pipelines"), rel("stage", "pipeline_stages")),
          pct("probability", { default: 50, label: "Probability (%)" }),
        ]),
        sec("Relations", [
          ...half(rel("company", "companies"), rel("primary_contact", "contacts", { label: "Primary contact" })),
          rel("team", "sales_teams", { label: "Sales team" }),
        ]),
        sec("Loss", [
          ...half(rel("loss_reason", "lost_reasons", { label: "Lost reason (lookup)" }), text("lost_reason", { label: "Lost reason (free text)" })),
        ], { folded: true }),
      ),
      samples: [{ name: "Acme — annual contract", amount: 24000, currency: "USD", pipeline: { ref: "pipelines:0" }, stage: { ref: "pipeline_stages:1" }, probability: 60, deal_type: "new_business", company: { ref: "companies:0" }, primary_contact: { ref: "contacts:0" }, team: { ref: "sales_teams:0" }, expected_close_date: ms("2026-08-01") }],
    },
    {
      slug: "products", group: "Catalog", singular: "Product", plural: "Products", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("sku", { unique: true, label: "SKU" })),
        ...half(money("unit_price", { label: "Unit price" }), flag("active", { label: "Active" })),
        notes("description"),
      ],
      samples: [
        { name: "Platform license (annual)", sku: "PLT-ANN", unit_price: 12000, active: true },
        { name: "Onboarding package", sku: "SVC-ONB", unit_price: 3000, active: true },
      ],
    },
    {
      // What the deal is actually made of (Salesforce OpportunityLineItem) —
      // without it, forecast amount is a number nobody can defend.
      slug: "deal_products", group: "Sales", singular: "Deal product", plural: "Deal products",
      fields: [
        hint("deal_products_total", "Line total is generated as quantity × unit price."),
        ...half(rel("deal", "deals"), rel("product", "products")),
        ...half(num("quantity", { default: 1, validation: { min: 0 } }), money("unit_price", { label: "Unit price" })),
        ...half(computedNum("line_total", "quantity * unit_price", { label: "Line total" }), notes("note")),
      ],
      samples: [{ deal: { ref: "deals:0" }, product: { ref: "products:0" }, quantity: 2, unit_price: 12000 }],
    },
    {
      slug: "quotes", group: "Sales", singular: "Quote", plural: "Quotes", defaultSort: "-created_at",
      fields: [
        ...half(text("number", { required: true, unique: true }), rel("deal", "deals")),
        ...half(
          select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("accepted", C.green), ch("declined", C.red), ch("expired", C.slate)], {
              default: "draft",
              ...flow(
                { draft: ["sent"], sent: ["accepted", "declined", "expired"] },
                { initial: ["draft"], labels: { sent: "Send", accepted: "Mark accepted", declined: "Mark declined" } },
              ),
            }),
          date("valid_until", { indexed: true, label: "Valid until" }),
        ),
        ...half(moneyIn("total"), select("currency", ["USD", "EUR", "GBP"], { default: "USD" })),
      ],
      samples: [{ number: "Q-2026-042", deal: { ref: "deals:0" }, status: "sent", currency: "USD", total: 24000, valid_until: ms("2026-07-31") }],
    },
    {
      slug: "quote_lines", group: "Sales", singular: "Quote line", plural: "Quote lines",
      fields: [
        hint("quote_lines_total", "Line total is generated as quantity × unit price — the discount is recorded for reporting, not applied here."),
        ...half(rel("quote", "quotes"), rel("product", "products")),
        ...half(num("quantity", { default: 1, validation: { min: 0 } }), money("unit_price", { label: "Unit price" })),
        ...half(pct("discount_pct", { default: 0, label: "Discount (%)" }), computedNum("line_total", "quantity * unit_price", { label: "Line total" })),
      ],
      samples: [
        { quote: { ref: "quotes:0" }, product: { ref: "products:0" }, quantity: 1, unit_price: 21000, discount_pct: 0 },
        { quote: { ref: "quotes:0" }, product: { ref: "products:1" }, quantity: 1, unit_price: 3000, discount_pct: 10 },
      ],
    },
    {
      // The signed agreement a won deal turns into (SuiteCRM AOS_Contracts) —
      // where renewal dates actually live.
      slug: "contracts", group: "Sales", singular: "Contract", plural: "Contracts", defaultSort: "-end_date",
      fields: stacked(
        sec("Contract", [
          ...half(text("number", { required: true, unique: true }), text("title")),
          ...half(rel("company", "companies"), rel("deal", "deals")),
          ...half(
            select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("signed", C.green), ch("active", C.green), ch("expired", C.slate), ch("terminated", C.red)], { default: "draft" }),
            money("value", { label: "Contract value" }),
          ),
        ]),
        sec("Term", [
          ...half(date("start_date", { range: { end: "end_date", bounds: "[]" }, label: "Start date" }), date("end_date", { indexed: true, label: "End date" })),
          ...half(bool("auto_renew", { default: false, label: "Auto-renew" }), int("notice_days", { label: "Notice period (days)" })),
          file("document", { label: "Signed document" }),
        ]),
      ),
      samples: [{ number: "CTR-2026-011", title: "Acme annual platform agreement", company: { ref: "companies:0" }, deal: { ref: "deals:0" }, status: "active", value: 24000, start_date: ms("2026-08-01"), end_date: ms("2027-07-31"), auto_renew: true, notice_days: 30 }],
    },
    {
      slug: "campaigns", group: "Marketing", singular: "Campaign", plural: "Campaigns", defaultSort: "-start_date",
      fields: stacked(
        sec("Campaign", [
          ...half(text("name", { required: true }), select("type", [ch("email", C.teal), ch("event", C.amber), ch("webinar", C.blue), ch("paid_ads", C.red, "Paid ads"), ch("content", C.purple), ch("other", C.slate)], { default: "email" })),
          ...half(
            select("status", [ch("planned", C.gray), ch("active", C.green), ch("completed", C.blue), ch("cancelled", C.red)], { default: "planned" }),
            rel("owner_team", "sales_teams", { label: "Owning team" }),
          ),
          notes("description"),
        ]),
        sec("Budget & results", [
          ...half(money("budget"), money("actual_cost", { label: "Actual cost" })),
          ...half(int("expected_leads", { label: "Expected leads" }), money("pipeline_generated", { label: "Pipeline generated" })),
          ...half(date("start_date", { range: { end: "end_date", bounds: "[]" }, indexed: true, label: "Start date" }), date("end_date", { label: "End date" })),
        ]),
      ),
      samples: [
        { name: "Q3 product webinar", type: "webinar", status: "active", owner_team: { ref: "sales_teams:0" }, budget: 8000, actual_cost: 6200, expected_leads: 150, pipeline_generated: 96000, start_date: ms("2026-07-01"), end_date: ms("2026-09-30") },
        { name: "Manufacturing newsletter", type: "email", status: "completed", budget: 1500, actual_cost: 1500, expected_leads: 60, start_date: ms("2026-04-01"), end_date: ms("2026-06-30") },
      ],
    },
    {
      slug: "campaign_members", group: "Marketing", singular: "Campaign member", plural: "Campaign members",
      note: "Who a campaign touched, and what it produced.",
      fields: [
        ...half(rel("campaign", "campaigns"), rel("contact", "contacts")),
        ...half(rel("lead", "leads"), select("status", [ch("targeted", C.gray), ch("sent", C.blue), ch("opened", C.teal), ch("clicked", C.amber), ch("responded", C.green), ch("converted", C.purple), ch("bounced", C.red)], { default: "targeted" })),
        ts("responded_at", { label: "Responded at" }),
      ],
      samples: [
        { campaign: { ref: "campaigns:0" }, contact: { ref: "contacts:1" }, status: "responded", responded_at: ms("2026-07-08") },
        { campaign: { ref: "campaigns:1" }, contact: { ref: "contacts:0" }, status: "opened" },
      ],
    },
    {
      slug: "activities", group: "Engagement", singular: "Activity", plural: "Activities", ownerScoped: true, defaultSort: "-due_at",
      fields: stacked(
        sec("Activity", [
          ...half(
            select("type", [ch("call", C.blue), ch("email", C.teal), ch("meeting", C.purple), ch("note", C.gray), ch("task", C.amber)], { default: "note" }),
            select("direction", [ch("inbound", C.green), ch("outbound", C.blue)], { label: "Direction" }),
          ),
          text("subject"),
          notes("body"),
        ]),
        sec("Linked to", [
          ...half(rel("contact", "contacts"), rel("company", "companies")),
          rel("deal", "deals"),
          ...half(ts("due_at", { indexed: true, label: "Due at" }), ts("completed_at", { label: "Completed at" })),
        ]),
      ),
      samples: [{ type: "call", subject: "Intro call", body: "Intro call with Jordan.", direction: "outbound", contact: { ref: "contacts:0" }, deal: { ref: "deals:0" }, due_at: ms("2026-07-05") }],
    },
    {
      slug: "notes", group: "Engagement", singular: "Note", plural: "Notes", ownerScoped: true, defaultSort: "-created_at",
      fields: [
        text("title"),
        notes("body", { required: true }),
        ...half(rel("company", "companies"), rel("contact", "contacts")),
        ...half(rel("deal", "deals"), bool("pinned", { default: false, label: "Pin to top" })),
      ],
      samples: [{ title: "Renewal risk", body: "Budget owner changed — re-qualify before the renewal conversation.", company: { ref: "companies:0" }, deal: { ref: "deals:0" }, pinned: true }],
    },
    {
      slug: "tasks", group: "Engagement", singular: "Task", plural: "Tasks", ownerScoped: true, defaultSort: "due_at",
      fields: [
        text("title", { required: true }),
        ...half(
          select("priority", [ch("low", C.gray), ch("normal", C.blue), ch("high", C.red)], { default: "normal" }),
          ts("due_at", { indexed: true }),
        ),
        bool("done", { default: false }),
      ],
      samples: [{ title: "Send proposal to Acme", priority: "high", done: false, due_at: ms("2026-07-02") }],
    },
    {
      slug: "sales_targets", group: "Sales", singular: "Sales target", plural: "Sales targets", defaultSort: "period",
      fields: [
        ...half(rel("team", "sales_teams"), text("rep", { label: "Rep (optional)" })),
        text("period", { required: true, indexed: true, label: "Period (YYYY-MM)" }),
        ...half(money("target_amount", { label: "Target amount" }), money("achieved_amount", { label: "Achieved amount" })),
      ],
      samples: [
        { team: { ref: "sales_teams:0" }, period: "2026-07", target_amount: 45000, achieved_amount: 24000 },
        { team: { ref: "sales_teams:1" }, rep: "Dana Fox", period: "2026-07", target_amount: 25000, achieved_amount: 9500 },
      ],
    },
  ],
  roles: [
    {
      name: "Sales manager",
      description: "Read the whole CRM; work leads, deals, quotes, tasks and targets across every rep.",
      permissions: [
        { collection: "companies", action: "read" },
        { collection: "contacts", action: "read" },
        { collection: "sales_teams", action: "read" },
        { collection: "lead_sources", action: "read" },
        { collection: "lost_reasons", action: "read" },
        { collection: "pipelines", action: "read" },
        { collection: "pipeline_stages", action: "read" },
        { collection: "leads", action: "read" },
        { collection: "leads", action: "update" },
        { collection: "deals", action: "read" },
        { collection: "deals", action: "update" },
        { collection: "products", action: "read" },
        { collection: "quotes", action: "read" },
        { collection: "quotes", action: "update" },
        { collection: "quote_lines", action: "read" },
        { collection: "quote_lines", action: "update" },
        { collection: "deal_products", action: "read" },
        { collection: "deal_products", action: "update" },
        { collection: "contracts", action: "read" },
        { collection: "contracts", action: "update" },
        { collection: "campaigns", action: "read" },
        { collection: "campaign_members", action: "read" },
        { collection: "activities", action: "read" },
        { collection: "notes", action: "read" },
        { collection: "notes", action: "create" },
        { collection: "tasks", action: "read" },
        { collection: "tasks", action: "update" },
        { collection: "sales_targets", action: "read" },
        { collection: "sales_targets", action: "update" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Sales overview",
      description: "Pipeline value, deal flow and campaign return.",
      panels: [
        { name: "Deals", kind: "items-aggregate", viz: "counter", config: { collection: "deals", agg: "count" } },
        { name: "Pipeline value", kind: "items-aggregate", viz: "counter", config: { collection: "deals", agg: "sum", field: "amount" } },
        { name: "Contacts", kind: "items-aggregate", viz: "counter", config: { collection: "contacts", agg: "count" } },
        { name: "Quoted value", kind: "items-aggregate", viz: "counter", config: { collection: "quotes", agg: "sum", field: "total" } },
        { name: "Deals by type", kind: "items-aggregate", viz: "donut", config: { collection: "deals", agg: "count", groupBy: "deal_type" } },
        { name: "Quotes by status", kind: "items-aggregate", viz: "donut", config: { collection: "quotes", agg: "count", groupBy: "status" } },
        { name: "Leads by status", kind: "items-aggregate", viz: "bars", config: { collection: "leads", agg: "count", groupBy: "status" } },
        { name: "Activities by type", kind: "items-aggregate", viz: "bars", config: { collection: "activities", agg: "count", groupBy: "type" } },
        { name: "Campaign members by status", kind: "items-aggregate", viz: "bars", config: { collection: "campaign_members", agg: "count", groupBy: "status" } },
      ],
    },
  ],
};
