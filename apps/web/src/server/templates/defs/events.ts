import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, email, geo, half, hint, image, int, money, moneyIn, ms, notes, pct, phone, rel, sec, select, seq, slugField, stacked, tabbed, text, ts, url, userLink, when } from "../dsl";

export const events: SchemaTemplate = {
  id: "events",
  label: "Events / Booking",
  groups: ["Events", "Ticketing", "Attendees", "Expo", "Finance"],
  description:
    "Eventbrite-grade ticketing: events with venues & sessions, tiered ticket types with capacity, attendees, orders and individual issued tickets with check-in — plus sponsors & expo booths, discount codes and per-event budgets.",
  collections: [
    { slug: "media", group: "Events", singular: "Media", plural: "Media", fields: [image("file"), text("alt", { label: "Alt text" })] },
    {
      slug: "venues", group: "Events", singular: "Venue", plural: "Venues", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), int("capacity", { validation: { min: 0 } })),
        text("address"),
        ...half(text("city"), text("country")),
        geo("coordinates", ["address", "city", "country"], { label: "Map pin" }),
      ],
      samples: [{ name: "Main Hall", address: "1 Conference Way", city: "Austin", country: "US", capacity: 500 }],
    },
    {
      slug: "organizers", group: "Events", singular: "Organizer", plural: "Organizers", defaultSort: "name",
      fields: [text("name", { required: true }), ...half(email("email"), url("website"))],
      samples: [{ name: "Backlex Events", email: "events@backlex.example" }],
    },
    {
      slug: "speakers", group: "Events", singular: "Speaker", plural: "Speakers", defaultSort: "name",
      note: "The people on stage — a session's speaker is a record, not a free-text name.",
      fields: stacked(
        sec("Speaker", [
          ...half(text("name", { required: true }), text("title", { label: "Job title" })),
          ...half(text("company"), image("photo")),
          notes("bio"),
        ]),
        sec("Contact", [
          ...half(email("email"), text("twitter", { label: "Twitter / X handle" })),
          url("website"),
        ], { folded: true }),
      ),
      samples: [
        { name: "Ada Lovelace", title: "Principal Engineer", company: "Acme", email: "ada@acme.example", bio: "Works on data platforms and developer tooling." },
        { name: "Grace Hopper", title: "VP Engineering", company: "Globex", email: "grace@globex.example" },
      ],
    },
    {
      slug: "events", group: "Events", singular: "Event", plural: "Events", versioned: true, vectorize: true, fts: true, defaultSort: "-start_at",
      kanbanGroupBy: "status",
      fields: tabbed(
        sec("Event", [
          ...half(text("title", { required: true, vectorize: true, searchable: true }), slugField("title")),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true },
          ...half(rel("organizer", "organizers"), rel("venue", "venues")),
          ...half(
            select("status", [ch("draft", C.gray), ch("on_sale", C.green, "On sale"), ch("sold_out", C.amber, "Sold out"), ch("cancelled", C.red), ch("completed", C.slate)], { default: "draft" }),
            select("type", [ch("conference", C.blue), ch("workshop", C.teal), ch("concert", C.purple), ch("webinar", C.amber), ch("meetup", C.gray)], { default: "conference" }),
          ),
        ]),
        sec("Schedule", [
          ...half(ts("start_at", { range: { end: "end_at" }, indexed: true, label: "Starts at" }), ts("end_at", { label: "Ends at" })),
          ...half(text("timezone", { label: "Timezone" }), bool("online", { default: false, label: "Online event" })),
        ]),
        sec("Media", [image("cover")]),
      ),
      samples: [{ title: "Backlex Conf 2026", slug: "backlex-conf-2026", description: "Our annual user conference.", organizer: { ref: "organizers:0" }, venue: { ref: "venues:0" }, status: "on_sale", type: "conference", start_at: ms("2026-10-01T09:00:00Z"), end_at: ms("2026-10-01T17:00:00Z") }],
    },
    {
      slug: "sessions", group: "Events", singular: "Session", plural: "Sessions", defaultSort: "start_at",
      fields: stacked(
        sec("Session", [
          ...half(rel("event", "events"), text("title")),
          notes("description"),
          ...half(rel("speaker", "speakers"), text("track")),
        ]),
        sec("Slot", [
          ...half(ts("start_at", { range: { end: "end_at" }, indexed: true, label: "Starts at" }), ts("end_at", { label: "Ends at" })),
          ...half(text("room"), int("capacity", { validation: { min: 0 } })),
        ]),
      ),
      samples: [{ event: { ref: "events:0" }, title: "Opening keynote", speaker: { ref: "speakers:0" }, track: "Main", room: "Main Hall", capacity: 500, start_at: ms("2026-10-01T09:30:00Z"), end_at: ms("2026-10-01T10:30:00Z") }],
    },
    {
      slug: "sponsors", group: "Expo", singular: "Sponsor", plural: "Sponsors", defaultSort: "name",
      fields: stacked(
        sec("Sponsor", [
          ...half(rel("event", "events"), text("name", { required: true })),
          ...half(
            select("tier", [ch("platinum", C.slate), ch("gold", C.amber), ch("silver", C.gray), ch("community", C.teal)], { default: "community" }),
            money("amount"),
          ),
          image("logo"),
        ]),
        sec("Contact", [
          ...half(text("contact_name", { label: "Contact name" }), email("contact_email", { label: "Contact email" })),
        ]),
      ),
      samples: [
        { event: { ref: "events:0" }, name: "Cloudpeak", tier: "gold", amount: 15000, contact_name: "Ana Silva", contact_email: "ana@cloudpeak.example" },
        { event: { ref: "events:0" }, name: "DevTools Co", tier: "community", amount: 1500, contact_name: "Ben Okafor", contact_email: "ben@devtools.example" },
      ],
    },
    {
      slug: "booths", group: "Expo", singular: "Booth", plural: "Booths", defaultSort: "number",
      kanbanGroupBy: "status",
      fields: [
        ...half(rel("event", "events"), text("number", { unique: true, label: "Booth #" })),
        ...half(
          select("size", [ch("small", C.gray), ch("medium", C.blue), ch("large", C.purple)], { default: "small" }),
          money("price"),
        ),
        ...half(
          rel("sponsor", "sponsors"),
          select("status", [ch("available", C.green), ch("reserved", C.amber), ch("occupied", C.blue)], { default: "available" }),
        ),
      ],
      samples: [
        { event: { ref: "events:0" }, number: "B-12", size: "large", sponsor: { ref: "sponsors:0" }, price: 4000, status: "reserved" },
        { event: { ref: "events:0" }, number: "B-13", size: "small", price: 900, status: "available" },
      ],
    },
    {
      slug: "ticket_types", group: "Ticketing", singular: "Ticket type", plural: "Ticket types", defaultSort: "price",
      fields: stacked(
        sec("Ticket type", [
          ...half(rel("event", "events"), text("name")),
          ...half(moneyIn("price"), select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" })),
        ]),
        sec("Inventory & limits", [
          ...half(
            int("quantity", { validation: { min: 0 }, label: "Quantity" }),
            int("sold", { default: 0, validation: { min: 0 }, label: "Sold" }),
          ),
          ...half(int("min_per_order", { default: 1, label: "Min per order" }), int("max_per_order", { default: 10, label: "Max per order" })),
          ...half(ts("sales_start", { range: { end: "sales_end" }, label: "Sales start" }), ts("sales_end", { label: "Sales end" })),
        ]),
      ),
      samples: [{ event: { ref: "events:0" }, name: "General Admission", price: 99, currency: "USD", quantity: 400, sold: 120 }, { event: { ref: "events:0" }, name: "VIP", price: 249, currency: "USD", quantity: 50, sold: 12 }],
    },
    {
      slug: "discount_codes", group: "Ticketing", singular: "Discount code", plural: "Discount codes", defaultSort: "-created_at",
      fields: [
        ...half(rel("event", "events"), text("code", { unique: true, required: true })),
        ...half(pct("percent_off", { label: "Percent off" }), int("max_uses", { validation: { min: 0 }, label: "Max uses" })),
        ...half(int("uses", { default: 0, validation: { min: 0 } }), ts("valid_until", { indexed: true, label: "Valid until" })),
        select("status", [ch("active", C.green), ch("expired", C.gray), ch("disabled", C.red)], { default: "active" }),
      ],
      samples: [{ event: { ref: "events:0" }, code: "EARLYBIRD20", percent_off: 20, max_uses: 100, uses: 37, valid_until: ms("2026-08-31"), status: "active" }],
    },
    {
      slug: "attendees", group: "Attendees", singular: "Attendee", plural: "Attendees", defaultSort: "name",
      portalLink: { emailField: "email", role: "Attendee (portal)" },
      fields: [
        ...half(text("name"), email("email", { required: true })),
        ...half(phone("phone"), text("company")),
        userLink(),
      ],
      samples: [{ name: "Jordan Reed", email: "jordan@example.com", company: "Acme" }],
    },
    {
      slug: "orders", group: "Ticketing", singular: "Order", plural: "Orders", defaultSort: "-placed_at",
      fields: [
        ...half(seq("number", "EVT-{YYYY}-{####}"), ts("placed_at", { indexed: true, label: "Placed at" })),
        ...half(rel("event", "events"), rel("buyer", "attendees")),
        ...half(
          select("status", [ch("pending", C.amber), ch("paid", C.green), ch("refunded", C.gray), ch("cancelled", C.red)], { default: "pending" }),
          moneyIn("total"),
        ),
        select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
      ],
      samples: [{ event: { ref: "events:0" }, buyer: { ref: "attendees:0" }, status: "paid", total: 198, currency: "USD", placed_at: ms("2026-08-01") }],
    },
    {
      slug: "tickets", group: "Ticketing", singular: "Ticket", plural: "Tickets", defaultSort: "-created_at",
      fields: [
        ...half(rel("order", "orders"), rel("ticket_type", "ticket_types")),
        ...half(rel("attendee", "attendees"), text("code", { unique: true, label: "Ticket code" })),
        ...half(
          select("status", [ch("valid", C.green), ch("checked_in", C.blue, "Checked in"), ch("cancelled", C.red)], { default: "valid" }),
          ts("checked_in_at", { label: "Checked in at", conditions: [when("status", "_neq", "checked_in", "hidden")] }),
        ),
      ],
      samples: [
        { order: { ref: "orders:0" }, ticket_type: { ref: "ticket_types:0" }, attendee: { ref: "attendees:0" }, code: "TIX-AAA-001", status: "valid" },
        { order: { ref: "orders:0" }, ticket_type: { ref: "ticket_types:0" }, attendee: { ref: "attendees:0" }, code: "TIX-AAA-002", status: "valid" },
      ],
    },
    {
      slug: "check_ins", group: "Attendees", singular: "Check-in", plural: "Check-ins", defaultSort: "-checked_in_at",
      fields: [
        ...half(rel("ticket", "tickets"), rel("attendee", "attendees")),
        ...half(ts("checked_in_at", { indexed: true, label: "Checked in at" }), text("gate", { label: "Gate / station" })),
      ],
      samples: [{ ticket: { ref: "tickets:0" }, attendee: { ref: "attendees:0" }, checked_in_at: ms("2026-10-01T08:45:00Z"), gate: "Gate A" }],
    },
    {
      slug: "event_budgets", group: "Finance", singular: "Budget line", plural: "Event budgets", defaultSort: "category",
      fields: [
        hint("event_budget_variance", "Variance is generated as planned − actual; a negative number means the line overran."),
        ...half(
          rel("event", "events"),
          select("category", [ch("venue", C.blue), ch("catering", C.teal), ch("av", C.purple, "A/V"), ch("marketing", C.amber), ch("speakers", C.green)], { default: "venue" }),
        ),
        ...half(money("planned"), money("actual")),
        computedNum("variance", "planned - actual", { label: "Variance" }),
        notes("note"),
      ],
      samples: [
        { event: { ref: "events:0" }, category: "venue", planned: 12000, actual: 12500 },
        { event: { ref: "events:0" }, category: "catering", planned: 8000, actual: 6900 },
      ],
    },
  ],
  roles: [
    {
      name: "Event staff",
      description: "Door & box office: look up orders, attendees and tickets, record check-ins and mark tickets checked in.",
      permissions: [
        { collection: "events", action: "read" },
        { collection: "sessions", action: "read" },
        { collection: "attendees", action: "read" },
        { collection: "orders", action: "read" },
        { collection: "ticket_types", action: "read" },
        { collection: "tickets", action: "read" },
        { collection: "tickets", action: "update" },
        { collection: "check_ins", action: "read" },
        { collection: "check_ins", action: "create" },
      ],
    },
    {
      name: "Sponsorship manager",
      description: "Sell and manage sponsorships and expo booths; read events and budgets.",
      permissions: [
        { collection: "events", action: "read" },
        { collection: "sponsors", action: "read" },
        { collection: "sponsors", action: "create" },
        { collection: "sponsors", action: "update" },
        { collection: "booths", action: "read" },
        { collection: "booths", action: "create" },
        { collection: "booths", action: "update" },
        { collection: "event_budgets", action: "read" },
      ],
    },
    {
      name: "Attendee (portal)",
      description: "Signed-in attendee self-service: browse events, sessions and ticket types; see and update own registration, orders and tickets.",
      permissions: [
        { collection: "events", action: "read" },
        { collection: "sessions", action: "read" },
        { collection: "ticket_types", action: "read" },
        { collection: "attendees", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "attendees", action: "update", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "orders", action: "read", condition: { "buyer.app_user_id": { _eq: "$user.id" } } },
        { collection: "tickets", action: "read", condition: { "attendee.app_user_id": { _eq: "$user.id" } } },
        { collection: "tickets", action: "update", condition: { "attendee.app_user_id": { _eq: "$user.id" } } },
      ],
    },
  ],
  dashboards: [
    {
      name: "Event overview",
      description: "Ticket sales, check-in flow, sponsorship and budget.",
      panels: [
        { name: "Events", kind: "items-aggregate", viz: "counter", config: { collection: "events", agg: "count" } },
        { name: "Tickets issued", kind: "items-aggregate", viz: "counter", config: { collection: "tickets", agg: "count" } },
        { name: "Ticket revenue", kind: "items-aggregate", viz: "counter", config: { collection: "orders", agg: "sum", field: "total" } },
        { name: "Sponsorship raised", kind: "items-aggregate", viz: "counter", config: { collection: "sponsors", agg: "sum", field: "amount" } },
        { name: "Events by status", kind: "items-aggregate", viz: "donut", config: { collection: "events", agg: "count", groupBy: "status" } },
        { name: "Tickets by status", kind: "items-aggregate", viz: "donut", config: { collection: "tickets", agg: "count", groupBy: "status" } },
        { name: "Orders by status", kind: "items-aggregate", viz: "bars", config: { collection: "orders", agg: "count", groupBy: "status" } },
        { name: "Sponsors by tier", kind: "items-aggregate", viz: "donut", config: { collection: "sponsors", agg: "count", groupBy: "tier" } },
      ],
    },
  ],
  /**
   * The rules a ticketed event runs on, already running.
   *
   * Deliberately absent: "an order was paid, so take those seats off the tier".
   * What was actually sold lives on the individual `tickets` rows and the
   * running count lives on `ticket_types.sold` — a flow's `data` is the order
   * row and can see neither, a `foreach` filter compiles to SQL over one
   * collection with no way to name the row that fired it, and an `item.update`
   * writes a VALUE rather than a delta, so even counting up by one is not
   * something a step could state. The flows below report the sale and leave the
   * count with the box office; the sell-out rule further down is the one
   * cross-column question this vertical can answer honestly, because both
   * numbers sit on the same row.
   */
  flows: [
    {
      name: "Tell the box office when a ticket order is placed",
      trigger: "event:items:orders:created",
      operations: [
        {
          type: "notification",
          title: "Order {{ data.number }} placed",
          body: "{{ data.total }} {{ data.currency }}, and the order is {{ data.status }}. Nobody can be scanned in on it yet — a ticket has to be issued against the order first.",
          url: "/collections/orders",
        },
      ],
    },
    {
      name: "Mark a ticket checked in when the door logs a scan",
      // The check-in row carries its own `ticket`, so this is one of the very
      // few cross-row moves a flow can make honestly: the id is ON the row that
      // fired, not down a join it cannot walk.
      //
      // Silent on purpose — no notification. A gate scans hundreds of codes in
      // an hour, and a feed with one line per admission is a feed nobody reads
      // the important entries out of. The check-in list is already the record.
      //
      // It sets the status and nothing else. `checked_in_at` on the ticket is
      // deliberately left alone: the check-in row already holds when the scan
      // happened, and two columns answering "when did they arrive?" is worse
      // than either.
      trigger: "event:items:check_ins:created",
      operations: [
        {
          type: "item.update",
          collection: "tickets",
          id: "{{ data.ticket }}",
          data: { status: "checked_in" },
        },
      ],
    },
    {
      name: "Brief the team the morning before an event opens its doors",
      // Fires once per event, one day before `start_at`, at 09:00 — and only
      // for events that are actually happening. `_in` rather than `_neq`,
      // because "not cancelled" has to also exclude the drafts nobody has put
      // on sale and the ones already completed.
      trigger: `schedule:${JSON.stringify({
        collection: "events",
        field: "start_at",
        offset: { value: 1, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { status: { _in: ["on_sale", "sold_out"] } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "{{ data.title }} opens tomorrow",
          body: "Doors {{ data.start_at }} ({{ data.timezone }}). Pull the door list, staff the gates, and walk the run sheet with the venue before tonight.",
          url: "/collections/events",
        },
      ],
    },
    {
      name: "Say so when a ticket tier sells out",
      // No transition trigger is available and none would fit: this is a
      // COUNTER crossing a threshold, not a status moving, and `sold` declares
      // no lifecycle to announce. So it re-announces on every later save of a
      // full tier — a repeated line in the feed costs nothing to read past, and
      // nothing irreversible happens here.
      trigger: "event:items:ticket_types:updated",
      operations: [
        {
          type: "condition",
          // `sold` and `quantity` are both on the tier, so `$field.` compares
          // them in memory — the only capacity question a flow can answer
          // without a join. The `quantity` guard is not decoration: an
          // uncapped tier leaves the column null, null compares as 0, and
          // without it every save of an unlimited tier would announce a
          // sell-out.
          filter: { quantity: { _gt: 0 }, sold: { _gte: "$field.quantity" } },
          then: [
            {
              type: "notification",
              title: "{{ data.name }} has sold out",
              body: "{{ data.sold }} of {{ data.quantity }} gone. Close the tier's sales window or raise its quantity — whether the EVENT is sold out is a separate call, because the other tiers on it may still have room.",
              url: "/collections/ticket_types",
            },
          ],
        },
      ],
    },
    {
      name: "Email the attendee their ticket when it is issued (needs email + a PDF renderer)",
      // Off until both are configured — the name carries the prerequisite so
      // nobody has to open it to find out.
      //
      // Triggered on the TICKET being issued rather than on the order turning
      // paid, and that is what makes it safe without a lifecycle to key off: a
      // ticket is created once, for one person, and the row already names who.
      // The message goes out once by construction instead of by a condition
      // trying to spot a move it has no before-image for.
      active: false,
      trigger: "event:items:tickets:created",
      operations: [
        { type: "document.render", templateKey: "event_ticket" },
        {
          type: "email",
          to: "{{ data.attendee.email }}",
          subject: "Your ticket — {{ data.code }}",
          html: "<p>Your ticket is attached. The code printed on it is what the gate scans, so bring it on a phone or on paper.</p>",
          attach: ["{{ $last.key }}"],
        },
      ],
    },
    {
      name: "Monthly event report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Event overview",
          subject: "Events — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "event_ticket",
      name: "Event ticket",
      description: "The one page an attendee shows at the gate.",
      filename: "ticket-{{ data.code }}",
      variables: ["code", "status"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:18mm}" +
        "body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:22px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        ".code{font:28px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:3px;" +
        "border:2px solid #111;border-radius:8px;padding:14px 18px;display:inline-block;margin:16px 0}" +
        "table{width:100%;border-collapse:collapse;margin-top:14px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5}" +
        "th{width:34%;color:#555;font-weight:600}" +
        "</style></head><body>" +
        "<h1>Admission ticket</h1>" +
        '<p class="muted">{{ data.ticket_type.name }} · order {{ data.order.number }}</p>' +
        '<div class="code">{{ data.code }}</div>' +
        "<table>" +
        "<tr><th>Attendee</th><td>{{ data.attendee.name }}</td></tr>" +
        "<tr><th>Email</th><td>{{ data.attendee.email }}</td></tr>" +
        "<tr><th>Ticket type</th><td>{{ data.ticket_type.name }}</td></tr>" +
        "<tr><th>Status</th><td>{{ data.status }}</td></tr>" +
        "</table>" +
        "<!-- the event's own title and doors time sit two relations away " +
        "(ticket to order to event), which this render does not walk; print them " +
        "from your own query if the ticket has to carry them -->" +
        '<p class="muted">One admission per code. The gate scans the code above and ' +
        "the ticket is marked checked in — a second scan is recorded as another " +
        "check-in rather than refused, so re-entry is a door policy, not a rule " +
        "this ticket enforces.</p>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "18mm" },
    },
    {
      key: "event_run_sheet",
      name: "Event run sheet",
      description: "The page the show is run off on the day — schedule, rooms and who is on stage.",
      filename: "run-sheet-{{ data.slug }}",
      variables: ["title", "start_at", "end_at"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:16mm}" +
        "body{font:12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:21px;margin:0 0 4px}" +
        "h2{font-size:14px;margin:18px 0 6px}" +
        ".muted{color:#666}" +
        "table{width:100%;border-collapse:collapse;margin-top:8px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5;vertical-align:top}" +
        "th{color:#555;font-weight:600}" +
        "</style></head><body>" +
        "<h1>{{ data.title }}</h1>" +
        '<p class="muted">{{ data.start_at }} — {{ data.end_at }} ({{ data.timezone }}) · ' +
        "{{ data.venue.name }}, {{ data.venue.address }} {{ data.venue.city }}</p>" +
        '<p class="muted">Organiser: {{ data.organizer.name }} · {{ data.organizer.email }} · ' +
        "status {{ data.status }}</p>" +
        "<h2>Schedule</h2>" +
        "<table><thead><tr><th>Start</th><th>End</th><th>Room</th><th>Track</th>" +
        "<th>Session</th><th>Speaker</th></tr></thead><tbody>" +
        "<!-- one row per session of this event, in start order; fill from your " +
        "own query or a foreach -->" +
        "</tbody></table>" +
        "<h2>On the day</h2>" +
        '<p class="muted">The venue capacity on the record is the ceiling for the ' +
        "whole site; each room's own capacity is on its session. Gates mark a " +
        "ticket checked in as they scan it, so the check-in list is the live count " +
        "of who is actually in the building.</p>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "16mm" },
    },
  ],
  forms: [
    {
      // Named for its collection AND its vertical: bundles are skipped by name,
      // a workspace may hold two templates, and a shared name would leave one
      // form quietly writing into the other vertical's table.
      name: "Attendee registration (events)",
      collection: "attendees",
      settings: {
        submitLabel: "Register",
        successMessage: "You're registered — your ticket follows by email once the order is confirmed.",
      },
      fields: [
        { name: "name", label: "Full name" },
        { name: "email", label: "Email", help: "Where the ticket and any schedule changes are sent." },
        { name: "phone", help: "Only used if something changes on the day." },
        { name: "company", label: "Company or organisation" },
      ],
    },
    {
      // The link an organiser sends a confirmed speaker to collect the details
      // the programme is set from — not a call for papers: this collection
      // holds a person, and a talk is a `sessions` row the team schedules.
      // `name` is exposed because the schema requires it; a required field left
      // off the form makes the whole apply fail.
      name: "Speaker profile (events)",
      collection: "speakers",
      settings: {
        submitLabel: "Send my details",
        successMessage: "Thank you — this goes straight onto the programme.",
      },
      fields: [
        { name: "name", label: "Full name", help: "Exactly as it should appear on the programme." },
        { name: "title", label: "Job title" },
        { name: "company", label: "Company" },
        { name: "email", label: "Email", help: "Used only for schedule and stage-time changes." },
        { name: "bio", label: "Speaker bio", help: "Two or three sentences — this is read out and printed as written." },
        { name: "website", label: "Website" },
        { name: "twitter", label: "Twitter / X handle" },
      ],
    },
  ],
  agents: [
    {
      name: "Box office assistant",
      handle: "box-office-assistant",
      description: "Answers questions about sales, capacity and who is through the gate.",
      systemPrompt:
        "You help an events team run its box office. Answer questions about " +
        "events, ticket types, orders, tickets, attendees, check-ins, sponsors " +
        "and budgets using the workspace's own data. Capacity is per TICKET " +
        "TYPE — what is left is that tier's `quantity` minus its `sold`, never " +
        "the venue's capacity, which is the building and not what was put on " +
        "sale. An event is only sold out when every one of its tiers is. " +
        "Attendance is the tickets whose status is `checked_in`; a check-in row " +
        "is one scan at one gate, so counting rows double-counts anybody who " +
        "left and came back. Never add money in different currencies together — " +
        "an order carries its own currency. On budgets, variance is planned " +
        "minus actual, so a negative number means the line overran. Be brief, " +
        "always name the event and the tier you mean, and say plainly when the " +
        "data does not answer the question.",
      tools: [
        "collections.list",
        "collections.read",
        "collections.aggregate",
        "collections.search",
        "dashboards.run",
      ],
      maxSteps: 8,
    },
  ],
};
