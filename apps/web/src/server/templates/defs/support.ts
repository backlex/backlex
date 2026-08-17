import type { SchemaTemplate } from "../types";
import { C, bool, ch, email, flag, flow, half, host, int, ms, notes, phone, position, rating, rel, relMany, sec, select, slugField, stacked, tabbed, tags, text, ts, userLink, when } from "../dsl";

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
          flag("active", { label: "Active" }),
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
        ...half(bool("auto_reply", { default: true, label: "Send auto-reply" }), flag("active")),
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
        ...half(position("category"), flag("visible")),
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
          flag("active", { label: "Active" }),
        ]),
      ),
      samples: [
        { name: "Urgent unanswered 30m", priority: "urgent", position: 1, minutes_threshold: 30, escalate_to_team: { ref: "teams:0" }, escalate_to_agent: { ref: "agents:0" }, active: true },
        { name: "High unanswered 4h", priority: "high", position: 2, minutes_threshold: 240, escalate_to_team: { ref: "teams:0" }, active: true },
      ],
    },
    {
      slug: "problems", group: "Tickets", singular: "Problem", plural: "Problems", defaultSort: "-created_at",
      kanbanGroupBy: "status",
      fields: [
        ...half(
          text("title", { required: true }),
          select("status", [ch("investigating", C.amber), ch("identified", C.blue), ch("resolved", C.green)], { default: "investigating" }),
        ),
        notes("body", { label: "Details" }),
        notes("linked_tickets_note", { label: "Linked tickets note" }),
        ts("resolved_at", {
          label: "Resolved at",
          conditions: [
            when("status", "_eq", "resolved", "required"),
            when("status", "_neq", "resolved", "hidden"),
          ],
        }),
      ],
      samples: [{ title: "Password reset emails delayed", status: "identified", body: "Email provider incident; retry queue draining.", linked_tickets_note: "Link all reset-email tickets here for a bulk close on resolution." }],
    },
    {
      slug: "tickets", group: "Tickets", singular: "Ticket", plural: "Tickets", fts: true, defaultSort: "-created_at",
      kanbanGroupBy: "status",
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
          ...half(
            ts("first_replied_at", { label: "First replied at" }),
            // When it was solved is the figure every SLA report is built on, so a
            // ticket cannot reach a closed state without it.
            ts("solved_at", { label: "Solved at", conditions: [when("status", "_in", ["solved", "closed"], "required")] }),
          ),
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
        flag("active"),
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
        ...half(text("title"), flag("active")),
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
  /**
   * The rules a helpdesk runs on, already running.
   *
   * Deliberately absent: "this ticket has breached its SLA". The target lives on
   * the `slas` row the ticket points at (`first_reply_mins`), and a flow's
   * `data` is the ticket — it cannot read the policy to compare against. The
   * escalation below writes its threshold into the filter instead, matching the
   * seeded "Urgent unanswered 30m" rule, and an operator who edits that rule has
   * to edit this flow too. Said here because the alternative — a flow that
   * looked like it honoured the policy table and did not — is worse.
   *
   * Absent for a different reason: "a problem was resolved, so solve every
   * ticket linked to it". A `foreach` filter is compiled from the SAVED flow and
   * is never interpolated, so it cannot be narrowed to `{{ data.id }}` — the
   * loop would walk every ticket in the workspace. That one reports the fact and
   * leaves the sweep to the person holding the list.
   */
  flows: [
    {
      name: "Tell the queue when a ticket arrives",
      trigger: "event:items:tickets:created",
      operations: [
        {
          // One flow, two voices. Everything lands in the feed; an urgent one
          // says so in the title, because a queue notification that reads the
          // same for every ticket is a queue notification nobody reads.
          type: "condition",
          filter: { priority: { _eq: "urgent" } },
          then: [
            {
              type: "notification",
              title: "Urgent ticket: {{ data.subject }}",
              body: "Arrived via {{ data.channel }} as a {{ data.type }}. Assign it and reply before the urgent SLA runs out.",
              url: "/collections/tickets",
            },
          ],
          else: [
            {
              type: "notification",
              title: "New ticket: {{ data.subject }}",
              body: "{{ data.priority }} priority, {{ data.type }}, via {{ data.channel }}. Triage it and pick a team.",
              url: "/collections/tickets",
            },
          ],
        },
      ],
    },
    {
      name: "Chase an urgent ticket nobody has answered",
      // Hourly, and it repeats until somebody replies — which is what an
      // escalation is. `first_replied_at` is the thing that stops it, so it has
      // to be stamped on the first public reply or this never goes quiet.
      trigger: "cron:0 * * * *",
      operations: [
        {
          type: "foreach",
          collection: "tickets",
          // Thirty minutes is the seeded "Urgent unanswered 30m" escalation
          // rule, spelled out here because a flow cannot read that row.
          filter: {
            priority: { _eq: "urgent" },
            status: { _in: ["new", "open"] },
            first_replied_at: { _null: true },
            created_at: { _lt: { $now: { sub: { minutes: 30 } } } },
          },
          sort: "created_at",
          limit: 50,
          do: [
            {
              type: "notification",
              title: "Still unanswered: {{ $item.subject }}",
              body: "An urgent ticket has been waiting over half an hour with no reply. Take it or hand it to the escalation team.",
              url: "/collections/tickets",
            },
          ],
        },
      ],
    },
    {
      name: "Close a ticket that has been solved for three days",
      // Fires once per row, three days after `solved_at`, at 03:00 — and only
      // for tickets still sitting in `solved`, so one the requester reopened in
      // the meantime is left alone. `solved` → `closed` is an allowed
      // transition; every other status here is not, which is why the filter
      // matters as much as the offset.
      trigger: `schedule:${JSON.stringify({
        collection: "tickets",
        field: "solved_at",
        offset: { value: 3, unit: "days", direction: "after" },
        at: 180,
        timeZone: null,
        where: { status: { _eq: "solved" } },
      })}`,
      operations: [
        {
          type: "item.update",
          collection: "tickets",
          id: "{{ data.id }}",
          data: { status: "closed" },
        },
      ],
    },
    {
      name: "Say when a known issue is resolved",
      trigger: "event:items:problems:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "resolved" } },
          then: [
            {
              // Reports the fact rather than closing the tickets itself — see
              // the note above the list. The problem row's own note is carried
              // through because that is where the list of what to close lives.
              type: "notification",
              title: "Problem resolved: {{ data.title }}",
              body: "Work through the tickets linked to it and solve them. {{ data.linked_tickets_note }}",
              url: "/collections/tickets",
            },
          ],
        },
      ],
    },
    {
      name: "Acknowledge a new ticket to the person who raised it (needs email)",
      // Off until a transport is configured. The wording an operator maintains
      // lives in the `email_templates` collection — copy the `ticket_received`
      // row into the workspace's own email templates and point `templateKey` at
      // it, and this stops carrying its copy inline.
      active: false,
      trigger: "event:items:tickets:created",
      operations: [
        {
          type: "email",
          to: "{{ data.requester.email }}",
          subject: "We have your request: {{ data.subject }}",
          html:
            "<p>Thanks for getting in touch — your request is logged and an agent " +
            "will reply within the target for its priority.</p>" +
            "<p><strong>{{ data.subject }}</strong><br>{{ data.description }}</p>" +
            "<p>Reply to this message to add anything else.</p>",
        },
      ],
    },
    {
      name: "Weekly helpdesk report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 7 * * 1",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Helpdesk overview",
          subject: "Helpdesk — last week",
        },
      ],
    },
  ],
  documents: [
    {
      key: "ticket_summary",
      name: "Ticket record",
      description: "One ticket as a printable record — what was asked, who handled it, how it ended.",
      filename: "ticket-{{ data.id }}",
      variables: ["subject", "status", "priority"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:21px;margin:0 0 4px}" +
        "h2{font-size:14px;margin:20px 0 6px;text-transform:uppercase;letter-spacing:.04em;color:#555}" +
        ".muted{color:#666}" +
        "table.meta{width:100%;border-collapse:collapse;margin-top:14px}" +
        "table.meta td{padding:4px 6px;border-bottom:1px solid #eee;vertical-align:top}" +
        "table.meta td.k{width:32%;color:#666}" +
        ".body{white-space:pre-wrap;margin-top:6px}" +
        "</style></head><body>" +
        "<h1>{{ data.subject }}</h1>" +
        '<p class="muted">{{ data.status }} · {{ data.priority }} priority · ' +
        "{{ data.type }} · arrived via {{ data.channel }}</p>" +
        '<table class="meta">' +
        '<tr><td class="k">Requester</td><td>{{ data.requester.name }} ' +
        "&lt;{{ data.requester.email }}&gt;</td></tr>" +
        '<tr><td class="k">Organization</td><td>{{ data.organization.name }}</td></tr>' +
        '<tr><td class="k">Assignee</td><td>{{ data.assignee.name }}</td></tr>' +
        '<tr><td class="k">Team</td><td>{{ data.team.name }}</td></tr>' +
        '<tr><td class="k">Category</td><td>{{ data.category.name }}</td></tr>' +
        '<tr><td class="k">SLA policy</td><td>{{ data.sla.name }}</td></tr>' +
        '<tr><td class="k">First replied</td><td>{{ data.first_replied_at }}</td></tr>' +
        '<tr><td class="k">Solved</td><td>{{ data.solved_at }}</td></tr>' +
        '<tr><td class="k">Satisfaction</td><td>{{ data.satisfaction }}</td></tr>' +
        "</table>" +
        "<h2>What was asked</h2>" +
        '<div class="body">{{ data.description }}</div>' +
        "<h2>Conversation</h2>" +
        "<!-- one block per public message; fill from your own query or a foreach -->" +
        '<p class="muted">Internal notes are deliberately not printed here — this ' +
        "record is the one a requester may be sent.</p>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "problem_report",
      name: "Known-issue report",
      description: "The write-up of one problem — what broke, where it stands, what it affected.",
      filename: "known-issue-{{ data.id }}",
      variables: ["title", "status"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 4px}" +
        "h2{font-size:13px;margin:18px 0 4px;text-transform:uppercase;letter-spacing:.04em;color:#555}" +
        ".muted{color:#666}" +
        ".body{white-space:pre-wrap}" +
        "</style></head><body>" +
        "<h1>{{ data.title }}</h1>" +
        '<p class="muted">Status: {{ data.status }} · Resolved {{ data.resolved_at }}</p>' +
        "<h2>Details</h2>" +
        '<div class="body">{{ data.body }}</div>' +
        "<h2>Affected tickets</h2>" +
        '<div class="body">{{ data.linked_tickets_note }}</div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      name: "Submit a support request",
      collection: "tickets",
      settings: {
        submitLabel: "Send request",
        successMessage: "Thanks — it's logged and an agent will reply.",
      },
      // `type` is deliberately not exposed: question / incident / problem / task
      // is agent vocabulary for routing, and a requester picking "problem"
      // means something else by it than the queue does.
      fields: [
        { name: "subject", label: "What do you need help with?" },
        { name: "description", label: "Tell us what happened", help: "What you tried, and what you saw instead." },
        { name: "priority", help: "Pick urgent only when work is stopped." },
      ],
    },
    {
      name: "Tell us how we did",
      collection: "csat_ratings",
      settings: {
        submitLabel: "Send rating",
        successMessage: "Thank you — every rating is read.",
      },
      // A relation is never form-eligible, so a rating arrives unlinked and an
      // agent attaches it to its ticket. That is on purpose rather than a gap:
      // the link is the one thing a public respondent must not be able to pick.
      fields: [
        { name: "rating", label: "How was the support you got?" },
        { name: "comment", label: "Anything you want to add?" },
      ],
    },
  ],
  agents: [
    {
      name: "Support analyst",
      handle: "support-analyst",
      description: "Answers questions about the queue, the backlog and how it is being handled.",
      systemPrompt:
        "You help a support team read its own queue. Answer questions about " +
        "tickets, problems and satisfaction using the workspace's own data. " +
        "Status, priority and type are three separate axes: urgent says nothing " +
        "about whether a ticket is still open, and problem is a ticket type " +
        "rather than a status — never collapse them into one. A ticket is " +
        "waiting until first_replied_at is set, and open until its status is " +
        "solved or closed. Rank a backlog by how long a ticket has been waiting, " +
        "not by priority alone. Satisfaction is an average over the few " +
        "requesters who answered, so always give the number of responses beside " +
        "it. Be brief and specific, and say plainly when the data does not " +
        "answer the question.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "collections.search", "kpis.run"],
      maxSteps: 8,
    },
  ],
  /**
   * One channel, for the thing a helpdesk screen is always waiting on: whether
   * anything has happened on the ticket in front of you. `{ticket}` is a
   * capture, so a subscriber names the ticket it cares about rather than every
   * agent receiving every ticket's traffic.
   *
   * **Both sides are held to the people who work the queue, and subscribing is
   * NOT opened to `authenticated`** — which is the tempting version, because a
   * requester watching their own ticket move is exactly what a portal wants.
   * It cannot be written safely here: a channel condition compares the
   * pattern's CAPTURES against `$user.*` / `$org.*` / `$tenant.id`, and
   * "this ticket is yours" is a fact about a ROW, which it cannot look up. So
   * `authenticated` would mean any signed-in end user could subscribe to any
   * ticket's feed by naming its id. A customer-facing version needs the
   * requester's own id IN the pattern (`support:{requester}:tickets`) so the
   * condition has something to compare — a different channel, and a modelling
   * decision a workspace should make deliberately rather than inherit.
   */
  channels: [
    {
      name: "Ticket activity",
      pattern: "support:{ticket}:activity",
      subscribe: { access: "roles", roles: ["admin", "Support agent"] },
      publish: { access: "roles", roles: ["admin", "Support agent"] },
      presence: true,
      retentionHours: 24,
    },
  ],
};
