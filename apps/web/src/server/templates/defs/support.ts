import type { SchemaTemplate } from "../types";
import { C, bool, ch, email, flow, half, host, int, ms, notes, phone, position, rating, rel, relMany, sec, select, slugField, stacked, tabbed, tags, text, ts, userLink } from "../dsl";

export const support: SchemaTemplate = {
  id: "support",
  label: "Support / Helpdesk",
  groups: ["Tickets", "People", "Knowledge base", "Configuration"],
  description:
    "Zendesk-grade helpdesk: organizations, customers, agents and teams, inbound channels with business hours, tickets across separate status/priority/type axes, SLA policies and escalation rules, managed ticket tags, known-issue problems linked to tickets, threaded messages with public/internal notes, CSAT ratings, a category → section → article knowledge base, canned responses and email templates.",
  collections: [
    {
      slug: "organizations", group: "People", singular: "Organization", plural: "Organizations", defaultSort: "name",
      fields: [...half(text("name", { required: true }), host("domain")), notes("notes")],
      samples: [{ name: "Acme Inc", domain: "acme.example" }],
    },
    {
      slug: "customers", group: "People", singular: "Customer", plural: "Customers", defaultSort: "name",
      fields: [
        ...half(text("name"), email("email", { required: true, unique: true })),
        ...half(phone("phone"), rel("organization", "organizations")),
        userLink(),
      ],
      samples: [{ email: "jordan@example.com", name: "Jordan Reed", organization: { ref: "organizations:0" } }, { email: "sam@example.com", name: "Sam Taylor", organization: { ref: "organizations:0" } }],
    },
    {
      slug: "agents", group: "People", singular: "Agent", plural: "Agents", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), email("email", { unique: true })),
        ...half(
          select("role", [ch("agent", C.blue), ch("admin", C.purple)], { default: "agent" }),
          bool("active", { default: true, label: "Active" }),
        ),
      ],
      samples: [{ name: "Robin Park", email: "robin@support.example", role: "agent" }],
    },
    {
      slug: "teams", group: "People", singular: "Team", plural: "Teams", defaultSort: "name",
      fields: [text("name", { required: true }), notes("description")],
      samples: [{ name: "Tier 1" }, { name: "Billing" }],
    },
    {
      // Where tickets come in from (Chatwoot inbox / Zendesk support address).
      slug: "channels", group: "Configuration", singular: "Channel", plural: "Channels", defaultSort: "name",
      fields: [
        ...half(
          text("name", { required: true }),
          select("kind", [ch("email", C.blue), ch("web_widget", C.teal, "Web widget"), ch("chat", C.purple), ch("phone", C.amber), ch("api", C.gray)], { default: "email" }),
        ),
        ...half(email("inbound_address", { label: "Inbound address" }), rel("default_team", "teams", { label: "Routes to team" })),
        ...half(bool("auto_reply", { default: true, label: "Send auto-reply" }), bool("active", { default: true })),
      ],
      samples: [
        { name: "support@ inbox", kind: "email", inbound_address: "support@example.com", default_team: { ref: "teams:0" }, auto_reply: true, active: true },
        { name: "Website widget", kind: "web_widget", default_team: { ref: "teams:0" }, auto_reply: false, active: true },
      ],
    },
    {
      // The clock SLAs are measured against (Zendesk schedule / Chatwoot working hours).
      slug: "business_hours", group: "Configuration", singular: "Business hours", plural: "Business hours", defaultSort: "weekday",
      fields: [
        ...half(
          select("weekday", ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], { default: "monday" }),
          text("timezone", { label: "Time zone", description: "IANA name, e.g. Europe/Istanbul." }),
        ),
        ...half(text("opens_at", { label: "Opens (HH:MM)" }), text("closes_at", { label: "Closes (HH:MM)" })),
        bool("closed", { default: false, label: "Closed all day" }),
      ],
      samples: [
        { weekday: "monday", timezone: "Europe/Istanbul", opens_at: "09:00", closes_at: "18:00", closed: false },
        { weekday: "saturday", timezone: "Europe/Istanbul", closed: true },
      ],
    },
    {
      slug: "categories", group: "Knowledge base", singular: "Category", plural: "Categories", defaultSort: "position",
      fields: [...half(text("name", { required: true }), position()), notes("description")],
      samples: [{ name: "Billing", position: 1 }, { name: "Technical", position: 2 }],
    },
    {
      // Zendesk's help centre is category → section → article; without the
      // middle level a real knowledge base flattens into an unusable list.
      slug: "kb_sections", group: "Knowledge base", singular: "Section", plural: "Sections", defaultSort: "position",
      fields: [
        ...half(rel("category", "categories", { required: true }), text("name", { required: true })),
        ...half(position("category"), bool("visible", { default: true })),
        notes("description"),
      ],
      samples: [
        { category: { ref: "categories:0" }, name: "Invoices & receipts", position: 1, visible: true },
        { category: { ref: "categories:1" }, name: "Login & access", position: 1, visible: true },
      ],
    },
    {
      slug: "ticket_tags", group: "Tickets", singular: "Ticket tag", plural: "Ticket tags", defaultSort: "name",
      fields: [text("name", { required: true, unique: true }), notes("description")],
      samples: [{ name: "billing" }, { name: "login" }, { name: "bug" }],
    },
    {
      slug: "slas", group: "Tickets", singular: "SLA policy", plural: "SLA policies", defaultSort: "position",
      fields: stacked(
        sec("Policy", [
          ...half(text("name", { required: true }), position()),
          select("priority", [ch("low", C.gray), ch("normal", C.blue), ch("high", C.amber), ch("urgent", C.red)], { default: "normal", label: "Applies to priority" }),
          notes("description"),
        ]),
        sec("Targets", [
          ...half(
            int("first_reply_mins", { label: "First reply (min)", validation: { min: 0 } }),
            int("resolution_mins", { label: "Resolution (min)", validation: { min: 0 } }),
          ),
          bool("business_hours", { default: true, label: "Business hours only", description: "Pauses the clock outside the hours configured under Business hours." }),
        ]),
      ),
      samples: [
        { name: "Urgent", priority: "urgent", position: 1, first_reply_mins: 30, resolution_mins: 240 },
        { name: "Standard", priority: "normal", position: 2, first_reply_mins: 240, resolution_mins: 1440 },
      ],
    },
    {
      slug: "escalation_rules", group: "Tickets", singular: "Escalation rule", plural: "Escalation rules", defaultSort: "position",
      fields: stacked(
        sec("Rule", [
          ...half(text("name", { required: true }), position()),
          ...half(
            select("priority", [ch("low", C.gray), ch("normal", C.blue), ch("high", C.amber), ch("urgent", C.red)], { default: "high", label: "Triggers on priority" }),
            int("minutes_threshold", { validation: { min: 0 }, label: "Escalate after (min)" }),
          ),
        ]),
        sec("Escalates to", [
          ...half(rel("escalate_to_team", "teams", { label: "Team" }), rel("escalate_to_agent", "agents", { label: "Agent" })),
          bool("active", { default: true, label: "Active" }),
        ]),
      ),
      samples: [
        { name: "Urgent unanswered 30m", priority: "urgent", position: 1, minutes_threshold: 30, escalate_to_team: { ref: "teams:0" }, escalate_to_agent: { ref: "agents:0" }, active: true },
        { name: "High unanswered 4h", priority: "high", position: 2, minutes_threshold: 240, escalate_to_team: { ref: "teams:0" }, active: true },
      ],
    },
    {
      slug: "problems", group: "Tickets", singular: "Problem", plural: "Problems", defaultSort: "-created_at",
      fields: [
        ...half(
          text("title", { required: true }),
          select("status", [ch("investigating", C.amber), ch("identified", C.blue), ch("resolved", C.green)], { default: "investigating" }),
        ),
        notes("body", { label: "Details" }),
        notes("linked_tickets_note", { label: "Linked tickets note" }),
        ts("resolved_at", { label: "Resolved at" }),
      ],
      samples: [{ title: "Password reset emails delayed", status: "identified", body: "Email provider incident; retry queue draining.", linked_tickets_note: "Link all reset-email tickets here for a bulk close on resolution." }],
    },
    {
      slug: "tickets", group: "Tickets", singular: "Ticket", plural: "Tickets", fts: true, defaultSort: "-created_at",
      fields: tabbed(
        sec("Ticket", [
          text("subject", { required: true, searchable: true }),
          { name: "description", type: "longtext", interface: "textarea", searchable: true },
          ...half(
            select("status", [ch("new", C.purple), ch("open", C.blue), ch("pending", C.amber), ch("hold", C.slate), ch("solved", C.green), ch("closed", C.gray)], {
              default: "new",
              ...flow(
                {
                  new: ["open", "solved"],
                  open: ["pending", "hold", "solved"],
                  pending: ["open", "hold", "solved"],
                  hold: ["open", "pending", "solved"],
                  solved: ["open", "closed"],
                },
                { initial: ["new"], labels: { solved: "Solve", closed: "Close", open: "Reopen" } },
              ),
            }),
            select("priority", [ch("low", C.gray), ch("normal", C.blue), ch("high", C.amber), ch("urgent", C.red)], { default: "normal" }),
          ),
          ...half(
            select("type", [ch("question", C.blue), ch("incident", C.amber), ch("problem", C.red), ch("task", C.teal)], { default: "question" }),
            select("channel", [ch("email", C.blue), ch("web", C.teal), ch("chat", C.purple), ch("phone", C.amber), ch("api", C.gray)], { default: "email" }),
          ),
          rel("inbox", "channels", { label: "Arrived through" }),
        ]),
        sec("Assignment", [
          ...half(rel("requester", "customers"), rel("organization", "organizations")),
          ...half(rel("assignee", "agents"), rel("team", "teams")),
          ...half(rel("category", "categories"), rel("sla", "slas", { label: "SLA policy" })),
        ]),
        sec("Meta", [
          ...half(rel("problem", "problems", { label: "Linked problem" }), select("satisfaction", [ch("offered", C.gray), ch("good", C.green), ch("bad", C.red)], { default: "offered" })),
          tags("tags"),
          relMany("managed_tags", "ticket_tags", { label: "Tags (managed)" }),
          ...half(ts("first_replied_at", { label: "First replied at" }), ts("solved_at", { label: "Solved at" })),
        ]),
      ),
      samples: [
        { subject: "Cannot reset my password", description: "I keep getting an error.", status: "open", priority: "high", type: "incident", channel: "email", inbox: { ref: "channels:0" }, requester: { ref: "customers:0" }, assignee: { ref: "agents:0" }, team: { ref: "teams:0" }, category: { ref: "categories:1" }, sla: { ref: "slas:0" }, problem: { ref: "problems:0" } },
        { subject: "Invoice question", description: "Where can I download my invoice?", status: "pending", priority: "normal", type: "question", channel: "web", inbox: { ref: "channels:1" }, requester: { ref: "customers:1" }, team: { ref: "teams:1" }, category: { ref: "categories:0" } },
      ],
    },
    {
      slug: "ticket_messages", group: "Tickets", singular: "Message", plural: "Messages", defaultSort: "created_at",
      fields: [
        ...half(rel("ticket", "tickets"), rel("agent", "agents")),
        notes("body"),
        bool("public", { default: true, label: "Public reply", description: "Off means an internal note the requester never sees." }),
      ],
      samples: [{ ticket: { ref: "tickets:0" }, agent: { ref: "agents:0" }, body: "Thanks for reaching out — taking a look now.", public: true }],
    },
    {
      slug: "csat_ratings", group: "Tickets", singular: "CSAT rating", plural: "CSAT ratings", defaultSort: "-submitted_at",
      fields: [
        ...half(rel("ticket", "tickets"), rating("rating")),
        notes("comment"),
        ts("submitted_at", { indexed: true, label: "Submitted at" }),
      ],
      samples: [{ ticket: { ref: "tickets:1" }, rating: 5, comment: "Quick and clear answer, thanks!", submitted_at: ms("2026-07-03T16:20:00Z") }],
    },
    {
      slug: "email_templates", group: "Configuration", singular: "Email template", plural: "Email templates", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("key", { unique: true, label: "Key", description: "Referenced by automations, e.g. ticket_received." })),
        text("subject"),
        notes("body"),
        bool("active", { default: true }),
      ],
      samples: [
        { name: "Ticket received", key: "ticket_received", subject: "We got your message ({{ticket.number}})", body: "Thanks — an agent will reply within the SLA for your plan.", active: true },
        { name: "Ticket solved", key: "ticket_solved", subject: "Your request is solved", body: "We've marked this solved. Reply to reopen it.", active: true },
      ],
    },
    {
      slug: "kb_articles", group: "Knowledge base", singular: "Article", plural: "Articles", versioned: true, vectorize: true, fts: true, defaultSort: "title",
      fields: stacked(
        sec("Article", [
          ...half(text("title", { required: true, vectorize: true, searchable: true }), slugField("title")),
          { name: "body", type: "longtext", interface: "richtext", vectorize: true, searchable: true },
        ]),
        sec("Placement", [
          ...half(rel("category", "categories"), rel("section", "kb_sections")),
          ...half(rel("author", "agents"), bool("promoted", { default: false, label: "Promoted" })),
        ]),
      ),
      samples: [{ title: "How to reset your password", slug: "reset-password", body: "Go to Settings → Security and click Reset.", category: { ref: "categories:1" }, section: { ref: "kb_sections:1" }, author: { ref: "agents:0" } }],
    },
    {
      slug: "canned_responses", group: "Tickets", singular: "Canned response", plural: "Canned responses", defaultSort: "title",
      fields: [
        ...half(text("title"), bool("active", { default: true })),
        notes("body"),
        tags("tags"),
      ],
      samples: [{ title: "Greeting", body: "Hi there! Thanks for contacting support." }, { title: "Password reset steps", body: "Go to Settings → Security and click Reset. Let us know if the email doesn't arrive within 5 minutes." }],
    },
  ],
  roles: [
    {
      name: "Support agent",
      description: "Work tickets end-to-end; read people, policies, problems and the knowledge base.",
      permissions: [
        { collection: "organizations", action: "read" },
        { collection: "customers", action: "read" },
        { collection: "customers", action: "create" },
        { collection: "agents", action: "read" },
        { collection: "teams", action: "read" },
        { collection: "categories", action: "read" },
        { collection: "ticket_tags", action: "read" },
        { collection: "slas", action: "read" },
        { collection: "escalation_rules", action: "read" },
        { collection: "problems", action: "read" },
        { collection: "problems", action: "update" },
        { collection: "tickets", action: "read" },
        { collection: "tickets", action: "create" },
        { collection: "tickets", action: "update" },
        { collection: "ticket_messages", action: "read" },
        { collection: "ticket_messages", action: "create" },
        { collection: "csat_ratings", action: "read" },
        { collection: "kb_sections", action: "read" },
        { collection: "kb_articles", action: "read" },
        { collection: "canned_responses", action: "read" },
        { collection: "email_templates", action: "read" },
        { collection: "channels", action: "read" },
        { collection: "business_hours", action: "read" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Helpdesk overview",
      description: "Ticket volume, queue health and satisfaction.",
      panels: [
        { name: "Tickets", kind: "items-aggregate", viz: "counter", config: { collection: "tickets", agg: "count" } },
        { name: "CSAT responses", kind: "items-aggregate", viz: "counter", config: { collection: "csat_ratings", agg: "count" } },
        { name: "Open problems", kind: "items-aggregate", viz: "counter", config: { collection: "problems", agg: "count" } },
        { name: "Tickets by status", kind: "items-aggregate", viz: "donut", config: { collection: "tickets", agg: "count", groupBy: "status" } },
        { name: "Tickets by priority", kind: "items-aggregate", viz: "bars", config: { collection: "tickets", agg: "count", groupBy: "priority" } },
        { name: "Tickets by channel", kind: "items-aggregate", viz: "bars", config: { collection: "tickets", agg: "count", groupBy: "channel" } },
        { name: "Tickets by type", kind: "items-aggregate", viz: "donut", config: { collection: "tickets", agg: "count", groupBy: "type" } },
      ],
    },
  ],
};
