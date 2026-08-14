import type { SchemaTemplate } from "../types";
import { C, bool, ch, date, email, flag, half, int, money, moneyIn, ms, notes, num, phone, rel, sec, select, slugField, stacked, tabbed, text, ts, userLink } from "../dsl";

export const nonprofit: SchemaTemplate = {
  id: "nonprofit",
  label: "Nonprofit",
  groups: ["Donors", "Fundraising", "Programs", "Volunteering"],
  description:
    "Salesforce NPSP-grade fundraising: donors, campaigns, donations (one-time & recurring), pledges, grants with report deadlines, programs & beneficiaries, memberships, donor communications, volunteers, events and volunteer shifts.",
  collections: [
    {
      slug: "donors", group: "Donors", singular: "Donor", plural: "Donors", defaultSort: "name",
      portalLink: { emailField: "email", role: "Donor (portal)" },
      fields: tabbed(
        sec("Donor", [
          ...half(
            text("name", { required: true }),
            select("type", [ch("individual", C.blue), ch("organization", C.purple), ch("foundation", C.teal)], { default: "individual" }),
          ),
          ...half(email("email", { unique: true }), phone("phone")),
          userLink(),
        ]),
        sec("Address", [
          text("address"),
          ...half(text("city"), text("country")),
        ]),
        sec("Giving history", [
          money("total_donated", { default: 0, label: "Total donated" }),
          ...half(date("first_gift_at", { label: "First gift" }), date("last_gift_at", { label: "Last gift" })),
        ]),
      ),
      samples: [{ name: "Jordan Reed", email: "jordan@example.com", type: "individual", total_donated: 100 }, { name: "Globex Foundation", email: "giving@globex.example", type: "foundation", total_donated: 25000 }],
    },
    {
      // Restricted vs unrestricted money (CiviCRM financial type) — the split
      // an auditor asks about first.
      slug: "funds", group: "Fundraising", singular: "Fund", plural: "Funds", defaultSort: "name",
      fields: [
        ...half(
          text("name", { required: true }),
          select("restriction", [ch("unrestricted", C.green), ch("temporarily_restricted", C.amber, "Temporarily restricted"), ch("permanently_restricted", C.red, "Permanently restricted")], { default: "unrestricted" }),
        ),
        ...half(text("code", { label: "GL code" }), flag("active")),
        notes("description"),
      ],
      samples: [
        { name: "General operating", restriction: "unrestricted", code: "4000", active: true },
        { name: "Winter relief", restriction: "temporarily_restricted", code: "4200", active: true, description: "Gifts earmarked for the winter emergency response." },
      ],
    },
    {
      slug: "campaigns", group: "Fundraising", singular: "Campaign", plural: "Campaigns", defaultSort: "-created_at",
      fields: stacked(
        sec("Campaign", [
          ...half(text("name", { required: true }), slugField("name")),
          { name: "description", type: "longtext", interface: "richtext" },
          ...half(
            select("type", [ch("annual_fund", C.blue, "Annual fund"), ch("capital", C.purple), ch("event", C.amber), ch("emergency", C.red)], { default: "annual_fund" }),
            rel("fund", "funds"),
          ),
        ]),
        sec("Progress", [
          ...half(money("goal_amount", { label: "Goal" }), money("raised_amount", { default: 0, label: "Raised" })),
          ...half(
            select("status", [ch("planned", C.gray), ch("active", C.green), ch("paused", C.amber), ch("completed", C.blue)], { default: "planned" }),
            date("starts_at", { range: { end: "ends_at", bounds: "[]" }, indexed: true, label: "Starts at" }),
          ),
          date("ends_at", { label: "Ends at" }),
        ]),
      ),
      samples: [{ name: "Winter Fund", slug: "winter-fund", description: "Support families this winter.", type: "emergency", fund: { ref: "funds:1" }, goal_amount: 50000, raised_amount: 12500, status: "active", starts_at: ms("2026-11-01"), ends_at: ms("2026-12-31") }],
    },
    {
      slug: "donations", group: "Fundraising", singular: "Donation", plural: "Donations", ownerScoped: true, defaultSort: "-donated_at",
      fields: stacked(
        sec("Gift", [
          ...half(rel("donor", "donors"), rel("campaign", "campaigns")),
          ...half(rel("fund", "funds"), moneyIn("amount", { required: true })),
          ...half(
            select("currency", ["USD", "EUR", "GBP"], { default: "USD" }),
            select("type", [ch("one_time", C.blue, "One-time"), ch("recurring", C.purple)], { default: "one_time", label: "Gift type" }),
          ),
        ]),
        sec("Processing", [
          ...half(
            select("payment_method", [ch("card", C.blue), ch("bank_transfer", C.teal, "Bank transfer"), ch("cash", C.gray), ch("check", C.amber)], { default: "card", label: "Payment method" }),
            select("status", [ch("pending", C.amber), ch("completed", C.green), ch("refunded", C.red)], { default: "completed" }),
          ),
          ...half(bool("anonymous", { default: false, label: "Anonymous" }), bool("tax_receipt_sent", { default: false, label: "Tax receipt sent" })),
          ts("donated_at", { indexed: true, label: "Donated at" }),
        ]),
      ),
      samples: [{ donor: { ref: "donors:0" }, campaign: { ref: "campaigns:0" }, fund: { ref: "funds:1" }, amount: 100, currency: "USD", type: "one_time", payment_method: "card", status: "completed", donated_at: ms("2026-11-10") }],
    },
    {
      slug: "pledges", group: "Fundraising", singular: "Pledge", plural: "Pledges", defaultSort: "-created_at",
      fields: [
        ...half(rel("donor", "donors"), rel("campaign", "campaigns")),
        ...half(money("amount"), int("installments", { default: 1, validation: { min: 1 } })),
        ...half(
          select("status", [ch("active", C.green), ch("fulfilled", C.blue), ch("cancelled", C.gray)], { default: "active" }),
          date("start_date", { label: "Start date" }),
        ),
      ],
      samples: [{ donor: { ref: "donors:1" }, campaign: { ref: "campaigns:0" }, amount: 12000, installments: 12, status: "active", start_date: ms("2026-01-01") }],
    },
    {
      slug: "pledge_payments", group: "Fundraising", singular: "Pledge payment", plural: "Pledge payments", defaultSort: "-due_on",
      note: "The installment schedule behind a pledge — what turns a promise into a forecast.",
      fields: [
        ...half(rel("pledge", "pledges", { required: true }), rel("donation", "donations", { label: "Fulfilled by" })),
        ...half(money("amount"), date("due_on", { indexed: true, label: "Due on" })),
        ...half(
          select("status", [ch("scheduled", C.blue), ch("paid", C.green), ch("overdue", C.red), ch("written_off", C.gray, "Written off")], { default: "scheduled" }),
          date("paid_on", { label: "Paid on" }),
        ),
      ],
      samples: [
        { pledge: { ref: "pledges:0" }, amount: 1000, due_on: ms("2026-01-31"), status: "paid", paid_on: ms("2026-01-29") },
        { pledge: { ref: "pledges:0" }, amount: 1000, due_on: ms("2026-02-28"), status: "scheduled" },
      ],
    },
    {
      slug: "grants", group: "Fundraising", singular: "Grant", plural: "Grants", defaultSort: "-applied_at",
      fields: [
        ...half(text("name", { required: true }), text("funder")),
        ...half(
          money("amount"),
          select("status", [ch("researching", C.gray), ch("applied", C.blue), ch("awarded", C.green), ch("declined", C.red)], { default: "researching" }),
        ),
        ...half(date("applied_at", { indexed: true, label: "Applied at" }), date("decision_at", { label: "Decision date" })),
      ],
      samples: [{ name: "Community Resilience Grant", funder: "City Foundation", amount: 30000, status: "applied", applied_at: ms("2026-05-01") }],
    },
    {
      slug: "grant_reports", group: "Fundraising", singular: "Grant report", plural: "Grant reports", defaultSort: "due_date",
      fields: [
        ...half(rel("grant", "grants"), text("title", { required: true })),
        ...half(date("due_date", { indexed: true, label: "Due date" }), ts("submitted_at", { label: "Submitted at" })),
        select("status", [ch("upcoming", C.amber), ch("submitted", C.blue), ch("approved", C.green)], { default: "upcoming" }),
        notes("note"),
      ],
      samples: [{ grant: { ref: "grants:0" }, title: "Mid-year progress report", due_date: ms("2026-09-30"), status: "upcoming" }],
    },
    {
      slug: "programs", group: "Programs", singular: "Program", plural: "Programs", defaultSort: "name",
      fields: [
        text("name", { required: true }),
        notes("description"),
        ...half(
          money("budget"),
          select("status", [ch("active", C.green), ch("paused", C.amber), ch("completed", C.blue)], { default: "active" }),
        ),
      ],
      samples: [{ name: "After-school tutoring", description: "Weekly tutoring for local students.", budget: 18000, status: "active" }],
    },
    {
      slug: "beneficiaries", group: "Programs", singular: "Beneficiary", plural: "Beneficiaries", defaultSort: "-enrolled_at",
      fields: [
        ...half(rel("program", "programs"), text("name", { required: true, label: "Name / alias" })),
        ...half(
          date("enrolled_at", { indexed: true, label: "Enrolled at" }),
          select("status", [ch("waitlist", C.amber), ch("active", C.green), ch("exited", C.gray)], { default: "active" }),
        ),
      ],
      samples: [{ program: { ref: "programs:0" }, name: "Student A-102", enrolled_at: ms("2026-02-10"), status: "active" }],
    },
    {
      slug: "memberships", group: "Donors", singular: "Membership", plural: "Memberships", defaultSort: "-joined_at", displayTemplate: "{{member_name}}",
      fields: stacked(
        sec("Member", [
          ...half(text("member_name", { required: true, label: "Member name" }), email("member_email", { label: "Member email" })),
          ...half(
            select("level", [ch("student", C.gray), ch("individual", C.blue), ch("family", C.teal), ch("patron", C.purple)], { default: "individual" }),
            money("annual_fee", { label: "Annual fee" }),
          ),
        ]),
        sec("Term", [
          ...half(date("joined_at", { indexed: true, label: "Joined at" }), date("renews_at", { indexed: true, label: "Renews at" })),
          select("status", [ch("active", C.green), ch("lapsed", C.amber), ch("cancelled", C.gray)], { default: "active" }),
        ]),
      ),
      samples: [{ member_name: "Robin Vale", member_email: "robin@example.com", level: "family", joined_at: ms("2026-01-15"), renews_at: ms("2027-01-15"), status: "active", annual_fee: 120 }],
    },
    {
      slug: "communications", group: "Donors", singular: "Communication", plural: "Communications", defaultSort: "-sent_at",
      fields: [
        ...half(
          rel("donor", "donors"),
          select("channel", [ch("email", C.blue), ch("phone", C.teal), ch("mail", C.gray), ch("meeting", C.purple)], { default: "email" }),
        ),
        ...half(text("subject"), ts("sent_at", { indexed: true, label: "Sent at" })),
        notes("outcome"),
      ],
      samples: [{ donor: { ref: "donors:1" }, channel: "meeting", subject: "Annual giving review", sent_at: ms("2026-06-05T14:00:00Z"), outcome: "Interested in increasing the pledge next year." }],
    },
    {
      slug: "volunteers", group: "Volunteering", singular: "Volunteer", plural: "Volunteers", defaultSort: "name",
      portalLink: { emailField: "email", role: "Volunteer (portal)" },
      fields: [
        ...half(text("name", { required: true }), email("email")),
        ...half(phone("phone"), select("status", [ch("active", C.green), ch("inactive", C.gray)], { default: "active" })),
        notes("skills"),
        userLink(),
      ],
      samples: [{ name: "Casey Morgan", email: "casey@example.com", skills: "Event setup, outreach.", status: "active" }],
    },
    {
      slug: "events", group: "Volunteering", singular: "Event", plural: "Events", defaultSort: "-starts_at",
      fields: [
        ...half(text("title", { required: true }), slugField("title")),
        { name: "description", type: "longtext", interface: "richtext" },
        ...half(ts("starts_at", { indexed: true, label: "Starts at" }), text("location")),
        int("capacity", { validation: { min: 0 } }),
      ],
      samples: [{ title: "Charity Gala", slug: "charity-gala", description: "Annual fundraising gala.", starts_at: ms("2026-12-05T18:00:00Z"), location: "Grand Hotel", capacity: 200 }],
    },
    {
      slug: "volunteer_shifts", group: "Volunteering", singular: "Shift", plural: "Shifts", defaultSort: "-created_at",
      fields: [
        ...half(rel("event", "events"), rel("volunteer", "volunteers")),
        ...half(text("role"), num("hours", { validation: { min: 0 } })),
        select("status", [ch("scheduled", C.blue), ch("completed", C.green), ch("no_show", C.red, "No show")], { default: "scheduled" }),
      ],
      samples: [{ event: { ref: "events:0" }, volunteer: { ref: "volunteers:0" }, role: "Registration desk", hours: 4, status: "scheduled" }],
    },
  ],
  roles: [
    {
      name: "Development officer",
      description: "Own donor relationships and the fundraising pipeline: donors, donations, pledges, grants, reports and communications.",
      permissions: [
        { collection: "donors", action: "read" },
        { collection: "donors", action: "create" },
        { collection: "donors", action: "update" },
        { collection: "campaigns", action: "read" },
        { collection: "campaigns", action: "update" },
        { collection: "donations", action: "read" },
        { collection: "donations", action: "create" },
        { collection: "donations", action: "update" },
        { collection: "pledges", action: "read" },
        { collection: "pledges", action: "create" },
        { collection: "pledges", action: "update" },
        { collection: "grants", action: "read" },
        { collection: "grants", action: "create" },
        { collection: "grants", action: "update" },
        { collection: "grant_reports", action: "read" },
        { collection: "grant_reports", action: "create" },
        { collection: "grant_reports", action: "update" },
        { collection: "memberships", action: "read" },
        { collection: "memberships", action: "create" },
        { collection: "memberships", action: "update" },
        { collection: "communications", action: "read" },
        { collection: "communications", action: "create" },
        { collection: "communications", action: "update" },
      ],
    },
    {
      name: "Volunteer coordinator",
      description: "Run volunteering: volunteers, events and shifts; read programs and beneficiaries.",
      permissions: [
        { collection: "volunteers", action: "read" },
        { collection: "volunteers", action: "create" },
        { collection: "volunteers", action: "update" },
        { collection: "events", action: "read" },
        { collection: "events", action: "create" },
        { collection: "events", action: "update" },
        { collection: "volunteer_shifts", action: "read" },
        { collection: "volunteer_shifts", action: "create" },
        { collection: "volunteer_shifts", action: "update" },
        { collection: "programs", action: "read" },
        { collection: "beneficiaries", action: "read" },
      ],
    },
    {
      name: "Donor (portal)",
      description: "Signed-in donor self-service: browse campaigns and events, see own donor record, donations and pledges.",
      permissions: [
        { collection: "campaigns", action: "read" },
        { collection: "events", action: "read" },
        { collection: "donors", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "donations", action: "read", condition: { "donor.app_user_id": { _eq: "$user.id" } } },
        { collection: "pledges", action: "read", condition: { "donor.app_user_id": { _eq: "$user.id" } } },
      ],
    },
    {
      name: "Volunteer (portal)",
      description: "Signed-in volunteer self-service: browse events, see own volunteer profile and shifts.",
      permissions: [
        { collection: "events", action: "read" },
        { collection: "volunteers", action: "read", condition: { app_user_id: { _eq: "$user.id" } } },
        { collection: "volunteer_shifts", action: "read", condition: { "volunteer.app_user_id": { _eq: "$user.id" } } },
      ],
    },
  ],
  dashboards: [
    {
      name: "Fundraising overview",
      description: "Giving, campaigns, grants and volunteering at a glance.",
      panels: [
        { name: "Donors", kind: "items-aggregate", viz: "counter", config: { collection: "donors", agg: "count" } },
        { name: "Donated", kind: "items-aggregate", viz: "counter", config: { collection: "donations", agg: "sum", field: "amount" } },
        { name: "Pledged", kind: "items-aggregate", viz: "counter", config: { collection: "pledges", agg: "sum", field: "amount" } },
        { name: "Volunteers", kind: "items-aggregate", viz: "counter", config: { collection: "volunteers", agg: "count" } },
        { name: "Campaigns by status", kind: "items-aggregate", viz: "donut", config: { collection: "campaigns", agg: "count", groupBy: "status" } },
        { name: "Donations by method", kind: "items-aggregate", viz: "bars", config: { collection: "donations", agg: "count", groupBy: "payment_method" } },
        { name: "Grants by status", kind: "items-aggregate", viz: "bars", config: { collection: "grants", agg: "count", groupBy: "status" } },
        { name: "Memberships by status", kind: "items-aggregate", viz: "donut", config: { collection: "memberships", agg: "count", groupBy: "status" } },
      ],
    },
  ],
};
