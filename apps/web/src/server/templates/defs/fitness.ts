import type { SchemaTemplate } from "../types";
import { C, bool, ch, date, email, file, flag, half, int, money, ms, notes, num, pct, phone, rel, rollup, sec, select, tabbed, text, ts, userLink, when } from "../dsl";

export const fitness: SchemaTemplate = {
  id: "fitness",
  label: "Fitness / Gym",
  groups: ["Members", "Classes", "Training", "Billing", "Operations"],
  description:
    "Odoo Fitness-Center-grade gym ops: membership plans, members with status and renewal dates, trainers, classes with capacity, scheduled sessions, class bookings and front-door check-ins — plus personal-training packages & sessions, payments, signed waivers, body-measurement progress tracking and membership freezes.",
  collections: [
    {
      slug: "trainers", group: "Classes", singular: "Trainer", plural: "Trainers", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), email("email")),
        ...half(phone("phone"), text("specialties", { label: "Specialties" })),
        flag("active", { label: "Active" }),
      ],
      samples: [{ name: "Alex Morgan", email: "alex@example.com", specialties: "Strength, HIIT", active: true }, { name: "Sofia Reyes", email: "sofia@example.com", specialties: "Yoga, Pilates", active: true }],
    },
    {
      slug: "membership_plans", group: "Members", singular: "Plan", plural: "Membership plans", defaultSort: "price_monthly",
      fields: [
        ...half(text("name", { required: true }), money("price_monthly", { label: "Price / month" })),
        ...half(
          select("term", [ch("monthly", C.blue), ch("quarterly", C.teal), ch("yearly", C.purple)], { default: "monthly" }),
          int("class_credits", { default: 0, validation: { min: 0 }, label: "Class credits / month" }),
        ),
        ...half(
          bool("unlimited_classes", { default: false, label: "Unlimited classes" }),
          flag("active", { label: "Active" }),
        ),
      ],
      samples: [
        { name: "Basic", price_monthly: 39, term: "monthly", class_credits: 4, unlimited_classes: false, active: true },
        { name: "Unlimited", price_monthly: 79, term: "monthly", class_credits: 0, unlimited_classes: true, active: true },
      ],
    },
    {
      slug: "members", group: "Members", singular: "Member", plural: "Members", fts: true, defaultSort: "name",
      portalLink: { emailField: "email", role: "Member (self-service)" },
      kanbanGroupBy: "status",
      fields: tabbed(
        sec("Member", [
          ...half(text("name", { required: true, searchable: true }), email("email")),
          ...half(phone("phone"), text("emergency_contact", { label: "Emergency contact" })),
          userLink(),
        ]),
        sec("Membership", [
          ...half(
            rel("plan", "membership_plans"),
            select("status", [ch("active", C.green), ch("paused", C.amber), ch("cancelled", C.red), ch("trial", C.blue)], { default: "active" }),
          ),
          ...half(date("joined_at", { indexed: true, label: "Joined" }), date("renews_at", { indexed: true, label: "Renews" })),
          // Two counts the server keeps, because the single best predictor of
          // whether somebody cancels is whether they turn up. A member on the
          // top plan with four visits all year is the one to call.
          ...half(
            rollup(
              "visit_count",
              { from: "check_ins", via: "member", fn: "count" },
              { label: "Visits", description: "Every front-door check-in on record." },
            ),
            rollup(
              "pt_sessions_done",
              { from: "pt_sessions", via: "member", fn: "count", filter: { status: { _eq: "completed" } } },
              { label: "PT sessions done", description: "Completed only — booked and no-show sessions are not training." },
            ),
          ),
          notes("notes"),
        ]),
      ),
      samples: [
        { name: "Jamie Fox", email: "jamie@example.com", plan: { ref: "membership_plans:1" }, status: "active", joined_at: ms("2026-02-01"), renews_at: ms("2026-08-01") },
        { name: "Chris Yuen", email: "chris@example.com", plan: { ref: "membership_plans:0" }, status: "trial", joined_at: ms("2026-07-01"), renews_at: ms("2026-08-01") },
      ],
    },
    {
      slug: "classes", group: "Classes", singular: "Class", plural: "Classes", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), rel("trainer", "trainers")),
        notes("description"),
        ...half(
          int("capacity", { default: 12, validation: { min: 1 } }),
          int("duration_minutes", { default: 45, validation: { min: 10 }, label: "Duration (min)" }),
        ),
        ...half(
          select("level", [ch("beginner", C.green), ch("intermediate", C.blue), ch("advanced", C.red), ch("all", C.gray, "All levels")], { default: "all" }),
          flag("active", { label: "Active" }),
        ),
      ],
      samples: [
        { name: "Morning yoga flow", trainer: { ref: "trainers:1" }, capacity: 16, duration_minutes: 60, level: "all", active: true },
        { name: "HIIT 45", trainer: { ref: "trainers:0" }, capacity: 12, duration_minutes: 45, level: "intermediate", active: true },
      ],
    },
    {
      slug: "class_sessions", group: "Classes", singular: "Session", plural: "Sessions", defaultSort: "-starts_at",
      fields: [
        ...half(rel("class", "classes"), rel("trainer", "trainers")),
        ...half(
          ts("starts_at", { required: true, indexed: true, label: "Starts at" }),
          select("status", [ch("scheduled", C.blue), ch("completed", C.green), ch("cancelled", C.red)], { default: "scheduled" }),
        ),
      ],
      samples: [
        { class: { ref: "classes:0" }, trainer: { ref: "trainers:1" }, starts_at: ms("2026-07-14T07:00:00Z"), status: "scheduled" },
        { class: { ref: "classes:1" }, trainer: { ref: "trainers:0" }, starts_at: ms("2026-07-10T18:00:00Z"), status: "completed" },
      ],
    },
    {
      slug: "class_bookings", group: "Classes", singular: "Booking", plural: "Class bookings", defaultSort: "-booked_at",
      fields: [
        ...half(rel("session", "class_sessions"), rel("member", "members")),
        ...half(
          select("status", [ch("booked", C.blue), ch("attended", C.green), ch("no_show", C.slate, "No-show"), ch("cancelled", C.red)], { default: "booked" }),
          ts("booked_at", { indexed: true, label: "Booked at" }),
        ),
      ],
      samples: [
        { session: { ref: "class_sessions:0" }, member: { ref: "members:0" }, status: "booked", booked_at: ms("2026-07-11T10:00:00Z") },
        { session: { ref: "class_sessions:1" }, member: { ref: "members:0" }, status: "attended", booked_at: ms("2026-07-09T08:00:00Z") },
      ],
    },
    {
      slug: "check_ins", group: "Operations", singular: "Check-in", plural: "Check-ins", defaultSort: "-checked_in_at",
      fields: [...half(rel("member", "members"), ts("checked_in_at", { required: true, indexed: true, label: "Checked in at" }))],
      samples: [{ member: { ref: "members:0" }, checked_in_at: ms("2026-07-10T17:52:00Z") }],
    },
    {
      slug: "pt_packages", group: "Training", singular: "PT package", plural: "PT packages", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), int("session_count", { default: 10, validation: { min: 1 }, label: "Sessions included" })),
        ...half(money("price"), rel("trainer", "trainers", { label: "Preferred trainer" })),
        flag("active", { label: "Active" }),
      ],
      samples: [
        { name: "PT starter — 5 sessions", session_count: 5, price: 275, trainer: { ref: "trainers:0" }, active: true },
        { name: "PT pro — 10 sessions", session_count: 10, price: 490, active: true },
      ],
    },
    {
      slug: "pt_sessions", group: "Training", singular: "PT session", plural: "PT sessions", defaultSort: "-scheduled_at",
      kanbanGroupBy: "status",
      fields: [
        ...half(rel("member", "members"), rel("trainer", "trainers")),
        ...half(rel("package", "pt_packages"), ts("scheduled_at", { required: true, indexed: true, label: "Scheduled" })),
        select("status", [ch("scheduled", C.blue), ch("completed", C.green), ch("cancelled", C.red), ch("no_show", C.slate, "No-show")], { default: "scheduled" }),
        notes("notes"),
      ],
      samples: [
        { member: { ref: "members:0" }, trainer: { ref: "trainers:0" }, package: { ref: "pt_packages:0" }, scheduled_at: ms("2026-07-16T08:00:00Z"), status: "scheduled" },
        { member: { ref: "members:0" }, trainer: { ref: "trainers:0" }, package: { ref: "pt_packages:0" }, scheduled_at: ms("2026-07-09T08:00:00Z"), status: "completed", notes: "Deadlift form work — 3x5 @ 80kg." },
      ],
    },
    {
      slug: "body_measurements", group: "Training", singular: "Measurement", plural: "Body measurements", defaultSort: "-measured_at",
      fields: [
        ...half(rel("member", "members"), date("measured_at", { required: true, indexed: true, label: "Measured" })),
        ...half(num("weight_kg", { validation: { min: 0 }, label: "Weight (kg)" }), pct("body_fat_pct", { label: "Body fat %" })),
        ...half(num("muscle_kg", { validation: { min: 0 }, label: "Muscle mass (kg)" }), notes("notes")),
      ],
      samples: [
        { member: { ref: "members:0" }, measured_at: ms("2026-06-01"), weight_kg: 78.4, body_fat_pct: 21, muscle_kg: 34.2 },
        { member: { ref: "members:0" }, measured_at: ms("2026-07-01"), weight_kg: 76.9, body_fat_pct: 19, muscle_kg: 34.8, notes: "Down 1.5kg since starting PT." },
      ],
    },
    {
      slug: "waivers", group: "Members", singular: "Waiver", plural: "Waivers", defaultSort: "-signed_at",
      fields: [
        ...half(
          rel("member", "members"),
          select("kind", [ch("liability", C.red), ch("health", C.teal)], { default: "liability" }),
        ),
        ...half(
          // A waiver marked signed with no date is not a defence.
          date("signed_at", {
            indexed: true,
            label: "Signed",
            conditions: [when("status", "_eq", "signed", "required")],
          }),
          select("status", [ch("signed", C.green), ch("pending", C.amber)], { default: "pending" }),
        ),
        file("file"),
      ],
      samples: [
        { member: { ref: "members:0" }, kind: "liability", signed_at: ms("2026-02-01"), status: "signed" },
        { member: { ref: "members:1" }, kind: "liability", status: "pending" },
      ],
    },
    {
      slug: "membership_freezes", group: "Members", singular: "Freeze", plural: "Membership freezes", defaultSort: "-starts_on",
      // Named because auto-detect would pick `reason` — travel or medical is
      // WHY, and the board is about where the request has got to.
      kanbanGroupBy: "status",
      fields: [
        rel("member", "members"),
        ...half(
          date("starts_on", { range: { end: "ends_on", bounds: "[]" }, required: true, indexed: true, label: "Starts" }),
          // An open-ended freeze is a cancelled membership nobody billed for.
          // The sweep below can only put somebody back on the floor if there
          // is a date to put them back on.
          date("ends_on", {
            label: "Ends",
            validation: { rule: { ends_on: { _gte: "$field.starts_on" } }, message: "A freeze must end on or after it starts." },
            conditions: [when("status", "_in", ["active", "ended"], "required")],
          }),
        ),
        ...half(
          select("reason", [ch("travel", C.blue), ch("medical", C.red), ch("financial", C.amber), ch("other", C.gray)], { default: "travel" }),
          select("status", [ch("requested", C.amber), ch("active", C.blue), ch("ended", C.slate)], { default: "requested" }),
        ),
      ],
      samples: [{ member: { ref: "members:0" }, starts_on: ms("2026-08-10"), ends_on: ms("2026-08-24"), reason: "travel", status: "requested" }],
    },
    {
      slug: "payments", group: "Billing", singular: "Payment", plural: "Payments", defaultSort: "-paid_at",
      fields: [
        ...half(
          rel("member", "members"),
          select("kind", [ch("membership_fee", C.blue, "Membership fee"), ch("pt_package", C.purple, "PT package"), ch("day_pass", C.teal, "Day pass"), ch("merch", C.amber, "Merchandise")], { default: "membership_fee" }),
        ),
        ...half(
          money("amount"),
          select("method", [ch("card", C.blue), ch("cash", C.green), ch("bank_transfer", C.teal, "Bank transfer")], { default: "card" }),
        ),
        ...half(ts("paid_at", { required: true, indexed: true, label: "Paid at" }), text("period", { label: "Period covered" })),
      ],
      samples: [
        { member: { ref: "members:0" }, kind: "membership_fee", amount: 79, method: "card", paid_at: ms("2026-07-01T09:12:00Z"), period: "Jul 2026" },
        { member: { ref: "members:0" }, kind: "pt_package", amount: 275, method: "card", paid_at: ms("2026-07-02T18:40:00Z") },
      ],
    },
  ],
  roles: [
    {
      name: "Front desk",
      description: "Manage members, bookings, check-ins, waivers, freezes and payments; read plans, classes and schedules.",
      permissions: [
        { collection: "trainers", action: "read" },
        { collection: "membership_plans", action: "read" },
        { collection: "members", action: "read" },
        { collection: "members", action: "create" },
        { collection: "members", action: "update" },
        { collection: "classes", action: "read" },
        { collection: "class_sessions", action: "read" },
        { collection: "class_bookings", action: "read" },
        { collection: "class_bookings", action: "create" },
        { collection: "class_bookings", action: "update" },
        { collection: "check_ins", action: "read" },
        { collection: "check_ins", action: "create" },
        { collection: "pt_packages", action: "read" },
        { collection: "pt_sessions", action: "read" },
        { collection: "waivers", action: "read" },
        { collection: "waivers", action: "create" },
        { collection: "waivers", action: "update" },
        { collection: "membership_freezes", action: "read" },
        { collection: "membership_freezes", action: "create" },
        { collection: "membership_freezes", action: "update" },
        { collection: "payments", action: "read" },
        { collection: "payments", action: "create" },
      ],
    },
    {
      name: "Trainer",
      description: "Run classes and personal training: sessions, bookings and member progress — no billing or membership admin.",
      permissions: [
        { collection: "members", action: "read" },
        { collection: "classes", action: "read" },
        { collection: "class_sessions", action: "read" },
        { collection: "class_sessions", action: "update" },
        { collection: "class_bookings", action: "read" },
        { collection: "class_bookings", action: "update" },
        { collection: "pt_packages", action: "read" },
        { collection: "pt_sessions", action: "read" },
        { collection: "pt_sessions", action: "create" },
        { collection: "pt_sessions", action: "update" },
        { collection: "body_measurements", action: "read" },
        { collection: "body_measurements", action: "create" },
        { collection: "body_measurements", action: "update" },
        { collection: "check_ins", action: "read" },
      ],
    },
    {
      name: "Member (self-service)",
      description: "Member self-service portal: browse plans and class schedules, book classes, request freezes, and see own payments, PT sessions and progress.",
      permissions: [
        { collection: "trainers", action: "read" },
        { collection: "membership_plans", action: "read" },
        { collection: "classes", action: "read" },
        { collection: "class_sessions", action: "read" },
        { collection: "members", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "class_bookings", action: "read", condition: { "member.app_user_id": { _eq: "$user.id" } } },
        { collection: "class_bookings", action: "create" },
        { collection: "class_bookings", action: "update", condition: { "member.app_user_id": { _eq: "$user.id" } } },
        { collection: "pt_sessions", action: "read", condition: { "member.app_user_id": { _eq: "$user.id" } } },
        { collection: "body_measurements", action: "read", condition: { "member.app_user_id": { _eq: "$user.id" } } },
        { collection: "membership_freezes", action: "read", condition: { "member.app_user_id": { _eq: "$user.id" } } },
        { collection: "membership_freezes", action: "create" },
        { collection: "payments", action: "read", condition: { "member.app_user_id": { _eq: "$user.id" } } },
      ],
    },
  ],
  dashboards: [
    {
      name: "Gym overview",
      description: "Membership health, class activity, personal training and revenue.",
      panels: [
        { name: "Members", kind: "items-aggregate", viz: "counter", config: { collection: "members", agg: "count" } },
        { name: "Check-ins", kind: "items-aggregate", viz: "counter", config: { collection: "check_ins", agg: "count" } },
        { name: "Class bookings", kind: "items-aggregate", viz: "counter", config: { collection: "class_bookings", agg: "count" } },
        { name: "Revenue collected", kind: "items-aggregate", viz: "counter", config: { collection: "payments", agg: "sum", field: "amount" } },
        { name: "Members by status", kind: "items-aggregate", viz: "donut", config: { collection: "members", agg: "count", groupBy: "status" } },
        { name: "Bookings by outcome", kind: "items-aggregate", viz: "bars", config: { collection: "class_bookings", agg: "count", groupBy: "status" } },
        { name: "Payments by kind", kind: "items-aggregate", viz: "donut", config: { collection: "payments", agg: "count", groupBy: "kind" } },
        { name: "PT sessions by status", kind: "items-aggregate", viz: "bars", config: { collection: "pt_sessions", agg: "count", groupBy: "status" } },
      ],
    },
  ],
  /**
   * A gym's month runs on renewal dates and who turned up, so that is what
   * these watch.
   *
   * NO sequence in this template. Nothing here is a numbered document — a gym
   * issues receipts against payments it already recorded, and inventing a
   * membership number would add an identifier nobody at the front desk asks
   * for. Same reading as `fleet`, for a different reason.
   */
  flows: [
    {
      name: "Warn a week before a membership renews",
      trigger: `schedule:${JSON.stringify({
        collection: "members",
        field: "renews_at",
        offset: { value: 7, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "active" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "{{ data.name }} renews in a week",
          body: "On {{ data.plan.name }}, renewing {{ data.renews_at }}. {{ data.visit_count }} visits on record — worth a word if that number is low.",
          url: "/collections/members",
        },
      ],
    },
    {
      name: "Catch a trial three days before it ends",
      // Separate from the renewal rule and deliberately earlier: a trial that
      // lapses quietly is a member who was never asked to join.
      trigger: `schedule:${JSON.stringify({
        collection: "members",
        field: "renews_at",
        offset: { value: 3, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "trial" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "{{ data.name }}'s trial ends {{ data.renews_at }}",
          body: "{{ data.visit_count }} visits so far. Ask them in person before the trial runs out — nobody converts from an email alone.",
          url: "/collections/members",
        },
      ],
    },
    {
      name: "Start and end membership freezes",
      // The one flow here that CHANGES something. A freeze is a promise about
      // billing, and a promise nobody actions is just a note: this puts the
      // member on hold on the day it starts and back on the floor on the day
      // it ends, so the status column and the freeze always agree.
      trigger: "cron:0 5 * * *",
      operations: [
        {
          type: "foreach",
          collection: "membership_freezes",
          filter: { starts_on: { _lte: "$now" }, status: { _eq: "requested" } },
          do: [
            {
              type: "item.update",
              collection: "membership_freezes",
              id: "{{ $item.id }}",
              data: { status: "active" },
            },
            {
              type: "item.update",
              collection: "members",
              id: "{{ $item.member }}",
              data: { status: "paused" },
            },
          ],
        },
        {
          type: "foreach",
          collection: "membership_freezes",
          filter: { ends_on: { _lt: "$now" }, status: { _eq: "active" } },
          do: [
            {
              type: "item.update",
              collection: "membership_freezes",
              id: "{{ $item.id }}",
              data: { status: "ended" },
            },
            {
              type: "item.update",
              collection: "members",
              id: "{{ $item.member }}",
              data: { status: "active" },
            },
          ],
        },
      ],
    },
    {
      name: "Chase waivers nobody has signed",
      trigger: "cron:0 9 * * 1",
      operations: [
        {
          type: "foreach",
          collection: "waivers",
          filter: { status: { _eq: "pending" } },
          do: [
            {
              type: "notification",
              title: "Unsigned {{ $item.kind }} waiver: {{ $item.member.name }}",
              body: "They are training without it. Catch them at the desk on the next visit.",
              url: "/collections/waivers",
            },
          ],
        },
      ],
    },
    {
      name: "Follow up a class no-show",
      trigger: "event:items:class_bookings:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "no_show" } },
          then: [
            {
              type: "notification",
              title: "No-show: {{ data.member.name }}",
              body: "Booked {{ data.session.class.name }} and did not come. One is nothing; a pattern is somebody about to cancel.",
              url: "/collections/class_bookings",
            },
          ],
        },
      ],
    },
    {
      name: "Email the member their renewal reminder (needs email)",
      active: false,
      trigger: `schedule:${JSON.stringify({
        collection: "members",
        field: "renews_at",
        offset: { value: 7, unit: "days", direction: "before" },
        at: 600,
        timeZone: null,
        where: { status: { _eq: "active" } },
      })}`,
      operations: [
        {
          type: "email",
          to: "{{ data.email }}",
          subject: "Your membership renews on {{ data.renews_at }}",
          html: "<p>Your {{ data.plan.name }} membership renews next week. Nothing to do — get in touch if you would like to change plan.</p>",
        },
      ],
    },
    {
      name: "Monthly gym report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Gym overview",
          subject: "Gym — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "fitness_waiver",
      name: "Liability waiver",
      description: "What a member signs before their first session.",
      filename: "waiver-{{ data.id }}",
      variables: ["kind"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:12.5px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:14px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:34%;color:#555;font-weight:600}" +
        "h2{font-size:13px;margin:18px 0 4px}" +
        ".sign{margin-top:30px;border-top:1px solid #333;width:55%;padding-top:6px}" +
        "</style></head><body>" +
        "<h1>{{ data.kind }} waiver</h1>" +
        '<p class="muted">{{ data.member.name }}</p>' +
        "<table>" +
        "<tr><th>Email</th><td>{{ data.member.email }}</td></tr>" +
        "<tr><th>Emergency contact</th><td>{{ data.member.emergency_contact }}</td></tr>" +
        "<tr><th>Plan</th><td>{{ data.member.plan.name }}</td></tr>" +
        "</table>" +
        "<h2>Acknowledgement</h2>" +
        "<p>I confirm I am fit to take part in the activities offered here, that " +
        "I have declared any condition that affects my training, and that I take " +
        "part at my own risk. I will follow instruction from staff and report any " +
        "injury on the day it happens.</p>" +
        '<div class="sign">Member signature · date</div>' +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "fitness_payment_receipt",
      name: "Payment receipt",
      description: "Proof of a membership or package payment.",
      filename: "receipt-{{ data.id }}",
      variables: ["amount", "kind"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A5;margin:14mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:19px;margin:0 0 10px}" +
        "table{width:100%;border-collapse:collapse}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:40%;color:#555;font-weight:600}" +
        ".total{margin-top:14px;font-size:17px;font-weight:600;text-align:right}" +
        "</style></head><body>" +
        "<h1>Receipt</h1>" +
        "<table>" +
        "<tr><th>Member</th><td>{{ data.member.name }}</td></tr>" +
        "<tr><th>For</th><td>{{ data.kind }}</td></tr>" +
        "<tr><th>Period</th><td>{{ data.period }}</td></tr>" +
        "<tr><th>Paid</th><td>{{ data.paid_at }} by {{ data.method }}</td></tr>" +
        "</table>" +
        '<div class="total">{{ data.amount }}</div>' +
        "</body></html>",
      pageOptions: { format: "A5", margin: "14mm" },
    },
    {
      key: "fitness_progress_sheet",
      name: "Progress sheet",
      description: "A measurement a trainer hands to a member.",
      filename: "progress-{{ data.id }}",
      variables: ["measured_at"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A5;margin:14mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:19px;margin:0 0 2px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:12px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #eee}" +
        "th{width:46%;color:#555;font-weight:600}" +
        "</style></head><body>" +
        "<h1>{{ data.member.name }}</h1>" +
        '<p class="muted">Measured {{ data.measured_at }}</p>' +
        "<table>" +
        "<tr><th>Weight</th><td>{{ data.weight_kg }} kg</td></tr>" +
        "<tr><th>Body fat</th><td>{{ data.body_fat_pct }}</td></tr>" +
        "<tr><th>Muscle mass</th><td>{{ data.muscle_kg }} kg</td></tr>" +
        "<tr><th>PT sessions done</th><td>{{ data.member.pt_sessions_done }}</td></tr>" +
        "</table>" +
        "<p>{{ data.notes }}</p>" +
        '<p class="muted">One measurement is a point, not a trend — compare against ' +
        "the last one rather than reading this on its own.</p>" +
        "</body></html>",
      pageOptions: { format: "A5", margin: "14mm" },
    },
  ],
  forms: [
    {
      name: "Join the gym",
      collection: "members",
      settings: {
        submitLabel: "Join",
        successMessage: "Welcome — the front desk will set your plan and get your waiver signed on your first visit.",
      },
      // `plan` is a relation and cannot go on a form, which is the right shape
      // anyway: the desk sets the plan when they take payment.
      fields: [
        { name: "name", label: "Full name" },
        { name: "email", label: "Email" },
        { name: "phone" },
        { name: "emergency_contact", label: "Emergency contact", description: "Name and number of someone we can call." },
      ],
    },
  ],
  agents: [
    {
      name: "Gym manager assistant",
      handle: "gym-manager-assistant",
      description: "Answers questions about retention, attendance and revenue.",
      systemPrompt:
        "You help a gym manager read their own numbers. Answer questions " +
        "about members, plans, classes, sessions, bookings, check-ins, PT, " +
        "waivers, freezes and payments using the workspace's own data. " +
        "Attendance is the retention signal: a member's `visit_count` is " +
        "kept by the server from check-ins, and a member on an expensive " +
        "plan with few visits is the one about to cancel — surface those " +
        "before anybody asks. `paused` is a frozen membership, not a lost " +
        "one, so never count it as churn; `cancelled` is churn. A class " +
        "booking is only attendance when its status is `attended` — `booked` " +
        "is an intention and `no_show` is the opposite of attendance. " +
        "Revenue comes from `payments`, not from plan prices, because a plan " +
        "price is a list price nobody may have paid. Be brief, name the " +
        "member, and never speculate about anybody's health from a body " +
        "measurement — report the figures and leave the reading to a trainer.",
      tools: ["collections.list", "collections.read", "collections.aggregate", "collections.search"],
      maxSteps: 8,
    },
  ],
};
