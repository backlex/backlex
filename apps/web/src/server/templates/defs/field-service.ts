import type { SchemaTemplate } from "../types";
import { C, ch, computedMoneyIn, computedNum, date, email, file, flag, geo, half, int, money, moneyIn, ms, notes, num, phone, position, rating, rel, rollup, sec, select, seq, stacked, tabbed, text, ts, userLink, when } from "../dsl";

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
          moneyIn("monthly_fee", { label: "Monthly fee" }),
          select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
        ),
        select("status", [ch("active", C.green), ch("paused", C.amber), ch("expired", C.red)], { default: "active" }),
      ],
      samples: [{ customer: { ref: "customers:0" }, name: "Riverside boiler care plan", frequency: "quarterly", next_visit_due: ms("2026-10-01"), monthly_fee: 95, currency: "USD", status: "active" }],
    },
    {
      slug: "work_orders", group: "Work orders", singular: "Work order", plural: "Work orders", fts: true, defaultSort: "-scheduled_at",
      kanbanGroupBy: "status",
      fields: tabbed(
        sec("Job", [
          ...half(seq("number", "WO-{#####}"), text("title", { required: true, searchable: true })),
          notes("description", { searchable: true }),
          ...half(rel("customer", "customers"), rel("contract", "service_contracts", { label: "Service contract" })),
          rel("checklist", "checklists"),
          // A job raised from the public request form has no `customer` yet — a
          // stranger cannot pick one — so without somewhere to put a name and a
          // number the request lands on the board with no way to answer it.
          // Dispatch fills `customer` in once it knows who this is.
          ...half(
            text("contact_name", { label: "Contact name", description: "Who to ask for on site." }),
            phone("contact_phone", { label: "Contact phone" }),
          ),
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
          ...half(
            // A job is not done until somebody says WHEN, because that stamp is
            // what the contract's next visit and the invoice both date from.
            ts("completed_at", {
              label: "Completed at",
              conditions: [when("status", "_eq", "done", "required")],
            }),
            // The catalog's first rollup, and a non-money one on purpose: the
            // server totals this job's visits so "90 minutes estimated, 145
            // logged" is a number somebody can read off the row rather than a
            // sum they have to do by hand.
            rollup(
              "minutes_logged",
              { from: "visits", via: "work_order", fn: "sum", field: "minutes_on_site" },
              { label: "Minutes logged", description: "Totalled from this job's visits — compare against the estimate." },
            ),
          ),
        ]),
      ),
      samples: [
        { title: "AC unit not cooling — building B", description: "Tenant reports warm air from unit 2B.", customer: { ref: "customers:0" }, technician: { ref: "technicians:0" }, priority: "high", status: "scheduled", scheduled_at: ms("2026-07-15T13:00:00Z"), estimated_minutes: 90 },
        { title: "Quarterly boiler inspection", customer: { ref: "customers:0" }, contract: { ref: "service_contracts:0" }, checklist: { ref: "checklists:0" }, technician: { ref: "technicians:1" }, priority: "normal", status: "done", scheduled_at: ms("2026-07-01T09:00:00Z"), estimated_minutes: 60, completed_at: ms("2026-07-01T10:05:00Z") },
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
          // "Needs follow-up" with no note is the sentence that loses the second
          // visit — say what is outstanding while standing in front of it.
          notes("recommendations", {
            conditions: [when("outcome", "_eq", "follow_up", "required")],
          }),
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
      kanbanGroupBy: "status",
      fields: [
        ...half(rel("customer", "customers"), seq("number", "EST-{#####}")),
        ...half(moneyIn("total"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
        select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("approved", C.green), ch("declined", C.red)], { default: "draft", indexed: true }),
        notes("scope_notes", { label: "Scope notes" }),
      ],
      samples: [
        { customer: { ref: "customers:0" }, status: "approved", total: 1240, currency: "USD", scope_notes: "Replace rooftop condenser fan assembly, building B." },
        { customer: { ref: "customers:0" }, status: "sent", total: 380, currency: "USD" },
      ],
    },
    {
      slug: "estimate_lines", group: "Billing", singular: "Estimate line", plural: "Estimate lines",
      fields: [
        ...half(rel("estimate", "estimates"), text("description", { required: true })),
        ...half(num("qty", { default: 1, validation: { min: 0 } }), moneyIn("unit_price", { label: "Unit price" })),
        ...half(select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }), computedMoneyIn("line_total", "qty * unit_price", { label: "Line total" })),
      ],
      samples: [
        { estimate: { ref: "estimates:0" }, description: "Condenser fan motor (part + install)", qty: 1, unit_price: 640 },
        { estimate: { ref: "estimates:0" }, description: "Labor — rooftop access, 4h", qty: 4, unit_price: 150 },
      ],
    },
    {
      slug: "invoices", group: "Billing", singular: "Invoice", plural: "Invoices", defaultSort: "-issued_at",
      kanbanGroupBy: "status",
      fields: [
        ...half(rel("work_order", "work_orders"), rel("customer", "customers")),
        ...half(seq("number", "INV-{#####}"), moneyIn("amount")),
        select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
        ...half(
          select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("paid", C.green)], { default: "draft", indexed: true }),
          date("issued_at", { indexed: true, label: "Issued" }),
        ),
      ],
      samples: [{ work_order: { ref: "work_orders:1" }, customer: { ref: "customers:0" }, amount: 184, currency: "USD", status: "paid", issued_at: ms("2026-07-02") }],
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
  /**
   * The dispatch rules a service desk keeps in somebody's head, written down.
   *
   * `work_orders.status` declares no `flow()` lifecycle, so the completion rule
   * is an `updated` trigger narrowed by a condition rather than a transition
   * one. That re-fires if a finished job is saved again, which for a feed line
   * costs a reread — and none of these flows mails anybody while active, which
   * is the case where re-firing would actually hurt.
   *
   * Deliberately absent: routing a job to the nearest technician. `customers`
   * carries a real map pin and `technicians` a home REGION — a word, not a
   * point — so there is nothing to measure a distance against. Distance
   * filtering is a query the dispatcher runs (see docs/geo.md), not a rule the
   * server can apply on its own.
   */
  flows: [
    {
      name: "Put a new job on the board",
      trigger: "event:items:work_orders:created",
      operations: [
        {
          type: "condition",
          filter: { priority: { _eq: "urgent" } },
          then: [
            {
              type: "notification",
              title: "URGENT job raised: {{ data.title }}",
              body: "{{ data.number }} for {{ data.customer.name }}. Urgent means today — assign a technician before this scrolls.",
              url: "/collections/work_orders",
            },
          ],
          else: [
            {
              type: "notification",
              title: "New job: {{ data.title }}",
              body: "{{ data.number }} for {{ data.customer.name }}, {{ data.priority }} priority.",
              url: "/collections/work_orders",
            },
          ],
        },
      ],
    },
    {
      name: "Ask for the invoice when a job is finished",
      trigger: "event:items:work_orders:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "done" } },
          then: [
            {
              type: "notification",
              title: "{{ data.number }} is done — invoice it",
              body: "{{ data.title }} for {{ data.customer.name }}, finished {{ data.completed_at }}. Estimated {{ data.estimated_minutes }} minutes against {{ data.minutes_logged }} logged.",
              url: "/collections/invoices",
            },
          ],
        },
      ],
    },
    {
      name: "Sweep jobs nobody has scheduled",
      // Every weekday morning, before the vans leave. A job sitting at `new`
      // with no date is the one failure mode of a dispatch board: it is not
      // late yet, so nothing else complains about it.
      trigger: "cron:0 7 * * 1-5",
      operations: [
        {
          type: "foreach",
          collection: "work_orders",
          filter: { status: { _eq: "new" }, scheduled_at: { _null: true } },
          do: [
            {
              type: "notification",
              title: "Unscheduled: {{ $item.title }}",
              body: "Raised as {{ $item.number }} and still has no date on it.",
              url: "/collections/work_orders",
            },
          ],
        },
      ],
    },
    {
      name: "Raise the next contract visit a week ahead",
      // The contract is the promise; this is what turns it into dispatched
      // work. One job per contract, seven days before it falls due, and only
      // while the contract is live — a paused plan should not keep generating.
      trigger: `schedule:${JSON.stringify({
        collection: "service_contracts",
        field: "next_visit_due",
        offset: { value: 7, unit: "days", direction: "before" },
        at: 480,
        timeZone: null,
        where: { status: { _eq: "active" } },
      })}`,
      operations: [
        {
          type: "item.create",
          collection: "work_orders",
          data: {
            title: "{{ data.name }}",
            description: "Scheduled visit under the {{ data.frequency }} service contract.",
            customer: "{{ data.customer }}",
            contract: "{{ data.id }}",
            status: "new",
            priority: "normal",
          },
        },
        {
          type: "notification",
          title: "Contract visit raised: {{ data.name }}",
          body: "Due {{ data.next_visit_due }}. The job is on the board unassigned — give it a technician and a date.",
          url: "/collections/work_orders",
        },
      ],
    },
    {
      name: "Chase an invoice still unpaid after two weeks",
      trigger: `schedule:${JSON.stringify({
        collection: "invoices",
        field: "issued_at",
        offset: { value: 14, unit: "days", direction: "after" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "sent" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "{{ data.number }} is two weeks old and unpaid",
          body: "{{ data.amount }} from {{ data.customer.name }}, issued {{ data.issued_at }}.",
          url: "/collections/invoices",
        },
      ],
    },
    {
      name: "Email the invoice to the customer (needs email)",
      active: false,
      trigger: "event:items:invoices:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "sent" } },
          then: [
            {
              type: "email",
              to: "{{ data.customer.email }}",
              subject: "Invoice {{ data.number }}",
              html: "<p>Your invoice for {{ data.amount }} is attached to your account.</p>",
            },
          ],
        },
      ],
    },
    {
      name: "Monthly field operations report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Field operations",
          subject: "Field service — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "field_work_order",
      name: "Job sheet",
      description: "What a technician takes to site.",
      filename: "job-{{ data.number }}",
      variables: ["number", "title"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:16mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:22px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        ".box{border:1px solid #ddd;border-radius:6px;padding:10px;margin-top:14px}" +
        "table{width:100%;border-collapse:collapse}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee;vertical-align:top}" +
        "th{width:32%;color:#555;font-weight:600}" +
        ".sign{margin-top:28px;border-top:1px solid #333;width:60%;padding-top:6px}" +
        "</style></head><body>" +
        "<h1>{{ data.title }}</h1>" +
        '<p class="muted">{{ data.number }} · {{ data.priority }} priority</p>' +
        "<table>" +
        "<tr><th>Customer</th><td>{{ data.customer.name }}</td></tr>" +
        "<tr><th>Address</th><td>{{ data.customer.address }}, {{ data.customer.city }}</td></tr>" +
        "<tr><th>Access</th><td>{{ data.customer.access_notes }}</td></tr>" +
        "<tr><th>Technician</th><td>{{ data.technician.name }}</td></tr>" +
        "<tr><th>Scheduled</th><td>{{ data.scheduled_at }}</td></tr>" +
        "<tr><th>Estimate</th><td>{{ data.estimated_minutes }} minutes</td></tr>" +
        "</table>" +
        '<div class="box"><strong>Reported problem</strong><p>{{ data.description }}</p></div>' +
        '<div class="box"><strong>Work performed</strong><p class="muted">Write on site.</p></div>' +
        '<div class="sign">Customer signature</div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "16mm" },
    },
    {
      key: "field_worksheet",
      name: "Completion worksheet",
      description: "The signed record of what was done.",
      filename: "worksheet-{{ data.id }}",
      variables: ["work_performed", "outcome"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:18mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 10px}" +
        ".muted{color:#666}" +
        "h2{font-size:14px;margin:18px 0 4px}" +
        ".sign{margin-top:26px;border-top:1px solid #333;width:55%;padding-top:6px}" +
        "</style></head><body>" +
        "<h1>Completion worksheet</h1>" +
        '<p class="muted">Job {{ data.work_order.number }} — {{ data.work_order.title }}</p>' +
        "<h2>Work performed</h2><p>{{ data.work_performed }}</p>" +
        "<h2>Recommendations</h2><p>{{ data.recommendations }}</p>" +
        "<h2>Outcome</h2><p>{{ data.outcome }}</p>" +
        '<div class="sign">{{ data.signed_by }} · {{ data.signed_at }}</div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "18mm" },
    },
    {
      key: "field_estimate",
      name: "Estimate",
      description: "The quoted scope a customer approves before work starts.",
      filename: "estimate-{{ data.number }}",
      variables: ["number", "total"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:22px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        ".total{margin-top:18px;font-size:17px;font-weight:600;text-align:right}" +
        ".sign{margin-top:30px;border-top:1px solid #333;width:55%;padding-top:6px}" +
        "</style></head><body>" +
        "<h1>Estimate {{ data.number }}</h1>" +
        '<p class="muted">{{ data.customer.name }}</p>' +
        "<p>{{ data.scope_notes }}</p>" +
        "<!-- line items live in `estimate_lines`, one row per line -->" +
        '<div class="total">Total {{ data.total }}</div>' +
        '<div class="sign">Approved by / date</div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      name: "Request a service call",
      collection: "work_orders",
      settings: {
        submitLabel: "Request a visit",
        successMessage: "Thanks — your request is on the dispatch board and we'll confirm a date shortly.",
      },
      fields: [
        { name: "title", label: "What needs looking at?" },
        { name: "description", label: "Tell us more" },
        { name: "priority", label: "How urgent is it?" },
        // Without these the dispatcher gets a job and no way to call anybody.
        // Not marked required: a bundled form exposes fields, and requiredness
        // lives on the collection field — making these mandatory there would
        // also block the jobs dispatch raises itself, which often have a
        // customer record instead of a phone number typed by a stranger.
        { name: "contact_name", label: "Your name", help: "So we know who to ask for." },
        { name: "contact_phone", label: "Phone we can reach you on", help: "We confirm the visit on this number." },
      ],
    },
    {
      name: "New service customer",
      collection: "customers",
      settings: {
        submitLabel: "Register",
        successMessage: "Thanks — we have your details and your service address.",
      },
      fields: [
        { name: "name", label: "Name" },
        { name: "email", label: "Email" },
        { name: "phone" },
        { name: "address", label: "Service address" },
        { name: "city" },
        { name: "postal_code", label: "Postal code" },
        { name: "access_notes", label: "How do we get in?" },
      ],
    },
  ],
  agents: [
    {
      name: "Dispatch assistant",
      handle: "dispatch-assistant",
      description: "Answers questions about job load, technician time and what is still unbilled.",
      systemPrompt:
        "You help a field service desk run its board. Answer questions about " +
        "work orders, visits, technicians, parts, contracts, estimates and " +
        "invoices using the workspace's own data. A job's real time is " +
        "`minutes_logged`, which the server totals from its visits — " +
        "`estimated_minutes` is what somebody guessed beforehand, and the gap " +
        "between them is usually the interesting part. `en_route` and " +
        "`in_progress` both mean the job is live today; only `done` is " +
        "finished, and `cancelled` is not a completion. Unbilled work is a job " +
        "that is done with no invoice pointing at it. Technicians have a home " +
        "REGION, not a location, so you cannot answer who is nearest — say so " +
        "and suggest filtering by distance from the customer's map pin " +
        "instead. Be brief and name the job number you mean.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "collections.search"],
      maxSteps: 8,
    },
  ],
};
