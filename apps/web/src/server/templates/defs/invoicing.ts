import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedMoneyIn, computedNum, date, email, file, flag, flow, half, hint, money, moneyIn, ms, notes, num, phone, rel, sec, select, seq, stacked, tabbed, text, ts, userLink, when } from "../dsl";

export const invoicing: SchemaTemplate = {
  id: "invoicing",
  label: "Invoicing / Billing",
  groups: ["Billing", "Sales", "Payables", "Expenses", "Settings"],
  description:
    "QuickBooks-grade billing: customers with payment terms, quotes with line items, invoices with line items and taxes, recurring invoice profiles, payments, payment reminders, credit notes, vendors with bills and bill lines, and company expenses with approval status.",
  collections: [
    {
      slug: "taxes", group: "Settings", singular: "Tax", plural: "Taxes", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), num("rate", { validation: { min: 0, max: 100 }, label: "Rate (%)" })),
        flag("active", { label: "Active" }),
      ],
      samples: [{ name: "VAT 20%", rate: 20, active: true }, { name: "Sales tax 8.5%", rate: 8.5, active: true }],
    },
    {
      slug: "customers", group: "Billing", singular: "Customer", plural: "Customers", fts: true, defaultSort: "name",
      portalLink: { emailField: "email", role: "Customer (portal)" },
      fields: tabbed(
        sec("Customer", [
          ...half(text("name", { required: true, searchable: true }), text("tax_number", { label: "Tax number" })),
          ...half(email("email"), phone("phone")),
        ]),
        sec("Address", [
          text("address"),
          ...half(text("city"), text("country")),
        ]),
        sec("Billing", [
          ...half(
            select("payment_terms", [ch("due_on_receipt", C.green, "Due on receipt"), ch("net_15", C.blue, "Net 15"), ch("net_30", C.teal, "Net 30"), ch("net_60", C.amber, "Net 60")], { default: "net_30", label: "Payment terms" }),
            select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
          ),
          ...half(flag("active", { label: "Active" }), userLink()),
          notes("notes"),
        ]),
      ),
      samples: [
        { name: "Acme Corp", email: "billing@acme.example", tax_number: "US-88-1234567", city: "Chicago", country: "US", payment_terms: "net_30", currency: "USD", active: true },
        { name: "Nordwind GmbH", email: "finanz@nordwind.example", tax_number: "DE123456789", city: "Hamburg", country: "DE", payment_terms: "net_15", currency: "EUR", active: true },
      ],
    },
    {
      slug: "quotes", group: "Sales", singular: "Quote", plural: "Quotes", defaultSort: "-valid_until",
      fields: stacked(
        sec("Quote", [
          ...half(seq("number", "Q-{YYYY}-{####}"), rel("customer", "customers")),
          ...half(
            select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("accepted", C.green), ch("declined", C.red), ch("expired", C.slate)], {
              default: "draft",
              ...flow(
                { draft: ["sent"], sent: ["accepted", "declined", "expired"] },
                { initial: ["draft"], labels: { sent: "Send", accepted: "Mark accepted", declined: "Mark declined" } },
              ),
            }),
            select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
          ),
          ...half(date("issue_date", { indexed: true, label: "Issue date" }), date("valid_until", { indexed: true, label: "Valid until" })),
        ]),
        sec("Amounts", [
          hint("quote_totals", "Totals summarise the quote lines below — regenerate them after editing a line."),
          ...half(moneyIn("subtotal"), moneyIn("tax_total", { label: "Tax" })),
          moneyIn("total"),
          notes("notes"),
        ]),
      ),
      samples: [
        // No `number` here, and none in any sample of a collection that issues
        // one: the value is allocated by the counter at seed time, so a literal
        // would be silently dropped AND leave the series looking wrong.
        { customer: { ref: "customers:0" }, status: "accepted", issue_date: ms("2026-05-18"), valid_until: ms("2026-06-18"), currency: "USD", subtotal: 4800, tax_total: 408, total: 5208 },
        { customer: { ref: "customers:1" }, status: "sent", issue_date: ms("2026-06-25"), valid_until: ms("2026-07-25"), currency: "EUR", subtotal: 6200, tax_total: 1240, total: 7440, notes: "Two-phase rollout; phase 2 optional." },
      ],
    },
    {
      slug: "quote_lines", group: "Sales", singular: "Quote line", plural: "Quote lines",
      fields: [
        ...half(rel("quote", "quotes"), text("description", { required: true })),
        ...half(num("quantity", { default: 1, validation: { min: 0 } }), money("unit_price", { label: "Unit price" })),
        ...half(rel("tax", "taxes"), computedNum("line_total", "quantity * unit_price", { label: "Line total" })),
      ],
      samples: [
        { quote: { ref: "quotes:0" }, description: "Consulting — June retainer", quantity: 32, unit_price: 150, tax: { ref: "taxes:1" } },
        { quote: { ref: "quotes:1" }, description: "Platform migration — phase 1", quantity: 1, unit_price: 6200, tax: { ref: "taxes:0" } },
      ],
    },
    {
      slug: "invoices", group: "Billing", singular: "Invoice", plural: "Invoices", defaultSort: "-issue_date",
      // An invoice ledger is something people work through a column at a time —
      // what is still a draft, what has been sent, what has gone overdue. Named
      // rather than left to auto-detect: this collection has exactly one
      // dropdown today, but the moment a second one arrives the board would
      // silently regroup around whichever came first.
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Invoice", [
          ...half(seq("number", "INV-{YYYY}-{####}"), rel("customer", "customers")),
          ...half(
            select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("partial", C.amber, "Partially paid"), ch("paid", C.green), ch("overdue", C.red), ch("void", C.slate)], {
              default: "draft",
              ...flow(
                {
                  draft: ["sent", "void"],
                  sent: ["partial", "paid", "overdue", "void"],
                  partial: ["paid", "overdue", "void"],
                  overdue: ["partial", "paid", "void"],
                },
                { initial: ["draft"], labels: { sent: "Send", paid: "Mark paid", void: "Void" } },
              ),
            }),
            select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
          ),
          ...half(
            date("issue_date", { indexed: true, label: "Issue date" }),
            date("due_date", { indexed: true, label: "Due date", validation: { rule: { due_date: { _gte: "$field.issue_date" } }, message: "An invoice can't fall due before it is issued." } }),
          ),
          // Asked for exactly when there is something to explain. Marked
          // `required` outright it would block every draft; left optional it
          // would let an invoice be cancelled with no record of why, which is
          // the one thing an auditor comes back for.
          text("void_reason", {
            label: "Reason for voiding",
            conditions: [
              when("status", "_eq", "void", "required"),
              when("status", "_neq", "void", "hidden"),
            ],
          }),
        ]),
        sec("Amounts", [
          hint("invoice_balance", "Balance due is generated as total − amount paid; record money in as a Payment rather than editing it here."),
          ...half(moneyIn("subtotal"), moneyIn("tax_total", { label: "Tax" })),
          ...half(moneyIn("total"), moneyIn("amount_paid", { label: "Amount paid" })),
          computedMoneyIn("balance_due", "total - amount_paid", { label: "Balance due" }),
          notes("notes"),
        ]),
      ),
      samples: [
        { customer: { ref: "customers:0" }, status: "paid", issue_date: ms("2026-06-01"), due_date: ms("2026-07-01"), currency: "USD", subtotal: 4800, tax_total: 408, total: 5208, amount_paid: 5208 },
        { customer: { ref: "customers:1" }, status: "sent", issue_date: ms("2026-06-20"), due_date: ms("2026-07-05"), currency: "EUR", subtotal: 1500, tax_total: 300, total: 1800, amount_paid: 0 },
      ],
    },
    {
      slug: "invoice_lines", group: "Billing", singular: "Line item", plural: "Line items",
      fields: [
        ...half(rel("invoice", "invoices"), text("description", { required: true })),
        ...half(num("quantity", { default: 1, validation: { min: 0 } }), money("unit_price", { label: "Unit price" })),
        ...half(rel("tax", "taxes"), computedNum("line_total", "quantity * unit_price", { label: "Line total" })),
      ],
      samples: [
        { invoice: { ref: "invoices:0" }, description: "Consulting — June retainer", quantity: 32, unit_price: 150, tax: { ref: "taxes:1" } },
        { invoice: { ref: "invoices:1" }, description: "Design sprint", quantity: 1, unit_price: 1500, tax: { ref: "taxes:0" } },
      ],
    },
    {
      slug: "recurring_profiles", group: "Billing", singular: "Recurring profile", plural: "Recurring profiles", defaultSort: "next_issue_date",
      fields: stacked(
        sec("Profile", [
          ...half(text("name", { required: true }), rel("customer", "customers")),
          ...half(
            select("frequency", [ch("monthly", C.blue), ch("quarterly", C.teal), ch("yearly", C.purple)], { default: "monthly" }),
            select("status", [ch("active", C.green), ch("paused", C.amber), ch("ended", C.gray)], { default: "active" }),
          ),
        ]),
        sec("Next run", [
          ...half(date("next_issue_date", { indexed: true, label: "Next issue date" }), moneyIn("amount")),
          select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
          notes("notes"),
        ]),
      ),
      samples: [
        { name: "Acme — monthly retainer", customer: { ref: "customers:0" }, frequency: "monthly", next_issue_date: ms("2026-08-01"), amount: 5208, currency: "USD", status: "active" },
        { name: "Nordwind — quarterly support", customer: { ref: "customers:1" }, frequency: "quarterly", next_issue_date: ms("2026-09-01"), amount: 1800, currency: "EUR", status: "paused" },
      ],
    },
    {
      slug: "payments", group: "Billing", singular: "Payment", plural: "Payments", defaultSort: "-received_at",
      fields: [
        ...half(rel("invoice", "invoices"), rel("customer", "customers")),
        ...half(
          money("amount"),
          select("method", [ch("bank_transfer", C.blue, "Bank transfer"), ch("card", C.purple), ch("cash", C.green), ch("check", C.gray), ch("other", C.slate)], { default: "bank_transfer" }),
        ),
        ...half(date("received_at", { indexed: true, label: "Received at" }), text("reference")),
      ],
      samples: [{ invoice: { ref: "invoices:0" }, customer: { ref: "customers:0" }, amount: 5208, method: "bank_transfer", received_at: ms("2026-06-28"), reference: "WIRE-84413" }],
    },
    {
      slug: "credit_notes", group: "Billing", singular: "Credit note", plural: "Credit notes", defaultSort: "-issued_at",
      fields: stacked(
        sec("Credit note", [
          ...half(seq("number", "CN-{YYYY}-{####}"), money("amount")),
          ...half(rel("invoice", "invoices"), rel("customer", "customers")),
        ]),
        sec("Reason", [
          ...half(
            select("status", [ch("draft", C.gray), ch("issued", C.blue), ch("applied", C.green)], { default: "draft" }),
            select("reason", [ch("return", C.amber), ch("correction", C.blue), ch("goodwill", C.teal), ch("duplicate", C.gray)], { default: "correction" }),
          ),
          ...half(date("issued_at", { indexed: true, label: "Issued at" }), notes("note")),
        ]),
      ),
      samples: [{ invoice: { ref: "invoices:0" }, customer: { ref: "customers:0" }, amount: 150, status: "applied", reason: "correction", issued_at: ms("2026-06-30"), note: "Overbilled one consulting hour." }],
    },
    {
      slug: "payment_reminders", group: "Billing", singular: "Payment reminder", plural: "Payment reminders", defaultSort: "-sent_at",
      fields: [
        rel("invoice", "invoices"),
        ...half(
          select("level", [ch("friendly", C.blue), ch("firm", C.amber), ch("final", C.red)], { default: "friendly" }),
          select("channel", [ch("email", C.blue), ch("sms", C.teal, "SMS")], { default: "email" }),
        ),
        ...half(ts("sent_at", { indexed: true, label: "Sent at" }), notes("note")),
      ],
      samples: [
        { invoice: { ref: "invoices:1" }, level: "friendly", channel: "email", sent_at: ms("2026-07-06T09:00:00Z"), note: "First nudge, one day past due." },
        { invoice: { ref: "invoices:1" }, level: "firm", channel: "sms", sent_at: ms("2026-07-10T09:00:00Z") },
      ],
    },
    {
      slug: "vendors", group: "Payables", singular: "Vendor", plural: "Vendors", defaultSort: "name",
      fields: stacked(
        sec("Vendor", [
          ...half(text("name", { required: true }), text("tax_number", { label: "Tax number" })),
          ...half(email("email"), phone("phone")),
        ]),
        sec("Billing", [
          ...half(
            select("payment_terms", [ch("due_on_receipt", C.green, "Due on receipt"), ch("net_15", C.blue, "Net 15"), ch("net_30", C.teal, "Net 30"), ch("net_60", C.amber, "Net 60")], { default: "net_30", label: "Payment terms" }),
            select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
          ),
          flag("active", { label: "Active" }),
          notes("notes"),
        ]),
      ),
      samples: [
        { name: "CloudHost Ltd", email: "ar@cloudhost.example", tax_number: "GB987654321", payment_terms: "net_30", currency: "GBP", active: true },
        { name: "Office Supply Co", email: "invoices@officesupply.example", tax_number: "US-77-7654321", payment_terms: "net_15", currency: "USD", active: true },
      ],
    },
    {
      // The commitment side of payables (Invoice Ninja PurchaseOrder) — what a
      // bill is later matched against.
      slug: "purchase_orders", group: "Payables", singular: "Purchase order", plural: "Purchase orders", defaultSort: "-issue_date",
      fields: stacked(
        sec("Order", [
          ...half(seq("number", "PO-{#####}"), rel("vendor", "vendors")),
          ...half(
            select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("accepted", C.green), ch("billed", C.teal), ch("cancelled", C.red)], { default: "draft" }),
            select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
          ),
          ...half(date("issue_date", { indexed: true, label: "Issue date" }), date("expected_date", { label: "Expected date" })),
        ]),
        sec("Amount", [
          ...half(moneyIn("total"), notes("notes")),
        ]),
      ),
      samples: [{ vendor: { ref: "vendors:1" }, status: "accepted", issue_date: ms("2026-06-18"), expected_date: ms("2026-06-25"), currency: "USD", total: 227.85 }],
    },
    {
      slug: "bills", group: "Payables", singular: "Bill", plural: "Bills", defaultSort: "-issue_date",
      fields: stacked(
        sec("Bill", [
          // NOT a sequence, and that is the distinction worth keeping: a bill
          // carries the number the VENDOR put on it. Every other document here
          // is one this business issues, so the server owns those; this one is
          // typed in off a piece of paper somebody else printed.
          ...half(text("number", { required: true, unique: true, label: "Vendor's number" }), rel("vendor", "vendors")),
          ...half(
            select("status", [ch("draft", C.gray), ch("awaiting_payment", C.amber, "Awaiting payment"), ch("paid", C.green), ch("overdue", C.red)], { default: "draft" }),
            rel("purchase_order", "purchase_orders", { label: "Against PO" }),
          ),
          ...half(date("issue_date", { indexed: true, label: "Issue date" }), date("due_date", { indexed: true, label: "Due date" })),
        ]),
        sec("Amounts", [
          ...half(select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }), moneyIn("subtotal")),
          ...half(moneyIn("tax_total", { label: "Tax" }), moneyIn("total")),
          ...half(moneyIn("amount_paid", { label: "Amount paid" }), computedMoneyIn("balance_due", "total - amount_paid", { label: "Balance due" })),
          notes("notes"),
        ]),
      ),
      samples: [
        { number: "BILL-2026-031", vendor: { ref: "vendors:0" }, status: "paid", issue_date: ms("2026-06-01"), due_date: ms("2026-07-01"), currency: "GBP", subtotal: 380, tax_total: 76, total: 456, amount_paid: 456 },
        { number: "BILL-2026-032", vendor: { ref: "vendors:1" }, purchase_order: { ref: "purchase_orders:0" }, status: "awaiting_payment", issue_date: ms("2026-06-22"), due_date: ms("2026-07-07"), currency: "USD", subtotal: 210, tax_total: 17.85, total: 227.85, amount_paid: 0 },
      ],
    },
    {
      slug: "bill_lines", group: "Payables", singular: "Bill line", plural: "Bill lines",
      fields: [
        ...half(rel("bill", "bills"), text("description", { required: true })),
        ...half(num("quantity", { default: 1, validation: { min: 0 } }), money("unit_price", { label: "Unit price" })),
        ...half(rel("tax", "taxes"), computedNum("line_total", "quantity * unit_price", { label: "Line total" })),
      ],
      samples: [
        { bill: { ref: "bills:0" }, description: "Dedicated server — June", quantity: 1, unit_price: 380, tax: { ref: "taxes:0" } },
        { bill: { ref: "bills:1" }, description: "Standing desk chairs", quantity: 2, unit_price: 105, tax: { ref: "taxes:1" } },
      ],
    },
    {
      slug: "expense_categories", group: "Expenses", singular: "Expense category", plural: "Expense categories", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("gl_code", { label: "GL code" })),
        ...half(bool("billable_by_default", { default: false, label: "Billable by default" }), flag("active")),
      ],
      samples: [
        { name: "Travel", gl_code: "6100", billable_by_default: true, active: true },
        { name: "Software", gl_code: "6300", billable_by_default: false, active: true },
      ],
    },
    {
      slug: "expenses", group: "Expenses", singular: "Expense", plural: "Expenses", defaultSort: "-spent_at",
      fields: stacked(
        sec("Expense", [
          ...half(text("merchant", { required: true }), rel("expense_category", "expense_categories", { label: "Category" })),
          ...half(
            select("category", [ch("travel", C.blue), ch("meals", C.amber), ch("office", C.teal), ch("software", C.purple), ch("other", C.gray)], { default: "other", label: "Category (quick)" }),
            date("spent_at", { indexed: true, label: "Spent at" }),
          ),
          ...half(moneyIn("amount"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
        ]),
        sec("Approval", [
          ...half(
            select("status", [ch("submitted", C.blue), ch("approved", C.green), ch("reimbursed", C.teal), ch("rejected", C.red)], { default: "submitted" }),
            text("submitted_by", { label: "Submitted by" }),
          ),
          ...half(bool("billable", { default: false, label: "Billable to a customer" }), rel("customer", "customers", { label: "Re-invoice to" })),
          file("receipt"),
        ]),
      ),
      samples: [
        { merchant: "Delta Airlines", expense_category: { ref: "expense_categories:0" }, category: "travel", amount: 420, currency: "USD", spent_at: ms("2026-06-12"), status: "approved", submitted_by: "Sam Carter", billable: true, customer: { ref: "customers:0" } },
        { merchant: "Figma", expense_category: { ref: "expense_categories:1" }, category: "software", amount: 45, currency: "USD", spent_at: ms("2026-06-15"), status: "submitted", submitted_by: "Robin Vale" },
      ],
    },
  ],
  roles: [
    {
      name: "Bookkeeper",
      description: "Manage quotes, invoices, bills, payments, credit notes and expenses; read customers, vendors and taxes.",
      permissions: [
        { collection: "taxes", action: "read" },
        { collection: "customers", action: "read" },
        { collection: "quotes", action: "read" },
        { collection: "quotes", action: "create" },
        { collection: "quotes", action: "update" },
        { collection: "quote_lines", action: "read" },
        { collection: "quote_lines", action: "create" },
        { collection: "quote_lines", action: "update" },
        { collection: "invoices", action: "read" },
        { collection: "invoices", action: "create" },
        { collection: "invoices", action: "update" },
        { collection: "invoice_lines", action: "read" },
        { collection: "invoice_lines", action: "create" },
        { collection: "invoice_lines", action: "update" },
        { collection: "recurring_profiles", action: "read" },
        { collection: "recurring_profiles", action: "create" },
        { collection: "recurring_profiles", action: "update" },
        { collection: "payments", action: "read" },
        { collection: "payments", action: "create" },
        { collection: "credit_notes", action: "read" },
        { collection: "credit_notes", action: "create" },
        { collection: "credit_notes", action: "update" },
        { collection: "payment_reminders", action: "read" },
        { collection: "payment_reminders", action: "create" },
        { collection: "vendors", action: "read" },
        { collection: "bills", action: "read" },
        { collection: "bills", action: "create" },
        { collection: "bills", action: "update" },
        { collection: "bill_lines", action: "read" },
        { collection: "bill_lines", action: "create" },
        { collection: "bill_lines", action: "update" },
        { collection: "expenses", action: "read" },
        { collection: "expenses", action: "update" },
      ],
    },
    {
      name: "Customer (portal)",
      description: "Signed-in customer self-service: read own invoices, line items, payments, quotes and credit notes — no writes, no payables.",
      permissions: [
        { collection: "customers", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "invoices", action: "read", condition: { "customer.app_user_id": { _eq: "$user.id" } } },
        { collection: "invoice_lines", action: "read", condition: { "invoice.customer.app_user_id": { _eq: "$user.id" } } },
        { collection: "payments", action: "read", condition: { "customer.app_user_id": { _eq: "$user.id" } } },
        { collection: "quotes", action: "read", condition: { "customer.app_user_id": { _eq: "$user.id" } } },
        { collection: "credit_notes", action: "read", condition: { "customer.app_user_id": { _eq: "$user.id" } } },
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
        { name: "Quotes by status", kind: "items-aggregate", viz: "donut", config: { collection: "quotes", agg: "count", groupBy: "status" } },
        { name: "Bills by status", kind: "items-aggregate", viz: "donut", config: { collection: "bills", agg: "count", groupBy: "status" } },
        { name: "Payments by method", kind: "items-aggregate", viz: "bars", config: { collection: "payments", agg: "count", groupBy: "method" } },
        { name: "Expenses by category", kind: "items-aggregate", viz: "bars", config: { collection: "expenses", agg: "count", groupBy: "category" } },
      ],
    },
  ],
  /**
   * The rules a billing operation runs on, already running.
   *
   * Deliberately absent: "a payment landed, so mark the invoice paid". Whether
   * a payment settles an invoice or only part of it depends on the invoice's
   * own total, and a flow's `data` is the payment row — it cannot see across.
   * A step that set `paid` on every payment would be wrong on every instalment,
   * which is worse than the operator doing it. So the flow reports the payment
   * and leaves the judgement where the figures are.
   */
  flows: [
    {
      name: "Tell the team when an invoice is issued",
      trigger: "event:items:invoices:created",
      operations: [
        {
          type: "notification",
          title: "Invoice {{ data.number }} created",
          body: "A new invoice was raised. Open it to review the lines before sending.",
          url: "/collections/invoices",
        },
      ],
    },
    {
      name: "Chase an invoice three days before it falls due",
      // Fires once per row, three days before `due_date`, at 09:00 — and only
      // for invoices that are still owed. `_nin` rather than `_neq`, because
      // "not paid" has to also exclude the ones that were voided.
      trigger: `schedule:${JSON.stringify({
        collection: "invoices",
        field: "due_date",
        offset: { value: 3, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { status: { _nin: ["paid", "void"] } },
      })}`,
      operations: [
        {
          type: "item.create",
          collection: "payment_reminders",
          data: {
            invoice: "{{ data.id }}",
            level: "friendly",
            channel: "email",
            note: "Due in three days.",
          },
        },
        {
          type: "notification",
          title: "Invoice {{ data.number }} is due in three days",
          body: "A friendly reminder has been logged against it.",
          url: "/collections/invoices",
        },
      ],
    },
    {
      name: "Move an invoice to overdue the morning after it was due",
      trigger: "cron:0 6 * * *",
      operations: [
        {
          type: "foreach",
          collection: "invoices",
          filter: { status: { _in: ["sent", "partial"] }, due_date: { _lt: "$now" } },
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
      name: "Log every payment against its invoice",
      trigger: "event:items:payments:created",
      operations: [
        {
          type: "notification",
          title: "Payment received",
          body: "{{ data.amount }} recorded via {{ data.method }}. Check the invoice balance and set its status.",
          url: "/collections/payments",
        },
      ],
    },
    {
      name: "Email the invoice PDF when it is sent (needs email + a PDF renderer)",
      // Off until both are configured — see the note in docs/templates.md. The
      // name carries the prerequisite so nobody has to open it to find out.
      active: false,
      trigger: "event:items:invoices:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "sent" } },
          then: [
            { type: "document.render", templateKey: "invoice" },
            {
              type: "email",
              to: "{{ data.customer.email }}",
              subject: "Invoice {{ data.number }}",
              html: "<p>Your invoice is attached.</p>",
              attach: ["{{ $last.key }}"],
            },
          ],
        },
      ],
    },
    {
      name: "Monthly billing report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Billing overview",
          subject: "Billing — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "invoice",
      name: "Invoice",
      description: "The invoice as the customer receives it.",
      filename: "invoice-{{ data.number }}",
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
        "<h1>Invoice {{ data.number }}</h1>" +
        '<p class="muted">Issued {{ data.issue_date }} · Due {{ data.due_date }}</p>' +
        "<p><strong>{{ data.customer.name }}</strong><br>{{ data.customer.address }}<br>" +
        "{{ data.customer.city }} {{ data.customer.country }}</p>" +
        "<table><thead><tr><th>Description</th><th class=\"n\">Qty</th>" +
        '<th class="n">Unit</th><th class="n">Line total</th></tr></thead><tbody>' +
        "<!-- one row per line item; fill from your own query or a foreach -->" +
        "</tbody></table>" +
        '<table class="totals"><tr><td class="n">Subtotal</td><td class="n">{{ data.subtotal }}</td></tr>' +
        '<tr><td class="n">Tax</td><td class="n">{{ data.tax_total }}</td></tr>' +
        '<tr><td class="n"><strong>Total {{ data.currency }}</strong></td>' +
        '<td class="n"><strong>{{ data.total }}</strong></td></tr>' +
        '<tr><td class="n">Paid</td><td class="n">{{ data.amount_paid }}</td></tr>' +
        '<tr><td class="n"><strong>Balance due</strong></td>' +
        '<td class="n"><strong>{{ data.balance_due }}</strong></td></tr></table>' +
        "<p class=\"muted\">{{ data.notes }}</p>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "payment_receipt",
      name: "Payment receipt",
      description: "Confirmation of one payment against an invoice.",
      filename: "receipt-{{ data.reference }}",
      variables: ["amount", "method"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 12px}" +
        "</style></head><body>" +
        "<h1>Payment receipt</h1>" +
        "<p>Received <strong>{{ data.amount }}</strong> on {{ data.received_at }} " +
        "by {{ data.method }}.</p>" +
        "<p>Reference: {{ data.reference }}</p>" +
        "<p>Thank you.</p>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      name: "New customer details",
      collection: "customers",
      settings: {
        submitLabel: "Send details",
        successMessage: "Thank you — we'll set you up and send your first invoice.",
      },
      fields: [
        { name: "name", label: "Company or full name" },
        { name: "email", label: "Billing email", help: "Where invoices should be sent." },
        { name: "phone" },
        { name: "tax_number", label: "Tax number", help: "Leave blank if you have none." },
        { name: "address" },
        { name: "city" },
        { name: "country" },
      ],
    },
  ],
  agents: [
    {
      name: "Collections assistant",
      handle: "collections-assistant",
      description: "Answers questions about who owes what.",
      systemPrompt:
        "You help a billing team chase money. Answer questions about invoices, " +
        "payments and outstanding balances using the workspace's own data. " +
        "Always name the invoice number and the currency; amounts in different " +
        "currencies are never added together. When asked what to chase, rank by " +
        "how far past due an invoice is, not by size. Be brief and specific, and " +
        "say plainly when the data does not answer the question.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "kpis.run"],
      maxSteps: 8,
    },
  ],
};
