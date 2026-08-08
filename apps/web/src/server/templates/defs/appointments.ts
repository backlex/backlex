import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, email, geo, half, hint, image, int, money, moneyIn, ms, notes, phone, position, rel, relMany, sec, select, stacked, tabbed, text, ts, userLink } from "../dsl";

export const appointments: SchemaTemplate = {
  id: "appointments",
  label: "Appointments / Scheduling",
  groups: ["Scheduling", "Catalog", "Packages", "People"],
  description:
    "Calendly-grade booking: bookable services with duration, buffer and price, staff with weekly availability and time-off blocks, multi-site locations, resources (rooms, stations), customers, bookings with payment status and reminders, custom intake questions, prepaid session packages, and a waitlist.",
  collections: [
    {
      slug: "locations", group: "Catalog", singular: "Location", plural: "Locations", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), phone("phone")),
        text("address"),
        ...half(text("city"), text("timezone", { default: "UTC", label: "Timezone (IANA)" })),
        geo("coordinates", ["address", "city"], { label: "Map pin" }),
        bool("active", { default: true, label: "Active" }),
      ],
      samples: [
        { name: "Downtown studio", address: "12 Main St", city: "Portland", timezone: "America/Los_Angeles", phone: "+15555550130", active: true },
        { name: "Eastside annex", address: "450 Burnside Ave", city: "Portland", timezone: "America/Los_Angeles", active: true },
      ],
    },
    {
      slug: "staff", group: "People", singular: "Staff member", plural: "Staff", defaultSort: "name",
      fields: stacked(
        sec("Staff member", [
          ...half(text("name", { required: true }), text("title")),
          ...half(email("email"), phone("phone")),
          ...half(image("avatar"), bool("active", { default: true, label: "Active" })),
        ]),
        sec("Profile", [notes("bio")], { folded: true }),
      ),
      samples: [{ name: "Maya Chen", title: "Senior consultant", email: "maya@example.com", active: true }, { name: "Leo Fontaine", title: "Consultant", email: "leo@example.com", active: true }],
    },
    {
      slug: "resources", group: "Catalog", singular: "Resource", plural: "Resources", defaultSort: "name",
      fields: [
        ...half(
          text("name", { required: true }),
          select("type", [ch("room", C.blue), ch("station", C.amber), ch("equipment", C.teal), ch("other", C.gray)], { default: "room" }),
        ),
        ...half(rel("location", "locations"), int("capacity", { default: 1, validation: { min: 1 } })),
        bool("active", { default: true, label: "Active" }),
      ],
      samples: [{ name: "Meeting room A", type: "room", location: { ref: "locations:0" }, capacity: 6, active: true }, { name: "Studio 1", type: "station", location: { ref: "locations:1" }, capacity: 1, active: true }],
    },
    {
      slug: "services", group: "Catalog", singular: "Service", plural: "Services", fts: true, defaultSort: "name",
      fields: stacked(
        sec("Service", [
          text("name", { required: true, searchable: true }),
          notes("description", { searchable: true }),
        ]),
        sec("Slot", [
          ...half(
            int("duration_minutes", { default: 30, validation: { min: 5 }, label: "Duration (min)" }),
            int("buffer_minutes", { default: 0, validation: { min: 0 }, label: "Buffer after (min)", description: "Dead time held after each booking for cleanup or travel." }),
          ),
          select("location_type", [ch("in_person", C.blue, "In person"), ch("video", C.purple), ch("phone", C.teal)], { default: "in_person", label: "Location" }),
        ]),
        sec("Pricing & staff", [
          ...half(moneyIn("price"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
          relMany("providers", "staff", { label: "Bookable staff" }),
          bool("active", { default: true, label: "Active" }),
        ]),
      ),
      samples: [
        { name: "Intro consultation", description: "30-minute discovery call.", duration_minutes: 30, buffer_minutes: 10, location_type: "video", price: 0, currency: "USD", active: true },
        { name: "Strategy session", description: "Deep-dive working session.", duration_minutes: 90, buffer_minutes: 15, location_type: "in_person", price: 240, currency: "USD", active: true },
      ],
    },
    {
      slug: "availability_rules", group: "Scheduling", singular: "Availability rule", plural: "Availability",
      fields: [
        ...half(
          rel("staff", "staff"),
          select("weekday", [ch("monday", C.blue), ch("tuesday", C.blue), ch("wednesday", C.blue), ch("thursday", C.blue), ch("friday", C.blue), ch("saturday", C.amber), ch("sunday", C.amber)], { default: "monday" }),
        ),
        ...half(text("start_time", { default: "09:00", label: "From (HH:MM)" }), text("end_time", { default: "17:00", label: "To (HH:MM)" })),
        bool("active", { default: true, label: "Active" }),
      ],
      samples: [
        { staff: { ref: "staff:0" }, weekday: "monday", start_time: "09:00", end_time: "17:00", active: true },
        { staff: { ref: "staff:0" }, weekday: "wednesday", start_time: "10:00", end_time: "16:00", active: true },
      ],
    },
    {
      slug: "blocked_times", group: "Scheduling", singular: "Blocked time", plural: "Blocked times", defaultSort: "-starts_at",
      fields: [
        ...half(
          rel("staff", "staff"),
          select("reason", [ch("time_off", C.amber, "Time off"), ch("break", C.teal), ch("training", C.purple)], { default: "time_off" }),
        ),
        ...half(
          ts("starts_at", { range: { end: "ends_at" }, required: true, indexed: true, label: "Starts at" }),
          ts("ends_at", { label: "Ends at", validation: { rule: { ends_at: { _gte: "$field.starts_at" } }, message: "The block must end after it starts." } }),
        ),
        notes("note"),
      ],
      samples: [
        { staff: { ref: "staff:1" }, starts_at: ms("2026-07-20T00:00:00Z"), ends_at: ms("2026-07-24T23:59:00Z"), reason: "time_off", note: "Summer vacation." },
        { staff: { ref: "staff:0" }, starts_at: ms("2026-07-16T12:00:00Z"), ends_at: ms("2026-07-16T13:00:00Z"), reason: "break" },
      ],
    },
    {
      slug: "customers", group: "People", singular: "Customer", plural: "Customers", fts: true, defaultSort: "name",
      portalLink: { emailField: "email", role: "Customer (portal)" },
      fields: [
        ...half(text("name", { required: true, searchable: true }), email("email")),
        ...half(phone("phone"), userLink()),
        notes("notes"),
      ],
      samples: [{ name: "Jordan Ellis", email: "jordan@example.com", phone: "+15555550142" }],
    },
    {
      slug: "bookings", group: "Scheduling", singular: "Booking", plural: "Bookings", defaultSort: "-starts_at",
      fields: tabbed(
        sec("Booking", [
          ...half(rel("service", "services"), rel("customer", "customers")),
          ...half(rel("staff", "staff"), rel("resource", "resources")),
          rel("location", "locations"),
          ...half(
            ts("starts_at", { range: { end: "ends_at" }, required: true, indexed: true, label: "Starts at" }),
            ts("ends_at", { label: "Ends at", validation: { rule: { ends_at: { _gte: "$field.starts_at" } }, message: "A booking must end after it starts." } }),
          ),
        ]),
        sec("Status", [
          ...half(
            select("status", [ch("pending", C.amber), ch("confirmed", C.blue), ch("completed", C.green), ch("cancelled", C.red), ch("no_show", C.slate, "No-show")], { default: "pending" }),
            select("payment_status", [ch("unpaid", C.gray), ch("paid", C.green), ch("refunded", C.red)], { default: "unpaid", label: "Payment" }),
          ),
          money("amount"),
          notes("notes"),
        ]),
      ),
      samples: [
        { service: { ref: "services:0" }, staff: { ref: "staff:0" }, customer: { ref: "customers:0" }, starts_at: ms("2026-07-14T15:00:00Z"), ends_at: ms("2026-07-14T15:30:00Z"), status: "confirmed", payment_status: "unpaid", amount: 0 },
        { service: { ref: "services:1" }, staff: { ref: "staff:1" }, resource: { ref: "resources:0" }, location: { ref: "locations:0" }, customer: { ref: "customers:0" }, starts_at: ms("2026-07-18T09:00:00Z"), ends_at: ms("2026-07-18T10:30:00Z"), status: "pending", payment_status: "paid", amount: 240 },
      ],
    },
    {
      slug: "reminders", group: "Scheduling", singular: "Reminder", plural: "Reminders",
      fields: [
        ...half(
          rel("booking", "bookings"),
          select("channel", [ch("email", C.blue), ch("sms", C.teal, "SMS")], { default: "email" }),
        ),
        ...half(
          int("minutes_before", { default: 60, validation: { min: 0 }, label: "Minutes before" }),
          select("status", [ch("scheduled", C.amber), ch("sent", C.green), ch("failed", C.red)], { default: "scheduled" }),
        ),
        ts("sent_at", { label: "Sent at" }),
      ],
      samples: [{ booking: { ref: "bookings:0" }, channel: "email", minutes_before: 60, status: "scheduled" }],
    },
    {
      slug: "booking_questions", group: "Catalog", singular: "Booking question", plural: "Booking questions", defaultSort: "position",
      fields: [
        ...half(rel("service", "services"), text("label", { required: true })),
        ...half(
          select("type", [ch("short_text", C.blue, "Short text"), ch("choice", C.purple), ch("yes_no", C.teal, "Yes / No")], { default: "short_text" }),
          text("choices", { label: "Choices (comma-separated)" }),
        ),
        ...half(bool("required", { default: false, label: "Required" }), position("service")),
      ],
      samples: [
        { service: { ref: "services:0" }, label: "What would you like to focus on?", type: "short_text", required: true, position: 1 },
        { service: { ref: "services:1" }, label: "Have you worked with us before?", type: "yes_no", required: false, position: 1 },
      ],
    },
    {
      slug: "booking_answers", group: "Scheduling", singular: "Booking answer", plural: "Booking answers",
      fields: [...half(rel("booking", "bookings"), rel("question", "booking_questions")), text("value")],
      samples: [{ booking: { ref: "bookings:0" }, question: { ref: "booking_questions:0" }, value: "Pricing strategy for our new product line." }],
    },
    {
      slug: "packages", group: "Packages", singular: "Package", plural: "Packages", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), rel("service", "services")),
        ...half(
          int("session_count", { default: 5, validation: { min: 1 }, label: "Sessions included" }),
          money("price"),
        ),
        ...half(
          int("validity_days", { default: 90, validation: { min: 1 }, label: "Valid for (days)" }),
          bool("active", { default: true, label: "Active" }),
        ),
      ],
      samples: [{ name: "Strategy 5-pack", service: { ref: "services:1" }, session_count: 5, price: 1050, validity_days: 180, active: true }],
    },
    {
      slug: "package_purchases", group: "Packages", singular: "Package purchase", plural: "Package purchases", defaultSort: "-purchased_at",
      fields: [
        hint("pkg_sessions_left", "Sessions left is generated as purchased − used."),
        ...half(rel("customer", "customers"), rel("package", "packages")),
        ...half(
          int("sessions_total", { default: 0, validation: { min: 0 }, label: "Sessions purchased" }),
          int("sessions_used", { default: 0, validation: { min: 0 }, label: "Sessions used" }),
        ),
        ...half(computedNum("sessions_left", "sessions_total - sessions_used", { label: "Sessions left" }), money("price_paid", { label: "Price paid" })),
        ...half(ts("purchased_at", { indexed: true, label: "Purchased at" }), date("expires_at", { label: "Expires" })),
      ],
      samples: [{ customer: { ref: "customers:0" }, package: { ref: "packages:0" }, sessions_total: 5, sessions_used: 1, price_paid: 1050, purchased_at: ms("2026-06-15T10:00:00Z"), expires_at: ms("2026-12-12") }],
    },
    {
      slug: "waitlist_entries", group: "Scheduling", singular: "Waitlist entry", plural: "Waitlist", defaultSort: "-requested_at",
      fields: [
        ...half(rel("service", "services"), rel("customer", "customers")),
        text("preferred_window", { label: "Preferred window" }),
        ...half(
          select("status", [ch("waiting", C.amber), ch("offered", C.blue), ch("booked", C.green), ch("expired", C.slate)], { default: "waiting", indexed: true }),
          ts("requested_at", { indexed: true, label: "Added at" }),
        ),
        notes("note"),
      ],
      samples: [
        { service: { ref: "services:1" }, customer: { ref: "customers:0" }, preferred_window: "Weekday mornings, week of Jul 20", status: "waiting", requested_at: ms("2026-07-09T14:00:00Z") },
      ],
    },
  ],
  roles: [
    {
      name: "Front desk",
      description: "Take and manage bookings, packages and the waitlist; read the service catalog and staff schedules.",
      permissions: [
        { collection: "locations", action: "read" },
        { collection: "staff", action: "read" },
        { collection: "resources", action: "read" },
        { collection: "services", action: "read" },
        { collection: "availability_rules", action: "read" },
        { collection: "blocked_times", action: "read" },
        { collection: "customers", action: "read" },
        { collection: "customers", action: "create" },
        { collection: "customers", action: "update" },
        { collection: "bookings", action: "read" },
        { collection: "bookings", action: "create" },
        { collection: "bookings", action: "update" },
        { collection: "reminders", action: "read" },
        { collection: "reminders", action: "create" },
        { collection: "reminders", action: "update" },
        { collection: "booking_questions", action: "read" },
        { collection: "booking_answers", action: "read" },
        { collection: "booking_answers", action: "create" },
        { collection: "booking_answers", action: "update" },
        { collection: "packages", action: "read" },
        { collection: "package_purchases", action: "read" },
        { collection: "package_purchases", action: "create" },
        { collection: "package_purchases", action: "update" },
        { collection: "waitlist_entries", action: "read" },
        { collection: "waitlist_entries", action: "create" },
        { collection: "waitlist_entries", action: "update" },
      ],
    },
    {
      name: "Practitioner",
      description: "See own schedule and bookings; manage own blocked times; read customers and intake answers.",
      permissions: [
        { collection: "locations", action: "read" },
        { collection: "staff", action: "read" },
        { collection: "resources", action: "read" },
        { collection: "services", action: "read" },
        { collection: "availability_rules", action: "read" },
        { collection: "blocked_times", action: "read" },
        { collection: "blocked_times", action: "create" },
        { collection: "blocked_times", action: "update" },
        { collection: "customers", action: "read" },
        { collection: "bookings", action: "read" },
        { collection: "bookings", action: "update" },
        { collection: "booking_questions", action: "read" },
        { collection: "booking_answers", action: "read" },
      ],
    },
    {
      name: "Customer (portal)",
      description: "Customer self-service portal: browse services, staff and availability, book and manage own appointments, join the waitlist, track own packages.",
      permissions: [
        { collection: "locations", action: "read" },
        { collection: "staff", action: "read" },
        { collection: "services", action: "read" },
        { collection: "availability_rules", action: "read" },
        { collection: "booking_questions", action: "read" },
        { collection: "packages", action: "read" },
        { collection: "customers", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "bookings", action: "read", condition: { "customer.app_user_id": { _eq: "$user.id" } } },
        { collection: "bookings", action: "create" },
        { collection: "bookings", action: "update", condition: { "customer.app_user_id": { _eq: "$user.id" } } },
        { collection: "package_purchases", action: "read", condition: { "customer.app_user_id": { _eq: "$user.id" } } },
        { collection: "waitlist_entries", action: "read", condition: { "customer.app_user_id": { _eq: "$user.id" } } },
        { collection: "waitlist_entries", action: "create" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Bookings overview",
      description: "Booking volume, status mix, packages and revenue.",
      panels: [
        { name: "Bookings", kind: "items-aggregate", viz: "counter", config: { collection: "bookings", agg: "count" } },
        { name: "Revenue", kind: "items-aggregate", viz: "counter", config: { collection: "bookings", agg: "sum", field: "amount" } },
        { name: "Customers", kind: "items-aggregate", viz: "counter", config: { collection: "customers", agg: "count" } },
        { name: "Waitlist", kind: "items-aggregate", viz: "counter", config: { collection: "waitlist_entries", agg: "count" } },
        { name: "Package revenue", kind: "items-aggregate", viz: "counter", config: { collection: "package_purchases", agg: "sum", field: "price_paid" } },
        { name: "Bookings by status", kind: "items-aggregate", viz: "donut", config: { collection: "bookings", agg: "count", groupBy: "status" } },
        { name: "Bookings by payment", kind: "items-aggregate", viz: "bars", config: { collection: "bookings", agg: "count", groupBy: "payment_status" } },
        { name: "Blocked time by reason", kind: "items-aggregate", viz: "bars", config: { collection: "blocked_times", agg: "count", groupBy: "reason" } },
      ],
    },
  ],
};
