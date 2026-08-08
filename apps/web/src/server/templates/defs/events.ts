import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, email, geo, half, hint, image, int, money, moneyIn, ms, notes, pct, phone, rel, sec, select, slugField, stacked, tabbed, text, ts, url, userLink } from "../dsl";

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
        ...half(text("number", { unique: true }), ts("placed_at", { indexed: true, label: "Placed at" })),
        ...half(rel("event", "events"), rel("buyer", "attendees")),
        ...half(
          select("status", [ch("pending", C.amber), ch("paid", C.green), ch("refunded", C.gray), ch("cancelled", C.red)], { default: "pending" }),
          moneyIn("total"),
        ),
        select("currency", ["USD", "EUR", "GBP", "TRY"], { default: "USD" }),
      ],
      samples: [{ number: "EVT-1001", event: { ref: "events:0" }, buyer: { ref: "attendees:0" }, status: "paid", total: 198, currency: "USD", placed_at: ms("2026-08-01") }],
    },
    {
      slug: "tickets", group: "Ticketing", singular: "Ticket", plural: "Tickets", defaultSort: "-created_at",
      fields: [
        ...half(rel("order", "orders"), rel("ticket_type", "ticket_types")),
        ...half(rel("attendee", "attendees"), text("code", { unique: true, label: "Ticket code" })),
        ...half(
          select("status", [ch("valid", C.green), ch("checked_in", C.blue, "Checked in"), ch("cancelled", C.red)], { default: "valid" }),
          ts("checked_in_at", { label: "Checked in at" }),
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
};
