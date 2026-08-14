import type { SchemaTemplate } from "../types";
import { C, ch, computedNum, date, email, file, flag, geo, half, int, money, ms, notes, num, phone, position, rating, rel, sec, select, stacked, tabbed, text, ts, userLink } from "../dsl";

export const fieldService: SchemaTemplate = {
  id: "field-service",
  label: "Field service",
  groups: ["Work orders", "Billing", "People", "Catalog"],
  description:
    "Odoo/Jobber-grade field service: customers with service addresses, technicians, work orders with scheduling and priority, visit timesheets, parts used per job, signed completion worksheets, recurring service contracts, estimates with line items, invoices, and reusable job checklists.",
  collections: [
    {
      slug: "technicians", group: "People", singular: "Technician", plural: "Technicians", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), email("email")),
        ...half(phone("phone"), text("skills_summary", { label: "Skills" })),
        ...half(
          select("home_region", ["north", "south", "east", "west", "central"], { default: "central", label: "Home region" }),
          flag("active", { label: "Active" }),
        ),
      ],
      samples: [
        { name: "Dana Whitfield", email: "dana@example.com", phone: "+15555550170", skills_summary: "HVAC, electrical", home_region: "north", active: true },
        { name: "Marco Ruiz", email: "marco@example.com", phone: "+15555550171", skills_summary: "Plumbing", home_region: "central", active: true },
      ],
    },
    {
      slug: "customers", group: "People", singular: "Customer", plural: "Customers", fts: true, defaultSort: "name",
      portalLink: { emailField: "email", role: "Customer (portal)" },
      fields: stacked(
        sec("Customer", [
          ...half(text("name", { required: true, searchable: true }), email("email")),
          ...half(phone("phone"), userLink()),
        ]),
        sec("Service address", [
          text("address"),
          ...half(text("city"), text("postal_code", { label: "Postal code" })),
          geo("coordinates", ["address", "city", "postal_code"], {
            label: "Map pin",
            description: "Filter jobs by distance from a technician — see docs/geo.md.",
          }),
          notes("access_notes", { label: "Access notes", description: "Gate codes, parking, who to ask for — what a tech needs to get in." }),
        ]),
      ),
      samples: [{ name: "Riverside Apartments", email: "manager@riverside.example", phone: "+15555550180", address: "88 River Rd", city: "Portland", access_notes: "Gate code 4415; parking in the rear lot." }],
    },
    {
      slug: "parts", group: "Catalog", singular: "Part", plural: "Parts", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("sku", { unique: true, label: "SKU" })),
        ...half(money("unit_cost", { label: "Unit cost" }), money("unit_price", { label: "Bill price" })),
        int("stock", { default: 0, validation: { min: 0 } }),
      ],
      samples: [{ name: "Condenser fan motor", sku: "HVAC-FM-01", unit_cost: 84, unit_price: 149, stock: 12 }, { name: "3/4\" ball valve", sku: "PLB-BV-34", unit_cost: 9.5, unit_price: 24, stock: 40 }],
    },
    {
      slug: "checklists", group: "Catalog", singular: "Checklist", plural: "Checklists", defaultSort: "name",
      fields: [text("name", { required: true }), notes("applies_to", { label: "Applies to" })],
      samples: [{ name: "Boiler inspection", applies_to: "Quarterly and annual boiler inspection jobs." }],
    },
    {
      slug: "checklist_items", group: "Catalog", singular: "Checklist item", plural: "Checklist items", defaultSort: "position",
      fields: [rel("checklist", "checklists"), ...half(text("label", { required: true }), position("checklist"))],
      samples: [
        { checklist: { ref: "checklists:0" }, label: "Check pressure relief valve", position: 1 },
        { checklist: { ref: "checklists:0" }, label: "Inspect burner and flame pattern", position: 2 },
        { checklist: { ref: "checklists:0" }, label: "Record boiler pressure", position: 3 },
      ],
    },
    {
      slug: "service_contracts", group: "Billing", singular: "Service contract", plural: "Service contracts", defaultSort: "next_visit_due",
      fields: [
        ...half(rel("customer", "customers"), text("name", { required: true })),
        ...half(
          select("frequency", [ch("monthly", C.blue), ch("quarterly", C.teal), ch("yearly", C.purple)], { default: "quarterly" }),
          date("next_visit_due", { indexed: true, label: "Next visit due" }),
        ),
        ...half(
          money("monthly_fee", { label: "Monthly fee" }),
          select("status", [ch("active", C.green), ch("paused", C.amber), ch("expired", C.red)], { default: "active" }),
        ),
      ],
      samples: [{ customer: { ref: "customers:0" }, name: "Riverside boiler care plan", frequency: "quarterly", next_visit_due: ms("2026-10-01"), monthly_fee: 95, status: "active" }],
    },
    {
      slug: "work_orders", group: "Work orders", singular: "Work order", plural: "Work orders", fts: true, defaultSort: "-scheduled_at",
      fields: tabbed(
        sec("Job", [
          ...half(text("number", { required: true, unique: true }), text("title", { required: true, searchable: true })),
          notes("description", { searchable: true }),
          ...half(rel("customer", "customers"), rel("contract", "service_contracts", { label: "Service contract" })),
          rel("checklist", "checklists"),
        ]),
        sec("Assignment", [
          ...half(
            rel("technician", "technicians"),
            select("priority", [ch("low", C.gray), ch("normal", C.blue), ch("high", C.amber), ch("urgent", C.red)], { default: "normal" }),
          ),
          select("status", [ch("new", C.gray), ch("scheduled", C.blue), ch("en_route", C.teal, "En route"), ch("in_progress", C.amber, "In progress"), ch("done", C.green), ch("cancelled", C.red)], { default: "new" }),
        ]),
        sec("Schedule", [
          ...half(
            ts("scheduled_at", { indexed: true, label: "Scheduled at" }),
            int("estimated_minutes", { default: 60, validation: { min: 0 }, label: "Estimate (min)" }),
          ),
          ts("completed_at", { label: "Completed at" }),
        ]),
      ),
      samples: [
        { number: "WO-1001", title: "AC unit not cooling — building B", description: "Tenant reports warm air from unit 2B.", customer: { ref: "customers:0" }, technician: { ref: "technicians:0" }, priority: "high", status: "scheduled", scheduled_at: ms("2026-07-15T13:00:00Z"), estimated_minutes: 90 },
        { number: "WO-1002", title: "Quarterly boiler inspection", customer: { ref: "customers:0" }, contract: { ref: "service_contracts:0" }, checklist: { ref: "checklists:0" }, technician: { ref: "technicians:1" }, priority: "normal", status: "done", scheduled_at: ms("2026-07-01T09:00:00Z"), estimated_minutes: 60, completed_at: ms("2026-07-01T10:05:00Z") },
      ],
    },
    {
      slug: "visits", group: "Work orders", singular: "Visit", plural: "Visits", defaultSort: "-started_at",
      fields: [
        ...half(rel("work_order", "work_orders"), rel("technician", "technicians")),
        ...half(ts("started_at", { range: { end: "ended_at" }, indexed: true, label: "Started at" }), ts("ended_at", { label: "Ended at" })),
        int("minutes_on_site", { default: 0, validation: { min: 0 }, label: "Minutes on site" }),
        notes("summary"),
      ],
      samples: [{ work_order: { ref: "work_orders:1" }, technician: { ref: "technicians:1" }, started_at: ms("2026-07-01T09:00:00Z"), ended_at: ms("2026-07-01T10:05:00Z"), minutes_on_site: 65, summary: "Inspection passed; replaced pressure gauge." }],
    },
    {
      slug: "work_order_parts", group: "Work orders", singular: "Part used", plural: "Parts used",
      fields: [
        ...half(rel("work_order", "work_orders"), rel("part", "parts")),
        ...half(int("quantity", { default: 1, validation: { min: 0 } }), money("unit_price", { label: "Billed price" })),
        computedNum("line_total", "quantity * unit_price", { label: "Line total" }),
      ],
      samples: [{ work_order: { ref: "work_orders:1" }, part: { ref: "parts:1" }, quantity: 1, unit_price: 24 }],
    },
    {
      slug: "worksheets", group: "Work orders", singular: "Worksheet", plural: "Worksheets", defaultSort: "-signed_at",
      fields: stacked(
        sec("Work performed", [
          rel("work_order", "work_orders"),
          notes("work_performed", { label: "Work performed" }),
          notes("recommendations"),
          ...half(
            select("outcome", [ch("resolved", C.green), ch("follow_up", C.amber, "Needs follow-up"), ch("unresolved", C.red)], { default: "resolved" }),
            rating("customer_rating", { label: "Customer rating" }),
          ),
        ]),
        sec("Sign-off", [
          ...half(text("signed_by", { label: "Signed by" }), ts("signed_at", { label: "Signed at" })),
          file("signature"),
        ]),
      ),
      samples: [{ work_order: { ref: "work_orders:1" }, work_performed: "Full inspection; gauge swap.", outcome: "resolved", customer_rating: 5, signed_by: "R. Alvarez", signed_at: ms("2026-07-01T10:10:00Z") }],
    },
    {
      slug: "estimates", group: "Billing", singular: "Estimate", plural: "Estimates", defaultSort: "number",
      fields: [
        ...half(rel("customer", "customers"), text("number", { required: true, unique: true })),
        ...half(
          select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("approved", C.green), ch("declined", C.red)], { default: "draft", indexed: true }),
          money("total"),
        ),
        notes("scope_notes", { label: "Scope notes" }),
      ],
      samples: [
        { customer: { ref: "customers:0" }, number: "EST-2001", status: "approved", total: 1240, scope_notes: "Replace rooftop condenser fan assembly, building B." },
        { customer: { ref: "customers:0" }, number: "EST-2002", status: "sent", total: 380 },
      ],
    },
    {
      slug: "estimate_lines", group: "Billing", singular: "Estimate line", plural: "Estimate lines",
      fields: [
        ...half(rel("estimate", "estimates"), text("description", { required: true })),
        ...half(num("qty", { default: 1, validation: { min: 0 } }), money("unit_price", { label: "Unit price" })),
        computedNum("line_total", "qty * unit_price", { label: "Line total" }),
      ],
      samples: [
        { estimate: { ref: "estimates:0" }, description: "Condenser fan motor (part + install)", qty: 1, unit_price: 640 },
        { estimate: { ref: "estimates:0" }, description: "Labor — rooftop access, 4h", qty: 4, unit_price: 150 },
      ],
    },
    {
      slug: "invoices", group: "Billing", singular: "Invoice", plural: "Invoices", defaultSort: "-issued_at",
      fields: [
        ...half(rel("work_order", "work_orders"), rel("customer", "customers")),
        ...half(text("number", { required: true, unique: true }), money("amount")),
        ...half(
          select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("paid", C.green)], { default: "draft", indexed: true }),
          date("issued_at", { indexed: true, label: "Issued" }),
        ),
      ],
      samples: [{ work_order: { ref: "work_orders:1" }, customer: { ref: "customers:0" }, number: "INV-5001", amount: 184, status: "paid", issued_at: ms("2026-07-02") }],
    },
  ],
  roles: [
    {
      name: "Dispatcher",
      description: "Schedule and assign work orders; manage customers, contracts, estimates and invoices; read everything else.",
      permissions: [
        { collection: "technicians", action: "read" },
        { collection: "customers", action: "read" },
        { collection: "customers", action: "create" },
        { collection: "customers", action: "update" },
        { collection: "parts", action: "read" },
        { collection: "checklists", action: "read" },
        { collection: "checklist_items", action: "read" },
        { collection: "service_contracts", action: "read" },
        { collection: "service_contracts", action: "create" },
        { collection: "service_contracts", action: "update" },
        { collection: "work_orders", action: "read" },
        { collection: "work_orders", action: "create" },
        { collection: "work_orders", action: "update" },
        { collection: "visits", action: "read" },
        { collection: "work_order_parts", action: "read" },
        { collection: "worksheets", action: "read" },
        { collection: "estimates", action: "read" },
        { collection: "estimates", action: "create" },
        { collection: "estimates", action: "update" },
        { collection: "estimate_lines", action: "read" },
        { collection: "estimate_lines", action: "create" },
        { collection: "estimate_lines", action: "update" },
        { collection: "invoices", action: "read" },
        { collection: "invoices", action: "create" },
        { collection: "invoices", action: "update" },
      ],
    },
    {
      name: "Technician",
      description: "Work assigned jobs in the field: log visits, parts used and signed worksheets.",
      permissions: [
        { collection: "customers", action: "read" },
        { collection: "parts", action: "read" },
        { collection: "checklists", action: "read" },
        { collection: "checklist_items", action: "read" },
        { collection: "work_orders", action: "read" },
        { collection: "work_orders", action: "update" },
        { collection: "visits", action: "read" },
        { collection: "visits", action: "create" },
        { collection: "visits", action: "update" },
        { collection: "work_order_parts", action: "read" },
        { collection: "work_order_parts", action: "create" },
        { collection: "worksheets", action: "read" },
        { collection: "worksheets", action: "create" },
        { collection: "worksheets", action: "update" },
      ],
    },
    {
      name: "Customer (portal)",
      description: "Signed-in customer self-service: read own work orders, visits, invoices, estimates and service contracts — no writes, no parts stock.",
      permissions: [
        { collection: "customers", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "work_orders", action: "read", condition: { "customer.app_user_id": { _eq: "$user.id" } } },
        { collection: "visits", action: "read", condition: { "work_order.customer.app_user_id": { _eq: "$user.id" } } },
        { collection: "invoices", action: "read", condition: { "customer.app_user_id": { _eq: "$user.id" } } },
        { collection: "estimates", action: "read", condition: { "customer.app_user_id": { _eq: "$user.id" } } },
        { collection: "service_contracts", action: "read", condition: { "customer.app_user_id": { _eq: "$user.id" } } },
      ],
    },
  ],
  dashboards: [
    {
      name: "Field operations",
      description: "Job load, status mix, technician activity and billing.",
      panels: [
        { name: "Work orders", kind: "items-aggregate", viz: "counter", config: { collection: "work_orders", agg: "count" } },
        { name: "Visits", kind: "items-aggregate", viz: "counter", config: { collection: "visits", agg: "count" } },
        { name: "Minutes on site", kind: "items-aggregate", viz: "counter", config: { collection: "visits", agg: "sum", field: "minutes_on_site" } },
        { name: "Invoiced", kind: "items-aggregate", viz: "counter", config: { collection: "invoices", agg: "sum", field: "amount" } },
        { name: "Service contracts", kind: "items-aggregate", viz: "counter", config: { collection: "service_contracts", agg: "count" } },
        { name: "Orders by status", kind: "items-aggregate", viz: "donut", config: { collection: "work_orders", agg: "count", groupBy: "status" } },
        { name: "Orders by priority", kind: "items-aggregate", viz: "bars", config: { collection: "work_orders", agg: "count", groupBy: "priority" } },
        { name: "Estimates by status", kind: "items-aggregate", viz: "bars", config: { collection: "estimates", agg: "count", groupBy: "status" } },
      ],
    },
  ],
};
