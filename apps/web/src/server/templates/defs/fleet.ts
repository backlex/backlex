import type { SchemaTemplate } from "../types";
import { C, ch, date, email, flag, half, int, money, ms, notes, num, phone, rel, sec, select, stacked, tabbed, text, ts } from "../dsl";

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
          ...half(rel("current_driver", "drivers", { label: "Current driver" }), int("odometer", { default: 0, validation: { min: 0 }, label: "Odometer (km)" })),
        ]),
        sec("Acquisition", [
          ...half(money("acquisition_cost", { label: "Acquisition cost" }), date("acquired_at", { label: "Acquired" })),
        ]),
      ),
      samples: [
        { name: "Van 12", make: "Ford", model: "Transit", year: 2024, plate: "7-KLM-482", fuel_type: "diesel", status: "active", current_driver: { ref: "drivers:0" }, odometer: 48210, acquisition_cost: 42000, acquired_at: ms("2024-05-01") },
        { name: "Car 3", make: "Tesla", model: "Model 3", year: 2025, plate: "9-EV-2210", fuel_type: "electric", status: "active", current_driver: { ref: "drivers:1" }, odometer: 15890, acquisition_cost: 39000, acquired_at: ms("2025-02-14") },
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
      samples: [{ vehicle: { ref: "vehicles:0" }, driver: { ref: "drivers:0" }, reading: 48210, logged_at: ms("2026-07-01") }],
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
            money("cost"),
          ),
        ]),
      ),
      samples: [{ vehicle: { ref: "vehicles:0" }, driver: { ref: "drivers:0" }, occurred_at: ms("2026-06-02T16:40:00Z"), kind: "accident", severity: "minor", description: "Rear bumper scrape while reversing at the depot.", claim_status: "filed", cost: 480 }],
    },
    {
      slug: "fines", group: "Compliance", singular: "Fine", plural: "Fines", defaultSort: "-issued_at",
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
        text("reference", { label: "Reference no." }),
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
        ...half(date("due_at", { indexed: true, label: "Due" }), date("performed_at", { label: "Performed" })),
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
};
