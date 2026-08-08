import type { SchemaTemplate } from "../types";
import { C, bool, ch, date, divider, email, file, half, hint, int, money, ms, notes, num, phone, rel, sec, select, stacked, tabbed, text, ts, userLink } from "../dsl";

export const clinic: SchemaTemplate = {
  id: "clinic",
  label: "Clinic / Health",
  groups: ["Patients", "Scheduling", "Care", "Billing"],
  description:
    "Clinic-grade patient ops: patients with insurance and allergy info, practitioners, services, rooms, appointments with status flow, visit notes, vitals, lab results and prescriptions — plus invoicing with payments and patient recall reminders, with a Reception role that never sees clinical records.",
  collections: [
    {
      slug: "practitioners", group: "Scheduling", singular: "Practitioner", plural: "Practitioners", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), text("title", { label: "Title" })),
        ...half(text("specialty"), email("email")),
        bool("active", { default: true, label: "Active" }),
      ],
      samples: [{ name: "Dr. Amara Okafor", title: "MD", specialty: "Family medicine", email: "amara@clinic.example", active: true }, { name: "Dr. Jonas Weiss", title: "DDS", specialty: "Dentistry", email: "jonas@clinic.example", active: true }],
    },
    {
      slug: "patients", group: "Patients", singular: "Patient", plural: "Patients", fts: true, defaultSort: "name",
      portalLink: { emailField: "email", role: "Patient (portal)" },
      auditReads: true,
      fields: tabbed(
        sec("Patient", [
          hint("patients_phi", "These records are patient health information. Reads are audited; share only what a colleague needs to treat this person."),
          ...half(text("name", { required: true, searchable: true }), date("birth_date", { label: "Date of birth" })),
          ...half(email("email"), phone("phone")),
          ...half(text("emergency_contact", { label: "Emergency contact" }), userLink()),
        ]),
        sec("Coverage", [
          ...half(text("insurance_provider", { label: "Insurance provider" }), text("insurance_number", { label: "Policy no." })),
        ]),
        sec("Clinical", [
          notes("allergies", { description: "Anything that must be checked before prescribing." }),
          notes("notes"),
        ]),
      ),
      samples: [{ name: "Rae Lindqvist", email: "rae@example.com", phone: "+15555550107", birth_date: ms("1991-04-18"), insurance_provider: "BlueShield", insurance_number: "BS-2210475", allergies: "Penicillin" }],
    },
    {
      slug: "services", group: "Scheduling", singular: "Service", plural: "Services", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), int("duration_minutes", { default: 30, validation: { min: 5 }, label: "Duration (min)" })),
        ...half(money("price"), bool("active", { default: true, label: "Active" })),
      ],
      samples: [{ name: "General consultation", duration_minutes: 30, price: 95, active: true }, { name: "Dental cleaning", duration_minutes: 45, price: 140, active: true }],
    },
    {
      slug: "rooms", group: "Scheduling", singular: "Room", plural: "Rooms", defaultSort: "name",
      fields: [
        ...half(
          text("name", { required: true }),
          select("kind", [ch("exam", C.blue), ch("procedure", C.purple), ch("lab", C.teal)], { default: "exam" }),
        ),
        bool("active", { default: true, label: "Active" }),
      ],
      samples: [{ name: "Exam 1", kind: "exam", active: true }, { name: "Procedure A", kind: "procedure", active: true }],
    },
    {
      slug: "appointments", group: "Scheduling", singular: "Appointment", plural: "Appointments", defaultSort: "-starts_at",
      fields: stacked(
        sec("Appointment", [
          ...half(rel("patient", "patients"), rel("practitioner", "practitioners")),
          ...half(rel("service", "services"), rel("room", "rooms")),
        ]),
        sec("Visit", [
          ...half(
            ts("starts_at", { required: true, indexed: true, label: "Starts at" }),
            select("status", [ch("scheduled", C.blue), ch("checked_in", C.teal, "Checked in"), ch("completed", C.green), ch("cancelled", C.red), ch("no_show", C.slate, "No-show")], { default: "scheduled" }),
          ),
          notes("reason", { label: "Reason for visit" }),
        ]),
      ),
      samples: [
        { patient: { ref: "patients:0" }, practitioner: { ref: "practitioners:0" }, service: { ref: "services:0" }, room: { ref: "rooms:0" }, starts_at: ms("2026-07-15T10:30:00Z"), status: "scheduled", reason: "Seasonal allergies follow-up." },
        { patient: { ref: "patients:0" }, practitioner: { ref: "practitioners:1" }, service: { ref: "services:1" }, room: { ref: "rooms:1" }, starts_at: ms("2026-06-20T09:00:00Z"), status: "completed" },
      ],
    },
    {
      slug: "visit_notes", group: "Care", singular: "Visit note", plural: "Visit notes", auditReads: true, defaultSort: "-recorded_at",
      fields: stacked(
        sec("Visit", [
          ...half(rel("appointment", "appointments"), rel("patient", "patients")),
          ...half(rel("practitioner", "practitioners"), ts("recorded_at", { indexed: true, label: "Recorded at" })),
        ]),
        sec("Clinical record", [
          notes("summary", { label: "Visit summary" }),
          notes("diagnosis"),
          notes("treatment_plan", { label: "Treatment plan" }),
        ]),
      ),
      samples: [{ appointment: { ref: "appointments:1" }, patient: { ref: "patients:0" }, practitioner: { ref: "practitioners:1" }, summary: "Routine cleaning, no cavities.", treatment_plan: "Next cleaning in 6 months.", recorded_at: ms("2026-06-20T09:50:00Z") }],
    },
    {
      slug: "prescriptions", group: "Care", singular: "Prescription", plural: "Prescriptions", auditReads: true, defaultSort: "-prescribed_at", displayTemplate: "{{medication}}",
      fields: stacked(
        sec("Prescription", [
          ...half(rel("patient", "patients"), rel("practitioner", "practitioners")),
          ...half(text("medication", { required: true }), text("dosage")),
          text("frequency"),
        ]),
        sec("Course", [
          ...half(date("prescribed_at", { indexed: true, label: "Prescribed" }), date("ends_at", { label: "Ends" })),
          select("status", [ch("active", C.green), ch("completed", C.slate), ch("stopped", C.red)], { default: "active" }),
          notes("instructions"),
        ]),
      ),
      samples: [{ patient: { ref: "patients:0" }, practitioner: { ref: "practitioners:0" }, medication: "Loratadine 10mg", dosage: "1 tablet", frequency: "Once daily", prescribed_at: ms("2026-06-01"), status: "active" }],
    },
    {
      slug: "vitals", group: "Care", singular: "Vitals record", plural: "Vitals", defaultSort: "-recorded_at",
      fields: [
        ...half(rel("appointment", "appointments"), rel("patient", "patients")),
        ts("recorded_at", { required: true, indexed: true, label: "Recorded at" }),
        divider("vitals_body", "Body"),
        ...half(num("height_cm", { validation: { min: 0 }, label: "Height (cm)" }), num("weight_kg", { validation: { min: 0 }, label: "Weight (kg)" })),
        divider("vitals_obs", "Observations"),
        ...half(
          int("systolic", { validation: { min: 0 }, label: "Systolic (mmHg)" }),
          int("diastolic", { validation: { min: 0 }, label: "Diastolic (mmHg)" }),
        ),
        ...half(int("heart_rate", { validation: { min: 0 }, label: "Heart rate (bpm)" }), num("temperature_c", { label: "Temperature (°C)" })),
      ],
      samples: [
        { appointment: { ref: "appointments:1" }, patient: { ref: "patients:0" }, recorded_at: ms("2026-06-20T09:05:00Z"), height_cm: 172, weight_kg: 64.5, systolic: 118, diastolic: 76, heart_rate: 68, temperature_c: 36.7 },
      ],
    },
    {
      slug: "lab_results", group: "Care", singular: "Lab result", plural: "Lab results", auditReads: true, defaultSort: "-resulted_at", displayTemplate: "{{test_name}}",
      fields: stacked(
        sec("Order", [
          ...half(rel("patient", "patients"), rel("appointment", "appointments")),
          ...half(
            text("test_name", { required: true, label: "Test" }),
            select("status", [ch("ordered", C.blue), ch("in_progress", C.amber, "In progress"), ch("completed", C.green)], { default: "ordered" }),
          ),
        ]),
        sec("Result", [
          ...half(text("result_value", { label: "Result" }), text("unit")),
          ...half(text("reference_range", { label: "Reference range" }), ts("resulted_at", { indexed: true, label: "Resulted at" })),
          file("file"),
        ]),
      ),
      samples: [
        { patient: { ref: "patients:0" }, test_name: "Hemoglobin A1c", result_value: "5.4", unit: "%", reference_range: "4.0–5.6", status: "completed", resulted_at: ms("2026-06-22T14:00:00Z") },
        { patient: { ref: "patients:0" }, appointment: { ref: "appointments:0" }, test_name: "IgE allergy panel", status: "ordered" },
      ],
    },
    {
      slug: "invoices", group: "Billing", singular: "Invoice", plural: "Invoices", defaultSort: "-issued_at",
      fields: [
        ...half(text("number", { required: true, unique: true }), money("amount")),
        ...half(rel("patient", "patients"), rel("appointment", "appointments")),
        ...half(
          select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("paid", C.green), ch("insurance_pending", C.amber, "Insurance pending")], { default: "draft" }),
          date("issued_at", { indexed: true, label: "Issued" }),
        ),
      ],
      samples: [{ number: "CL-2026-118", patient: { ref: "patients:0" }, appointment: { ref: "appointments:1" }, amount: 140, status: "paid", issued_at: ms("2026-06-20") }],
    },
    {
      slug: "payments", group: "Billing", singular: "Payment", plural: "Payments", defaultSort: "-paid_at",
      fields: [
        ...half(rel("invoice", "invoices"), money("amount")),
        ...half(
          select("method", [ch("cash", C.green), ch("card", C.blue), ch("insurance", C.purple)], { default: "card" }),
          ts("paid_at", { required: true, indexed: true, label: "Paid at" }),
        ),
      ],
      samples: [{ invoice: { ref: "invoices:0" }, amount: 140, method: "card", paid_at: ms("2026-06-20T10:05:00Z") }],
    },
    {
      slug: "recalls", group: "Patients", singular: "Recall", plural: "Recalls", defaultSort: "due_on",
      fields: [
        rel("patient", "patients"),
        ...half(
          select("reason", [ch("annual_checkup", C.blue, "Annual checkup"), ch("follow_up", C.teal, "Follow-up"), ch("vaccination", C.purple), ch("cleaning", C.green)], { default: "follow_up" }),
          date("due_on", { required: true, indexed: true, label: "Due" }),
        ),
        select("status", [ch("due", C.amber), ch("contacted", C.blue), ch("booked", C.teal), ch("done", C.green)], { default: "due" }),
      ],
      samples: [
        { patient: { ref: "patients:0" }, reason: "cleaning", due_on: ms("2026-12-20"), status: "due" },
        { patient: { ref: "patients:0" }, reason: "follow_up", due_on: ms("2026-07-15"), status: "booked" },
      ],
    },
  ],
  roles: [
    {
      name: "Reception",
      description: "Manage patients, the appointment book, recalls and billing — no access to clinical notes, vitals, labs or prescriptions.",
      permissions: [
        { collection: "practitioners", action: "read" },
        { collection: "services", action: "read" },
        { collection: "rooms", action: "read" },
        { collection: "patients", action: "read" },
        { collection: "patients", action: "create" },
        { collection: "patients", action: "update" },
        { collection: "appointments", action: "read" },
        { collection: "appointments", action: "create" },
        { collection: "appointments", action: "update" },
        { collection: "invoices", action: "read" },
        { collection: "invoices", action: "create" },
        { collection: "invoices", action: "update" },
        { collection: "payments", action: "read" },
        { collection: "payments", action: "create" },
        { collection: "recalls", action: "read" },
        { collection: "recalls", action: "create" },
        { collection: "recalls", action: "update" },
      ],
    },
    {
      name: "Nurse",
      description: "Clinical support: record vitals, track lab results and manage recalls — read-only on notes and prescriptions.",
      permissions: [
        { collection: "practitioners", action: "read" },
        { collection: "services", action: "read" },
        { collection: "rooms", action: "read" },
        { collection: "patients", action: "read" },
        { collection: "patients", action: "update" },
        { collection: "appointments", action: "read" },
        { collection: "appointments", action: "update" },
        { collection: "vitals", action: "read" },
        { collection: "vitals", action: "create" },
        { collection: "vitals", action: "update" },
        { collection: "lab_results", action: "read" },
        { collection: "lab_results", action: "create" },
        { collection: "lab_results", action: "update" },
        { collection: "visit_notes", action: "read" },
        { collection: "prescriptions", action: "read" },
        { collection: "recalls", action: "read" },
        { collection: "recalls", action: "create" },
        { collection: "recalls", action: "update" },
      ],
    },
    {
      name: "Patient (portal)",
      description: "Patient portal: own appointments, prescriptions, lab results, invoices and recalls — never other patients, visit notes or vitals.",
      permissions: [
        { collection: "practitioners", action: "read" },
        { collection: "services", action: "read" },
        { collection: "patients", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "appointments", action: "read", condition: { "patient.app_user_id": { _eq: "$user.id" } } },
        { collection: "prescriptions", action: "read", condition: { "patient.app_user_id": { _eq: "$user.id" } } },
        { collection: "lab_results", action: "read", condition: { "patient.app_user_id": { _eq: "$user.id" } } },
        { collection: "invoices", action: "read", condition: { "patient.app_user_id": { _eq: "$user.id" } } },
        { collection: "recalls", action: "read", condition: { "patient.app_user_id": { _eq: "$user.id" } } },
      ],
    },
  ],
  dashboards: [
    {
      name: "Clinic overview",
      description: "Appointment flow, patient base, billing and recalls.",
      panels: [
        { name: "Patients", kind: "items-aggregate", viz: "counter", config: { collection: "patients", agg: "count" } },
        { name: "Appointments", kind: "items-aggregate", viz: "counter", config: { collection: "appointments", agg: "count" } },
        { name: "Active prescriptions", kind: "items-aggregate", viz: "counter", config: { collection: "prescriptions", agg: "count" } },
        { name: "Invoiced", kind: "items-aggregate", viz: "counter", config: { collection: "invoices", agg: "sum", field: "amount" } },
        { name: "Collected", kind: "items-aggregate", viz: "counter", config: { collection: "payments", agg: "sum", field: "amount" } },
        { name: "Appointments by status", kind: "items-aggregate", viz: "donut", config: { collection: "appointments", agg: "count", groupBy: "status" } },
        { name: "Invoices by status", kind: "items-aggregate", viz: "bars", config: { collection: "invoices", agg: "count", groupBy: "status" } },
        { name: "Recalls by status", kind: "items-aggregate", viz: "bars", config: { collection: "recalls", agg: "count", groupBy: "status" } },
      ],
    },
  ],
};
