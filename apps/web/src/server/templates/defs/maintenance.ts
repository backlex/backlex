import type { SchemaTemplate } from "../types";
import { C, ch, computedNum, date, email, flag, half, hint, int, money, ms, notes, num, parent, phone, rel, rollup, sec, select, seq, stacked, tabbed, text, ts, when } from "../dsl";

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
        ...half(text("specialties", { label: "Specialties" }), flag("active", { label: "Active" })),
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
          // Run hours, kept by the server from the meter readings — and
          // FILTERED to the hours metric, because the same collection also
          // holds cycles and kilometers and a `max` across all three would
          // report whichever number happened to be biggest. Preventive
          // intervals are set in hours, so this is the one that matters.
          rollup(
            "run_hours",
            { from: "meter_readings", via: "equipment", fn: "max", field: "reading", filter: { metric: { _eq: "hours" } } },
            { label: "Run hours", description: "Highest hours reading logged against this asset." },
          ),
        ]),
        sec("Upkeep", [
          ...half(rel("team", "teams", { label: "Maintenance team" }), rel("vendor", "vendors", { label: "Service vendor" })),
          ...half(
            select("criticality", [ch("low", C.gray), ch("medium", C.blue), ch("high", C.amber), ch("critical", C.red)], { default: "medium" }),
            flag("active", { label: "In service" }),
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
      // Named because auto-detect would pick `kind` — the first dropdown — and
      // corrective-vs-preventive is what a request IS, not where it has got to.
      kanbanGroupBy: "status",
      fields: tabbed(
        sec("Request", [
          ...half(seq("number", "MR-{#####}"), text("title", { required: true, searchable: true })),
          // A critical request that says only "machine broken" costs somebody a
          // walk to the floor before they can even triage it.
          notes("description", {
            searchable: true,
            conditions: [when("priority", "_eq", "critical", "required")],
          }),
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
          ...half(
            ts("completed_at", {
              label: "Completed at",
              conditions: [when("status", "_eq", "done", "required")],
            }),
            int("downtime_minutes", { default: 0, validation: { min: 0 }, label: "Downtime (min)" }),
          ),
          ...half(
            money("cost"),
            // Labour actually spent, totalled from the work logs. `downtime`
            // is how long the asset was DOWN, which is a different number and
            // usually the larger one — keeping both makes the gap visible.
            rollup(
              "labor_minutes",
              { from: "work_logs", via: "request", fn: "sum", field: "minutes" },
              { label: "Labour (min)", description: "Totalled from this request's work logs." },
            ),
          ),
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
          flag("active", { label: "Active" }),
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
  /**
   * Preventive maintenance is a promise about the future, so most of this is
   * scheduling — and one flow that turns a schedule into an actual request,
   * which is the step teams skip when they are busy and regret when they are
   * not.
   *
   * Deliberately absent: advancing `next_due` after a preventive request is
   * completed. That means reading `frequency` and adding a month or a quarter
   * to a date, and flow operations have no date arithmetic — a rule that set
   * the wrong next date would be worse than the one somebody sets by hand
   * while closing the job.
   */
  flows: [
    {
      name: "Raise the alarm on a critical request",
      trigger: "event:items:maintenance_requests:created",
      operations: [
        {
          type: "condition",
          filter: { priority: { _in: ["critical", "high"] } },
          then: [
            {
              type: "notification",
              title: "{{ data.priority }}: {{ data.title }}",
              body: "{{ data.number }} on {{ data.equipment.name }} at {{ data.equipment.location }}. {{ data.description }}",
              url: "/collections/maintenance_requests",
            },
          ],
        },
      ],
    },
    {
      name: "Turn a preventive schedule into a request a week early",
      trigger: `schedule:${JSON.stringify({
        collection: "preventive_schedules",
        field: "next_due",
        offset: { value: 7, unit: "days", direction: "before" },
        at: 420,
        timeZone: null,
        where: { active: { _eq: true } },
      })}`,
      operations: [
        {
          type: "item.create",
          collection: "maintenance_requests",
          data: {
            title: "{{ data.task }}",
            description: "Raised from the {{ data.frequency }} preventive schedule, due {{ data.next_due }}.",
            equipment: "{{ data.equipment }}",
            team: "{{ data.team }}",
            kind: "preventive",
            priority: "normal",
            status: "new",
          },
        },
        {
          type: "notification",
          title: "Preventive work raised: {{ data.task }}",
          body: "For {{ data.equipment.name }}, due {{ data.next_due }}. Set the schedule's next date when the job closes — nothing moves it on its own.",
          url: "/collections/maintenance_requests",
        },
      ],
    },
    {
      name: "Chase preventive schedules that have slipped",
      trigger: "cron:0 7 * * 1",
      operations: [
        {
          type: "foreach",
          collection: "preventive_schedules",
          filter: { next_due: { _lt: "$now" }, active: { _eq: true } },
          do: [
            {
              type: "notification",
              title: "Overdue schedule: {{ $item.task }}",
              body: "Was due {{ $item.next_due }} and has not been moved on. Either it was done and nobody said so, or it was not done.",
              url: "/collections/preventive_schedules",
            },
          ],
        },
      ],
    },
    {
      name: "Reorder spare parts that have run low",
      trigger: "cron:0 8 * * 1-5",
      operations: [
        {
          type: "foreach",
          collection: "spare_parts",
          // `min_stock: {_gt: 0}` is the guard AND the opt-in: a part left at
          // the default 0 is one nobody set a minimum for, and it should not
          // start shouting the moment the shelf is empty. Without it the
          // matcher would read the empty minimum as 0 and match everything.
          filter: { min_stock: { _gt: 0 }, stock_qty: { _lte: "$field.min_stock" } },
          do: [
            {
              type: "notification",
              title: "Low stock: {{ $item.name }}",
              body: "{{ $item.stock_qty }} left against a minimum of {{ $item.min_stock }} ({{ $item.shelf_location }}). Order from {{ $item.vendor.name }}.",
              url: "/collections/spare_parts",
            },
          ],
        },
      ],
    },
    {
      name: "Warn a month before a warranty lapses",
      // The cheapest money this template saves. A fault found the week after
      // the warranty ends is paid for twice.
      trigger: `schedule:${JSON.stringify({
        collection: "equipment",
        field: "warranty_until",
        offset: { value: 30, unit: "days", direction: "before" },
        at: 480,
        timeZone: null,
        where: { active: { _eq: true } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "{{ data.name }} goes out of warranty in a month",
          body: "Cover ends {{ data.warranty_until }}. Anything you have been putting off on this asset is free until then and billable after.",
          url: "/collections/equipment",
        },
      ],
    },
    {
      name: "Send an external vendor the request (needs email)",
      active: false,
      trigger: "event:items:maintenance_requests:created",
      operations: [
        {
          type: "condition",
          filter: { vendor: { _null: false } },
          then: [
            {
              type: "email",
              to: "{{ data.vendor.email }}",
              subject: "Service request {{ data.number }} — {{ data.equipment.name }}",
              html: "<p>{{ data.title }}</p><p>{{ data.description }}</p><p>Asset {{ data.equipment.serial }} at {{ data.equipment.location }}.</p>",
            },
          ],
        },
      ],
    },
    {
      name: "Monthly maintenance report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Maintenance overview",
          subject: "Maintenance — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "maintenance_work_order",
      name: "Maintenance work order",
      description: "The sheet a technician takes to the asset.",
      filename: "request-{{ data.number }}",
      variables: ["number", "title"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:16mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:21px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:14px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee;vertical-align:top}" +
        "th{width:32%;color:#555;font-weight:600}" +
        ".box{border:1px solid #ddd;border-radius:6px;padding:10px;margin-top:14px}" +
        ".sign{margin-top:26px;border-top:1px solid #333;width:55%;padding-top:6px}" +
        "</style></head><body>" +
        "<h1>{{ data.title }}</h1>" +
        '<p class="muted">{{ data.number }} · {{ data.kind }} · {{ data.priority }}</p>' +
        "<table>" +
        "<tr><th>Asset</th><td>{{ data.equipment.name }} ({{ data.equipment.serial }})</td></tr>" +
        "<tr><th>Location</th><td>{{ data.equipment.location }}</td></tr>" +
        "<tr><th>Criticality</th><td>{{ data.equipment.criticality }}</td></tr>" +
        "<tr><th>Team</th><td>{{ data.team.name }}</td></tr>" +
        "<tr><th>Vendor</th><td>{{ data.vendor.name }}</td></tr>" +
        "<tr><th>Scheduled</th><td>{{ data.scheduled_for }}</td></tr>" +
        "</table>" +
        '<div class="box"><strong>Reported</strong><p>{{ data.description }}</p></div>' +
        '<div class="box"><strong>Work done / parts used</strong><p class="muted">Write on site.</p></div>' +
        '<div class="sign">Technician · date</div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "16mm" },
    },
    {
      key: "maintenance_asset_card",
      name: "Asset card",
      description: "One page per asset for an audit or an insurance schedule.",
      filename: "asset-{{ data.serial }}",
      variables: ["name", "serial"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:18mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:22px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:14px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:34%;color:#555;font-weight:600}" +
        "</style></head><body>" +
        "<h1>{{ data.name }}</h1>" +
        '<p class="muted">{{ data.serial }} · {{ data.category.name }}</p>' +
        "<table>" +
        "<tr><th>Location</th><td>{{ data.location }}</td></tr>" +
        "<tr><th>Criticality</th><td>{{ data.criticality }}</td></tr>" +
        "<tr><th>Run hours</th><td>{{ data.run_hours }}</td></tr>" +
        "<tr><th>Team</th><td>{{ data.team.name }}</td></tr>" +
        "<tr><th>Service vendor</th><td>{{ data.vendor.name }}</td></tr>" +
        "<tr><th>Purchased</th><td>{{ data.purchased_at }} for {{ data.purchase_cost }}</td></tr>" +
        "<tr><th>Warranty until</th><td>{{ data.warranty_until }}</td></tr>" +
        "</table>" +
        "<!-- request history and meter readings are rows in their own " +
        "collections, filtered by this asset -->" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "18mm" },
    },
  ],
  forms: [
    {
      name: "Report a maintenance problem",
      collection: "maintenance_requests",
      settings: {
        submitLabel: "Report it",
        successMessage: "Thanks — the maintenance team has it. Name the machine in the title if you can, it gets triaged faster.",
      },
      // `equipment` is a relation and not form-eligible, so a reporter names
      // the asset in words and the team links it at triage. Better than making
      // somebody on the floor pick from a register they cannot see.
      fields: [
        { name: "title", label: "What is wrong?", help: "Include the machine or the room." },
        { name: "description", label: "What did you see or hear?" },
        { name: "priority", label: "How urgent?" },
      ],
    },
  ],
  agents: [
    {
      name: "Maintenance analyst",
      handle: "maintenance-analyst",
      description: "Answers questions about downtime, cost per asset and what keeps breaking.",
      systemPrompt:
        "You help a maintenance team read its own history. Answer questions " +
        "about equipment, requests, work logs, parts, meters, vendors and " +
        "preventive schedules using the workspace's own data. Keep two " +
        "numbers apart: `downtime_minutes` is how long the ASSET was out of " +
        "action, and `labor_minutes` is how long people worked on it — the " +
        "first is the cost to production, the second the cost to the team, " +
        "and they are rarely the same. `corrective` means something broke; " +
        "`preventive` means it did not. An asset that keeps generating " +
        "corrective requests is the answer to \"what should we replace\", so " +
        "count by equipment rather than in total. `run_hours` is kept from " +
        "the hours meter only — cycles and kilometers are recorded in the " +
        "same collection and are not interchangeable. Be brief, name the " +
        "asset, and say when a period has too few requests to conclude from.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "collections.search"],
      maxSteps: 8,
    },
  ],
};
