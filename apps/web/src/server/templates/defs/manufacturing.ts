import type { SchemaTemplate } from "../types";
import { C, bool, ch, date, half, int, money, ms, notes, num, position, rel, sec, select, stacked, tabbed, text, ts } from "../dsl";

export const manufacturing: SchemaTemplate = {
  id: "manufacturing",
  label: "Manufacturing",
  groups: ["Engineering", "Production", "Catalog", "Quality"],
  description:
    "Odoo MRP-grade production: products (raw / component / finished), multi-line bills of materials with per-operation work centers, manufacturing orders that consume components, work orders per operation, and scrap records — plus lot/serial traceability, quality checks, work-center downtime events and engineering change orders.",
  collections: [
    {
      slug: "work_centers", group: "Production", singular: "Work center", plural: "Work centers", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("code", { unique: true })),
        ...half(
          int("capacity_per_hour", { default: 1, validation: { min: 0 }, label: "Capacity / hour" }),
          money("cost_per_hour", { label: "Cost / hour" }),
        ),
        bool("active", { default: true, label: "Active" }),
      ],
      samples: [{ name: "Assembly line 1", code: "ASM-1", capacity_per_hour: 20, cost_per_hour: 85, active: true }, { name: "Paint booth", code: "PNT-1", capacity_per_hour: 12, cost_per_hour: 60, active: true }],
    },
    {
      slug: "products", group: "Catalog", singular: "Product", plural: "Products", fts: true, defaultSort: "name",
      fields: stacked(
        sec("Product", [
          ...half(text("name", { required: true, searchable: true }), text("sku", { unique: true, label: "SKU" })),
          ...half(
            select("kind", [ch("raw", C.slate, "Raw material"), ch("component", C.blue), ch("finished", C.green, "Finished good")], { default: "component", label: "Type" }),
            text("unit", { default: "ea", label: "Unit of measure" }),
          ),
        ]),
        sec("Stock", [
          ...half(money("cost", { label: "Standard cost" }), int("on_hand", { default: 0, validation: { min: 0 }, label: "On hand" })),
          ...half(
            int("reorder_point", { default: 0, validation: { min: 0 }, label: "Reorder point" }),
            bool("active", { default: true, label: "Active" }),
          ),
        ]),
      ),
      samples: [
        { name: "Steel frame", sku: "RM-FRAME", kind: "raw", unit: "ea", cost: 34, on_hand: 320, reorder_point: 100, active: true },
        { name: "Motor assembly", sku: "CMP-MOTOR", kind: "component", unit: "ea", cost: 78, on_hand: 140, reorder_point: 50, active: true },
        { name: "E-bike Model S", sku: "FG-EBIKE-S", kind: "finished", unit: "ea", cost: 420, on_hand: 25, reorder_point: 10, active: true },
      ],
    },
    {
      slug: "boms", group: "Engineering", singular: "Bill of materials", plural: "Bills of materials", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), rel("product", "products", { label: "Produces" })),
        ...half(int("output_qty", { default: 1, validation: { min: 1 }, label: "Output qty" }), text("version", { default: "v1" })),
        select("status", [ch("draft", C.gray), ch("active", C.green), ch("obsolete", C.slate)], { default: "active" }),
      ],
      samples: [{ name: "E-bike Model S — standard build", product: { ref: "products:2" }, output_qty: 1, version: "v3", status: "active" }],
    },
    {
      slug: "bom_lines", group: "Engineering", singular: "BoM line", plural: "BoM lines",
      fields: [
        ...half(rel("bom", "boms"), rel("component", "products")),
        ...half(num("quantity", { default: 1, validation: { min: 0 } }), notes("note")),
      ],
      samples: [
        { bom: { ref: "boms:0" }, component: { ref: "products:0" }, quantity: 1 },
        { bom: { ref: "boms:0" }, component: { ref: "products:1" }, quantity: 1 },
      ],
    },
    {
      slug: "bom_operations", group: "Engineering", singular: "Operation", plural: "Operations", defaultSort: "position",
      fields: [
        ...half(rel("bom", "boms"), text("name", { required: true })),
        ...half(rel("work_center", "work_centers"), int("minutes", { default: 30, validation: { min: 0 }, label: "Duration (min)" })),
        position("bom"),
      ],
      samples: [
        { bom: { ref: "boms:0" }, name: "Frame prep", work_center: { ref: "work_centers:1" }, minutes: 25, position: 1 },
        { bom: { ref: "boms:0" }, name: "Final assembly", work_center: { ref: "work_centers:0" }, minutes: 45, position: 2 },
      ],
    },
    {
      slug: "ecos", group: "Engineering", singular: "Engineering change order", plural: "Engineering change orders", defaultSort: "-effective_date",
      fields: stacked(
        sec("Change order", [
          ...half(text("number", { required: true, unique: true }), rel("bom", "boms", { label: "BoM" })),
          text("title", { required: true }),
          notes("description"),
        ]),
        sec("Approval", [
          ...half(
            select("status", [ch("draft", C.gray), ch("in_review", C.amber, "In review"), ch("approved", C.green), ch("applied", C.teal)], { default: "draft" }),
            date("effective_date", { indexed: true, label: "Effective date" }),
          ),
        ]),
      ),
      samples: [
        { number: "ECO-014", bom: { ref: "boms:0" }, title: "Switch to torque-limited fasteners on frame prep", status: "in_review", effective_date: ms("2026-08-01"), description: "Replace M6 bolts with torque-limited fasteners to cut assembly rework." },
        { number: "ECO-011", bom: { ref: "boms:0" }, title: "Motor assembly rev C wiring loom", status: "applied", effective_date: ms("2026-05-15"), description: "Rev C loom removes the splice joint flagged by quality." },
      ],
    },
    {
      slug: "manufacturing_orders", group: "Production", singular: "Manufacturing order", plural: "Manufacturing orders", defaultSort: "-planned_start",
      fields: tabbed(
        sec("Order", [
          ...half(text("number", { required: true, unique: true }), int("quantity", { default: 1, validation: { min: 1 } })),
          ...half(rel("bom", "boms"), rel("product", "products")),
          ...half(
            select("status", [ch("draft", C.gray), ch("confirmed", C.blue), ch("in_progress", C.amber, "In progress"), ch("done", C.green), ch("cancelled", C.red)], { default: "draft" }),
            select("priority", [ch("normal", C.blue), ch("rush", C.red)], { default: "normal" }),
          ),
        ]),
        sec("Schedule", [
          ...half(ts("planned_start", { range: { end: "planned_end" }, indexed: true, label: "Planned start" }), ts("planned_end", { label: "Planned end" })),
          ...half(ts("completed_at", { label: "Completed at" }), int("qty_produced", { default: 0, validation: { min: 0 }, label: "Qty produced" })),
        ]),
      ),
      samples: [
        { number: "MO-501", bom: { ref: "boms:0" }, product: { ref: "products:2" }, quantity: 10, status: "in_progress", priority: "normal", planned_start: ms("2026-07-10T07:00:00Z"), planned_end: ms("2026-07-12T16:00:00Z"), qty_produced: 4 },
        { number: "MO-502", bom: { ref: "boms:0" }, product: { ref: "products:2" }, quantity: 5, status: "confirmed", priority: "rush", planned_start: ms("2026-07-16T07:00:00Z") },
      ],
    },
    {
      slug: "work_orders", group: "Production", singular: "Work order", plural: "Work orders", defaultSort: "-started_at",
      fields: [
        ...half(rel("manufacturing_order", "manufacturing_orders", { label: "MO" }), text("operation", { required: true })),
        ...half(
          rel("work_center", "work_centers"),
          select("status", [ch("pending", C.gray), ch("running", C.amber), ch("done", C.green), ch("blocked", C.red)], { default: "pending" }),
        ),
        ...half(ts("started_at", { indexed: true, label: "Started at" }), ts("finished_at", { label: "Finished at" })),
        int("minutes_actual", { default: 0, validation: { min: 0 }, label: "Actual minutes" }),
      ],
      samples: [{ manufacturing_order: { ref: "manufacturing_orders:0" }, operation: "Frame prep", work_center: { ref: "work_centers:1" }, status: "done", started_at: ms("2026-07-10T07:15:00Z"), finished_at: ms("2026-07-10T11:40:00Z"), minutes_actual: 265 }],
    },
    {
      slug: "scrap_records", group: "Production", singular: "Scrap record", plural: "Scrap records", defaultSort: "-scrapped_at",
      fields: [
        ...half(rel("manufacturing_order", "manufacturing_orders", { label: "MO" }), rel("product", "products")),
        ...half(
          int("quantity", { default: 1, validation: { min: 0 } }),
          select("reason", [ch("defect", C.red), ch("damage", C.amber), ch("expired", C.slate), ch("other", C.gray)], { default: "defect" }),
        ),
        ...half(ts("scrapped_at", { indexed: true, label: "Scrapped at" }), notes("note")),
      ],
      samples: [{ manufacturing_order: { ref: "manufacturing_orders:0" }, product: { ref: "products:1" }, quantity: 1, reason: "defect", note: "Bent shaft on arrival.", scrapped_at: ms("2026-07-10T09:00:00Z") }],
    },
    {
      slug: "lots", group: "Quality", singular: "Lot", plural: "Lots", defaultSort: "-produced_at",
      fields: [
        ...half(text("number", { required: true, unique: true, label: "Lot / serial no." }), rel("product", "products")),
        ...half(rel("manufacturing_order", "manufacturing_orders", { label: "MO" }), int("qty", { default: 1, validation: { min: 0 } })),
        ...half(
          ts("produced_at", { indexed: true, label: "Produced at" }),
          select("status", [ch("available", C.green), ch("consumed", C.gray), ch("quarantine", C.amber)], { default: "available" }),
        ),
      ],
      samples: [
        { number: "LOT-2607-A", product: { ref: "products:2" }, manufacturing_order: { ref: "manufacturing_orders:0" }, qty: 4, produced_at: ms("2026-07-11T15:00:00Z"), status: "available" },
        { number: "LOT-2605-C", product: { ref: "products:1" }, qty: 40, produced_at: ms("2026-06-20T10:00:00Z"), status: "quarantine" },
      ],
    },
    {
      slug: "quality_checks", group: "Quality", singular: "Quality check", plural: "Quality checks", defaultSort: "-checked_at",
      fields: stacked(
        sec("Check", [
          ...half(rel("manufacturing_order", "manufacturing_orders", { label: "MO" }), rel("work_order", "work_orders")),
          text("check_point", { required: true, label: "Check point" }),
        ]),
        sec("Result", [
          ...half(
            select("type", [ch("pass_fail", C.blue, "Pass / fail"), ch("measure", C.teal)], { default: "pass_fail" }),
            select("result", [ch("pending", C.amber), ch("pass", C.green), ch("fail", C.red)], { default: "pending" }),
          ),
          ...half(num("measured_value", { label: "Measured value" }), text("inspector")),
          ts("checked_at", { indexed: true, label: "Checked at" }),
        ]),
      ),
      samples: [
        { manufacturing_order: { ref: "manufacturing_orders:0" }, work_order: { ref: "work_orders:0" }, check_point: "Frame weld visual inspection", type: "pass_fail", result: "pass", checked_at: ms("2026-07-10T12:00:00Z"), inspector: "Nadia Kova" },
        { manufacturing_order: { ref: "manufacturing_orders:0" }, check_point: "Axle bolt torque (Nm)", type: "measure", result: "pending", measured_value: 42.5, checked_at: ms("2026-07-11T08:30:00Z"), inspector: "Nadia Kova" },
      ],
    },
    {
      slug: "downtime_events", group: "Production", singular: "Downtime event", plural: "Downtime events", defaultSort: "-started_at",
      fields: [
        ...half(
          rel("work_center", "work_centers"),
          select("reason", [ch("breakdown", C.red), ch("changeover", C.blue), ch("material_shortage", C.amber, "Material shortage"), ch("planned", C.gray)], { default: "breakdown" }),
        ),
        ...half(ts("started_at", { range: { end: "ended_at" }, indexed: true, label: "Started at" }), ts("ended_at", { label: "Ended at" })),
        ...half(int("minutes", { default: 0, validation: { min: 0 } }), notes("note")),
      ],
      samples: [
        { work_center: { ref: "work_centers:1" }, started_at: ms("2026-07-10T13:00:00Z"), ended_at: ms("2026-07-10T14:30:00Z"), reason: "breakdown", minutes: 90, note: "Paint booth extraction fan tripped; reset after motor cooled." },
        { work_center: { ref: "work_centers:0" }, started_at: ms("2026-07-11T06:30:00Z"), ended_at: ms("2026-07-11T07:00:00Z"), reason: "changeover", minutes: 30 },
      ],
    },
  ],
  roles: [
    {
      name: "Production supervisor",
      description: "Run manufacturing and work orders; read engineering data.",
      permissions: [
        { collection: "work_centers", action: "read" },
        { collection: "products", action: "read" },
        { collection: "boms", action: "read" },
        { collection: "bom_lines", action: "read" },
        { collection: "bom_operations", action: "read" },
        { collection: "ecos", action: "read" },
        { collection: "manufacturing_orders", action: "read" },
        { collection: "manufacturing_orders", action: "create" },
        { collection: "manufacturing_orders", action: "update" },
        { collection: "work_orders", action: "read" },
        { collection: "work_orders", action: "create" },
        { collection: "work_orders", action: "update" },
        { collection: "scrap_records", action: "read" },
        { collection: "scrap_records", action: "create" },
        { collection: "lots", action: "read" },
        { collection: "lots", action: "create" },
        { collection: "lots", action: "update" },
        { collection: "quality_checks", action: "read" },
        { collection: "downtime_events", action: "read" },
        { collection: "downtime_events", action: "create" },
        { collection: "downtime_events", action: "update" },
      ],
    },
    {
      name: "Quality inspector",
      description: "Record quality checks, manage lot status and log scrap.",
      permissions: [
        { collection: "products", action: "read" },
        { collection: "manufacturing_orders", action: "read" },
        { collection: "work_orders", action: "read" },
        { collection: "lots", action: "read" },
        { collection: "lots", action: "update" },
        { collection: "quality_checks", action: "read" },
        { collection: "quality_checks", action: "create" },
        { collection: "quality_checks", action: "update" },
        { collection: "scrap_records", action: "read" },
        { collection: "scrap_records", action: "create" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Production overview",
      description: "Order flow, output, quality and scrap.",
      panels: [
        { name: "Manufacturing orders", kind: "items-aggregate", viz: "counter", config: { collection: "manufacturing_orders", agg: "count" } },
        { name: "Units produced", kind: "items-aggregate", viz: "counter", config: { collection: "manufacturing_orders", agg: "sum", field: "qty_produced" } },
        { name: "Scrapped units", kind: "items-aggregate", viz: "counter", config: { collection: "scrap_records", agg: "sum", field: "quantity" } },
        { name: "Downtime (min)", kind: "items-aggregate", viz: "counter", config: { collection: "downtime_events", agg: "sum", field: "minutes" } },
        { name: "MOs by status", kind: "items-aggregate", viz: "donut", config: { collection: "manufacturing_orders", agg: "count", groupBy: "status" } },
        { name: "Checks by result", kind: "items-aggregate", viz: "donut", config: { collection: "quality_checks", agg: "count", groupBy: "result" } },
        { name: "Downtime by reason", kind: "items-aggregate", viz: "bars", config: { collection: "downtime_events", agg: "count", groupBy: "reason" } },
        { name: "Scrap by reason", kind: "items-aggregate", viz: "bars", config: { collection: "scrap_records", agg: "count", groupBy: "reason" } },
      ],
    },
  ],
};
