import type { SchemaTemplate } from "../types";
import { C, bool, ch, date, email, file, flag, half, int, money, ms, notes, num, pct, phone, rel, sec, select, tabbed, text, ts, userLink } from "../dsl";

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
          date("signed_at", { indexed: true, label: "Signed" }),
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
      fields: [
        rel("member", "members"),
        ...half(
          date("starts_on", { range: { end: "ends_on", bounds: "[]" }, required: true, indexed: true, label: "Starts" }),
          date("ends_on", { label: "Ends", validation: { rule: { ends_on: { _gte: "$field.starts_on" } }, message: "A freeze must end on or after it starts." } }),
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
};
