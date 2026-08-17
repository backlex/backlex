import type { SchemaTemplate } from "../types";
import { C, bool, ch, computedNum, date, divider, email, file, geo, half, hint, image, int, money, ms, notes, num, pct, phone, rel, relMany, sec, select, slugField, stacked, tabbed, tags, text, ts, when } from "../dsl";

export const realEstate: SchemaTemplate = {
  id: "real-estate",
  label: "Real estate",
  groups: ["Listings", "People", "Deals", "Management"],
  description:
    "Full brokerage + property management: listings with owners and agents, inquiries, viewings, open houses, offers, closed transactions with commission, and a rental side with leases, rent collection and maintenance.",
  collections: [
    { slug: "media", group: "Listings", singular: "Media", plural: "Media", fields: [file("file"), text("alt", { label: "Alt text" })] },
    {
      slug: "agents", group: "People", singular: "Agent", plural: "Agents", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), email("email", { unique: true })),
        ...half(phone("phone"), text("license_number", { label: "License #" })),
        ...half(text("agency"), image("photo")),
      ],
      samples: [{ name: "Casey Morgan", email: "casey@realty.example", phone: "+15555550170", license_number: "RE-558210", agency: "Skyline Realty" }],
    },
    {
      slug: "owners", group: "People", singular: "Owner", plural: "Owners", defaultSort: "name",
      fields: [
        ...half(text("name", { required: true }), select("type", [ch("seller", C.blue), ch("landlord", C.teal), ch("investor", C.purple)], { default: "seller" })),
        ...half(email("email"), phone("phone")),
        notes("note"),
      ],
      samples: [
        { name: "Priya Natarajan", email: "priya@example.com", phone: "+15555550182", type: "seller" },
        { name: "Harbor Holdings LLC", email: "assets@harborholdings.example", phone: "+15555550146", type: "landlord" },
      ],
    },
    {
      slug: "properties", group: "Listings", singular: "Property", plural: "Properties", versioned: true, vectorize: true, fts: true, defaultSort: "-created_at",
      kanbanGroupBy: "status",
      fields: tabbed(
        sec("Listing", [
          ...half(text("title", { required: true, vectorize: true, searchable: true }), slugField("title")),
          text("mls_number", { unique: true, label: "MLS #" }),
          { name: "description", type: "longtext", interface: "richtext", vectorize: true, searchable: true },
          ...half(
            select("type", [ch("house", C.blue), ch("apartment", C.teal), ch("condo", C.purple), ch("townhouse", C.green), ch("land", C.amber), ch("commercial", C.slate)], { default: "house" }),
            select("listing_type", [ch("sale", C.green, "For sale"), ch("rent", C.blue, "For rent")], { default: "sale", label: "Listing type" }),
          ),
          ...half(
            select("status", [ch("active", C.green), ch("pending", C.amber), ch("under_offer", C.amber, "Under offer"), ch("sold", C.gray), ch("rented", C.blue), ch("off_market", C.slate, "Off market")], { default: "active" }),
            money("price"),
          ),
        ]),
        sec("Details", [
          ...half(int("bedrooms", { default: 0, validation: { min: 0 } }), num("bathrooms", { default: 0, validation: { min: 0 } })),
          ...half(
            num("area_sqm", { label: "Living area (m²)", validation: { min: 0 } }),
            num("lot_sqm", { label: "Lot size (m²)", validation: { min: 0 } }),
          ),
          ...half(int("year_built", { label: "Year built" }), int("garage_spaces", { default: 0, validation: { min: 0 }, label: "Garage spaces" })),
          tags("amenities"),
        ]),
        sec("Location", [
          text("address"),
          ...half(text("city", { indexed: true }), text("state", { label: "State / Province" })),
          ...half(text("postal_code", { label: "Postal code" }), text("country")),
          divider("geo", "Map pin"),
          geo("coordinates", ["address", "city", "state", "postal_code", "country"], {
            label: "Map pin",
          }),
        ]),
        sec("Representation", [
          ...half(rel("agent", "agents"), rel("owner", "owners")),
        ]),
        sec("Media", [
          image("cover"),
          relMany("images", "media"),
          bool("featured", { default: false, label: "Featured" }),
        ]),
      ),
      samples: [
        { title: "Sunny 2-bed apartment", slug: "sunny-2-bed-apartment", mls_number: "MLS-10001", description: "Bright apartment near the park.", type: "apartment", listing_type: "sale", status: "active", price: 320000, bedrooms: 2, bathrooms: 1, area_sqm: 78, year_built: 2015, city: "Austin", state: "TX", agent: { ref: "agents:0" }, owner: { ref: "owners:0" }, featured: true },
        { title: "Family house with garden", slug: "family-house-with-garden", mls_number: "MLS-10002", description: "Spacious 4-bed with large garden.", type: "house", listing_type: "sale", status: "active", price: 540000, bedrooms: 4, bathrooms: 3, area_sqm: 180, lot_sqm: 600, year_built: 2008, garage_spaces: 2, city: "Denver", state: "CO", agent: { ref: "agents:0" }, owner: { ref: "owners:0" } },
        { title: "Downtown condo for rent", slug: "downtown-condo-for-rent", mls_number: "MLS-10003", description: "Modern 1-bed condo, walk to everything.", type: "condo", listing_type: "rent", status: "rented", price: 1850, bedrooms: 1, bathrooms: 1, area_sqm: 55, year_built: 2019, city: "Austin", state: "TX", agent: { ref: "agents:0" }, owner: { ref: "owners:1" } },
      ],
    },
    {
      slug: "inquiries", group: "Deals", singular: "Inquiry", plural: "Inquiries", ownerScoped: true, defaultSort: "-created_at",
      kanbanGroupBy: "status",
      fields: [
        rel("property", "properties"),
        ...half(text("name"), email("email")),
        notes("message"),
        select("status", [ch("new", C.blue), ch("contacted", C.amber), ch("closed", C.gray)], { default: "new" }),
      ],
      samples: [{ property: { ref: "properties:0" }, name: "Jordan Reed", email: "jordan@example.com", message: "Is this still available?", status: "new" }],
    },
    {
      slug: "viewings", group: "Deals", singular: "Viewing", plural: "Viewings", defaultSort: "-scheduled_at",
      fields: stacked(
        sec("Viewing", [
          ...half(rel("property", "properties"), rel("agent", "agents")),
          ...half(text("name"), email("email")),
        ]),
        sec("Outcome", [
          ...half(
            ts("scheduled_at", { indexed: true, label: "Scheduled at" }),
            select("status", [ch("scheduled", C.blue), ch("completed", C.green), ch("no_show", C.red, "No show"), ch("cancelled", C.gray)], { default: "scheduled" }),
          ),
          notes("feedback", { conditions: [when("status", "_eq", "completed", "required")] }),
        ]),
      ),
      samples: [{ property: { ref: "properties:0" }, agent: { ref: "agents:0" }, name: "Jordan Reed", email: "jordan@example.com", scheduled_at: ms("2026-07-10T15:00:00Z"), status: "scheduled" }],
    },
    {
      slug: "offers", group: "Deals", singular: "Offer", plural: "Offers", defaultSort: "-submitted_at", displayTemplate: "{{buyer_name}}",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Offer", [
          rel("property", "properties"),
          ...half(text("buyer_name", { label: "Buyer name" }), email("buyer_email", { label: "Buyer email" })),
          ...half(
            money("amount"),
            select("status", [ch("submitted", C.blue), ch("countered", C.amber), ch("accepted", C.green), ch("rejected", C.red), ch("withdrawn", C.gray)], { default: "submitted" }),
          ),
        ]),
        sec("Timing", [
          ...half(ts("submitted_at", { indexed: true, label: "Submitted at" }), date("expires_at", { label: "Expires at" })),
          notes("note"),
        ]),
      ),
      samples: [{ property: { ref: "properties:0" }, buyer_name: "Jordan Reed", buyer_email: "jordan@example.com", amount: 310000, status: "submitted", submitted_at: ms("2026-07-12"), expires_at: ms("2026-07-26") }],
    },
    {
      slug: "open_houses", group: "Deals", singular: "Open house", plural: "Open houses", defaultSort: "-starts_at",
      fields: [
        ...half(rel("property", "properties"), rel("host", "agents", { label: "Host agent" })),
        ...half(ts("starts_at", { range: { end: "ends_at" }, indexed: true, label: "Starts at" }), ts("ends_at", { label: "Ends at" })),
        ...half(int("visitors", { default: 0, validation: { min: 0 }, label: "Visitor count" }), notes("notes")),
      ],
      samples: [{ property: { ref: "properties:1" }, host: { ref: "agents:0" }, starts_at: ms("2026-07-18T17:00:00Z"), ends_at: ms("2026-07-18T19:00:00Z"), visitors: 14 }],
    },
    {
      slug: "transactions", group: "Deals", singular: "Transaction", plural: "Transactions", defaultSort: "-closed_at",
      fields: stacked(
        sec("Deal", [
          ...half(rel("property", "properties"), rel("agent", "agents")),
          ...half(
            select("status", [ch("pending", C.amber), ch("closed", C.green), ch("fell_through", C.red, "Fell through")], { default: "pending" }),
            date("closed_at", { indexed: true, label: "Closed at" }),
          ),
        ]),
        sec("Commission", [
          hint("re_commission", "Commission is generated from sale price × rate — change the rate, not the result."),
          ...half(money("sale_price", { label: "Sale price" }), pct("commission_rate", { default: 3, label: "Commission rate (%)" })),
          computedNum("commission", "sale_price * commission_rate * 0.01", { label: "Commission" }),
          notes("note"),
        ]),
      ),
      samples: [{ property: { ref: "properties:1" }, agent: { ref: "agents:0" }, sale_price: 535000, commission_rate: 3, status: "pending", closed_at: ms("2026-08-15") }],
    },
    {
      slug: "leases", group: "Management", singular: "Lease", plural: "Leases", defaultSort: "-starts_at", displayTemplate: "{{tenant_name}}",
      fields: stacked(
        sec("Tenant", [
          rel("property", "properties"),
          ...half(text("tenant_name", { required: true, label: "Tenant name" }), email("tenant_email", { label: "Tenant email" })),
          phone("tenant_phone", { label: "Tenant phone" }),
        ]),
        sec("Terms", [
          ...half(money("rent", { label: "Monthly rent" }), money("deposit")),
          ...half(
            date("starts_at", { range: { end: "ends_at", bounds: "[]" }, indexed: true, label: "Starts" }),
            date("ends_at", { indexed: true, label: "Ends", validation: { rule: { ends_at: { _gte: "$field.starts_at" } }, message: "The lease must end on or after it starts." } }),
          ),
          select("status", [ch("active", C.green), ch("expiring", C.amber), ch("ended", C.gray)], { default: "active" }),
        ]),
      ),
      samples: [{ property: { ref: "properties:2" }, tenant_name: "Sam Taylor", tenant_email: "sam@example.com", tenant_phone: "+15555550138", rent: 1850, deposit: 3700, starts_at: ms("2026-02-01"), ends_at: ms("2027-01-31"), status: "active" }],
    },
    {
      slug: "rent_payments", group: "Management", singular: "Rent payment", plural: "Rent payments", defaultSort: "-created_at",
      fields: [
        ...half(rel("lease", "leases"), text("period", { indexed: true, label: "Period (YYYY-MM)" })),
        ...half(money("amount"), ts("paid_at", { label: "Paid at", conditions: [when("status", "_eq", "paid", "required"), when("status", "_neq", "paid", "hidden")] })),
        select("status", [ch("due", C.amber), ch("paid", C.green), ch("late", C.red)], { default: "due" }),
      ],
      samples: [
        { lease: { ref: "leases:0" }, period: "2026-06", amount: 1850, paid_at: ms("2026-06-01"), status: "paid" },
        { lease: { ref: "leases:0" }, period: "2026-07", amount: 1850, status: "due" },
      ],
    },
    {
      slug: "property_maintenance", group: "Management", singular: "Maintenance request", plural: "Maintenance", defaultSort: "-reported_at",
      kanbanGroupBy: "status",
      fields: stacked(
        sec("Request", [
          ...half(rel("property", "properties"), rel("lease", "leases")),
          text("title", { required: true }),
          notes("description"),
        ]),
        sec("Triage", [
          ...half(
            select("priority", [ch("low", C.gray), ch("medium", C.blue), ch("high", C.amber), ch("urgent", C.red)], { default: "medium" }),
            select("status", [ch("open", C.blue), ch("scheduled", C.amber), ch("done", C.green)], { default: "open" }),
          ),
          ...half(ts("reported_at", { indexed: true, label: "Reported at" }), money("cost")),
        ]),
      ),
      samples: [{ property: { ref: "properties:2" }, lease: { ref: "leases:0" }, title: "Leaking kitchen faucet", reported_at: ms("2026-06-24T09:00:00Z"), priority: "medium", status: "scheduled", cost: 120 }],
    },
  ],
  roles: [
    {
      name: "Listing agent",
      description: "Work the sales pipeline: manage inquiries, viewings, open houses and offers; read listings, owners and closed transactions.",
      permissions: [
        { collection: "properties", action: "read" },
        { collection: "properties", action: "update" },
        { collection: "media", action: "read" },
        { collection: "agents", action: "read" },
        { collection: "owners", action: "read" },
        { collection: "inquiries", action: "read" },
        { collection: "inquiries", action: "create" },
        { collection: "inquiries", action: "update" },
        { collection: "viewings", action: "read" },
        { collection: "viewings", action: "create" },
        { collection: "viewings", action: "update" },
        { collection: "open_houses", action: "read" },
        { collection: "open_houses", action: "create" },
        { collection: "open_houses", action: "update" },
        { collection: "offers", action: "read" },
        { collection: "offers", action: "create" },
        { collection: "offers", action: "update" },
        { collection: "transactions", action: "read" },
      ],
    },
    {
      name: "Property manager",
      description: "Run the rental side: leases, rent collection and maintenance; read properties and owners.",
      permissions: [
        { collection: "properties", action: "read" },
        { collection: "owners", action: "read" },
        { collection: "leases", action: "read" },
        { collection: "leases", action: "create" },
        { collection: "leases", action: "update" },
        { collection: "rent_payments", action: "read" },
        { collection: "rent_payments", action: "create" },
        { collection: "rent_payments", action: "update" },
        { collection: "property_maintenance", action: "read" },
        { collection: "property_maintenance", action: "create" },
        { collection: "property_maintenance", action: "update" },
      ],
    },
  ],
  dashboards: [
    {
      name: "Real estate overview",
      description: "Listing pipeline, deals and rental income.",
      panels: [
        { name: "Properties", kind: "items-aggregate", viz: "counter", config: { collection: "properties", agg: "count" } },
        { name: "Portfolio value", kind: "items-aggregate", viz: "counter", config: { collection: "properties", agg: "sum", field: "price" } },
        { name: "Inquiries", kind: "items-aggregate", viz: "counter", config: { collection: "inquiries", agg: "count" } },
        { name: "Rent collected", kind: "items-aggregate", viz: "counter", config: { collection: "rent_payments", agg: "sum", field: "amount" } },
        { name: "Properties by status", kind: "items-aggregate", viz: "donut", config: { collection: "properties", agg: "count", groupBy: "status" } },
        { name: "Properties by type", kind: "items-aggregate", viz: "bars", config: { collection: "properties", agg: "count", groupBy: "type" } },
        { name: "Offers by status", kind: "items-aggregate", viz: "donut", config: { collection: "offers", agg: "count", groupBy: "status" } },
        { name: "Maintenance by status", kind: "items-aggregate", viz: "bars", config: { collection: "property_maintenance", agg: "count", groupBy: "status" } },
      ],
    },
  ],
  /**
   * The rules a brokerage runs on, already running.
   *
   * Deliberately absent: "the offer was accepted, so take the listing off the
   * market and open the transaction". Two things stop it being written
   * honestly. `offers.status` declares no lifecycle, so the only trigger
   * available is `…:updated` plus a condition — which cannot tell "just became
   * accepted" from "was saved again while accepted", and would re-fire every
   * time somebody corrected the buyer's email. And a transaction needs the
   * sale price and the listing agent, which live on the `properties` and
   * `agents` rows; a flow's `data` is the offer row alone and cannot join to
   * them. A step that guessed would open a transaction at the OFFER amount,
   * which is the number that is wrong once the counter lands. So the offer
   * stays where a person can see it, and flow 1 makes sure they do.
   *
   * Same reason, different shape, for "open next month's rent row when the
   * last one is paid": `rent_payments.period` is the month as `YYYY-MM` and a
   * flow has no clock arithmetic to produce it, so the row would arrive
   * without the one column the rent ledger is read by.
   */
  flows: [
    {
      name: "Tell the desk when a listing inquiry arrives",
      trigger: "event:items:inquiries:created",
      operations: [
        {
          type: "notification",
          title: "New inquiry from {{ data.name }}",
          body: "{{ data.message }} — reply to {{ data.email }}. Open the inquiry to see which listing it names.",
          url: "/collections/inquiries",
        },
      ],
    },
    {
      name: "Remind the agent the day before a viewing",
      // Fires once per row, one day before `scheduled_at`, at 08:00 — early
      // enough that access to an occupied property can still be arranged.
      // `status` filters to the ones still standing, so a cancelled viewing
      // does not wake anybody up.
      trigger: `schedule:${JSON.stringify({
        collection: "viewings",
        field: "scheduled_at",
        offset: { value: 1, unit: "days", direction: "before" },
        at: 480,
        timeZone: null,
        where: { status: { _eq: "scheduled" } },
      })}`,
      operations: [
        {
          type: "notification",
          title: "Viewing tomorrow — {{ data.name }}",
          body: "Booked for {{ data.scheduled_at }}. Confirm access with the occupier and check the visitor is still coming: {{ data.email }}.",
          url: "/collections/viewings",
        },
      ],
    },
    {
      name: "Sweep viewings nobody recorded an outcome for",
      // The seller is owed feedback after every viewing, and a viewing left on
      // `scheduled` after its date is the one place that promise silently
      // breaks. Oldest first and capped: switched on over a year of history an
      // uncapped sweep posts a Monday digest nobody reads to the bottom of.
      trigger: "cron:0 7 * * 1",
      operations: [
        {
          type: "foreach",
          collection: "viewings",
          filter: { status: { _eq: "scheduled" }, scheduled_at: { _lt: "$now" } },
          sort: "scheduled_at",
          limit: 25,
          do: [
            {
              type: "notification",
              title: "No outcome recorded for {{ $item.name }}'s viewing",
              body: "It was set for {{ $item.scheduled_at }} and still reads scheduled. Mark it completed, no show or cancelled, and write the feedback the seller is waiting on.",
              url: "/collections/viewings",
            },
          ],
        },
      ],
    },
    {
      name: "Open the renewal window sixty days before a lease ends",
      // Sixty days is the point at which a renewal is still a conversation
      // rather than a notice. The status move is safe to automate because
      // `expiring` is a warning rather than a decision — `ended` is the one a
      // person has to take, and this flow deliberately never reaches for it.
      trigger: `schedule:${JSON.stringify({
        collection: "leases",
        field: "ends_at",
        offset: { value: 60, unit: "days", direction: "before" },
        at: 540,
        timeZone: null,
        where: { status: { _eq: "active" } },
      })}`,
      operations: [
        {
          type: "item.update",
          collection: "leases",
          id: "{{ data.id }}",
          data: { status: "expiring" },
        },
        {
          type: "notification",
          title: "{{ data.tenant_name }}'s lease ends in 60 days",
          body: "Rent is {{ data.rent }} and the lease now reads expiring. Agree a renewal or serve notice before {{ data.ends_at }}.",
          url: "/collections/leases",
        },
      ],
    },
    {
      name: "Escalate an urgent maintenance request the moment it is logged",
      // Only the top two priorities. A board that pings for every dripping tap
      // is a board people mute, and then the burst pipe goes unread with it.
      trigger: "event:items:property_maintenance:created",
      operations: [
        {
          type: "condition",
          filter: { priority: { _in: ["high", "urgent"] } },
          then: [
            {
              type: "notification",
              title: "{{ data.priority }} maintenance: {{ data.title }}",
              body: "Reported at {{ data.reported_at }}. Dispatch a contractor and move it to scheduled — open the request for the property and the lease it came in against.",
              url: "/collections/property_maintenance",
            },
          ],
        },
      ],
    },
    {
      name: "Monthly real-estate report (needs a PDF renderer)",
      active: false,
      trigger: "cron:0 8 1 * *",
      operations: [
        {
          type: "report.deliver",
          dashboardId: "@dashboard:Real estate overview",
          subject: "Real estate — last month",
        },
      ],
    },
  ],
  documents: [
    {
      key: "listing_sheet",
      name: "Listing sheet",
      description: "The one page handed out at a viewing or an open house.",
      filename: "listing-{{ data.mls_number }}",
      variables: ["title", "price", "bedrooms", "bathrooms", "area_sqm"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:18mm}" +
        "body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:24px;margin:0 0 4px}" +
        ".muted{color:#666}" +
        ".price{font-size:22px;font-weight:700;margin:10px 0 2px}" +
        "table{width:100%;border-collapse:collapse;margin-top:16px}" +
        "th,td{text-align:left;padding:6px;border-bottom:1px solid #e5e5e5}" +
        "th{width:34%;color:#555;font-weight:600}" +
        ".agent{margin-top:20px;padding-top:12px;border-top:2px solid #111}" +
        "</style></head><body>" +
        "<h1>{{ data.title }}</h1>" +
        '<p class="muted">{{ data.address }}, {{ data.city }} {{ data.state }} ' +
        "{{ data.postal_code }} {{ data.country }}</p>" +
        '<p class="price">{{ data.price }}</p>' +
        '<p class="muted">{{ data.listing_type }} · {{ data.type }} · MLS {{ data.mls_number }} ' +
        "· currently {{ data.status }}</p>" +
        "<p>{{ data.description }}</p>" +
        "<table>" +
        "<tr><th>Bedrooms</th><td>{{ data.bedrooms }}</td></tr>" +
        "<tr><th>Bathrooms</th><td>{{ data.bathrooms }}</td></tr>" +
        "<tr><th>Living area</th><td>{{ data.area_sqm }} m&sup2;</td></tr>" +
        "<tr><th>Lot size</th><td>{{ data.lot_sqm }} m&sup2;</td></tr>" +
        "<tr><th>Year built</th><td>{{ data.year_built }}</td></tr>" +
        "<tr><th>Garage spaces</th><td>{{ data.garage_spaces }}</td></tr>" +
        "</table>" +
        '<div class="agent"><strong>{{ data.agent.name }}</strong> · {{ data.agent.agency }}<br>' +
        "{{ data.agent.phone }} · {{ data.agent.email }}<br>" +
        '<span class="muted">License {{ data.agent.license_number }}</span></div>' +
        '<p class="muted">Figures are taken from the listing record on the day this ' +
        "sheet was printed and are not a representation of fact. Verify area, year " +
        "built and taxes independently before making an offer.</p>" +
        "</body></html>",
      footerHtml:
        '<span style="font-size:9px;color:#888;width:100%;text-align:center">' +
        'Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>',
      pageOptions: { format: "A4", margin: "18mm" },
    },
    {
      key: "lease_summary",
      name: "Lease summary",
      description: "The terms of one tenancy on a single page, for a renewal conversation or a handover.",
      filename: "lease-{{ data.tenant_name }}",
      variables: ["tenant_name", "rent", "starts_at", "ends_at"],
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
        "<h1>Lease summary — {{ data.tenant_name }}</h1>" +
        '<p class="muted">{{ data.property.title }} · {{ data.property.address }}, ' +
        "{{ data.property.city }}</p>" +
        "<table>" +
        "<tr><th>Tenant</th><td>{{ data.tenant_name }}</td></tr>" +
        "<tr><th>Contact</th><td>{{ data.tenant_email }} · {{ data.tenant_phone }}</td></tr>" +
        "<tr><th>Term</th><td>{{ data.starts_at }} &mdash; {{ data.ends_at }}</td></tr>" +
        "<tr><th>Monthly rent</th><td>{{ data.rent }}</td></tr>" +
        "<tr><th>Deposit held</th><td>{{ data.deposit }}</td></tr>" +
        "<tr><th>Status</th><td>{{ data.status }}</td></tr>" +
        "</table>" +
        '<p class="muted">Rent received against this lease is recorded month by ' +
        "month in Rent payments; this page states the terms, not the balance.</p>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "20mm" },
    },
    {
      key: "open_house_signin",
      name: "Open house sign-in sheet",
      description: "The clipboard page for the door — printed with the event's own details and blank rows for visitors.",
      filename: "open-house-{{ data.starts_at }}",
      variables: ["starts_at", "ends_at"],
      bodyHtml:
        '<html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:15mm}" +
        "body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111}" +
        "h1{font-size:20px;margin:0 0 2px}" +
        ".muted{color:#666;margin:0 0 14px}" +
        "table{width:100%;border-collapse:collapse}" +
        "th,td{text-align:left;padding:9px 6px;border-bottom:1px solid #bbb}" +
        "th{background:#f4f4f4;font-weight:600}" +
        "td{height:22px}" +
        "</style></head><body>" +
        "<h1>Open house — {{ data.property.title }}</h1>" +
        '<p class="muted">{{ data.property.address }}, {{ data.property.city }} · ' +
        "{{ data.starts_at }} to {{ data.ends_at }} · hosted by {{ data.host.name }}</p>" +
        "<table><thead><tr><th>Name</th><th>Phone</th><th>Email</th>" +
        "<th>Own agent?</th></tr></thead><tbody>" +
        // Twelve blank rows — a sheet with room for one more visitor than turned
        // up is the point of printing it.
        "<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>".repeat(12) +
        "</tbody></table>" +
        '<p class="muted">Enter each visitor as an Inquiry afterwards and update ' +
        "the event's visitor count — the sheet itself is not the record.</p>" +
        "</body></html>",
      pageOptions: { format: "A4", margin: "15mm" },
    },
  ],
  forms: [
    {
      // A relation is never form-eligible, so the inquiry arrives unlinked and
      // the desk attaches it to a listing. That is on purpose rather than a
      // gap: the MLS number belongs in the message, where a member of the
      // public can be wrong about it without repointing a record.
      name: "Property listing inquiry",
      collection: "inquiries",
      settings: {
        submitLabel: "Send inquiry",
        successMessage: "Thanks — an agent will come back to you, usually the same day.",
      },
      fields: [
        { name: "name", label: "Your name" },
        { name: "email", label: "Email" },
        {
          name: "message",
          label: "Which property, and what would you like to know?",
          help: "Include the MLS number or the address so we can find the listing.",
        },
      ],
    },
    {
      // `title` is exposed because the schema requires it — a required field
      // left off the form makes the whole apply fail. `status` and `cost` are
      // deliberately not: a tenant does not triage the queue or price the job.
      name: "Property maintenance request",
      collection: "property_maintenance",
      settings: {
        submitLabel: "Send request",
        successMessage: "Logged — you'll hear from us once a contractor is booked.",
      },
      fields: [
        { name: "title", label: "What needs fixing?" },
        {
          name: "description",
          label: "Tell us more",
          help: "Include the property address and unit — the form cannot link to a lease, so the office attaches it.",
        },
        { name: "priority", help: "Pick urgent only when the property is unsafe or unusable." },
      ],
    },
  ],
  agents: [
    {
      name: "Real estate assistant",
      handle: "real-estate-assistant",
      description: "Answers questions about the listing book, the deal pipeline and the rental portfolio.",
      systemPrompt:
        "You help a brokerage that also manages rentals. Answer questions about " +
        "properties, inquiries, viewings, offers, transactions, leases, rent and " +
        "maintenance using the workspace's own data. Sale and rental are two " +
        "different books and must never be added together: `listing_type` says " +
        "which one a property is on, and `price` means an asking price on a sale " +
        "listing and a monthly rent on a rental one. A listing is live only while " +
        "its status is active, pending or under offer — sold, rented and off " +
        "market are not. An offer's amount is what was asked, not what was got; " +
        "only a transaction's sale price is a result, and commission is that " +
        "price times the deal's own rate, so never recompute it your own way. A " +
        "lease reads expiring for the sixty days before it ends, which is a " +
        "warning and not a termination. When asked what needs attention, rank " +
        "viewings with no recorded outcome, offers past their expiry date, rent " +
        "that is late, and urgent maintenance ahead of everything else. When a " +
        "figure has a seeded KPI — closed sale value, commission earned, rent " +
        "collected, listings by status, maintenance cost — run that definition " +
        "rather than adding rows up yourself, so your answer matches the " +
        "dashboard. Be brief, name the property or the MLS number you mean, and " +
        "say plainly when the data does not answer the question.",
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
