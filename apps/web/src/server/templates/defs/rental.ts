import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, email, file, half, hint, int, money, ms, notes, num, phone, rel, sec, select, stacked, tabbed, text, ts } from "../dsl";

export const rental: SchemaTemplate = {
  id: "rental",
  label: "Rental",
  groups: ["Catalog", "Rentals", "Billing", "People"],
  description:
    "Odoo-grade rental ops: rentable products with hourly/daily/weekly rates, serialized units, customers, rental orders with pickup & return schedules, per-line periods, late-return fees, payments (deposits, fees, refunds), signed rental agreements, bundle kits, and unit availability blocks.",
  collections: [
    {
      slug: "rental_products", group: "Catalog", singular: "Rental product", plural: "Rental products", fts: true, defaultSort: "name",
      fields: stacked(
        sec("Product", [
          ...half(
            text("name", { required: true, searchable: true }),
            select("category", [ch("tools", C.blue), ch("vehicles", C.teal), ch("av_equipment", C.purple, "A/V equipment"), ch("event", C.amber, "Event & party"), ch("other", C.gray)], { default: "other" }),
          ),
          notes("description", { searchable: true }),
        ]),
        sec("Rates", [
          ...half(money("rate_hourly", { label: "Hourly rate" }), money("rate_daily", { label: "Daily rate" })),
          ...half(money("rate_weekly", { label: "Weekly rate" }), money("deposit", { label: "Security deposit" })),
        ]),
        sec("Terms", [
          ...half(
            money("late_fee_per_day", { label: "Late fee / day" }),
            int("padding_hours", { default: 0, validation: { min: 0 }, label: "Padding between rentals (h)", description: "Turnaround time held after each return before the unit is bookable again." }),
          ),
          bool("active", { default: true, label: "Active" }),
        ]),
      ),
      samples: [
        { name: "Excavator — 1.7t mini", category: "tools", rate_hourly: 45, rate_daily: 280, rate_weekly: 1250, deposit: 500, late_fee_per_day: 80, padding_hours: 2, active: true },
        { name: "PA system — 2×12\" + mixer", category: "av_equipment", rate_daily: 90, rate_weekly: 420, deposit: 150, late_fee_per_day: 30, active: true },
      ],
    },
    {
      slug: "units", group: "Catalog", singular: "Unit", plural: "Units", defaultSort: "serial",
      fields: [
        ...half(rel("product", "rental_products"), text("serial", { required: true, unique: true, label: "Serial no." })),
        ...half(
          select("condition", [ch("new", C.green), ch("good", C.blue), ch("worn", C.amber), ch("maintenance", C.red, "In maintenance"), ch("retired", C.slate)], { default: "good" }),
          date("acquired_at", { label: "Acquired" }),
        ),
        notes("notes"),
      ],
      samples: [
        { product: { ref: "rental_products:0" }, serial: "EXC-17-001", condition: "good", acquired_at: ms("2025-03-10") },
        { product: { ref: "rental_products:1" }, serial: "PA-212-004", condition: "new", acquired_at: ms("2026-01-22") },
      ],
    },
    {
      slug: "customers", group: "People", singular: "Customer", plural: "Customers", fts: true, defaultSort: "name",
      fields: [
        ...half(text("name", { required: true, searchable: true }), email("email")),
        ...half(phone("phone"), text("id_document", { label: "ID document no." })),
        notes("notes"),
      ],
      samples: [{ name: "Hartley Construction", email: "ops@hartley.example", phone: "+15555550166", id_document: "BL-778812" }],
    },
    {
      slug: "rental_orders", group: "Rentals", singular: "Rental order", plural: "Rental orders", defaultSort: "-starts_at",
      fields: tabbed(
        sec("Order", [
          ...half(text("number", { required: true, unique: true }), rel("customer", "customers")),
          select("status", [ch("quote", C.gray), ch("reserved", C.blue), ch("picked_up", C.amber, "Picked up"), ch("returned", C.green), ch("late", C.red), ch("cancelled", C.slate)], { default: "quote" }),
        ]),
        sec("Period", [
          ...half(
            ts("starts_at", { indexed: true, label: "Pickup at" }),
            ts("due_back_at", { indexed: true, label: "Due back at", validation: { rule: { due_back_at: { _gte: "$field.starts_at" } }, message: "The return must be due after pickup." } }),
          ),
          ts("returned_at", { label: "Returned at" }),
        ]),
        sec("Totals", [
          ...half(money("subtotal"), money("deposit_held", { label: "Deposit held" })),
          ...half(money("late_fees", { label: "Late fees" }), money("total")),
        ]),
      ),
      samples: [
        { number: "RO-3001", customer: { ref: "customers:0" }, status: "picked_up", starts_at: ms("2026-07-08T08:00:00Z"), due_back_at: ms("2026-07-15T08:00:00Z"), subtotal: 1250, deposit_held: 500, late_fees: 0, total: 1250 },
        { number: "RO-3002", customer: { ref: "customers:0" }, status: "returned", starts_at: ms("2026-06-20T09:00:00Z"), due_back_at: ms("2026-06-22T09:00:00Z"), returned_at: ms("2026-06-23T11:00:00Z"), subtotal: 180, deposit_held: 150, late_fees: 30, total: 210 },
      ],
    },
    {
      slug: "rental_lines", group: "Rentals", singular: "Rental line", plural: "Rental lines",
      fields: [
        hint("rental_line_total", "Line total is generated as periods × rate."),
        ...half(rel("order", "rental_orders"), rel("product", "rental_products")),
        ...half(
          rel("unit", "units"),
          select("rate_type", [ch("hourly", C.blue), ch("daily", C.teal), ch("weekly", C.purple)], { default: "daily", label: "Rate" }),
        ),
        ...half(num("periods", { default: 1, validation: { min: 0 }, label: "Periods billed" }), money("rate", { label: "Rate amount" })),
        computedNum("line_total", "periods * rate", { label: "Line total" }),
      ],
      samples: [
        { order: { ref: "rental_orders:0" }, product: { ref: "rental_products:0" }, unit: { ref: "units:0" }, rate_type: "weekly", periods: 1, rate: 1250 },
        { order: { ref: "rental_orders:1" }, product: { ref: "rental_products:1" }, unit: { ref: "units:1" }, rate_type: "daily", periods: 2, rate: 90 },
      ],
    },
    {
      slug: "inspections", group: "Rentals", singular: "Inspection", plural: "Inspections", defaultSort: "-inspected_at",
      fields: stacked(
        sec("Inspection", [
          ...half(rel("order", "rental_orders"), rel("unit", "units")),
          ...half(
            select("stage", [ch("pre_rental", C.blue, "Pre-rental"), ch("post_return", C.teal, "Post-return")], { default: "pre_rental" }),
            select("result", [ch("ok", C.green, "OK"), ch("damage", C.red), ch("missing_parts", C.amber, "Missing parts")], { default: "ok" }),
          ),
        ]),
        sec("Findings", [
          ...half(money("damage_charge", { label: "Damage charge" }), ts("inspected_at", { indexed: true, label: "Inspected at" })),
          notes("notes"),
          file("photo"),
        ]),
      ),
      samples: [{ order: { ref: "rental_orders:1" }, unit: { ref: "units:1" }, stage: "post_return", result: "ok", damage_charge: 0, inspected_at: ms("2026-06-23T11:20:00Z") }],
    },
    {
      slug: "payments", group: "Billing", singular: "Payment", plural: "Payments", defaultSort: "-received_at",
      fields: [
        ...half(
          rel("order", "rental_orders"),
          select("kind", [ch("deposit", C.blue), ch("rental_fee", C.green, "Rental fee"), ch("late_fee", C.amber, "Late fee"), ch("damage_charge", C.red, "Damage charge"), ch("refund", C.slate)], { default: "rental_fee" }),
        ),
        ...half(
          money("amount"),
          select("method", [ch("card", C.blue), ch("cash", C.green), ch("bank_transfer", C.teal, "Bank transfer")], { default: "card" }),
        ),
        ...half(ts("received_at", { indexed: true, label: "Received at" }), notes("note")),
      ],
      samples: [
        { order: { ref: "rental_orders:0" }, kind: "deposit", amount: 500, method: "card", received_at: ms("2026-07-08T08:05:00Z") },
        { order: { ref: "rental_orders:1" }, kind: "rental_fee", amount: 180, method: "card", received_at: ms("2026-06-20T09:05:00Z") },
        { order: { ref: "rental_orders:1" }, kind: "late_fee", amount: 30, method: "card", received_at: ms("2026-06-23T11:30:00Z"), note: "One day late." },
      ],
    },
    {
      slug: "agreements", group: "Billing", singular: "Agreement", plural: "Agreements", defaultSort: "-signed_at",
      fields: [
        ...half(rel("order", "rental_orders"), select("status", [ch("draft", C.gray), ch("signed", C.green), ch("void", C.red)], { default: "draft" })),
        ...half(text("signed_by", { label: "Signed by" }), ts("signed_at", { indexed: true, label: "Signed at" })),
        file("file", { label: "Signed document" }),
      ],
      samples: [{ order: { ref: "rental_orders:0" }, signed_by: "L. Hartley", signed_at: ms("2026-07-08T08:02:00Z"), status: "signed" }],
    },
    {
      slug: "bundles", group: "Catalog", singular: "Bundle", plural: "Bundles", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), money("rate_daily", { label: "Daily rate" })),
        notes("description"),
        bool("active", { default: true, label: "Active" }),
      ],
      samples: [{ name: "Event starter kit", rate_daily: 150, description: "PA system plus stands and cabling for small events.", active: true }],
    },
    {
      slug: "bundle_items", group: "Catalog", singular: "Bundle item", plural: "Bundle items",
      fields: [...half(rel("bundle", "bundles"), rel("product", "rental_products")), int("qty", { default: 1, validation: { min: 1 } })],
      samples: [{ bundle: { ref: "bundles:0" }, product: { ref: "rental_products:1" }, qty: 1 }],
    },
    {
      slug: "availability_blocks", group: "Rentals", singular: "Availability block", plural: "Availability blocks", defaultSort: "-starts_at",
      fields: [
        ...half(
          rel("unit", "units"),
          select("reason", [ch("maintenance", C.red), ch("reserved", C.blue), ch("transit", C.amber)], { default: "maintenance" }),
        ),
        ...half(ts("starts_at", { range: { end: "ends_at" }, required: true, indexed: true, label: "Starts at" }), ts("ends_at", { label: "Ends at" })),
        notes("note"),
      ],
      samples: [
        { unit: { ref: "units:0" }, starts_at: ms("2026-07-15T08:00:00Z"), ends_at: ms("2026-07-16T08:00:00Z"), reason: "maintenance", note: "Post-rental hydraulic check." },
        { unit: { ref: "units:1" }, starts_at: ms("2026-07-25T09:00:00Z"), ends_at: ms("2026-07-26T18:00:00Z"), reason: "reserved" },
      ],
    },
  ],
  roles: [
    {
      name: "Rental desk",
      description: "Create and manage rental orders, customers, payments, agreements and inspections; read the catalog.",
      permissions: [
        { collection: "rental_products", action: "read" },
        { collection: "units", action: "read" },
        { collection: "units", action: "update" },
        { collection: "customers", action: "read" },
        { collection: "customers", action: "create" },
        { collection: "customers", action: "update" },
        { collection: "rental_orders", action: "read" },
        { collection: "rental_orders", action: "create" },
        { collection: "rental_orders", action: "update" },
        { collection: "rental_lines", action: "read" },
        { collection: "rental_lines", action: "create" },
        { collection: "rental_lines", action: "update" },
        { collection: "inspections", action: "read" },
        { collection: "inspections", action: "create" },
        { collection: "payments", action: "read" },
        { collection: "payments", action: "create" },
        { collection: "agreements", action: "read" },
        { collection: "agreements", action: "create" },
        { collection: "agreements", action: "update" },
        { collection: "bundles", action: "read" },
        { collection: "bundle_items", action: "read" },
        { collection: "availability_blocks", action: "read" },
        { collection: "availability_blocks", action: "create" },
      ],
    },
    {
      name: "Warehouse",
      description: "Keep units rentable: conditions, inspections and availability blocks.",
      permissions: [
        { collection: "rental_products", action: "read" },
        { collection: "units", action: "read" },
        { collection: "units", action: "update" },
        { collection: "rental_orders", action: "read" },
        { collection: "rental_lines", action: "read" },
        { collection: "inspections", action: "read" },
        { collection: "inspections", action: "create" },
        { collection: "inspections", action: "update" },
        { collection: "availability_blocks", action: "read" },
        { collection: "availability_blocks", action: "create" },
        { collection: "availability_blocks", action: "update" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Rental overview",
      description: "Fleet utilization, order flow, payments and revenue.",
      panels: [
        { name: "Rental orders", kind: "items-aggregate", viz: "counter", config: { collection: "rental_orders", agg: "count" } },
        { name: "Revenue", kind: "items-aggregate", viz: "counter", config: { collection: "rental_orders", agg: "sum", field: "total" } },
        { name: "Late fees", kind: "items-aggregate", viz: "counter", config: { collection: "rental_orders", agg: "sum", field: "late_fees" } },
        { name: "Payments collected", kind: "items-aggregate", viz: "counter", config: { collection: "payments", agg: "sum", field: "amount" } },
        { name: "Units", kind: "items-aggregate", viz: "counter", config: { collection: "units", agg: "count" } },
        { name: "Orders by status", kind: "items-aggregate", viz: "donut", config: { collection: "rental_orders", agg: "count", groupBy: "status" } },
        { name: "Units by condition", kind: "items-aggregate", viz: "bars", config: { collection: "units", agg: "count", groupBy: "condition" } },
        { name: "Payments by kind", kind: "items-aggregate", viz: "bars", config: { collection: "payments", agg: "count", groupBy: "kind" } },
      ],
    },
  ],
};
