import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, email, half, hint, int, money, ms, notes, num, parent, phone, rel, sec, select, stacked, tabbed, text, ts } from "../dsl";

export const maintenance: SchemaTemplate = {
  id: "maintenance",
  label: "Maintenance / Assets",
  groups: ["Assets", "Requests", "Parts & Vendors"],
  description:
    "Odoo Maintenance-grade asset upkeep: equipment with location and warranty, maintenance teams, corrective & preventive requests with priority and downtime, and recurring preventive schedules — plus external service vendors, a spare-parts store with per-request usage, equipment meter readings and technician work logs.",
  collections: [
    {
      slug: "teams", group: "Requests", singular: "Team", plural: "Teams", defaultSort: "name",
      fields: [text("name", { required: true }), notes("description")],
      samples: [{ name: "Internal maintenance", description: "In-house crew for facilities and machines." }, { name: "Vendor — HVAC" }],
    },
    {
      slug: "equipment_categories", group: "Assets", singular: "Category", plural: "Categories", defaultSort: "name",
      fields: [...half(text("name", { required: true }), parent("equipment_categories"))],
      samples: [{ name: "Production machines" }, { name: "Facilities" }],
    },
    {
      slug: "vendors", group: "Parts & Vendors", singular: "Vendor", plural: "Vendors", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("contact_name", { label: "Contact name" })),
        ...half(email("email"), phone("phone")),
        ...half(text("specialties", { label: "Specialties" }), bool("active", { default: true, label: "Active" })),
      ],
      samples: [
        { name: "CoolAir HVAC Services", contact_name: "Dana Frost", email: "dispatch@coolair.example", phone: "+15555550142", specialties: "HVAC, refrigeration, air handling", active: true },
        { name: "Precision Spindle Co.", contact_name: "Omar Reyes", email: "service@precisionspindle.example", phone: "+15555550177", specialties: "CNC spindles, machine tool rebuilds", active: true },
      ],
    },
    {
      slug: "equipment", group: "Assets", singular: "Equipment", plural: "Equipment", fts: true, defaultSort: "name",
      fields: tabbed(
        sec("Asset", [
          ...half(text("name", { required: true, searchable: true }), text("serial", { unique: true, label: "Serial no." })),
          ...half(rel("category", "equipment_categories"), text("location")),
        ]),
        sec("Upkeep", [
          ...half(rel("team", "teams", { label: "Maintenance team" }), rel("vendor", "vendors", { label: "Service vendor" })),
          ...half(
            select("criticality", [ch("low", C.gray), ch("medium", C.blue), ch("high", C.amber), ch("critical", C.red)], { default: "medium" }),
            bool("active", { default: true, label: "In service" }),
          ),
        ]),
        sec("Purchase", [
          ...half(date("purchased_at", { label: "Purchased" }), date("warranty_until", { label: "Warranty until" })),
          money("purchase_cost", { label: "Purchase cost" }),
        ]),
      ),
      samples: [
        { name: "CNC mill #2", serial: "CNC-2201", category: { ref: "equipment_categories:0" }, location: "Hall A", team: { ref: "teams:0" }, vendor: { ref: "vendors:1" }, criticality: "critical", purchased_at: ms("2023-08-15"), warranty_until: ms("2026-08-15"), purchase_cost: 84000, active: true },
        { name: "Rooftop AC unit", serial: "HVAC-R1", category: { ref: "equipment_categories:1" }, location: "Roof", team: { ref: "teams:1" }, vendor: { ref: "vendors:0" }, criticality: "high", purchased_at: ms("2022-04-01"), purchase_cost: 12500, active: true },
      ],
    },
    {
      slug: "meter_readings", group: "Assets", singular: "Meter reading", plural: "Meter readings", defaultSort: "-read_at",
      fields: [
        ...half(
          rel("equipment", "equipment"),
          select("metric", [ch("hours", C.blue, "Run hours"), ch("cycles", C.teal), ch("km", C.amber, "Kilometers")], { default: "hours" }),
        ),
        ...half(num("reading", { required: true, validation: { min: 0 } }), ts("read_at", { indexed: true, label: "Read at" })),
      ],
      samples: [
        { equipment: { ref: "equipment:0" }, metric: "hours", reading: 12480, read_at: ms("2026-07-01T06:00:00Z") },
        { equipment: { ref: "equipment:0" }, metric: "hours", reading: 12544, read_at: ms("2026-07-08T06:00:00Z") },
        { equipment: { ref: "equipment:1" }, metric: "hours", reading: 30110, read_at: ms("2026-07-07T09:00:00Z") },
      ],
    },
    {
      slug: "spare_parts", group: "Parts & Vendors", singular: "Spare part", plural: "Spare parts", defaultSort: "name",
      fields: stacked(
        sec("Part", [
          ...half(text("name", { required: true }), text("part_number", { unique: true, label: "Part number" })),
          ...half(rel("vendor", "vendors", { label: "Preferred vendor" }), money("unit_cost", { label: "Unit cost" })),
        ]),
        sec("Stock", [
          ...half(
            int("stock_qty", { default: 0, validation: { min: 0 }, label: "Stock qty" }),
            int("min_stock", { default: 0, validation: { min: 0 }, label: "Min stock" }),
          ),
          text("shelf_location", { label: "Shelf location" }),
        ]),
      ),
      samples: [
        { name: "Spindle bearing kit", part_number: "SP-BRG-2201", vendor: { ref: "vendors:1" }, stock_qty: 3, min_stock: 2, unit_cost: 410, shelf_location: "Store B / S3" },
        { name: "HVAC filter set (MERV 13)", part_number: "SP-FLT-R1", vendor: { ref: "vendors:0" }, stock_qty: 8, min_stock: 4, unit_cost: 45, shelf_location: "Store B / S1" },
      ],
    },
    {
      slug: "maintenance_requests", group: "Requests", singular: "Request", plural: "Requests", fts: true, defaultSort: "-requested_at",
      fields: tabbed(
        sec("Request", [
          text("title", { required: true, searchable: true }),
          notes("description", { searchable: true }),
          ...half(rel("equipment", "equipment"), rel("team", "teams")),
          rel("vendor", "vendors", { label: "External vendor" }),
        ]),
        sec("Triage", [
          ...half(
            select("kind", [ch("corrective", C.red), ch("preventive", C.blue)], { default: "corrective", label: "Type" }),
            select("priority", [ch("low", C.gray), ch("normal", C.blue), ch("high", C.amber), ch("critical", C.red)], { default: "normal" }),
          ),
          select("status", [ch("new", C.gray), ch("in_progress", C.amber, "In progress"), ch("blocked", C.red), ch("done", C.green), ch("cancelled", C.slate)], { default: "new" }),
        ]),
        sec("Timing", [
          ...half(ts("requested_at", { indexed: true, label: "Requested at" }), ts("scheduled_for", { label: "Scheduled for" })),
          ...half(ts("completed_at", { label: "Completed at" }), int("downtime_minutes", { default: 0, validation: { min: 0 }, label: "Downtime (min)" })),
          money("cost"),
        ]),
      ),
      samples: [
        { title: "Spindle vibration above threshold", description: "Vibration sensor tripped during morning shift.", equipment: { ref: "equipment:0" }, team: { ref: "teams:0" }, vendor: { ref: "vendors:1" }, kind: "corrective", priority: "critical", status: "in_progress", requested_at: ms("2026-07-09T06:40:00Z"), downtime_minutes: 240 },
        { title: "Quarterly filter change", equipment: { ref: "equipment:1" }, team: { ref: "teams:1" }, vendor: { ref: "vendors:0" }, kind: "preventive", priority: "normal", status: "done", requested_at: ms("2026-06-25T09:00:00Z"), completed_at: ms("2026-06-25T11:30:00Z"), cost: 180 },
      ],
    },
    {
      slug: "work_logs", group: "Requests", singular: "Work log", plural: "Work logs", defaultSort: "-performed_at",
      fields: [
        ...half(rel("request", "maintenance_requests"), text("technician", { required: true })),
        ...half(
          int("minutes", { default: 0, validation: { min: 0 }, label: "Minutes" }),
          ts("performed_at", { indexed: true, label: "Performed at" }),
        ),
        notes("notes"),
      ],
      samples: [
        { request: { ref: "maintenance_requests:0" }, technician: "Aylin Demir", minutes: 90, performed_at: ms("2026-07-09T08:00:00Z"), notes: "Isolated vibration to front spindle bearing; ordered replacement kit." },
        { request: { ref: "maintenance_requests:1" }, technician: "Marco Silva", minutes: 150, performed_at: ms("2026-06-25T09:30:00Z"), notes: "Replaced full filter set, cleaned coils, verified airflow." },
      ],
    },
    {
      slug: "part_usage", group: "Parts & Vendors", singular: "Part usage", plural: "Part usage",
      fields: [
        hint("part_usage_total", "Total is generated as qty × unit cost."),
        ...half(rel("request", "maintenance_requests"), rel("part", "spare_parts")),
        ...half(int("qty", { default: 1, validation: { min: 1 } }), money("unit_cost", { label: "Unit cost" })),
        computedNum("total", "qty * unit_cost", { label: "Total" }),
      ],
      samples: [
        { request: { ref: "maintenance_requests:0" }, part: { ref: "spare_parts:0" }, qty: 1, unit_cost: 410 },
        { request: { ref: "maintenance_requests:1" }, part: { ref: "spare_parts:1" }, qty: 2, unit_cost: 45 },
      ],
    },
    {
      slug: "preventive_schedules", group: "Requests", singular: "Preventive schedule", plural: "Preventive schedules", defaultSort: "next_due",
      fields: stacked(
        sec("Schedule", [
          ...half(rel("equipment", "equipment"), rel("team", "teams")),
          text("task", { required: true, label: "Task" }),
          select("frequency", [ch("weekly", C.blue), ch("monthly", C.teal), ch("quarterly", C.amber), ch("yearly", C.purple)], { default: "monthly" }),
        ]),
        sec("Cadence", [
          ...half(date("last_done", { label: "Last done" }), date("next_due", { indexed: true, label: "Next due" })),
          bool("active", { default: true, label: "Active" }),
        ]),
      ),
      samples: [{ equipment: { ref: "equipment:1" }, team: { ref: "teams:1" }, task: "Replace filters + coil clean", frequency: "quarterly", last_done: ms("2026-06-25"), next_due: ms("2026-09-25"), active: true }],
    },
  ],
  roles: [
    {
      name: "Maintenance tech",
      description: "Work requests and schedules; read the asset register.",
      permissions: [
        { collection: "teams", action: "read" },
        { collection: "equipment_categories", action: "read" },
        { collection: "equipment", action: "read" },
        { collection: "equipment", action: "update" },
        { collection: "vendors", action: "read" },
        { collection: "maintenance_requests", action: "read" },
        { collection: "maintenance_requests", action: "create" },
        { collection: "maintenance_requests", action: "update" },
        { collection: "preventive_schedules", action: "read" },
        { collection: "preventive_schedules", action: "update" },
        { collection: "spare_parts", action: "read" },
        { collection: "spare_parts", action: "update" },
        { collection: "part_usage", action: "read" },
        { collection: "part_usage", action: "create" },
        { collection: "meter_readings", action: "read" },
        { collection: "meter_readings", action: "create" },
        { collection: "work_logs", action: "read" },
        { collection: "work_logs", action: "create" },
      ],
    },
    {
      name: "Maintenance manager",
      description: "Full control of assets, vendors, parts and the request pipeline.",
      permissions: [
        { collection: "teams", action: "read" },
        { collection: "teams", action: "create" },
        { collection: "teams", action: "update" },
        { collection: "equipment_categories", action: "read" },
        { collection: "equipment_categories", action: "create" },
        { collection: "equipment_categories", action: "update" },
        { collection: "equipment", action: "read" },
        { collection: "equipment", action: "create" },
        { collection: "equipment", action: "update" },
        { collection: "vendors", action: "read" },
        { collection: "vendors", action: "create" },
        { collection: "vendors", action: "update" },
        { collection: "spare_parts", action: "read" },
        { collection: "spare_parts", action: "create" },
        { collection: "spare_parts", action: "update" },
        { collection: "part_usage", action: "read" },
        { collection: "part_usage", action: "create" },
        { collection: "part_usage", action: "update" },
        { collection: "meter_readings", action: "read" },
        { collection: "maintenance_requests", action: "read" },
        { collection: "maintenance_requests", action: "create" },
        { collection: "maintenance_requests", action: "update" },
        { collection: "maintenance_requests", action: "delete" },
        { collection: "work_logs", action: "read" },
        { collection: "preventive_schedules", action: "read" },
        { collection: "preventive_schedules", action: "create" },
        { collection: "preventive_schedules", action: "update" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Maintenance overview",
      description: "Request load, downtime and asset criticality.",
      panels: [
        { name: "Open requests", kind: "items-aggregate", viz: "counter", config: { collection: "maintenance_requests", agg: "count" } },
        { name: "Downtime (min)", kind: "items-aggregate", viz: "counter", config: { collection: "maintenance_requests", agg: "sum", field: "downtime_minutes" } },
        { name: "Maintenance spend", kind: "items-aggregate", viz: "counter", config: { collection: "maintenance_requests", agg: "sum", field: "cost" } },
        { name: "Labor minutes logged", kind: "items-aggregate", viz: "counter", config: { collection: "work_logs", agg: "sum", field: "minutes" } },
        { name: "Spare parts on hand", kind: "items-aggregate", viz: "counter", config: { collection: "spare_parts", agg: "sum", field: "stock_qty" } },
        { name: "Requests by status", kind: "items-aggregate", viz: "donut", config: { collection: "maintenance_requests", agg: "count", groupBy: "status" } },
        { name: "Requests by type", kind: "items-aggregate", viz: "bars", config: { collection: "maintenance_requests", agg: "count", groupBy: "kind" } },
        { name: "Requests by priority", kind: "items-aggregate", viz: "bars", config: { collection: "maintenance_requests", agg: "count", groupBy: "priority" } },
      ],
    },
  ],
};
