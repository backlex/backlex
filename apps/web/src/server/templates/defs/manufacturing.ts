import type { SchemaTemplate } from "../types";
import { C, ch, date, flag, half, int, money, ms, notes, num, position, rel, rollup, sec, select, seq, stacked, tabbed, text, ts, when } from "../dsl";

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
        ...half(
          flag("active", { label: "Active" }),
          // Every minute this centre was not running, totalled by the server.
          // Capacity per hour is what it CAN do; this is what took that away.
          rollup(
            "downtime_minutes",
            { from: "downtime_events", via: "work_center", fn: "sum", field: "minutes" },
            { label: "Downtime (min)", description: "Totalled from this centre's downtime events." },
          ),
        ),
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
            flag("active", { label: "Active" }),
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
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Change order", [
          ...half(seq("number", "ECO-{#####}"), rel("bom", "boms", { label: "BoM" })),
          text("title", { required: true }),
          notes("description"),
        ]),
        sec("Approval", [
          ...half(
            select("status", [ch("draft", C.gray), ch("in_review", C.amber, "In review"), ch("approved", C.green), ch("applied", C.teal)], { default: "draft" }),
            // Approving a change without saying when it takes effect leaves the
            // floor building to two revisions at once.
            date("effective_date", {
              indexed: true,
              label: "Effective date",
              conditions: [when("status", "_in", ["approved", "applied"], "required")],
            }),
          ),
        ]),
      ),
      samples: [
        { bom: { ref: "boms:0" }, title: "Switch to torque-limited fasteners on frame prep", status: "in_review", effective_date: ms("2026-08-01"), description: "Replace M6 bolts with torque-limited fasteners to cut assembly rework." },
        { bom: { ref: "boms:0" }, title: "Motor assembly rev C wiring loom", status: "applied", effective_date: ms("2026-05-15"), description: "Rev C loom removes the splice joint flagged by quality." },
      ],
    },
    {
      slug: "manufacturing_orders", group: "Production", singular: "Manufacturing order", plural: "Manufacturing orders", defaultSort: "-planned_start",
      kanbanGroupBy: "status",
      fields: tabbed(
        sec("Order", [
          ...half(seq("number", "MO-{#####}"), int("quantity", { default: 1, validation: { min: 1 } })),
          ...half(rel("bom", "boms"), rel("product", "products")),
          ...half(
            select("status", [ch("draft", C.gray), ch("confirmed", C.blue), ch("in_progress", C.amber, "In progress"), ch("done", C.green), ch("cancelled", C.red)], { default: "draft" }),
            select("priority", [ch("normal", C.blue), ch("rush", C.red)], { default: "normal" }),
          ),
        ]),
        sec("Schedule", [
          ...half(ts("planned_start", { range: { end: "planned_end" }, indexed: true, label: "Planned start" }), ts("planned_end", { label: "Planned end" })),
          ...half(
            ts("completed_at", {
              label: "Completed at",
              conditions: [when("status", "_eq", "done", "required")],
            }),
            int("qty_produced", { default: 0, validation: { min: 0 }, label: "Qty produced" }),
          ),
          // Both kept by the server, and both additive — `qty_produced` stays
          // a number the floor enters, because not every shop books production
          // through lots and taking that away would be a bigger opinion than
          // this template is entitled to. Yield reads as produced against
          // produced-plus-scrapped; the minutes read against the plan.
          ...half(
            rollup(
              "scrapped_qty",
              { from: "scrap_records", via: "manufacturing_order", fn: "sum", field: "quantity" },
              { label: "Scrapped", description: "Totalled from this order's scrap records." },
            ),
            rollup(
              "actual_minutes",
              { from: "work_orders", via: "manufacturing_order", fn: "sum", field: "minutes_actual" },
              { label: "Actual (min)", description: "Totalled from this order's work orders." },
            ),
          ),
        ]),
      ),
      samples: [
        { bom: { ref: "boms:0" }, product: { ref: "products:2" }, quantity: 10, status: "in_progress", priority: "normal", planned_start: ms("2026-07-10T07:00:00Z"), planned_end: ms("2026-07-12T16:00:00Z"), qty_produced: 4 },
        { bom: { ref: "boms:0" }, product: { ref: "products:2" }, quantity: 5, status: "confirmed", priority: "rush", planned_start: ms("2026-07-16T07:00:00Z") },
      ],
    },
    {
      slug: "work_orders", group: "Production", singular: "Work order", plural: "Work orders", defaultSort: "-started_at",
      kanbanGroupBy: "status",
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
        // NOT a sequence, unlike the MO and ECO numbers beside it. A lot on a
        // raw material arrives carrying the SUPPLIER's number, and that number
        // is the whole point of traceability — issuing our own over the top
        // would break the chain back to whoever made the batch.
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
      // Auto-detect would pick `type` — pass/fail versus measure is how the
      // check WORKS, not whether it passed.
      kanbanGroupBy: "result",
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
          ...half(
            // A measurement check with no measurement recorded is a check
            // that did not happen.
            num("measured_value", {
              label: "Measured value",
              conditions: [when("type", "_eq", "measure", "required")],
            }),
            text("inspector"),
          ),
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
  /**
   * Shop-floor rules, all of them about noticing something on the day it
   * happens rather than in the month-end review.
   *
   * NO email flow here, and that is the honest reading of the schema rather
   * than an oversight: nothing in this template holds an outside party's
   * address. Manufacturing talks to itself, so every rule below lands in the
   * workspace feed where the people who can act on it already are.
   *
   * Deliberately absent: quarantining a lot when a check fails. A
   * `quality_checks` row points at the manufacturing order and the work
   * order — never at a LOT — so the flow that sees the failure has no lot to
   * put on hold. It says which order failed and leaves the hold to somebody
   * who can see which lots came off it.
   */
  flows: [
    {
      name: "Stop the line on a failed quality check",
      trigger: "event:items:quality_checks:updated",
      operations: [
        {
          type: "condition",
          filter: { result: { _eq: "fail" } },
          then: [
            {
              type: "notification",
              title: "FAILED check: {{ data.check_point }}",
              body: "On {{ data.manufacturing_order.number }}, recorded by {{ data.inspector }}. Quarantine the lots that came off this order before any more ship.",
              url: "/collections/quality_checks",
            },
          ],
        },
      ],
    },
    {
      name: "Announce a rush order",
      trigger: "event:items:manufacturing_orders:created",
      operations: [
        {
          type: "condition",
          filter: { priority: { _eq: "rush" } },
          then: [
            {
              type: "notification",
              title: "RUSH: {{ data.number }} — {{ data.quantity }} × {{ data.product.name }}",
              body: "Planned {{ data.planned_start }} to {{ data.planned_end }}. Something else on the schedule is about to move.",
              url: "/collections/manufacturing_orders",
            },
          ],
        },
      ],
    },
    {
      name: "Chase orders past their planned end",
      trigger: "cron:0 7 * * 1-5",
      operations: [
        {
          type: "foreach",
          collection: "manufacturing_orders",
          filter: { planned_end: { _lt: "$now" }, status: { _in: ["confirmed", "in_progress"] } },
          do: [
            {
              type: "notification",
              title: "Late: {{ $item.number }}",
              body: "Planned to finish {{ $item.planned_end }}. {{ $item.qty_produced }} of {{ $item.quantity }} built so far.",
              url: "/collections/manufacturing_orders",
            },
          ],
        },
      ],
    },
    {
      name: "Call out an unplanned breakdown",
      // Only breakdowns. A changeover or a planned stop is downtime somebody
      // already decided to take, and announcing those trains people to ignore
      // the ones that matter.
      trigger: "event:items:downtime_events:created",
      operations: [
        {
          type: "condition",
          filter: { reason: { _eq: "breakdown" } },
          then: [
            {
              type: "notification",
              title: "{{ data.work_center.name }} is down",
              body: "Breakdown from {{ data.started_at }}. {{ data.note }}",
              url: "/collections/downtime_events",
            },
          ],
        },
      ],
    },
    {
      name: "Warn before an approved change takes effect",
      trigger: `schedule:${JSON.stringify({
        collection: "ecos",
        field: "effective_date",
        offset: { value: 3, unit: "days", direction: "before" },
        at: 420,
        timeZone: null,
        where: { status: { _eq: "approved" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "{{ data.number }} takes effect in three days",
          body: "{{ data.title }} — against {{ data.bom.name }}. Update the BoM and tell the line before {{ data.effective_date }}, or the floor builds the old revision.",
          url: "/collections/ecos",
        },
      ],
    },
    {
      name: "Reorder products that have hit their reorder point",
      trigger: "cron:0 6 * * 1-5",
      operations: [
        {
          type: "foreach",
          collection: "products",
          // The `reorder_point > 0` half is both the null-guard and the
          // opt-in: a product left at the default has no reorder policy, and
          // an empty minimum would otherwise read as 0 and match everything.
          filter: {
            active: { _eq: true },
            reorder_point: { _gt: 0 },
            on_hand: { _lte: "$field.reorder_point" },
          },
          do: [
            {
              type: "notification",
              title: "Reorder {{ $item.name }}",
              body: "{{ $item.on_hand }} {{ $item.unit }} on hand against a reorder point of {{ $item.reorder_point }} ({{ $item.sku }}).",
              url: "/collections/products",
            },
          ],
        },
      ],
    },
    {
      name: "Monthly production report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Production overview",
          subject: "Production — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "manufacturing_traveler",
      name: "Production traveler",
      description: "The sheet that follows a job down the line.",
      filename: "traveler-{{ data.number }}",
      variables: ["number", "quantity"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:14mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:22px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:14px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:32%;color:#555;font-weight:600}" +
        ".ops{margin-top:16px}" +
        ".ops td,.ops th{border:1px solid #ddd;height:26px}" +
        "</style></head><body>" +
        "<h1>{{ data.number }}</h1>" +
        '<p class="muted">{{ data.quantity }} × {{ data.product.name }} ({{ data.product.sku }})</p>' +
        "<table>" +
        "<tr><th>BoM</th><td>{{ data.bom.name }} {{ data.bom.version }}</td></tr>" +
        "<tr><th>Priority</th><td>{{ data.priority }}</td></tr>" +
        "<tr><th>Planned</th><td>{{ data.planned_start }} → {{ data.planned_end }}</td></tr>" +
        "</table>" +
        '<table class="ops"><tr><th>Operation</th><th>Work centre</th><th>Operator</th><th>Start</th><th>End</th><th>OK</th></tr>' +
        "<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>" +
        "<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>" +
        "<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>" +
        "<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr></table>" +
        '<p class="muted">Operations are rows in `bom_operations`, in position order — ' +
        "fill the grid from the BoM before the job starts.</p>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "14mm" },
    },
    {
      key: "manufacturing_lot_certificate",
      name: "Certificate of conformance",
      description: "What ships with a lot to say it was made and checked.",
      filename: "coc-{{ data.number }}",
      variables: ["number", "qty"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:21px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:16px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:34%;color:#555;font-weight:600}" +
        ".sign{margin-top:30px;border-top:1px solid #333;width:55%;padding-top:6px}" +
        "</style></head><body>" +
        "<h1>Certificate of conformance</h1>" +
        '<p class="muted">Lot {{ data.number }}</p>' +
        "<table>" +
        "<tr><th>Product</th><td>{{ data.product.name }} ({{ data.product.sku }})</td></tr>" +
        "<tr><th>Quantity</th><td>{{ data.qty }} {{ data.product.unit }}</td></tr>" +
        "<tr><th>Manufacturing order</th><td>{{ data.manufacturing_order.number }}</td></tr>" +
        "<tr><th>Produced</th><td>{{ data.produced_at }}</td></tr>" +
        "<tr><th>Status</th><td>{{ data.status }}</td></tr>" +
        "</table>" +
        "<p>The goods described above were manufactured under the controlling " +
        "bill of materials and passed the quality checks recorded against the " +
        "order.</p>" +
        '<div class="sign">Quality · date</div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "manufacturing_eco",
      name: "Engineering change order",
      description: "The change as it goes round for sign-off.",
      filename: "eco-{{ data.number }}",
      variables: ["number", "title"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        "h2{font-size:13px;margin:18px 0 4px}" +
        ".sign{margin-top:30px;display:flex;gap:40px}" +
        ".sign div{border-top:1px solid #333;width:45%;padding-top:6px}" +
        "</style></head><body>" +
        "<h1>{{ data.number }} — {{ data.title }}</h1>" +
        '<p class="muted">Against {{ data.bom.name }} {{ data.bom.version }} · effective {{ data.effective_date }}</p>' +
        "<h2>Change</h2><p>{{ data.description }}</p>" +
        "<h2>Status</h2><p>{{ data.status }}</p>" +
        '<div class="sign"><div>Engineering · date</div><div>Production · date</div></div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      name: "Request an engineering change",
      collection: "ecos",
      settings: {
        submitLabel: "Submit change request",
        successMessage: "Thanks — engineering will review it and set an effective date if it is approved.",
      },
      // Shared inside the plant rather than on a public site: the people who
      // notice a drawing is wrong are on the floor, not in engineering. The
      // BoM is a relation and cannot go on a form, so the request names it in
      // words and engineering links it during review.
      fields: [
        { name: "title", label: "What should change?" },
        { name: "description", label: "Why — and which BoM or part does it affect?" },
      ],
    },
  ],
  agents: [
    {
      name: "Production analyst",
      handle: "production-analyst",
      description: "Answers questions about yield, scrap, downtime and where the line loses time.",
      systemPrompt:
        "You help a production team read its own floor data. Answer questions " +
        "about products, BoMs, manufacturing orders, work orders, scrap, " +
        "lots, quality checks and downtime using the workspace's own data. " +
        "Yield is `qty_produced` against `qty_produced` plus `scrapped_qty` — " +
        "not against the ORDERED `quantity`, which is a plan and not an " +
        "outcome. `actual_minutes` on an order is totalled from its work " +
        "orders and is what to compare against the BoM operations' planned " +
        "minutes. Downtime has reasons that are not alike: `breakdown` is " +
        "lost capacity, `changeover` and `planned` are capacity somebody " +
        "spent on purpose, so never add all four together and call it loss. " +
        "A lot in `quarantine` is not available stock. Be brief, name the " +
        "order or work centre, and say when a sample is too small to conclude " +
        "from.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "collections.search"],
      maxSteps: 8,
    },
  ],
};
