import type { SchemaTemplate } from "../types";
import { C, ch, date, divider, email, file, flag, half, hint, int, money, ms, notes, num, phone, rel, rollup, sec, select, seq, stacked, tabbed, text, ts, userLink, when } from "../dsl";

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
        flag("active", { label: "Active" }),
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
          // Completed visits only, kept by the server. Reception uses it to
          // judge a recall ("has this person actually been in?") without
          // opening a single clinical record.
          rollup(
            "completed_visits",
            { from: "appointments", via: "patient", fn: "count", filter: { status: { _eq: "completed" } } },
            { label: "Completed visits" },
          ),
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
        ...half(money("price"), flag("active", { label: "Active" })),
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
        flag("active", { label: "Active" }),
      ],
      samples: [{ name: "Exam 1", kind: "exam", active: true }, { name: "Procedure A", kind: "procedure", active: true }],
    },
    {
      slug: "appointments", group: "Scheduling", singular: "Appointment", plural: "Appointments", defaultSort: "-starts_at",
      kanbanGroupBy: "status",
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
          ...half(
            date("prescribed_at", { indexed: true, label: "Prescribed" }),
            date("ends_at", {
              label: "Ends",
              conditions: [when("status", "_eq", "completed", "required")],
            }),
          ),
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
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Order", [
          ...half(rel("patient", "patients"), rel("appointment", "appointments")),
          ...half(
            text("test_name", { required: true, label: "Test" }),
            select("status", [ch("ordered", C.blue), ch("in_progress", C.amber, "In progress"), ch("completed", C.green)], { default: "ordered" }),
          ),
        ]),
        sec("Result", [
          // A lab marked completed with no value is the record somebody acts
          // on believing it came back normal.
          ...half(
            text("result_value", {
              label: "Result",
              conditions: [when("status", "_eq", "completed", "required")],
            }),
            text("unit"),
          ),
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
      kanbanGroupBy: "status",
      fields: [
        ...half(seq("number", "CL-{YYYY}-{####}"), money("amount")),
        ...half(rel("patient", "patients"), rel("appointment", "appointments")),
        ...half(
          select("status", [ch("draft", C.gray), ch("sent", C.blue), ch("paid", C.green), ch("insurance_pending", C.amber, "Insurance pending")], { default: "draft" }),
          date("issued_at", { indexed: true, label: "Issued" }),
        ),
      ],
      samples: [{ patient: { ref: "patients:0" }, appointment: { ref: "appointments:1" }, amount: 140, status: "paid", issued_at: ms("2026-06-20") }],
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
      // Auto-detect would pick `reason` — a cleaning and a vaccination are
      // both things that are due, contacted, booked or done.
      kanbanGroupBy: "status",
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
  /**
   * Read this before adding a rule here.
   *
   * **A flow notification with no `userId` is a BROADCAST to the whole
   * workspace.** There is no role targeting — `services/flows.ts` writes one
   * row scoped to the tenant, and everybody in it can read the title and body.
   * This template's entire shape is a Reception role that deliberately cannot
   * see visit notes, vitals, labs or prescriptions; putting a test name, a
   * medication or a diagnosis in a notification body routes clinical data
   * straight past that boundary, and does it in a place nobody thinks to
   * audit.
   *
   * So the clinical rules below say only that something needs attention and
   * where to look. The lab and prescription ones name NO patient and NO
   * clinical detail — even a name would tell Reception that a particular
   * person had a test, which is the thing they were not given. The scheduling
   * and billing rules do name patients, because Reception legitimately holds
   * the appointment book and the ledger; what they withhold is the REASON for
   * the visit, which is clinical.
   *
   * Deliberately absent: raising a recall automatically after a no-show or a
   * completed visit. A recall needs a due date, computing one means adding six
   * months to a date, and flow operations have no date arithmetic — a recall
   * dated wrongly is worse than one a nurse sets while the patient is still in
   * the room.
   */
  flows: [
    {
      name: "Remind the desk about tomorrow's appointments",
      trigger: `schedule:${JSON.stringify({
        collection: "appointments",
        field: "starts_at",
        offset: { value: 1, unit: "days", direction: "before" },
        at: 600,
        timeZone: null,
        where: { status: { _eq: "scheduled" } },
      })}`,
      operations: [
        {
          // Name, time, practitioner, room — the appointment book, which is
          // Reception's job. The `reason` field is deliberately not here.
          type: "notification",
          title: "Tomorrow: {{ data.patient.name }} at {{ data.starts_at }}",
          body: "{{ data.service.name }} with {{ data.practitioner.name }} in {{ data.room.name }}. Confirm by phone if they have not been in before.",
          url: "/collections/appointments",
        },
      ],
    },
    {
      name: "Follow up a no-show",
      trigger: "event:items:appointments:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "no_show" } },
          then: [
            {
              type: "notification",
              title: "No-show: {{ data.patient.name }}",
              body: "Missed {{ data.starts_at }} with {{ data.practitioner.name }}. Call to rebook, and raise a recall if the visit still needs to happen.",
              url: "/collections/appointments",
            },
          ],
        },
      ],
    },
    {
      name: "Work the recall list every Monday",
      trigger: "cron:0 9 * * 1",
      operations: [
        {
          type: "foreach",
          collection: "recalls",
          filter: { due_on: { _lte: "$now" }, status: { _eq: "due" } },
          do: [
            {
              type: "notification",
              title: "Recall due: {{ $item.patient.name }}",
              body: "{{ $item.reason }}, due {{ $item.due_on }}. {{ $item.patient.completed_visits }} visits on record.",
              url: "/collections/recalls",
            },
          ],
        },
      ],
    },
    {
      name: "Say when a lab result has come back",
      // No patient, no test, no value — see the note above this list. A
      // clinician opens the record; a broadcast that named either would tell
      // the whole workspace something only clinicians are given.
      trigger: "event:items:lab_results:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "completed" } },
          then: [
            {
              type: "notification",
              title: "A lab result has come back",
              body: "One result moved to completed and is waiting on a clinician. Open Lab results to review it.",
              url: "/collections/lab_results",
            },
          ],
        },
      ],
    },
    {
      name: "Say when a prescription course is ending",
      // Same restraint, same reason: the fact that a course is ending is
      // enough to prompt a review, and the medication is not the feed's
      // business.
      trigger: `schedule:${JSON.stringify({
        collection: "prescriptions",
        field: "ends_at",
        offset: { value: 3, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "active" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "A prescription course ends in three days",
          body: "Open Prescriptions to decide whether it continues, changes or stops.",
          url: "/collections/prescriptions",
        },
      ],
    },
    {
      name: "Chase an invoice unpaid after a month",
      trigger: `schedule:${JSON.stringify({
        collection: "invoices",
        field: "issued_at",
        offset: { value: 30, unit: "days", direction: "after" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "sent" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "{{ data.number }} unpaid after 30 days",
          body: "{{ data.amount }} for {{ data.patient.name }}, issued {{ data.issued_at }}. Check whether it should be with the insurer instead.",
          url: "/collections/invoices",
        },
      ],
    },
    {
      name: "Email the patient their appointment reminder (needs email)",
      active: false,
      trigger: `schedule:${JSON.stringify({
        collection: "appointments",
        field: "starts_at",
        offset: { value: 1, unit: "days", direction: "before" },
        at: 660,
        timeZone: null,
        where: { status: { _eq: "scheduled" } },
      })}`,
      operations: [
        {
          // To the patient's own address, and still no clinical detail: mail
          // goes through servers the clinic does not control, and an inbox is
          // read by more people than its owner.
          type: "email",
          to: "{{ data.patient.email }}",
          subject: "Your appointment tomorrow",
          html: "<p>This is a reminder of your appointment at {{ data.starts_at }} with {{ data.practitioner.name }}. Call us if you need to change it.</p>",
        },
      ],
    },
    {
      name: "Monthly clinic report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Clinic overview",
          subject: "Clinic — last month",
        },
      ],
    },
  ],
  /*
   * These DO carry clinical detail, and that is correct: a document is
   * rendered on demand by somebody who already holds permission on the record,
   * and handed to the patient it belongs to. That is the opposite of a
   * broadcast notification, which is why the rules above are so bare and these
   * are not.
   */
  documents: [
    {
      key: "clinic_prescription",
      name: "Prescription",
      description: "What a patient takes to a pharmacy.",
      filename: "prescription-{{ data.id }}",
      variables: ["medication", "dosage"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A5;margin:14mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:18px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:12px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:38%;color:#555;font-weight:600}" +
        ".rx{font-size:16px;font-weight:600;margin-top:12px}" +
        ".sign{margin-top:26px;border-top:1px solid #333;width:70%;padding-top:6px}" +
        "</style></head><body>" +
        "<h1>{{ data.patient.name }}</h1>" +
        '<p class="muted">Date of birth {{ data.patient.birth_date }}</p>' +
        '<div class="rx">{{ data.medication }}</div>' +
        "<table>" +
        "<tr><th>Dosage</th><td>{{ data.dosage }}</td></tr>" +
        "<tr><th>Frequency</th><td>{{ data.frequency }}</td></tr>" +
        "<tr><th>Prescribed</th><td>{{ data.prescribed_at }}</td></tr>" +
        "<tr><th>Until</th><td>{{ data.ends_at }}</td></tr>" +
        "<tr><th>Known allergies</th><td>{{ data.patient.allergies }}</td></tr>" +
        "</table>" +
        "<p>{{ data.instructions }}</p>" +
        '<div class="sign">{{ data.practitioner.name }} {{ data.practitioner.title }}</div>' +
        "</body></html>",
      pageOptions: { format: "A5", margin: "14mm" },
    },
    {
      key: "clinic_visit_summary",
      name: "After-visit summary",
      description: "What the patient leaves with.",
      filename: "visit-{{ data.id }}",
      variables: ["summary"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        "h2{font-size:13px;margin:18px 0 4px}" +
        "</style></head><body>" +
        "<h1>{{ data.patient.name }}</h1>" +
        '<p class="muted">Seen by {{ data.practitioner.name }} on {{ data.recorded_at }}</p>' +
        "<h2>Summary</h2><p>{{ data.summary }}</p>" +
        "<h2>Plan</h2><p>{{ data.treatment_plan }}</p>" +
        '<p class="muted">Call the clinic if anything changes or you are unsure ' +
        "about the plan above.</p>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "clinic_invoice",
      name: "Patient invoice",
      description: "The bill, with insurance status.",
      filename: "invoice-{{ data.number }}",
      variables: ["number", "amount"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:21px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:14px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:36%;color:#555;font-weight:600}" +
        ".total{margin-top:16px;font-size:18px;font-weight:600;text-align:right}" +
        "</style></head><body>" +
        "<h1>Invoice {{ data.number }}</h1>" +
        '<p class="muted">{{ data.patient.name }}</p>' +
        "<table>" +
        "<tr><th>Issued</th><td>{{ data.issued_at }}</td></tr>" +
        "<tr><th>Status</th><td>{{ data.status }}</td></tr>" +
        "<tr><th>Insurance</th><td>{{ data.patient.insurance_provider }}</td></tr>" +
        "</table>" +
        '<div class="total">{{ data.amount }}</div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      name: "Register as a new patient",
      collection: "patients",
      settings: {
        submitLabel: "Register",
        successMessage:
          "Thanks — you're registered. Please bring your insurance card and a list of any medication to your first visit; do not send medical details through this form.",
      },
      // Contact and identity only. Three fields on this collection are
      // deliberately NOT here:
      //   `allergies` — clinical information, taken by a clinician who can ask
      //     follow-up questions, not typed into a public page by a stranger;
      //   `insurance_number` — a policy number is a credential, and the card
      //     is checked at the desk;
      //   `notes` — the staff's internal record of a person, not the person's.
      // The success message says all of this in the patient's own words.
      fields: [
        { name: "name", label: "Full name" },
        { name: "birth_date", label: "Date of birth" },
        { name: "email", label: "Email" },
        { name: "phone" },
        { name: "emergency_contact", label: "Emergency contact", help: "Name and number of someone we can call." },
        { name: "insurance_provider", label: "Insurance provider", help: "The name only — we take the policy number from your card at reception." },
      ],
    },
  ],
  agents: [
    {
      name: "Clinic operations assistant",
      handle: "clinic-ops-assistant",
      description: "Answers questions about the appointment book, recalls and billing — not about anyone's health.",
      systemPrompt:
        "You help a clinic run its front office. Answer questions about " +
        "appointments, practitioners, services, rooms, recalls, invoices and " +
        "payments using the workspace's own data.\n\n" +
        "You do NOT practise medicine. Never diagnose, never suggest a " +
        "treatment or a medication, never interpret a lab value or a set of " +
        "vitals, and never say whether a result looks normal — not even when " +
        "asked plainly, and not even to reassure somebody. Say that it is for " +
        "the treating clinician and stop there.\n\n" +
        "Stay on the operational side of the data. Visit notes, vitals, lab " +
        "results and prescriptions are patient health information and reads " +
        "against them are AUDITED — do not go looking through them to answer " +
        "a scheduling or billing question, and never quote clinical content " +
        "into an answer that a non-clinical colleague might be reading. " +
        "Counting appointments or recalls is operations; summarising what is " +
        "wrong with somebody is not.\n\n" +
        "`no_show` and `cancelled` are different problems — one is capacity " +
        "lost with no notice. A patient's `completed_visits` is kept by the " +
        "server and counts finished appointments only. `insurance_pending` on " +
        "an invoice is not unpaid by the patient. Be brief, and say when the " +
        "data does not answer the question.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "collections.search"],
      maxSteps: 8,
    },
  ],
};
