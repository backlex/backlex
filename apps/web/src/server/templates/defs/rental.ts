import type { SchemaTemplate } from "../types";
import { C, ch, computedNum, date, email, file, flag, half, hint, int, money, ms, notes, num, phone, rel, rollup, sec, select, seq, stacked, tabbed, text, ts, when } from "../dsl";

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
          // How many of these we actually own, kept by the server from the
          // serialized units. It is the first half of every availability
          // question — the second half is which of them are out right now.
          rollup(
            "unit_count",
            { from: "units", via: "product", fn: "count" },
            { label: "Units owned" },
          ),
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
          flag("active", { label: "Active" }),
        ]),
      ),
      samples: [
        { name: "Excavator — 1.7t mini", category: "tools", rate_hourly: 45, rate_daily: 280, rate_weekly: 1250, deposit: 500, late_fee_per_day: 80, padding_hours: 2, active: true },
        { name: "PA system — 2×12\" + mixer", category: "av_equipment", rate_daily: 90, rate_weekly: 420, deposit: 150, late_fee_per_day: 30, active: true },
      ],
    },
    {
      slug: "units", group: "Catalog", singular: "Unit", plural: "Units", defaultSort: "serial",
      kanbanGroupBy: "condition",
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
      kanbanGroupBy: "status",
      fields: tabbed(
        sec("Order", [
          ...half(seq("number", "RO-{#####}"), rel("customer", "customers")),
          select("status", [ch("quote", C.gray), ch("reserved", C.blue), ch("picked_up", C.amber, "Picked up"), ch("returned", C.green), ch("late", C.red), ch("cancelled", C.slate)], { default: "quote" }),
        ]),
        sec("Period", [
          ...half(
            ts("starts_at", { indexed: true, label: "Pickup at" }),
            ts("due_back_at", { indexed: true, label: "Due back at", validation: { rule: { due_back_at: { _gte: "$field.starts_at" } }, message: "The return must be due after pickup." } }),
          ),
          // "Returned" without the hour it came back is the row that makes a
          // late fee unarguable one way or the other.
          ts("returned_at", {
            label: "Returned at",
            conditions: [when("status", "_eq", "returned", "required")],
          }),
        ]),
        sec("Totals", [
          ...half(money("subtotal"), money("deposit_held", { label: "Deposit held" })),
          ...half(money("late_fees", { label: "Late fees" }), money("total")),
        ]),
      ),
      samples: [
        { customer: { ref: "customers:0" }, status: "picked_up", starts_at: ms("2026-07-08T08:00:00Z"), due_back_at: ms("2026-07-15T08:00:00Z"), subtotal: 1250, deposit_held: 500, late_fees: 0, total: 1250 },
        { customer: { ref: "customers:0" }, status: "returned", starts_at: ms("2026-06-20T09:00:00Z"), due_back_at: ms("2026-06-22T09:00:00Z"), returned_at: ms("2026-06-23T11:00:00Z"), subtotal: 180, deposit_held: 150, late_fees: 30, total: 210 },
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
          ...half(
            // Calling it damage and leaving the charge blank is how a deposit
            // gets returned in full by accident.
            money("damage_charge", {
              label: "Damage charge",
              conditions: [when("result", "_eq", "damage", "required")],
            }),
            ts("inspected_at", { indexed: true, label: "Inspected at" }),
          ),
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
        ...half(
          text("signed_by", {
            label: "Signed by",
            conditions: [when("status", "_eq", "signed", "required")],
          }),
          ts("signed_at", { indexed: true, label: "Signed at" }),
        ),
        file("file", { label: "Signed document" }),
      ],
      samples: [{ order: { ref: "rental_orders:0" }, signed_by: "L. Hartley", signed_at: ms("2026-07-08T08:02:00Z"), status: "signed" }],
    },
    {
      slug: "bundles", group: "Catalog", singular: "Bundle", plural: "Bundles", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), money("rate_daily", { label: "Daily rate" })),
        notes("description"),
        flag("active", { label: "Active" }),
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
  /**
   * A rental desk's standing rules — mostly about time, because that is what
   * this business sells.
   *
   * Deliberately absent: holding a unit for turnaround after it comes back.
   * `rental_products.padding_hours` says how long to hold it and
   * `availability_blocks` is where the hold would go, but the UNIT is named on
   * the rental LINE, not on the order — so the flow that sees a returned order
   * has no unit to block. The inspection rule below works precisely because an
   * inspection does name its unit.
   */
  flows: [
    {
      name: "Announce a new rental order",
      trigger: "event:items:rental_orders:created",
      operations: [
        {
          type: "notification",
          title: "New rental order {{ data.number }}",
          body: "{{ data.customer.name }} — out {{ data.starts_at }}, back {{ data.due_back_at }}.",
          url: "/collections/rental_orders",
        },
      ],
    },
    {
      name: "Mark overdue rentals late every morning",
      // The one rule that pays for itself. A unit still out past its due time
      // is revenue nobody is billing and stock nobody can re-let, and `late`
      // is a status the board already has a column for.
      trigger: "cron:0 7 * * *",
      operations: [
        {
          type: "foreach",
          collection: "rental_orders",
          filter: { status: { _eq: "picked_up" }, due_back_at: { _lt: "$now" } },
          do: [
            {
              type: "item.update",
              collection: "rental_orders",
              id: "{{ $item.id }}",
              data: { status: "late" },
            },
            {
              type: "notification",
              title: "Overdue: {{ $item.number }}",
              body: "Due back {{ $item.due_back_at }} and still out. Late fees apply from today.",
              url: "/collections/rental_orders",
            },
          ],
        },
      ],
    },
    {
      name: "Remind the desk a day before a return is due",
      trigger: `schedule:${JSON.stringify({
        collection: "rental_orders",
        field: "due_back_at",
        offset: { value: 1, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "picked_up" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "{{ data.number }} is due back tomorrow",
          body: "{{ data.customer.name }} — call ahead if the unit is wanted for the next booking.",
          url: "/collections/rental_orders",
        },
      ],
    },
    {
      name: "Take a damaged unit out of service",
      // An inspection names its unit, so this one can act rather than just
      // announce: a unit that came back damaged stops being rentable the
      // moment somebody records the damage, not the next time it is noticed.
      trigger: "event:items:inspections:created",
      operations: [
        {
          type: "condition",
          filter: { result: { _eq: "damage" } },
          then: [
            {
              type: "item.update",
              collection: "units",
              id: "{{ data.unit }}",
              data: { condition: "maintenance" },
            },
            {
              type: "notification",
              title: "Damage found — unit pulled from the fleet",
              body: "{{ data.damage_charge }} charged against order {{ data.order.number }}. The unit is in maintenance until somebody clears it.",
              url: "/collections/units",
            },
          ],
        },
      ],
    },
    {
      name: "Check the agreement before a unit leaves",
      trigger: "event:items:rental_orders:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "picked_up" } },
          then: [
            {
              type: "notification",
              title: "{{ data.number }} has gone out — is it signed?",
              body: "Deposit held {{ data.deposit_held }}. A signed agreement is what makes the damage charge collectable, so check it exists before this scrolls away.",
              url: "/collections/agreements",
            },
          ],
        },
      ],
    },
    {
      name: "Email the customer their return reminder (needs email)",
      active: false,
      trigger: `schedule:${JSON.stringify({
        collection: "rental_orders",
        field: "due_back_at",
        offset: { value: 1, unit: "days", direction: "before" },
        at: 600,
        timeZone: null,
        where: { status: { _eq: "picked_up" } },
      })}`,
      operations: [
        {
          type: "email",
          to: "{{ data.customer.email }}",
          subject: "Your rental {{ data.number }} is due back tomorrow",
          html: "<p>Please return by {{ data.due_back_at }} to avoid late fees.</p>",
        },
      ],
    },
    {
      name: "Monthly rental report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Rental overview",
          subject: "Rental — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "rental_agreement",
      name: "Rental agreement",
      description: "The terms a customer signs before the unit leaves.",
      filename: "agreement-{{ data.number }}",
      variables: ["number", "starts_at"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:12.5px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:21px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:14px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:34%;color:#555;font-weight:600}" +
        "h2{font-size:13px;margin:18px 0 4px}" +
        ".sign{margin-top:30px;border-top:1px solid #333;width:55%;padding-top:6px}" +
        "</style></head><body>" +
        "<h1>Rental agreement {{ data.number }}</h1>" +
        '<p class="muted">{{ data.customer.name }} · {{ data.customer.id_document }}</p>' +
        "<table>" +
        "<tr><th>Pickup</th><td>{{ data.starts_at }}</td></tr>" +
        "<tr><th>Due back</th><td>{{ data.due_back_at }}</td></tr>" +
        "<tr><th>Rental charge</th><td>{{ data.subtotal }}</td></tr>" +
        "<tr><th>Security deposit</th><td>{{ data.deposit_held }}</td></tr>" +
        "</table>" +
        "<h2>Terms</h2>" +
        "<p>The equipment is returned by the due time above and in the condition it left in. " +
        "Late returns are charged at the daily late fee set for each product. " +
        "Damage found at post-return inspection is charged against the deposit.</p>" +
        "<!-- the rented items themselves are rows in `rental_lines` -->" +
        '<div class="sign">Customer signature · date</div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "rental_return_receipt",
      name: "Return receipt",
      description: "What the customer walks away with — including late fees.",
      filename: "return-{{ data.number }}",
      variables: ["number", "total"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:21px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:14px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:40%;color:#555;font-weight:600}" +
        ".total{margin-top:16px;font-size:17px;font-weight:600;text-align:right}" +
        "</style></head><body>" +
        "<h1>Return receipt {{ data.number }}</h1>" +
        '<p class="muted">{{ data.customer.name }}</p>' +
        "<table>" +
        "<tr><th>Out</th><td>{{ data.starts_at }}</td></tr>" +
        "<tr><th>Due back</th><td>{{ data.due_back_at }}</td></tr>" +
        "<tr><th>Returned</th><td>{{ data.returned_at }}</td></tr>" +
        "<tr><th>Rental charge</th><td>{{ data.subtotal }}</td></tr>" +
        "<tr><th>Late fees</th><td>{{ data.late_fees }}</td></tr>" +
        "<tr><th>Deposit held</th><td>{{ data.deposit_held }}</td></tr>" +
        "</table>" +
        '<div class="total">Total {{ data.total }}</div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "rental_inspection_report",
      name: "Inspection report",
      description: "The record a damage charge rests on.",
      filename: "inspection-{{ data.id }}",
      variables: ["stage", "result"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:18mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 10px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:34%;color:#555;font-weight:600}" +
        "h2{font-size:13px;margin:18px 0 4px}" +
        "</style></head><body>" +
        "<h1>Unit inspection</h1>" +
        '<p class="muted">Order {{ data.order.number }} · unit {{ data.unit.serial }}</p>' +
        "<table>" +
        "<tr><th>Stage</th><td>{{ data.stage }}</td></tr>" +
        "<tr><th>Result</th><td>{{ data.result }}</td></tr>" +
        "<tr><th>Inspected at</th><td>{{ data.inspected_at }}</td></tr>" +
        "<tr><th>Damage charge</th><td>{{ data.damage_charge }}</td></tr>" +
        "</table>" +
        "<h2>Notes</h2><p>{{ data.notes }}</p>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "18mm" },
    },
  ],
  /*
   * One form, not two. A "request a quote" form would have to write a
   * `rental_orders` row, and the customer it is for is a RELATION — not a
   * form-eligible field — so every enquiry would arrive belonging to nobody.
   * Registering the customer first is the step that actually unblocks the
   * desk, and the order is raised against a real account afterwards.
   */
  forms: [
    {
      name: "Register as a rental customer",
      collection: "customers",
      settings: {
        submitLabel: "Register",
        successMessage: "Thanks — you're on file. Bring photo ID when you collect and we'll finish the paperwork there.",
      },
      // `id_document` is deliberately NOT on this form. The desk checks the
      // document physically at pickup, so asking a stranger to type a licence
      // or registration number into a public page collects a government ID
      // over the internet for no operational gain — and the column is not
      // `private`, so anything typed here is readable by every role with read
      // on customers. The desk fills it in with the document in hand.
      fields: [
        { name: "name", label: "Name or company" },
        { name: "email", label: "Email" },
        { name: "phone" },
        { name: "notes", label: "Anything we should know?" },
      ],
    },
  ],
  agents: [
    {
      name: "Rental desk assistant",
      handle: "rental-desk-assistant",
      description: "Answers questions about what is out, what is late and what a unit has earned.",
      systemPrompt:
        "You help a rental desk. Answer questions about products, units, " +
        "orders, lines, inspections, payments and agreements using the " +
        "workspace's own data. `picked_up` and `late` both mean the unit is " +
        "OUT — only `returned` is back, and `quote` is not a commitment. " +
        "A product's `unit_count` is how many are owned, which is not how " +
        "many are free: availability is owned units minus the ones on open " +
        "orders and minus anything in `availability_blocks`, and you should " +
        "show that subtraction rather than a bare number. Money on an order " +
        "is `subtotal` plus `late_fees`; the deposit is held, not earned, so " +
        "never add it to revenue. Be brief and name the order number.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "collections.search"],
      maxSteps: 8,
    },
  ],
};
