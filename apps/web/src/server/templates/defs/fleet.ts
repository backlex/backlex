import type { SchemaTemplate } from "../types";
import { C, ch, date, email, flag, half, int, money, ms, notes, num, phone, rel, rollup, sec, select, stacked, tabbed, text, ts, when } from "../dsl";

export const fleet: SchemaTemplate = {
  id: "fleet",
  label: "Fleet",
  groups: ["Fleet", "Usage", "Costs", "Compliance"],
  description:
    "Odoo Fleet-grade vehicle management: vehicles with model/plate/status, drivers and assignment history, lease & insurance contracts with renewal dates, odometer and fuel logs, service records with costs, incidents with claim tracking, traffic fines, and periodic inspections.",
  collections: [
    {
      slug: "drivers", group: "Fleet", singular: "Driver", plural: "Drivers", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), email("email")),
        ...half(phone("phone"), text("license_no", { label: "License no." })),
        ...half(date("license_expires", { label: "License expires" }), flag("active", { label: "Active" })),
      ],
      samples: [{ name: "Priya Nair", email: "priya@example.com", license_no: "D-4471820", license_expires: ms("2028-03-01"), active: true }, { name: "Tom Becker", email: "tom@example.com", license_no: "D-9982710", license_expires: ms("2027-09-15"), active: true }],
    },
    {
      slug: "vehicles", group: "Fleet", singular: "Vehicle", plural: "Vehicles", fts: true, defaultSort: "name",
      kanbanGroupBy: "status",
      fields: tabbed(
        sec("Vehicle", [
          ...half(text("name", { required: true, searchable: true }), int("year", { validation: { min: 1980, max: 2100 } })),
          ...half(text("make"), text("model")),
          ...half(text("plate", { unique: true, label: "License plate" }), text("vin", { label: "VIN" })),
        ]),
        sec("Specs", [
          ...half(
            select("fuel_type", [ch("gasoline", C.amber), ch("diesel", C.slate), ch("hybrid", C.teal), ch("electric", C.green)], { default: "gasoline", label: "Fuel" }),
            select("status", [ch("ordered", C.gray), ch("active", C.green), ch("in_service", C.amber, "In service"), ch("retired", C.slate), ch("sold", C.blue)], { default: "active" }),
          ),
          ...half(
            rel("current_driver", "drivers", { label: "Current driver" }),
            // A vehicle's mileage is not a number somebody types on the
            // vehicle — it is the highest reading anybody has logged against
            // it, which is exactly what `max` says. Kept by the server, it
            // stops being a figure that drifts every time a log is added and
            // nobody remembers to copy it up.
            rollup(
              "odometer",
              { from: "odometer_logs", via: "vehicle", fn: "max", field: "reading" },
              { label: "Odometer (km)", description: "Highest logged reading — add an odometer log to move it." },
            ),
          ),
        ]),
        sec("Acquisition", [
          ...half(money("acquisition_cost", { label: "Acquisition cost" }), date("acquired_at", { label: "Acquired" })),
        ]),
      ),
      samples: [
        { name: "Van 12", make: "Ford", model: "Transit", year: 2024, plate: "7-KLM-482", fuel_type: "diesel", status: "active", current_driver: { ref: "drivers:0" }, acquisition_cost: 42000, acquired_at: ms("2024-05-01") },
        { name: "Car 3", make: "Tesla", model: "Model 3", year: 2025, plate: "9-EV-2210", fuel_type: "electric", status: "active", current_driver: { ref: "drivers:1" }, acquisition_cost: 39000, acquired_at: ms("2025-02-14") },
      ],
    },
    {
      slug: "assignments", group: "Usage", singular: "Assignment", plural: "Assignments", defaultSort: "-assigned_at",
      fields: [
        ...half(rel("vehicle", "vehicles"), rel("driver", "drivers")),
        ...half(ts("assigned_at", { indexed: true, label: "Assigned at" }), ts("returned_at", { label: "Returned at" })),
        notes("note"),
      ],
      samples: [{ vehicle: { ref: "vehicles:0" }, driver: { ref: "drivers:0" }, assigned_at: ms("2026-01-05T08:00:00Z") }],
    },
    {
      slug: "contracts", group: "Costs", singular: "Contract", plural: "Contracts", defaultSort: "-ends_at",
      fields: stacked(
        sec("Contract", [
          ...half(
            rel("vehicle", "vehicles"),
            select("type", [ch("lease", C.blue), ch("insurance", C.teal), ch("warranty", C.purple), ch("service_plan", C.amber, "Service plan")], { default: "lease" }),
          ),
          ...half(text("provider"), text("reference")),
        ]),
        sec("Term & cost", [
          ...half(date("starts_at", { range: { end: "ends_at", bounds: "[]" }, label: "Starts" }), date("ends_at", { indexed: true, label: "Ends" })),
          ...half(
            money("monthly_cost", { label: "Monthly cost" }),
            select("status", [ch("active", C.green), ch("expiring", C.amber), ch("expired", C.red), ch("cancelled", C.slate)], { default: "active" }),
          ),
        ]),
      ),
      samples: [{ vehicle: { ref: "vehicles:0" }, type: "insurance", provider: "Allianz", reference: "POL-88213", starts_at: ms("2026-01-01"), ends_at: ms("2026-12-31"), monthly_cost: 110, status: "active" }],
    },
    {
      slug: "odometer_logs", group: "Usage", singular: "Odometer log", plural: "Odometer logs", defaultSort: "-logged_at",
      fields: [
        ...half(rel("vehicle", "vehicles"), rel("driver", "drivers")),
        ...half(int("reading", { validation: { min: 0 }, label: "Reading (km)" }), date("logged_at", { indexed: true, label: "Logged at" })),
      ],
      // These readings are what the vehicles' odometers roll up FROM — every
      // vehicle needs at least one or its mileage reads empty on arrival.
      samples: [
        { vehicle: { ref: "vehicles:0" }, driver: { ref: "drivers:0" }, reading: 48210, logged_at: ms("2026-07-01") },
        { vehicle: { ref: "vehicles:1" }, driver: { ref: "drivers:1" }, reading: 15890, logged_at: ms("2026-07-01") },
      ],
    },
    {
      slug: "service_records", group: "Costs", singular: "Service record", plural: "Service records", defaultSort: "-serviced_at",
      fields: [
        ...half(
          rel("vehicle", "vehicles"),
          select("service_type", [ch("maintenance", C.blue), ch("repair", C.red), ch("tires", C.slate), ch("inspection", C.teal), ch("fuel", C.amber), ch("other", C.gray)], { default: "maintenance", label: "Type" }),
        ),
        ...half(text("vendor"), money("cost")),
        ...half(int("odometer_at", { validation: { min: 0 }, label: "Odometer (km)" }), date("serviced_at", { indexed: true, label: "Serviced at" })),
        notes("notes"),
      ],
      samples: [
        { vehicle: { ref: "vehicles:0" }, service_type: "maintenance", vendor: "Ford Service Center", cost: 320, odometer_at: 45000, serviced_at: ms("2026-05-20"), notes: "45k service — oil, filters, brake check." },
        { vehicle: { ref: "vehicles:1" }, service_type: "tires", vendor: "QuickTire", cost: 540, odometer_at: 15000, serviced_at: ms("2026-06-11") },
      ],
    },
    {
      slug: "fuel_logs", group: "Usage", singular: "Fuel log", plural: "Fuel logs", defaultSort: "-filled_at",
      fields: [
        ...half(rel("vehicle", "vehicles"), rel("driver", "drivers")),
        ...half(date("filled_at", { indexed: true, label: "Filled at" }), text("station")),
        ...half(num("liters", { validation: { min: 0 } }), money("cost")),
        int("odometer_at", { validation: { min: 0 }, label: "Odometer (km)" }),
      ],
      samples: [
        { vehicle: { ref: "vehicles:0" }, driver: { ref: "drivers:0" }, filled_at: ms("2026-07-03"), liters: 62.4, cost: 108.5, odometer_at: 48350, station: "Shell — Ring Rd" },
        { vehicle: { ref: "vehicles:0" }, driver: { ref: "drivers:0" }, filled_at: ms("2026-06-24"), liters: 58, cost: 101.2, odometer_at: 47610, station: "BP Central" },
      ],
    },
    {
      slug: "incidents", group: "Compliance", singular: "Incident", plural: "Incidents", defaultSort: "-occurred_at",
      // Named on purpose: auto-detect would pick `kind`, the first dropdown,
      // but what an incident MOVES through is its claim.
      kanbanGroupBy: "claim_status",
      fields: stacked(
        sec("Incident", [
          ...half(rel("vehicle", "vehicles"), rel("driver", "drivers")),
          ...half(
            ts("occurred_at", { indexed: true, label: "Occurred at" }),
            select("kind", [ch("accident", C.red), ch("theft", C.purple), ch("vandalism", C.amber), ch("breakdown", C.slate)], { default: "accident" }),
          ),
          select("severity", [ch("minor", C.gray), ch("moderate", C.amber), ch("major", C.red), ch("total_loss", C.slate, "Total loss")], { default: "minor" }),
          notes("description"),
        ]),
        sec("Claim", [
          ...half(
            select("claim_status", [ch("none", C.gray), ch("filed", C.blue), ch("approved", C.green), ch("denied", C.red), ch("paid", C.teal)], { default: "none", label: "Claim" }),
            // No insurer opens a claim without a figure attached to it.
            money("cost", {
              conditions: [when("claim_status", "_nin", ["none"], "required")],
            }),
          ),
        ]),
      ),
      samples: [{ vehicle: { ref: "vehicles:0" }, driver: { ref: "drivers:0" }, occurred_at: ms("2026-06-02T16:40:00Z"), kind: "accident", severity: "minor", description: "Rear bumper scrape while reversing at the depot.", claim_status: "filed", cost: 480 }],
    },
    {
      slug: "fines", group: "Compliance", singular: "Fine", plural: "Fines", defaultSort: "-issued_at",
      kanbanGroupBy: "status",
      fields: [
        ...half(rel("vehicle", "vehicles"), rel("driver", "drivers")),
        ...half(
          date("issued_at", { indexed: true, label: "Issued" }),
          select("kind", [ch("speeding", C.red), ch("parking", C.amber), ch("toll", C.blue), ch("other", C.gray)], { default: "parking" }),
        ),
        ...half(
          money("amount"),
          select("status", [ch("unpaid", C.amber), ch("paid", C.green), ch("disputed", C.purple)], { default: "unpaid" }),
        ),
        // Not a sequence: the authority printed this number, not us. Disputing
        // one without quoting it is a letter that goes nowhere.
        text("reference", {
          label: "Reference no.",
          conditions: [when("status", "_eq", "disputed", "required")],
        }),
      ],
      samples: [
        { vehicle: { ref: "vehicles:1" }, driver: { ref: "drivers:1" }, issued_at: ms("2026-06-18"), kind: "parking", amount: 45, status: "paid", reference: "PK-20260618-771" },
        { vehicle: { ref: "vehicles:0" }, driver: { ref: "drivers:0" }, issued_at: ms("2026-07-05"), kind: "speeding", amount: 120, status: "unpaid", reference: "SP-20260705-034" },
      ],
    },
    {
      slug: "inspections", group: "Compliance", singular: "Inspection", plural: "Inspections", defaultSort: "due_at",
      fields: [
        ...half(
          rel("vehicle", "vehicles"),
          select("kind", [ch("periodic", C.blue), ch("emissions", C.teal), ch("insurance", C.purple), ch("pre_trip", C.amber, "Pre-trip")], { default: "periodic" }),
        ),
        ...half(
          date("due_at", { indexed: true, label: "Due" }),
          // Passed or failed, somebody stood next to the vehicle on a day —
          // and that date is what the next due date counts from.
          date("performed_at", {
            label: "Performed",
            conditions: [when("result", "_neq", "pending", "required")],
          }),
        ),
        select("result", [ch("passed", C.green), ch("failed", C.red), ch("pending", C.amber)], { default: "pending" }),
        notes("notes"),
      ],
      samples: [
        { vehicle: { ref: "vehicles:0" }, kind: "periodic", due_at: ms("2026-05-01"), performed_at: ms("2026-04-28"), result: "passed" },
        { vehicle: { ref: "vehicles:1" }, kind: "emissions", due_at: ms("2026-09-01"), result: "pending" },
      ],
    },
  ],
  roles: [
    {
      name: "Fleet manager",
      description: "Manage vehicles, assignments, contracts, service records, incidents, fines and inspections.",
      permissions: [
        { collection: "drivers", action: "read" },
        { collection: "drivers", action: "create" },
        { collection: "drivers", action: "update" },
        { collection: "vehicles", action: "read" },
        { collection: "vehicles", action: "create" },
        { collection: "vehicles", action: "update" },
        { collection: "assignments", action: "read" },
        { collection: "assignments", action: "create" },
        { collection: "assignments", action: "update" },
        { collection: "contracts", action: "read" },
        { collection: "contracts", action: "create" },
        { collection: "contracts", action: "update" },
        { collection: "odometer_logs", action: "read" },
        { collection: "odometer_logs", action: "create" },
        { collection: "service_records", action: "read" },
        { collection: "service_records", action: "create" },
        { collection: "service_records", action: "update" },
        { collection: "fuel_logs", action: "read" },
        { collection: "fuel_logs", action: "create" },
        { collection: "fuel_logs", action: "update" },
        { collection: "incidents", action: "read" },
        { collection: "incidents", action: "create" },
        { collection: "incidents", action: "update" },
        { collection: "fines", action: "read" },
        { collection: "fines", action: "create" },
        { collection: "fines", action: "update" },
        { collection: "inspections", action: "read" },
        { collection: "inspections", action: "create" },
        { collection: "inspections", action: "update" },
      ],
    },
    {
      name: "Driver",
      description: "Self-service for assigned vehicles: log fuel, odometer readings and incidents; see fines and inspections.",
      permissions: [
        { collection: "vehicles", action: "read" },
        { collection: "assignments", action: "read" },
        { collection: "odometer_logs", action: "read" },
        { collection: "odometer_logs", action: "create" },
        { collection: "fuel_logs", action: "read" },
        { collection: "fuel_logs", action: "create" },
        { collection: "incidents", action: "read" },
        { collection: "incidents", action: "create" },
        { collection: "fines", action: "read" },
        { collection: "inspections", action: "read" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Fleet overview",
      description: "Fleet size, running costs, fuel, incidents and compliance.",
      panels: [
        { name: "Vehicles", kind: "items-aggregate", viz: "counter", config: { collection: "vehicles", agg: "count" } },
        { name: "Service spend", kind: "items-aggregate", viz: "counter", config: { collection: "service_records", agg: "sum", field: "cost" } },
        { name: "Monthly contracts", kind: "items-aggregate", viz: "counter", config: { collection: "contracts", agg: "sum", field: "monthly_cost" } },
        { name: "Fuel spend", kind: "items-aggregate", viz: "counter", config: { collection: "fuel_logs", agg: "sum", field: "cost" } },
        { name: "Vehicles by status", kind: "items-aggregate", viz: "donut", config: { collection: "vehicles", agg: "count", groupBy: "status" } },
        { name: "Service by type", kind: "items-aggregate", viz: "bars", config: { collection: "service_records", agg: "count", groupBy: "service_type" } },
        { name: "Incidents by kind", kind: "items-aggregate", viz: "bars", config: { collection: "incidents", agg: "count", groupBy: "kind" } },
        { name: "Fines by status", kind: "items-aggregate", viz: "donut", config: { collection: "fines", agg: "count", groupBy: "status" } },
      ],
    },
  ],
  /**
   * Fleet work is almost entirely dates falling due, so most of these are
   * schedules — the one thing a fleet manager cannot do by looking harder at a
   * list is be reminded of it a month early.
   *
   * NO sequences in this template, deliberately. Every number here was printed
   * by somebody else: a fine's `reference` comes from the authority, a
   * contract's from the insurer or lessor, and a plate and VIN from the
   * registry. Issuing our own would invent a second identifier for a thing
   * that already has one.
   */
  flows: [
    {
      name: "Warn a month before a driving licence expires",
      trigger: `schedule:${JSON.stringify({
        collection: "drivers",
        field: "license_expires",
        offset: { value: 30, unit: "days", direction: "before" },
        at: 480,
        timeZone: null,
        where: { active: { _eq: true } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "{{ data.name }}'s licence expires in a month",
          body: "Licence {{ data.license_no }} runs out {{ data.license_expires }}. An expired licence puts every trip they drive outside the insurance.",
          url: "/collections/drivers",
        },
      ],
    },
    {
      name: "Warn a month before a contract ends",
      trigger: `schedule:${JSON.stringify({
        collection: "contracts",
        field: "ends_at",
        offset: { value: 30, unit: "days", direction: "before" },
        at: 480,
        timeZone: null,
        where: { status: { _eq: "active" } },
      })}`,
      operations: [
        {
          type: "item.update",
          collection: "contracts",
          id: "{{ data.id }}",
          data: { status: "expiring" },
        },
        {
          type: "notification",
          title: "{{ data.type }} contract ends in a month",
          body: "{{ data.provider }} ({{ data.reference }}) for {{ data.vehicle.name }} ends {{ data.ends_at }}. Renew or let it lapse on purpose.",
          url: "/collections/contracts",
        },
      ],
    },
    {
      name: "Expire contracts that have run out",
      // The status column only tells the truth if something moves it. This is
      // the piece that keeps "active contracts" on the dashboard honest.
      trigger: "cron:0 6 * * *",
      operations: [
        {
          type: "foreach",
          collection: "contracts",
          filter: { ends_at: { _lt: "$now" }, status: { _in: ["active", "expiring"] } },
          do: [
            {
              type: "item.update",
              collection: "contracts",
              id: "{{ $item.id }}",
              data: { status: "expired" },
            },
          ],
        },
      ],
    },
    {
      name: "Warn two weeks before an inspection is due",
      trigger: `schedule:${JSON.stringify({
        collection: "inspections",
        field: "due_at",
        offset: { value: 14, unit: "days", direction: "before" },
        at: 480,
        timeZone: null,
        where: { result: { _eq: "pending" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "{{ data.kind }} inspection due for {{ data.vehicle.name }}",
          body: "Due {{ data.due_at }}. Book it now — a vehicle that misses one is off the road until it passes.",
          url: "/collections/inspections",
        },
      ],
    },
    {
      name: "Chase unpaid fines every Monday",
      trigger: "cron:0 9 * * 1",
      operations: [
        {
          type: "foreach",
          collection: "fines",
          filter: { status: { _eq: "unpaid" } },
          do: [
            {
              type: "notification",
              title: "Unpaid {{ $item.kind }} fine — {{ $item.amount }}",
              body: "Issued {{ $item.issued_at }}, reference {{ $item.reference }}. Most authorities raise the amount after a deadline.",
              url: "/collections/fines",
            },
          ],
        },
      ],
    },
    {
      name: "Take a vehicle off the road after a major incident",
      // Only `major`. A `total_loss` is an insurance decision about whether
      // the vehicle exists any more — `retired` or `sold` is somebody's call
      // to make with the claim in front of them, not a status a rule flips.
      trigger: "event:items:incidents:created",
      operations: [
        {
          type: "condition",
          filter: { severity: { _eq: "major" } },
          then: [
            {
              type: "item.update",
              collection: "vehicles",
              id: "{{ data.vehicle }}",
              data: { status: "in_service" },
            },
            {
              type: "notification",
              title: "Major incident — {{ data.vehicle.name }} pulled off the road",
              body: "{{ data.kind }} on {{ data.occurred_at }}, driver {{ data.driver.name }}. The vehicle is marked in service; file the claim while the detail is fresh.",
              url: "/collections/incidents",
            },
          ],
        },
      ],
    },
    {
      name: "Tell a driver about their unpaid fine (needs email)",
      active: false,
      trigger: "event:items:fines:created",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "unpaid" } },
          then: [
            {
              type: "email",
              to: "{{ data.driver.email }}",
              subject: "A {{ data.kind }} fine was issued against your vehicle",
              html: "<p>{{ data.amount }} issued on {{ data.issued_at }}, reference {{ data.reference }}. Contact the fleet desk if you believe it is wrong.</p>",
            },
          ],
        },
      ],
    },
    {
      name: "Monthly fleet report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Fleet overview",
          subject: "Fleet — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "fleet_vehicle_file",
      name: "Vehicle file",
      description: "The one-page record an auditor, buyer or new manager asks for.",
      filename: "vehicle-{{ data.plate }}",
      variables: ["name", "plate"],
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
        '<p class="muted">{{ data.make }} {{ data.model }} · {{ data.year }}</p>' +
        "<table>" +
        "<tr><th>Plate</th><td>{{ data.plate }}</td></tr>" +
        "<tr><th>VIN</th><td>{{ data.vin }}</td></tr>" +
        "<tr><th>Fuel</th><td>{{ data.fuel_type }}</td></tr>" +
        "<tr><th>Status</th><td>{{ data.status }}</td></tr>" +
        "<tr><th>Odometer</th><td>{{ data.odometer }} km</td></tr>" +
        "<tr><th>Current driver</th><td>{{ data.current_driver.name }}</td></tr>" +
        "<tr><th>Acquired</th><td>{{ data.acquired_at }} for {{ data.acquisition_cost }}</td></tr>" +
        "</table>" +
        "<!-- service history, fuel and incidents are rows in their own " +
        "collections, filtered by this vehicle -->" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "18mm" },
    },
    {
      key: "fleet_incident_report",
      name: "Incident report",
      description: "What goes to the insurer with the claim.",
      filename: "incident-{{ data.id }}",
      variables: ["kind", "severity"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 10px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:34%;color:#555;font-weight:600}" +
        "h2{font-size:13px;margin:18px 0 4px}" +
        ".sign{margin-top:28px;border-top:1px solid #333;width:55%;padding-top:6px}" +
        "</style></head><body>" +
        "<h1>Incident report</h1>" +
        '<p class="muted">{{ data.vehicle.name }} · {{ data.vehicle.plate }}</p>' +
        "<table>" +
        "<tr><th>Occurred</th><td>{{ data.occurred_at }}</td></tr>" +
        "<tr><th>Kind</th><td>{{ data.kind }}</td></tr>" +
        "<tr><th>Severity</th><td>{{ data.severity }}</td></tr>" +
        "<tr><th>Driver</th><td>{{ data.driver.name }} — licence {{ data.driver.license_no }}</td></tr>" +
        "<tr><th>Claim</th><td>{{ data.claim_status }} · {{ data.cost }}</td></tr>" +
        "</table>" +
        "<h2>What happened</h2><p>{{ data.description }}</p>" +
        '<div class="sign">Driver signature · date</div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "fleet_handover",
      name: "Vehicle handover note",
      description: "Signed when a vehicle changes hands between drivers.",
      filename: "handover-{{ data.id }}",
      variables: ["assigned_at"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 10px}" +
        "table{width:100%;border-collapse:collapse}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:34%;color:#555;font-weight:600}" +
        ".muted{color:#666}" +
        ".sign{margin-top:34px;border-top:1px solid #333;width:55%;padding-top:6px}" +
        "</style></head><body>" +
        "<h1>Vehicle handover</h1>" +
        "<table>" +
        "<tr><th>Vehicle</th><td>{{ data.vehicle.name }} — {{ data.vehicle.plate }}</td></tr>" +
        "<tr><th>Odometer at handover</th><td>{{ data.vehicle.odometer }} km</td></tr>" +
        "<tr><th>Driver</th><td>{{ data.driver.name }}</td></tr>" +
        "<tr><th>Licence</th><td>{{ data.driver.license_no }}, expires {{ data.driver.license_expires }}</td></tr>" +
        "<tr><th>Assigned</th><td>{{ data.assigned_at }}</td></tr>" +
        "</table>" +
        "<p>{{ data.note }}</p>" +
        '<p class="muted">The driver confirms the vehicle was received in working order, ' +
        "with the documents and equipment it is registered to carry.</p>" +
        '<div class="sign">Driver signature · date</div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      name: "Driver registration",
      collection: "drivers",
      settings: {
        submitLabel: "Register",
        successMessage: "Thanks — the fleet desk will assign you a vehicle and confirm.",
      },
      fields: [
        { name: "name", label: "Full name" },
        { name: "email", label: "Work email" },
        { name: "phone" },
        { name: "license_no", label: "Licence number" },
        { name: "license_expires", label: "Licence expiry", description: "We warn you a month before it runs out." },
      ],
    },
  ],
  agents: [
    {
      name: "Fleet analyst",
      handle: "fleet-analyst",
      description: "Answers questions about running costs, mileage and what is due.",
      systemPrompt:
        "You help a fleet manager. Answer questions about vehicles, drivers, " +
        "contracts, service records, fuel, incidents, fines and inspections " +
        "using the workspace's own data. A vehicle's `odometer` is kept by " +
        "the server as the highest logged reading, so distance travelled " +
        "between two dates comes from the odometer LOGS, not from that " +
        "column. Cost per kilometre is service plus fuel plus contract cost " +
        "over distance — say which of the three you included, because people " +
        "mean different things by it. `in_service` means the vehicle is off " +
        "the road being worked on, not that it is in use; `active` is the one " +
        "that means available. Fines belong to a driver as well as a vehicle. " +
        "Be brief, name the plate, and say when a figure is missing rather " +
        "than treating an empty column as zero.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "collections.search"],
      maxSteps: 8,
    },
  ],
};
