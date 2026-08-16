import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, email, flag, geo, half, hint, image, int, money, moneyIn, ms, notes, phone, position, rel, relMany, sec, select, stacked, tabbed, text, ts, userLink, when } from "../dsl";

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
        flag("active", { label: "Active" }),
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
          ...half(image("avatar"), flag("active", { label: "Active" })),
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
        flag("active", { label: "Active" }),
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
          flag("active", { label: "Active" }),
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
        flag("active", { label: "Active" }),
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
      kanbanGroupBy: "status",
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
        ts("sent_at", { label: "Sent at", conditions: [when("status", "_neq", "sent", "hidden")] }),
      ],
      samples: [{ booking: { ref: "bookings:0" }, channel: "email", minutes_before: 60, status: "scheduled" }],
    },
    {
      slug: "booking_questions", group: "Catalog", singular: "Booking question", plural: "Booking questions", defaultSort: "position",
      fields: [
        ...half(rel("service", "services"), text("label", { required: true })),
        ...half(
          select("type", [ch("short_text", C.blue, "Short text"), ch("choice", C.purple), ch("yes_no", C.teal, "Yes / No")], { default: "short_text" }),
          // Only a choice question has choices — on every other kind the box is
          // a prompt for something that does not exist.
          text("choices", {
            label: "Choices (comma-separated)",
            conditions: [when("type", "_eq", "choice", "required"), when("type", "_neq", "choice", "hidden")],
          }),
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
          flag("active", { label: "Active" }),
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
      kanbanGroupBy: "status",
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
  /**
   * The rules a booking desk runs on, already running.
   *
   * Deliberately absent: "a booking was cancelled, so promote whoever is next
   * on the waitlist". Matching an entry needs this booking's service AND
   * whether the freed time falls inside an entry's `preferred_window`, which is
   * free text nothing can compare — and a flow's `data` is the booking row
   * alone. A step that offered the slot to the oldest waiting entry would offer
   * Tuesday morning to somebody who asked for evenings. So the flow reports the
   * slot and leaves the choice with the desk.
   */
  flows: [
    {
      name: "Queue a reminder as soon as a booking is taken",
      // The `reminders` collection is the record of intent, and nothing else
      // would ever put a row in it: a booking taken at the desk is exactly the
      // moment somebody decides the customer gets a nudge the day before. The
      // row is queued here; SENDING it needs a mail or SMS transport, which is
      // why the one flow below that actually leaves the workspace ships off.
      trigger: "event:items:bookings:created",
      operations: [
        {
          type: "item.create",
          collection: "reminders",
          data: {
            booking: "{{ data.id }}",
            channel: "email",
            minutes_before: 1440,
            status: "scheduled",
          },
        },
        {
          type: "notification",
          title: "A booking was taken",
          body: "It starts {{ data.starts_at }}, is {{ data.status }}, and payment is {{ data.payment_status }}. A 24-hour reminder is queued in Reminders.",
          url: "/collections/bookings",
        },
      ],
    },
    {
      name: "Chase a booking that is still unconfirmed the day before",
      // Fires once per booking, one day before `starts_at`, at 09:00 — and only
      // for the ones nobody has confirmed. That is the slot most likely to be
      // wasted: it is held, it is not agreed, and by tomorrow morning it is too
      // late to offer it to anyone else.
      trigger: `schedule:${JSON.stringify({
        collection: "bookings",
        field: "starts_at",
        offset: { value: 1, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "pending" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "Tomorrow's booking is still unconfirmed",
          body: "It starts {{ data.starts_at }} and has never moved off pending. Confirm it, or release the slot to the waitlist.",
          url: "/collections/bookings",
        },
      ],
    },
    {
      name: "Ask for an outcome once an appointment has finished",
      // Two hours AFTER `ends_at`, and with no time of day: a wall clock may
      // only pair with a day or week offset, since "two hours before, at 09:00"
      // names two different instants.
      //
      // Deliberately a notification rather than an `item.update` to
      // `completed`. The row cannot tell a finished appointment from one the
      // customer never turned up to — `completed` and `no_show` differ only in
      // what happened in the room — and quietly completing every no-show would
      // erase the one signal a cancellation policy is charged on.
      trigger: `schedule:${JSON.stringify({
        collection: "bookings",
        field: "ends_at",
        offset: { value: 2, unit: "hours", direction: "after" },
        at: null,
        timeZone: null,
        where: { status: { _in: ["pending", "confirmed"] } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "An appointment has finished with no outcome",
          body: "It ended {{ data.ends_at }} and is still {{ data.status }}. Mark it completed, or a no-show.",
          url: "/collections/bookings",
        },
      ],
    },
    {
      name: "Offer a cancelled slot to the waitlist",
      trigger: "event:items:bookings:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "cancelled" } },
          then: [
            {
              type: "notification",
              title: "A booking was cancelled — the slot is free",
              body: "It ran {{ data.starts_at }} to {{ data.ends_at }}. Check who is waiting for this service before the time is re-opened publicly.",
              url: "/collections/waitlist_entries",
            },
          ],
        },
      ],
    },
    {
      name: "Flag a package that is nearly used up",
      trigger: "event:items:package_purchases:updated",
      operations: [
        {
          type: "condition",
          // `sessions_left` is generated on the purchase row itself, which is
          // what makes this one of the few cross-row-looking rules a flow can
          // state honestly. Every later save at or below one notifies again; a
          // repeated line in the feed costs nothing to read past, and nothing
          // irreversible happens here.
          filter: { sessions_left: { _lte: 1 } },
          then: [
            {
              type: "notification",
              title: "A package is nearly used up",
              body: "{{ data.sessions_used }} of {{ data.sessions_total }} sessions used, {{ data.sessions_left }} left, and it expires {{ data.expires_at }}. Offer a renewal at the next appointment.",
              url: "/collections/package_purchases",
            },
          ],
        },
      ],
    },
    {
      name: "Email the confirmation and a calendar invite (needs email + a PDF renderer)",
      // Off until both are configured — the name carries the prerequisite so
      // nobody has to open it to find out. The `.ics` is the piece worth having
      // in this vertical: it reaches Google, Outlook and Apple Calendar with no
      // account connected anywhere, and `uid` is the booking's own id, so a
      // re-send updates the entry the customer already has rather than leaving
      // two appointments in their week.
      active: false,
      trigger: "event:items:bookings:updated",
      operations: [
        {
          type: "condition",
          filter: { status: { _eq: "confirmed" } },
          then: [
            { type: "document.render", templateKey: "appointment_confirmation" },
            {
              type: "email",
              to: "{{ data.customer.email }}",
              subject: "Your appointment is confirmed",
              html: "<p>Your appointment is confirmed — the details are attached, along with a calendar invite.</p>",
              attach: ["{{ $last.key }}"],
              ics: {
                summary: "{{ data.service.name }}",
                start: "{{ data.starts_at }}",
                end: "{{ data.ends_at }}",
                location: "{{ data.location.address }} {{ data.location.city }}",
                uid: "{{ data.id }}",
              },
            },
          ],
        },
      ],
    },
  ],
  documents: [
    {
      key: "appointment_confirmation",
      name: "Appointment confirmation",
      description: "The one page a customer is sent when a booking is agreed.",
      filename: "appointment-{{ data.starts_at }}",
      variables: ["starts_at", "ends_at"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:22px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:16px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5}" +
        "th{width:30%;color:#555;font-weight:600}" +
        "</style></head><body>" +
        "<h1>Appointment confirmed</h1>" +
        '<p class="muted">{{ data.service.name }}</p>' +
        "<table>" +
        "<tr><th>Who</th><td>{{ data.customer.name }}</td></tr>" +
        "<tr><th>With</th><td>{{ data.staff.name }}</td></tr>" +
        "<tr><th>When</th><td>{{ data.starts_at }} — {{ data.ends_at }}</td></tr>" +
        "<tr><th>Where</th><td>{{ data.location.name }}<br>{{ data.location.address }} {{ data.location.city }}</td></tr>" +
        "<tr><th>Room</th><td>{{ data.resource.name }}</td></tr>" +
        "<tr><th>Payment</th><td>{{ data.payment_status }} · {{ data.amount }}</td></tr>" +
        "</table>" +
        '<p class="muted">{{ data.notes }}</p>' +
        '<p class="muted">Times are shown in the timezone of the location above. ' +
        "Tell us as early as you can if you need to move it — the slot is held for you until then.</p>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "package_card",
      name: "Package card",
      description: "What is left on a prepaid block of sessions, and until when.",
      filename: "package-{{ data.purchased_at }}",
      variables: ["sessions_total", "sessions_used", "expires_at"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:20mm}" +
        "body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:16px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5}" +
        "th{width:34%;color:#555;font-weight:600}" +
        "</style></head><body>" +
        "<h1>{{ data.package.name }}</h1>" +
        '<p class="muted">Prepaid sessions for {{ data.customer.name }}</p>' +
        "<table>" +
        "<tr><th>Purchased</th><td>{{ data.purchased_at }}</td></tr>" +
        "<tr><th>Sessions</th><td>{{ data.sessions_total }}</td></tr>" +
        "<tr><th>Used</th><td>{{ data.sessions_used }}</td></tr>" +
        "<tr><th>Left</th><td><strong>{{ data.sessions_left }}</strong></td></tr>" +
        "<tr><th>Expires</th><td>{{ data.expires_at }}</td></tr>" +
        "<tr><th>Paid</th><td>{{ data.price_paid }}</td></tr>" +
        "</table>" +
        '<p class="muted">Unused sessions lapse on the expiry date. Bring this card, ' +
        "or just give your name — we hold the same figures here.</p>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
  ],
  forms: [
    {
      // Named for its collection, not generically: bundles are skipped by NAME
      // and a workspace can apply more than one template, so two forms sharing
      // a name means the second is silently skipped and the workspace keeps one
      // pointing at the other vertical's collection.
      name: "New customer details (bookings)",
      collection: "customers",
      settings: {
        submitLabel: "Send my details",
        successMessage: "Thank you — we have your details and will confirm your first appointment.",
      },
      fields: [
        { name: "name", label: "Full name" },
        { name: "email", label: "Email", help: "Where the confirmation and reminders are sent." },
        { name: "phone" },
        { name: "notes", label: "Anything we should know?", help: "Access needs, preferred times, or what you'd like to cover." },
      ],
    },
    {
      // A link rather than an admin screen on purpose: in this vertical the
      // people who need time off are practitioners, and practitioners are
      // rarely given a workspace login. The request lands with no `staff` on it
      // — a relation cannot appear on a public form — so whoever owns the
      // schedule attaches the person before the block counts against
      // availability, which is what `description` says out loud rather than
      // leaving somebody to discover it.
      name: "Time-off request",
      collection: "blocked_times",
      settings: {
        description: "Ask for time off. It only blocks the calendar once the schedule owner attaches your name to it.",
        submitLabel: "Request time off",
        successMessage: "Sent — you'll hear back once it has been approved.",
      },
      fields: [
        { name: "reason", label: "Reason" },
        { name: "starts_at", label: "From" },
        { name: "ends_at", label: "Until" },
        { name: "note", label: "Note", help: "Anything the desk needs to know while you're away." },
      ],
    },
  ],
  agents: [
    {
      name: "Schedule assistant",
      handle: "schedule-assistant",
      description: "Answers questions about the diary, who is free, and what is still unconfirmed.",
      systemPrompt:
        "You help a booking desk run its diary. Answer questions about services, " +
        "staff, customers, bookings, packages and the waitlist using the " +
        "workspace's own data. A slot is only genuinely free when an availability " +
        "rule covers it AND no blocked time overlaps it AND no booking already " +
        "holds it — check all three before telling anyone somebody is available. " +
        "A booking still occupies the calendar while it is pending or confirmed; " +
        "cancelled and no-show do not, and completed is in the past. What a " +
        "booking really consumes is the service's duration_minutes plus its " +
        "buffer_minutes, so never fit a second appointment into the buffer. " +
        "Times are stored as instants and read against the location's own " +
        "timezone — say which zone you mean whenever an answer is an hour. " +
        "Amounts in different currencies are never added together. When a figure " +
        "has a seeded KPI — bookings taken, booking revenue, cancellations — run " +
        "that definition rather than adding rows up your own way, so your answer " +
        "matches the dashboard. Be brief, name the customer and the time you " +
        "mean, and say plainly when the data does not answer the question.",
      tools: [
        "collections.list",
        "collections.read",
        "collections.aggregate",
        "collections.search",
        "kpis.run",
        "dashboards.run",
      ],
      maxSteps: 8,
    },
  ],
};
