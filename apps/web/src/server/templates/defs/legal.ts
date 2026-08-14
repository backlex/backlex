import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, email, file, flag, half, hint, money, ms, notes, num, phone, rel, sec, select, stacked, tabbed, text, ts, userLink } from "../dsl";

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
      fields: tabbed(
        sec("Matter", [
          ...half(text("number", { required: true, unique: true }), text("title", { required: true, searchable: true })),
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
            money("fixed_fee", { label: "Fixed fee" }),
          ),
        ]),
        sec("Dates", [
          ...half(date("opened_at", { indexed: true, label: "Opened" }), date("closed_at", { label: "Closed" })),
        ]),
      ),
      samples: [
        { number: "M-2026-014", title: "Meridian — Series B financing", client: { ref: "clients:0" }, lead_attorney: { ref: "attorneys:0" }, practice_area: "corporate", status: "active", billing_type: "hourly", opened_at: ms("2026-05-12"), summary: "Term sheet review and closing docs." },
        { number: "M-2026-019", title: "Meridian — office lease dispute", client: { ref: "clients:0" }, lead_attorney: { ref: "attorneys:1" }, practice_area: "litigation", status: "intake", billing_type: "fixed", fixed_fee: 7500, opened_at: ms("2026-07-01") },
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
        ...half(text("checked_by", { label: "Checked by" }), notes("notes")),
      ],
      samples: [
        { matter: { ref: "matters:1" }, party_name: "Harborview Properties LP", result: "clear", checked_at: ms("2026-07-01T15:30:00Z"), checked_by: "David Osei", notes: "No prior representation found in client index." },
      ],
    },
    {
      slug: "matter_tasks", group: "Matters", singular: "Task", plural: "Matter tasks", defaultSort: "due_on",
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
      fields: [
        ...half(text("number", { required: true, unique: true }), money("amount")),
        ...half(rel("matter", "matters"), rel("client", "clients")),
        ...half(
          select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("paid", C.green), ch("overdue", C.red)], { default: "draft" }),
          date("issued_at", { indexed: true, label: "Issued" }),
        ),
        date("due_date", { label: "Due" }),
      ],
      samples: [{ number: "LF-2026-031", matter: { ref: "matters:0" }, client: { ref: "clients:0" }, amount: 4287.5, status: "sent", issued_at: ms("2026-07-01"), due_date: ms("2026-07-31") }],
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
};
