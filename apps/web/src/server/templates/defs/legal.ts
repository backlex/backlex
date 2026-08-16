import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, email, file, flag, half, hint, money, ms, notes, num, phone, rel, rollup, sec, select, seq, stacked, tabbed, text, ts, userLink, when } from "../dsl";

export const legal: SchemaTemplate = {
  id: "legal",
  label: "Legal practice",
  groups: ["Matters", "People", "Billing"],
  description:
    "Odoo Law-Firm-grade practice management: clients, matters with practice area and billing type, attorneys, billable time entries, hearings & deadlines, case documents and matter invoices — plus opposing parties & conflict checks, retainer trust accounting, disbursements and matter task lists.",
  collections: [
    {
      slug: "attorneys", group: "People", singular: "Attorney", plural: "Attorneys", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), email("email")),
        ...half(text("bar_number", { label: "Bar no." }), money("hourly_rate", { label: "Default hourly rate" })),
        flag("active", { label: "Active" }),
      ],
      samples: [{ name: "Elena Vasquez", email: "elena@firm.example", bar_number: "NY-448211", hourly_rate: 350, active: true }, { name: "David Osei", email: "david@firm.example", bar_number: "NY-501992", hourly_rate: 275, active: true }],
    },
    {
      slug: "clients", group: "People", singular: "Client", plural: "Clients", fts: true, defaultSort: "name",
      portalLink: { emailField: "email", role: "Client (portal)" },
      fields: stacked(
        sec("Client", [
          ...half(text("name", { required: true, searchable: true }), text("company")),
          ...half(email("email"), phone("phone")),
          text("address"),
        ]),
        sec("Internal", [notes("notes"), userLink()], { folded: true }),
      ),
      samples: [{ name: "Meridian Holdings LLC", email: "legal@meridian.example", company: "Meridian Holdings", phone: "+15555550122" }],
    },
    {
      slug: "matters", group: "Matters", singular: "Matter", plural: "Matters", fts: true, defaultSort: "-opened_at",
      // Auto-detect would pick `practice_area` — what a matter IS rather than
      // where it stands.
      kanbanGroupBy: "status",
      fields: tabbed(
        sec("Matter", [
          ...half(seq("number", "M-{YYYY}-{###}"), text("title", { required: true, searchable: true })),
          ...half(rel("client", "clients"), rel("lead_attorney", "attorneys", { label: "Lead attorney" })),
          notes("summary", { searchable: true }),
        ]),
        sec("Status", [
          ...half(
            select("practice_area", [ch("corporate", C.blue), ch("litigation", C.red), ch("real_estate", C.teal, "Real estate"), ch("ip", C.purple, "IP"), ch("family", C.amber), ch("criminal", C.slate), ch("other", C.gray)], { default: "corporate", label: "Practice area" }),
            select("status", [ch("intake", C.gray), ch("active", C.green), ch("on_hold", C.amber, "On hold"), ch("closed", C.slate)], { default: "intake" }),
          ),
          ...half(
            select("billing_type", [ch("hourly", C.blue), ch("fixed", C.teal, "Fixed fee"), ch("contingency", C.purple)], { default: "hourly", label: "Billing" }),
            // The textbook conditional field: a fixed-fee matter with no fee
            // agreed is the argument you have with the client at the end.
            money("fixed_fee", {
              label: "Fixed fee",
              conditions: [when("billing_type", "_eq", "fixed", "required")],
            }),
          ),
        ]),
        sec("Dates", [
          ...half(
            date("opened_at", { indexed: true, label: "Opened" }),
            date("closed_at", {
              label: "Closed",
              conditions: [when("status", "_eq", "closed", "required")],
            }),
          ),
          // Two the server keeps. Billable hours filtered to `billable` on
          // purpose: writing off an entry should take it out of the number
          // the matter is judged on, not just off the invoice.
          ...half(
            rollup(
              "billable_hours",
              { from: "time_entries", via: "matter", fn: "sum", field: "hours", filter: { billable: { _eq: true } } },
              { label: "Billable hours", description: "Totalled from billable time entries on this matter." },
            ),
            rollup(
              "open_tasks",
              { from: "matter_tasks", via: "matter", fn: "count", filter: { status: { _neq: "done" } } },
              { label: "Open tasks" },
            ),
          ),
        ]),
      ),
      samples: [
        { title: "Meridian — Series B financing", client: { ref: "clients:0" }, lead_attorney: { ref: "attorneys:0" }, practice_area: "corporate", status: "active", billing_type: "hourly", opened_at: ms("2026-05-12"), summary: "Term sheet review and closing docs." },
        { title: "Meridian — office lease dispute", client: { ref: "clients:0" }, lead_attorney: { ref: "attorneys:1" }, practice_area: "litigation", status: "intake", billing_type: "fixed", fixed_fee: 7500, opened_at: ms("2026-07-01") },
      ],
    },
    {
      slug: "parties", group: "Matters", singular: "Party", plural: "Parties", fts: true, defaultSort: "name",
      fields: [
        ...half(rel("matter", "matters"), text("name", { required: true, searchable: true })),
        ...half(
          select("role", [ch("opposing_party", C.red, "Opposing party"), ch("opposing_counsel", C.amber, "Opposing counsel"), ch("witness", C.blue), ch("expert", C.purple), ch("co_counsel", C.teal, "Co-counsel")], { default: "opposing_party" }),
          text("contact", { label: "Contact info" }),
        ),
        notes("notes"),
      ],
      samples: [
        { matter: { ref: "matters:1" }, name: "Harborview Properties LP", role: "opposing_party", contact: "c/o registered agent, Albany NY" },
        { matter: { ref: "matters:1" }, name: "Sandra Liu, Esq. (Liu & Park)", role: "opposing_counsel", contact: "sliu@liupark.example" },
      ],
    },
    {
      slug: "conflict_checks", group: "Matters", singular: "Conflict check", plural: "Conflict checks", defaultSort: "-checked_at", displayTemplate: "{{party_name}}",
      fields: [
        ...half(rel("matter", "matters"), text("party_name", { required: true, label: "Party searched" })),
        ...half(
          select("result", [ch("clear", C.green), ch("flagged", C.red)], { default: "clear" }),
          ts("checked_at", { required: true, indexed: true, label: "Checked at" }),
        ),
        ...half(
          text("checked_by", { label: "Checked by" }),
          // A flagged conflict with no note is a finding nobody can act on,
          // and this is the record the firm relies on if it is ever asked.
          notes("notes", {
            conditions: [when("result", "_eq", "flagged", "required")],
          }),
        ),
      ],
      samples: [
        { matter: { ref: "matters:1" }, party_name: "Harborview Properties LP", result: "clear", checked_at: ms("2026-07-01T15:30:00Z"), checked_by: "David Osei", notes: "No prior representation found in client index." },
      ],
    },
    {
      slug: "matter_tasks", group: "Matters", singular: "Task", plural: "Matter tasks", defaultSort: "due_on",
      // Auto-detect would pick `priority`, which is how urgent a task is, not
      // whether anybody has started it.
      kanbanGroupBy: "status",
      fields: [
        ...half(rel("matter", "matters"), text("title", { required: true })),
        ...half(rel("assignee", "attorneys", { label: "Assignee" }), date("due_on", { indexed: true, label: "Due" })),
        ...half(
          select("priority", [ch("low", C.gray), ch("normal", C.blue), ch("high", C.amber), ch("urgent", C.red)], { default: "normal" }),
          select("status", [ch("todo", C.gray, "To do"), ch("doing", C.blue, "In progress"), ch("done", C.green)], { default: "todo" }),
        ),
      ],
      samples: [
        { matter: { ref: "matters:0" }, title: "Circulate closing checklist to investors", assignee: { ref: "attorneys:0" }, due_on: ms("2026-07-18"), priority: "high", status: "doing" },
        { matter: { ref: "matters:1" }, title: "Draft engagement letter", assignee: { ref: "attorneys:1" }, due_on: ms("2026-07-15"), priority: "normal", status: "todo" },
      ],
    },
    {
      slug: "time_entries", group: "Billing", singular: "Time entry", plural: "Time entries", defaultSort: "-worked_on",
      fields: [
        hint("time_entry_amount", "Amount is generated as hours × rate — the rate defaults from the attorney but can be overridden per entry."),
        ...half(rel("matter", "matters"), rel("attorney", "attorneys")),
        ...half(date("worked_on", { indexed: true, label: "Date" }), num("hours", { validation: { min: 0 } })),
        ...half(money("rate"), computedNum("amount", "hours * rate")),
        ...half(bool("billable", { default: true, label: "Billable" }), notes("description")),
      ],
      samples: [
        { matter: { ref: "matters:0" }, attorney: { ref: "attorneys:0" }, worked_on: ms("2026-07-08"), hours: 3.5, rate: 350, billable: true, description: "Reviewed investor rights agreement." },
        { matter: { ref: "matters:0" }, attorney: { ref: "attorneys:1" }, worked_on: ms("2026-07-09"), hours: 2, rate: 275, billable: true, description: "Drafted board consent." },
      ],
    },
    {
      slug: "key_dates", group: "Matters", singular: "Key date", plural: "Hearings & deadlines", defaultSort: "due_at",
      // Auto-detect would pick `kind` — a hearing and a filing deadline are
      // both things that are either upcoming, done or missed.
      kanbanGroupBy: "status",
      fields: [
        ...half(rel("matter", "matters"), text("title", { required: true })),
        ...half(
          select("kind", [ch("hearing", C.red), ch("filing_deadline", C.amber, "Filing deadline"), ch("meeting", C.blue), ch("statute_limitation", C.purple, "Statute of limitations"), ch("other", C.gray)], { default: "meeting" }),
          ts("due_at", { required: true, indexed: true, label: "Due" }),
        ),
        select("status", [ch("upcoming", C.blue), ch("done", C.green), ch("missed", C.red)], { default: "upcoming" }),
        notes("notes"),
      ],
      samples: [{ matter: { ref: "matters:0" }, title: "Closing call with investors", kind: "meeting", due_at: ms("2026-07-22T14:00:00Z"), status: "upcoming" }],
    },
    {
      slug: "documents", group: "Matters", singular: "Document", plural: "Documents", defaultSort: "-uploaded_at",
      fields: [
        ...half(rel("matter", "matters"), text("title", { required: true })),
        ...half(
          select("doc_type", [ch("contract", C.blue), ch("pleading", C.red), ch("evidence", C.amber), ch("correspondence", C.teal), ch("other", C.gray)], { default: "other", label: "Type" }),
          ts("uploaded_at", { indexed: true, label: "Uploaded at" }),
        ),
        file("file"),
      ],
      samples: [{ matter: { ref: "matters:0" }, title: "Series B term sheet (v4)", doc_type: "contract", uploaded_at: ms("2026-06-30T16:00:00Z") }],
    },
    {
      slug: "retainers", group: "Billing", singular: "Retainer", plural: "Retainers", defaultSort: "-received_at",
      fields: [
        ...half(rel("client", "clients"), rel("matter", "matters")),
        ...half(money("amount_received", { label: "Amount received" }), date("received_at", { indexed: true, label: "Received" })),
        ...half(
          money("balance_remaining", { label: "Balance remaining" }),
          select("status", [ch("active", C.green), ch("depleted", C.amber), ch("refunded", C.slate)], { default: "active" }),
        ),
      ],
      samples: [
        { client: { ref: "clients:0" }, matter: { ref: "matters:0" }, amount_received: 10000, received_at: ms("2026-05-15"), balance_remaining: 5712.5, status: "active" },
      ],
    },
    {
      slug: "disbursements", group: "Billing", singular: "Disbursement", plural: "Disbursements", defaultSort: "-incurred_at",
      fields: [
        ...half(rel("matter", "matters"), text("description", { required: true })),
        ...half(
          select("category", [ch("filing_fee", C.blue, "Filing fee"), ch("expert", C.purple), ch("travel", C.teal), ch("copying", C.gray), ch("other", C.slate)], { default: "other" }),
          money("amount"),
        ),
        ...half(date("incurred_at", { indexed: true, label: "Incurred" }), bool("billable", { default: true, label: "Billable" })),
        select("status", [ch("unbilled", C.amber), ch("invoiced", C.blue), ch("written_off", C.slate, "Written off")], { default: "unbilled" }),
      ],
      samples: [
        { matter: { ref: "matters:0" }, description: "Delaware franchise filing fee", category: "filing_fee", amount: 450, incurred_at: ms("2026-06-28"), billable: true, status: "invoiced" },
        { matter: { ref: "matters:1" }, description: "Commercial lease valuation expert", category: "expert", amount: 1200, incurred_at: ms("2026-07-08"), billable: true, status: "unbilled" },
      ],
    },
    {
      slug: "invoices", group: "Billing", singular: "Invoice", plural: "Invoices", defaultSort: "-issued_at",
      kanbanGroupBy: "status",
      fields: [
        ...half(seq("number", "LF-{YYYY}-{####}"), money("amount")),
        ...half(rel("matter", "matters"), rel("client", "clients")),
        ...half(
          select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("paid", C.green), ch("overdue", C.red)], { default: "draft" }),
          date("issued_at", { indexed: true, label: "Issued" }),
        ),
        date("due_date", { label: "Due" }),
      ],
      samples: [{ matter: { ref: "matters:0" }, client: { ref: "clients:0" }, amount: 4287.5, status: "sent", issued_at: ms("2026-07-01"), due_date: ms("2026-07-31") }],
    },
  ],
  roles: [
    {
      name: "Paralegal",
      description: "Work matters day-to-day: time, documents, key dates, parties, tasks and conflict checks; no billing changes.",
      permissions: [
        { collection: "attorneys", action: "read" },
        { collection: "clients", action: "read" },
        { collection: "clients", action: "update" },
        { collection: "matters", action: "read" },
        { collection: "matters", action: "update" },
        { collection: "time_entries", action: "read" },
        { collection: "time_entries", action: "create" },
        { collection: "time_entries", action: "update" },
        { collection: "key_dates", action: "read" },
        { collection: "key_dates", action: "create" },
        { collection: "key_dates", action: "update" },
        { collection: "documents", action: "read" },
        { collection: "documents", action: "create" },
        { collection: "documents", action: "update" },
        { collection: "parties", action: "read" },
        { collection: "parties", action: "create" },
        { collection: "parties", action: "update" },
        { collection: "matter_tasks", action: "read" },
        { collection: "matter_tasks", action: "create" },
        { collection: "matter_tasks", action: "update" },
        { collection: "conflict_checks", action: "read" },
        { collection: "conflict_checks", action: "create" },
        { collection: "disbursements", action: "read" },
        { collection: "disbursements", action: "create" },
        { collection: "retainers", action: "read" },
      ],
    },
    {
      name: "Billing clerk",
      description: "Own the money side: invoices, retainer balances and disbursement billing status — read-only on matters.",
      permissions: [
        { collection: "attorneys", action: "read" },
        { collection: "clients", action: "read" },
        { collection: "matters", action: "read" },
        { collection: "time_entries", action: "read" },
        { collection: "invoices", action: "read" },
        { collection: "invoices", action: "create" },
        { collection: "invoices", action: "update" },
        { collection: "retainers", action: "read" },
        { collection: "retainers", action: "create" },
        { collection: "retainers", action: "update" },
        { collection: "disbursements", action: "read" },
        { collection: "disbursements", action: "update" },
      ],
    },
    {
      name: "Client (portal)",
      description: "Client portal: read-only view of own matters, invoices and hearings/deadlines — no other records, no writes.",
      permissions: [
        { collection: "clients", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "matters", action: "read", condition: { "client.app_user_id": { _eq: "$user.id" } } },
        { collection: "key_dates", action: "read", condition: { "matter.client.app_user_id": { _eq: "$user.id" } } },
        { collection: "invoices", action: "read", condition: { "client.app_user_id": { _eq: "$user.id" } } },
      ],
    },
  ],
  dashboards: [
    {
      name: "Practice overview",
      description: "Matter pipeline, billable hours, receivables and trust balances.",
      panels: [
        { name: "Matters", kind: "items-aggregate", viz: "counter", config: { collection: "matters", agg: "count" } },
        { name: "Hours logged", kind: "items-aggregate", viz: "counter", config: { collection: "time_entries", agg: "sum", field: "hours" } },
        { name: "Invoiced", kind: "items-aggregate", viz: "counter", config: { collection: "invoices", agg: "sum", field: "amount" } },
        { name: "Retainer balance", kind: "items-aggregate", viz: "counter", config: { collection: "retainers", agg: "sum", field: "balance_remaining" } },
        { name: "Matters by practice area", kind: "items-aggregate", viz: "donut", config: { collection: "matters", agg: "count", groupBy: "practice_area" } },
        { name: "Matters by status", kind: "items-aggregate", viz: "bars", config: { collection: "matters", agg: "count", groupBy: "status" } },
        { name: "Disbursements by status", kind: "items-aggregate", viz: "donut", config: { collection: "disbursements", agg: "count", groupBy: "status" } },
        { name: "Tasks by status", kind: "items-aggregate", viz: "bars", config: { collection: "matter_tasks", agg: "count", groupBy: "status" } },
      ],
    },
  ],
  /**
   * A practice's standing rules. Deadlines get two of them, because in this
   * one domain the cost of noticing late is not inconvenience.
   *
   * Deliberately absent: anything that reads a document or decides whether a
   * conflict is real. These rules move dates and statuses around; every
   * judgement stays with the people admitted to make it.
   */
  flows: [
    {
      name: "Open a conflict check with every new matter",
      // Intake, enforced. The check itself is a person's job — this makes sure
      // the job exists and is assigned before anybody bills an hour.
      trigger: "event:items:matters:created",
      operations: [
        {
          type: "item.create",
          collection: "matter_tasks",
          data: {
            matter: "{{ data.id }}",
            title: "Run the conflict check before work starts",
            assignee: "{{ data.lead_attorney }}",
            priority: "urgent",
            status: "todo",
          },
        },
        {
          type: "notification",
          title: "New matter {{ data.number }} — conflict check owed",
          body: "{{ data.title }} for {{ data.client.name }}. A task is on {{ data.lead_attorney.name }}; nothing should be billed until it clears.",
          url: "/collections/conflict_checks",
        },
      ],
    },
    {
      name: "Escalate a flagged conflict",
      trigger: "event:items:conflict_checks:created",
      operations: [
        {
          type: "condition",
          filter: { result: { _eq: "flagged" } },
          then: [
            {
              type: "notification",
              title: "CONFLICT FLAGGED: {{ data.party_name }}",
              body: "On {{ data.matter.number }}, found by {{ data.checked_by }}. {{ data.notes }} — stop work on this matter until it is resolved.",
              url: "/collections/conflict_checks",
            },
          ],
        },
      ],
    },
    {
      name: "Warn a week before a hearing or deadline",
      trigger: `schedule:${JSON.stringify({
        collection: "key_dates",
        field: "due_at",
        offset: { value: 7, unit: "days", direction: "before" },
        at: 480,
        timeZone: null,
        where: { status: { _eq: "upcoming" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "{{ data.kind }} in a week: {{ data.title }}",
          body: "{{ data.matter.number }} — {{ data.matter.title }}, due {{ data.due_at }}. Lead: {{ data.matter.lead_attorney.name }}.",
          url: "/collections/key_dates",
        },
      ],
    },
    {
      name: "Warn the day before a hearing or deadline",
      // Twice on purpose. A week out is enough time to prepare; the day before
      // is the one that catches what slipped, and a duplicated reminder costs
      // a glance against a missed filing date.
      trigger: `schedule:${JSON.stringify({
        collection: "key_dates",
        field: "due_at",
        offset: { value: 1, unit: "days", direction: "before" },
        at: 480,
        timeZone: null,
        where: { status: { _eq: "upcoming" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "TOMORROW: {{ data.title }}",
          body: "{{ data.kind }} on {{ data.matter.number }} at {{ data.due_at }}.",
          url: "/collections/key_dates",
        },
      ],
    },
    {
      name: "Mark passed deadlines missed",
      // Blunt on purpose: it marks anything still `upcoming` after its time as
      // `missed`, including work that was done and never ticked off. A false
      // "missed" is corrected in one click; a deadline that quietly stays
      // "upcoming" forever is how one gets forgotten.
      trigger: "cron:0 6 * * *",
      operations: [
        {
          type: "foreach",
          collection: "key_dates",
          filter: { due_at: { _lt: "$now" }, status: { _eq: "upcoming" } },
          do: [
            {
              type: "item.update",
              collection: "key_dates",
              id: "{{ $item.id }}",
              data: { status: "missed" },
            },
            {
              type: "notification",
              title: "Passed without being closed: {{ $item.title }}",
              body: "Due {{ $item.due_at }} and still marked upcoming. Mark it done if it was — otherwise it needs attention today.",
              url: "/collections/key_dates",
            },
          ],
        },
      ],
    },
    {
      name: "Flag retainers that have run out",
      trigger: "cron:0 7 * * 1",
      operations: [
        {
          type: "foreach",
          collection: "retainers",
          // No arbitrary threshold — zero is the only figure that means the
          // same thing at every firm. Where to top up before that is a
          // conversation, not a rule.
          filter: { balance_remaining: { _lte: 0 }, status: { _eq: "active" } },
          do: [
            {
              type: "item.update",
              collection: "retainers",
              id: "{{ $item.id }}",
              data: { status: "depleted" },
            },
            {
              type: "notification",
              title: "Retainer exhausted: {{ $item.client.name }}",
              body: "On {{ $item.matter.number }}. Work billed past this point is unfunded until the retainer is topped up.",
              url: "/collections/retainers",
            },
          ],
        },
      ],
    },
    {
      name: "Mark invoices overdue past their due date",
      trigger: "cron:0 6 * * *",
      operations: [
        {
          type: "foreach",
          collection: "invoices",
          filter: { due_date: { _lt: "$now" }, status: { _eq: "sent" } },
          do: [
            {
              type: "item.update",
              collection: "invoices",
              id: "{{ $item.id }}",
              data: { status: "overdue" },
            },
          ],
        },
      ],
    },
    {
      name: "Email the client their invoice (needs email)",
      active: false,
      trigger: "event:items:invoices:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "sent" } },
          then: [
            {
              type: "email",
              to: "{{ data.client.email }}",
              subject: "Invoice {{ data.number }} — {{ data.matter.title }}",
              html: "<p>Invoice {{ data.number }} for {{ data.amount }} is due {{ data.due_date }}.</p>",
            },
          ],
        },
      ],
    },
    {
      name: "Monthly practice report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Practice overview",
          subject: "Practice — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "legal_invoice",
      name: "Matter invoice",
      description: "The bill a client receives for a matter.",
      filename: "invoice-{{ data.number }}",
      variables: ["number", "amount"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:21px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:16px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:36%;color:#555;font-weight:600}" +
        ".total{margin-top:18px;font-size:18px;font-weight:600;text-align:right}" +
        "</style></head><body>" +
        "<h1>Invoice {{ data.number }}</h1>" +
        '<p class="muted">{{ data.client.name }} · {{ data.client.company }}</p>' +
        "<table>" +
        "<tr><th>Matter</th><td>{{ data.matter.number }} — {{ data.matter.title }}</td></tr>" +
        "<tr><th>Billing</th><td>{{ data.matter.billing_type }}</td></tr>" +
        "<tr><th>Issued</th><td>{{ data.issued_at }}</td></tr>" +
        "<tr><th>Due</th><td>{{ data.due_date }}</td></tr>" +
        "</table>" +
        "<!-- time entries and disbursements are rows in their own " +
        "collections, filtered by this matter -->" +
        '<div class="total">{{ data.amount }}</div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "legal_engagement_letter",
      name: "Engagement letter",
      description: "The terms a matter is opened on.",
      filename: "engagement-{{ data.number }}",
      variables: ["number", "title"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:22mm}" +
        "body{font:12.5px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:19px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "h2{font-size:13px;margin:18px 0 4px}" +
        ".sign{margin-top:34px;display:flex;gap:40px}" +
        ".sign div{border-top:1px solid #333;width:45%;padding-top:6px}" +
        "</style></head><body>" +
        "<h1>Engagement — {{ data.title }}</h1>" +
        '<p class="muted">Matter {{ data.number }} · {{ data.client.name }}</p>' +
        "<h2>Scope</h2><p>{{ data.summary }}</p>" +
        "<h2>Fees</h2>" +
        "<p>This matter is billed on a {{ data.billing_type }} basis. Where the " +
        "basis is hourly, time is recorded against the matter and billed at the " +
        "rate agreed for the attorney doing the work. Where a fixed fee applies, " +
        "it is {{ data.fixed_fee }}. Disbursements are billed as incurred.</p>" +
        "<h2>Lead attorney</h2><p>{{ data.lead_attorney.name }} ({{ data.lead_attorney.bar_number }})</p>" +
        '<div class="sign"><div>Client · date</div><div>For the firm · date</div></div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "22mm" },
    },
    {
      key: "legal_matter_status",
      name: "Matter status report",
      description: "Where a matter stands, for the client or a file review.",
      filename: "status-{{ data.number }}",
      variables: ["number", "status"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:14px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:36%;color:#555;font-weight:600}" +
        "</style></head><body>" +
        "<h1>{{ data.title }}</h1>" +
        '<p class="muted">{{ data.number }} · {{ data.client.name }}</p>' +
        "<table>" +
        "<tr><th>Status</th><td>{{ data.status }}</td></tr>" +
        "<tr><th>Practice area</th><td>{{ data.practice_area }}</td></tr>" +
        "<tr><th>Lead attorney</th><td>{{ data.lead_attorney.name }}</td></tr>" +
        "<tr><th>Opened</th><td>{{ data.opened_at }}</td></tr>" +
        "<tr><th>Billable hours</th><td>{{ data.billable_hours }}</td></tr>" +
        "<tr><th>Open tasks</th><td>{{ data.open_tasks }}</td></tr>" +
        "</table>" +
        "<p>{{ data.summary }}</p>" +
        "<!-- upcoming hearings and deadlines are rows in `key_dates` -->" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      name: "New client enquiry",
      collection: "clients",
      settings: {
        submitLabel: "Send enquiry",
        successMessage:
          "Thanks — we'll be in touch. Please do not send confidential details or documents until we have confirmed we can act for you.",
      },
      // Contact details only, and the success message says why. An enquiry
      // form is not privileged: no solicitor-client relationship exists until
      // the firm has run its conflict check and accepted the matter, so this
      // asks how to reach somebody and nothing about their case.
      fields: [
        { name: "name", label: "Your name" },
        { name: "company", label: "Company (if any)" },
        { name: "email", label: "Email" },
        { name: "phone" },
      ],
    },
  ],
  agents: [
    {
      name: "Practice assistant",
      handle: "practice-assistant",
      description: "Answers questions about matter load, billable hours and what is due.",
      systemPrompt:
        "You help a law firm read its own practice data. Answer questions " +
        "about clients, matters, attorneys, time entries, key dates, tasks, " +
        "retainers, disbursements and invoices using the workspace's own " +
        "data.\n\n" +
        "You do NOT give legal advice, interpret a document, or opine on the " +
        "merits of a matter — not even when asked directly, and not even in " +
        "general terms. If a question calls for legal judgement, say plainly " +
        "that it is for the attorney on the matter and answer the part that " +
        "is about the firm's records instead.\n\n" +
        "A matter's `billable_hours` is kept by the server from entries " +
        "marked billable, so it already excludes written-off time — do not " +
        "add non-billable hours to it and call the result revenue. A fixed-" +
        "fee matter's hours are a cost, not a bill. A retainer's " +
        "`balance_remaining` is client money held in trust: report it, never " +
        "describe it as firm income. A `flagged` conflict check means work " +
        "should stop, so surface it whenever a matter it touches comes up. " +
        "Be brief and name the matter number.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "collections.search"],
      maxSteps: 8,
    },
  ],
};
