import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedMoneyIn, computedNum, date, email, file, flow, half, hint, money, moneyIn, ms, notes, num, phone, rel, sec, select, stacked, tabbed, text, ts, userLink } from "../dsl";

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
        bool("active", { default: true, label: "Active" }),
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
          ...half(bool("active", { default: true, label: "Active" }), userLink()),
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
          ...half(text("number", { required: true, unique: true }), rel("customer", "customers")),
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
        { number: "Q-2026-014", customer: { ref: "customers:0" }, status: "accepted", issue_date: ms("2026-05-18"), valid_until: ms("2026-06-18"), currency: "USD", subtotal: 4800, tax_total: 408, total: 5208 },
        { number: "Q-2026-015", customer: { ref: "customers:1" }, status: "sent", issue_date: ms("2026-06-25"), valid_until: ms("2026-07-25"), currency: "EUR", subtotal: 6200, tax_total: 1240, total: 7440, notes: "Two-phase rollout; phase 2 optional." },
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
      fields: stacked(
        sec("Invoice", [
          ...half(text("number", { required: true, unique: true }), rel("customer", "customers")),
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
        { number: "INV-2026-001", customer: { ref: "customers:0" }, status: "paid", issue_date: ms("2026-06-01"), due_date: ms("2026-07-01"), currency: "USD", subtotal: 4800, tax_total: 408, total: 5208, amount_paid: 5208 },
        { number: "INV-2026-002", customer: { ref: "customers:1" }, status: "sent", issue_date: ms("2026-06-20"), due_date: ms("2026-07-05"), currency: "EUR", subtotal: 1500, tax_total: 300, total: 1800, amount_paid: 0 },
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
          ...half(text("number", { required: true, unique: true }), money("amount")),
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
      samples: [{ number: "CN-2026-001", invoice: { ref: "invoices:0" }, customer: { ref: "customers:0" }, amount: 150, status: "applied", reason: "correction", issued_at: ms("2026-06-30"), note: "Overbilled one consulting hour." }],
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
          bool("active", { default: true, label: "Active" }),
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
          ...half(text("number", { required: true, unique: true }), rel("vendor", "vendors")),
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
      samples: [{ number: "PO-2026-007", vendor: { ref: "vendors:1" }, status: "accepted", issue_date: ms("2026-06-18"), expected_date: ms("2026-06-25"), currency: "USD", total: 227.85 }],
    },
    {
      slug: "bills", group: "Payables", singular: "Bill", plural: "Bills", defaultSort: "-issue_date",
      fields: stacked(
        sec("Bill", [
          ...half(text("number", { required: true, unique: true }), rel("vendor", "vendors")),
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
        ...half(bool("billable_by_default", { default: false, label: "Billable by default" }), bool("active", { default: true })),
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
};
